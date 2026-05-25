'use strict';

// Export the current 3D scene (terrain + buildings) in several formats.
// All exporters clone the live meshes so the rendered scene keeps animating
// while serialisation runs — geometry, materials and textures are shared by
// reference, no duplication or re-encoding.

function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _waitForTexture(tex) {
  return new Promise(resolve => {
    if (!tex || !tex.image) return resolve();
    const img = tex.image;
    if (img.complete || img.width > 0) return resolve();
    img.addEventListener('load',  () => resolve(), { once: true });
    img.addEventListener('error', () => resolve(), { once: true });
  });
}

// When terrain is a THREE.LOD, exports should always use the highest-detail
// level — not whatever level the camera happens to be displaying right now.
function _resolveTerrainMesh(terrain) {
  if (terrain && terrain.isLOD) {
    return terrain.userData.fullDetail || terrain.levels[0].object;
  }
  return terrain;
}

async function _buildExportRoot(terrain, buildings, name) {
  if (!terrain) throw new Error('生成された3Dシーンがありません — まず3D表示を生成してください');
  const mesh = _resolveTerrainMesh(terrain);
  if (mesh.material && mesh.material.map) {
    await _waitForTexture(mesh.material.map);
  }
  const root = new THREE.Group();
  root.name = name;
  // Wrap the mesh so we can apply the parent LOD's transform without
  // mutating the original (mesh sits at identity, LOD carries the world
  // offset). Clone the mesh so we don't yank it out of the live LOD.
  const t = mesh.clone();
  if (terrain.isLOD) {
    t.position.copy(terrain.position);
    t.quaternion.copy(terrain.quaternion);
    t.scale.copy(terrain.scale);
  }
  root.add(t);
  if (buildings) root.add(buildings.clone());
  return root;
}

// ── DAE (Collada) ──────────────────────────────────────────────────────────
// SketchUp-friendly: COLLADA 1.4.1, Y-up, Lambert materials, PNG textures.
async function exportSceneAsDae(terrain, buildings, baseName) {
  if (typeof THREE.ColladaExporter !== 'function') throw new Error('ColladaExporter not loaded');
  if (typeof JSZip !== 'function') throw new Error('JSZip not loaded');

  const root = await _buildExportRoot(terrain, buildings, baseName);
  const result = new THREE.ColladaExporter().parse(root, null, {
    version: '1.4.1',
    author: 'openEarth3D',
    textureDirectory: 'textures',
  });
  if (!result || !result.data) throw new Error('Collada export produced no data');

  const zip = new JSZip();
  zip.file(`${baseName}.dae`, result.data);
  const tFolder = zip.folder('textures');
  for (const tex of (result.textures || [])) {
    tFolder.file(`${tex.name}.${tex.ext}`, tex.data, { base64: true });
  }
  zip.file('README.txt',
    `openEarth3D — Collada export\n` +
    `\n` +
    `Open ${baseName}.dae in SketchUp via File → Import.\n` +
    `Set "Files of type" to "COLLADA (*.dae)" in the dialog.\n` +
    `Keep the textures/ folder next to the .dae file.\n` +
    `\n` +
    `Axes: Y-up (SketchUp converts to its Z-up convention on import).\n` +
    `Units: metres.\n`
  );
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  _triggerDownload(blob, `${baseName}.zip`);
}

// ── GLB (binary glTF 2.0) ──────────────────────────────────────────────────
// Single self-contained .glb — textures are embedded as binary buffers.
// Universally supported: Blender, Windows 3D Viewer, web viewers, AR tools.
async function exportSceneAsGlb(terrain, buildings, baseName) {
  if (typeof THREE.GLTFExporter !== 'function') throw new Error('GLTFExporter not loaded');

  const root = await _buildExportRoot(terrain, buildings, baseName);
  const exporter = new THREE.GLTFExporter();
  const arrayBuffer = await new Promise((resolve, reject) => {
    exporter.parse(root, (out) => resolve(out), { binary: true, embedImages: true });
    setTimeout(() => reject(new Error('GLTF export timeout')), 60000);
  });
  const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
  _triggerDownload(blob, `${baseName}.glb`);
}

