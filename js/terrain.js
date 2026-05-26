'use strict';

// Fractional tile position (not floored)
function deg2tileFrac(lat, lon, z) {
  const n = Math.pow(2, z);
  const lr = lat * Math.PI / 180;
  return {
    x: (lon + 180) / 360 * n,
    y: (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n
  };
}

// GSI DEM sources, tried in order at the same (z,tx,ty):
//   dem5a_png — 5m DEM, narrowest coverage (excludes outer islands)
//   dem_png   — 10m DEM, covers essentially all of Japan
// Outside Japan both 404 and the cascade falls back to Terrarium.
// We use fetch() instead of <img> so 404s stay out of the console.
const GSI_DEM_SOURCES = ['dem5a_png', 'dem_png'];

// Decode a DEM PNG blob → Float32Array(256*256) using the given (r,g,b)→elev fn
async function decodeDemBlob(blob, decode) {
  const bitmap = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, 256, 256);
  bitmap.close && bitmap.close();
  const px = ctx.getImageData(0, 0, 256, 256).data;
  const arr = new Float32Array(256 * 256);
  for (let i = 0; i < 256 * 256; i++) {
    arr[i] = decode(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  }
  return arr;
}

// GSI PNG encoding: signed 24-bit, 0.01m units, 0x800000 = no-data
function decodeGsi(r, g, b) {
  const v = r * 65536 + g * 256 + b;
  return v === 8388608 ? 0 : v < 8388608 ? v * 0.01 : (v - 16777216) * 0.01;
}

// Terrarium PNG encoding: elevation = R*256 + G + B/256 - 32768
function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

// GSI DEM tile (Japan only). Tries dem5a then dem. Returns null silently
// on 404 — the cascade caller will fall back to global Terrarium.
async function fetchDemTile(z, tx, ty) {
  for (const name of GSI_DEM_SOURCES) {
    try {
      const res = await cachedFetch(`https://cyberjapandata.gsi.go.jp/xyz/${name}/${z}/${tx}/${ty}.png`);
      if (!res.ok) continue;
      return await decodeDemBlob(await res.blob(), decodeGsi);
    } catch {
      // network error → try next source
    }
  }
  return null;
}

// AWS Terrarium global DEM (ex-Mapzen, free, no key, full global coverage)
async function fetchTerrariumTile(z, tx, ty) {
  try {
    const res = await cachedFetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`);
    if (!res.ok) return null;
    return await decodeDemBlob(await res.blob(), decodeTerrarium);
  } catch {
    return null;
  }
}

// Parallel map with a concurrency cap. Lets us fan out tile fetches without
// flooding the browser's request queue.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function pump() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

// Bilinear sample from a decoded tile array
function sampleTile(arr, fx, fy) {
  if (!arr) return 0;
  const x0 = Math.max(0, Math.min(255, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(255, Math.floor(fy)));
  const x1 = Math.min(255, x0 + 1);
  const y1 = Math.min(255, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  return (arr[y0 * 256 + x0] * (1 - tx) + arr[y0 * 256 + x1] * tx) * (1 - ty)
       + (arr[y1 * 256 + x0] * (1 - tx) + arr[y1 * 256 + x1] * tx) * ty;
}

// Catmull-Rom 1D cubic. Smoother than bilinear when the output grid is
// denser than the DEM source; preserves curvature instead of flattening
// the surface into long planar facets.
function _cubic(p0, p1, p2, p3, t) {
  const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
  const c = -0.5 * p0 + 0.5 * p2;
  return ((a * t + b) * t + c) * t + p1;
}

function _readClamped(arr, x, y) {
  const cx = Math.max(0, Math.min(255, x));
  const cy = Math.max(0, Math.min(255, y));
  return arr[cy * 256 + cx];
}

// Bicubic sample of a 256×256 tile. Only worth doing when the output mesh
// is denser than DEM pixels (otherwise we're oversampling and bilinear
// suffices).
function sampleTileCubic(arr, fx, fy) {
  if (!arr) return 0;
  const x = Math.floor(fx), y = Math.floor(fy);
  const tx = fx - x, ty = fy - y;
  const rows = new Array(4);
  for (let j = 0; j < 4; j++) {
    const yy = y - 1 + j;
    rows[j] = _cubic(
      _readClamped(arr, x - 1, yy),
      _readClamped(arr, x,     yy),
      _readClamped(arr, x + 1, yy),
      _readClamped(arr, x + 2, yy),
      tx
    );
  }
  return _cubic(rows[0], rows[1], rows[2], rows[3], ty);
}

// Terrain tile with cascade: GSI dem5a (Japan ~5m) → AWS Terrarium (global ~30m)
// GSI 404 (sea/outside Japan) is silently handled — no console errors for missing tiles
async function fetchDemTileCascade(z, tx, ty) {
  const gsi = await fetchDemTile(z, tx, ty);
  if (gsi) return gsi;
  // GSI returned null (404 or outside coverage) → fall back to global Terrarium
  return await fetchTerrariumTile(z, tx, ty);
}

// Pick the DEM XYZ zoom that gives roughly one DEM pixel per output grid
// cell. Going higher just downloads more tiles without adding real detail
// (oversampling), going lower wastes mesh density (interpolation noise).
//   metersPerPixel(z, lat) ≈ 156543 · cos(lat) / 2^z
function pickDemZoom(bb, meshN, zMax = 15, zMin = 9) {
  const midLat = (bb.n + bb.s) / 2;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  // Bbox width in metres at the centre latitude.
  const widthM = (bb.e - bb.w) * (Math.PI / 180) * 6378137 * cosLat;
  const cellM = widthM / (meshN - 1);
  for (let z = zMax; z >= zMin; z--) {
    const pxM = 156543.03 * cosLat / Math.pow(2, z);
    if (pxM <= cellM) return z;     // first zoom whose pixels fit in a cell
  }
  return zMin;
}

// High-resolution terrain grid.
//   Japan:         GSI dem5a (~5m, z=15) → dem (~10m, z=14)
//   Outside Japan: AWS Terrarium (~30m, z=15)
// `zoom` defaults to whatever fits the requested mesh density best; pass a
// fixed value to force a particular DEM zoom level.
async function fetchElevGridHiRes(bb, meshN, onProgress, zoom) {
  const z = zoom || pickDemZoom(bb, meshN);
  const nwF = deg2tileFrac(bb.n, bb.w, z);
  const seF = deg2tileFrac(bb.s, bb.e, z);
  const txMin = Math.floor(nwF.x), txMax = Math.floor(seF.x);
  const tyMin = Math.floor(nwF.y), tyMax = Math.floor(seF.y);

  // Fan tile requests out in parallel (cap at 6 — same as the browser's
  // typical per-host limit) so a 5×5 grid finishes in ~5× less wall time.
  const coords = [];
  for (let ty = tyMin; ty <= tyMax; ty++)
    for (let tx = txMin; tx <= txMax; tx++)
      coords.push({ tx, ty });

  const total = coords.length;
  const tileMap = {};
  let done = 0;

  await mapWithConcurrency(coords, 6, async ({ tx, ty }) => {
    tileMap[`${tx}_${ty}`] = await fetchDemTileCascade(z, tx, ty);
    done++;
    onProgress && onProgress(done / total * 0.85, `地形タイル z${z} ${done}/${total} 取得中…`);
  });

  // Decide once whether the mesh is denser than the DEM source. If so the
  // bilinear lattice would flatten curvature into facets — switch to a
  // Catmull-Rom bicubic kernel that preserves smoothness.
  const cosLat = Math.cos((bb.n + bb.s) / 2 * Math.PI / 180);
  const widthM = (bb.e - bb.w) * (Math.PI / 180) * 6378137 * cosLat;
  const cellM = widthM / (meshN - 1);
  const pxM = 156543.03 * cosLat / Math.pow(2, z);
  const useCubic = cellM < pxM * 0.9;
  const sample = useCubic ? sampleTileCubic : sampleTile;

  const grid = [];
  for (let r = 0; r < meshN; r++) {
    const lat = bb.n - r * (bb.n - bb.s) / (meshN - 1);
    const row = [];
    for (let c = 0; c < meshN; c++) {
      const lon = bb.w + c * (bb.e - bb.w) / (meshN - 1);
      const frac = deg2tileFrac(lat, lon, z);
      const tx = Math.floor(frac.x), ty = Math.floor(frac.y);
      row.push(sample(tileMap[`${tx}_${ty}`], (frac.x - tx) * 256, (frac.y - ty) * 256));
    }
    grid.push(row);
    onProgress && onProgress(0.85 + r / meshN * 0.15, '地形メッシュ生成中…');
  }
  return grid;
}


// ── Aerial photo sources — multi-source pyramid ────────────────────────
// Ordered by priority. fetchAerialPhoto walks this in 'auto' mode, picks
// the first source that (a) has its bbox intersect ours and (b) probes
// real (non-placeholder) imagery at a usable zoom.
//
// User-supplied custom sources (terrain.js sees them as an array passed
// in from app.js) get inserted ABOVE this list, so a downloaded municipal
// dataset or self-hosted drone server can win against the built-in fallbacks.
const AERIAL_SOURCES = [
  {
    id:    'esri',
    name:  'ESRI World Imagery',
    label: 'ESRI World Imagery (zoom 19, ~30cm/px)',
    // ESRI uses {z}/{y}/{x} order (y before x), unlike OSM/GSI.
    url: (z, tx, ty) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`,
    minZoom: 0, maxZoom: 19,
    bbox: null,                  // global
    probePlaceholder: true,      // ESRI serves a placeholder when imagery missing
  },
  {
    id:    'gsi_ort',
    name:  '国土地理院 ort',
    label: '国土地理院 オルソ (zoom 18, ~25cm/px, 主要都市部)',
    // GSI's "ort" service is denser than seamlessphoto in city centres —
    // 25 cm/px is common in central Tokyo / Osaka at z=18. Coverage is
    // patchy outside major cities, so it sits below ESRI but above
    // seamlessphoto in priority. Mixed jpg/png extension; ort uses png.
    url: (z, tx, ty) =>
      `https://cyberjapandata.gsi.go.jp/xyz/ort/${z}/${tx}/${ty}.png`,
    minZoom: 14, maxZoom: 18,
    bbox: { s: 24, n: 46, w: 122, e: 146 },
    probePlaceholder: false,
  },
  {
    id:    'gsi',
    name:  '国土地理院シームレス写真',
    label: '国土地理院シームレス写真 (zoom 18, ~60cm/px)',
    url: (z, tx, ty) =>
      `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${tx}/${ty}.jpg`,
    minZoom: 0, maxZoom: 18,
    bbox: { s: 24, n: 46, w: 122, e: 146 },  // Japan rough bbox
    probePlaceholder: false,
  },
];

// Kept as a lookup index for the old "force this exact source" pathway.
const PHOTO_SOURCES = Object.fromEntries(AERIAL_SOURCES.map(s => [s.id, s]));

// Build a source from a user-supplied spec.
//   { name, url, minZoom, maxZoom, bbox }
// `url` can be either a string template containing {z}/{x}/{y} or a function.
// Missing fields fall back to safe defaults so a "just a URL" entry works.
function makeCustomAerialSource(spec) {
  if (typeof spec === 'string') spec = { url: spec };
  const tpl = spec.url;
  const urlFn = typeof tpl === 'function'
    ? tpl
    : (z, x, y) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  return {
    id:    'custom:' + (spec.name || 'unnamed'),
    name:  spec.name || 'カスタムソース',
    label: spec.name || 'カスタムタイルサーバ',
    url:   urlFn,
    minZoom: spec.minZoom != null ? spec.minZoom : 0,
    maxZoom: spec.maxZoom != null ? spec.maxZoom : 23,
    bbox:    spec.bbox || null,
    probePlaceholder: spec.probePlaceholder !== false,
  };
}

function _bboxIntersects(a, b) {
  return a && !(a.e < b.w || a.w > b.e || a.n < b.s || a.s > b.n);
}

// ESRI returns a "Map data not yet available" placeholder PNG (HTTP 200) when
// imagery doesn't exist at the requested zoom. The placeholder is uniform gray
// with text; real imagery has high colour variance. We use the same chroma+
// variance check for any source whose `probePlaceholder` flag is set.
async function probeRealImagery(src, tx, ty, z) {
  try {
    const img = await loadTileImg(src.url(z, tx, ty));
    if (!img) return false;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    c.getContext('2d').drawImage(img, 0, 0, 32, 32);
    img.close && img.close();
    const px = c.getContext('2d').getImageData(0, 0, 32, 32).data;
    let chrom = 0, varSum = 0, mean = 0;
    for (let i = 0; i < 1024; i++) {
      const r = px[i*4], g = px[i*4+1], b = px[i*4+2];
      chrom += Math.abs(r - g) + Math.abs(g - b);
      mean += r + g + b;
    }
    mean /= 3072;
    for (let i = 0; i < 1024; i++) {
      const lum = (px[i*4] + px[i*4+1] + px[i*4+2]) / 3;
      varSum += (lum - mean) * (lum - mean);
    }
    const variance = varSum / 1024;
    return chrom > 500 || variance > 200;
  } catch { return false; }
}

// Walk a single source from `requestedZoom` down to its minimum, returning
// the highest zoom whose centre tile is real imagery. Used by both forced
// and auto modes.
async function _pickZoomForSource(src, bb, requestedZoom) {
  let z = Math.min(requestedZoom, src.maxZoom);
  if (z < src.minZoom) return null;
  const lat = (bb.n + bb.s) / 2, lon = (bb.w + bb.e) / 2;
  const ZOOM_FLOOR = Math.max(14, src.minZoom);  // give up below this
  while (z >= ZOOM_FLOOR) {
    const ctr = deg2tile(lat, lon, z);
    if (src.probePlaceholder) {
      if (await probeRealImagery(src, ctr.x, ctr.y, z)) return { src, zoom: z };
    } else {
      // Cheaper path: just check the tile loads at all (HTTP 200 + decodable).
      const img = await loadTileImg(src.url(z, ctr.x, ctr.y));
      if (img) { img.close && img.close(); return { src, zoom: z }; }
    }
    z--;
  }
  return null;
}

// Pick the source + zoom we'll actually render with.
//   mode = 'auto'   → walk user customs first, then AERIAL_SOURCES
//   mode = id       → force that exact built-in source, still probe-degrade
//   mode = 'custom' → walk user customs only (no built-in fallback)
// `customs` is an array of spec objects (see makeCustomAerialSource).
async function pickAerialSource(bb, requestedZoom, mode, customs) {
  const cs = Array.isArray(customs) ? customs : (customs ? [customs] : []);
  const customSources = cs.map(makeCustomAerialSource);

  if (mode === 'custom') {
    if (customSources.length === 0) throw new Error('カスタムソースが未設定');
    for (const src of customSources) {
      if (src.bbox && !_bboxIntersects(src.bbox, bb)) continue;
      const result = await _pickZoomForSource(src, bb, requestedZoom);
      if (result) return result;
    }
    return null;
  }
  if (mode && mode !== 'auto') {
    const src = PHOTO_SOURCES[mode];
    if (!src) throw new Error(`unknown aerial source: ${mode}`);
    return _pickZoomForSource(src, bb, requestedZoom);
  }
  // Auto: user customs first (highest priority — typically highest precision),
  // then built-in fallbacks.
  const list = [...customSources, ...AERIAL_SOURCES];
  for (const src of list) {
    if (src.bbox && !_bboxIntersects(src.bbox, bb)) continue;
    const result = await _pickZoomForSource(src, bb, requestedZoom);
    if (result) return result;
  }
  return null;
}

// Fetch an image tile through the cache and decode to an ImageBitmap.
// Returns null silently on any failure so the composite skips that tile.
async function loadTileImg(url) {
  try {
    const res = await cachedFetch(url);
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch { return null; }
}

// Composite an aerial photo for the bbox. `opts` accepts either a legacy
// string (the source id) or an object { mode, customs } where `customs`
// is an array of {name, url, minZoom, maxZoom, bbox} source specs.
async function fetchAerialPhoto(bb, requestedZoom, onProgress, opts) {
  const o = typeof opts === 'string' ? { mode: opts } : (opts || {});
  const mode = o.mode || 'auto';
  // Accept either `customs` (array) or legacy `customUrl` (string).
  const customs = o.customs || (o.customUrl ? [{ url: o.customUrl }] : []);

  const chosen = await pickAerialSource(bb, requestedZoom, mode, customs);
  if (!chosen) throw new Error('利用可能な航空写真ソースが見つかりません');

  const src = chosen.src;
  const effectiveZoom = chosen.zoom;
  onProgress && onProgress(0, `航空写真: ${src.name} z${effectiveZoom} 取得中…`);

  const nw = deg2tile(bb.n, bb.w, effectiveZoom);
  const se = deg2tile(bb.s, bb.e, effectiveZoom);
  const txMin = Math.min(nw.x, se.x), txMax = Math.max(nw.x, se.x);
  const tyMin = Math.min(nw.y, se.y), tyMax = Math.max(nw.y, se.y);
  const cols = txMax - txMin + 1, rows = tyMax - tyMin + 1, tot = cols * rows;

  const cvs = document.createElement('canvas');
  cvs.width = cols * 256; cvs.height = rows * 256;
  const ctx = cvs.getContext('2d');

  // Parallel download + decode, then composite onto the working canvas.
  const coords = [];
  for (let ty = tyMin; ty <= tyMax; ty++)
    for (let tx = txMin; tx <= txMax; tx++)
      coords.push({ tx, ty });
  let done = 0;
  await mapWithConcurrency(coords, 6, async ({ tx, ty }) => {
    const img = await loadTileImg(src.url(effectiveZoom, tx, ty));
    if (img) {
      try { ctx.drawImage(img, (tx - txMin) * 256, (ty - tyMin) * 256, 256, 256); } catch {}
      img.close && img.close();
    }
    done++;
    onProgress && onProgress(done / tot, `航空写真 ${src.name} z${effectiveZoom}: ${done}/${tot}`);
  });

  const bx = txMin * 256, by = tyMin * 256;
  const xMin = lonToWorldPx(bb.w, effectiveZoom) - bx, xMax = lonToWorldPx(bb.e, effectiveZoom) - bx;
  const yMin = latToWorldPy(bb.n, effectiveZoom) - by, yMax = latToWorldPy(bb.s, effectiveZoom) - by;
  const cx = Math.max(0, Math.round(xMin)), cy = Math.max(0, Math.round(yMin));
  const cw = Math.min(cvs.width - cx, Math.round(xMax - xMin));
  const ch = Math.min(cvs.height - cy, Math.round(yMax - yMin));

  const out = document.createElement('canvas');
  // Cap at 4096 on the long edge with a single uniform scale; clamping
  // width and height independently would squash the photo non-uniformly
  // and the texture would no longer line up with OSM building positions.
  const scale = Math.min(1, 4096 / Math.max(cw, ch));
  out.width  = Math.max(1, Math.round(cw * scale));
  out.height = Math.max(1, Math.round(ch * scale));
  out.getContext('2d').drawImage(cvs, cx, cy, cw, ch, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.95);
}
