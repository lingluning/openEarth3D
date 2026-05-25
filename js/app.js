'use strict';

// Mesh density is now user-selectable (see #meshDetail); DEM zoom is
// picked automatically inside fetchElevGridHiRes so that one DEM pixel
// ≈ one grid cell at the chosen density.
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
      meshDetail: document.getElementById('meshDetail').value,
      hour: document.getElementById('timeOfDay').value,
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
    if (v.meshDetail) document.getElementById('meshDetail').value = v.meshDetail;
    if (v.hour != null) {
      const slider = document.getElementById('timeOfDay');
      slider.value = v.hour;
      updateHourLabel(v.hour);
      if (typeof setTimeOfDay === 'function') setTimeOfDay(parseFloat(v.hour));
    }
  } catch {}
}

function updateHourLabel(h) {
  const v = parseFloat(h);
  const hh = String(Math.floor(v)).padStart(2, '0');
  const mm = String(Math.round((v - Math.floor(v)) * 60)).padStart(2, '0');
  document.getElementById('hourLabel').textContent = `${hh}:${mm}`;
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
  const meshN       = parseInt(document.getElementById('meshDetail').value, 10) || 128;

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

  // ── Step 4: buildings + ground features ────────────────────────────────
  // Both OSM queries run in parallel; the roads/water/trees layer is light
  // enough that it almost always finishes before the buildings.
  if (showBuildings) {
    setProgress(0.75, 'OSMデータ取得中（建物・道路・水域）…');
    try {
      const [bElems, gElems] = await Promise.all([
        fetchBuildings(bb),
        fetchGroundFeatures(bb).catch(() => []),
      ]);

      // Ground features first so buildings draw on top (they're taller and
      // shouldn't be blocked by water transparency).
      const feats = parseGroundFeatures(gElems, bb);
      const featGroup = new THREE.Group();
      featGroup.name = 'ground-features';
      featGroup.add(createWater(feats.waters, bb, elevGrid, meshN, vertExag));
      featGroup.add(createRoads(feats.roads, bb, elevGrid, meshN, vertExag));
      featGroup.add(createTrees(feats.trees, feats.forests, bb, elevGrid, meshN, vertExag));
      scene.add(featGroup);

      setProgress(0.88, '建物3D生成中…');
      const parsed = parseBuildings(bElems, bb);
      currentBuildings = createBuildingGroup(parsed, bb, elevGrid, meshN, vertExag);
      scene.add(currentBuildings);
      setProgress(0.96,
        `建物 ${parsed.length} 棟・道路 ${feats.roads.length}・水域 ${feats.waters.length}・樹木 ${feats.trees.length} を生成`
      );
    } catch (e) {
      console.warn('OSM取得失敗:', e);
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

  document.querySelectorAll('[data-lat]').forEach(btn => {
    btn.addEventListener('click', () => {
      setCenter(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lon));
    });
  });
});
