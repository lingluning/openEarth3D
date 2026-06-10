'use strict';

// openEarth3D facade-palette server.
//
// Looks up street-level photos near a coordinate on Mapillary (Meta's
// crowd-sourced street imagery, CC-BY-SA, official API), and derives the
// DOMINANT WALL COLOUR PALETTE of the neighbourhood. The viewer feeds
// that palette into its own procedural facade generator.
//
// Licensing posture, deliberately conservative:
//   - imagery is fetched through the official Graph API with your own
//     access token, never scraped;
//   - no image bytes are stored, cached to disk, or re-served — the only
//     output is a handful of aggregate colour values (facts, not works);
//   - the generated textures are 100% procedural, so they are "similar
//     in palette" to the street, never copies of any photo.
//
// Usage:
//   cd server && npm install
//   MAPILLARY_TOKEN=MLY|xxxx... node facade-server.js
//   → GET http://localhost:8787/palette?lat=35.68&lon=139.76&radius=600
//   ← { palette: ["#b8b0a4", ...], samples: 4 }
//
// Get a free token at https://www.mapillary.com/dashboard/developers
// (register an app, copy the client token).

const http = require('http');
const Jimp = require('jimp');

const TOKEN = process.env.MAPILLARY_TOKEN || '';
const PORT = parseInt(process.env.PORT || '8787', 10);

// In-memory palette cache. Street colour schemes don't change hour to
// hour; one lookup per ~100 m cell per process lifetime is plenty.
const cache = new Map();

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    // The viewer is a static page on any origin (file://, GitHub Pages…).
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

async function mapillaryImageUrls(lat, lon, radiusM, limit = 6) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].join(',');
  const url =
    'https://graph.mapillary.com/images' +
    `?access_token=${encodeURIComponent(TOKEN)}` +
    `&bbox=${bbox}&limit=${limit}&fields=id,thumb_1024_url`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapillary API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.data || []).map(d => d.thumb_1024_url).filter(Boolean);
}

// Is this pixel plausibly a building wall (vs sky / vegetation / road)?
function wallish(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const v = mx / 255;
  const s = mx ? (mx - mn) / mx : 0;
  if (v < 0.15) return false;                       // asphalt, deep shadow
  if (b > r + 25 && b > g + 10 && s > 0.2) return false;  // sky
  if (g > r + 20 && g > b + 20) return false;       // vegetation
  return true;
}

// Derive the dominant wall palette from a handful of street photos.
// Pixels are bucketed at 3 bits/channel; only the middle horizontal band
// of each photo is sampled (top ≈ sky, bottom ≈ road surface).
async function extractPalette(urls) {
  const buckets = new Map();   // key → { n, r, g, b }
  let photos = 0;
  for (const u of urls.slice(0, 4)) {
    let img;
    try {
      img = await Jimp.read(u);
    } catch {
      continue;   // one unreadable photo shouldn't kill the request
    }
    img.resize(96, 96);
    photos++;
    for (let y = Math.floor(96 * 0.3); y < Math.floor(96 * 0.75); y++) {
      for (let x = 0; x < 96; x += 2) {
        const { r, g, b } = Jimp.intToRGBA(img.getPixelColor(x, y));
        if (!wallish(r, g, b)) continue;
        const key = ((r >> 5) << 10) | ((g >> 5) << 5) | (b >> 5);
        const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        e.n++; e.r += r; e.g += g; e.b += b;
        buckets.set(key, e);
      }
    }
  }
  const top = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 5);
  const palette = top.map(e => {
    const hx = c => Math.round(c / e.n).toString(16).padStart(2, '0');
    return `#${hx(e.r)}${hx(e.g)}${hx(e.b)}`;
  });
  return { palette, samples: photos };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (u.pathname === '/health') return send(res, 200, { ok: true });

  if (u.pathname === '/palette') {
    if (!TOKEN) {
      return send(res, 503, {
        error: 'MAPILLARY_TOKEN not set — get a free token at https://www.mapillary.com/dashboard/developers',
      });
    }
    const lat = parseFloat(u.searchParams.get('lat'));
    const lon = parseFloat(u.searchParams.get('lon'));
    const radius = Math.min(2000, parseFloat(u.searchParams.get('radius')) || 600);
    if (!isFinite(lat) || !isFinite(lon)) {
      return send(res, 400, { error: 'lat and lon are required' });
    }
    const key = `${lat.toFixed(3)},${lon.toFixed(3)},${radius}`;
    if (cache.has(key)) return send(res, 200, cache.get(key));
    try {
      const urls = await mapillaryImageUrls(lat, lon, radius);
      if (!urls.length) {
        const empty = { palette: [], samples: 0, note: 'no Mapillary coverage here' };
        cache.set(key, empty);
        return send(res, 200, empty);
      }
      const result = await extractPalette(urls);
      result.attribution = 'palette derived from Mapillary street imagery (CC-BY-SA)';
      cache.set(key, result);
      return send(res, 200, result);
    } catch (e) {
      return send(res, 502, { error: String(e.message || e) });
    }
  }

  send(res, 404, { error: 'unknown endpoint — use /palette?lat=&lon=&radius= or /health' });
});

server.listen(PORT, () => {
  console.log(`facade-palette server on http://localhost:${PORT}`);
  console.log(TOKEN ? 'Mapillary token: set' : '⚠ MAPILLARY_TOKEN not set — /palette will return 503');
});
