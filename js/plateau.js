'use strict';

// ── PLATEAU LOD2 integration ──────────────────────────────────────────────
// Pulls Japanese government 3D city models (real roof shapes, real heights,
// embedded photo textures) and drops them into our local-metres Three.js
// scene. Falls back to OSM in app.js when this returns null.
//
// We bypass the 3d-tiles-renderer library: it's ES-module-only and would
// drag in a second copy of THREE that won't share types with ours. Manual
// loading is ~150 LOC and gives us full control over LOD selection.

// ── City lat/lon bboxes that have confirmed PLATEAU coverage ───────────
// Catalog lookup happens at runtime via GraphQL; this table just tells us
// which city code to query for a given click point. Bboxes are loose — we
// only need them to win an "is this lat/lon inside this ward" check.
const PLATEAU_CITIES = [
  // Tokyo 23 wards (most have LOD2 for at least part of their footprint)
  { code: '13101', name: '千代田区', bb: { s: 35.679, n: 35.708, w: 139.743, e: 139.787 } },
  { code: '13102', name: '中央区',   bb: { s: 35.655, n: 35.694, w: 139.748, e: 139.808 } },
  { code: '13103', name: '港区',     bb: { s: 35.605, n: 35.683, w: 139.708, e: 139.788 } },
  { code: '13104', name: '新宿区',   bb: { s: 35.668, n: 35.731, w: 139.675, e: 139.738 } },
  { code: '13105', name: '文京区',   bb: { s: 35.700, n: 35.742, w: 139.726, e: 139.778 } },
  { code: '13106', name: '台東区',   bb: { s: 35.696, n: 35.732, w: 139.766, e: 139.806 } },
  { code: '13107', name: '墨田区',   bb: { s: 35.683, n: 35.736, w: 139.787, e: 139.835 } },
  { code: '13108', name: '江東区',   bb: { s: 35.605, n: 35.704, w: 139.794, e: 139.873 } },
  { code: '13109', name: '品川区',   bb: { s: 35.585, n: 35.638, w: 139.708, e: 139.785 } },
  { code: '13110', name: '目黒区',   bb: { s: 35.605, n: 35.654, w: 139.658, e: 139.715 } },
  { code: '13111', name: '大田区',   bb: { s: 35.535, n: 35.616, w: 139.667, e: 139.825 } },
  { code: '13112', name: '世田谷区', bb: { s: 35.603, n: 35.681, w: 139.575, e: 139.677 } },
  { code: '13113', name: '渋谷区',   bb: { s: 35.645, n: 35.688, w: 139.670, e: 139.723 } },
  { code: '13114', name: '中野区',   bb: { s: 35.685, n: 35.731, w: 139.633, e: 139.685 } },
  { code: '13115', name: '杉並区',   bb: { s: 35.665, n: 35.738, w: 139.605, e: 139.675 } },
  { code: '13116', name: '豊島区',   bb: { s: 35.720, n: 35.751, w: 139.689, e: 139.736 } },
  { code: '13117', name: '北区',     bb: { s: 35.738, n: 35.793, w: 139.715, e: 139.769 } },
  { code: '13118', name: '荒川区',   bb: { s: 35.727, n: 35.752, w: 139.755, e: 139.810 } },
  { code: '13119', name: '板橋区',   bb: { s: 35.745, n: 35.804, w: 139.652, e: 139.738 } },
  { code: '13120', name: '練馬区',   bb: { s: 35.717, n: 35.795, w: 139.572, e: 139.683 } },
  { code: '13121', name: '足立区',   bb: { s: 35.748, n: 35.823, w: 139.748, e: 139.875 } },
  { code: '13122', name: '葛飾区',   bb: { s: 35.722, n: 35.793, w: 139.819, e: 139.913 } },
  { code: '13123', name: '江戸川区', bb: { s: 35.620, n: 35.781, w: 139.823, e: 139.940 } },
  // Other major cities with PLATEAU coverage
  { code: '01101', name: '札幌市中央区', bb: { s: 43.020, n: 43.094, w: 141.291, e: 141.378 } },
  { code: '27100', name: '大阪市',   bb: { s: 34.585, n: 34.762, w: 135.385, e: 135.555 } },
  { code: '14100', name: '横浜市',   bb: { s: 35.300, n: 35.580, w: 139.515, e: 139.788 } },
  { code: '23100', name: '名古屋市', bb: { s: 35.080, n: 35.290, w: 136.795, e: 137.025 } },
  { code: '26100', name: '京都市',   bb: { s: 34.875, n: 35.330, w: 135.605, e: 135.870 } },
  { code: '40100', name: '北九州市', bb: { s: 33.797, n: 33.953, w: 130.690, e: 131.030 } },
  { code: '40130', name: '福岡市',   bb: { s: 33.495, n: 33.704, w: 130.302, e: 130.480 } },
];

