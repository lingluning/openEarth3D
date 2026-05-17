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

function getBuildingColor(tags) {
  const t = tags.building || '';
  if (t === 'residential' || t === 'house' || t === 'apartments') return 0xd4a96a;
  if (t === 'commercial' || t === 'retail' || t === 'office') return 0x7ab8d4;
  if (t === 'industrial' || t === 'warehouse') return 0xa0a0a0;
  if (t === 'church' || t === 'cathedral' || t === 'temple') return 0xe8c87a;
  return 0xc8c0b8;
}

function buildingToMesh(building, bb, elevGrid, gridN, vertExag) {
  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);

  // local XZ coords
  const pts2d = building.coords.map(c => ({
    x: toLocalX(c.lon, bb),
    z: toLocalZ(c.lat, bb)
  }));

  // signed area in XZ space
  const area2 = pts2d.reduce((s, p, i) => {
    const q = pts2d[(i + 1) % pts2d.length];
    return s + (p.x * q.z - q.x * p.z);
  }, 0);
  // for correct shape winding with y=-z trick: need area2 < 0
  if (area2 > 0) pts2d.reverse();

  // Three.js Shape is in XY plane; we store (x, -z) so that after
  // applyMatrix4(rotateX(-PI/2)) the result lands in world XZ correctly:
  //   shape(x, -z, 0)  →  world(x, 0,  z)  ✓
  //   extrusion(x, -z, h) →  world(x, h,  z)  ✓
  const shapePts = pts2d.map(p => new THREE.Vector2(p.x, -p.z));
  const shape = new THREE.Shape(shapePts);

  // building base elevation (with vertical exaggeration)
  const cx = pts2d.reduce((s, p) => s + p.x, 0) / pts2d.length;
  const cz = pts2d.reduce((s, p) => s + p.z, 0) / pts2d.length;
  const rx = Math.max(0, Math.min(1, cx / xSize));
  const rz = Math.max(0, Math.min(1, cz / zSize));
  const baseElev = getElevAt(elevGrid, gridN, rx, rz) * vertExag;

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: building.height,
    bevelEnabled: false
  });
  // rotate geometry (not mesh) so extrusion axis Z → world Y (up)
  // and shape Y=-z → world Z (south)
  geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));

  const color = getBuildingColor(building.tags);
  const mat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, baseElev, 0);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}

function createBuildingGroup(buildings, bb, elevGrid, gridN, vertExag) {
  const group = new THREE.Group();
  for (const b of buildings) {
    try {
      const mesh = buildingToMesh(b, bb, elevGrid, gridN, vertExag);
      group.add(mesh);
    } catch {}
  }
  return group;
}
