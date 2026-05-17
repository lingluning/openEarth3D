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
