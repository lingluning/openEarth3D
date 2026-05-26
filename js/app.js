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
let currentTerrain = null, currentBuildings = null;

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
}

// Show a transient error in the progress label instead of a blocking alert.
function showError(msg) {
  const label = document.getElementById('progressLabel');
  if (label) {
    label.textContent = '❌ ' + msg;
    label.style.color = '#ff8a8a';
    setTimeout(() => { label.style.color = ''; }, 6000);
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
  for (const id of ['exportBtn', 'exportFormat']) {
    const el = document.getElementById(id);
    el.disabled = !enabled;
    el.style.opacity = enabled ? '1' : '.5';
  }
}

async function run() {
  const lat = parseFloat(document.getElementById('latInput').value);
  const lon = parseFloat(document.getElementById('lonInput').value);
  const km  = parseFloat(document.getElementById('rangeKm').value) || 1.0;
  const showBuildings = document.getElementById('toggleBuildings').checked;
  const vertExag   = parseFloat(document.getElementById('vertExag').value) || 2.0;
  const photoSrc    = (document.getElementById('photoSource') || {}).value || 'auto';
  const customAerials = parseCustomAerialJson(
    (document.getElementById('customAerialJson') || {}).value || ''
  );
  const meshN       = parseInt(document.getElementById('meshDetail').value, 10) || 128;
  const usePlateau  = document.getElementById('togglePlateau').checked;

  if (isNaN(lat) || isNaN(lon)) { showError('緯度経度を入力してください'); return; }

  persistInputs();
  document.getElementById('runBtn').disabled = true;
  showProgress(true);

  const bb = bboxFromCenter(lat, lon, km);
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
    document.getElementById('runBtn').disabled = false;
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
    document.getElementById('runBtn').disabled = false;
    return;
  }

  // ── Step 3: build 3D scene ─────────────────────────────────────────────
  setProgress(0.7, '3Dシーン構築中…');
  clearSceneObjects();
  currentTerrain = buildTerrain(elevGrid, meshN, xSize, zSize, aerialTex, vertExag);
  scene.add(currentTerrain);
  placeCameraOverTerrain(elevGrid, meshN, xSize, zSize, vertExag);
  currentBuildings = null;

  // ── Step 4: buildings + ground features ────────────────────────────────
  // Two parallel paths for buildings:
  //   - PLATEAU LOD2 (real roof shapes + textures) when the bbox is inside
  //     a known city and the user hasn't disabled the toggle.
  //   - OSM extrusion (worldwide fallback).
  // Ground features (roads/water/bridges/trees) always come from OSM.
  if (showBuildings) {
    setProgress(0.75, 'OSMデータ取得中（道路・水域・樹木）…');

    // Kick PLATEAU lookup in parallel with OSM so we don't pay the wait
    // serially. If PLATEAU is disabled or there's no coverage we just
    // skip the await and use OSM buildings.
    const plateauCity = usePlateau ? findPlateauCity(lat, lon) : null;
    const plateauPromise = plateauCity
      ? fetchPlateauTilesetUrl(plateauCity.code).catch(e => { console.warn('PLATEAU lookup failed:', e); return null; })
      : Promise.resolve(null);

    const [bRes, gRes, tilesetUrl] = await Promise.all([
      Promise.allSettled([fetchBuildings(bb)]).then(r => r[0]),
      Promise.allSettled([fetchGroundFeatures(bb)]).then(r => r[0]),
      plateauPromise,
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
      featGroup.add(createBridges(feats.bridges, bb, elevGrid, meshN, vertExag));
      featGroup.add(createTrees(feats.trees, feats.forests, bb, elevGrid, meshN, vertExag));
      scene.add(featGroup);

      // PLATEAU path
      let usedPlateau = false;
      if (tilesetUrl) {
        try {
          setProgress(0.80, `PLATEAU LOD2 (${plateauCity.name}) 読込中…`);
          const plateauGroup = await loadPlateauBuildings(tilesetUrl, bb,
            (p, label) => setProgress(0.80 + p * 0.15, label));
          if (plateauGroup) {
            scene.add(plateauGroup);
            currentBuildings = plateauGroup;
            usedPlateau = true;
            setProgress(0.96, `✨ PLATEAU LOD2 ${plateauCity.name} で表示中`);
          }
        } catch (e) {
          console.warn('PLATEAU load failed, falling back to OSM:', e);
        }
      }

      // OSM fallback (or primary path outside Japan)
      if (!usedPlateau) {
        setProgress(0.88, '建物3D生成中（OSM）…');
        const parsed = parseBuildings(bElems, bb);
        currentBuildings = createBuildingGroup(parsed, bb, elevGrid, meshN, vertExag);
        scene.add(currentBuildings);
        const failNote = (bRes.status === 'rejected' || gRes.status === 'rejected')
          ? ' ⚠️ 一部のOSMデータ取得失敗' : '';
        const plateauNote = (usePlateau && !plateauCity) ? ' (PLATEAU圏外)'
                          : (usePlateau && plateauCity && !tilesetUrl) ? ' (PLATEAUデータ無し)'
                          : '';
        setProgress(0.96,
          `建物 ${parsed.length} 棟・道路 ${feats.roads.length}・橋 ${feats.bridges.length}・水域 ${feats.waters.length}・樹木 ${feats.trees.length} を生成${plateauNote}${failNote}`
        );
      }
    } catch (e) {
      console.warn('ジオメトリ生成失敗:', e);
    }
  }

  setProgress(1.0, '完了');
  setTimeout(() => showProgress(false), 1000);
  document.getElementById('runBtn').disabled = false;
  setExportEnabled(true);
}

document.addEventListener('DOMContentLoaded', () => {
  initScene(document.getElementById('glCanvas'));
  initMap();
  restoreInputs();

  document.getElementById('runBtn').addEventListener('click', run);

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
      await exportScene(select.value, currentTerrain, currentBuildings, name);
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
