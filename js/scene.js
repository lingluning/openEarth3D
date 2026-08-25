'use strict';

let renderer, scene, camera, controls, animId;
let hemiLight, ambLight, sunLight, sky, composer;
let _currentHour = 13.5;
// Scene extent, remembered so setTimeOfDay() can re-fit the shadow camera
// whenever the sun moves. Set by fitSunToScene() after each generate.
let _sceneSpan = 2000, _sceneCentre = new THREE.Vector3(0, 0, 0), _sceneTopY = 200;

// ── Lighting rig ────────────────────────────────────────────────────────
// The previous rig was ambient(0.55) + hemisphere(0.85) and nothing else.
// That is physically incapable of showing form: every vertical wall of a
// building receives IDENTICAL irradiance regardless of which way it faces,
// so a cube renders as a flat silhouette and a whole city renders as
// coloured paper. It also summed to ~1.4x albedo, hard-clipping every
// bright surface to white.
//
// New rig — a real sun plus balanced fill, tuned so that:
//   sunlit roof   ~ 0.22 + 0.40 + 1.00*0.85 = 1.47  (ACES rolls off to ~0.82)
//   sunlit wall   ~ 0.22 + 0.20 + 1.00*0.60 = 1.02  (~0.68)
//   shaded wall   ~ 0.22 + 0.20             = 0.42  (~0.37)
// i.e. a ~2:1 lit/shade ratio, which is what makes edges and volumes read.
// Tone mapping is REQUIRED here: without it the >1.0 values clip and we
// are back to flat white roofs.
const SUN_MAX_INTENSITY  = 1.00;
const AMBIENT_INTENSITY  = 0.22;
const HEMI_INTENSITY     = 0.40;
const SHADOW_MAP_SIZE    = 2048;

function initScene(canvas) {
  // preserveDrawingBuffer lets downloadScreenshot() read the canvas after
  // a render without the framebuffer being cleared first.
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  // ACES filmic: the scene now deliberately produces values above 1.0 on
  // sunlit surfaces. ACES rolls those off into a highlight shoulder
  // instead of clipping them to flat white, which is what gives the
  // render its depth. Exposure compensates for ACES' darker midtones.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.physicallyCorrectLights = false;

  scene = new THREE.Scene();
  // Fog colour is re-tinted to the horizon sky colour by setTimeOfDay so
  // distant geometry dissolves INTO the sky rather than into a mismatched
  // band. Density gives ~30 % aerial perspective at 1.7 km, which is what
  // separates foreground from background at city scale.
  scene.fog = new THREE.FogExp2(0xcfd8e0, 0.00035);

  camera = new THREE.PerspectiveCamera(50, 1, 1, 20000);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 15;
  controls.maxDistance = 6000;
  controls.maxPolarAngle = Math.PI / 2 - 0.01;

  ambLight = new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY);
  scene.add(ambLight);
  // Sky/ground hemisphere provides the blue-from-above / warm-bounce-from-
  // below fill that keeps shadowed faces readable instead of black.
  hemiLight = new THREE.HemisphereLight(0xbcd4f0, 0xb0a290, HEMI_INTENSITY);
  scene.add(hemiLight);

  sunLight = new THREE.DirectionalLight(0xfff4e6, SUN_MAX_INTENSITY);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  // normalBias beats plain bias for large-scale architecture: it offsets
  // along the surface normal so tall thin walls don't self-shadow-acne
  // while flat ground keeps its contact shadow.
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.8;
  sunLight.target.position.set(0, 0, 0);
  // Both the light and its target must survive clearSceneObjects().
  sunLight.userData.keepOnClear = true;
  sunLight.target.userData.keepOnClear = true;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // Real gradient sky via Sky.js (already loaded in index.html and, until
  // now, entirely unused — the background was a flat cream fill that gave
  // the skyline nothing to read against).
  if (typeof THREE.Sky === 'function') {
    sky = new THREE.Sky();
    sky.scale.setScalar(450000);
    sky.frustumCulled = false;     // camera.far is far below the sky scale
    sky.userData.keepOnClear = true;
    const u = sky.material.uniforms;
    u['turbidity'].value = 8;
    u['rayleigh'].value = 2.2;
    u['mieCoefficient'].value = 0.005;
    u['mieDirectionalG'].value = 0.75;
    scene.add(sky);
  } else {
    scene.background = new THREE.Color(0xbcd4f0);
  }

  setTimeOfDay(_currentHour);
  initComposer();

  window.addEventListener('resize', onResize);
  onResize();
  startLoop();
}

