'use strict';

// Pull OSM ground features (roads, water, trees, forests) for the bbox.
// Buildings stay in buildings.js — there's enough room in Overpass's 40 s
// timeout to run both requests in parallel from app.js.
async function fetchGroundFeatures(bb) {
  const q = `[out:json][timeout:40];
(
  way["highway"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["natural"="water"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["water"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["waterway"="riverbank"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["natural"="water"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["landuse"="forest"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["natural"="wood"](${bb.s},${bb.w},${bb.n},${bb.e});
  node["natural"="tree"](${bb.s},${bb.w},${bb.n},${bb.e});
);
out body;>;out skel qt;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(q),
  });
  const json = await res.json();
  return json.elements;
}

// ── Road width and colour per OSM `highway=` tag ───────────────────────────
const ROAD_STYLES = {
  motorway:      { w: 12, color: 0x4a4a4a },
  trunk:         { w: 11, color: 0x4a4a4a },
  primary:       { w: 10, color: 0x555555 },
  secondary:     { w: 9,  color: 0x5a5a5a },
  tertiary:      { w: 8,  color: 0x606060 },
  unclassified:  { w: 7,  color: 0x686868 },
  residential:   { w: 6,  color: 0x686868 },
  service:       { w: 4,  color: 0x707070 },
  living_street: { w: 5,  color: 0x686868 },
  pedestrian:    { w: 5,  color: 0x9a8a72 },
  footway:       { w: 2.5, color: 0x9a8a72 },
  path:          { w: 2,  color: 0x9a8a72 },
  cycleway:      { w: 3,  color: 0x6a8a72 },
  track:         { w: 3.5, color: 0x9a8a72 },
};

function parseGroundFeatures(elements, bb) {
  const nodeMap = {};
  elements.filter(e => e.type === 'node').forEach(n => { nodeMap[n.id] = n; });

  const roads = [], waters = [], forests = [], trees = [];

  for (const e of elements) {
    if (e.type === 'way' && e.tags) {
      const t = e.tags;
      const coords = e.nodes
        .map(id => nodeMap[id])
        .filter(Boolean)
        .map(n => ({ lat: n.lat, lon: n.lon }));
      if (coords.length < 2) continue;

      if (t.highway) {
        const style = ROAD_STYLES[t.highway] || ROAD_STYLES.unclassified;
        roads.push({ coords, ...style });
      } else if (t.natural === 'water' || t.water || t.waterway === 'riverbank') {
        if (coords.length >= 3) waters.push({ coords });
      } else if (t.landuse === 'forest' || t.natural === 'wood') {
        if (coords.length >= 3) forests.push({ coords });
      }
    } else if (e.type === 'node' && e.tags && e.tags.natural === 'tree') {
      trees.push({ lat: e.lat, lon: e.lon });
    }
  }
  return { roads, waters, forests, trees };
}

// ── Road geometry — flat ribbons hovering 0.5 m above the terrain ─────────
function _toLocal(c, bb) { return { x: toLocalX(c.lon, bb), z: toLocalZ(c.lat, bb) }; }

function _buildRoadRibbon(coords, width, bb, elevGrid, gridN, vertExag) {
  const pts = coords.map(c => _toLocal(c, bb));
  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);
  const positions = [], uvs = [];
  // Drop a small vertical offset above the terrain so the road doesn't
  // z-fight with the aerial-photo texture.
  const LIFT = 0.5;
  const half = width / 2;

  // Pre-compute outward normals at each vertex (averaged with neighbour).
  const n = pts.length;
  const normals = new Array(n);
  for (let i = 0; i < n; i++) {
    let dx = 0, dz = 0;
    if (i > 0)     { dx += pts[i].x - pts[i-1].x; dz += pts[i].z - pts[i-1].z; }
    if (i < n - 1) { dx += pts[i+1].x - pts[i].x; dz += pts[i+1].z - pts[i].z; }
    const L = Math.hypot(dx, dz) || 1;
    normals[i] = { x: -dz / L, z: dx / L };  // 90° rotated tangent
  }

  function elevAt(x, z) {
    const rx = Math.max(0, Math.min(1, x / xSize));
    const rz = Math.max(0, Math.min(1, z / zSize));
    return getElevAt(elevGrid, gridN, rx, rz) * vertExag + LIFT;
  }

  let u = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const na = normals[i], nb = normals[i + 1];
    const al = { x: a.x + na.x * half, z: a.z + na.z * half };
    const ar = { x: a.x - na.x * half, z: a.z - na.z * half };
    const bl = { x: b.x + nb.x * half, z: b.z + nb.z * half };
    const br = { x: b.x - nb.x * half, z: b.z - nb.z * half };
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const uNext = u + segLen / width; // texture repeat per road-width

    // Horizontal triangles: vertex order picked so the right-hand-rule
    // normal points up (+Y), otherwise the ribbon is hidden by backface
    // culling when viewed from above.
    positions.push(al.x, elevAt(al.x, al.z), al.z,
                   br.x, elevAt(br.x, br.z), br.z,
                   ar.x, elevAt(ar.x, ar.z), ar.z);
    positions.push(al.x, elevAt(al.x, al.z), al.z,
                   bl.x, elevAt(bl.x, bl.z), bl.z,
                   br.x, elevAt(br.x, br.z), br.z);
    uvs.push(0, u,  1, uNext,  1, u);
    uvs.push(0, u,  0, uNext,  1, uNext);
    u = uNext;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

// Group all roads sharing a colour into one BufferGeometry so we draw
// hundreds of roads in a handful of draw calls instead of hundreds.
function createRoads(roads, bb, elevGrid, gridN, vertExag) {
  const byColor = {};
  for (const r of roads) {
    (byColor[r.color] = byColor[r.color] || []).push(r);
  }
  const group = new THREE.Group();
  group.name = 'roads';
  for (const col in byColor) {
    const positions = [], uvs = [];
    for (const r of byColor[col]) {
      const g = _buildRoadRibbon(r.coords, r.w, bb, elevGrid, gridN, vertExag);
      const p = g.attributes.position.array;
      const t = g.attributes.uv.array;
      for (let i = 0; i < p.length; i++) positions.push(p[i]);
      for (let i = 0; i < t.length; i++) uvs.push(t[i]);
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    merged.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
    merged.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: parseInt(col, 10),
      roughness: 0.95,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    mat.name = `road_${parseInt(col, 10).toString(16)}`;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// ── Water — flat semi-transparent blue mesh just above terrain ────────────
function createWater(waters, bb, elevGrid, gridN, vertExag) {
  const group = new THREE.Group();
  group.name = 'water';
  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2a5d7d,
    roughness: 0.1,
    metalness: 0.3,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
  });
  mat.name = 'water';

  for (const w of waters) {
    const pts = w.coords.map(c => new THREE.Vector2(
      toLocalX(c.lon, bb),
      -toLocalZ(c.lat, bb)
    ));
    if (pts.length < 3) continue;
    const shape = new THREE.Shape(pts);
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);

    // Sit the polygon at the elevation of its centroid, slightly above
    // terrain to win the z-fight with the aerial photo.
    let cx = 0, cz = 0;
    for (const c of w.coords) { cx += toLocalX(c.lon, bb); cz += toLocalZ(c.lat, bb); }
    cx /= w.coords.length; cz /= w.coords.length;
    const elev = getElevAt(elevGrid, gridN, cx/xSize, cz/zSize) * vertExag + 0.3;

    geo.translate(0, elev, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// ── Trees — InstancedMesh of a low-poly trunk + crown ─────────────────────
// One draw call for thousands of trees. Each instance gets a random scale
// and a slight rotation so the canopy doesn't look like a regiment.
function createTrees(treePoints, forests, bb, elevGrid, gridN, vertExag) {
  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);

  // Sprinkle random trees inside each forest/wood polygon. Density tuned
  // so a city park reads as foliage without the GPU hitting a wall.
  const FOREST_DENSITY = 0.0008; // trees per m²
  const all = treePoints.slice();
  for (const f of forests) {
    const pts = f.coords.map(c => ({ x: toLocalX(c.lon, bb), z: toLocalZ(c.lat, bb) }));
    let minX = +Infinity, maxX = -Infinity, minZ = +Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    const area = Math.max(0, (maxX - minX) * (maxZ - minZ));
    const target = Math.min(800, Math.round(area * FOREST_DENSITY));
    for (let i = 0; i < target * 3 && all.length < (treePoints.length + 4000); i++) {
      const x = minX + Math.random() * (maxX - minX);
      const z = minZ + Math.random() * (maxZ - minZ);
      if (_pointInPoly(x, z, pts)) {
        const lat = bb.s + (1 - z / zSize) * (bb.n - bb.s);
        const lon = bb.w + (x / xSize) * (bb.e - bb.w);
        all.push({ lat, lon });
        if (all.length - treePoints.length >= target) break;
      }
    }
  }
  if (all.length === 0) return new THREE.Group();

  // One simple tree mesh: a brown trunk cylinder + a green crown cone.
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 2.5, 5);
  trunkGeo.translate(0, 1.25, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3520, roughness: 0.9 });
  trunkMat.name = 'tree_trunk';

  const crownGeo = new THREE.ConeGeometry(2.2, 5.5, 7);
  crownGeo.translate(0, 2.5 + 2.75, 0);
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x3a6a32, roughness: 0.85 });
  crownMat.name = 'tree_crown';

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, all.length);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, all.length);
  trunks.castShadow = crowns.castShadow = true;
  trunks.receiveShadow = crowns.receiveShadow = false;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    const x = toLocalX(t.lon, bb), z = toLocalZ(t.lat, bb);
    if (x < 0 || x > xSize || z < 0 || z > zSize) continue;
    const y = getElevAt(elevGrid, gridN, x / xSize, z / zSize) * vertExag;
    const s = 0.7 + Math.random() * 0.7;
    pos.set(x, y, z); scl.set(s, s, s);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    m.compose(pos, q, scl);
    trunks.setMatrixAt(i, m);
    crowns.setMatrixAt(i, m);
  }
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.name = 'trees';
  group.add(trunks);
  group.add(crowns);
  return group;
}

function _pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi + 1e-9) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}