// ── OBJ + MTL + textures ───────────────────────────────────────────────────
// Three.js's bundled OBJExporter only writes geometry; we generate the .mtl
// ourselves so materials and texture links survive the round-trip into
// Blender / SketchUp / 3ds Max / Cinema 4D.
async function exportSceneAsObj(terrain, buildings, baseName) {
  if (typeof THREE.OBJExporter !== 'function') throw new Error('OBJExporter not loaded');
  if (typeof JSZip !== 'function') throw new Error('JSZip not loaded');

  const root = await _buildExportRoot(terrain, buildings, baseName);

  // Collect unique materials in traversal order so the OBJ's usemtl
  // references line up with the .mtl file we write below.
  const materials = [];
  const matIds = new Map();
  root.traverse(obj => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (m && !matIds.has(m)) {
        matIds.set(m, materials.length);
        materials.push(m);
      }
    }
  });

  let objText = new THREE.OBJExporter().parse(root);
  // Inject mtllib + material name reference at the top; OBJExporter doesn't.
  objText = `mtllib ${baseName}.mtl\n` + objText;

  // Render each unique texture into a PNG via an offscreen canvas.
  const textures = [];
  const texIds = new Map();
  function ensureTextureFile(tex) {
    if (!tex) return null;
    if (texIds.has(tex)) return textures[texIds.get(tex)].file;
    if (!tex.image) return null;
    const c = document.createElement('canvas');
    c.width  = tex.image.width  || tex.image.videoWidth  || 256;
    c.height = tex.image.height || tex.image.videoHeight || 256;
    try { c.getContext('2d').drawImage(tex.image, 0, 0, c.width, c.height); }
    catch { return null; }
    const file = `textures/${tex.name || 'tex_' + textures.length}.png`;
    const base64 = c.toDataURL('image/png').split(',').pop();
    texIds.set(tex, textures.length);
    textures.push({ file, base64 });
    return file;
  }

  // .mtl writer — covers diffuse colour and diffuse-map for the materials we
  // actually use (MeshLambertMaterial). Good enough for ~every DCC tool.
  const mtlLines = ['# openEarth3D MTL', `# generated for ${baseName}.obj`, ''];
  materials.forEach((m, i) => {
    const name = (m.name && /^[\w.-]+$/.test(m.name)) ? m.name : `mat_${i}`;
    const col  = m.color || new THREE.Color(0xffffff);
    mtlLines.push(`newmtl ${name}`);
    mtlLines.push(`Ka 0.2 0.2 0.2`);
    mtlLines.push(`Kd ${col.r.toFixed(4)} ${col.g.toFixed(4)} ${col.b.toFixed(4)}`);
    mtlLines.push(`Ks 0.0 0.0 0.0`);
    mtlLines.push(`d 1.0`);
    mtlLines.push(`illum 1`);
    const texFile = ensureTextureFile(m.map);
    if (texFile) mtlLines.push(`map_Kd ${texFile}`);
    mtlLines.push('');
  });

  const zip = new JSZip();
  zip.file(`${baseName}.obj`, objText);
  zip.file(`${baseName}.mtl`, mtlLines.join('\n'));
  const tFolder = zip.folder('textures');
  for (const t of textures) {
    tFolder.file(t.file.replace(/^textures\//, ''), t.base64, { base64: true });
  }
  zip.file('README.txt',
    `openEarth3D — Wavefront OBJ export\n` +
    `\n` +
    `Files: ${baseName}.obj, ${baseName}.mtl, textures/*.png\n` +
    `Most DCC tools (Blender, SketchUp, 3ds Max, Cinema 4D, Maya) will\n` +
    `import the .obj and auto-resolve the .mtl + textures alongside it.\n` +
    `\n` +
    `Axes: Y-up. Units: metres.\n`
  );

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  _triggerDownload(blob, `${baseName}_obj.zip`);
}

// Dispatch by format name; called from app.js.
async function exportScene(format, terrain, buildings, baseName) {
  switch (format) {
    case 'dae': return exportSceneAsDae(terrain, buildings, baseName);
    case 'glb': return exportSceneAsGlb(terrain, buildings, baseName);
    case 'obj': return exportSceneAsObj(terrain, buildings, baseName);
    default: throw new Error('Unknown export format: ' + format);
  }
}