// Sun direction for a given hour in our local frame (+X east, +Y up,
// +Z south). Azimuth runs east (06:00) → south (12:00) → west (18:00);
// elevation peaks at noon. Returns a unit vector pointing FROM the origin
// TOWARD the sun.
function _sunDirection(hour) {
  const elevDeg = 62 * Math.sin(Math.PI * (hour - 6) / 12);
  const azDeg   = 90 + (hour - 6) * 15;          // 0 = north, clockwise
  const el = elevDeg * Math.PI / 180;
  const az = azDeg   * Math.PI / 180;
  return {
    dir: new THREE.Vector3(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      -Math.cos(el) * Math.cos(az)
    ),
    elevDeg,
  };
}

// Called by app.js once the scene extent is known, so the shadow camera
// covers exactly the generated area. An orthographic shadow frustum that
// is too large wastes depth precision (blocky shadows); too small and
// shadows are clipped away mid-scene.
function fitSunToScene(xSize, zSize, topY) {
  _sceneSpan = Math.max(xSize, zSize);
  _sceneCentre.set(xSize / 2, 0, zSize / 2);
  _sceneTopY = Math.max(50, topY || 200);
  setTimeOfDay(_currentHour);
}

function setTimeOfDay(hour) {
  _currentHour = hour;
  if (!sunLight) return;
  const { dir, elevDeg } = _sunDirection(hour);

  // Position the sun far enough out that its orthographic shadow frustum
  // can enclose the whole scene from any azimuth.
  const dist = _sceneSpan * 1.6 + _sceneTopY * 2;
  sunLight.position.copy(_sceneCentre).addScaledVector(dir, dist);
  sunLight.target.position.copy(_sceneCentre);
  sunLight.target.updateMatrixWorld();

  // Orthographic extent: half the diagonal plus headroom for tall towers,
  // so a skyscraper at the map edge still casts into frame.
  const half = _sceneSpan * 0.75 + _sceneTopY;
  const cam = sunLight.shadow.camera;
  cam.left = -half; cam.right = half;
  cam.top = half;   cam.bottom = -half;
  cam.near = 1;
  cam.far = dist + _sceneSpan * 1.5 + _sceneTopY * 2;
  cam.updateProjectionMatrix();

  // Intensity ramps in across civil twilight so dawn/dusk are gradual and
  // night is genuinely dark rather than an abrupt cut.
  const t = Math.max(0, Math.min(1, (elevDeg + 4) / 14));
  const dayness = t * t * (3 - 2 * t);                     // smoothstep
  sunLight.intensity = SUN_MAX_INTENSITY * dayness;
  sunLight.castShadow = dayness > 0.05;

  // Low sun = warm; high sun = neutral. This single cue does most of the
  // work of selling a time of day.
  const warm = Math.max(0, Math.min(1, (20 - elevDeg) / 26));
  sunLight.color.setRGB(1, 1 - 0.30 * warm, 1 - 0.62 * warm);

  // Fill light follows: blue sky bounce by day, deep blue by night, and
  // ambient never drops to zero so a night scene stays legible.
  const nightAmb = 0.10, nightHemi = 0.16;
  ambLight.intensity  = nightAmb  + (AMBIENT_INTENSITY - nightAmb)  * dayness;
  hemiLight.intensity = nightHemi + (HEMI_INTENSITY    - nightHemi) * dayness;
  hemiLight.color.setHSL(0.60, 0.45, 0.30 + 0.42 * dayness);
  hemiLight.groundColor.setHSL(0.09, 0.25, 0.12 + 0.30 * dayness);

  if (sky) {
    sky.material.uniforms['sunPosition'].value.copy(dir);
    // Thicker air at low sun exaggerates the sunset gradient.
    sky.material.uniforms['turbidity'].value = 6 + 8 * (1 - dayness);
    sky.material.uniforms['rayleigh'].value = 1.2 + 2.2 * dayness;
  }

  // Fog takes the horizon's colour so the far edge of the map dissolves
  // into the sky instead of ending on a visible band.
  if (scene && scene.fog) {
    const dayFog = new THREE.Color(0xcfd8e0);
    const duskFog = new THREE.Color(0x6b5a63);
    scene.fog.color.copy(duskFog).lerp(dayFog, dayness);
    if (scene.background && scene.background.isColor) {
      scene.background.copy(scene.fog.color);
    }
  }
  // Exposure lifts at night so the scene doesn't go to mud.
  if (renderer) renderer.toneMappingExposure = 1.15 + 0.35 * (1 - dayness);
}