function findPlateauCity(lat, lon) {
  for (const c of PLATEAU_CITIES) {
    if (lat >= c.bb.s && lat <= c.bb.n && lon >= c.bb.w && lon <= c.bb.e) return c;
  }
  return null;
}

// ── PLATEAU catalog API — resolve cityCode → bldg LOD2 tileset URL ─────
async function fetchPlateauTilesetUrl(cityCode) {
  const query = `{
    datasets(input: {cityCode: "${cityCode}", type: "plateau"}) {
      items { items { name url type } }
    }
  }`;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 8000);
  const res = await fetch('https://api.plateauview.mlit.go.jp/datacatalog/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: ctrl.signal,
  });
  const json = await res.json();
  const all = (json?.data?.datasets?.items || []).flatMap(d => d.items || []);
  const bldg = all.filter(i => i.url && i.url.includes('bldg') && i.url.endsWith('tileset.json'));
  if (bldg.length === 0) return null;
  // Prefer LOD2 (real roof shapes) over LOD1 (boxes).
  const lod2 = bldg.find(i => /lod2/i.test(i.url));
  return (lod2 || bldg[0]).url;
}

// ── ECEF math ───────────────────────────────────────────────────────────
// WGS84 ellipsoid constants.
const WGS84_A  = 6378137.0;
const WGS84_E2 = 0.006694379990141316;  // first eccentricity squared

function geodeticToEcef(latDeg, lonDeg, h = 0) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const sLat = Math.sin(lat), cLat = Math.cos(lat);
  const sLon = Math.sin(lon), cLon = Math.cos(lon);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sLat * sLat);
  return new THREE.Vector3(
    (N + h) * cLat * cLon,
    (N + h) * cLat * sLon,
    (N * (1 - WGS84_E2) + h) * sLat
  );
}

// Build a 4×4 transform that takes ECEF coordinates to our local frame:
// +X east, +Y up, +Z south, NW corner of `bb` at (0, 0, 0).
function buildEcefToLocalMatrix(bb) {
  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);
  const lat0 = (bb.n + bb.s) / 2;
  const lon0 = (bb.w + bb.e) / 2;
  const O = geodeticToEcef(lat0, lon0, 0);

  const lat = lat0 * Math.PI / 180, lon = lon0 * Math.PI / 180;
  const sLat = Math.sin(lat), cLat = Math.cos(lat);
  const sLon = Math.sin(lon), cLon = Math.cos(lon);

  // ENU basis vectors expressed in ECEF coordinates.
  const east  = new THREE.Vector3(-sLon,            cLon,           0);
  const north = new THREE.Vector3(-sLat * cLon,    -sLat * sLon,    cLat);
  const up    = new THREE.Vector3( cLat * cLon,     cLat * sLon,    sLat);

  // local = R^T · (ecef - O) + (xSize/2, 0, zSize/2)
  // Row layout — east row, up row, -north row, identity translation row.
  // Translation column folds in the offset to NW-corner origin.
  const m = new THREE.Matrix4();
  m.set(
     east.x,    east.y,    east.z,    -east.dot(O)  + xSize / 2,
     up.x,      up.y,      up.z,      -up.dot(O),
    -north.x,  -north.y,  -north.z,    north.dot(O) + zSize / 2,
     0,         0,         0,          1
  );
  return m;
}

// ── b3dm parser ────────────────────────────────────────────────────────
// b3dm = 28-byte header + featureTable (JSON + binary) + batchTable
//        (JSON + binary) + embedded glb. We skip everything except the glb.
function parseB3dm(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1),
                                    view.getUint8(2), view.getUint8(3));
  if (magic !== 'b3dm') throw new Error(`not a b3dm tile (magic=${magic})`);
  const ftJsonLen = view.getUint32(12, true);
  const ftBinLen  = view.getUint32(16, true);
  const btJsonLen = view.getUint32(20, true);
  const btBinLen  = view.getUint32(24, true);
  return buffer.slice(28 + ftJsonLen + ftBinLen + btJsonLen + btBinLen);
}

