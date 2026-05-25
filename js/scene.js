'use strict';

let renderer, scene, camera, controls, animId;
let sky, sun, hemiLight, fillLight, composer;
let pmrem, skyOnlyScene;
let _currentHour = 13.5; // local solar hour; updated by setTimeOfDay()

function initScene(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Slight boost over neutral so the post-tone-map image isn't muddy.
  // The contrast pass after this brings it the rest of the way.
  renderer.toneMappingExposure = 1.18;
  renderer.physicallyCorrectLights = true;

  scene = new THREE.Scene();
  // Sky and fog colour follow the sun — both updated by setTimeOfDay().
  scene.fog = new THREE.FogExp2(0xd8dde0, 0.00018);

  camera = new THREE.PerspectiveCamera(50, 1, 1, 10000);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 15;
  controls.maxDistance = 6000;
  controls.maxPolarAngle = Math.PI / 2 - 0.01;

  // Physical sky (Hosek-Wilkie atmospheric scattering). Dropped rayleigh
  // and turbidity from the previous values — the original 2.0 / 4.0 made
  // every PBR material reflect a deep blue dome via the env map, and the
  // whole scene came out cyan-tinted.
  sky = new THREE.Sky();
  sky.scale.setScalar(450000);
  const u = sky.material.uniforms;
  u.turbidity.value = 2.5;
  u.rayleigh.value = 1.2;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.85;
  scene.add(sky);

  // Hemisphere fill: warmer / less-saturated sky tone. The ground bounce
  // is a touch warmer too so shaded sides don't read as cold blue.
  hemiLight = new THREE.HemisphereLight(0xe8eef2, 0x6a5640, 0.35);
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

  // Sky-only scene used by PMREMGenerator to bake an environment map. The
  // clone shares the original sky's material (uniforms included), so updating
  // the sun position automatically propagates here too — we just need to
  // re-bake on each time-of-day change.
  //
  // Critical: PMREMGenerator's default near/far is 0.1/100. The main-scene
  // sky is scaled to 450 000 (so it stays "at infinity" while the camera
  // moves over a 3 km terrain), which would put every face well past the
  // default far plane and leave the env map black. The clone shrinks the
  // sky to fit inside the default frustum without affecting the displayed
  // sky (the shader only cares about view direction, not distance).
  pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  skyOnlyScene = new THREE.Scene();
  const envSky = new THREE.Mesh(sky.geometry, sky.material);
  envSky.scale.setScalar(50);
  skyOnlyScene.add(envSky);

  setTimeOfDay(_currentHour); // initialise sun + sky tint + env map

  // Post-processing: render-pass + bloom for highlights + SSAO for crevices.
  // Effects are wired in initComposer() lazily once we know the canvas size.
  initComposer();

  window.addEventListener('resize', onResize);
  onResize();
  startLoop();
}

