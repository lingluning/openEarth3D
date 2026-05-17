'use strict';

const GRID_N = 32;
const PHOTO_ZOOM = 17;

let leafletMap, leafletMarker;

function initMap() {
  leafletMap = L.map('minimap').setView([35.6812, 139.7671], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(leafletMap);

  leafletMap.on('click', e => {
    setCenter(e.latlng.lat, e.latlng.lng);
  });
}

function setCenter(lat, lon) {
  const kmVal = parseFloat(document.getElementById('rangeKm').value) || 1.0;
  bboxFromCenter(lat, lon, kmVal); // validate

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

function showProgress(visible) {
  document.getElementById('progressWrap').style.display = visible ? 'flex' : 'none';
}

async function run() {
  const lat = parseFloat(document.getElementById('latInput').value);
  const lon = parseFloat(document.getElementById('lonInput').value);
  const km  = parseFloat(document.getElementById('rangeKm').value) || 1.0;
  const showBuildings = document.getElementById('toggleBuildings').checked;
  const vertExag = parseFloat(document.getElementById('vertExag').value) || 2.0;

  if (isNaN(lat) || isNaN(lon)) { alert('緯度経度を入力してください'); return; }

  document.getElementById('runBtn').disabled = true;
  showProgress(true);
  setProgress(0, '地形データ取得中…');

  const bb = bboxFromCenter(lat, lon, km);
  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);

  let elevGrid;
  try {
    elevGrid = await fetchElevGrid(bb, GRID_N, p => setProgress(p * 0.4, '地形データ取得中…'));
  } catch (e) {
    alert('地形データ取得失敗: ' + e.message);
    document.getElementById('runBtn').disabled = false;
    showProgress(false);
    return;
  }

  setProgress(0.4, '航空写真取得中…');
  let photoUrl;
  try {
    photoUrl = await fetchAerialPhoto(bb, PHOTO_ZOOM, p => setProgress(0.4 + p * 0.3, '航空写真取得中…'));
  } catch (e) {
    alert('航空写真取得失敗: ' + e.message);
    document.getElementById('runBtn').disabled = false;
    showProgress(false);
    return;
  }

  setProgress(0.7, '3Dシーン構築中…');
  clearSceneObjects();

  const terrainMesh = buildTerrain(elevGrid, GRID_N, xSize, zSize, photoUrl, vertExag);
  scene.add(terrainMesh);
  placeCameraOverTerrain(elevGrid, GRID_N, xSize, zSize, vertExag);

  if (showBuildings) {
    setProgress(0.75, '建物データ取得中…');
    try {
      const elements = await fetchBuildings(bb);
      setProgress(0.88, '建物3D生成中…');
      const parsed = parseBuildings(elements, bb);
      const group = createBuildingGroup(parsed, bb, elevGrid, GRID_N, vertExag);
      scene.add(group);
    } catch (e) {
      console.warn('建物取得失敗:', e);
    }
  }

  setProgress(1.0, '完了');
  setTimeout(() => showProgress(false), 800);
  document.getElementById('runBtn').disabled = false;
}

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('glCanvas');
  initScene(canvas);
  initMap();

  document.getElementById('runBtn').addEventListener('click', run);

  document.getElementById('locBtn').addEventListener('click', () => {
    if (!navigator.geolocation) { alert('Geolocation not supported'); return; }
    navigator.geolocation.getCurrentPosition(pos => {
      setCenter(pos.coords.latitude, pos.coords.longitude);
    }, () => alert('位置情報の取得に失敗しました'));
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