// ── Bounding-volume tests ─────────────────────────────────────────────
// A 3D Tiles `region` is [west, south, east, north, minH, maxH] in radians.
// We use it to discard tiles whose ground footprint doesn't touch our bbox.
function tileRegionIntersects(region, bb) {
  if (!region) return true;  // unknown bounding type → keep, be conservative
  const w = region[0] * 180 / Math.PI, s = region[1] * 180 / Math.PI;
  const e = region[2] * 180 / Math.PI, n = region[3] * 180 / Math.PI;
  return !(e < bb.w || w > bb.e || n < bb.s || s > bb.n);
}

// ── Tile loader ────────────────────────────────────────────────────────
// Walk the tile hierarchy, collect leaves whose region intersects bb, then
// fetch + parse + add to scene with capped concurrency. No streaming LOD —
// we load the smallest level of the hierarchy that covers the bbox.
async function loadPlateauBuildings(tilesetUrl, bb, onProgress) {
  if (typeof THREE.GLTFLoader !== 'function') {
    throw new Error('GLTFLoader not loaded — add the three GLTFLoader script tag');
  }

  onProgress && onProgress(0, 'PLATEAU カタログ読込中…');
  const tileset = await fetch(tilesetUrl).then(r => r.json());
  const baseUrl = tilesetUrl.substring(0, tilesetUrl.lastIndexOf('/') + 1);

  // Collect leaf tiles (no children) whose region intersects bb. PLATEAU
  // tilesets typically nest content+children at parent levels; we only
  // grab the deepest content to avoid double-drawing.
  const leaves = [];
  function walk(tile, inherited) {
    const region = tile.boundingVolume?.region;
    if (!tileRegionIntersects(region, bb)) return;
    const xform = inherited.clone();
    if (tile.transform) {
      const m = new THREE.Matrix4().fromArray(tile.transform);
      xform.multiply(m);
    }
    const hasChildren = Array.isArray(tile.children) && tile.children.length > 0;
    if (hasChildren) {
      for (const c of tile.children) walk(c, xform);
    } else if (tile.content?.uri) {
      leaves.push({ uri: tile.content.uri, transform: xform });
    }
  }
  walk(tileset.root, new THREE.Matrix4());

  if (leaves.length === 0) {
    onProgress && onProgress(1, 'PLATEAU: bbox 範囲に該当タイル無し');
    return null;
  }

  // Decompose the ECEF→local matrix into position/quaternion/scale so we
  // can keep matrixAutoUpdate = true and let the renderer's normal
  // matrixWorld pipeline handle it. Same trick for per-tile transforms.
  const ecefToLocal = buildEcefToLocalMatrix(bb);
  const group = new THREE.Group();
  group.name = 'plateau';
  ecefToLocal.decompose(group.position, group.quaternion, group.scale);

  const loader = new THREE.GLTFLoader();
  let done = 0;
  const CONCURRENCY = 6;

  async function loadOne(leaf) {
    try {
      const buffer = await fetch(baseUrl + leaf.uri).then(r => r.arrayBuffer());
      const glb = parseB3dm(buffer);
      const gltf = await new Promise((resolve, reject) => {
        loader.parse(glb, '', resolve, reject);
      });
      // 3D Tiles convention: glTF assets are Y-up. Tile transforms in ECEF
      // already include the orientation flip, so we just apply the tile
      // transform and let the group's ECEF→local matrix do the rest.
      leaf.transform.decompose(gltf.scene.position, gltf.scene.quaternion, gltf.scene.scale);
      // Shadows on every mesh in the tile.
      gltf.scene.traverse(o => {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      group.add(gltf.scene);
    } catch (e) {
      // Skip individual tile failures; PLATEAU CDN occasionally serves
      // partial responses and one bad tile shouldn't take down the city.
      console.warn('PLATEAU tile failed:', leaf.uri, e.message);
    }
    done++;
    onProgress && onProgress(done / leaves.length, `PLATEAU タイル ${done}/${leaves.length}`);
  }

  // Capped concurrency — PLATEAU CDN handles a handful of parallel requests
  // fine but 100+ at once trips its rate limiter.
  const queue = leaves.slice();
  async function pump() {
    while (queue.length) {
      const leaf = queue.shift();
      if (leaf) await loadOne(leaf);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, pump));

  return group;
}
