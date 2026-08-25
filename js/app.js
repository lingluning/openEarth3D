'use strict';

// Mesh density is now user-selectable (see #meshDetail); DEM zoom is
// picked automatically inside fetchElevGridHiRes so that one DEM pixel
// ≈ one grid cell at the chosen density.
// PHOTO_ZOOM is the *desired* upper bound — fetchAerialPhoto walks the
// multi-source pyramid (terrain.js) and probes down per source. Custom
// drone/municipal tile servers can take advantage of the higher cap.
const PHOTO_ZOOM = 22;
const LS_KEY     = 'openearth3d:lastInputs';

let leafletMap, leafletMarker;
let currentTerrain = null, currentBuildings = null, currentFeatures = null;
// Kept for click-to-inspect: the parsed OSM building array + the bbox they
// were built in, so a raycast hit can be matched back to a footprint.
let currentBuildingData = null, currentBB = null;

function initMap() {
  leafletMap = L.map('minimap').setView([35.6812, 139.7671], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(leafletMap);
  leafletMap.on('click', e => setCenter(e.latlng.lat, e.latlng.lng));
}

function setCenter(lat, lon) {
  if (leafletMarker) leafletMap.removeLayer(leafletMarker);
  leafletMarker = L.marker([lat, lon]).addTo(leafletMap);
  leafletMap.setView([lat, lon], 15);
  document.getElementById('latInput').value = lat.toFixed(6);
  document.getElementById('lonInput').value = lon.toFixed(6);
}

function setProgress(pct, label) {
  document.getElementById('progressBar').style.width = (pct * 100).toFixed(1) + '%';
  document.getElementById('progressLabel').textContent = label;
}

function showProgress(v) {
  document.getElementById('progressWrap').style.display = v ? 'flex' : 'none';
  // Showing the bar cancels any pending auto-hide: otherwise a hide timer
  // armed at the end of the PREVIOUS run fires part-way through this one
  // and blanks the progress UI while work is still going.
  if (v) cancelProgressHide();
}

let _progressHideTimer = null;
function cancelProgressHide() {
  if (_progressHideTimer != null) { clearTimeout(_progressHideTimer); _progressHideTimer = null; }
}
function scheduleProgressHide(ms) {
  cancelProgressHide();
  _progressHideTimer = setTimeout(() => { _progressHideTimer = null; showProgress(false); }, ms);
}

// Show a transient error in the progress label instead of a blocking alert.
// The label lives inside #progressWrap which is display:none outside a run,
// so force the wrap visible — otherwise errors fired from idle-state buttons
// (invalid lat/lon, geolocation denied, export/share failures) are silent.
function showError(msg) {
  showProgress(true);
  const label = document.getElementById('progressLabel');
  if (label) {
    label.textContent = '❌ ' + msg;
    label.style.color = '#ff8a8a';
    scheduleProgressHide(6000);
    setTimeout(() => { label.style.color = ''; }, 6000);
  }
}

// Non-error sibling of showError for success/status toasts (share copied,
// screenshot saved, …) — same surfacing, no ❌ and no red.
function showStatus(msg) {
  showProgress(true);
  const label = document.getElementById('progressLabel');
  if (label) {
    label.textContent = msg;
    scheduleProgressHide(4000);
  }
}

function persistInputs() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      lat: document.getElementById('latInput').value,
      lon: document.getElementById('lonInput').value,
      km: document.getElementById('rangeKm').value,
      buildings: document.getElementById('toggleBuildings').checked,
      vertExag: document.getElementById('vertExag').value,
      photoSource: document.getElementById('photoSource').value,
      customAerialJson: document.getElementById('customAerialJson').value,
      facadeServerUrl: (document.getElementById('facadeServerUrl') || {}).value || '',
      cc0Facades: !!(document.getElementById('toggleCc0Facades') || {}).checked,
      cc0OverrideJson: (document.getElementById('cc0OverrideJson') || {}).value || '',
      textureQuality: document.getElementById('textureQuality').value,
      meshDetail: document.getElementById('meshDetail').value,
      hour: document.getElementById('timeOfDay').value,
      plateau: document.getElementById('togglePlateau').checked,
    }));
  } catch {}
}

