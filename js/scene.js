'use strict';

let renderer, scene, camera, controls, animId;

function initScene(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  // Filmic tone mapping flattens out blown highlights on bright aerial
  // imagery and makes shaded sides of buildings read more naturally.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.FogExp2(0xc8e8f8, 0.00025);

  camera = new THREE.PerspectiveCamera(50, 1, 1, 10000);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 15;
  controls.maxDistance = 6000;
  controls.maxPolarAngle = Math.PI / 2 - 0.01;

  // hemisphere sky/ground light
  scene.add(new THREE.HemisphereLight(0xc8e8ff, 0x886644, 0.65));
  // main sun — warmer, slightly stronger to compensate for tone mapping
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.45);
  sun.position.set(600, 900, 400);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 4000;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -1500;
  sun.shadow.camera.right = sun.shadow.camera.top = 1500;
  sun.shadow.bias = -0.0003;
  scene.add(sun);
  // soft fill from opposite side
  const fill = new THREE.DirectionalLight(0x9ab8d8, 0.4);
  fill.position.set(-400, 300, -200);
  scene.add(fill);

  window.addEventListener('resize', onResize);
  onResize();
  startLoop();
}

function onResize() {
  const el = renderer.domElement.parentElement;
  const w = el.clientWidth || window.innerWidth;
  const h = el.clientHeight || (window.innerHeight - 44);
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function startLoop() {
  if (animId != null) cancelAnimationFrame(animId);
  (function loop() {
    animId = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();
}

function clearSceneObjects() {
  const toRemove = [];
  scene.traverse(obj => {
    if (obj !== scene && !(obj instanceof THREE.Light)) toRemove.push(obj);
  });
  toRemove.forEach(obj => {
    scene.remove(obj);
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
    }
  });
  // Material/texture caches in buildings.js point at GPU resources we just
  // disposed; let them be rebuilt fresh on the next run.
  if (typeof resetBuildingCaches === 'function') resetBuildingCaches();
}

function buildTerrain(grid, n, xSize, zSize, texDataUrl, vertExag) {
  const geo = new THREE.PlaneGeometry(xSize, zSize, n - 1, n - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const c = i % n, r = Math.floor(i / n);
    pos.setY(i, grid[r][c] * vertExag);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  const tex = new THREE.TextureLoader().load(texDataUrl);
  tex.encoding = THREE.sRGBEncoding;
  tex.name = 'aerial';
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  mat.name = 'terrain';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.position.set(xSize / 2, 0, zSize / 2);
  return mesh;
}

function placeCameraOverTerrain(grid, n, xSize, zSize, vertExag) {
  const cx = xSize / 2, cz = zSize / 2;
  const midElev = grid[Math.floor(n / 2)][Math.floor(n / 2)] * vertExag;
  const span = Math.max(xSize, zSize);
  // 45° oblique view from south-east, looking north-west — shows terrain + buildings
  camera.position.set(
    cx + span * 0.45,
    midElev + span * 0.52,
    cz + span * 0.65
  );
  controls.target.set(cx, midElev + 10, cz);
  controls.update();
}