// Final grade + vignette. ACES already shaped the tonal response in the
// material shader, so this pass stays gentle; its job is to recover the
// saturation ACES costs and to add a touch of edge falloff.
//
// ORDER MATTERS: the composer target holds LINEAR values. Contrast and
// saturation are perceptual operations and must be applied in DISPLAY
// space — pivoting contrast around 0.5 in linear space pivots around
// ~73 % grey in sRGB, which crushes shadows and does almost nothing to
// highlights. So we convert to sRGB FIRST, then grade.
const ColorGradeShader = {
  uniforms: {
    tDiffuse:   { value: null },
    contrast:   { value: 1.06 },
    saturation: { value: 1.14 },   // ACES desaturates; put it back
    warmth:     { value: 0.008 },
    brightness: { value: 1.0 },
    vignette:   { value: 0.22 },
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
    uniform float vignette;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // Linear -> display space BEFORE any perceptual grading.
      c = LinearTosRGB(c);
      c.rgb *= brightness;
      c.r = clamp(c.r + warmth, 0.0, 1.0);
      c.b = clamp(c.b - warmth, 0.0, 1.0);
      c.rgb = (c.rgb - 0.5) * contrast + 0.5;
      float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(lum), c.rgb, saturation);
      // Soft vignette — settles the eye on the centre of the map and
      // stops the frame edges competing with the skyline.
      vec2 d = vUv - 0.5;
      float v = 1.0 - vignette * dot(d, d) * 2.4;
      c.rgb *= v;
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), c.a);
    }
  `,
};

function initComposer() {
  if (typeof THREE.EffectComposer !== 'function') return;
  // The renderer was constructed with antialias:true, but that MSAA only
  // applies to the DEFAULT framebuffer. As soon as an EffectComposer
  // renders into its own target, MSAA is silently gone and every edge in
  // the city aliases — very visible on building silhouettes against the
  // sky. On WebGL2 we can ask for a multisampled target and get it back.
  let target;
  const gl = renderer.getContext();
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined'
    && gl instanceof WebGL2RenderingContext;
  if (isWebGL2 && typeof THREE.WebGLMultisampleRenderTarget === 'function') {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    target = new THREE.WebGLMultisampleRenderTarget(size.width, size.height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      encoding: THREE.LinearEncoding,
    });
    target.samples = 4;
  }
  composer = new THREE.EffectComposer(renderer, target);
  composer.addPass(new THREE.RenderPass(scene, camera));
  if (typeof THREE.ShaderPass === 'function') {
    composer.addPass(new THREE.ShaderPass(ColorGradeShader));
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
  const toRemove = [];
  scene.traverse(obj => {
    if (obj === scene) return;
    if (obj instanceof THREE.Light) return;
    // The sky dome and the sun's target Object3D are permanent scene
    // furniture, not generated content — without this guard the first
    // regenerate would delete the sky and disposing its ShaderMaterial
    // would take the sun direction with it.
    if (obj.userData && obj.userData.keepOnClear) return;
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
  // LOD switch distances are measured from the camera to the LOD's centre.
  // placeCameraOverTerrain parks the camera ~0.94 x span from that centre,
  // so the old first stop at 0.4 x span meant the DEFAULT view already ran
  // on the half-density mesh — the user never once saw the terrain detail
  // they paid for in the mesh-density selector. Push the stops out so full
  // detail covers the default framing and a comfortable zoom-out beyond it.
  const stops = [
    { sub: n,                       dist: 0 },
    { sub: Math.max(2, n >> 1),     dist: span * 1.35 },
    { sub: Math.max(2, n >> 2),     dist: span * 2.6 },
    { sub: Math.max(2, n >> 3),     dist: span * 4.5 },
  ];

  // Skirt: without it the world is a paper-thin slab and every low-angle
  // orbit shows the map floating in the sky with a razor edge. A dark
  // extruded band gives the terrain visible thickness and reads as a
  // deliberate "model on a base" presentation.
  let minElev = Infinity;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (grid[r][c] < minElev) minElev = grid[r][c];
  }
  const skirtBottom = minElev * vertExag - Math.max(30, span * 0.03);
  const skirtMat = new THREE.MeshLambertMaterial({
    color: 0x6b6255, side: THREE.DoubleSide,
  });
  skirtMat.name = 'terrain-skirt';

  const lod = new THREE.LOD();
  let fullDetail = null;
  for (const s of stops) {
    const mesh = new THREE.Mesh(_terrainGeo(grid, n, s.sub, xSize, zSize, vertExag), mat);
    // The ground is what building shadows actually land on — without
    // receiveShadow the whole shadow pass is invisible where it matters
    // most. It does not cast (nothing is under it).
    mesh.receiveShadow = true;
    // Child of the level mesh, so it appears/disappears with its level.
    mesh.add(new THREE.Mesh(
      _terrainSkirtGeo(grid, n, s.sub, xSize, zSize, vertExag, skirtBottom),
      skirtMat));
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

// Vertical band around the terrain border, from the edge elevation down
// to `bottomY`. Local coords match _terrainGeo: x in [-xSize/2, xSize/2]
// (west→east), z in [-zSize/2, zSize/2] (north→south).
function _terrainSkirtGeo(grid, n, sub, xSize, zSize, vertExag, bottomY) {
  const pos = [];
  const step = (n - 1) / (sub - 1);
  const xAt = c => -xSize / 2 + (c / (sub - 1)) * xSize;
  const zAt = r => -zSize / 2 + (r / (sub - 1)) * zSize;
  const gAt = (r, c) => grid[Math.round(r * step)][Math.round(c * step)] * vertExag;
  // Emit one quad (two triangles) per border segment. Material is
  // DoubleSide so winding does not matter here.
  const quad = (ax, ay, az, bx, by, bz) => {
    pos.push(ax, ay, az,  bx, by, bz,  bx, bottomY, bz);
    pos.push(ax, ay, az,  bx, bottomY, bz,  ax, bottomY, az);
  };
  for (let c = 0; c < sub - 1; c++) {
    quad(xAt(c), gAt(0, c), zAt(0), xAt(c + 1), gAt(0, c + 1), zAt(0));               // north
    quad(xAt(c), gAt(sub - 1, c), zAt(sub - 1),
         xAt(c + 1), gAt(sub - 1, c + 1), zAt(sub - 1));                              // south
  }
  for (let r = 0; r < sub - 1; r++) {
    quad(xAt(0), gAt(r, 0), zAt(r), xAt(0), gAt(r + 1, 0), zAt(r + 1));               // west
    quad(xAt(sub - 1), gAt(r, sub - 1), zAt(r),
         xAt(sub - 1), gAt(r + 1, sub - 1), zAt(r + 1));                              // east
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
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
