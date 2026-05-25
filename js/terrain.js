'use strict';

async function fetchElev(lat, lon) {
  const url = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php`
            + `?lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}&outtype=JSON`;
  try {
    const d = await (await fetch(url)).json();
    const v = d.elevation;
    return (v != null && v !== 'e') ? parseFloat(v) : 0;
  } catch { return 0; }
}

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
// We use fetch() instead of <img> so 404s stay out of the console.
const DEM_SOURCES = ['dem5a_png', 'dem_png'];

async function decodeDemBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, 256, 256);
  bitmap.close && bitmap.close();
  const px = ctx.getImageData(0, 0, 256, 256).data;
  const arr = new Float32Array(256 * 256);
  for (let i = 0; i < 256 * 256; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    const v = r * 65536 + g * 256 + b;
    // 8388608 (0x800000) = no-data sentinel
    arr[i] = v === 8388608 ? 0 : v < 8388608 ? v * 0.01 : (v - 16777216) * 0.01;
  }
  return arr;
}

// Decode a GSI DEM PNG tile → Float32Array(256*256) of elevations in metres.
// Falls back from dem5a (5m) to dem (10m) on 404. Returns null if both miss,
// letting the caller fall through to the global per-point elevation API.
async function fetchDemTile(z, tx, ty) {
  for (const name of DEM_SOURCES) {
    const url = `https://cyberjapandata.gsi.go.jp/xyz/${name}/${z}/${tx}/${ty}.png`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      return await decodeDemBlob(await res.blob());
    } catch {
      // network error → try next source
    }
  }
  return null;
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

// High-resolution terrain from GSI DEM PNG tiles (~10m at z=14, Japan coverage)
// Returns null if outside Japan (all tiles 404)
async function fetchElevGridHiRes(bb, meshN, onProgress) {
  const z = 14;
  const nwF = deg2tileFrac(bb.n, bb.w, z);
  const seF = deg2tileFrac(bb.s, bb.e, z);
  const txMin = Math.floor(nwF.x), txMax = Math.floor(seF.x);
  const tyMin = Math.floor(nwF.y), tyMax = Math.floor(seF.y);

  const total = (txMax - txMin + 1) * (tyMax - tyMin + 1);
  const tileMap = {};
  let done = 0;

  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      tileMap[`${tx}_${ty}`] = await fetchDemTile(z, tx, ty);
      onProgress && onProgress(++done / total * 0.85);
    }
  }

  if (!Object.values(tileMap).some(Boolean)) return null; // outside Japan

  const grid = [];
  for (let r = 0; r < meshN; r++) {
    const lat = bb.n - r * (bb.n - bb.s) / (meshN - 1);
    const row = [];
    for (let c = 0; c < meshN; c++) {
      const lon = bb.w + c * (bb.e - bb.w) / (meshN - 1);
      const frac = deg2tileFrac(lat, lon, z);
      const tx = Math.floor(frac.x), ty = Math.floor(frac.y);
      row.push(sampleTile(tileMap[`${tx}_${ty}`], (frac.x - tx) * 256, (frac.y - ty) * 256));
    }
    grid.push(row);
    onProgress && onProgress(0.85 + r / meshN * 0.15);
  }
  return grid;
}

// Fallback: individual-point API (works globally, slower, lower resolution)
async function fetchElevGrid(bb, n, onProgress) {
  const lats = Array.from({ length: n }, (_, i) => bb.n - i * (bb.n - bb.s) / (n - 1));
  const lons = Array.from({ length: n }, (_, i) => bb.w + i * (bb.e - bb.w) / (n - 1));
  const grid = [];
  let done = 0;
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c += 8) {
      const batch = [];
      for (let k = 0; k < 8 && c + k < n; k++) batch.push(fetchElev(lats[r], lons[c + k]));
      const vals = await Promise.all(batch);
      row.push(...vals);
      done += vals.length;
      onProgress && onProgress(done / (n * n));
    }
    grid.push(row);
  }
  // smooth zero islands
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r][c] === 0) {
        const nb = [];
        if (r > 0 && grid[r-1][c]) nb.push(grid[r-1][c]);
        if (r < n-1 && grid[r+1][c]) nb.push(grid[r+1][c]);
        if (c > 0 && grid[r][c-1]) nb.push(grid[r][c-1]);
        if (c < n-1 && grid[r][c+1]) nb.push(grid[r][c+1]);
        if (nb.length) grid[r][c] = nb.reduce((a, b) => a + b, 0) / nb.length;
      }
    }
  }
  return grid;
}

async function fetchAerialPhoto(bb, zoom, onProgress) {
  const nw = deg2tile(bb.n, bb.w, zoom);
  const se = deg2tile(bb.s, bb.e, zoom);
  const txMin = Math.min(nw.x, se.x), txMax = Math.max(nw.x, se.x);
  const tyMin = Math.min(nw.y, se.y), tyMax = Math.max(nw.y, se.y);
  const cols = txMax - txMin + 1, rows = tyMax - tyMin + 1, tot = cols * rows;

  const cvs = document.createElement('canvas');
  cvs.width = cols * 256; cvs.height = rows * 256;
  const ctx = cvs.getContext('2d');
  let done = 0;

  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const img = await new Promise(res => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => res(im);
        im.onerror = () => res(null);
        im.src = `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${zoom}/${tx}/${ty}.jpg`;
      });
      if (img) try { ctx.drawImage(img, (tx - txMin) * 256, (ty - tyMin) * 256, 256, 256); } catch {}
      done++;
      onProgress && onProgress(done / tot);
    }
  }

  const bx = txMin * 256, by = tyMin * 256;
  const xMin = lonToWorldPx(bb.w, zoom) - bx, xMax = lonToWorldPx(bb.e, zoom) - bx;
  const yMin = latToWorldPy(bb.n, zoom) - by, yMax = latToWorldPy(bb.s, zoom) - by;
  const cx = Math.max(0, Math.round(xMin)), cy = Math.max(0, Math.round(yMin));
  const cw = Math.min(cvs.width - cx, Math.round(xMax - xMin));
  const ch = Math.min(cvs.height - cy, Math.round(yMax - yMin));

  const out = document.createElement('canvas');
  out.width = Math.min(cw, 4096); out.height = Math.min(ch, 4096);
  out.getContext('2d').drawImage(cvs, cx, cy, cw, ch, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.95);
}
