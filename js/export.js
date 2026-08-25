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

// None of r128's exporters (Collada / GLTF / OBJ) understands
// InstancedMesh — isMesh is true, so they serialise the base geometry
// ONCE at the object's own transform and silently drop instanceMatrix.
// Trees are InstancedMesh, so exports used to contain a single tree at
// the group origin instead of the forest. Bake every instance into one
// merged plain BufferGeometry the exporters do understand.
function _expandInstancedMeshes(rootGroup) {
  const swaps = [];
  rootGroup.traverse(o => { if (o.isInstancedMesh) swaps.push(o); });
  for (const im of swaps) {
    const base = im.geometry.index ? im.geometry.toNonIndexed() : im.geometry;
    const posA = base.getAttribute('position');
    const nrmA = base.getAttribute('normal');
    const uvA  = base.getAttribute('uv');
    const count = im.count, vtx = posA.count;
    const pos = new Float32Array(count * vtx * 3);
    const nrm = nrmA ? new Float32Array(count * vtx * 3) : null;
    const uv  = uvA  ? new Float32Array(count * vtx * 2) : null;
    const m = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      im.getMatrixAt(i, m);
      nm.getNormalMatrix(m);
      for (let j = 0; j < vtx; j++) {
        const o3 = (i * vtx + j) * 3;
        v.fromBufferAttribute(posA, j).applyMatrix4(m);
        pos[o3] = v.x; pos[o3 + 1] = v.y; pos[o3 + 2] = v.z;
        if (nrm) {
          v.fromBufferAttribute(nrmA, j).applyMatrix3(nm).normalize();
          nrm[o3] = v.x; nrm[o3 + 1] = v.y; nrm[o3 + 2] = v.z;
        }
        if (uv) {
          const o2 = (i * vtx + j) * 2;
          uv[o2] = uvA.getX(j); uv[o2 + 1] = uvA.getY(j);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (nrm) g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    if (uv)  g.setAttribute('uv',     new THREE.BufferAttribute(uv, 2));
    const mesh = new THREE.Mesh(g, im.material);
    mesh.name = im.name;
    mesh.position.copy(im.position);
    mesh.quaternion.copy(im.quaternion);
    mesh.scale.copy(im.scale);
    im.parent.add(mesh);
    im.parent.remove(im);
  }
}

async function _buildExportRoot(terrain, buildings, name, features) {
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
  // Ground features (roads / rails / water / bridges / trees).
  if (features) root.add(features.clone());
  _expandInstancedMeshes(root);
  return root;
}

// ── DAE (Collada) ──────────────────────────────────────────────────────────
// SketchUp-friendly: COLLADA 1.4.1, Y-up, Lambert materials, PNG textures.
async function exportSceneAsDae(terrain, buildings, baseName, features) {
  if (typeof THREE.ColladaExporter !== 'function') throw new Error('ColladaExporter not loaded');
  if (typeof JSZip !== 'function') throw new Error('JSZip not loaded');

  const root = await _buildExportRoot(terrain, buildings, baseName, features);
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
async function exportSceneAsGlb(terrain, buildings, baseName, features) {
  if (typeof THREE.GLTFExporter !== 'function') throw new Error('GLTFExporter not loaded');

  const root = await _buildExportRoot(terrain, buildings, baseName, features);
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
async function exportSceneAsObj(terrain, buildings, baseName, features) {
  if (typeof THREE.OBJExporter !== 'function') throw new Error('OBJExporter not loaded');
  if (typeof JSZip !== 'function') throw new Error('JSZip not loaded');

  const root = await _buildExportRoot(terrain, buildings, baseName, features);

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

  // Stable, UNIQUE .mtl names. Material .name often repeats (every PLATEAU
  // tile names its materials 'plateau') — duplicate newmtl entries make
  // importers bind the wrong texture.
  const usedNames = new Set();
  const matNames = materials.map((m, i) => {
    let n = (m.name && /^[\w.-]+$/.test(m.name)) ? m.name : `mat_${i}`;
    if (usedNames.has(n)) n = `${n}_${i}`;
    usedNames.add(n);
    return n;
  });

  // r0.128's OBJExporter DOES emit `usemtl <material.name>` per mesh — it
  // just uses the raw name. That name is frequently a DUPLICATE (every
  // PLATEAU tile calls its materials 'plateau') and may contain characters
  // MTL cannot express, so it referenced entries that do not exist in the
  // de-duplicated .mtl we write and importers fell back to untextured grey.
  //
  // A previous attempt injected a second `usemtl` after each `o` line; the
  // exporter's own line appears later in the block and simply overrode it.
  // The fix is to make the exporter emit the RIGHT names: rename the
  // materials to their unique .mtl names for the duration of the export,
  // then restore. (Object3D.clone() shares materials by reference, so
  // these are the live scene's materials — restoring is not optional.)
  const originalNames = materials.map(m => m.name);
  materials.forEach((m, i) => { m.name = matNames[i]; });
  let objText;
  try {
    objText = new THREE.OBJExporter().parse(root);
  } finally {
    materials.forEach((m, i) => { m.name = originalNames[i]; });
  }
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
    // Sanitise: spaces split MTL map_Kd tokens, non-ASCII breaks CP437
    // zip readers — strict importers then silently lose the texture.
    const safe = (tex.name || 'tex_' + textures.length).replace(/[^\w.-]+/g, '_');
    const file = `textures/${safe}.png`;
    const base64 = c.toDataURL('image/png').split(',').pop();
    texIds.set(tex, textures.length);
    textures.push({ file, base64 });
    return file;
  }

  // .mtl writer — covers diffuse colour and diffuse-map for the materials we
  // actually use (MeshLambertMaterial). Good enough for ~every DCC tool.
  const mtlLines = ['# openEarth3D MTL', `# generated for ${baseName}.obj`, ''];
  materials.forEach((m, i) => {
    const name = matNames[i];
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
async function exportScene(format, terrain, buildings, baseName, features) {
  switch (format) {
    case 'dae': return exportSceneAsDae(terrain, buildings, baseName, features);
    case 'glb': return exportSceneAsGlb(terrain, buildings, baseName, features);
    case 'obj': return exportSceneAsObj(terrain, buildings, baseName, features);
    default: throw new Error('Unknown export format: ' + format);
  }
}
