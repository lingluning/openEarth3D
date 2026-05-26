'use strict';

let renderer, scene, camera, controls, animId;
let hemiLight, composer;
// kept around so app.js's existing setTimeOfDay(...) callsite is a harmless no-op
let _currentHour = 13.5;

function initScene(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // SketchUp-style: no shadows, no tone mapping, no PBR. Keeps the image
  // clean and graphic instead of photoreal.
  renderer.shadowMap.enabled = false;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.physicallyCorrectLights = false;

  scene = new THREE.Scene();
  // Cream paper background + a very light haze so distant objects fade
  // toward the background colour instead of clipping at the far plane.
  // Same vibe as SketchUp's default "Architectural Design" style.
  scene.background = new THREE.Color(0xf0ede4);
  scene.fog = new THREE.FogExp2(0xeeeae0, 0.00010);

  camera = new THREE.PerspectiveCamera(50, 1, 1, 10000);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 15;
  controls.maxDistance = 6000;
  controls.maxPolarAngle = Math.PI / 2 - 0.01;

  // No directional sun / no PBR env map. Ambient + hemisphere only —
  // the hemi gradient is exactly what gives SketchUp its readable
  // "lighter on top, darker underneath" look on every face.
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  hemiLight = new THREE.HemisphereLight(0xffffff, 0xc8c0b0, 0.85);
  scene.add(hemiLight);

  initComposer();

  window.addEventListener('resize', onResize);
  onResize();
  startLoop();
}

// Mild contrast / saturation grade. With the realistic lighting gone the
// image already reads clean; this pass just keeps a bit of pop without
// the photoreal warm-cool dance.
const ColorGradeShader = {
  uniforms: {
    tDiffuse:   { value: null },
    contrast:   { value: 1.05 },
    saturation: { value: 1.00 },
    warmth:     { value: 0.0 },
    brightness: { value: 1.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float contrast;
    uniform float saturation;
    uniform float warmth;
    uniform float brightness;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      c.rgb *= brightness;
      c.r = clamp(c.r + warmth, 0.0, 1.0);
      c.b = clamp(c.b - warmth, 0.0, 1.0);
      c.rgb = (c.rgb - 0.5) * contrast + 0.5;
      float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(lum), c.rgb, saturation);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), c.a);
    }
  `,
};

function initComposer() {
  if (typeof THREE.EffectComposer !== 'function') return;
  composer = new THREE.EffectComposer(renderer);
  composer.addPass(new THREE.RenderPass(scene, camera));
  // No bloom — cartoon look has no glow / highlight bleed.
  if (typeof THREE.ShaderPass === 'function') {
    composer.addPass(new THREE.ShaderPass(ColorGradeShader));
  }
}

// No-op stub. The time-of-day slider used to drive sun direction +
// physical sky tint; with the cartoon lighting model there's nothing
// to update. Kept so the slider's input handler doesn't NPE.
function setTimeOfDay(hour) {
  _currentHour = hour;
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
  const toRemove = [];
  scene.traverse(obj => {
    if (obj === scene) return;
    if (obj instanceof THREE.Light) return;
    toRemove.push(obj);
  });
  const TEX_SLOTS = [
    'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
    'emissiveMap', 'bumpMap', 'displacementMap', 'alphaMap',
    'envMap', 'lightMap', 'gradientMap', 'specularMap',
    'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap',
  ];
  toRemove.forEach(obj => {
    scene.remove(obj);
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(m => {
        for (const k of TEX_SLOTS) {
          if (m[k] && typeof m[k].dispose === 'function') m[k].dispose();
        }
        m.dispose();
      });
    }
  });
  if (typeof resetBuildingCaches === 'function') resetBuildingCaches();
}

// Build a terrain LOD with 4 vertex-density levels (see commit d08cde4).
// Material is MeshLambertMaterial now — picks up the hemi gradient but
// has no specular / no env reflections, matching the cartoon look.
// `aerialTex` is a THREE.Texture handed back by fetchAerialPhoto — already
// configured with the right encoding / mipmap settings, no roundtrip
// through a data URL.
function buildTerrain(grid, n, xSize, zSize, aerialTex, vertExag) {
  // Defensive: legacy path passed a data URL string. Wrap on the fly so
  // older callers don't break.
  let tex = aerialTex;
  if (typeof aerialTex === 'string') {
    tex = new THREE.TextureLoader().load(aerialTex);
    tex.encoding = THREE.sRGBEncoding;
    tex.name = 'aerial';
  }
  const mat = new THREE.MeshLambertMaterial({ map: tex });
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
}
