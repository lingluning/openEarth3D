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

function buildingToMesh(building, bb, elevGrid, gridN) {
  const pts = building.coords.map(c => {
    const x = toLocalX(c.lon, bb);
    const z = toLocalZ(c.lat, bb);
    return new THREE.Vector2(x, z);
  });

  // ensure CCW winding for Three.js shape
  const area2 = pts.reduce((s, p, i) => {
    const q = pts[(i + 1) % pts.length];
    return s + (p.x * q.y - q.x * p.y);
  }, 0);
  if (area2 < 0) pts.reverse();

  const shape = new THREE.Shape(pts);
  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);

  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const rx = Math.max(0, Math.min(1, cx / xSize));
  const rz = Math.max(0, Math.min(1, cz / zSize));
  const baseElev = getElevAt(elevGrid, gridN, rx, rz);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: building.height,
    bevelEnabled: false
  });

  const color = getBuildingColor(building.tags);
  const mat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);

  // ExtrudeGeometry extrudes along Z; rotate so extrusion goes up (Y)
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, baseElev, 0);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}

function createBuildingGroup(buildings, bb, elevGrid, gridN) {
  const group = new THREE.Group();
  for (const b of buildings) {
    try {
      const mesh = buildingToMesh(b, bb, elevGrid, gridN);
      group.add(mesh);
    } catch {}
  }
  return group;
}
