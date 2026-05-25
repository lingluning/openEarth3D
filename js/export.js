'use strict';

// Export the current 3D scene (terrain + buildings) as a Collada DAE file
// bundled with its texture images, packaged in a ZIP. The output is
// SketchUp-compatible: COLLADA 1.4.1, Y-up axis, triangulated geometry,
// Lambert materials, PNG textures with relative paths.

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

// Wait until the texture image is fully decoded; data-URL images load
// synchronously enough that this usually resolves on the first tick.
function _waitForTexture(tex) {
  return new Promise(resolve => {
    if (!tex || !tex.image) return resolve();
    const img = tex.image;
    if (img.complete || img.width > 0) return resolve();
    img.addEventListener('load',  () => resolve(), { once: true });
    img.addEventListener('error', () => resolve(), { once: true });
  });
}

async function exportSceneAsDae(terrain, buildings, baseName = 'openEarth3D') {
  if (typeof THREE.ColladaExporter !== 'function') {
    throw new Error('ColladaExporter not loaded');
  }
  if (typeof JSZip !== 'function') {
    throw new Error('JSZip not loaded');
  }
  if (!terrain) throw new Error('No scene to export — generate the 3D view first');

  // Make sure the aerial-photo texture image has decoded
  if (terrain.material && terrain.material.map) {
    await _waitForTexture(terrain.material.map);
  }

  // Clone (shares geometry, material, and textures by reference — no
  // duplication, no re-encoding) so we can re-parent under a temporary root
  // without yanking the live mesh out of the rendered scene.
  const root = new THREE.Group();
  root.name = baseName;
  root.add(terrain.clone());
  if (buildings) root.add(buildings.clone());

  const exporter = new THREE.ColladaExporter();
  const result = exporter.parse(root, null, {
    version: '1.4.1',
    author: 'openEarth3D',
    textureDirectory: 'textures',
  });

  if (!result || !result.data) throw new Error('Collada export produced no data');

  const zip = new JSZip();
  zip.file(`${baseName}.dae`, result.data);

  const folder = zip.folder('textures');
  for (const tex of (result.textures || [])) {
    folder.file(`${tex.name}.${tex.ext}`, tex.data, { base64: true });
  }

  // Small README so SketchUp users know what to do
  zip.file('README.txt',
    'openEarth3D export\n' +
    '------------------\n' +
    'Open ' + baseName + '.dae in SketchUp via File → Import.\n' +
    'In the import dialog, set "Files of type" to "COLLADA (*.dae)".\n' +
    'The textures/ folder must stay alongside the .dae file.\n' +
    '\n' +
    'Axes: Y-up (SketchUp will reorient to its Z-up convention).\n' +
    'Units: metres.\n'
  );

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  _triggerDownload(blob, `${baseName}.zip`);
}
