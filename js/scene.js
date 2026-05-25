'use strict';

let renderer, scene, camera, controls, animId;
let sky, sun, hemiLight, fillLight, composer;
let _currentHour = 13.5; // local solar hour; updated by setTimeOfDay()

function initScene(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.physicallyCorrectLights = true;

  scene = new THREE.Scene();
  // Sky and fog colour follow the sun — both updated by setTimeOfDay().
  scene.fog = new THREE.FogExp2(0xc8e8f8, 0.00022);

  camera = new THREE.PerspectiveCamera(50, 1, 1, 10000);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 15;
  controls.maxDistance = 6000;
  controls.maxPolarAngle = Math.PI / 2 - 0.01;

  // Physical sky (Hosek-Wilkie atmospheric scattering).
  sky = new THREE.Sky();
  sky.scale.setScalar(450000);
  const u = sky.material.uniforms;
  u.turbidity.value = 4.0;
  u.rayleigh.value = 2.0;
  u.mieCoefficient.value = 0.005;
  u.mieDirectionalG.value = 0.8;
  scene.add(sky);

  hemiLight = new THREE.HemisphereLight(0xc8e8ff, 0x4a4030, 0.45);
  scene.add(hemiLight);

  sun = new THREE.DirectionalLight(0xffffff, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 6000;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -1800;
  sun.shadow.camera.right = sun.shadow.camera.top = 1800;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.4;
  scene.add(sun);
  scene.add(sun.target);

  fillLight = new THREE.DirectionalLight(0xa0c0e0, 0.4);
  fillLight.position.set(-400, 300, -200);
  scene.add(fillLight);

  setTimeOfDay(_currentHour); // initialise sun + sky tint

  // Post-processing: render-pass + bloom for highlights + SSAO for crevices.
  // Effects are wired in initComposer() lazily once we know the canvas size.
  initComposer();

  window.addEventListener('resize', onResize);
  onResize();
  startLoop();
}

function initComposer() {
  if (typeof THREE.EffectComposer !== 'function') return;
  composer = new THREE.EffectComposer(renderer);
  composer.addPass(new THREE.RenderPass(scene, camera));

  if (typeof THREE.UnrealBloomPass === 'function') {
    const bloom = new THREE.UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.35,  // strength — subtle, only glassy reflections / sun glints
      0.85,  // radius
      0.92   // threshold (only the brightest pixels bloom)
    );
    composer.addPass(bloom);
  }
}

// Update sun direction, intensity and sky/fog tint based on local solar
// hour. 0..24, 6 = sunrise on horizon east, 18 = sunset on horizon west.
function setTimeOfDay(hour) {
  _currentHour = hour;
  if (!sun || !sky) return;

  // theta = angle above horizon, phi = azimuth.
  // Sun arcs from east (phi=π/2) through south (phi=π) to west (phi=3π/2)
  // for a northern-hemisphere observer.
  const t = (hour - 6) / 12;              // 0 at sunrise, 1 at sunset
  const theta = Math.PI * t;              // 0..π over the day
  const elev = Math.sin(theta);           // -1..1
  const azim = Math.PI * (0.5 + t);       // east → south → west

  const dist = 4000;
  const cosE = Math.cos(theta);           // east-west component
  const sunPos = new THREE.Vector3(
    dist * cosE * Math.cos(azim - Math.PI/2),
    dist * elev,
    dist * cosE * Math.sin(azim - Math.PI/2)
  );
  sun.position.copy(sunPos);
  sun.target.position.set(0, 0, 0);
  sky.material.uniforms.sunPosition.value.copy(sunPos);

  // Sun colour and intensity vs. elevation. Below horizon → blue moonlight.
  if (elev > 0.02) {
    const warm = Math.pow(1 - Math.max(0, elev), 2); // 0 at noon, 1 at horizon
    sun.color.setRGB(
      1.0,
      0.85 + 0.15 * (1 - warm),
      0.55 + 0.45 * (1 - warm)
    );
    sun.intensity = 0.6 + 2.8 * Math.max(0, elev);
    hemiLight.intensity = 0.35 + 0.4 * elev;
    hemiLight.color.setRGB(0.78 + 0.22*(1-warm), 0.91, 1.0);
  } else {
    sun.color.setRGB(0.4, 0.5, 0.7);
    sun.intensity = 0.05;
    hemiLight.intensity = 0.15;
    hemiLight.color.setRGB(0.3, 0.4, 0.6);
  }

  // Fog colour follows the lit sky: blue at midday, warm at golden hour,
  // dark blue at night.
  const fogR = Math.max(0.04, 0.25 + 0.75 * Math.max(0, elev) - 0.3 * Math.pow(1-elev, 2));
  const fogG = Math.max(0.05, 0.35 + 0.55 * Math.max(0, elev));
  const fogB = Math.max(0.08, 0.45 + 0.45 * Math.max(0, elev));
  scene.fog.color.setRGB(fogR, fogG, fogB);
  renderer.setClearColor(scene.fog.color);
}

