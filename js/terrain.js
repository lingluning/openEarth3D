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

// Samplers operate on a single stitched mosaic of all fetched tiles, not
// per-tile arrays: per-tile clamping could never reach the neighbouring
// tile's pixels, leaving a one-pixel flat shelf (bicubic: two-pixel) crease
// along every DEM tile seam.
function sampleMosaic(arr, W, H, fx, fy) {
  if (!arr) return 0;
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
  return (arr[y0 * W + x0] * (1 - tx) + arr[y0 * W + x1] * tx) * (1 - ty)
       + (arr[y1 * W + x0] * (1 - tx) + arr[y1 * W + x1] * tx) * ty;
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

function _readClamped(arr, W, H, x, y) {
  const cx = Math.max(0, Math.min(W - 1, x));
  const cy = Math.max(0, Math.min(H - 1, y));
  return arr[cy * W + cx];
}

// Bicubic sample of the mosaic. Only worth doing when the output mesh is
// denser than DEM pixels (otherwise we're oversampling and bilinear
// suffices).
function sampleMosaicCubic(arr, W, H, fx, fy) {
  if (!arr) return 0;
  const x = Math.floor(fx), y = Math.floor(fy);
  const tx = fx - x, ty = fy - y;
  const rows = new Array(4);
  for (let j = 0; j < 4; j++) {
    const yy = y - 1 + j;
    rows[j] = _cubic(
      _readClamped(arr, W, H, x - 1, yy),
      _readClamped(arr, W, H, x,     yy),
      _readClamped(arr, W, H, x + 1, yy),
      _readClamped(arr, W, H, x + 2, yy),
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
  // GSI publishes dem5a (5 m) ONLY at z15 and dem (10 m) ONLY up to z14.
  // fetchDemTile tries both at the SAME zoom, so at z15 the 10 m layer can
  // never respond — every part of Japan outside dem5a's narrower coverage
  // (outer islands, various inland areas) skipped straight past 10 m data
  // to 30 m global Terrarium. Reach the 10 m layer by fetching the parent
  // z14 tile and upsampling our quadrant of it.
  if (z === 15) {
    const parent = await fetchGsiDemAt(14, tx >> 1, ty >> 1, 'dem_png');
    if (parent) return _upsampleQuadrant(parent, tx & 1, ty & 1);
  }
  return await fetchTerrariumTile(z, tx, ty);
}

// One named GSI DEM layer at an explicit zoom (the cascade needs to mix
// zooms; fetchDemTile is locked to a single one).
async function fetchGsiDemAt(z, tx, ty, layer) {
  try {
    const res = await cachedFetch(`https://cyberjapandata.gsi.go.jp/xyz/${layer}/${z}/${tx}/${ty}.png`);
    if (!res.ok) return null;
    return await decodeDemBlob(await res.blob(), decodeGsi);
  } catch { return null; }
}

// Bilinearly blow up one 128x128 quadrant of a 256x256 parent tile back to
// 256x256, so a z14 tile can stand in for one of its four z15 children.
function _upsampleQuadrant(parent, qx, qy) {
  const out = new Float32Array(256 * 256);
  const ox = qx * 128, oy = qy * 128;
  for (let y = 0; y < 256; y++) {
    const sy = oy + y / 2;
    const y0 = Math.floor(sy), y1 = Math.min(255, y0 + 1), fy = sy - y0;
    for (let x = 0; x < 256; x++) {
      const sx = ox + x / 2;
      const x0 = Math.floor(sx), x1 = Math.min(255, x0 + 1), fx = sx - x0;
      const a = parent[y0 * 256 + x0], b = parent[y0 * 256 + x1];
      const c = parent[y1 * 256 + x0], d = parent[y1 * 256 + x1];
      out[y * 256 + x] = (a * (1 - fx) + b * fx) * (1 - fy)
                       + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
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
  // Ascend from the coarsest zoom and return the FIRST one whose pixels
  // are at least as fine as a mesh cell. (Descending from zMax returned
  // zMax for almost every input — and worse, fell through to zMin
  // (~300 m/px!) whenever the mesh was denser than zMax pixels, so
  // *raising* mesh detail produced dramatically flatter terrain.)
  let z = zMax;
  for (let zz = zMin; zz <= zMax; zz++) {
    const pxM = 156543.03 * cosLat / Math.pow(2, zz);
    if (pxM <= cellM) { z = zz; break; }
  }
  // GSI's DEM tiles only exist at z15 (dem5a) / z14 (dem): below z14 in
  // Japan both 404 and the cascade silently degrades to ~30 m Terrarium,
  // which is worse than GSI 10 m data. Clamp.
  const midLon = (bb.w + bb.e) / 2;
  const inJapan = midLat >= 24 && midLat <= 46 && midLon >= 122 && midLon <= 154;
  if (inJapan) z = Math.max(z, 14);
  return z;
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

  // Stitch all fetched tiles into one mosaic so interpolation kernels can
  // cross tile boundaries (per-tile clamping creased the terrain along
  // every seam). Missing tiles (sea / no coverage) stay 0.
  const mosaicW = (txMax - txMin + 1) * 256;
  const mosaicH = (tyMax - tyMin + 1) * 256;
  const mosaic = new Float32Array(mosaicW * mosaicH);
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const arr = tileMap[`${tx}_${ty}`];
      if (!arr) continue;
      const ox = (tx - txMin) * 256, oy = (ty - tyMin) * 256;
      for (let r = 0; r < 256; r++) {
        mosaic.set(arr.subarray(r * 256, r * 256 + 256), (oy + r) * mosaicW + ox);
      }
    }
  }

  // Decide once whether the mesh is denser than the DEM source. If so the
  // bilinear lattice would flatten curvature into facets — switch to a
  // Catmull-Rom bicubic kernel that preserves smoothness.
  const cosLat = Math.cos((bb.n + bb.s) / 2 * Math.PI / 180);
  const widthM = (bb.e - bb.w) * (Math.PI / 180) * 6378137 * cosLat;
  const cellM = widthM / (meshN - 1);
  const pxM = 156543.03 * cosLat / Math.pow(2, z);
  const useCubic = cellM < pxM * 0.9;
  const sample = useCubic ? sampleMosaicCubic : sampleMosaic;

  const grid = [];
  for (let r = 0; r < meshN; r++) {
    const lat = bb.n - r * (bb.n - bb.s) / (meshN - 1);
    const row = [];
    for (let c = 0; c < meshN; c++) {
      const lon = bb.w + c * (bb.e - bb.w) / (meshN - 1);
      const frac = deg2tileFrac(lat, lon, z);
      // −0.5: tile pixel values sit at pixel CENTRES; sampling at the
      // raw fractional position shifted all elevations ~half a DEM pixel
      // north-west relative to the aerial photo and OSM features.
      const fx = (frac.x - txMin) * 256 - 0.5;
      const fy = (frac.y - tyMin) * 256 - 0.5;
      row.push(sample(mosaic, mosaicW, mosaicH, fx, fy));
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
    id:    'usgs',
    name:  'USGS National Map',
    label: 'USGS Imagery (zoom 19, 北米 ~30cm/px)',
    // USGS ImageryOnly REST tile service. ArcGIS-style {z}/{y}/{x}
    // ordering. Public domain, no API key. Coverage = USA + Alaska +
    // Hawaii + Puerto Rico. Hosted on basemap.nationalmap.gov (different
    // origin than ESRI), so if Tracking Prevention or a corporate
    // firewall blocks server.arcgisonline.com this one usually still
    // works.
    url: (z, tx, ty) =>
      `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${ty}/${tx}`,
    minZoom: 0, maxZoom: 19,
    // Wide bbox covering CONUS + Alaska + Hawaii + Puerto Rico. Outside
    // this we skip the probe entirely so non-US users don't pay for it.
    bbox: { s: 17, n: 72, w: -180, e: -65 },
    probePlaceholder: false,
  },
  {
    id:    'esri',
    name:  'ESRI World Imagery',
    label: 'ESRI World Imagery (zoom 19, ~30cm/px)',
    // ESRI uses {z}/{y}/{x} order (y before x), unlike OSM/GSI.
    url: (z, tx, ty) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`,
    // ESRI returns HTTP 200 even past their real data limit — at z=20+
    // most cities get bicubic upsampled z=19 tiles that PASS our
    // placeholder probe (variance + chroma are preserved across the
    // upscale). The result is more tiles to download (16× per zoom
    // step) carrying no extra information — visibly softer than just
    // using z=19 directly. Keep the cap at the published real-data
    // limit; users in cities that genuinely have z=20-21 ortho (NYC,
    // London, central Tokyo for some captures) should configure those
    // via a custom-source JSON entry instead.
    minZoom: 0, maxZoom: 19,
    bbox: null,                  // global
    probePlaceholder: true,      // ESRI serves a placeholder when imagery missing
  },
  {
    // Bing Maps Aerial. Different host (ecn.t*.tiles.virtualearth.net)
    // than ESRI / EOX, so most domain blockers and Tracking Prevention
    // rules don't catch it. Quadkey-encoded tile URLs — convert
    // {z,x,y} into a single string and Bing serves the right ortho.
    // Coverage broadly matches ESRI globally (Microsoft licences from
    // similar suppliers); useful when ESRI returns "no data" for an
    // area or its domain is blocked.
    id:    'bing',
    name:  'Bing Maps Aerial',
    label: 'Bing Maps Aerial (zoom 19, global ~30cm/px in cities)',
    url: (z, tx, ty) => {
      let key = '';
      for (let i = z; i > 0; i--) {
        let digit = 0;
        const mask = 1 << (i - 1);
        if ((tx & mask) !== 0) digit += 1;
        if ((ty & mask) !== 0) digit += 2;
        key += digit;
      }
      const sub = (tx + ty) & 3;  // 0..3, balances across t0..t3
      return `https://ecn.t${sub}.tiles.virtualearth.net/tiles/a${key}.jpeg?g=1`;
    },
    minZoom: 1, maxZoom: 19,
    bbox: null,
    // Bing returns a watermarked "no data" PNG in unmapped areas — same
    // pattern as ESRI's placeholder, so we run the chroma/variance probe.
    probePlaceholder: true,
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
  {
    // Last-resort global aerial fallback. Sentinel-2 cloudless mosaic
    // by EOX — free, no API key, CC BY 4.0, ~10 m/px native resolution.
    // Useful when ESRI / Bing are both blocked and the user is outside
    // Japan so GSI is out too. Uses s2maps-tiles.eu (different origin
    // from tiles.maps.eox.at; same data, occasionally one host works
    // when the other doesn't due to corporate DNS or CDN routing).
    id:    's2maps',
    name:  'Sentinel-2 cloudless (EOX)',
    label: 'Sentinel-2 cloudless (~10m/px, 全球バックアップ)',
    url: (z, tx, ty) =>
      `https://s2maps-tiles.eu/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${ty}/${tx}.jpg`,
    minZoom: 0, maxZoom: 14,
    bbox: null,
    probePlaceholder: false,
  },
  {
    // Absolute-last resort. Not satellite — it's the standard OSM line
    // map. Reachable from essentially every network on earth (CDN by
    // OSMF + Cloudflare, hammered by every mapping tutorial in
    // existence). Drops the user into a flat-coloured cartographic
    // backdrop instead of a black void when every aerial source is
    // simultaneously down / blocked.
    id:    'osm',
    name:  'OpenStreetMap (地図)',
    label: 'OpenStreetMap 地図タイル (航空写真ではないが必ず動く)',
    url: (z, tx, ty) => `https://tile.openstreetmap.org/${z}/${tx}/${ty}.png`,
    minZoom: 0, maxZoom: 19,
    bbox: null,
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
  if (!spec || (typeof spec.url !== 'string' && typeof spec.url !== 'function')) {
    // Bad JSON entry — caller filters out null. Log so user can spot
    // the offending row in their textarea.
    console.warn('カスタムソース無効 (url が未指定):', spec);
    return null;
  }
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

// Probe a single tile and report whether it's real imagery vs a placeholder
// vs an outright load failure. Distinguishing the three is the difference
// between "we're outside this dataset's coverage" (placeholder) and "the
// browser can't reach this server at all" (network) — very different
// debugging paths for the user.
//   { ok: true,  reason: 'ok' }          → real imagery
//   { ok: false, reason: 'placeholder' } → tile loaded but probe rejected
//   { ok: false, reason: 'network' }     → fetch / decode failed
//   { ok: false, reason: 'exception' }   → drawImage / getImageData threw
async function probeRealImagery(src, tx, ty, z) {
  let img;
  try {
    img = await loadTileImg(src.url(z, tx, ty));
  } catch { return { ok: false, reason: 'network' }; }
  if (!img) return { ok: false, reason: 'network' };
  try {
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
    const real = chrom > 500 || variance > 200;
    return { ok: real, reason: real ? 'ok' : 'placeholder' };
  } catch { return { ok: false, reason: 'exception' }; }
}

// Walk a single source from `requestedZoom` down to its minimum, returning
// the highest zoom whose centre tile is real imagery. `diag` accumulates
// per-zoom probe results so the caller can format a useful error if every
// source ends up failing.
async function _pickZoomForSource(src, bb, requestedZoom, diag) {
  let z = Math.min(requestedZoom, src.maxZoom);
  if (z < src.minZoom) {
    diag && diag.push(`${src.name}: requestedZoom < minZoom`);
    return null;
  }
  const lat = (bb.n + bb.s) / 2, lon = (bb.w + bb.e) / 2;
  const ZOOM_FLOOR = Math.max(12, src.minZoom);  // give up below this
  while (z >= ZOOM_FLOOR) {
    const ctr = deg2tile(lat, lon, z);
    if (src.probePlaceholder) {
      const probe = await probeRealImagery(src, ctr.x, ctr.y, z);
      if (probe.ok) return { src, zoom: z };
      diag && diag.push(`${src.name} z${z}: ${probe.reason}`);
    } else {
      // Cheaper path: just check the tile loads at all (HTTP 200 + decodable).
      const img = await loadTileImg(src.url(z, ctr.x, ctr.y));
      if (img) { img.close && img.close(); return { src, zoom: z }; }
      diag && diag.push(`${src.name} z${z}: network`);
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
// Returns either { src, zoom } or { failed: true, diag: [..] } so the
// caller can show the user what was tried and at which zoom.
async function pickAerialSource(bb, requestedZoom, mode, customs) {
  const cs = Array.isArray(customs) ? customs : (customs ? [customs] : []);
  // filter(Boolean) drops invalid specs (no url field) — they were
  // already warned about in makeCustomAerialSource.
  const customSources = cs.map(makeCustomAerialSource).filter(Boolean);
  const diag = [];

  if (mode === 'custom') {
    if (customSources.length === 0) {
      throw new Error('カスタムソースが未設定 — JSON が空または無効です');
    }
    for (const src of customSources) {
      if (src.bbox && !_bboxIntersects(src.bbox, bb)) {
        diag.push(`${src.name}: bbox 範囲外`);
        continue;
      }
      const result = await _pickZoomForSource(src, bb, requestedZoom, diag);
      if (result) return result;
    }
    return { failed: true, diag };
  }
  if (mode && mode !== 'auto') {
    const src = PHOTO_SOURCES[mode];
    if (!src) throw new Error(`unknown aerial source: ${mode}`);
    const result = await _pickZoomForSource(src, bb, requestedZoom, diag);
    return result || { failed: true, diag };
  }
  // Auto: user customs first (highest priority — typically highest precision),
  // then built-in fallbacks.
  const list = [...customSources, ...AERIAL_SOURCES];
  for (const src of list) {
    if (src.bbox && !_bboxIntersects(src.bbox, bb)) {
      diag.push(`${src.name}: bbox 範囲外`);
      continue;
    }
    const result = await _pickZoomForSource(src, bb, requestedZoom, diag);
    if (result) return result;
  }
  return { failed: true, diag };
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
  if (!chosen || chosen.failed) {
    // chosen.diag lists what was tried so the user / dev can see why
    // every source bowed out. Most common cause: every source's centre
    // tile failed the placeholder probe — usually network/Tracking-
    // Prevention blocking ESRI, OR a rural area where ESRI returns
    // their solid-colour low-res tiles that don't pass the chroma test.
    const diag = (chosen && chosen.diag) || [];
    console.warn('航空写真 picker 全失敗:', diag);
    throw new Error(
      '利用可能な航空写真ソースが見つかりません — 詳細は console を確認 ' +
      `(試行 ${diag.length} 件)`
    );
  }

  const src = chosen.src;
  const effectiveZoom = chosen.zoom;
  onProgress && onProgress(0, `航空写真: ${src.name} z${effectiveZoom} 取得中…`);

  const nw = deg2tile(bb.n, bb.w, effectiveZoom);
  const se = deg2tile(bb.s, bb.e, effectiveZoom);
  const txMin = Math.min(nw.x, se.x), txMax = Math.max(nw.x, se.x);
  const tyMin = Math.min(nw.y, se.y), tyMax = Math.max(nw.y, se.y);
  const cols = txMax - txMin + 1, rows = tyMax - tyMin + 1, tot = cols * rows;

  // Crop rectangle in full-resolution tile-pixel space.
  const bx = txMin * 256, by = tyMin * 256;
  const xMin = lonToWorldPx(bb.w, effectiveZoom) - bx, xMax = lonToWorldPx(bb.e, effectiveZoom) - bx;
  const yMin = latToWorldPy(bb.n, effectiveZoom) - by, yMax = latToWorldPy(bb.s, effectiveZoom) - by;
  const cw = Math.max(1, xMax - xMin), ch = Math.max(1, yMax - yMin);

  // Texture-edge cap. 4096 used to be the safe number; modern desktops
  // and most phones now handle 8192 fine and 16384 on dedicated GPUs.
  // Caller can override via opts.maxTextureEdge.
  const MAX_EDGE = (o && o.maxTextureEdge) || 8192;
  // Cap on the long edge with a single uniform scale; clamping width
  // and height independently would squash the photo non-uniformly and
  // the texture would stop lining up with OSM building positions.
  const scale = Math.min(1, MAX_EDGE / Math.max(cw, ch));

  // Composite DIRECTLY at output scale. The previous version built a
  // full-resolution mosaic of every tile first and then downscaled it in
  // one go: for a 3 km request at a high zoom that intermediate is tens of
  // thousands of pixels on a side — hundreds of megabytes, and past the
  // browser's maximum canvas area it silently yields a BLANK canvas, i.e.
  // a black map. Drawing each tile straight into its place in the final
  // canvas removes the intermediate entirely, so peak memory is just the
  // output texture and the size cap can never be exceeded.
  const out = document.createElement('canvas');
  out.width  = Math.max(1, Math.round(cw * scale));
  out.height = Math.max(1, Math.round(ch * scale));
  const outCtx = out.getContext('2d');
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';
  // Pre-fill: failed tiles (coverage edges — the picker only probes the
  // CENTRE tile) leave transparent canvas, which an opaque material
  // renders as solid black. Neutral grey-green reads as "no data".
  outCtx.fillStyle = '#9aa39a';
  outCtx.fillRect(0, 0, out.width, out.height);

  const coords = [];
  for (let ty = tyMin; ty <= tyMax; ty++)
    for (let tx = txMin; tx <= txMax; tx++)
      coords.push({ tx, ty });
  let done = 0;
  const tileDst = 256 * scale;
  await mapWithConcurrency(coords, 6, async ({ tx, ty }) => {
    const img = await loadTileImg(src.url(effectiveZoom, tx, ty));
    if (img) {
      // Float destination coordinates — rounding each tile independently
      // would open hairline seams between neighbours.
      const dx = ((tx - txMin) * 256 - xMin) * scale;
      const dy = ((ty - tyMin) * 256 - yMin) * scale;
      try { outCtx.drawImage(img, dx, dy, tileDst, tileDst); } catch {}
      img.close && img.close();
    }
    done++;
    onProgress && onProgress(done / tot, `航空写真 ${src.name} z${effectiveZoom}: ${done}/${tot}`);
  });

  // Skip the JPEG roundtrip — round-tripping through toDataURL('image/jpeg', 0.95)
  // re-encodes to lossy JPEG then re-decodes via TextureLoader, introducing
  // block artifacts and a measurable softness. Returning a CanvasTexture
  // hands the GPU the raw canvas pixels directly.
  const tex = new THREE.CanvasTexture(out);
  tex.encoding = THREE.sRGBEncoding;
  tex.anisotropy = 8;            // sharper at grazing angles, free on modern GPUs
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  // Sanitise: this name becomes a zip entry + MTL map_Kd path on export.
  // Spaces split MTL tokens and non-ASCII breaks CP437 zip readers.
  tex.name = `aerial_${src.id || src.name}_z${effectiveZoom}`.replace(/[^\w.-]+/g, '_');
  tex.userData = { sourceName: src.name, zoom: effectiveZoom, width: out.width, height: out.height };
  return tex;
}
