'use strict';

// ── Overpass fetch ─────────────────────────────────────────────────────────
// We pull buildings AND ground features (roads / water / trees) in one
// request so the user only waits for a single Overpass round-trip.
async function fetchBuildings(bb) {
  const q = `[out:json][timeout:25];
(
  way["building"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["building"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["building:part"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["building:part"](${bb.s},${bb.w},${bb.n},${bb.e});
);
out body;>;out skel qt;`;
  return _overpassJson(q);
}

// Shared Overpass helper. The public Overpass API rate-limits aggressively
// — under load any single endpoint returns 429 "rate_limited" in plain
// text (so res.json() throws an unhelpful SyntaxError). We rotate through
// several public mirrors with a tiny back-off so a one-shot 429 from
// overpass-api.de doesn't kill the whole generate flow.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];
let _overpassMirrorIdx = 0;

async function _overpassJson(query) {
  const body = 'data=' + encodeURIComponent(query);
  let lastErr = null;
  // Try every mirror once, starting from wherever the previous successful
  // call left off (mild round-robin so we spread load across servers).
  // Claim a starting mirror IMMEDIATELY. app.js fires the buildings query
  // and the ground-features query in parallel; because _overpassMirrorIdx
  // was only advanced on SUCCESS, both requests read the same index and
  // hammered the same server simultaneously — reliably self-inflicting the
  // 429s the mirror rotation exists to avoid. Reserving the slot up front
  // means concurrent callers start on different mirrors.
  const startIdx = _overpassMirrorIdx;
  _overpassMirrorIdx = (_overpassMirrorIdx + 1) % OVERPASS_MIRRORS.length;
  for (let attempt = 0; attempt < OVERPASS_MIRRORS.length; attempt++) {
    const url = OVERPASS_MIRRORS[(startIdx + attempt) % OVERPASS_MIRRORS.length];
    try {
      const res = await fetch(url, { method: 'POST', body });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !ct.includes('json')) {
        const snippet = (await res.text()).slice(0, 120).replace(/\s+/g, ' ').trim();
        lastErr = new Error(`Overpass ${res.status}: ${snippet || res.statusText}`);
        // 429 / 504 → try the next mirror after a tiny pause. Other 4xx
        // are usually our fault (bad query) so retrying won't help —
        // mark fatal so our own catch below rethrows instead of cycling
        // through every mirror with the same doomed query.
        if (res.status !== 429 && res.status !== 504 && res.status !== 503) {
          lastErr.fatal = true;
          throw lastErr;
        }
        console.warn(`Overpass ${url} → ${res.status}, trying next mirror`);
        await new Promise(r => setTimeout(r, 400 + attempt * 600));   // 0.4, 1.0, 1.6 s
        continue;
      }
      const json = await res.json();
      // Next caller should start after the mirror that just worked.
      _overpassMirrorIdx = (startIdx + attempt + 1) % OVERPASS_MIRRORS.length;
      return json.elements || [];
    } catch (e) {
      if (e && e.fatal) throw e;
      // Network failure → try next mirror.
      lastErr = e;
      console.warn(`Overpass ${url} → ${e.message}, trying next mirror`);
    }
  }
  throw lastErr || new Error('Overpass: all mirrors failed');
}

// Most OSM buildings (especially in Japan) have no `roof:shape` tag — so
// if we trusted the tag literally every roof would default to flat and the
// city would look like a parking lot of grey boxes. Infer a plausible
// shape from the building type, footprint area, and height instead.
//
// Heuristic: small / mid-sized civilian buildings get pitched roofs;
// industrial, commercial and anything tall stays flat.
function _inferRoofShape(tags, areaM2, height) {
  if (tags['roof:shape']) return tags['roof:shape'].toLowerCase();

  const t = (tags.building || '').toLowerCase();

  // Religious / heritage architecture almost always has a sloped roof.
  if (['church','cathedral','chapel','basilica'].includes(t)) return 'pyramidal';
  if (['temple','shrine','pagoda'].includes(t))               return 'pyramidal';
  if (t === 'mosque')                                         return 'dome';
  if (t === 'castle' || t === 'tower')                        return 'pyramidal';

  // Industrial / large commercial / hi-rise stay flat regardless of size.
  if (['industrial','warehouse','factory','manufacture','depot',
       'parking','silo','storage_tank','garage','garages'].includes(t)) return 'flat';
  if (height >= 25 || areaM2 >= 1500) return 'flat';

  // Mid-sized commercial / office: small ones get a hipped cap, big ones flat.
  if (['retail','supermarket','commercial','office','hotel',
       'hospital','clinic','train_station'].includes(t)) {
    return areaM2 < 600 && height < 15 ? 'hipped' : 'flat';
  }

  // Everything else (incl. `building=yes`, `apartments`, `house`, …)
  // — pick the shape from size. Small → gabled, mid → hipped.
  if (areaM2 < 400 && height < 14) return 'gabled';
  if (areaM2 < 900 && height < 20) return 'hipped';
  return 'flat';
}

function _inferRoofHeight(shape, totalH, areaM2) {
  if (shape === 'flat') return 0;
  if (shape === 'dome' || shape === 'onion') {
    return Math.min(Math.max(3, Math.sqrt(areaM2) * 0.25), totalH * 0.6);
  }
  // Gabled / hipped / pyramidal: ~33 % of total height, clamped 2.5..7 m.
  return Math.min(7, Math.max(2.5, totalH * 0.33));
}

// Polygon area in m² using the shoelace formula in local-XZ space.
function _footprintAreaM2(coords, bb) {
  let a2 = 0;
  for (let i = 0; i < coords.length; i++) {
    const A = coords[i], B = coords[(i + 1) % coords.length];
    a2 += toLocalX(A.lon, bb) * toLocalZ(B.lat, bb)
        - toLocalX(B.lon, bb) * toLocalZ(A.lat, bb);
  }
  return Math.abs(a2) / 2;
}

// Parse a numeric tag with a fallback. Rejects NaN, ±Infinity and negatives —
// OSM tags can contain "yes", "approx 12", or stray units, all of which would
// otherwise yield an unsigned-NaN building height.
function _posFloat(raw, fallback) {
  if (raw == null) return fallback;
  const v = parseFloat(raw);
  return (isFinite(v) && v > 0) ? v : fallback;
}

