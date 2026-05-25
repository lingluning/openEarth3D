'use strict';

// 128×128 mesh using DEM PNG tiles → ~10m resolution, comparable to Google Earth
const GRID_N     = 128;
const PHOTO_ZOOM = 19; // ESRI supports zoom 19 (~30cm/px); GSI caps at 18 (~60cm/px)
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
  } catch {}
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
  const photoSrc    = document.getElementById('photoSource').value;

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
    elevGrid = await fetchElevGridHiRes(bb, GRID_N, (p, label) => {
      setProgress(p * 0.4, label || '地形データ取得中…');
    });
  } catch (e) {
    showError('地形取得失敗: ' + e.message);
    document.getElementById('runBtn').disabled = false;
    return;
  }
  const meshN = elevGrid.length;

  // ── Step 2: aerial photo ───────────────────────────────────────────────
  setProgress(0.4, '航空写真取得中…');
  let photoUrl;
  try {
    photoUrl = await fetchAerialPhoto(bb, PHOTO_ZOOM, (p, label) => {
      setProgress(0.4 + p * 0.3, label || '航空写真取得中…');
    }, photoSrc);
  } catch (e) {
    showError('航空写真取得失敗: ' + e.message);
    document.getElementById('runBtn').disabled = false;
    return;
  }

  // ── Step 3: build 3D scene ─────────────────────────────────────────────
  setProgress(0.7, '3Dシーン構築中…');
  clearSceneObjects();
  currentTerrain = buildTerrain(elevGrid, meshN, xSize, zSize, photoUrl, vertExag);
  scene.add(currentTerrain);
  placeCameraOverTerrain(elevGrid, meshN, xSize, zSize, vertExag);
  currentBuildings = null;

  // ── Step 4: buildings ──────────────────────────────────────────────────
  if (showBuildings) {
    setProgress(0.75, '建物データ取得中（OSM）…');
    try {
      const elements = await fetchBuildings(bb);
      setProgress(0.88, '建物3D生成中…');
      const parsed = parseBuildings(elements, bb);
      currentBuildings = createBuildingGroup(parsed, bb, elevGrid, meshN, vertExag);
      scene.add(currentBuildings);
      setProgress(0.96, `建物 ${parsed.length} 棟を生成`);
    } catch (e) {
      console.warn('建物取得失敗:', e);
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

  document.querySelectorAll('[data-lat]').forEach(btn => {
    btn.addEventListener('click', () => {
      setCenter(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lon));
    });
  });
});
