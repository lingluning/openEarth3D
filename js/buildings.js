'use strict';

// ── Overpass fetch ─────────────────────────────────────────────────────────
// We pull buildings AND ground features (roads / water / trees) in one
// request so the user only waits for a single Overpass round-trip.
async function fetchBuildings(bb) {
  const q = `[out:json][timeout:40];
(
  way["building"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["building"](${bb.s},${bb.w},${bb.n},${bb.e});
);
out body;>;out skel qt;`;
  return _overpassJson(q);
}

// Shared Overpass helper. Overpass returns plain text on 429 / 504 / 500
// (e.g. "rate_limited"), so res.json() throws an unhelpful SyntaxError.
// Detect that and surface the actual status code instead.
async function _overpassJson(query) {
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || !ct.includes('json')) {
    const snippet = (await res.text()).slice(0, 120).replace(/\s+/g, ' ').trim();
    throw new Error(`Overpass ${res.status}: ${snippet || res.statusText}`);
  }
  const json = await res.json();
  return json.elements || [];
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

function parseBuildings(elements, bb) {
  const nodeMap = {};
  elements.filter(e => e.type === 'node').forEach(n => { nodeMap[n.id] = n; });

  // Lookup `way` elements by id so we can resolve simple multipolygon
  // relation outers (complex donut-shaped buildings like train stations).
  const wayMap = {};
  elements.filter(e => e.type === 'way').forEach(w => { wayMap[w.id] = w; });

  // Yield {tags, coords} for both standalone ways and the outer ring of
  // a `type=multipolygon` building relation. Inner rings (holes) are
  // skipped because our extruder doesn't model holes.
  function* iterFootprints() {
    for (const e of elements) {
      if (!e.tags || !e.tags.building) continue;
      // OSM `building=no` explicitly marks "this is not a building" — common
      // on park outlines and parking lots — so we have to exclude it.
      if (e.tags.building === 'no') continue;

      if (e.type === 'way') {
        yield { tags: e.tags, way: e };
      } else if (e.type === 'relation' && e.tags.type === 'multipolygon' && e.members) {
        // Pick the first `outer` member with resolvable nodes.
        const outer = e.members.find(m => m.type === 'way' && m.role === 'outer' && wayMap[m.ref]);
        if (outer) yield { tags: e.tags, way: wayMap[outer.ref] };
      }
    }
  }

  const buildings = [];
  for (const { tags, way } of iterFootprints()) {
    const coords = way.nodes
      .map(id => nodeMap[id])
      .filter(Boolean)
      .map(n => ({ lat: n.lat, lon: n.lon }));
    if (coords.length < 3) continue;

    // Validated numerics. Defaults guard against missing / malformed tags
    // ("yes", "12 m", negative levels) and prevent inverted geometry.
    const levels  = _posFloat(tags['building:levels'] || tags['levels'], 2);
    const height  = _posFloat(tags.height, Math.max(3, levels * 3.2));
    let   minH    = _posFloat(tags.min_height, 0);
    if (minH >= height) minH = 0; // a floating slab makes no sense; ignore

    const area      = _footprintAreaM2(coords, bb);
    const roofShape = _inferRoofShape(tags, area, height);
    let   roofH     = _posFloat(tags['roof:height'], _inferRoofHeight(roofShape, height, area));
    // Roof can't be taller than the building above its min_height base.
    roofH = Math.min(roofH, Math.max(0, height - minH - 2));

    buildings.push({ coords, height, minH, roofH, roofShape, area, tags });
  }
  return buildings;
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

function makeFacadeTexture(wallHex, type, bucket = 0) {
  const key = `${wallHex.toString(16)}_${type}_${bucket}`;
  if (_facadeCache[key]) return _facadeCache[key];

  const W = 256, H = 512;
  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d');
  // Reproducible randomness per bucket — same bucket always gives the
  // same window-light pattern, AC unit placement, etc.
  const rng = _seededRng(((wallHex << 4) ^ bucket * 0x9e37) >>> 0);

  const r = (wallHex >> 16) & 0xff;
  const g = (wallHex >> 8) & 0xff;
  const b = wallHex & 0xff;

  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = `rgba(0,0,0,0.12)`;
  ctx.lineWidth = 1;
  for (let y = 22; y < H; y += 22) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  const COLS = type === 'glass' ? 4 : 5;
  const ROWS = type === 'glass' ? 8 : 10;
  const padX = 16, padY = 22;
  const stepX = (W - padX * 2) / COLS;
  const stepY = (H - padY * 2) / ROWS;
  const winW = stepX * (type === 'glass' ? 0.78 : 0.60);
  const winH = stepY * (type === 'glass' ? 0.72 : 0.55);

  // Concrete-style buildings get an optional balcony rail on a random
  // row — extra horizontal detail that distinguishes apartments from
  // offices. Glass curtain-walls don't have these.
  let balconyRow = -1;
  if (type === 'concrete' && rng() < 0.6) {
    balconyRow = Math.floor(rng() * (ROWS - 2)) + 1;
  }

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      // ±2 px jitter so the grid doesn't look like graph paper.
      const wx = padX + col * stepX + (stepX - winW) / 2 + (rng() - 0.5) * 3;
      const wy = padY + row * stepY + (stepY - winH) / 2 + (rng() - 0.5) * 3;
      if (type === 'glass') {
        const grad = ctx.createLinearGradient(wx, wy, wx + winW, wy + winH);
        grad.addColorStop(0, 'rgba(140,210,240,0.88)');
        grad.addColorStop(0.5, 'rgba(100,180,220,0.75)');
        grad.addColorStop(1, 'rgba(60,140,190,0.82)');
        ctx.fillStyle = grad;
        ctx.fillRect(wx, wy, winW, winH);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(wx + 2, wy + 2, winW * 0.35, winH * 0.4);
      } else {
        const lit = rng() > 0.22;
        ctx.fillStyle = lit ? 'rgba(200,228,255,0.80)' : 'rgba(22,30,50,0.86)';
        ctx.fillRect(wx, wy, winW, winH);
        if (lit) {
          ctx.strokeStyle = 'rgba(180,210,240,0.6)';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(wx + winW * 0.5, wy);
          ctx.lineTo(wx + winW * 0.5, wy + winH);
          ctx.stroke();
        }
        // 5 % chance: small AC unit hanging off the side of an unlit window
        if (!lit && rng() < 0.05) {
          ctx.fillStyle = 'rgba(168,168,160,1.0)';
          ctx.fillRect(wx + winW + 1, wy + winH * 0.3, 7, winH * 0.45);
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.strokeRect(wx + winW + 1, wy + winH * 0.3, 7, winH * 0.45);
        }
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(wx, wy, winW, winH);
    }
    // Balcony rail across the row (drawn over the windows we just painted
    // below the rail line). Subtle horizontal dark band reads as railing.
    if (row === balconyRow) {
      const y = padY + row * stepY + stepY * 0.92;
      ctx.fillStyle = 'rgba(60,45,32,0.55)';
      ctx.fillRect(0, y, W, 2.2);
      // Vertical balusters
      ctx.fillStyle = 'rgba(60,45,32,0.40)';
      for (let bx = 4; bx < W; bx += 8) ctx.fillRect(bx, y - 5, 1, 6);
    }
  }

  const tex = new THREE.CanvasTexture(cvs);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.encoding = THREE.sRGBEncoding;
  tex.name = 'facade_' + key;
  _facadeCache[key] = tex;
  return tex;
}

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
  if (mat === 'glass' || ['commercial','retail','office','civic','public'].includes(t))
    return { wall: 0x9ac2d4, roof: 0x809ab0, type: 'glass',    pbr: { rough: 0.15, metal: 0.55 } };
  if (mat === 'metal' || ['industrial','warehouse','factory'].includes(t))
    return { wall: 0xb4b4ac, roof: 0x9a9a92, type: 'concrete', pbr: { rough: 0.45, metal: 0.55 } };
  if (mat === 'wood'  || ['church','cathedral','temple','shrine'].includes(t))
    return { wall: 0xe8d490, roof: 0xa8884a, type: 'concrete', pbr: { rough: 0.75, metal: 0.0  } };
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
        const v = 0.90 + Math.random() * 0.40;
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
        ctx.strokeStyle = `rgba(255,255,255,${0.10 + Math.random() * 0.08})`;
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
      const n = (Math.random() - 0.5) * 22;
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
}