// Parse a length that may carry units. OSM heights show up as "12",
// "12 m", "12m", "40'" (feet), "40 ft", "12.5 metres". Returns metres
// or null if unparseable. Capturing the unit variants alone recovers a
// surprising number of buildings whose height we were silently dropping.
function _parseLengthM(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  let m = s.match(/^([\d.]+)\s*(?:'|ft|feet)$/);          // feet
  if (m) return parseFloat(m[1]) * 0.3048;
  m = s.match(/^([\d.]+)\s*(?:m|metre|meter|metres|meters)?$/);  // metres
  if (m) { const v = parseFloat(m[1]); return isFinite(v) && v > 0 ? v : null; }
  return null;
}

// Floor-to-floor height by building type. Offices / retail have taller
// storeys than apartments; industrial sheds and religious halls taller
// still. Used both to convert `building:levels` → metres and to estimate
// untagged buildings.
function _floorHeightFor(tags) {
  const t = (tags.building || '').toLowerCase();
  if (['commercial','retail','office','hotel','mall','department_store',
       'supermarket','civic','public','hospital','school'].includes(t)) return 3.9;
  if (['industrial','warehouse','factory','hangar','depot'].includes(t)) return 6.0;
  if (['church','cathedral','temple','shrine','mosque','pagoda'].includes(t)) return 6.5;
  if (['house','detached','bungalow','cabin','cottage'].includes(t)) return 3.0;
  if (['apartments','residential','dormitory'].includes(t)) return 3.0;
  return 3.3;
}

// Best-effort building height in metres, in priority order:
//   1. explicit height / building:height / est_height (with unit parsing)
//   2. (building:levels + roof:levels) × type-aware floor height
//   3. type + footprint-area inference for fully untagged buildings
// This squeezes every height hint OSM actually carries (we used to only
// read `height` and `building:levels` as bare floats, dropping anything
// with a unit suffix or alternate tag) before falling back to inference.
function _resolveHeight(tags, areaM2) {
  const explicit =
    _parseLengthM(tags.height) ??
    _parseLengthM(tags['building:height']) ??
    _parseLengthM(tags['est_height']);
  if (explicit != null) return explicit;

  const fh = _floorHeightFor(tags);
  const levelsRaw = tags['building:levels'] ?? tags['levels'];
  if (levelsRaw != null) {
    const levels = _posFloat(levelsRaw, 0);
    const roofLv = _posFloat(tags['roof:levels'], 0);
    if (levels > 0) return Math.max(2.5, (levels + roofLv) * fh);
  }

  // Fully untagged — infer from type + footprint area.
  const t = (tags.building || '').toLowerCase();
  if (['warehouse','industrial','factory','retail','supermarket',
       'hangar','depot','parking'].includes(t)) {
    return fh * (areaM2 > 2000 ? 1 : 2);          // big-box: 1-2 storeys
  }
  if (['house','detached','bungalow','cabin','cottage','hut','shed'].includes(t)) {
    return fh * 2;                                 // houses: ~2 storeys
  }
  // Generic / apartments / yes: small dense footprints tend taller,
  // sprawling footprints tend lower.
  if (areaM2 < 120)  return fh * 3;
  if (areaM2 < 400)  return fh * 4;
  if (areaM2 < 2000) return fh * 3;
  return fh * 2;
}

function parseBuildings(elements, bb) {
  const nodeMap = {};
  elements.filter(e => e.type === 'node').forEach(n => { nodeMap[n.id] = n; });
  const wayMap = {};
  elements.filter(e => e.type === 'way').forEach(w => { wayMap[w.id] = w; });

  // OSM closed ways repeat their first node as the last one. Carrying that
  // duplicate through means the first vertex is counted TWICE in every
  // centroid average — which is what positions pitched-roof apexes, roof
  // equipment and the elevation sample — and it feeds a zero-length edge
  // into the convexity test. Strip it once, here.
  const coordsOf = way => {
    const c = way.nodes
      .map(id => nodeMap[id]).filter(Boolean)
      .map(n => ({ lat: n.lat, lon: n.lon }));
    while (c.length > 2 &&
           Math.abs(c[0].lat - c[c.length - 1].lat) < 1e-9 &&
           Math.abs(c[0].lon - c[c.length - 1].lon) < 1e-9) {
      c.pop();
    }
    return c;
  };

  // Resolve the geometry way for an element: the way itself, or the outer
  // ring of a type=multipolygon relation (donut buildings / stations).
  function geomWay(e) {
    if (e.type === 'way') return e;
    if (e.type === 'relation' && e.tags.type === 'multipolygon' && e.members) {
      const outer = e.members.find(m => m.type === 'way' && m.role === 'outer' && wayMap[m.ref]);
      if (outer) return wayMap[outer.ref];
    }
    return null;
  }

  // Build the {coords, height, minH, roofH, roofShape, area, tags} record
  // shared by both building outlines and building:part volumes.
  function recordFrom(tags, coords) {
    if (coords.length < 3) return null;
    const area    = _footprintAreaM2(coords, bb);
    const height  = _resolveHeight(tags, area);
    let   minH    = _parseLengthM(tags.min_height) || 0;
    if (minH >= height) minH = 0;
    const roofShape = _inferRoofShape(tags, area, height);
    const roofHTag  = _parseLengthM(tags['roof:height']);
    let   roofH     = roofHTag != null ? roofHTag : _inferRoofHeight(roofShape, height, area);
    roofH = Math.min(roofH, Math.max(0, height - minH - 2));
    return { coords, height, minH, roofH, roofShape, area, tags };
  }

  const outlines = [];   // building=*
  const parts    = [];   // building:part=*  (the real 3D volumes)

  for (const e of elements) {
    if (!e.tags) continue;
    const hasPart     = e.tags['building:part'] && e.tags['building:part'] !== 'no';
    const hasBuilding = e.tags.building && e.tags.building !== 'no';

    if (hasPart) {
      const way = geomWay(e);
      if (!way) continue;
      // building:part volumes often lack a `building` type — fall back to
      // the part value (e.g. "residential") as the type hint so height /
      // roof / style inference still has something to work with.
      const tags = e.tags.building ? e.tags
        : Object.assign({}, e.tags, {
            building: e.tags['building:part'] !== 'yes' ? e.tags['building:part'] : 'yes',
          });
      const rec = recordFrom(tags, coordsOf(way));
      if (rec) parts.push(rec);
    } else if (hasBuilding) {
      const way = geomWay(e);
      if (!way) continue;
      const rec = recordFrom(e.tags, coordsOf(way));
      if (rec) outlines.push(rec);
    }
  }

  // Simple 3D Buildings rule: an outline covered by ≥1 part is REPLACED by
  // its parts — we must not extrude the outline box on top of the detailed
  // volumes. Associate parts → outlines by centroid containment, with an
  // AABB pre-reject so this stays fast on dense city blocks.
  for (const o of outlines) {
    o._local = o.coords.map(c => ({ x: toLocalX(c.lon, bb), z: toLocalZ(c.lat, bb) }));
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of o._local) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    o._aabb = { minX, maxX, minZ, maxZ };
  }
  for (const p of parts) {
    const lc = p.coords.map(c => ({ x: toLocalX(c.lon, bb), z: toLocalZ(c.lat, bb) }));
    const cx = lc.reduce((s, q) => s + q.x, 0) / lc.length;
    const cz = lc.reduce((s, q) => s + q.z, 0) / lc.length;
    for (const o of outlines) {
      if (o._hasParts) continue;
      const a = o._aabb;
      if (cx < a.minX || cx > a.maxX || cz < a.minZ || cz > a.maxZ) continue;
      if (_ptInPoly2d(cx, cz, o._local)) { o._hasParts = true; break; }
    }
  }

  // Final render list: every part + every outline that has no parts.
  const result = parts;
  for (const o of outlines) {
    if (o._hasParts) continue;
    delete o._local; delete o._aabb;
    result.push(o);
  }
  return result;
}

// ── Per-building variety ────────────────────────────────────────────────
// Real cities don't have one wall colour per building type — they have a
// distribution. To kill the "clone army" feel we bucket each building into
// one of N variants by hashing its first coord; the bucket drives both an
// HSL offset on the style colours and a seed for the facade's random
// window pattern. Texture cache key includes the bucket so we still share
// across buildings that fall in the same bucket.
const STYLE_VARIANTS = 8;
const HSL_OFFSETS = [
  { dh:  0.000, ds:  0.00, dl:  0.00 },  // base
  { dh:  0.020, ds:  0.04, dl:  0.06 },
  { dh: -0.020, ds: -0.04, dl: -0.04 },
  { dh:  0.040, ds: -0.04, dl:  0.04 },
  { dh: -0.040, ds:  0.06, dl: -0.06 },
  { dh:  0.012, ds: -0.08, dl:  0.10 },
  { dh: -0.030, ds:  0.04, dl: -0.08 },
  { dh:  0.030, ds: -0.02, dl:  0.02 },
];

function _buildingBucket(coords) {
  const c = coords && coords[0];
  if (!c) return 0;
  // Hash that's stable for the same lat/lon across runs. 1e5 keeps us at
  // sub-metre precision while staying inside Int32.
  const s = (Math.round(c.lat * 1e5) | 0) ^
            Math.imul((Math.round(c.lon * 1e5) | 0), 0x1f3b);
  return (s >>> 0) % STYLE_VARIANTS;
}

function _jitterHexHSL(hex, dh, ds, dl) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  hsl.h = ((hsl.h + dh) % 1 + 1) % 1;
  hsl.s = Math.max(0, Math.min(1, hsl.s + ds));
  hsl.l = Math.max(0.05, Math.min(0.95, hsl.l + dl));
  c.setHSL(hsl.h, hsl.s, hsl.l);
  return c.getHex();
}