function restoreInputs() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const v = JSON.parse(raw);
    if (v.lat) document.getElementById('latInput').value = v.lat;
    if (v.lon) document.getElementById('lonInput').value = v.lon;
    if (v.km) {
      document.getElementById('rangeKm').value = v.km;
      document.getElementById('kmLabel').textContent = parseFloat(v.km).toFixed(1) + ' km';
    }
    if (typeof v.buildings === 'boolean') document.getElementById('toggleBuildings').checked = v.buildings;
    if (v.vertExag) {
      document.getElementById('vertExag').value = v.vertExag;
      document.getElementById('exagLabel').textContent = parseFloat(v.vertExag).toFixed(1) + 'x';
    }
    if (v.photoSource) document.getElementById('photoSource').value = v.photoSource;
    if (v.customAerialJson != null) {
      document.getElementById('customAerialJson').value = v.customAerialJson;
      validateCustomAerialJson();
    }
    if (v.facadeServerUrl != null && document.getElementById('facadeServerUrl')) {
      document.getElementById('facadeServerUrl').value = v.facadeServerUrl;
    }
    if (typeof v.cc0Facades === 'boolean' && document.getElementById('toggleCc0Facades')) {
      document.getElementById('toggleCc0Facades').checked = v.cc0Facades;
    }
    if (v.cc0OverrideJson != null && document.getElementById('cc0OverrideJson')) {
      document.getElementById('cc0OverrideJson').value = v.cc0OverrideJson;
    }
    if (v.textureQuality) document.getElementById('textureQuality').value = v.textureQuality;
    if (v.meshDetail) document.getElementById('meshDetail').value = v.meshDetail;
    if (v.hour != null) {
      const slider = document.getElementById('timeOfDay');
      slider.value = v.hour;
      updateHourLabel(v.hour);
      if (typeof setTimeOfDay === 'function') setTimeOfDay(parseFloat(v.hour));
    }
    if (typeof v.plateau === 'boolean') document.getElementById('togglePlateau').checked = v.plateau;
  } catch {}
}

function updateHourLabel(h) {
  const v = parseFloat(h);
  const hh = String(Math.floor(v)).padStart(2, '0');
  const mm = String(Math.round((v - Math.floor(v)) * 60)).padStart(2, '0');
  document.getElementById('hourLabel').textContent = `${hh}:${mm}`;
}

// ── Custom aerial source JSON config ─────────────────────────────────────
// Users can plug in self-hosted ortho servers (drone, downloaded municipal
// GeoTIFF tiled with TileServer-GL, OpenDroneMap output, etc) by pasting
// an array of source specs into the textarea. Each spec:
//   { name, url, minZoom, maxZoom, bbox: {s,n,w,e} }
// url must contain {z}/{x}/{y} placeholders. bbox is optional (omit for
// global coverage). Single-source quick form: just paste a URL string.
const AERIAL_PRESETS_JSON = `[
  {
    "name": "サンプル: 自前ドローンタイル",
    "url": "https://your.server/path/{z}/{x}/{y}.jpg",
    "minZoom": 18,
    "maxZoom": 22,
    "bbox": { "s": 35.681, "n": 35.690, "w": 139.760, "e": 139.770 }
  },
  {
    "name": "サンプル: 横浜市 12.5cm（要自前ホスト）",
    "url": "https://your.cdn/yokohama-125cm/{z}/{x}/{y}.jpg",
    "minZoom": 16,
    "maxZoom": 21,
    "bbox": { "s": 35.300, "n": 35.580, "w": 139.515, "e": 139.788 }
  }
]`;

