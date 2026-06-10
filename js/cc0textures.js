'use strict';

// ── CC0 photo-texture library for facades ─────────────────────────────
// Sources every default texture from PolyHaven (https://polyhaven.com/),
// 100% Public Domain / CC0 — no attribution legally required, freely
// usable in any context including commercial. The CDN serves them as
// 1K JPGs at https://dl.polyhaven.org/file/ph-assets/...
//
// Each catalog entry says what kind of building the texture suits, and
// the WORLD SIZE the texture covers per repeat — the renderer uses this
// to set THREE.Texture.repeat so brick reads as ~2 m bricks, not
// stretched / shrunk to fit whatever wall it lands on.
//
// Per-entry loading is async + cached. Failures fall back to the
// procedural facade canvas in buildings.js, so the build never breaks
// because PolyHaven is down or an asset id changed.

const CC0_FACADE_CATALOG = {
  // Single-/low-rise residential — warm brick.
  residential: {
    url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/brick_wall_006/brick_wall_006_diff_1k.jpg',
    worldSize: 2,
    label: 'PolyHaven brick_wall_006 (CC0)',
  },
  house: {
    url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/brick_wall_006/brick_wall_006_diff_1k.jpg',
    worldSize: 2,
    label: 'PolyHaven brick_wall_006 (CC0)',
  },
  // Mid-rise apartments — painted/plastered brick.
  apartments: {
    url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/painted_concrete_wall/painted_concrete_wall_diff_1k.jpg',
    worldSize: 3,
    label: 'PolyHaven painted_concrete_wall (CC0)',
  },
  // Office / commercial — clean concrete panel.
  office: {
    url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_wall_004/concrete_wall_004_diff_1k.jpg',
    worldSize: 4,
    label: 'PolyHaven concrete_wall_004 (CC0)',
  },
  commercial: {
    url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_wall_004/concrete_wall_004_diff_1k.jpg',
    worldSize: 4,
    label: 'PolyHaven concrete_wall_004 (CC0)',
  },
  retail: {
    url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_wall_004/concrete_wall_004_diff_1k.jpg',
    worldSize: 4,
    label: 'PolyHaven concrete_wall_004 (CC0)',
  },
  // Warehouse / factory — corrugated metal siding.
  industrial: {
    url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/corrugated_iron_02/corrugated_iron_02_diff_1k.jpg',
    worldSize: 2.5,
    label: 'PolyHaven corrugated_iron_02 (CC0)',
  },
  warehouse: {
    url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/corrugated_iron_02/corrugated_iron_02_diff_1k.jpg',
    worldSize: 2.5,
    label: 'PolyHaven corrugated_iron_02 (CC0)',
  },
  // Religious / shrine / temple — weathered wood planks.
  religious: {
    url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/weathered_brown_planks/weathered_brown_planks_diff_1k.jpg',
    worldSize: 3,
    label: 'PolyHaven weathered_brown_planks (CC0)',
  },
  // Catch-all when getBuildingStyle returns an unknown type.
  generic: {
    url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_wall_004/concrete_wall_004_diff_1k.jpg',
    worldSize: 4,
    label: 'PolyHaven concrete_wall_004 (CC0)',
  },
};

const _cc0TexCache = new Map();   // key (entry.url) → Promise<THREE.Texture>

// Load (or return cached) THREE.Texture for an entry. THREE.TextureLoader
// has no native abort; race with a manual timeout so a stalled CDN
// doesn't hang the generate flow.
function _cc0LoadOne(entry, timeoutMs) {
  if (_cc0TexCache.has(entry.url)) return _cc0TexCache.get(entry.url);
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const p = new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('timeout fetching ' + entry.url));
    }, timeoutMs);
    loader.load(
      entry.url,
      tex => {
        if (done) return;
        done = true; clearTimeout(t);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.encoding = THREE.sRGBEncoding;
        tex.anisotropy = 8;
        tex.minFilter = THREE.LinearMipMapLinearFilter;
        // Tiled to the wall's UV span (set in _makeWallsGeo to
        // segLen/8 horizontal, height/4 vertical) so each repeat
        // covers worldSize metres of wall.
        tex.repeat.set(8 / entry.worldSize, 4 / entry.worldSize);
        tex.name = entry.label;
        resolve(tex);
      },
      undefined,
      err => {
        if (done) return;
        done = true; clearTimeout(t);
        reject(err);
      }
    );
  });
  _cc0TexCache.set(entry.url, p);
  return p;
}

// Preload the catalog (or the subset selected by `types`) in parallel.
// Returns a Map of "type" → THREE.Texture, omitting any that failed —
// callers fall back to the procedural facade for missing entries.
async function preloadCc0Facades(types, opts) {
  const wanted = types && types.length
    ? types.filter(t => CC0_FACADE_CATALOG[t])
    : Object.keys(CC0_FACADE_CATALOG);
  const timeoutMs = (opts && opts.timeoutMs) || 8000;
  const results = await Promise.all(wanted.map(async t => {
    try { return [t, await _cc0LoadOne(CC0_FACADE_CATALOG[t], timeoutMs)]; }
    catch (e) {
      console.warn(`[CC0] ${t} (${CC0_FACADE_CATALOG[t].url}) failed:`, e.message);
      return null;
    }
  }));
  const map = new Map();
  for (const r of results) if (r) map.set(r[0], r[1]);
  console.log(`[CC0] loaded ${map.size}/${wanted.length} facade texture(s) — failures fall back to procedural`);
  return map;
}

// Apply a JSON override on top of the default catalog. Mirrors the
// custom-aerial-JSON pattern: user pastes an object like
//   {"office":{"url":"...","worldSize":3.5,"label":"my pack"}}
// and only the listed keys are replaced; missing entries inherit the
// PolyHaven defaults so partial overrides are useful.
function applyCc0CatalogOverride(json) {
  const t = (json || '').trim();
  if (!t) return;
  try {
    const obj = JSON.parse(t);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v.url === 'string') {
        CC0_FACADE_CATALOG[k] = {
          url: v.url,
          worldSize: Number(v.worldSize) > 0 ? Number(v.worldSize) : 3,
          label: v.label || ('custom ' + k),
        };
        _cc0TexCache.delete(v.url);   // force reload if the URL changed
      }
    }
  } catch (e) {
    console.warn('[CC0] catalog override JSON parse failed:', e.message);
  }
}
