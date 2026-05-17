'use strict';

function bboxFromCenter(lat, lon, km) {
  const dlat = (km / 2) / 110.54;
  const dlon = (km / 2) / (111.32 * Math.cos(lat * Math.PI / 180));
  return { n: lat + dlat, s: lat - dlat, w: lon - dlon, e: lon + dlon };
}

function bboxXSize(bb) {
  const lat0 = (bb.n + bb.s) / 2;
  return (bb.e - bb.w) * 111320 * Math.cos(lat0 * Math.PI / 180);
}

function bboxZSize(bb) {
  return (bb.n - bb.s) * 110540;
}

function toLocalX(lon, bb) {
  const lat0 = (bb.n + bb.s) / 2;
  return (lon - bb.w) * 111320 * Math.cos(lat0 * Math.PI / 180);
}

function toLocalZ(lat, bb) {
  return (bb.n - lat) * 110540;
}

function deg2tile(lat, lon, z) {
  const n = Math.pow(2, z), lr = lat * Math.PI / 180;
  return {
    x: Math.floor((lon + 180) / 360 * n),
    y: Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n)
  };
}

function lonToWorldPx(lon, z) { return (lon + 180) / 360 * 256 * Math.pow(2, z); }
function latToWorldPy(lat, z) {
  const lr = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + lr / 2)) / Math.PI) / 2 * 256 * Math.pow(2, z);
}

// bilinear interpolation on elevation grid
function getElevAt(grid, n, rx, rz) {
  const fx = Math.max(0, Math.min(n - 1, rx * (n - 1)));
  const fz = Math.max(0, Math.min(n - 1, rz * (n - 1)));
  const c0 = Math.floor(fx), c1 = Math.min(n - 1, c0 + 1);
  const r0 = Math.floor(fz), r1 = Math.min(n - 1, r0 + 1);
  const tc = fx - c0, tr = fz - r0;
  return (grid[r0][c0] * (1 - tc) + grid[r0][c1] * tc) * (1 - tr)
       + (grid[r1][c0] * (1 - tc) + grid[r1][c1] * tc) * tr;
}