// Mulberry32 — small, fast, deterministic. We need a seeded RNG because
// the facade canvas needs reproducible patterns per (style, bucket) so
// the texture cache works.
function _seededRng(seed) {
  let s = (seed | 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Procedural facade textures ─────────────────────────────────────────────
const _facadeCache = {};

// ── Facade texture contract ────────────────────────────────────────────
// makeFacadeTexture draws exactly FACADE_ROWS(type) window rows and
// FACADE_COLS(type) window columns into ONE texture repeat. Every caller
// that maps this texture onto geometry MUST size its UVs so that one
// repeat spans FACADE_ROWS storeys vertically — otherwise the window
// rhythm has nothing to do with the building.
//
// This used to be duplicated as magic numbers in three places and they
// drifted: plateau.js mapped one repeat to 4 m of height while asking for
// a 10-row texture, i.e. ten storeys crammed into 4 m (a 40 cm storey).
// At any real camera distance mipmapping averaged that to flat grey —
// which is exactly why PLATEAU buildings rendered as solid colour slabs.
// Single source of truth now.
const FACADE_STOREY_M = 3;                       // metres per window row
function FACADE_ROWS(type) {
  return type === 'glass' ? 8 : type === 'metal' ? 6 : 10;
}
function FACADE_COLS(type) {
  return type === 'metal' ? 4 : 5;
}
// Metres of wall height covered by one full vertical texture repeat.
function facadeRepeatMetres(type, storeyM) {
  return FACADE_ROWS(type) * (storeyM || FACADE_STOREY_M);
}
// Metres of wall length covered by one full horizontal texture repeat.
// _makeWallsGeo divides run length by 8, so this must stay 8.
const FACADE_REPEAT_WIDTH_M = 8;

function makeFacadeTexture(wallHex, type, bucket = 0) {
  const key = `${wallHex.toString(16)}_${type}_${bucket}`;
  if (_facadeCache[key]) return _facadeCache[key];

  // 512 × 1024 — double resolution of the v1 canvas. Keeps window detail
  // legible from a few hundred metres away (the worst case is medium
  // distance where mipmap blur eats sub-pixel features; the extra res
  // pushes that distance further out). One texture repeat is meant to
  // cover ROWS storeys vertically and ~5 windows horizontally, so the
  // per-pixel world size is ~3 cm horizontal × 3 cm vertical for an
  // 8 m × 30 m repeat — plenty for windows.
  const W = 512, H = 1024;
  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d');
  const rng = _seededRng(((wallHex << 4) ^ bucket * 0x9e37) >>> 0);

  const r = (wallHex >> 16) & 0xff;
  const g = (wallHex >> 8) & 0xff;
  const b = wallHex & 0xff;

  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, W, H);

  // ── Base material pattern under the windows ─────────────────────────
  if (type === 'brick') {
    // Divisors of the 512x1024 canvas so the pattern wraps EXACTLY at the
    // seam. 18 and 52 divide neither, so every tile boundary showed a
    // sliced course and a broken bond.
    const courseH = 16, brickW = 64;
    for (let y = 0; y < H; y += courseH) {
      const offset = (y / courseH) % 2 ? brickW / 2 : 0;
      for (let x = -brickW; x < W + brickW; x += brickW) {
        const shade = (rng() - 0.5) * 28;
        ctx.fillStyle = `rgb(${_clamp8(r + shade)},${_clamp8(g + shade * 0.8)},${_clamp8(b + shade * 0.7)})`;
        ctx.fillRect(x + offset + 2, y + 2, brickW - 3, courseH - 3);
      }
    }
  } else if (type === 'wood') {
    const plankW = 32;      // 512 / 32 = 16 planks, exact wrap
    for (let x = 0; x < W; x += plankW) {
      const shade = (rng() - 0.5) * 30;
      ctx.fillStyle = `rgb(${_clamp8(r + shade)},${_clamp8(g + shade * 0.85)},${_clamp8(b + shade * 0.6)})`;
      ctx.fillRect(x + 1, 0, plankW - 2, H);
      ctx.strokeStyle = 'rgba(40,24,8,0.22)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
  } else if (type === 'metal') {
    for (let x = 0; x < W; x += 16) {   // 512 / 16 = 32 ribs, exact wrap
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(x, 0, 5, H);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(x + 8, 0, 5, H);
    }
  } else if (type === 'concrete') {
    // Coarse-aggregate noise — gives the wall a real material read
    // instead of a flat slab. Cheap: 1 px noise sparkles, denser bands
    // at panel joints.
    const idata = ctx.getImageData(0, 0, W, H);
    const px = idata.data;
    for (let i = 0; i < px.length; i += 4) {
      const n = (rng() - 0.5) * 18;
      px[i]     = _clamp8(px[i]     + n);
      px[i + 1] = _clamp8(px[i + 1] + n);
      px[i + 2] = _clamp8(px[i + 2] + n);
    }
    ctx.putImageData(idata, 0, 0);
  }

  // ── Window grid ──────────────────────────────────────────────────────
  // Bigger windows, real depth (recess shadow), mullions, sub-panes,
  // varied per-window lighting and shading suggestion. The grid is
  // sized so ROWS rows fill the height and one row reads as one storey.
  const COLS = FACADE_COLS(type);
  const ROWS = FACADE_ROWS(type);
  // No side padding: with padX on both edges the gap between the last
  // window of one repeat and the first of the next was 2*padX instead of
  // one column pitch, printing a blank double-width pier every 8 m across
  // every long wall. Full-width pitch tiles seamlessly.
  const padX = 0;
  const stepX = W / COLS;
  const stepY = H / ROWS;
  const winW = stepX * (type === 'glass' ? 0.84 : type === 'metal' ? 0.55 : 0.66);
  const winH = stepY * (type === 'glass' ? 0.78 : type === 'metal' ? 0.45 : 0.62);

  // Floor-plate horizontal line for every storey — visible at distance
  // (one of the few features that survives mipmap blur and so makes a
  // distant building still read as a building rather than a slab).
  ctx.strokeStyle = `rgba(0,0,0,${type === 'glass' ? 0.18 : 0.14})`;
  ctx.lineWidth = 2;
  for (let row = 0; row <= ROWS; row++) {
    const y = row * stepY;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  // Subtle horizontal band per floor: tints alternate floors by ±2 L —
  // a building-shape silhouette emerges even at extreme mip levels.
  for (let row = 0; row < ROWS; row++) {
    if (row % 2) continue;
    ctx.fillStyle = 'rgba(0,0,0,0.04)';
    ctx.fillRect(0, row * stepY, W, stepY);
  }

  // Per-floor light bias so adjacent floors aren't independently random
  // (real apartments have whole-floor occupancy patterns).
  const floorLitBias = [];
  for (let row = 0; row < ROWS; row++) floorLitBias.push(rng());

  // Per-column horizontal jitter once per column — windows on the same
  // column align between floors (real buildings do this almost without
  // exception; the old per-cell jitter looked drunk).
  const colJit = [];
  for (let col = 0; col < COLS; col++) colJit.push((rng() - 0.5) * 4);

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const wx = padX + col * stepX + (stepX - winW) / 2 + colJit[col];
      const wy = row * stepY + (stepY - winH) / 2;

      // 1. Recessed frame: a darker rectangle slightly larger than the
      // glass, giving every window a hint of depth.
      ctx.fillStyle = `rgba(${_clamp8(r * 0.35)},${_clamp8(g * 0.35)},${_clamp8(b * 0.35)},0.55)`;
      ctx.fillRect(wx - 2, wy - 1, winW + 4, winH + 3);

      // 2. Glass itself.
      if (type === 'glass') {
        // Curtain-wall: cool blue gradient simulating sky reflection.
        const g1 = ctx.createLinearGradient(wx, wy, wx, wy + winH);
        g1.addColorStop(0,    'rgb(170,215,240)');
        g1.addColorStop(0.45, 'rgb(120,185,225)');
        g1.addColorStop(1,    'rgb(70,140,195)');
        ctx.fillStyle = g1;
        ctx.fillRect(wx, wy, winW, winH);
        // Building-across reflection — diagonal slash darker.
        const refl = ctx.createLinearGradient(wx, wy + winH * 0.3, wx + winW, wy + winH * 0.7);
        refl.addColorStop(0,    'rgba(255,255,255,0.0)');
        refl.addColorStop(0.45, 'rgba(255,255,255,0.18)');
        refl.addColorStop(0.5,  'rgba(255,255,255,0.0)');
        ctx.fillStyle = refl;
        ctx.fillRect(wx, wy, winW, winH);
      } else {
        // DAYLIGHT windows are DARKER than the wall, not brighter: you are
        // looking into an unlit interior with a slice of sky reflected off
        // the top of the pane. The previous version painted ~68 % of
        // windows in the 200–225 range — indistinguishable from a
        // 212,204,192 wall — so most of the grid was invisible and the
        // facade read as a blank slab. Now the default is dark glass
        // (strong contrast against any pale wall) and only a minority are
        // warm-lit, which reads as occupancy rather than noise.
        const litRoll = (floorLitBias[row] * 0.7 + rng() * 0.3);
        const lit = litRoll > 0.86;
        if (lit) {
          // Warm interior light spilling out.
          const gradL = ctx.createLinearGradient(wx, wy, wx, wy + winH);
          gradL.addColorStop(0,   'rgb(255,238,196)');
          gradL.addColorStop(0.4, 'rgb(246,220,166)');
          gradL.addColorStop(1,   'rgb(214,182,130)');
          ctx.fillStyle = gradL;
        } else {
          // Dark interior with a sky reflection fading down the pane.
          const gradD = ctx.createLinearGradient(wx, wy, wx, wy + winH);
          gradD.addColorStop(0,   'rgb(108,132,158)');
          gradD.addColorStop(0.35, 'rgb(52,68,90)');
          gradD.addColorStop(1,   'rgb(28,36,52)');
          ctx.fillStyle = gradD;
        }
        ctx.fillRect(wx, wy, winW, winH);

        // 10% of unlit windows: blind/curtain partially drawn.
        if (!lit && rng() < 0.22) {
          const blindH = winH * (0.3 + rng() * 0.55);
          ctx.fillStyle = 'rgba(220,210,190,0.85)';
          ctx.fillRect(wx, wy, winW, blindH);
          // Blind slat shadows
          ctx.strokeStyle = 'rgba(0,0,0,0.18)';
          ctx.lineWidth = 1;
          for (let by = wy + 3; by < wy + blindH; by += 4) {
            ctx.beginPath(); ctx.moveTo(wx, by); ctx.lineTo(wx + winW, by); ctx.stroke();
          }
        }
      }

      // 3. Mullions — vertical centre + horizontal middle. 2 panes wide
      // × 2 panes tall = 4-pane window, which is what most apartment
      // and office windows actually look like.
      ctx.fillStyle = `rgba(${_clamp8(r * 0.5)},${_clamp8(g * 0.5)},${_clamp8(b * 0.5)},0.8)`;
      ctx.fillRect(wx + winW / 2 - 0.6, wy, 1.2, winH);
      ctx.fillRect(wx, wy + winH / 2 - 0.6, winW, 1.2);

      // 4. Outer frame line — crisp black-ish.
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(wx, wy, winW, winH);

      // 5. Sill — small light strip just under the window for shadow
      // contrast, helps the eye read 3D depth from a flat texture.
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(wx - 2, wy + winH + 2, winW + 4, 1.5);

      // 6. AC unit (residential only, ~6% of unlit windows).
      if (type === 'concrete' && rng() < 0.06) {
        const acX = wx + winW - 8, acY = wy + winH * 0.55;
        ctx.fillStyle = 'rgb(190,190,182)';
        ctx.fillRect(acX, acY, 18, winH * 0.38);
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.strokeRect(acX, acY, 18, winH * 0.38);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        for (let li = 0; li < 4; li++) ctx.fillRect(acX + 2, acY + 4 + li * 4, 14, 1);
      }
    }
  }

  // Mipmap-friendly post: subtle vignette on each floor so a heavily
  // shrunk version still shows horizontal banding (= floors).
  for (let row = 0; row < ROWS; row++) {
    const y0 = row * stepY;
    const grd = ctx.createLinearGradient(0, y0, 0, y0 + stepY);
    grd.addColorStop(0,    'rgba(255,255,255,0.05)');
    grd.addColorStop(0.92, 'rgba(0,0,0,0.05)');
    grd.addColorStop(1,    'rgba(0,0,0,0.18)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, y0, W, stepY);
  }

  const tex = new THREE.CanvasTexture(cvs);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.encoding = THREE.sRGBEncoding;
  tex.anisotropy = 8;            // sharper at grazing angles
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.name = 'facade_' + key;
  _facadeCache[key] = tex;
  return tex;
}

function _clamp8(v) { return Math.max(0, Math.min(255, v | 0)); }

// ── Shopfront texture — bottom 3.5 m of commercial / mixed-use buildings ──
// Big glass storefronts + a coloured signage band at the top. Bucket picks
// the signage colour from a palette so the street reads as a mix of shops
// rather than a single brand. Texture is 256 × 128 and the wall geo's
// vRepeatM is set so one texture covers the full ground-floor height.
const _shopfrontCache = {};
const SIGNAGE_COLOURS = [
  '#c8423a', '#3268c6', '#c9a23a', '#3b9c66', '#9358bc',
  '#c87538', '#2c8aa4', '#a23a86', '#cc6262', '#3a7c40',
];

function makeShopfrontTexture(wallHex, bucket = 0) {
  const key = `${wallHex.toString(16)}_${bucket}`;
  if (_shopfrontCache[key]) return _shopfrontCache[key];

  const W = 256, H = 128;
  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d');
  const rng = _seededRng(((wallHex << 8) ^ bucket * 0x4f1c + 17) >>> 0);

  // Wall above signage (visible only as a thin strip at the very top).
  const wr = (wallHex >> 16) & 0xff, wg = (wallHex >> 8) & 0xff, wb = wallHex & 0xff;
  ctx.fillStyle = `rgb(${wr},${wg},${wb})`;
  ctx.fillRect(0, 0, W, H);

  // Signage band — top ~28 % of the texture. Bucket chooses one of N
  // palette colours so neighbouring shops have different signs.
  const signColour = SIGNAGE_COLOURS[Math.floor(rng() * SIGNAGE_COLOURS.length)];
  ctx.fillStyle = signColour;
  ctx.fillRect(0, 0, W, H * 0.28);
  // Edge shadow under the signage band — visually grounds it.
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, H * 0.28, W, 2);
  // Mock text marks on the signage (random dark blocks).
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  let cursor = 12 + rng() * 20;
  while (cursor < W - 20) {
    const charW = 6 + rng() * 12;
    ctx.fillRect(cursor, H * 0.10, charW, H * 0.12);
    cursor += charW + 5 + rng() * 4;
  }

  // Glass storefront panels — bottom 70 % of texture, repeated horizontally.
  const PANELS = 4;
  const panelW = W / PANELS;
  const glassY = H * 0.32;
  const glassH = H * 0.65;
  for (let i = 0; i < PANELS; i++) {
    const x = i * panelW;
    const grad = ctx.createLinearGradient(x, glassY, x + panelW, glassY + glassH);
    grad.addColorStop(0,   'rgba(80,140,180,0.92)');
    grad.addColorStop(0.5, 'rgba(40,100,150,0.86)');
    grad.addColorStop(1,   'rgba(20,80,130,0.92)');
    ctx.fillStyle = grad;
    ctx.fillRect(x + 3, glassY + 2, panelW - 6, glassH - 4);
    // Highlight reflection.
    ctx.fillStyle = 'rgba(255,255,255,0.20)';
    ctx.fillRect(x + 6, glassY + 4, panelW * 0.32, glassH * 0.32);
    // Dark frame.
    ctx.strokeStyle = 'rgba(20,15,10,0.75)';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(x + 3, glassY + 2, panelW - 6, glassH - 4);
  }
  // Ground line — paves the storefront onto the street visually.
  ctx.fillStyle = 'rgba(40,30,20,0.6)';
  ctx.fillRect(0, H - 3, W, 3);

  const tex = new THREE.CanvasTexture(cvs);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.encoding = THREE.sRGBEncoding;
  tex.name = 'shop_' + key;
  _shopfrontCache[key] = tex;
  return tex;
}

// True if the OSM `building=*` tag (or footprint size for the `yes` /
// untagged case) suggests this building has a commercial ground floor.
// Used to gate the storefront overlay.
function _hasShopfront(tags, areaM2, height) {
  const t = (tags.building || '').toLowerCase();
  if (['commercial','retail','office','supermarket','mall','kiosk',
       'department_store','public','civic','hotel'].includes(t)) return true;
  if (t === 'mixed') return true;
  // Unspecified / generic large building in a dense area — assume
  // commercial. Filters out small houses (< 80 m²) and short structures.
  if ((t === 'yes' || t === '') && areaM2 > 80 && height >= 6) return true;
  return false;
}

function getBuildingStyle(tags) {
  const t = (tags.building || '').toLowerCase();
  const mat = (tags['building:material'] || '').toLowerCase();
  // Cartoon-friendly palette — roofs significantly brighter than before
  // because the old photoreal roof colours went near-black under the
  // SketchUp ambient+hemi rig. pbr.* is kept for back-compat but
  // MeshLambertMaterial ignores it.
  //
  // `type` selects the procedural facade PATTERN (window grid + base
  // material drawing in makeFacadeTexture): glass curtain wall, brick
  // courses, wood siding, corrugated metal, or plain concrete. OSM's
  // building:material tag drives it directly when present — that's the
  // most truthful per-building signal we have — with building= type
  // heuristics as fallback.
  if (mat === 'glass' || (!mat && ['commercial','retail','office','civic','public'].includes(t)))
    return { wall: 0x9ac2d4, roof: 0x809ab0, type: 'glass',    pbr: { rough: 0.15, metal: 0.55 } };
  if (mat === 'brick')
    return { wall: 0xb87858, roof: 0x96604a, type: 'brick',    pbr: { rough: 0.9,  metal: 0.0  } };
  if (mat === 'metal' || mat === 'steel' ||
      (!mat && ['industrial','warehouse','factory','hangar'].includes(t)))
    return { wall: 0xb8bcc0, roof: 0x9a9a92, type: 'metal',    pbr: { rough: 0.45, metal: 0.55 } };
  if (mat === 'wood' || (!mat && ['church','cathedral','temple','shrine'].includes(t)))
    return { wall: 0xc8a878, roof: 0xa8884a, type: 'wood',     pbr: { rough: 0.75, metal: 0.0  } };
  if (mat === 'concrete' || mat === 'plaster' || mat === 'cement_block')
    return { wall: 0xd0ccc4, roof: 0x9a9488, type: 'concrete', pbr: { rough: 0.85, metal: 0.0  } };
  if (['residential','house','apartments','dormitory'].includes(t))
    return { wall: 0xe4c890, roof: 0xc06840, type: 'concrete', pbr: { rough: 0.85, metal: 0.0  } };  // terracotta
  return { wall: 0xd4ccc0, roof: 0x9a8a78, type: 'concrete', pbr: { rough: 0.85, metal: 0.0 } };
}

// ── Procedural roof textures ──────────────────────────────────────────────
// Two patterns:
//   pitched → overlapping clay-tile rows (gabled/hipped/pyramidal houses)
//   flat    → asphalt / gravel membrane with seams
// One texture covers a 4 m × 4 m patch of roof, so a typical 12 m house
// roof sees ~3 repeats and individual tiles read at ~30 cm — the natural
// size in real life.
const _roofTexCache = {};
function makeRoofTexture(baseHex, pitched) {
  const key = `${baseHex}_${pitched ? 'tile' : 'flat'}`;
  if (_roofTexCache[key]) return _roofTexCache[key];

  const W = 256, H = 256;
  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d');

  const br = (baseHex >> 16) & 0xff;
  const bg = (baseHex >> 8) & 0xff;
  const bb = baseHex & 0xff;
  const baseRGB = (k=1) => `rgb(${(br*k)|0},${(bg*k)|0},${(bb*k)|0})`;
  // Seeded, not Math.random(): the roof pattern is part of the rendered
  // image, so an unseeded generator makes two loads of the same share URL
  // produce visibly different roofs — the link stops reproducing the view
  // it promised, and screenshots are not repeatable either. Everything
  // that feeds the pixels must derive from the same key as the cache.
  const rng = _seededRng(((baseHex << 3) ^ (pitched ? 0x5bf03 : 0x1d7a9)) >>> 0);

  if (pitched) {
    // Mortar / shadow background — kept a bit darker than the base, but
    // not so dark that it dominates a flat-shaded view. Old value 0.55
    // produced near-black gaps that read as solid black under cartoon
    // lighting.
    ctx.fillStyle = baseRGB(0.78);
    ctx.fillRect(0, 0, W, H);

    // Overlapping rows of curved clay tiles. Rows offset every other row.
    const tileW = 24, tileH = 16;
    for (let row = -1; row * tileH < H; row++) {
      const y = row * tileH;
      const offX = (row & 1) ? tileW / 2 : 0;
      for (let col = -1; col * tileW + offX < W; col++) {
        const x = col * tileW + offX;
        // 0.90 .. 1.30 around base — guarantees tiles are at least as
        // bright as the base colour even after random variation.
        const v = 0.90 + rng() * 0.40;
        // Tile body: rounded "shield" top + rectangle base.
        ctx.fillStyle = baseRGB(v);
        ctx.beginPath();
        ctx.moveTo(x, y + tileH);
        ctx.lineTo(x, y + tileH * 0.55);
        ctx.arc(x + tileW * 0.5, y + tileH * 0.55, tileW * 0.5, Math.PI, 0, false);
        ctx.lineTo(x + tileW, y + tileH);
        ctx.closePath();
        ctx.fill();
        // Top highlight.
        ctx.strokeStyle = `rgba(255,255,255,${0.10 + rng() * 0.08})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x + tileW * 0.5, y + tileH * 0.55, tileW * 0.5 - 0.8, Math.PI, 0, false);
        ctx.stroke();
        // Bottom shadow line — separates rows. Lighter than before so
        // the grid doesn't read as dark stripes on bright tiles.
        ctx.strokeStyle = 'rgba(0,0,0,0.28)';
        ctx.beginPath();
        ctx.moveTo(x - 0.5, y + tileH);
        ctx.lineTo(x + tileW + 0.5, y + tileH);
        ctx.stroke();
      }
    }
  } else {
    // Asphalt-membrane base + noise + faint seams every 1 m (= 64 px).
    // Brightened from 0.85 to 0.96 so flat roofs don't read as a dark
    // smudge from above.
    ctx.fillStyle = baseRGB(0.96);
    ctx.fillRect(0, 0, W, H);
    const img = ctx.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rng() - 0.5) * 22;
      img.data[i]   = Math.max(0, Math.min(255, img.data[i]   + n));
      img.data[i+1] = Math.max(0, Math.min(255, img.data[i+1] + n));
      img.data[i+2] = Math.max(0, Math.min(255, img.data[i+2] + n));
    }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    for (let s = 0; s < W; s += 64) {
      ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(s, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, s); ctx.lineTo(W, s); ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(cvs);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.encoding = THREE.sRGBEncoding;
  tex.name = `roof_${key}`;
  _roofTexCache[key] = tex;
  return tex;
}

// Project geometry vertices to world-XZ planar UVs so a single tile
// texture maps onto any roof shape — pyramidal, hipped, gabled, flat —
// without per-face UV unwrapping. UV_SCALE controls the world distance
// covered by one texture tile.
const ROOF_UV_SCALE = 4;
function _addRoofUVs(geo) {
  const pos = geo.attributes.position;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uvs[i*2]   = pos.getX(i) / ROOF_UV_SCALE;
    uvs[i*2+1] = pos.getZ(i) / ROOF_UV_SCALE;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geo;
}

// ── Material cache (shared across buildings of the same style) ─────────────
let _matCache = { wall: {}, roof: {} };
function resetBuildingCaches() {
  _matCache = { wall: {}, roof: {} };
  for (const k in _facadeCache) delete _facadeCache[k];
  for (const k in _roofTexCache) delete _roofTexCache[k];
  for (const k in _shopfrontCache) delete _shopfrontCache[k];
  _roofEquipMat = null;  // disposed by clearSceneObjects; rebuild next run
  _aerialRoof = null;
  _facadePalette = null;
  _cc0Walls = null;
}

// ── Aerial-photo roof projection (Auto-Create-bldg-lod2-tool style) ────────
// When createBuildingGroup gets the aerial CanvasTexture, FLAT roofs are
// textured by projecting the same ortho photo the terrain uses: the photo
// genuinely contains every roof as seen from above, and it lines up
// seamlessly with the ground because it IS the ground texture. Pitched
// roofs keep their procedural tile/shingle look (an ortho photo of a
// pitched roof smeared across sloped faces looks wrong).
let _aerialRoof = null;   // { mat, xSize, zSize } for the current run

// Neighbourhood wall palette derived from Mapillary street imagery by the
// optional facade-palette server (colour STATISTICS only — the textures
// themselves stay 100% procedural). When set, building wall base colours
// come from this pool instead of the per-type style defaults.
let _facadePalette = null;   // array of int hex, or null

// CC0 photo-texture map for the current run (see js/cc0textures.js).
// type → THREE.Texture. When set, _getWallMat builds materials with the
// photo texture instead of the procedural canvas; missing types or load
// failures still fall back to procedural per-call.
let _cc0Walls = null;

function _aerialUVRoof(geo) {
  const pos = geo.attributes.position;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uvs[i * 2]     = pos.getX(i) / _aerialRoof.xSize;
    uvs[i * 2 + 1] = 1 - pos.getZ(i) / _aerialRoof.zSize;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geo;
}

function _getWallMat(style, bucket = 0) {
  const off = HSL_OFFSETS[bucket % STYLE_VARIANTS];
  const wallHex = _jitterHexHSL(style.wall, off.dh, off.ds, off.dl);
  // CC0 photo-texture branch: one shared material per building TYPE
  // (the photo carries every detail — windows, panels, weathering — so
  // we don't bucket-jitter it). Falls back to procedural for any type
  // that didn't load successfully.
  if (_cc0Walls && _cc0Walls.has(style.type)) {
    const ckey = `cc0_${style.type}`;
    if (_matCache.wall[ckey]) return _matCache.wall[ckey];
    const mat = new THREE.MeshLambertMaterial({
      map: _cc0Walls.get(style.type), vertexColors: true });
    mat.name = `wall_${ckey}`;
    _matCache.wall[ckey] = mat;
    return mat;
  }
  const key = `${wallHex.toString(16)}_${style.type}_${bucket}`;
  if (_matCache.wall[key]) return _matCache.wall[key];
  const tex = makeFacadeTexture(wallHex, style.type, bucket);
  // vertexColors carries the baked ground-contact AO from _makeWallsGeo.
  const mat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true });
  mat.name = `wall_${key}`;
  _matCache.wall[key] = mat;
  return mat;
}
function _getShopfrontMat(style, bucket = 0) {
  const off = HSL_OFFSETS[bucket % STYLE_VARIANTS];
  const wallHex = _jitterHexHSL(style.wall, off.dh, off.ds, off.dl);
  const key = `shop_${wallHex.toString(16)}_${bucket}`;
  if (_matCache.wall[key]) return _matCache.wall[key];
  const tex = makeShopfrontTexture(wallHex, bucket);
  const mat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true });
  mat.name = key;
  _matCache.wall[key] = mat;
  return mat;
}

// Blank coping for parapets / upstands — never the window facade. Double
// sided so looking down into a roof shows the parapet's inner face rather
// than seeing straight through it.
function _getParapetMat(style, bucket = 0) {
  const off = HSL_OFFSETS[bucket % STYLE_VARIANTS];
  const hex = _jitterHexHSL(style.roof, off.dh * 0.4, off.ds * 0.4, off.dl * 0.4 + 0.06);
  const key = `parapet_${hex.toString(16)}`;
  if (_matCache.roof[key]) return _matCache.roof[key];
  const mat = new THREE.MeshLambertMaterial({
    color: hex, side: THREE.DoubleSide, vertexColors: true });
  mat.name = key;
  _matCache.roof[key] = mat;
  return mat;
}

function _getRoofMat(style, pitched, bucket = 0) {
  const off = HSL_OFFSETS[bucket % STYLE_VARIANTS];
  // Real rooftops vary less than walls — use half the wall jitter so the
  // skyline doesn't end up with eight wildly different roof colours.
  const roofHex = _jitterHexHSL(style.roof, off.dh * 0.5, off.ds * 0.5, off.dl * 0.5);
  const key = `${roofHex.toString(16)}_${style.type}_${pitched ? 'p' : 'f'}_${bucket}`;
  if (_matCache.roof[key]) return _matCache.roof[key];
  const mat = new THREE.MeshLambertMaterial({
    map: makeRoofTexture(roofHex, pitched),
    // Flat roofs come from THREE.ShapeGeometry whose winding is arbitrary
    // depending on Earcut output; DoubleSide guarantees visibility.
    side: THREE.DoubleSide,
  });
  mat.name = `roof_${key}`;
  _matCache.roof[key] = mat;
  return mat;
}

// ── Wall geometry — non-capped quad strip with proper UVs ──────────────────
// ExtrudeGeometry produces walls + a flat cap; we want walls only so the
// roof geometry can replace the cap cleanly.
//
// Winding note: our coordinate frame has +X east, +Y up, +Z south. After
// ensuring `area2 >= 0`, the footprint is traversed clockwise as seen from
// +Y, so the outward direction for each edge is the LEFT side of walking
// — equivalently, the cross (top-bot) × (b-a) (rather than the natural
// (b-a) × (top-bot)). We emit triangles in (a-bot, b-top, b-bot) /
// (a-bot, a-top, b-top) order so the right-hand-rule normals point
// outward and FrontSide culling keeps them visible.
// ── Baked ambient occlusion ───────────────────────────────────────────────
// Nothing in the scene darkens where a building meets the ground, and that
// missing contact shading is the single strongest cue that a render is
// "3D" rather than cardboard cut-outs pasted on a photo. A real AO pass
// (SSAO) is not available under the r0.128 UMD script set we ship, but the
// dominant term — occlusion by the ground plane itself — is a pure
// function of height above ground, so it can be baked into vertex colours
// for free at build time.
//
// Returns the AO multiplier for a wall vertex `y` metres above `groundY`.
const AO_HEIGHT_M = 6;     // fades out this far up the wall
const AO_STRENGTH = 0.42;  // 1 - darkest multiplier at the very bottom
function _wallAO(y, groundY) {
  const t = Math.min(1, Math.max(0, (y - groundY) / AO_HEIGHT_M));
  // Square root: occlusion falls off fast near the ground and lingers,
  // which matches how a real contact shadow reads.
  return 1 - AO_STRENGTH * (1 - Math.sqrt(t));
}

function _makeWallsGeo(footprint, baseY, topY, vRepeatM = 4, groundY) {
  const positions = [], uvs = [], colors = [];
  const n = footprint.length;
  const vMax = (topY - baseY) / vRepeatM;
  // AO is measured from the BUILDING's ground line, not from this strip's
  // own baseY — a shopfront band and the wall above it must share one
  // continuous gradient, and a parapet 60 m up must get no AO at all.
  const gY = (groundY == null) ? baseY : groundY;
  const aoLo = _wallAO(baseY, gY), aoHi = _wallAO(topY, gY);
  const push = (...v) => { for (const c of v) colors.push(c, c, c); };
  for (let i = 0; i < n; i++) {
    const a = footprint[i], b = footprint[(i + 1) % n];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const uMax = segLen / FACADE_REPEAT_WIDTH_M;
    positions.push(a.x, baseY, a.z,   b.x, topY, b.z,    b.x, baseY, b.z);
    positions.push(a.x, baseY, a.z,   a.x, topY, a.z,    b.x, topY, b.z);
    uvs.push(0, 0,  uMax, vMax,  uMax, 0);
    uvs.push(0, 0,  0, vMax,     uMax, vMax);
    push(aoLo, aoHi, aoLo);
    push(aoLo, aoHi, aoHi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

// ── Roof shape generators ──────────────────────────────────────────────────
// All return a BufferGeometry positioned in world space — vertices already
// at the correct (x, y, z). The mesh that wraps them sits at the identity.

// True iff the footprint is convex — every consecutive triple turns the
// same way. Non-convex polygons (L/U/T houses, courtyards, complex
// commercial blocks) break every fan-triangulation algorithm we have
// for pitched roofs, so we use this to demote them to flat.
function _isConvex(pts) {
  const n = pts.length;
  if (n < 4) return true;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
    const ux = b.x - a.x, uz = b.z - a.z;
    const vx = c.x - b.x, vz = c.z - b.z;
    const cross = ux * vz - uz * vx;
    // Normalise by the edge lengths so the threshold is a TURN ANGLE, not
    // an area. The old test compared the raw cross product against 1e-6,
    // which in metres-squared is essentially zero: a surveyed footprint
    // whose wall jogs by a centimetre over 10 m yields a cross of ~0.1 and
    // was read as a genuine reversal of direction. Almost every real OSM
    // building therefore failed the convexity test and got demoted to a
    // flat roof — including the simple rectangles-with-a-nick that pitched
    // roofs handle perfectly well. sin(3 deg) tolerance keeps real L/U/T
    // shapes rejected while accepting survey noise.
    const len = Math.sqrt(ux * ux + uz * uz) * Math.sqrt(vx * vx + vz * vz);
    if (len < 1e-9) continue;
    const sinTurn = cross / len;
    if (Math.abs(sinTurn) < 0.05) continue;
    const s = sinTurn > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function _makeFlatRoofGeo(footprint, y) {
  // Triangulate via THREE.Shape so non-convex footprints work too.
  const shape = new THREE.Shape(footprint.map(p => new THREE.Vector2(p.x, -p.z)));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  return _addRoofUVs(geo);
}

function _makePyramidalRoofGeo(footprint, baseY, topY) {
  const n = footprint.length;
  const cx = footprint.reduce((s, p) => s + p.x, 0) / n;
  const cz = footprint.reduce((s, p) => s + p.z, 0) / n;
  const positions = [];
  // Triangle order (a, apex, b) keeps the right-hand-rule normal pointing
  // outward+up for our CW-from-+Y footprint convention.
  for (let i = 0; i < n; i++) {
    const a = footprint[i], b = footprint[(i + 1) % n];
    positions.push(a.x, baseY, a.z,  cx, topY, cz,  b.x, baseY, b.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return _addRoofUVs(geo);
}

function _makeDomeRoofGeo(footprint, baseY, topY) {
  // Sphere fit to the footprint bounding circle, with its equator at baseY.
  const n = footprint.length;
  const cx = footprint.reduce((s, p) => s + p.x, 0) / n;
  const cz = footprint.reduce((s, p) => s + p.z, 0) / n;
  const r = Math.max(...footprint.map(p => Math.hypot(p.x - cx, p.z - cz)));
  const h = topY - baseY;
  // SphereGeometry top half only
  const sphere = new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  // Squash vertically to match roof height instead of r
  sphere.scale(1, h / r, 1);
  sphere.translate(cx, baseY, cz);
  // SphereGeometry has spherical UVs already; replace with planar so the
  // tile texture aligns with the other roof shapes.
  return _addRoofUVs(sphere);
}

// Gabled roof built over the polygon's oriented bounding box, *not* its
// raw outline. The OBB approach gives:
//   - a clean ridge at the middle of the long axis
//   - two long sloped trapezoids covering the full roof width
//   - two vertical triangular gable ends
//   - ~4 % eave overhang so the roof reads like a real overhanging roof
// rather than a tarp shrink-wrapped to the wall. The previous "each edge
// slopes to one ridge endpoint" trick produced asymmetric, hole-ridden
// surfaces on any footprint that wasn't a perfect aspect-ratio rectangle.
//
// Ridge orientation comes from the longest edge of the footprint, not a
// PCA fit. PCA was numerically degenerate on near-square plans (a square
// + 1 % digitisation noise in OSM vertices flipped the principal axis by
// nearly 90°), which gave apartment blocks a randomly rotated roof.
// Longest-edge is deterministic, matches what a person would draw by
// hand, and reduces to the natural axis for honest rectangles.
function _makeGabledRoofGeo(footprint, baseY, topY) {
  const n = footprint.length;
  const cx = footprint.reduce((s, p) => s + p.x, 0) / n;
  const cz = footprint.reduce((s, p) => s + p.z, 0) / n;

  // Longest-edge direction = ridge axis.
  let bestL2 = 0;
  let dx0 = 1, dz0 = 0;
  for (let i = 0; i < n; i++) {
    const a = footprint[i], b = footprint[(i + 1) % n];
    const dx = b.x - a.x, dz = b.z - a.z;
    const L2 = dx*dx + dz*dz;
    if (L2 > bestL2) { bestL2 = L2; dx0 = dx; dz0 = dz; }
  }
  const L = Math.sqrt(bestL2) || 1;
  const ax = dx0 / L,  az = dz0 / L;   // along ridge
  const nx = -az,      nz = ax;        // perpendicular

  // Project footprint into (ridge, perp) frame → OBB extents.
  let tMin = +Infinity, tMax = -Infinity, sMin = +Infinity, sMax = -Infinity;
  for (const p of footprint) {
    const dx = p.x - cx, dz = p.z - cz;
    const t = dx * ax + dz * az;
    const s = dx * nx + dz * nz;
    if (t < tMin) tMin = t; if (t > tMax) tMax = t;
    if (s < sMin) sMin = s; if (s > sMax) sMax = s;
  }
  // 4 % eave overhang on both axes.
  const tEave = (tMax - tMin) * 0.04, sEave = (sMax - sMin) * 0.04;
  tMin -= tEave; tMax += tEave;
  sMin -= sEave; sMax += sEave;

  const corner = (t, s) => ({
    x: cx + ax * t + nx * s,
    z: cz + az * t + nz * s,
  });
  // c1..c4 walk the OBB CW from +Y (same convention as our footprints).
  const c1 = corner(tMin, sMin);  // NW (or "back-left" in ridge frame)
  const c2 = corner(tMax, sMin);  // NE
  const c3 = corner(tMax, sMax);  // SE
  const c4 = corner(tMin, sMax);  // SW
  // Ridge endpoints sit on the OBB midline along the perp axis.
  const rA = { x: cx + ax * tMin, y: topY, z: cz + az * tMin };
  const rB = { x: cx + ax * tMax, y: topY, z: cz + az * tMax };

  // Winding hand-verified for our +X-east / +Y-up / +Z-south frame so the
  // right-hand-rule normal points up + outward on every face. See the
  // commit message for the per-triangle derivation.
  const P = [];
  // North slope (trapezoid c1-c2-rB-rA → two CCW-from-camera triangles)
  P.push(c1.x, baseY, c1.z,  rB.x, rB.y, rB.z,  c2.x, baseY, c2.z);
  P.push(c1.x, baseY, c1.z,  rA.x, rA.y, rA.z,  rB.x, rB.y, rB.z);
  // South slope (trapezoid c3-c4-rA-rB)
  P.push(c3.x, baseY, c3.z,  rA.x, rA.y, rA.z,  c4.x, baseY, c4.z);
  P.push(c3.x, baseY, c3.z,  rB.x, rB.y, rB.z,  rA.x, rA.y, rA.z);
  // West gable
  P.push(c4.x, baseY, c4.z,  rA.x, rA.y, rA.z,  c1.x, baseY, c1.z);
  // East gable
  P.push(c2.x, baseY, c2.z,  rB.x, rB.y, rB.z,  c3.x, baseY, c3.z);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.computeVertexNormals();
  return _addRoofUVs(geo);
}

function _makeRoofGeo(shape, footprint, baseY, topY) {
  if (topY <= baseY + 0.01) return _makeFlatRoofGeo(footprint, baseY);
  switch (shape) {
    case 'flat':       return _makeFlatRoofGeo(footprint, baseY);
    case 'pyramidal':
    case 'hipped':
    case 'hip':        return _makePyramidalRoofGeo(footprint, baseY, topY);
    case 'dome':
    case 'onion':      return _makeDomeRoofGeo(footprint, baseY, topY);
    case 'gabled':
    case 'gable':
    case 'pitched':    return _makeGabledRoofGeo(footprint, baseY, topY);
    default:           return _makePyramidalRoofGeo(footprint, baseY, topY);
  }
}

// ── Rooftop equipment ───────────────────────────────────────────────────
// HVAC units, water tanks, stairwell housings — the clutter that makes a
// flat roof read as a real building from an oblique / top-down view
// instead of a clean slab. Shared flat-grey material (no texture).
let _roofEquipMat = null;
function _getRoofEquipMat() {
  if (!_roofEquipMat) {
    _roofEquipMat = new THREE.MeshLambertMaterial({ color: 0x8a8a86 });
    _roofEquipMat.name = 'roof_equipment';
  }
  return _roofEquipMat;
}

function _ptInPoly2d(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
    if (((zi > z) !== (zj > z)) &&
        (x < (xj - xi) * (z - zi) / (zj - zi + 1e-9) + xi)) inside = !inside;
  }
  return inside;
}

// Emit 5 faces of an axis-aligned box (top + 4 sides; bottom omitted —
// it sits on the roof). Winding hand-verified for +X-east / +Y-up /
// +Z-south so every outward normal is correct.
function _emitBox(P, cx, cz, bx, bz, by, y0) {
  const xl = cx - bx/2, xr = cx + bx/2;
  const zb = cz - bz/2, zf = cz + bz/2;
  const y1 = y0 + by;
  P.push(xl,y1,zb, xr,y1,zf, xr,y1,zb,  xl,y1,zb, xl,y1,zf, xr,y1,zf); // top +Y
  P.push(xl,y0,zb, xr,y1,zb, xr,y0,zb,  xl,y0,zb, xl,y1,zb, xr,y1,zb); // north -Z
  P.push(xr,y0,zf, xl,y1,zf, xl,y0,zf,  xr,y0,zf, xr,y1,zf, xl,y1,zf); // south +Z
  P.push(xl,y0,zf, xl,y1,zb, xl,y0,zb,  xl,y0,zf, xl,y1,zf, xl,y1,zb); // west -X
  P.push(xr,y0,zb, xr,y1,zf, xr,y0,zf,  xr,y0,zb, xr,y1,zb, xr,y1,zf); // east +X
}

function _emitRoofEquipment(out, footprint, roofY, bucket, areaM2) {
  const rng = _seededRng((bucket * 0x2f1b + 911) >>> 0);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of footprint) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  // More boxes on bigger roofs, capped at 6.
  const count = Math.min(6, 2 + Math.floor(areaM2 / 400) + Math.floor(rng() * 2));
  const P = [];
  let placed = 0, tries = 0;
  while (placed < count && tries < count * 6) {
    tries++;
    const x = minX + rng() * (maxX - minX);
    const z = minZ + rng() * (maxZ - minZ);
    if (!_ptInPoly2d(x, z, footprint)) continue;
    const bx = 1 + rng() * 2;    // 1-3 m
    const bz = 1 + rng() * 2;
    const by = 1 + rng() * 1.5;  // 1-2.5 m
    _emitBox(P, x, z, bx, bz, by, roofY);
    placed++;
  }
  if (P.length === 0) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.computeVertexNormals();
  out.push({ geometry: geo, material: _getRoofEquipMat() });
}

// ── Building assembly ──────────────────────────────────────────────────────
// Emits geometry parts as { geometry, material } into `out` rather than
// building a Mesh per part. createBuildingGroup then merges everything that
// shares a material into one BufferGeometry — turning hundreds of draw
// calls (2-4 meshes × hundreds of buildings) into a handful (one per
// distinct material = ~style × bucket).
function buildingToParts(building, bb, elevGrid, gridN, vertExag, out) {
  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);

  const pts2d = building.coords.map(c => ({
    x: toLocalX(c.lon, bb),
    z: toLocalZ(c.lat, bb),
  }));

  // Normalise winding so the signed area is positive in our XZ frame.
  // +X is east, +Z is south (toLocalZ uses bb.n - lat), so the +Y-up view
  // sees this as CLOCKWISE — _makeWallsGeo / roof generators rely on
  // that orientation for their right-hand-rule outward normals.
  let area2 = 0;
  for (let i = 0; i < pts2d.length; i++) {
    const a = pts2d[i], b = pts2d[(i + 1) % pts2d.length];
    area2 += a.x * b.z - b.x * a.z;
  }
  if (area2 < 0) pts2d.reverse();

  const cx = pts2d.reduce((s, p) => s + p.x, 0) / pts2d.length;
  const cz = pts2d.reduce((s, p) => s + p.z, 0) / pts2d.length;

  // Ground contact. Sampling the terrain at the CENTROID only means every
  // building on a slope is planted at its middle height: the downhill half
  // floats in mid-air and the uphill half is buried. On a 10 % grade a 40 m
  // building floats/sinks by ±2 m — extremely visible, and it is what makes
  // hillside districts look like scattered cards.
  //
  // Sample the whole footprint and sit the building on its LOWEST corner,
  // so the downhill side meets the ground and the uphill side embeds into
  // the slope. That is both what real construction does (cut and fill) and
  // the only choice that never leaves a visible gap under a wall.
  let baseElev = Infinity;
  for (const p of pts2d) {
    const e = getElevAt(elevGrid, gridN,
      Math.min(1, Math.max(0, p.x / xSize)),
      Math.min(1, Math.max(0, p.z / zSize))) * vertExag;
    if (e < baseElev) baseElev = e;
  }
  if (!isFinite(baseElev)) {
    baseElev = getElevAt(elevGrid, gridN, cx / xSize, cz / zSize) * vertExag;
  }

  let style = getBuildingStyle(building.tags);
  // Wall colour priority: explicit OSM building:colour tag > Mapillary
  // neighbourhood palette > per-type style default. The footprint hash
  // keeps palette assignment stable across re-runs.
  const taggedColour = building.tags
    && (building.tags['building:colour'] || building.tags['building:color']);
  if (taggedColour) {
    const c = new THREE.Color(style.wall);
    c.set(String(taggedColour).toLowerCase());   // hex or CSS name; invalid → unchanged
    style = Object.assign({}, style, { wall: c.getHex() });
  } else if (_facadePalette && _facadePalette.length) {
    const pick = _facadePalette[_buildingBucket(building.coords) % _facadePalette.length];
    style = Object.assign({}, style, { wall: pick });
  }
  // Roof tags: explicit roof:colour wins; otherwise roof:material picks a
  // plausible tone (zinc-grey metal, green roof, clay tile).
  const tagsB = building.tags || {};
  const roofColourTag = tagsB['roof:colour'] || tagsB['roof:color'];
  const roofMatTag = String(tagsB['roof:material'] || '').toLowerCase();
  if (roofColourTag) {
    const rc = new THREE.Color(style.roof);
    rc.set(String(roofColourTag).toLowerCase());   // invalid → unchanged
    style = Object.assign({}, style, { roof: rc.getHex() });
  } else if (roofMatTag) {
    if (/metal|steel|zinc|copper/.test(roofMatTag))      style = Object.assign({}, style, { roof: 0x96a0a6 });
    else if (/grass|green/.test(roofMatTag))             style = Object.assign({}, style, { roof: 0x7aa05c });
    else if (/roof_tiles|tile/.test(roofMatTag))         style = Object.assign({}, style, { roof: 0xb86848 });
  }
  const minH  = building.minH;
  const totalH = building.height;

  // Fan-triangulated pitched roofs need a convex footprint — demote
  // non-convex (L/U/T) to flat so they reach full height without holes.
  let roofShape = building.roofShape;
  let roofH     = building.roofH;
  if (roofShape !== 'flat' && roofShape !== 'dome' && !_isConvex(pts2d)) {
    roofShape = 'flat';
    roofH = 0;
  }

  // Simple-3D-Buildings semantics: `height` is the ABSOLUTE top above
  // ground and the volume spans min_height..height — min_height is where
  // the part STARTS, not an extra offset added under the height. Adding
  // both (baseElev + minH + totalH) stretched every stacked building:part
  // tower: a part with min_height=100/height=200 topped out at 300 m.
  const roofTop = baseElev + totalH;
  const wallTop = roofTop - roofH;
  const baseY   = baseElev + minH;
  const bucket  = _buildingBucket(building.coords);

  // Ground-floor shopfront band for commercial / large generic buildings.
  const wallH = wallTop - baseY;
  const wantShopfront = wallH >= 6 && _hasShopfront(building.tags, building.area, totalH);
  const groundH = wantShopfront ? Math.min(3.5, wallH * 0.25) : 0;
  const groundTopY = baseY + groundH;

  if (wantShopfront) {
    out.push({ geometry: _makeWallsGeo(pts2d, baseY, groundTopY, groundH, baseY),
               material: _getShopfrontMat(style, bucket) });
  }
  // Floor-height-aware vertical UV repeat: one facade-texture window ROW
  // per real storey. building:levels is OSM ground truth when present
  // (floor height = building height / levels, clamped to sane bounds);
  // 3 m otherwise. The facade canvas carries rowsPerRepeat window rows,
  // so one full texture repeat spans rowsPerRepeat × floorH metres —
  // windows land at storey rhythm instead of an arbitrary fixed repeat.
  const levelsTag = _posFloat(tagsB['building:levels'] ?? tagsB.levels, 0);
  const floorH = levelsTag > 0
    ? Math.max(2.4, Math.min(5, totalH / levelsTag)) : FACADE_STOREY_M;
  out.push({ geometry: _makeWallsGeo(pts2d, groundTopY, wallTop,
                                     facadeRepeatMetres(style.type, floorH), baseY),
             material: _getWallMat(style, bucket) });

  const pitched = roofShape !== 'flat' && roofH > 0.5;
  if (roofShape === 'flat' && _aerialRoof) {
    out.push({ geometry: _aerialUVRoof(_makeRoofGeo('flat', pts2d, wallTop, roofTop)),
               material: _aerialRoof.mat });
  } else {
    out.push({ geometry: _makeRoofGeo(roofShape, pts2d, wallTop, roofTop),
               material: _getRoofMat(style, pitched, bucket) });
  }

  // Parapet on tall flat roofs — a low solid upstand around the roof deck.
  //
  // Two bugs used to live here. (1) It reused the WINDOW facade material,
  // so every roof edge in the city wore a band of sliced windows. A real
  // parapet is blank coping. (2) It then capped the top with a second roof
  // surface at wallTop + parapetH, turning the parapet into a solid block
  // that sealed over the actual roof deck at wallTop — which is also where
  // _emitRoofEquipment places HVAC units, so every rooftop machine was
  // entombed one parapet-height below a lid. Now: blank double-sided
  // upstand, no lid, deck stays visible.
  if (roofShape === 'flat' && totalH >= 6 && building.area >= 25) {
    const parapetH = Math.min(1.0, 0.4 + totalH * 0.012);
    out.push({ geometry: _makeWallsGeo(pts2d, wallTop, wallTop + parapetH, parapetH, baseY),
               material: _getParapetMat(style, bucket) });
  }

  // Rooftop equipment (HVAC / water tank / stairwell box) on flat roofs.
  if (roofShape === 'flat' && totalH >= 9 && building.area >= 120) {
    _emitRoofEquipment(out, pts2d, wallTop, bucket, building.area);
  }
}

// Concatenate position / normal / uv of many geometries into one.
// Indexed geometries (ShapeGeometry flat roofs, SphereGeometry domes) are
// expanded to flat triangle soup first via toNonIndexed — otherwise their
// shared-vertex index would be lost and the mesh would shatter. Normals
// are preserved (recomputing would smooth across building boundaries);
// geometries missing uv leave zeros in their slots.
function _concatGeometries(geos) {
  const flat = geos.map(g => g.index ? { geo: g.toNonIndexed(), temp: true }
                                     : { geo: g, temp: false });
  let posLen = 0;
  for (const f of flat) posLen += f.geo.attributes.position.array.length;
  const positions = new Float32Array(posLen);
  const normals   = new Float32Array(posLen);
  const uvs       = new Float32Array((posLen / 3) * 2);
  // Baked AO travels as vertex colours. Geometries that carry none must
  // default to WHITE — leaving the Float32Array at its zero fill would
  // multiply those surfaces to black the moment any material in the merge
  // has vertexColors enabled.
  const colors    = new Float32Array(posLen).fill(1);
  let po = 0, uo = 0;
  for (const f of flat) {
    const g = f.geo;
    const pa = g.attributes.position.array;
    positions.set(pa, po);
    if (g.attributes.normal) normals.set(g.attributes.normal.array, po);
    if (g.attributes.uv) uvs.set(g.attributes.uv.array, uo);
    if (g.attributes.color) colors.set(g.attributes.color.array, po);
    po += pa.length;
    uo += (pa.length / 3) * 2;
    if (f.temp) g.dispose();   // free the toNonIndexed scratch copy
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal',   new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
  merged.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  return merged;
}

function createBuildingGroup(buildings, bb, elevGrid, gridN, vertExag, opts) {
  // Aerial roof projection for this run (see _aerialRoof). Set before any
  // buildingToParts call; reset by resetBuildingCaches between runs.
  _aerialRoof = null;
  if (opts && opts.aerialTex) {
    const mat = new THREE.MeshLambertMaterial({ map: opts.aerialTex, side: THREE.DoubleSide });
    mat.name = 'roof_aerial';
    _aerialRoof = { mat, xSize: bboxXSize(bb), zSize: bboxZSize(bb) };
  }
  _facadePalette = (opts && Array.isArray(opts.facadePalette) && opts.facadePalette.length)
    ? opts.facadePalette : null;
  _cc0Walls = (opts && opts.cc0Walls instanceof Map && opts.cc0Walls.size)
    ? opts.cc0Walls : null;
  // Collect every geometry part across all buildings, keyed by material.
  const byMaterial = new Map();
  for (const b of buildings) {
    const parts = [];
    try {
      buildingToParts(b, bb, elevGrid, gridN, vertExag, parts);
    } catch { continue; }
    for (const part of parts) {
      if (!byMaterial.has(part.material)) byMaterial.set(part.material, []);
      byMaterial.get(part.material).push(part.geometry);
    }
  }

  // One merged mesh per material.
  const group = new THREE.Group();
  group.name = 'buildings';
  for (const [material, geos] of byMaterial) {
    if (geos.length === 0) continue;
    const merged = _concatGeometries(geos);
    geos.forEach(g => g.dispose());  // free the per-building scratch geos
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