function _getWallMat(style, bucket = 0) {
  const off = HSL_OFFSETS[bucket % STYLE_VARIANTS];
  const wallHex = _jitterHexHSL(style.wall, off.dh, off.ds, off.dl);
  const key = `${wallHex.toString(16)}_${style.type}_${bucket}`;
  if (_matCache.wall[key]) return _matCache.wall[key];
  const tex = makeFacadeTexture(wallHex, style.type, bucket);
  // Cartoon style: Lambert reads the hemi gradient but has no specular
  // or env reflections.
  const mat = new THREE.MeshLambertMaterial({ map: tex });
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
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  mat.name = key;
  _matCache.wall[key] = mat;
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
function _makeWallsGeo(footprint, baseY, topY, vRepeatM = 4) {
  const positions = [], uvs = [];
  const n = footprint.length;
  const vMax = (topY - baseY) / vRepeatM;  // 4 m vertical repeat by default
  for (let i = 0; i < n; i++) {
    const a = footprint[i], b = footprint[(i + 1) % n];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const uMax = segLen / 8;          // 8 m horizontal texture repeat
    positions.push(a.x, baseY, a.z,   b.x, topY, b.z,    b.x, baseY, b.z);
    positions.push(a.x, baseY, a.z,   a.x, topY, a.z,    b.x, topY, b.z);
    uvs.push(0, 0,  uMax, vMax,  uMax, 0);
    uvs.push(0, 0,  0, vMax,     uMax, vMax);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
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
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) continue;
    const s = cross > 0 ? 1 : -1;
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
function _makeGabledRoofGeo(footprint, baseY, topY) {
  const n = footprint.length;
  const cx = footprint.reduce((s, p) => s + p.x, 0) / n;
  const cz = footprint.reduce((s, p) => s + p.z, 0) / n;

  // PCA principal axis = ridge direction.
  let sxx = 0, szz = 0, sxz = 0;
  for (const p of footprint) {
    const dx = p.x - cx, dz = p.z - cz;
    sxx += dx*dx; szz += dz*dz; sxz += dx*dz;
  }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ax = Math.cos(theta),  az = Math.sin(theta);   // along ridge
  const nx = -az,              nz = ax;                 // perpendicular

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

// ── Building assembly ──────────────────────────────────────────────────────
function buildingToMesh(building, bb, elevGrid, gridN, vertExag) {
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
  const baseElev = getElevAt(elevGrid, gridN, cx / xSize, cz / zSize) * vertExag;

  // parseBuildings has already validated and clamped these so they're safe
  // to use directly: minH < totalH, roofH ≤ totalH - minH - 2.
  const style = getBuildingStyle(building.tags);
  const minH  = building.minH;
  const totalH = building.height;

  // Fan-triangulated pitched roofs (pyramidal/gabled) need a convex
  // footprint — on L/U/T-shaped polygons the fan triangles either leave
  // visible holes or fold over each other, which is exactly the "roofs
  // are partial" symptom users hit. Demote to flat here so the building
  // still reaches its tagged height instead of standing under a half-
  // missing roof.
  let roofShape = building.roofShape;
  let roofH     = building.roofH;
  if (roofShape !== 'flat' && roofShape !== 'dome' && !_isConvex(pts2d)) {
    roofShape = 'flat';
    roofH = 0;
  }

  const wallTop = baseElev + minH + (totalH - roofH);
  const roofTop = baseElev + minH + totalH;
  const baseY   = baseElev + minH;

  // Per-building variant bucket — drives the HSL jitter on wall/roof
  // material and the random seed for the facade window pattern. Same
  // bucket → cached material; total cache size stays ~5 styles × 2
  // types × 8 buckets ≈ 80 entries.
  const bucket = _buildingBucket(building.coords);
  const group = new THREE.Group();

  // Walls: side quads only, with UVs ready for facade texture.
  //
  // Commercial / mixed-use / large generic buildings get a separate
  // ground-floor band with a shopfront texture (big glass + signage).
  // Upper floors keep the regular facade. Threshold of 6 m total height
  // avoids forcing storefronts on single-storey shacks where it'd look
  // off-scale.
  const wallH = wallTop - baseY;
  const wantShopfront = wallH >= 6 && _hasShopfront(building.tags, building.area, totalH);
  const groundH = wantShopfront ? Math.min(3.5, wallH * 0.25) : 0;
  const groundTopY = baseY + groundH;

  if (wantShopfront) {
    // Ground floor — one texture height covers the full band, no repeat.
    const groundGeo = _makeWallsGeo(pts2d, baseY, groundTopY, groundH);
    const groundMesh = new THREE.Mesh(groundGeo, _getShopfrontMat(style, bucket));
    groundMesh.castShadow = true;
    groundMesh.receiveShadow = true;
    group.add(groundMesh);
  }

  // Upper floors (or whole wall if no shopfront).
  const wallGeo = _makeWallsGeo(pts2d, groundTopY, wallTop);
  const wallMesh = new THREE.Mesh(wallGeo, _getWallMat(style, bucket));
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;

  // Roof: matches the OSM roof:shape tag (or our inference if absent).
  // Use the locally-demoted roofShape so non-convex footprints get the
  // flat roof + tile-vs-membrane choice we actually computed above.
  const pitched = roofShape !== 'flat' && roofH > 0.5;
  const roofGeo = _makeRoofGeo(roofShape, pts2d, wallTop, roofTop);
  const roofMesh = new THREE.Mesh(roofGeo, _getRoofMat(style, pitched, bucket));
  roofMesh.castShadow = true;
  roofMesh.receiveShadow = true;

  group.add(wallMesh);
  group.add(roofMesh);

  // Parapet for tall enough flat-roofed buildings — small wall ring above
  // the roof slab plus a thin concrete cap. Gives the silhouette the
  // characteristic "raised lip" that flat roofs actually have in real
  // life; without it everything just stops at the wall plane.
  // Skip on tiny structures (sheds, small houses) where it'd look weird.
  if (roofShape === 'flat' && totalH >= 6 && building.area >= 25) {
    const parapetH = Math.min(1.0, 0.4 + totalH * 0.012);  // ~0.4-1.0 m
    const parapetGeo = _makeWallsGeo(pts2d, wallTop, wallTop + parapetH);
    const parapetMesh = new THREE.Mesh(parapetGeo, _getWallMat(style, bucket));
    parapetMesh.castShadow = true;
    parapetMesh.receiveShadow = true;
    group.add(parapetMesh);
    // Concrete cap closing the top of the parapet ring.
    const capGeo = _makeFlatRoofGeo(pts2d, wallTop + parapetH);
    const capMesh = new THREE.Mesh(capGeo, _getRoofMat(style, false, bucket));
    capMesh.receiveShadow = true;
    group.add(capMesh);
  }

  return group;
}

function createBuildingGroup(buildings, bb, elevGrid, gridN, vertExag) {
  const group = new THREE.Group();
  for (const b of buildings) {
    try {
      group.add(buildingToMesh(b, bb, elevGrid, gridN, vertExag));
    } catch {}
  }
  return group;
}
