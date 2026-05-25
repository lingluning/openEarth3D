'use strict';

// ── Overpass fetch ─────────────────────────────────────────────────────────
// We pull buildings AND ground features (roads / water / trees) in one
// request so the user only waits for a single Overpass round-trip.
async function fetchBuildings(bb) {
  const q = `[out:json][timeout:40];
(
  way["building"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["building"](${bb.s},${bb.w},${bb.n},${bb.e});
);
out body;>;out skel qt;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(q),
  });
  const json = await res.json();
  return json.elements;
}

// Most OSM buildings (especially in Japan) have no `roof:shape` tag — so
// if we trusted the tag literally every roof would default to flat and the
// city would look like a parking lot of grey boxes. Infer a plausible
// shape from the building type, footprint area, and height instead.
function _inferRoofShape(tags, areaM2, height) {
  if (tags['roof:shape']) return tags['roof:shape'].toLowerCase();

  const t = (tags.building || '').toLowerCase();

  // Religious / heritage architecture almost always has a sloped roof.
  if (['church','cathedral','chapel'].includes(t))       return 'pyramidal';
  if (['temple','shrine','pagoda'].includes(t))          return 'pyramidal';
  if (t === 'mosque')                                    return 'dome';
  if (t === 'castle' || t === 'tower')                   return 'pyramidal';

  // Small detached houses → gabled roof. Cap by footprint + height so a
  // 200 m tall "house" tag doesn't get a pitched roof.
  if (areaM2 < 250 && height < 14 &&
      ['house','detached','residential','bungalow','cabin',
       'cottage','semidetached_house','farm'].includes(t)) {
    return 'gabled';
  }

  // Barns and small farm buildings → hipped.
  if (areaM2 < 600 && height < 12 &&
      ['barn','farm_auxiliary','stable','greenhouse','hut','shed'].includes(t)) {
    return 'hipped';
  }

  // Schools, town halls, civic buildings → hipped if not too big.
  if (areaM2 < 1500 && height < 18 &&
      ['school','kindergarten','civic','public','townhall'].includes(t)) {
    return 'hipped';
  }

  // Default — apartments, offices, retail, industrial, anything large.
  return 'flat';
}

function _inferRoofHeight(shape, totalH, areaM2) {
  if (shape === 'flat') return 0;
  if (shape === 'dome' || shape === 'onion') {
    // Bigger domes need more rise to look like a dome and not a contact lens.
    return Math.min(Math.max(3, Math.sqrt(areaM2) * 0.25), totalH * 0.6);
  }
  // Gabled / hipped / pyramidal: 25–40 % of total height, clamped 2..8 m.
  return Math.min(8, Math.max(2, totalH * 0.32));
}

// Polygon area in m² using the shoelace formula in local-XZ space.
function _footprintAreaM2(coords, bb) {
  let a2 = 0;
  for (let i = 0; i < coords.length; i++) {
    const A = coords[i], B = coords[(i + 1) % coords.length];
    a2 += toLocalX(A.lon, bb) * toLocalZ(B.lat, bb)
        - toLocalX(B.lon, bb) * toLocalZ(A.lat, bb);
  }
  return Math.abs(a2) / 2;
}

function parseBuildings(elements, bb) {
  const nodeMap = {};
  elements.filter(e => e.type === 'node').forEach(n => { nodeMap[n.id] = n; });

  const buildings = [];
  elements.filter(e => e.type === 'way' && e.tags && e.tags.building).forEach(way => {
    const coords = way.nodes
      .map(id => nodeMap[id])
      .filter(Boolean)
      .map(n => ({ lat: n.lat, lon: n.lon }));
    if (coords.length < 3) return;

    const tags = way.tags;
    const levelsRaw = tags['building:levels'] || tags['levels'];
    const levels   = levelsRaw ? parseFloat(levelsRaw) : 2;
    const height   = tags.height ? parseFloat(tags.height) : Math.max(3, levels * 3.2);
    const minH     = tags.min_height ? parseFloat(tags.min_height) : 0;

    const area     = _footprintAreaM2(coords, bb);
    const roofShape = _inferRoofShape(tags, area, height);
    const roofH    = tags['roof:height'] ? parseFloat(tags['roof:height'])
                                         : _inferRoofHeight(roofShape, height, area);

    buildings.push({ coords, height, minH, roofH, roofShape, area, tags });
  });
  return buildings;
}

// ── Procedural facade textures ─────────────────────────────────────────────
const _facadeCache = {};

function makeFacadeTexture(wallHex, type) {
  const key = wallHex + '_' + type;
  if (_facadeCache[key]) return _facadeCache[key];

  const W = 256, H = 512;
  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d');

  const r = (wallHex >> 16) & 0xff;
  const g = (wallHex >> 8) & 0xff;
  const b = wallHex & 0xff;

  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = `rgba(0,0,0,0.12)`;
  ctx.lineWidth = 1;
  for (let y = 22; y < H; y += 22) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  const COLS = type === 'glass' ? 4 : 5;
  const ROWS = type === 'glass' ? 8 : 10;
  const padX = 16, padY = 22;
  const stepX = (W - padX * 2) / COLS;
  const stepY = (H - padY * 2) / ROWS;
  const winW = stepX * (type === 'glass' ? 0.78 : 0.60);
  const winH = stepY * (type === 'glass' ? 0.72 : 0.55);

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const wx = padX + col * stepX + (stepX - winW) / 2;
      const wy = padY + row * stepY + (stepY - winH) / 2;
      if (type === 'glass') {
        const grad = ctx.createLinearGradient(wx, wy, wx + winW, wy + winH);
        grad.addColorStop(0, 'rgba(140,210,240,0.88)');
        grad.addColorStop(0.5, 'rgba(100,180,220,0.75)');
        grad.addColorStop(1, 'rgba(60,140,190,0.82)');
        ctx.fillStyle = grad;
        ctx.fillRect(wx, wy, winW, winH);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(wx + 2, wy + 2, winW * 0.35, winH * 0.4);
      } else {
        const lit = Math.random() > 0.18;
        ctx.fillStyle = lit ? 'rgba(200,228,255,0.80)' : 'rgba(22,30,50,0.86)';
        ctx.fillRect(wx, wy, winW, winH);
        if (lit) {
          ctx.strokeStyle = 'rgba(180,210,240,0.6)';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(wx + winW * 0.5, wy);
          ctx.lineTo(wx + winW * 0.5, wy + winH);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(wx, wy, winW, winH);
    }
  }

  const tex = new THREE.CanvasTexture(cvs);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.encoding = THREE.sRGBEncoding;
  tex.name = 'facade_' + key;
  _facadeCache[key] = tex;
  return tex;
}

function getBuildingStyle(tags) {
  const t = (tags.building || '').toLowerCase();
  const mat = (tags['building:material'] || '').toLowerCase();
  // Glassy / commercial
  if (mat === 'glass' || ['commercial','retail','office','civic','public'].includes(t))
    return { wall: 0x8ab8cc, roof: 0x3a6070, type: 'glass',    pbr: { rough: 0.15, metal: 0.55 } };
  if (mat === 'metal' || ['industrial','warehouse','factory'].includes(t))
    return { wall: 0xa8a8a0, roof: 0x505048, type: 'concrete', pbr: { rough: 0.45, metal: 0.55 } };
  if (mat === 'wood'  || ['church','cathedral','temple','shrine'].includes(t))
    return { wall: 0xe0cc80, roof: 0x5a4a20, type: 'concrete', pbr: { rough: 0.75, metal: 0.0  } };
  if (['residential','house','apartments','dormitory'].includes(t))
    return { wall: 0xd8b87a, roof: 0x6e4e28, type: 'concrete', pbr: { rough: 0.85, metal: 0.0  } };
  return { wall: 0xc8c0b4, roof: 0x585048, type: 'concrete', pbr: { rough: 0.85, metal: 0.0 } };
}

// ── Material cache (shared across buildings of the same style) ─────────────
let _matCache = { wall: {}, roof: {} };
function resetBuildingCaches() {
  _matCache = { wall: {}, roof: {} };
  for (const k in _facadeCache) delete _facadeCache[k];
}

function _getWallMat(style) {
  const key = `${style.wall}_${style.type}`;
  if (_matCache.wall[key]) return _matCache.wall[key];
  const tex = makeFacadeTexture(style.wall, style.type);
  const mat = new THREE.MeshStandardMaterial({
    map:       tex,
    roughness: style.pbr.rough,
    metalness: style.pbr.metal,
    envMapIntensity: 1.0,
  });
  mat.name = `wall_${key}`;
  _matCache.wall[key] = mat;
  return mat;
}
function _getRoofMat(style) {
  const key = `${style.roof}_${style.type}`;
  if (_matCache.roof[key]) return _matCache.roof[key];
  const mat = new THREE.MeshStandardMaterial({
    color:     style.roof,
    roughness: 0.75,
    metalness: style.type === 'glass' ? 0.3 : 0.0,
    // Flat roofs come from THREE.ShapeGeometry whose winding is arbitrary
    // depending on Earcut output; DoubleSide guarantees visibility.
    side: THREE.DoubleSide,
  });
  mat.name = `roof_${key}`;
  _matCache.roof[key] = mat;
  return mat;
}

// ── Wall geometry — non-capped quad strip with proper UVs ──────────────────
// ExtrudeGeometry produces walls + a flat cap; we want walls only so the
// roof geometry can replace the cap cleanly.
//
// Winding note: our coordinate frame has +X east, +Y up, +Z south. After
// ensuring `area2 >= 0`, the footprint is traversed clockwise as seen from
// +Y, so the outward direction for each edge is the LEFT side of walking
// — equivalently, the cross (top-bot) × (b-a) (rather than the natural
// (b-a) × (top-bot)). We emit triangles in (a-bot, b-top, b-bot) /
// (a-bot, a-top, b-top) order so the right-hand-rule normals point
// outward and FrontSide culling keeps them visible.
function _makeWallsGeo(footprint, baseY, topY) {
  const positions = [], uvs = [];
  const n = footprint.length;
  for (let i = 0; i < n; i++) {
    const a = footprint[i], b = footprint[(i + 1) % n];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const uMax = segLen / 8;          // 8 m horizontal texture repeat
    const vMax = (topY - baseY) / 4;  // 4 m vertical
    positions.push(a.x, baseY, a.z,   b.x, topY, b.z,    b.x, baseY, b.z);
    positions.push(a.x, baseY, a.z,   a.x, topY, a.z,    b.x, topY, b.z);
    uvs.push(0, 0,  uMax, vMax,  uMax, 0);
    uvs.push(0, 0,  0, vMax,     uMax, vMax);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

// ── Roof shape generators ──────────────────────────────────────────────────
// All return a BufferGeometry positioned in world space — vertices already
// at the correct (x, y, z). The mesh that wraps them sits at the identity.

function _makeFlatRoofGeo(footprint, y) {
  // Triangulate via THREE.Shape so non-convex footprints work too.
  const shape = new THREE.Shape(footprint.map(p => new THREE.Vector2(p.x, -p.z)));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  return geo;
}

function _makePyramidalRoofGeo(footprint, baseY, topY) {
  const n = footprint.length;
  const cx = footprint.reduce((s, p) => s + p.x, 0) / n;
  const cz = footprint.reduce((s, p) => s + p.z, 0) / n;
  const positions = [];
  // Triangle order (a, apex, b) keeps the right-hand-rule normal pointing
  // outward+up for our CW-from-+Y footprint convention.
  for (let i = 0; i < n; i++) {
    const a = footprint[i], b = footprint[(i + 1) % n];
    positions.push(a.x, baseY, a.z,  cx, topY, cz,  b.x, baseY, b.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function _makeDomeRoofGeo(footprint, baseY, topY) {
  // Sphere fit to the footprint bounding circle, with its equator at baseY.
  const n = footprint.length;
  const cx = footprint.reduce((s, p) => s + p.x, 0) / n;
  const cz = footprint.reduce((s, p) => s + p.z, 0) / n;
  const r = Math.max(...footprint.map(p => Math.hypot(p.x - cx, p.z - cz)));
  const h = topY - baseY;
  // SphereGeometry top half only
  const sphere = new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  // Squash vertically to match roof height instead of r
  sphere.scale(1, h / r, 1);
  sphere.translate(cx, baseY, cz);
  return sphere;
}

function _makeGabledRoofGeo(footprint, baseY, topY) {
  // Compute principal axis of the footprint (longest edge or PCA-lite via
  // bounding-box major axis), then ridge along that axis.
  const n = footprint.length;
  const cx = footprint.reduce((s, p) => s + p.x, 0) / n;
  const cz = footprint.reduce((s, p) => s + p.z, 0) / n;

  // Pick axis as the principal direction of the OBB approximated by PCA.
  let sxx = 0, szz = 0, sxz = 0;
  for (const p of footprint) {
    const dx = p.x - cx, dz = p.z - cz;
    sxx += dx*dx; szz += dz*dz; sxz += dx*dz;
  }
  // Eigenvector angle of 2D covariance matrix.
  const theta = 0.5 * Math.atan2(2*sxz, sxx - szz);
  const ax = Math.cos(theta), az = Math.sin(theta);   // ridge direction
  const nx = -az,            nz = ax;                  // perpendicular

  // Project footprint onto ridge axis; ridge endpoints at extreme projections.
  let tMin = +Infinity, tMax = -Infinity;
  for (const p of footprint) {
    const t = (p.x - cx) * ax + (p.z - cz) * az;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  // Inset by 10 % so the gable ends look like real gables (vertical triangles).
  const inset = (tMax - tMin) * 0.05;
  tMin += inset; tMax -= inset;
  const ridgeA = { x: cx + ax * tMin, y: topY, z: cz + az * tMin };
  const ridgeB = { x: cx + ax * tMax, y: topY, z: cz + az * tMax };

  // For each edge of the footprint, slope upward to whichever ridge endpoint
  // its midpoint is closer to. That gives two long sloping roof planes.
  // Triangle vertex order is (a, apex, b) so the right-hand-rule normals
  // point outward+up under our CW-from-+Y footprint convention.
  const positions = [];
  for (let i = 0; i < n; i++) {
    const a = footprint[i], b = footprint[(i + 1) % n];
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const tMid = (mx - cx) * ax + (mz - cz) * az;
    const apex = tMid < 0 ? ridgeA : ridgeB;
    positions.push(a.x, baseY, a.z,  apex.x, apex.y, apex.z,  b.x, baseY, b.z);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function _makeRoofGeo(shape, footprint, baseY, topY) {
  if (topY <= baseY + 0.01) return _makeFlatRoofGeo(footprint, baseY);
  switch (shape) {
    case 'flat':       return _makeFlatRoofGeo(footprint, baseY);
    case 'pyramidal':
    case 'hipped':
    case 'hip':        return _makePyramidalRoofGeo(footprint, baseY, topY);
    case 'dome':
    case 'onion':      return _makeDomeRoofGeo(footprint, baseY, topY);
    case 'gabled':
    case 'gable':
    case 'pitched':    return _makeGabledRoofGeo(footprint, baseY, topY);
    default:           return _makePyramidalRoofGeo(footprint, baseY, topY);
  }
}

// ── Building assembly ──────────────────────────────────────────────────────
function buildingToMesh(building, bb, elevGrid, gridN, vertExag) {
  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);

  const pts2d = building.coords.map(c => ({
    x: toLocalX(c.lon, bb),
    z: toLocalZ(c.lat, bb),
  }));

  // CCW winding (positive signed area in this XZ frame).
  let area2 = 0;
  for (let i = 0; i < pts2d.length; i++) {
    const a = pts2d[i], b = pts2d[(i + 1) % pts2d.length];
    area2 += a.x * b.z - b.x * a.z;
  }
  if (area2 < 0) pts2d.reverse();

  const cx = pts2d.reduce((s, p) => s + p.x, 0) / pts2d.length;
  const cz = pts2d.reduce((s, p) => s + p.z, 0) / pts2d.length;
  const baseElev = getElevAt(elevGrid, gridN, cx / xSize, cz / zSize) * vertExag;

  const style = getBuildingStyle(building.tags);
  const minH    = building.minH || 0;
  const totalH  = building.height;
  const roofH   = Math.min(building.roofH || 0, Math.max(0, totalH - minH - 2));
  const wallTop = baseElev + minH + (totalH - roofH);
  const roofTop = baseElev + minH + totalH;
  const baseY   = baseElev + minH;

  // Walls: side quads only, with UVs ready for facade texture.
  const wallGeo = _makeWallsGeo(pts2d, baseY, wallTop);
  const wallMesh = new THREE.Mesh(wallGeo, _getWallMat(style));
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;

  // Roof: matches the OSM roof:shape tag.
  const roofGeo = _makeRoofGeo(building.roofShape, pts2d, wallTop, roofTop);
  const roofMesh = new THREE.Mesh(roofGeo, _getRoofMat(style));
  roofMesh.castShadow = true;
  roofMesh.receiveShadow = true;

  const group = new THREE.Group();
  group.add(wallMesh);
  group.add(roofMesh);
  return group;
}

function createBuildingGroup(buildings, bb, elevGrid, gridN, vertExag) {
  const group = new THREE.Group();
  for (const b of buildings) {
    try {
      group.add(buildingToMesh(b, bb, elevGrid, gridN, vertExag));
    } catch {}
  }
  return group;
}
