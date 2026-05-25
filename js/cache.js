'use strict';

// Persistent tile cache built on the browser's Cache API. Stores fetched
// responses on disk so a second visit (or re-running the same area) skips
// the network entirely. Falls back to a passthrough fetch when the Cache
// API is unavailable (e.g. file:// origins, very old browsers).

const TILE_CACHE_NAME = 'openearth3d-tiles-v1';

let _cachePromise = null;
function _openCache() {
  if (!_cachePromise) {
    _cachePromise = (typeof caches !== 'undefined' && caches.open)
      ? caches.open(TILE_CACHE_NAME).catch(() => null)
      : Promise.resolve(null);
  }
  return _cachePromise;
}

async function cachedFetch(url, init) {
  const cache = await _openCache();
  if (!cache) return fetch(url, init);

  // Cache.match needs a Request; URL-only matches work too in modern browsers
  // but using a Request keeps headers/method consistent across calls.
  const req = new Request(url, init);
  try {
    const hit = await cache.match(req);
    if (hit) return hit;
  } catch {}

  const res = await fetch(req);
  // Only cache successful, non-opaque responses. Opaque (no-cors) responses
  // would still be stored but waste space without being readable.
  if (res && res.ok && res.type !== 'opaque') {
    try { await cache.put(req, res.clone()); } catch {}
  }
  return res;
}

// Erase the whole tile cache — exposed for a future "clear cache" UI control.
async function clearTileCache() {
  if (typeof caches === 'undefined') return false;
  try {
    return await caches.delete(TILE_CACHE_NAME);
  } catch { return false; }
}
