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
  way["leisure"="park"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["leisure"="garden"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["landuse"="village_green"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["landuse"="grass"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["landuse"="cemetery"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["natural"="scrub"](${bb.s},${bb.w},${bb.n},${bb.e});
  node["natural"="tree"](${bb.s},${bb.w},${bb.n},${bb.e});
);
out body;>;out skel qt;`;
  // _overpassJson lives in buildings.js; it surfaces 429 / 504 cleanly
  // instead of letting res.json() throw an unhelpful SyntaxError.
  return _overpassJson(q);
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

// Vegetation areas with their tree-sprinkle density (trees per m²). Higher
// for actual woods, lower for ornamental parks so a city park reads as
// foliage without overwhelming the GPU.
const VEGETATION_DENSITY = {
  forest: 0.0010,
  park:   0.0005,
  garden: 0.0008,
  cemetery: 0.0003,
  grass: 0.0002,
  scrub: 0.0006,
};

function parseGroundFeatures(elements, bb) {
  const nodeMap = {};
  elements.filter(e => e.type === 'node').forEach(n => { nodeMap[n.id] = n; });

  const roads = [], waters = [], forests = [], trees = [], bridges = [];

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
        // OSM tags bridges with `bridge=*` on the underlying highway way.
        // `bridge=no` means "explicitly not a bridge" (rare), everything
        // else (yes/viaduct/cantilever/suspension/…) counts.
        const isBridge = t.bridge && t.bridge !== 'no';
        if (isBridge) {
          const layer = parseInt(t.layer, 10);
          bridges.push({
            coords,
            width: style.w,
            // Use OSM `layer` (typical bridges have layer=1..3) to space
            // stacked structures; fall back to 1 for un-tagged bridges.
            layer: Number.isFinite(layer) && layer > 0 ? layer : 1,
            kind: t.bridge,
          });
        } else {
          roads.push({ coords, ...style });
        }
      } else if (t.natural === 'water' || t.water || t.waterway === 'riverbank') {
        if (coords.length >= 3) waters.push({ coords });
      } else if (coords.length >= 3) {
        // Classify any vegetation polygon by its expected planting density.
        let density = 0;
        if (t.landuse === 'forest' || t.natural === 'wood')        density = VEGETATION_DENSITY.forest;
        else if (t.leisure === 'park')                              density = VEGETATION_DENSITY.park;
        else if (t.leisure === 'garden')                            density = VEGETATION_DENSITY.garden;
        else if (t.landuse === 'cemetery')                          density = VEGETATION_DENSITY.cemetery;
        else if (t.landuse === 'village_green' || t.landuse === 'grass') density = VEGETATION_DENSITY.grass;
        else if (t.natural === 'scrub')                             density = VEGETATION_DENSITY.scrub;
        if (density > 0) forests.push({ coords, density });
      }
    } else if (e.type === 'node' && e.tags && e.tags.natural === 'tree') {
      trees.push({ lat: e.lat, lon: e.lon });
    }
  }
  return { roads, waters, forests, trees, bridges };
}

// ── Road geometry — flat ribbons hovering 0.5 m above the terrain ─────────
function _toLocal(c, bb) { return { x: toLocalX(c.lon, bb), z: toLocalZ(c.lat, bb) }; }

function _buildRoadRibbon(coords, width, bb, elevGrid, gridN, vertExag) {
  // Drop near-coincident consecutive points up front. OSM occasionally
  // stacks two nodes at the same coordinate (digitisation noise), which
  // makes the bisector calc go undefined and produces visible spikes /
  // gaps in the ribbon.
  const raw = coords.map(c => _toLocal(c, bb));
  const pts = raw.length ? [raw[0]] : [];
  for (let i = 1; i < raw.length; i++) {
    const last = pts[pts.length - 1];
    if (Math.hypot(raw[i].x - last.x, raw[i].z - last.z) > 0.1) pts.push(raw[i]);
  }
  const n = pts.length;
  if (n < 2) {
    const empty = new THREE.BufferGeometry();
    empty.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    empty.setAttribute('uv',       new THREE.Float32BufferAttribute([], 2));
    return empty;
  }

  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);
  const half = width / 2;
  const LIFT = 0.5;
  // Miter length cap — beyond this multiplier of half-width the corner
  // would spike off into the distance on near-180° hairpin turns.
  const MITER_LIMIT = 4.0;
  // Extend the first and last segments by half a road-width along their
  // own direction so each ribbon's end pokes into adjacent ribbons at
  // junctions. Cheap visual fix for OSM's "every road is a separate way
  // even at intersections" topology — without an actual road graph join,
  // this overlap covers the gap.
  const ENDPOINT_EXTEND = half;

  // Unit tangent of segment i→i+1.
  const tangents = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i+1].x - pts[i].x;
    const dz = pts[i+1].z - pts[i].z;
    const L = Math.hypot(dx, dz);
    tangents[i] = L > 0 ? { x: dx / L, z: dz / L } : { x: 1, z: 0 };
  }
  const t0 = tangents[0], tEnd = tangents[n - 2];

  // Extended endpoint positions for triangle assembly (originals stay in
  // `pts` so tangent indexing doesn't drift).
  const p0Ext  = { x: pts[0].x   - t0.x   * ENDPOINT_EXTEND, z: pts[0].z   - t0.z   * ENDPOINT_EXTEND };
  const pEndExt = { x: pts[n-1].x + tEnd.x * ENDPOINT_EXTEND, z: pts[n-1].z + tEnd.z * ENDPOINT_EXTEND };

  // Per-vertex miter offset: direction perpendicular to the bisector of
  // incoming + outgoing tangents, length = half_width / cos(half_angle).
  // Using |t_in + t_out| = 2·cos(half_angle), the factor becomes 2/|b|.
  // This is the standard "stroke miter" formula — it keeps the road's
  // outer edge straight through corners instead of pinching inward.
  const offsets = new Array(n);
  for (let i = 0; i < n; i++) {
    const tin  = i > 0     ? tangents[i - 1] : tangents[i];
    const tout = i < n - 1 ? tangents[i]     : tangents[i - 1];
    const bx = tin.x + tout.x, bz = tin.z + tout.z;
    const blen = Math.hypot(bx, bz);
    let nx, nz, len;
    if (blen < 1e-6) {
      // Degenerate 180° turn — fall back to in-tangent's perpendicular.
      nx = -tin.z; nz = tin.x; len = half;
    } else {
      nx = -bz / blen;
      nz =  bx / blen;
      len = half * Math.min(MITER_LIMIT, 2 / blen);
    }
    offsets[i] = { nx, nz, len };
  }

  function elevAt(x, z) {
    const rx = Math.max(0, Math.min(1, x / xSize));
    const rz = Math.max(0, Math.min(1, z / zSize));
    return getElevAt(elevGrid, gridN, rx, rz) * vertExag + LIFT;
  }
  function vertexAt(i) {
    if (i === 0)     return p0Ext;
    if (i === n - 1) return pEndExt;
    return pts[i];
  }

  const positions = [], uvs = [];
  let u = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = vertexAt(i), b = vertexAt(i + 1);
    const oa = offsets[i], ob = offsets[i + 1];
    const al = { x: a.x + oa.nx * oa.len, z: a.z + oa.nz * oa.len };
    const ar = { x: a.x - oa.nx * oa.len, z: a.z - oa.nz * oa.len };
    const bl = { x: b.x + ob.nx * ob.len, z: b.z + ob.nz * ob.len };
    const br = { x: b.x - ob.nx * ob.len, z: b.z - ob.nz * ob.len };
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const uNext = u + segLen / width;  // texture repeat per road-width

    // Horizontal triangles wound CCW from +Y so the up-pointing normal
    // survives backface culling.
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
    const mat = new THREE.MeshLambertMaterial({
      color: parseInt(col, 10),
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

// ── Bridges — elevated road deck + thickness + parapets ──────────────────
// OSM marks bridges with `bridge=*` on the underlying highway way; we
// pull those out in parseGroundFeatures and render them separately so the
// deck sits above the terrain (and above water) rather than draped on it.
//
// The geometry is layered:
//   • deck  : a solid slab ~0.5 m thick along the ribbon path, top
//             surface at  baseY + lift, bottom at top - thickness.
//   • parapet: a thin vertical wall on each side of the deck, rising
//             ~1 m above the deck so the side rail reads from far away.
//
// All three meshes per bridge share one Group; we merge into the parent
// `bridges` group at the end so the whole layer is a handful of draw
// calls regardless of how many bridges OSM returned.
function createBridges(bridges, bb, elevGrid, gridN, vertExag) {
  const group = new THREE.Group();
  group.name = 'bridges';
  if (!bridges || bridges.length === 0) return group;

  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);
  // OSM `layer` spacing — typical road bridges sit ~5 m above the deck
  // they cross, viaducts higher. Tuned by eye, not by physics.
  const LIFT_PER_LAYER = 5;
  const DECK_THICKNESS = 0.6;
  const PARAPET_H      = 1.1;
  const PARAPET_T      = 0.25;

  function terrainY(x, z) {
    const rx = Math.max(0, Math.min(1, x / xSize));
    const rz = Math.max(0, Math.min(1, z / zSize));
    return getElevAt(elevGrid, gridN, rx, rz) * vertExag;
  }

  const deckPositions = [], parapetPositions = [];

  for (const br of bridges) {
    const pts = br.coords.map(c => _toLocal(c, bb));
    const n = pts.length;
    if (n < 2) continue;

    // Bridge deck stays at a constant lift above the average ground
    // elevation along the bridge — gives a flat deck instead of a deck
    // that follows terrain dips under it.
    let avg = 0;
    for (const p of pts) avg += terrainY(p.x, p.z);
    avg /= n;
    const deckTopY = avg + LIFT_PER_LAYER * br.layer;
    const deckBotY = deckTopY - DECK_THICKNESS;

    // Outward normals at each vertex (averaged with neighbour).
    const normals = new Array(n);
    for (let i = 0; i < n; i++) {
      let dx = 0, dz = 0;
      if (i > 0)     { dx += pts[i].x - pts[i-1].x; dz += pts[i].z - pts[i-1].z; }
      if (i < n - 1) { dx += pts[i+1].x - pts[i].x; dz += pts[i+1].z - pts[i].z; }
      const L = Math.hypot(dx, dz) || 1;
      normals[i] = { x: -dz / L, z: dx / L };
    }
    const half = br.width / 2;

    for (let i = 0; i < n - 1; i++) {
      const a = pts[i],     na = normals[i];
      const b = pts[i + 1], nb = normals[i + 1];
      const al = { x: a.x + na.x * half, z: a.z + na.z * half };
      const ar = { x: a.x - na.x * half, z: a.z - na.z * half };
      const bl = { x: b.x + nb.x * half, z: b.z + nb.z * half };
      const br_ = { x: b.x - nb.x * half, z: b.z - nb.z * half };

      // ── Deck slab — 4 quads (top, bottom, left side, right side).
      //   Winding picked so right-hand-rule normals point outward in
      //   our +X-east / +Z-south frame (same convention as walls/roads).

      // Top face (visible from above)
      deckPositions.push(
        al.x, deckTopY, al.z,  br_.x, deckTopY, br_.z,  ar.x, deckTopY, ar.z,
        al.x, deckTopY, al.z,  bl.x,  deckTopY, bl.z,   br_.x, deckTopY, br_.z
      );
      // Bottom face (visible from below)
      deckPositions.push(
        al.x, deckBotY, al.z,  ar.x, deckBotY, ar.z,  br_.x, deckBotY, br_.z,
        al.x, deckBotY, al.z,  br_.x, deckBotY, br_.z, bl.x, deckBotY, bl.z
      );
      // Left side (al-ar are on +normal side, so 'left' = al/bl edge)
      deckPositions.push(
        al.x, deckBotY, al.z,  bl.x, deckTopY, bl.z,  al.x, deckTopY, al.z,
        al.x, deckBotY, al.z,  bl.x, deckBotY, bl.z,  bl.x, deckTopY, bl.z
      );
      // Right side
      deckPositions.push(
        ar.x, deckBotY, ar.z,  ar.x, deckTopY, ar.z,  br_.x, deckTopY, br_.z,
        ar.x, deckBotY, ar.z,  br_.x, deckTopY, br_.z, br_.x, deckBotY, br_.z
      );

      // ── Parapets — vertical walls on both sides above the deck.
      //   Outer face only; the inside of a parapet is rarely visible.
      const pTop = deckTopY + PARAPET_H;
      // Left parapet — outer face points outward (+normal direction).
      // Slightly inset so it sits on the deck, not flush with the edge.
      const li = PARAPET_T * 0.5;
      const al2 = { x: al.x - na.x * li, z: al.z - na.z * li };
      const bl2 = { x: bl.x - nb.x * li, z: bl.z - nb.z * li };
      parapetPositions.push(
        al2.x, deckTopY, al2.z,  bl2.x, pTop,     bl2.z,  bl2.x, deckTopY, bl2.z,
        al2.x, deckTopY, al2.z,  al2.x, pTop,     al2.z,  bl2.x, pTop,     bl2.z
      );
      // Right parapet
      const ar2 = { x: ar.x + na.x * li, z: ar.z + na.z * li };
      const br2 = { x: br_.x + nb.x * li, z: br_.z + nb.z * li };
      parapetPositions.push(
        ar2.x, deckTopY, ar2.z,  br2.x, deckTopY, br2.z,  br2.x, pTop,     br2.z,
        ar2.x, deckTopY, ar2.z,  br2.x, pTop,     br2.z,  ar2.x, pTop,     ar2.z
      );
    }
  }
  if (deckPositions.length === 0) return group;

  const deckGeo = new THREE.BufferGeometry();
  deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(deckPositions, 3));
  deckGeo.computeVertexNormals();
  const deckMat = new THREE.MeshLambertMaterial({ color: 0x6a6a6a });
  deckMat.name = 'bridge_deck';
  const deckMesh = new THREE.Mesh(deckGeo, deckMat);
  deckMesh.castShadow = true;
  deckMesh.receiveShadow = true;
  group.add(deckMesh);

  const parapetGeo = new THREE.BufferGeometry();
  parapetGeo.setAttribute('position', new THREE.Float32BufferAttribute(parapetPositions, 3));
  parapetGeo.computeVertexNormals();
  const parapetMat = new THREE.MeshLambertMaterial({
    color: 0xcec8c0,
    side: THREE.DoubleSide,  // parapets thin enough that the inside reads
  });
  parapetMat.name = 'bridge_parapet';
  const parapetMesh = new THREE.Mesh(parapetGeo, parapetMat);
  parapetMesh.castShadow = true;
  parapetMesh.receiveShadow = true;
  group.add(parapetMesh);

  return group;
}

// ── Water — flat semi-transparent blue mesh just above terrain ────────────
function createWater(waters, bb, elevGrid, gridN, vertExag) {
  const group = new THREE.Group();
  group.name = 'water';
  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);
  const mat = new THREE.MeshLambertMaterial({
    color: 0x7eb4d4,            // lighter blue, illustration-friendly
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

  // Sprinkle random trees inside each vegetation polygon, with the density
  // already stamped on the polygon by parseGroundFeatures.
  const placements = treePoints.map(t => ({ lat: t.lat, lon: t.lon }));
  const MAX_TOTAL = 8000;       // safety cap

  for (const f of forests) {
    if (placements.length >= MAX_TOTAL) break;
    const pts = f.coords.map(c => ({ x: toLocalX(c.lon, bb), z: toLocalZ(c.lat, bb) }));
    let minX = +Infinity, maxX = -Infinity, minZ = +Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    const bboxArea = Math.max(0, (maxX - minX) * (maxZ - minZ));
    const target = Math.min(1200, Math.round(bboxArea * (f.density || 0.0005)));
    if (target <= 0) continue;
    // Rejection-sample inside the polygon; cap attempts at 4× target.
    let placed = 0, attempts = 0;
    while (placed < target && attempts < target * 4 && placements.length < MAX_TOTAL) {
      attempts++;
      const x = minX + Math.random() * (maxX - minX);
      const z = minZ + Math.random() * (maxZ - minZ);
      if (!_pointInPoly(x, z, pts)) continue;
      if (x < 0 || x > xSize || z < 0 || z > zSize) continue;
      const lat = bb.s + (1 - z / zSize) * (bb.n - bb.s);
      const lon = bb.w + (x / xSize) * (bb.e - bb.w);
      placements.push({ lat, lon });
      placed++;
    }
  }
  if (placements.length === 0) return new THREE.Group();

  // Only trees inside the bbox; classify each into a species so the
  // canopy isn't a regiment of identical cones.
  const inside = [];
  for (const t of placements) {
    const x = toLocalX(t.lon, bb), z = toLocalZ(t.lat, bb);
    if (x < 0 || x > xSize || z < 0 || z > zSize) continue;
    // ~55 % deciduous (round crown), ~45 % coniferous (cone crown).
    inside.push({ x, z, conifer: Math.random() < 0.45 });
  }
  if (inside.length === 0) return new THREE.Group();

  // Shared trunk; two crown shapes.
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 2.5, 6);
  trunkGeo.translate(0, 1.25, 0);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6e4e30 });
  trunkMat.name = 'tree_trunk';

  // Deciduous: rounded icosahedron crown sitting on the trunk top.
  const decidGeo = new THREE.IcosahedronGeometry(2.4, 1);
  decidGeo.scale(1, 1.15, 1);          // slightly egg-shaped
  decidGeo.translate(0, 2.5 + 2.4, 0);
  // Coniferous: tall cone.
  const coniGeo = new THREE.ConeGeometry(2.0, 6.0, 8);
  coniGeo.translate(0, 2.5 + 3.0, 0);

  const decidMat = new THREE.MeshLambertMaterial({ color: 0x5a9a48 });
  decidMat.name = 'tree_crown_deciduous';
  const coniMat = new THREE.MeshLambertMaterial({ color: 0x3f7a44 });
  coniMat.name = 'tree_crown_conifer';

  const nConifer = inside.reduce((s, t) => s + (t.conifer ? 1 : 0), 0);
  const nDecid = inside.length - nConifer;

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, inside.length);
  const decid  = nDecid   ? new THREE.InstancedMesh(decidGeo, decidMat, nDecid) : null;
  const coni   = nConifer ? new THREE.InstancedMesh(coniGeo,  coniMat, nConifer) : null;

  // CRITICAL: r128's InstancedMesh bounding sphere is from the local
  // geometry only, so spread-out instances get the whole mesh
  // frustum-culled the moment the camera looks away from the origin.
  for (const im of [trunks, decid, coni]) {
    if (!im) continue;
    im.frustumCulled = false;
    im.castShadow = true;
    im.receiveShadow = false;
  }
  if (decid) decid.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nDecid * 3), 3);
  if (coni)  coni.instanceColor  = new THREE.InstancedBufferAttribute(new Float32Array(nConifer * 3), 3);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const hue = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  let di = 0, ci = 0;
  for (let i = 0; i < inside.length; i++) {
    const { x, z, conifer } = inside[i];
    const y = getElevAt(elevGrid, gridN, x / xSize, z / zSize) * vertExag;
    // Conifers a touch taller and narrower; deciduous wider.
    const s = (conifer ? 0.65 : 0.75) + Math.random() * 0.7;
    pos.set(x, y, z);
    scl.set(conifer ? s * 0.9 : s * 1.05, s, conifer ? s * 0.9 : s * 1.05);
    q.setFromAxisAngle(up, Math.random() * Math.PI * 2);
    m.compose(pos, q, scl);
    trunks.setMatrixAt(i, m);

    // Crown colour jitter — conifers darker/bluer green, deciduous brighter.
    if (conifer) {
      coni.setMatrixAt(ci, m);
      hue.setHSL(0.33 + (Math.random()-0.5)*0.04, 0.42 + Math.random()*0.2, 0.30 + Math.random()*0.12);
      coni.setColorAt(ci, hue); ci++;
    } else {
      decid.setMatrixAt(di, m);
      hue.setHSL(0.26 + (Math.random()-0.5)*0.07, 0.48 + Math.random()*0.25, 0.42 + Math.random()*0.16);
      decid.setColorAt(di, hue); di++;
    }
  }
  trunks.instanceMatrix.needsUpdate = true;
  if (decid) { decid.instanceMatrix.needsUpdate = true; decid.instanceColor.needsUpdate = true; }
  if (coni)  { coni.instanceMatrix.needsUpdate = true;  coni.instanceColor.needsUpdate = true; }

  const group = new THREE.Group();
  group.name = 'trees';
  group.add(trunks);
  if (decid) group.add(decid);
  if (coni)  group.add(coni);
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
