'use strict';

async function fetchBuildings(bb) {
  const q = `[out:json][timeout:30];
(
  way["building"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["building"](${bb.s},${bb.w},${bb.n},${bb.e});
);
out body;>;out skel qt;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(q)
  });
  const json = await res.json();
  return json.elements;
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
    const levels = levelsRaw ? parseFloat(levelsRaw) : 2;
    const height = tags.height ? parseFloat(tags.height) : Math.max(3, levels * 3.2);

    buildings.push({ coords, height, tags });
  });
  return buildings;
}

// Cache facade textures by color key
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

  // base wall
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, W, H);

  // horizontal floor lines (concrete)
  ctx.strokeStyle = `rgba(0,0,0,0.12)`;
  ctx.lineWidth = 1;
  for (let y = 22; y < H; y += 22) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // window grid
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
        // curtain wall: full blue-green glass
        const grad = ctx.createLinearGradient(wx, wy, wx + winW, wy + winH);
        grad.addColorStop(0, 'rgba(140,210,240,0.88)');
        grad.addColorStop(0.5, 'rgba(100,180,220,0.75)');
        grad.addColorStop(1, 'rgba(60,140,190,0.82)');
        ctx.fillStyle = grad;
        ctx.fillRect(wx, wy, winW, winH);
        // reflection highlight
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(wx + 2, wy + 2, winW * 0.35, winH * 0.4);
      } else {
        const lit = Math.random() > 0.18;
        ctx.fillStyle = lit ? 'rgba(200,228,255,0.80)' : 'rgba(22,30,50,0.86)';
        ctx.fillRect(wx, wy, winW, winH);
        if (lit) {
          // window divider
          ctx.strokeStyle = 'rgba(180,210,240,0.6)';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(wx + winW * 0.5, wy);
          ctx.lineTo(wx + winW * 0.5, wy + winH);
          ctx.stroke();
        }
      }
      // window frame
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(wx, wy, winW, winH);
    }
  }

  const tex = new THREE.CanvasTexture(cvs);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  _facadeCache[key] = tex;
  return tex;
}

function getBuildingStyle(tags) {
  const t = tags.building || '';
  if (t === 'commercial' || t === 'retail' || t === 'office' || t === 'civic')
    return { wall: 0x8ab8cc, roof: 0x3a6070, type: 'glass' };
  if (t === 'residential' || t === 'house' || t === 'apartments' || t === 'dormitory')
    return { wall: 0xd8b87a, roof: 0x6e4e28, type: 'concrete' };
  if (t === 'industrial' || t === 'warehouse' || t === 'factory')
    return { wall: 0xa8a8a0, roof: 0x505048, type: 'concrete' };
  if (t === 'church' || t === 'cathedral' || t === 'temple' || t === 'shrine')
    return { wall: 0xe0cc80, roof: 0x5a4a20, type: 'concrete' };
  return { wall: 0xc8c0b4, roof: 0x585048, type: 'concrete' };
}

function buildingToMesh(building, bb, elevGrid, gridN, vertExag) {
  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);

  const pts2d = building.coords.map(c => ({
    x: toLocalX(c.lon, bb),
    z: toLocalZ(c.lat, bb)
  }));

  // signed area in XZ; for correct shape winding after y=-z trick, need area2 < 0
  const area2 = pts2d.reduce((s, p, i) => {
    const q = pts2d[(i + 1) % pts2d.length];
    return s + (p.x * q.z - q.x * p.z);
  }, 0);
  if (area2 > 0) pts2d.reverse();

  // shape: (x, -z) so applyMatrix4(rotX(-PI/2)) maps correctly to world XZ
  const shapePts = pts2d.map(p => new THREE.Vector2(p.x, -p.z));
  const shape = new THREE.Shape(shapePts);

  // elevation at building centroid
  const cx = pts2d.reduce((s, p) => s + p.x, 0) / pts2d.length;
  const cz = pts2d.reduce((s, p) => s + p.z, 0) / pts2d.length;
  const rx = Math.max(0, Math.min(1, cx / xSize));
  const rz = Math.max(0, Math.min(1, cz / zSize));
  const baseElev = getElevAt(elevGrid, gridN, rx, rz) * vertExag;

  const style = getBuildingStyle(building.tags);

  const geo = new THREE.ExtrudeGeometry(shape, { depth: building.height, bevelEnabled: false });
  // fix coordinate system: shape XY → world XZ, extrusion Z → world Y (up)
  geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));

  const facadeTex = makeFacadeTexture(style.wall, style.type);
  const wallMat = new THREE.MeshPhongMaterial({
    map: facadeTex,
    shininess: style.type === 'glass' ? 60 : 20,
    specular: style.type === 'glass' ? new THREE.Color(0x88ccee) : new THREE.Color(0x222222)
  });
  const roofMat = new THREE.MeshLambertMaterial({ color: style.roof });

  const mesh = new THREE.Mesh(geo, [wallMat, roofMat]);
  mesh.position.set(0, baseElev, 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
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