// Small contrast + saturation + warm-tint adjustment, runs after bloom.
// Tone-mapped output is usually a touch flat and slightly cool; this
// pass nudges it toward a sharper, less-blue look without touching the
// underlying lighting model.
const ColorGradeShader = {
  uniforms: {
    tDiffuse:   { value: null },
    contrast:   { value: 1.12 },   // around mid-gray, gentle S-curve effect
    saturation: { value: 0.92 },   // < 1 = desaturate (kills blue dominance)
    warmth:     { value: 0.025 },  // adds R, subtracts B for warmer cast
    brightness: { value: 1.02 },
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
      // Brightness
      c.rgb *= brightness;
      // Warmth: nudge red up, blue down (preserves luminance close enough).
      c.r = clamp(c.r + warmth, 0.0, 1.0);
      c.b = clamp(c.b - warmth, 0.0, 1.0);
      // Contrast around 0.5
      c.rgb = (c.rgb - 0.5) * contrast + 0.5;
      // Saturation around perceived luminance
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

  if (typeof THREE.UnrealBloomPass === 'function') {
    const bloom = new THREE.UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.30,  // strength — subtle, only glassy reflections / sun glints
      0.85,  // radius
      0.94   // threshold — bumped so the sky doesn't bloom into haze
    );
    composer.addPass(bloom);
  }

  if (typeof THREE.ShaderPass === 'function') {
    composer.addPass(new THREE.ShaderPass(ColorGradeShader));
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
  const elev = Math.sin(theta);           // -1..1 (sin of altitude)
  const azim = Math.PI * (0.5 + t);       // east → south → west

  // Horizontal magnitude = cos(altitude) = |cos(theta)|. The naked
  // cos(theta) flips sign after noon and (combined with the azim cos/sin)
  // mirrored every afternoon position back to the morning side, so 3 pm
  // ended up north-east and sunset happened in the east. abs() keeps the
  // sun on the correct side of the sky.
  const dist = 4000;
  const horiz = Math.abs(Math.cos(theta));
  const sunPos = new THREE.Vector3(
    dist * horiz * Math.cos(azim - Math.PI/2),
    dist * elev,
    dist * horiz * Math.sin(azim - Math.PI/2)
  );
  sun.position.copy(sunPos);
  sun.target.position.set(0, 0, 0);
  sky.material.uniforms.sunPosition.value.copy(sunPos);

  // Sun colour and intensity vs. elevation. Below horizon → blue moonlight.
  // Sun is intentionally stronger than the hemi fill so direct/indirect
  // light has clear separation — that's where most of the perceived
  // contrast lives in a daytime scene.
  if (elev > 0.02) {
    const warm = Math.pow(1 - Math.max(0, elev), 2); // 0 at noon, 1 at horizon
    sun.color.setRGB(
      1.0,
      0.88 + 0.12 * (1 - warm),
      0.65 + 0.35 * (1 - warm)
    );
    sun.intensity = 0.7 + 3.4 * Math.max(0, elev);
    // Hemi fill kept low (~1/4 of sun) and close to neutral so it tints
    // the shadows only slightly. Previously it ramped to (0.78, 0.91, 1.0)
    // — pure blue cap — which turned every concrete surface cyan.
    hemiLight.intensity = 0.18 + 0.22 * elev;
    hemiLight.color.setRGB(0.93, 0.95 + 0.04*(1-warm), 1.0);
  } else {
    sun.color.setRGB(0.4, 0.5, 0.7);
    sun.intensity = 0.05;
    hemiLight.intensity = 0.12;
    hemiLight.color.setRGB(0.32, 0.42, 0.6);
  }

  // Fog colour follows the lit sky but stays much more neutral than before
  // — heavy blue fog washed out distant buildings into a single blue mush.
  const fogR = Math.max(0.05, 0.45 + 0.50 * Math.max(0, elev));
  const fogG = Math.max(0.06, 0.50 + 0.45 * Math.max(0, elev));
  const fogB = Math.max(0.10, 0.55 + 0.40 * Math.max(0, elev));
  scene.fog.color.setRGB(fogR, fogG, fogB);
  renderer.setClearColor(scene.fog.color);

  // Re-bake the PBR environment map. Cheap (sky only, no terrain/buildings
  // captured) — only called when the user moves the time slider.
  if (pmrem && skyOnlyScene) {
    if (scene.environment) scene.environment.dispose();
    scene.environment = pmrem.fromScene(skyOnlyScene, 0).texture;
  }
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
  // All known texture slots on MeshStandardMaterial / Phong / Lambert.
  // Leaking any of these has bitten us across many "regenerate" clicks.
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
function buildTerrain(grid, n, xSize, zSize, texDataUrl, vertExag) {
  const tex = new THREE.TextureLoader().load(texDataUrl);
  tex.encoding = THREE.sRGBEncoding;
  tex.name = 'aerial';
  // MeshStandardMaterial picks up sky lighting via PBR; roughness keeps it
  // non-reflective so the aerial-photo texture reads cleanly. envMap
  // intensity dialled down so the terrain doesn't get the sky's blue cast.
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.97,
    metalness: 0.0,
    envMapIntensity: 0.4,
  });
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
