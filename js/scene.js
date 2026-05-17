'use strict';

let renderer, scene, camera, controls, animId;

function initScene(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, 1200, 4000);

  camera = new THREE.PerspectiveCamera(55, 1, 1, 8000);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 20;
  controls.maxDistance = 5000;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;

  // ambient + directional sun
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xfff8e7, 1.1);
  sun.position.set(500, 800, 300);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 3000;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -1200;
  sun.shadow.camera.right = sun.shadow.camera.top = 1200;
  scene.add(sun);

  window.addEventListener('resize', onResize);
  onResize();
  startLoop();
}

function onResize() {
  const el = renderer.domElement.parentElement;
  const w = el.clientWidth || window.innerWidth;
  const h = el.clientHeight || window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function startLoop() {
  if (animId != null) cancelAnimationFrame(animId);
  function loop() {
    animId = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  }
  loop();
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
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
}

// vertExag: vertical exaggeration factor (1 = real scale, 2-3 = helps flat areas look 3D)
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
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.position.set(xSize / 2, 0, zSize / 2);
  return mesh;
}

function placeCameraOverTerrain(grid, n, xSize, zSize, vertExag) {
  const cx = xSize / 2, cz = zSize / 2;
  const midElev = grid[Math.floor(n / 2)][Math.floor(n / 2)] * vertExag;
  const span = Math.max(xSize, zSize);
  // oblique 45-degree view from south-east, looking north-west
  camera.position.set(
    cx + span * 0.4,
    midElev + span * 0.55,
    cz + span * 0.6
  );
  controls.target.set(cx, midElev + span * 0.02, cz);
  controls.update();
}