// Parse the textarea content into an array of source specs. Returns [] on
// any failure — fetchAerialPhoto silently falls back to built-in sources
// instead of breaking the whole generate flow on a typo.
function parseCustomAerialJson(text) {
  const t = text.trim();
  if (!t) return [];
  // Quick "just a URL" shortcut.
  if (/^https?:\/\//i.test(t)) return [{ url: t }];
  try {
    const parsed = JSON.parse(t);
    if (!Array.isArray(parsed)) return [parsed];
    return parsed;
  } catch {
    return [];
  }
}

// Inline status under the textarea — tells the user "3 sources OK" vs.
// "JSON parse error" without blocking the generate flow.
function validateCustomAerialJson() {
  const el = document.getElementById('customAerialJson');
  const status = document.getElementById('customAerialStatus');
  if (!el || !status) return;
  const t = (el.value || '').trim();
  if (!t) { status.textContent = ''; return; }
  if (/^https?:\/\//i.test(t)) {
    status.textContent = '✓ 単一 URL モード';
    status.style.color = '#81d4fa';
    return;
  }
  try {
    const parsed = JSON.parse(t);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const valid = arr.filter(s => s && typeof s.url === 'string');
    status.textContent = `✓ ${valid.length} ソース定義`;
    status.style.color = '#81d4fa';
  } catch (e) {
    status.textContent = '⚠️ JSON 構文エラー: ' + (e.message || '').slice(0, 60);
    status.style.color = '#ff8a8a';
  }
}

function setExportEnabled(enabled) {
  for (const id of ['exportBtn', 'exportFormat', 'shareBtn', 'shotBtn']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.disabled = !enabled;
    el.style.opacity = enabled ? '1' : '.5';
  }
}

// ── Share URL ────────────────────────────────────────────────────────────
// Encode the current location + settings into the URL hash so a link
// reproduces the exact view. Hash (not query) keeps it client-side only.
function buildShareUrl() {
  const g = id => (document.getElementById(id) || {}).value;
  const params = {
    lat: g('latInput'), lon: g('lonInput'), km: g('rangeKm'),
    mesh: g('meshDetail'), src: g('photoSource'), tex: g('textureQuality'),
    exag: g('vertExag'),
    bldg: document.getElementById('toggleBuildings').checked ? '1' : '0',
    plateau: document.getElementById('togglePlateau').checked ? '1' : '0',
  };
  // Custom aerial source list must travel in the share link, otherwise
  // sharing a view with src=custom hands the recipient a 'custom' mode
  // with no usable source and aerial fetch fails to reproduce the view.
  // Only include when non-empty to keep the URL short.
  const customs = (g('customAerialJson') || '').trim();
  if (customs) params.customs = customs;
  return location.origin + location.pathname + '#' + new URLSearchParams(params).toString();
}

// Apply settings from the URL hash on load. Returns true if anything was
// applied (so we know to skip the localStorage restore / could auto-run).
function applyHashState() {
  if (!location.hash || location.hash.length < 2) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  const set = (id, key) => { const v = p.get(key); if (v != null && document.getElementById(id)) document.getElementById(id).value = v; };
  set('latInput', 'lat'); set('lonInput', 'lon'); set('rangeKm', 'km');
  set('meshDetail', 'mesh'); set('photoSource', 'src');
  set('textureQuality', 'tex'); set('vertExag', 'exag');
  if (p.get('bldg') != null) document.getElementById('toggleBuildings').checked = p.get('bldg') === '1';
  if (p.get('plateau') != null) document.getElementById('togglePlateau').checked = p.get('plateau') === '1';
  if (p.get('customs') != null) {
    document.getElementById('customAerialJson').value = p.get('customs');
    validateCustomAerialJson();
  }
  // Labels must reflect what the range input ACTUALLY accepted — a
  // malformed hash (#km=abc) is rejected by the input element but
  // parseFloat(p.get(...)) would still render "NaN km".
  document.getElementById('kmLabel').textContent =
    parseFloat(document.getElementById('rangeKm').value).toFixed(1) + ' km';
  document.getElementById('exagLabel').textContent =
    parseFloat(document.getElementById('vertExag').value).toFixed(1) + 'x';
  return p.has('lat') && p.has('lon');
}

// ── Click-to-inspect ─────────────────────────────────────────────────────
// Raycast the merged building meshes; match the world hit point back to an
// OSM footprint (point-in-polygon in local metres) to show its tags.
function _ptInPolyLocal(x, z, coordsLocal) {
  let inside = false;
  for (let i = 0, j = coordsLocal.length - 1; i < coordsLocal.length; j = i++) {
    const xi = coordsLocal[i].x, zi = coordsLocal[i].z;
    const xj = coordsLocal[j].x, zj = coordsLocal[j].z;
    if (((zi > z) !== (zj > z)) &&
        (x < (xj - xi) * (z - zi) / (zj - zi + 1e-9) + xi)) inside = !inside;
  }
  return inside;
}

function pickBuildingInfo(clientX, clientY) {
  if (!currentBuildings || !currentBuildingData || !currentBB) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObject(currentBuildings, true);
  if (hits.length === 0) return null;
  const hx = hits[0].point.x, hz = hits[0].point.z;

  // Find the footprint that contains (or is nearest to) the hit point.
  let best = null, bestDist = Infinity;
  for (const b of currentBuildingData) {
    const local = b.coords.map(c => ({ x: toLocalX(c.lon, currentBB), z: toLocalZ(c.lat, currentBB) }));
    if (_ptInPolyLocal(hx, hz, local)) return { b, point: hits[0].point };
    // boundary fallback: track nearest centroid
    const cx = local.reduce((s, p) => s + p.x, 0) / local.length;
    const cz = local.reduce((s, p) => s + p.z, 0) / local.length;
    const d = (cx - hx) ** 2 + (cz - hz) ** 2;
    if (d < bestDist) { bestDist = d; best = b; }
  }
  // Accept the nearest footprint only if the hit is plausibly on it (<8 m).
  return (best && bestDist < 64) ? { b: best, point: hits[0].point } : null;
}

function showBuildingInfo(info) {
  const panel = document.getElementById('buildingInfo');
  if (!panel) return;
  if (!info) { panel.style.display = 'none'; return; }
  const t = info.b.tags || {};
  const name = t.name || t['name:en'] || t['name:ja'] || '(無名)';
  const type = t.building && t.building !== 'yes' ? t.building : '建物';
  const rows = [
    `<b>${name}</b>`,
    `種別: ${type}`,
    `高さ: ${info.b.height.toFixed(1)} m`,
    `屋根: ${info.b.roofShape}`,
    `床面積: ${Math.round(info.b.area)} m²`,
  ];
  if (t['building:levels']) rows.push(`階数: ${t['building:levels']}`);
  panel.innerHTML = rows.join('<br>') +
    '<br><span style="color:#7a9ab8;font-size:0.68rem">クリックで閉じる</span>';
  panel.style.display = 'block';
}

// ── Screenshot ────────────────────────────────────────────────────────────
function downloadScreenshot() {
  // Force one fresh render so the framebuffer is populated, then read it.
  if (composer) composer.render(); else renderer.render(scene, camera);
  renderer.domElement.toBlob(blob => {
    if (!blob) { showError('スクリーンショット失敗'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `openEarth3D_${Date.now()}.png`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
}

// Remove every triangle whose world-space centroid falls outside the map
// rectangle (plus `margin`), rewriting each mesh's geometry in place.
// Triangle granularity is what makes this correct for PLATEAU, where one
// mesh can hold an entire district. Returns { total, removed } counts.
function cullGeometryOutside(group, xSize, zSize, margin) {
  group.updateMatrixWorld(true);
  const lo = -margin, hiX = xSize + margin, hiZ = zSize + margin;
  const v = new THREE.Vector3();
  let total = 0, removed = 0;
  const doomed = [];

  group.traverse(o => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const pos = src.attributes.position;
    const uv = src.attributes.uv, nrm = src.attributes.normal;
    const triCount = Math.floor(pos.count / 3);
    total += triCount;

    // First pass: decide, so we can allocate exactly and bail out early
    // when nothing changes (the common case for a fully-inside mesh).
    const keep = new Uint8Array(triCount);
    let kept = 0;
    for (let t = 0; t < triCount; t++) {
      let cx = 0, cz = 0;
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, t * 3 + k).applyMatrix4(o.matrixWorld);
        cx += v.x; cz += v.z;
      }
      cx /= 3; cz /= 3;
      if (cx >= lo && cx <= hiX && cz >= lo && cz <= hiZ) { keep[t] = 1; kept++; }
    }
    if (kept === triCount) { if (src !== o.geometry) src.dispose(); return; }
    removed += triCount - kept;

    if (kept === 0) { doomed.push(o); if (src !== o.geometry) src.dispose(); return; }

    const np = new Float32Array(kept * 9);
    const nu = uv  ? new Float32Array(kept * 6) : null;
    const nn = nrm ? new Float32Array(kept * 9) : null;
    let w = 0;
    for (let t = 0; t < triCount; t++) {
      if (!keep[t]) continue;
      for (let k = 0; k < 3; k++) {
        const s = t * 3 + k;
        np[w * 9 + k * 3]     = pos.getX(s);
        np[w * 9 + k * 3 + 1] = pos.getY(s);
        np[w * 9 + k * 3 + 2] = pos.getZ(s);
        if (nn) {
          nn[w * 9 + k * 3]     = nrm.getX(s);
          nn[w * 9 + k * 3 + 1] = nrm.getY(s);
          nn[w * 9 + k * 3 + 2] = nrm.getZ(s);
        }
        if (nu) {
          nu[w * 6 + k * 2]     = uv.getX(s);
          nu[w * 6 + k * 2 + 1] = uv.getY(s);
        }
      }
      w++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(np, 3));
    if (nn) g.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
    if (nu) g.setAttribute('uv', new THREE.BufferAttribute(nu, 2));
    if (!nn) g.computeVertexNormals();
    if (src !== o.geometry) src.dispose();
    o.geometry.dispose();
    o.geometry = g;
  });

  for (const o of doomed) {
    if (o.parent) o.parent.remove(o);
    if (o.geometry) o.geometry.dispose();
  }
  return { total, removed };
}

async function run() {
  const lat = parseFloat(document.getElementById('latInput').value);
  const lon = parseFloat(document.getElementById('lonInput').value);
  const km  = parseFloat(document.getElementById('rangeKm').value) || 1.0;
  const showBuildings = document.getElementById('toggleBuildings').checked;
  const vertExagInput = parseFloat(document.getElementById('vertExag').value) || 2.0;
  const photoSrc    = (document.getElementById('photoSource') || {}).value || 'auto';
  const customAerials = parseCustomAerialJson(
    (document.getElementById('customAerialJson') || {}).value || ''
  );
  const meshN       = parseInt(document.getElementById('meshDetail').value, 10) || 128;
  const usePlateau  = document.getElementById('togglePlateau').checked;

  if (isNaN(lat) || isNaN(lon)) { showError('緯度経度を入力してください'); return; }

  const bb = bboxFromCenter(lat, lon, km);

  // Vertical exaggeration conflicts with real-scale 3D city models: if the
  // terrain is stretched 2× but PLATEAU buildings are true-scale, the terrain
  // slopes twice as steeply as the buildings' base plane and they no longer
  // sit flush. When the AREA (not just the click point — boundary-straddling
  // maps load neighbouring wards too) touches a PLATEAU city with the toggle
  // on, force true scale (1×) so terrain + LOD2 share one vertical metric.
  // Buildings off ⇒ nothing to keep flush ⇒ honour the user's slider.
  const willTryPlateau = usePlateau && showBuildings
    && findPlateauCitiesForBbox(bb).length > 0;
  const vertExag = willTryPlateau ? 1.0 : vertExagInput;

  persistInputs();
  document.getElementById('runBtn').disabled = true;
  setExportEnabled(false);   // stale-scene export during the rebuild = partial ZIP
  showProgress(true);

  // Everything below runs inside try/finally: any uncaught throw (WebGL
  // context loss during texture upload, a geometry bug…) used to leave
  // runBtn disabled forever with the progress bar frozen — page reload
  // was the only way out.
  try {

  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);

  // ── Step 1: terrain elevation ──────────────────────────────────────────
  setProgress(0, '地形データ取得中…');
  let elevGrid;
  try {
    elevGrid = await fetchElevGridHiRes(bb, meshN, (p, label) => {
      setProgress(p * 0.4, label || '地形データ取得中…');
    });
  } catch (e) {
    showError('地形取得失敗: ' + e.message);
    return;
  }
  // elevGrid.length === meshN (kept here only as a sanity guard if the
  // backend ever decides to clamp differently for tiny bboxes).

  // ── Step 2: aerial photo ───────────────────────────────────────────────
  setProgress(0.4, '航空写真取得中…');
  const maxTextureEdge = parseInt(
    (document.getElementById('textureQuality') || {}).value || '8192', 10);
  let aerialTex;
  try {
    aerialTex = await fetchAerialPhoto(bb, PHOTO_ZOOM, (p, label) => {
      setProgress(0.4 + p * 0.3, label || '航空写真取得中…');
    }, { mode: photoSrc, customs: customAerials, maxTextureEdge });
  } catch (e) {
    showError('航空写真取得失敗: ' + e.message);
    return;
  }

  // ── Step 3: build 3D scene ─────────────────────────────────────────────
  setProgress(0.7, '3Dシーン構築中…');
  clearSceneObjects();
  currentTerrain = buildTerrain(elevGrid, meshN, xSize, zSize, aerialTex, vertExag);
  scene.add(currentTerrain);
  placeCameraOverTerrain(elevGrid, meshN, xSize, zSize, vertExag);
  // Size the sun's orthographic shadow frustum to this scene. Headroom
  // above the highest terrain point covers towers we haven't built yet.
  let maxElev = -Infinity;
  for (let r = 0; r < meshN; r++) for (let c = 0; c < meshN; c++) {
    if (elevGrid[r][c] > maxElev) maxElev = elevGrid[r][c];
  }
  fitSunToScene(xSize, zSize, maxElev * vertExag + 300);
  currentBuildings = null;
  currentFeatures = null;
  currentBuildingData = null;   // PLATEAU path leaves this null (no footprints)
  currentBB = bb;

  // ── Step 4: buildings + ground features ────────────────────────────────
  // Two parallel paths for buildings:
  //   - PLATEAU LOD2 (real roof shapes + textures) when the bbox is inside
  //     a known city and the user hasn't disabled the toggle.
  //   - OSM extrusion (worldwide fallback).
  // Ground features (roads/water/bridges/trees) always come from OSM.
  if (showBuildings) {
    setProgress(0.75, 'OSMデータ取得中（道路・水域・樹木）…');

    // Kick PLATEAU lookup in parallel with OSM. fetchPlateauForBbox
    // resolves EVERY city/ward whose bbox intersects the map area, not
    // just the click point's ward — a Tokyo-station map straddles the
    // Chiyoda/Chuo boundary and loading only Chiyoda left the whole
    // east half (Yaesu/Nihonbashi) without buildings.
    const plateauPromise = usePlateau
      ? fetchPlateauForBbox(bb).catch(e => { console.warn('PLATEAU lookup failed:', e); return null; })
      : Promise.resolve(null);

    // Optional neighbourhood wall-colour palette from the local
    // facade-palette server (server/facade-server.js — Mapillary street
    // imagery, colour statistics only). Fail-soft: any error just means
    // the procedural facades keep their default style palette.
    const facadeUrl = ((document.getElementById('facadeServerUrl') || {}).value || '').trim();
    const facadePromise = facadeUrl
      ? (async () => {
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 6000);
          try {
            const res = await fetch(
              `${facadeUrl.replace(/\/+$/, '')}/palette?lat=${lat}&lon=${lon}&radius=600`,
              { signal: ctrl.signal });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json();
            const pal = (Array.isArray(j.palette) ? j.palette : [])
              .map(h => parseInt(String(h).replace('#', ''), 16))
              .filter(Number.isFinite);
            if (pal.length) {
              console.log(`[FACADE] Mapillary palette: ${j.palette.join(' ')} (samples=${j.samples})`);
              return pal;
            }
            return null;
          } finally { clearTimeout(tid); }
        })().catch(e => { console.warn('[FACADE] palette fetch failed:', e.message); return null; })
      : Promise.resolve(null);

    // Optional CC0 photo-texture pack for facades (js/cc0textures.js).
    // Loaded in parallel with everything else; missing/slow URLs fall
    // back to the procedural canvas per material.
    const cc0On = !!(document.getElementById('toggleCc0Facades') || {}).checked;
    if (cc0On && typeof applyCc0CatalogOverride === 'function') {
      applyCc0CatalogOverride((document.getElementById('cc0OverrideJson') || {}).value || '');
    }
    const cc0Promise = cc0On && typeof preloadCc0Facades === 'function'
      ? preloadCc0Facades(null).catch(e => { console.warn('[CC0] preload failed:', e); return null; })
      : Promise.resolve(null);

    const [bRes, gRes, plateauPicks, facadePalette, cc0Walls] = await Promise.all([
      Promise.allSettled([fetchBuildings(bb)]).then(r => r[0]),
      Promise.allSettled([fetchGroundFeatures(bb)]).then(r => r[0]),
      plateauPromise,
      facadePromise,
      cc0Promise,
    ]);
    const bElems = bRes.status === 'fulfilled' ? bRes.value : [];
    const gElems = gRes.status === 'fulfilled' ? gRes.value : [];
    if (bRes.status === 'rejected') console.warn('建物取得失敗:', bRes.reason);
    if (gRes.status === 'rejected') console.warn('地物取得失敗:', gRes.reason);

    try {
      const feats = parseGroundFeatures(gElems, bb);
      const featGroup = new THREE.Group();
      featGroup.name = 'ground-features';
      featGroup.add(createWater(feats.waters, bb, elevGrid, meshN, vertExag));
      featGroup.add(createRoads(feats.roads, bb, elevGrid, meshN, vertExag));
      featGroup.add(createRailways(feats.rails, bb, elevGrid, meshN, vertExag));
      featGroup.add(createBridges(feats.bridges, bb, elevGrid, meshN, vertExag));
      featGroup.add(createTrees(feats.trees, feats.forests, bb, elevGrid, meshN, vertExag));
      scene.add(featGroup);
      currentFeatures = featGroup;   // for export

      // PLATEAU path
      let usedPlateau = false;
      if (plateauPicks && plateauPicks.length) {
        try {
          // pick.label is e.g. "LOD2 (textured)" or "LOD2 (no-texture)"
          // so the user can tell from the progress whether they're getting
          // the photo-textured variant (roof detail) or the white model.
          const cityNames = plateauPicks.map(p => p.city.name).join('・');
          const lodLabel = plateauPicks[0].label || plateauPicks[0].lod.toUpperCase();
          // Load every intersecting ward's tileset and merge under one
          // parent. Sequential, so the per-tileset concurrency cap (6)
          // stays the effective ceiling on parallel CDN requests.
          const plateauGroup = new THREE.Group();
          plateauGroup.name = 'plateau-merged';
          for (let k = 0; k < plateauPicks.length; k++) {
            const pick = plateauPicks[k];
            setProgress(0.80 + (k / plateauPicks.length) * 0.15,
              `PLATEAU ${pick.label || pick.lod} (${pick.city.name}) 読込中…`);
            try {
              const g = await loadPlateauBuildings(pick.url, bb, (p, label) =>
                setProgress(0.80 + ((k + p) / plateauPicks.length) * 0.15, label),
                { aerialTex, facadePalette, cc0Walls });
              if (g) plateauGroup.add(g);
            } catch (e) {
              console.warn(`PLATEAU ${pick.city.name} load failed:`, e);
            }
          }
          if (plateauGroup.children.length) {
            plateauGroup.updateMatrixWorld(true);

            // ── Cull geometry outside the requested area ──────────────────
            // A PLATEAU b3dm tile covers a whole district (~2 km) and a tile
            // is kept when its region merely TOUCHES the bbox, so a 1 km
            // request drags in buildings sprawling far past the map edge,
            // floating over no terrain.
            //
            // This used to test each MESH's bounding-box CENTRE, which is the
            // wrong granularity in both directions: a PLATEAU mesh is a whole
            // tile's worth of merged buildings (and after auto-texturing, the
            // entire city's roofs are one mesh), so a mesh straddling the edge
            // had every one of its in-map buildings deleted because its centre
            // happened to fall outside — while a mesh centred inside kept all
            // of its out-of-map sprawl. Cull per TRIANGLE instead: exact, and
            // independent of how the source happens to group its meshes.
            const MARGIN = 120;   // metres of slack beyond the map edge
            const culled = cullGeometryOutside(plateauGroup, xSize, zSize, MARGIN);
            if (culled.removed) {
              console.log(`[PLATEAU] culled ${culled.removed}/${culled.total} triangle(s) ` +
                `outside the ${km} km area`);
              plateauGroup.updateMatrixWorld(true);
            }

            // ── Vertical alignment ───────────────────────────────────────
            // PLATEAU's baked heights and our DEM disagree by a near-
            // constant offset (geoid vs ellipsoid; sign/size varies per
            // dataset — MEASURE it). One global Y shift aligns.
            //
            // Method: spatial grid (8 m bins) over the map; for each bin
            // keep the LOWEST sampled vertex Y of any mesh that touches
            // it. Each non-empty bin's min Y is necessarily a WALL-BOTTOM
            // (or basement) vertex of whatever building sits in that bin.
            // The shift is the median of (terrain(bin centre) − bin minY)
            // across non-empty bins.
            //   · Per-bin MIN ignores wall-side and roof vertices that
            //     dominate the global vertex count.
            //   · Per-bin sampling localises against the LOCAL terrain so
            //     hills don't bias the result.
            //   · Cross-bin MEDIAN ignores outlier bins (underground
            //     parking, basement-only patches, isolated tower roofs).
            // (Predecessors: centre-ray hit one tower roof, buried 174 m;
            // per-mesh bbox-mins included merged underground, floated 38 m;
            // ray-grid lowest-hits missed bottomless LOD2 walls, buried
            // 67 m; vertex-delta histogram MODE in downtown Tokyo locked
            // onto the dominant ~30 m-roof CLUSTER, buried 67 m again.)
            const BIN = 8;   // metres
            const nx = Math.max(1, Math.ceil(xSize / BIN));
            const nz = Math.max(1, Math.ceil(zSize / BIN));
            const binMin = new Float32Array(nx * nz);
            binMin.fill(Infinity);
            const _v = new THREE.Vector3();
            let sampled = 0;
            plateauGroup.traverse(o => {
              if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
              const pos = o.geometry.attributes.position;
              // Iterate every vertex — per-bin min is robust to dense
              // sampling but degrades if we miss the wall-bottom corner.
              for (let i = 0; i < pos.count; i++) {
                _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
                if (_v.x < 0 || _v.x > xSize || _v.z < 0 || _v.z > zSize) continue;
                const bx = Math.min(nx - 1, Math.floor(_v.x / BIN));
                const bz = Math.min(nz - 1, Math.floor(_v.z / BIN));
                const k = bz * nx + bx;
                if (_v.y < binMin[k]) binMin[k] = _v.y;
                sampled++;
              }
            });
            const deltas = [];
            for (let bz = 0; bz < nz; bz++) {
              for (let bx = 0; bx < nx; bx++) {
                const k = bz * nx + bx;
                const yMin = binMin[k];
                if (!isFinite(yMin)) continue;
                const cx = (bx + 0.5) * BIN, cz = (bz + 0.5) * BIN;
                const terrainY = getElevAt(elevGrid, meshN,
                  Math.min(1, cx / xSize), Math.min(1, cz / zSize)) * vertExag;
                const d = terrainY - yMin;
                // Plausibility filter: geoid undulation is within ±110 m
                // anywhere on Earth; allow some basement slack.
                if (d > -150 && d < 60) deltas.push(d);
              }
            }
            let shift = null;
            if (deltas.length) {
              deltas.sort((a, b) => a - b);
              shift = deltas[deltas.length >> 1];
            } else {
              // Degenerate — fall back to bbox bottom vs centre terrain.
              const box = new THREE.Box3().setFromObject(plateauGroup);
              const terrainCenterY = getElevAt(elevGrid, meshN, 0.5, 0.5) * vertExag;
              if (isFinite(box.min.y)) shift = terrainCenterY - box.min.y;
            }
            if (shift != null && Math.abs(shift) < 2000) {
              plateauGroup.position.y += shift;
              console.log(`[PLATEAU] vertical align shift = ${shift.toFixed(1)} m ` +
                `(median over ${deltas.length} bins, ${sampled} verts)`);
            }
            scene.add(plateauGroup);
            currentBuildings = plateauGroup;
            usedPlateau = true;
            setProgress(0.96, `✨ PLATEAU ${lodLabel} ${cityNames} で表示中`);
          }
        } catch (e) {
          console.warn('PLATEAU load failed, falling back to OSM:', e);
        }
      }

      // OSM fallback (or primary path outside Japan)
      if (!usedPlateau) {
        setProgress(0.88, '建物3D生成中（OSM）…');
        const parsed = parseBuildings(bElems, bb);
        currentBuildings = createBuildingGroup(parsed, bb, elevGrid, meshN, vertExag, { aerialTex, facadePalette, cc0Walls });
        currentBuildingData = parsed;   // for click-to-inspect
        currentBB = bb;
        scene.add(currentBuildings);
        const failNote = (bRes.status === 'rejected' || gRes.status === 'rejected')
          ? ' ⚠️ 一部のOSMデータ取得失敗' : '';
        const plateauNote = !usePlateau ? ''
                          : (findPlateauCitiesForBbox(bb).length === 0 ? ' (PLATEAU圏外)' : ' (PLATEAUデータ無し)');
        setProgress(0.96,
          `建物 ${parsed.length} 棟・道路 ${feats.roads.length}・橋 ${feats.bridges.length}・水域 ${feats.waters.length}・樹木 ${feats.trees.length} を生成${plateauNote}${failNote}`
        );
      }
    } catch (e) {
      console.warn('ジオメトリ生成失敗:', e);
    }
  }

  // Fill the bar but KEEP the last label — it's the only place that tells
  // the user whether they got PLATEAU or OSM (and any ⚠️ partial-failure
  // note). Overwriting it with 完了 in the same tick made it unreadable.
  document.getElementById('progressBar').style.width = '100%';
  scheduleProgressHide(4000);

  } catch (e) {
    console.error('run() failed:', e);
    showError('生成失敗: ' + (e.message || e));
  } finally {
    document.getElementById('runBtn').disabled = false;
    // Re-enable export/share/screenshot even when the run threw. These
    // were only re-enabled on the success path, so a single failed
    // generate left 保存 / 共有URL / スクショ greyed out for the rest of
    // the session with no way back short of a page reload — and after a
    // partial failure there is usually still a scene worth exporting.
    setExportEnabled(!!currentTerrain);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initScene(document.getElementById('glCanvas'));
  initMap();
  restoreInputs();
  // A share-link hash overrides the saved localStorage state.
  const fromHash = applyHashState();
  if (fromHash) {
    const lat = parseFloat(document.getElementById('latInput').value);
    const lon = parseFloat(document.getElementById('lonInput').value);
    if (isFinite(lat) && isFinite(lon)) setCenter(lat, lon);
  }

  document.getElementById('runBtn').addEventListener('click', () => {
    // On mobile the sidebar is a drawer over the view — close it so the
    // user sees the result after hitting generate.
    document.body.classList.remove('menu-open');
    run();
  });

  // Hamburger drawer toggle (mobile only; the button is display:none on
  // desktop via CSS).
  const menuToggle = document.getElementById('menuToggle');
  if (menuToggle) menuToggle.addEventListener('click', () =>
    document.body.classList.toggle('menu-open'));

  // Share — copy a reproducible URL to the clipboard.
  document.getElementById('shareBtn').addEventListener('click', async () => {
    const url = buildShareUrl();
    history.replaceState(null, '', url);  // reflect in the address bar too
    try {
      await navigator.clipboard.writeText(url);
      showStatus('🔗 共有URLをクリップボードにコピーしました');
    } catch {
      showStatus('URL をアドレスバーに反映しました（コピー権限なし）');
    }
  });

  // Screenshot — download the current canvas as PNG.
  document.getElementById('shotBtn').addEventListener('click', downloadScreenshot);

  // Click-to-inspect on the 3D canvas. A small drag = orbit (ignore);
  // a click = inspect. Track pointer movement to tell them apart.
  const canvas = document.getElementById('glCanvas');
  let downX = 0, downY = 0;
  canvas.addEventListener('pointerdown', e => { downX = e.clientX; downY = e.clientY; });
  canvas.addEventListener('pointerup', e => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // was a drag
    const info = pickBuildingInfo(e.clientX, e.clientY);
    showBuildingInfo(info);
  });
  // Click the info panel to dismiss it.
  document.getElementById('buildingInfo').addEventListener('click', () => showBuildingInfo(null));

  document.getElementById('exportBtn').addEventListener('click', async () => {
    const btn = document.getElementById('exportBtn');
    const select = document.getElementById('exportFormat');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ ZIP…';
    try {
      const lat = parseFloat(document.getElementById('latInput').value);
      const lon = parseFloat(document.getElementById('lonInput').value);
      const name = `openEarth3D_${lat.toFixed(4)}_${lon.toFixed(4)}`;
      await exportScene(select.value, currentTerrain, currentBuildings, name, currentFeatures);
    } catch (e) {
      showError('エクスポート失敗: ' + e.message);
      console.error(e);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  document.getElementById('locBtn').addEventListener('click', () => {
    if (!navigator.geolocation) { showError('Geolocation not supported'); return; }
    navigator.geolocation.getCurrentPosition(
      pos => setCenter(pos.coords.latitude, pos.coords.longitude),
      () => showError('位置情報の取得に失敗しました')
    );
  });

  document.getElementById('rangeKm').addEventListener('input', function () {
    document.getElementById('kmLabel').textContent = parseFloat(this.value).toFixed(1) + ' km';
  });

  document.getElementById('vertExag').addEventListener('input', function () {
    document.getElementById('exagLabel').textContent = parseFloat(this.value).toFixed(1) + 'x';
  });

  document.getElementById('timeOfDay').addEventListener('input', function () {
    const h = parseFloat(this.value);
    updateHourLabel(h);
    setTimeOfDay(h);
    persistInputs();
  });

  // Defensive: skip wiring if the element isn't in the DOM. Common cause
  // for a NullRef here is a stale browser cache loading an old index.html.
  const on = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
  };
  on('photoSource', 'change', persistInputs);
  on('textureQuality', 'change', persistInputs);
  on('customAerialJson', 'input', () => { validateCustomAerialJson(); persistInputs(); });
  on('presetSourceBtn', 'click', () => {
    const el = document.getElementById('customAerialJson');
    if (!el) return;
    el.value = AERIAL_PRESETS_JSON;
    validateCustomAerialJson();
    persistInputs();
  });
  on('clearSourceBtn', 'click', () => {
    const el = document.getElementById('customAerialJson');
    if (!el) return;
    el.value = '';
    validateCustomAerialJson();
    persistInputs();
  });

  document.querySelectorAll('[data-lat]').forEach(btn => {
    btn.addEventListener('click', () => {
      setCenter(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lon));
    });
  });
});