function onResize() {
  const el = renderer.domElement.parentElement;
  const w = el.clientWidth || window.innerWidth;
  const h = el.clientHeight || (window.innerHeight - 44);
  renderer.setSize(w, h);
  if (composer) composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function startLoop() {
  if (animId != null) cancelAnimationFrame(animId);
  (function loop() {
    animId = requestAnimationFrame(loop);
    controls.update();
    if (composer) composer.render();
    else renderer.render(scene, camera);
  })();
}

function clearSceneObjects() {
  const protect = new Set([sky, sun, sun && sun.target, hemiLight, fillLight].filter(Boolean));
  const toRemove = [];
  scene.traverse(obj => {
    if (obj === scene) return;
    if (protect.has(obj)) return;
    if (obj instanceof THREE.Light) return;
    toRemove.push(obj);
  });
  toRemove.forEach(obj => {
    scene.remove(obj);
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
    }
  });
  if (typeof resetBuildingCaches === 'function') resetBuildingCaches();
}

// Build a terrain LOD with 4 vertex-density levels (see commit d08cde4).
function buildTerrain(grid, n, xSize, zSize, texDataUrl, vertExag) {
  const tex = new THREE.TextureLoader().load(texDataUrl);
  tex.encoding = THREE.sRGBEncoding;
  tex.name = 'aerial';
  // MeshStandardMaterial picks up sky lighting via PBR; roughness keeps it
  // non-reflective so the aerial-photo texture reads cleanly.
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0.0 });
  mat.name = 'terrain';

  const span = Math.max(xSize, zSize);
  const stops = [
    { sub: n,                       dist: 0 },
    { sub: Math.max(2, n >> 1),     dist: span * 0.4 },
    { sub: Math.max(2, n >> 2),     dist: span * 1.0 },
    { sub: Math.max(2, n >> 3),     dist: span * 2.0 },
  ];

  const lod = new THREE.LOD();
  let fullDetail = null;
  for (const s of stops) {
    const mesh = new THREE.Mesh(_terrainGeo(grid, n, s.sub, xSize, zSize, vertExag), mat);
    mesh.receiveShadow = true;
    lod.addLevel(mesh, s.dist);
    if (fullDetail === null) fullDetail = mesh;
  }
  lod.position.set(xSize / 2, 0, zSize / 2);
  lod.userData.fullDetail = fullDetail;
  return lod;
}

function _terrainGeo(grid, n, sub, xSize, zSize, vertExag) {
  const geo = new THREE.PlaneGeometry(xSize, zSize, sub - 1, sub - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const step = (n - 1) / (sub - 1);
  for (let i = 0; i < pos.count; i++) {
    const c = i % sub, r = (i / sub) | 0;
    const gc = Math.round(c * step), gr = Math.round(r * step);
    pos.setY(i, grid[gr][gc] * vertExag);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function placeCameraOverTerrain(grid, n, xSize, zSize, vertExag) {
  const cx = xSize / 2, cz = zSize / 2;
  const midElev = grid[Math.floor(n / 2)][Math.floor(n / 2)] * vertExag;
  const span = Math.max(xSize, zSize);
  camera.position.set(
    cx + span * 0.45,
    midElev + span * 0.52,
    cz + span * 0.65
  );
  controls.target.set(cx, midElev + 10, cz);
  controls.update();

  // Aim the sun's shadow camera at the new terrain centre so the shadow
  // map covers what we actually look at.
  if (sun) {
    sun.target.position.set(cx, midElev, cz);
    sun.target.updateMatrixWorld();
  }
}
