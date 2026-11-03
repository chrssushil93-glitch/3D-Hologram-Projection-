// LumaGrid AIR Studio - browser app.
// LumaGrid coordinates: X width, Y depth, Z height (metres). Three.js is Y-up, so luma (x, y, z) renders at three (x, z, y).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  sampleTriangles, meshArea, placePoints, checkInsideVolume, voxelize, volumeBounds, viewerPosition, VIEW_ANGLES,
} from './src/spatial.js';
import { compileJob } from './src/job.js';
import { SimulatedDevice, STATES } from './src/device.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state
const state = {
  volume: { x: 2, y: 1, z: 2 },
  size: 0.6, pos: [0, 0, 1], yaw: 0,
  spin: 36, durationS: 10, fps: 30,
  voxelMm: 20, samples: 30000,
  mode: 'optical', // 'visual' | 'optical'
  view: 'orbit', // 'orbit' | 'tri'
  playing: true, previewT: 0,
  model: null, // { name, wrapper, meshes, unit, colours, info }
  placed: null, placedColours: null,
  voxels: null, // editor voxels (luma coords)
  job: null, jobStale: true,
};
let dirtyResample = true;
let dirtyPlacement = true;
let machineJobId = null;

const device = new SimulatedDevice();

// ---------------------------------------------------------------- three.js scene
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);

const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
camera.position.set(2.6, 2.2, -3.4);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 1, 0);

scene.add(new THREE.HemisphereLight(0x9bb6ff, 0x101018, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(-2, 4, -3);
scene.add(key);

const grid = new THREE.GridHelper(8, 16, 0x2a3550, 0x182036);
scene.add(grid);

const pivot = new THREE.Group(); // spin about the volume axis (matches the job's yaw-spin pivot at 0,0)
scene.add(pivot);
const placeGroup = new THREE.Group(); // object placement: position, size, own yaw
pivot.add(placeGroup);

// Opaque, depth-tested voxels: keeps colour readable and shows natural front-to-back occlusion.
const voxelMaterial = new THREE.PointsMaterial({
  size: 0.02, sizeAttenuation: true, vertexColors: true,
});
const editorPoints = new THREE.Points(new THREE.BufferGeometry(), voxelMaterial);
editorPoints.frustumCulled = false;
const machinePoints = new THREE.Points(new THREE.BufferGeometry(), voxelMaterial);
machinePoints.frustumCulled = false;
machinePoints.visible = false;
pivot.add(editorPoints, machinePoints);

let volumeBox = null;
let arcLine = null;
const markers = [];

function toThree(luma) {
  const out = new Float32Array(luma.length);
  for (let i = 0; i < luma.length; i += 3) {
    out[i] = luma[i];
    out[i + 1] = luma[i + 2];
    out[i + 2] = luma[i + 1];
  }
  return out;
}

function viewDistance() { return 4.5; }
function eyeHeight() { return Math.min(1.5, state.volume.z); }

function rebuildVolumeGuides() {
  const { x, y, z } = state.volume;
  if (volumeBox) { scene.remove(volumeBox); volumeBox.geometry.dispose(); }
  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(x, z, y));
  volumeBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x35d0ff, transparent: true, opacity: 0.7 }));
  volumeBox.position.set(0, z / 2, 0);
  scene.add(volumeBox);

  if (arcLine) { scene.remove(arcLine); arcLine.geometry.dispose(); }
  const pts = [];
  for (let a = -90; a <= 90; a += 3) {
    const [lx, ly] = viewerPosition(a, viewDistance(), 0);
    pts.push(new THREE.Vector3(lx, 0.01, ly));
  }
  arcLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x8b7bff, transparent: true, opacity: 0.8 }));
  scene.add(arcLine);

  markers.splice(0).forEach((m) => { scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
  VIEW_ANGLES.forEach((a) => {
    const [lx, ly] = viewerPosition(a, viewDistance(), 0);
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshBasicMaterial({ color: 0x8b7bff }));
    m.position.set(lx, 0.07, ly);
    scene.add(m);
    markers.push(m);
  });

  // sliders follow the volume so placement stays meaningful
  const set = (id, min, max) => { const el = $(id); el.min = min; el.max = max; };
  set('px', -x, x); set('py', -y, y); set('pz', 0, +(z * 1.5).toFixed(2));
  controls.target.set(0, z / 2, 0);
}

// ---------------------------------------------------------------- models
function colourOf(mesh) {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  if (mat && mat.color) {
    const hex = mat.color.getHex();
    return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  }
  return [200, 220, 255];
}

function buildSample(kind) {
  const g = new THREE.Group();
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, metalness: 0.25, roughness: 0.4, ...extra });
  if (kind === 'knot') {
    g.add(new THREE.Mesh(new THREE.TorusKnotGeometry(0.5, 0.16, 240, 36), std(0x35d0ff)));
  } else if (kind === 'orb') {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.07, 32, 120), std(0xff7a59));
    ring.rotation.x = Math.PI / 2.6;
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 48, 32), std(0x6ee7ff));
    g.add(ring, orb);
  } else if (kind === 'vase') {
    const profile = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      profile.push(new THREE.Vector2(0.12 + 0.2 * Math.sin(t * Math.PI * 1.15) + 0.06 * t, t * 1.1));
    }
    g.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 64), std(0xf5c451, { side: THREE.DoubleSide })));
  } else {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 4, 4, 4), std(0xc084fc)));
  }
  return g;
}

/** Take any Object3D (imported GLB or sample), sample its surface and prepare it for the editor. */
function adoptModel(root, name) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  if (box.isEmpty()) throw new Error('The model has no visible geometry.');
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z) || 1;

  const meshes = [];
  let tris = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const geo = o.geometry;
    const src = geo.attributes.position;
    const world = new Float32Array(src.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < src.count; i++) {
      v.fromBufferAttribute(src, i).applyMatrix4(o.matrixWorld);
      // to luma coordinates: (x, z, y) of three space, centred and scaled to unit extent
      world[i * 3] = (v.x - centre.x) / extent;
      world[i * 3 + 1] = (v.z - centre.z) / extent;
      world[i * 3 + 2] = (v.y - centre.y) / extent;
    }
    const index = geo.index ? geo.index.array : null;
    const area = meshArea(world, index);
    tris += index ? index.length / 3 : src.count / 3;
    if (area > 0) meshes.push({ world, index, area, colour: colourOf(o) });
  });
  if (!meshes.length) throw new Error('The model contains no triangle meshes.');

  // visual copy, normalised so its largest dimension is 1 and centred on the origin
  const wrapper = new THREE.Group();
  root.position.sub(centre);
  wrapper.add(root);
  wrapper.scale.setScalar(1 / extent);

  if (state.model) {
    placeGroup.remove(state.model.wrapper);
    state.model.wrapper.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
  placeGroup.add(wrapper);
  state.model = {
    name, wrapper, meshes,
    info: `${name} · ${Math.round(tris).toLocaleString()} triangles · ${meshes.length} mesh${meshes.length > 1 ? 'es' : ''} · ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} (source units)`,
  };
  $('modelInfo').textContent = state.model.info;
  dirtyResample = true;
}

function resample() {
  const m = state.model;
  if (!m) return;
  const totalArea = m.meshes.reduce((s, x) => s + x.area, 0);
  const parts = [];
  const cols = [];
  let used = 0;
  m.meshes.forEach((mesh, i) => {
    let n = Math.max(1, Math.round((state.samples * mesh.area) / totalArea));
    if (i === m.meshes.length - 1) n = Math.max(1, state.samples - used);
    used += n;
    const pts = sampleTriangles(mesh.world, mesh.index, n, 11 + i);
    parts.push(pts);
    const c = new Uint8Array(pts.length);
    for (let k = 0; k < pts.length; k += 3) { c[k] = mesh.colour[0]; c[k + 1] = mesh.colour[1]; c[k + 2] = mesh.colour[2]; }
    cols.push(c);
  });
  const join = (arrs, Type) => {
    const total = arrs.reduce((s, a) => s + a.length, 0);
    const out = new Type(total);
    let o = 0;
    arrs.forEach((a) => { out.set(a, o); o += a.length; });
    return out;
  };
  m.unit = join(parts, Float32Array);
  m.colours = join(cols, Uint8Array);
}

// ---------------------------------------------------------------- placement + voxels
function applyPlacementTransform() {
  const [px, py, pz] = state.pos;
  placeGroup.position.set(px, pz, py);
  placeGroup.scale.setScalar(state.size);
  placeGroup.rotation.y = -(state.yaw * Math.PI) / 180;
}

function updatePlacement() {
  const m = state.model;
  if (!m || !m.unit) return;
  applyPlacementTransform();
  state.placed = placePoints(m.unit, { size: state.size, position: state.pos, yawDeg: state.yaw });
  state.placedColours = m.colours;

  const vs = state.voxelMm / 1000;
  const { voxels, indexMap } = voxelize(state.placed, vs);
  state.voxels = voxels;
  const inside = checkInsideVolume(state.placed, state.volume);

  // colour voxels: source colour inside, red outside the volume
  const { min, max } = volumeBounds(state.volume);
  const col = new Float32Array(voxels.length);
  for (let n = 0; n < indexMap.length; n++) {
    const x = voxels[n * 3], y = voxels[n * 3 + 1], z = voxels[n * 3 + 2];
    const out = x < min[0] || x > max[0] || y < min[1] || y > max[1] || z < min[2] || z > max[2];
    if (out) { col[n * 3] = 1; col[n * 3 + 1] = 0.25; col[n * 3 + 2] = 0.25; } else {
      const s = indexMap[n] * 3;
      col[n * 3] = m.colours[s] / 255; col[n * 3 + 1] = m.colours[s + 1] / 255; col[n * 3 + 2] = m.colours[s + 2] / 255;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(toThree(voxels), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  editorPoints.geometry.dispose();
  editorPoints.geometry = geo;
  voxelMaterial.size = Math.max(vs * 0.8, 0.006);

  const ok = inside.ok;
  $('stats').innerHTML =
    `Voxels: <b>${(voxels.length / 3).toLocaleString()}</b> from ${inside.total.toLocaleString()} samples<br>` +
    (ok
      ? '<span class="ok">✓ Inside the volume</span>'
      : `<span class="bad">✗ ${inside.outside.toLocaleString()} samples outside the volume (red)</span>`);

  state.jobStale = true;
  updateJobUI();
}

// ---------------------------------------------------------------- compiler UI
function compile() {
  if (!state.placed) return;
  const { job, report } = compileJob({
    points: state.placed,
    colours: state.placedColours,
    volume: state.volume,
    voxelSize: state.voxelMm / 1000,
    animation: { spinDegPerSec: state.spin, durationMs: state.durationS * 1000, fps: state.fps },
    backend: 'simulation',
    name: state.model ? state.model.name : 'Untitled hologram',
  });
  const ul = $('report');
  ul.innerHTML = '';
  for (const c of report.checks) {
    const li = document.createElement('li');
    li.className = c.ok ? 'ok' : (c.severity === 'error' ? 'fail' : 'warn');
    li.textContent = c.detail;
    ul.appendChild(li);
  }
  state.job = job;
  state.jobStale = false;
  updateJobUI(report);
  updateMachineUI(device.snapshot());
}

function updateJobUI(report) {
  const st = $('jobStatus');
  const hasReport = $('report').children.length > 0;
  $('report').classList.toggle('stale', state.jobStale && hasReport);
  $('download').disabled = !state.job;
  if (!state.job) {
    if (report && !report.ok) st.textContent = 'Compile failed. Fix the items marked ✗ and compile again.';
    else if (hasReport) st.textContent = 'The last compile report is out of date. Compile again.';
    else st.textContent = 'No job compiled yet.';
    return;
  }
  st.textContent = state.jobStale
    ? `Job ${state.job.id} is out of date. Recompile after your changes.`
    : `Job ${state.job.id} · ${state.job.voxelCount.toLocaleString()} voxels · ${state.job.animation.frameCount} frames · ready to send.`;
  updateMachineUI(device.snapshot());
}

function downloadJob() {
  if (!state.job) return;
  const blob = new Blob([JSON.stringify(state.job)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.job.id}.job.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- machine UI
let lastLogLen = -1;
function fmtTime(t) { return new Date(t).toLocaleTimeString([], { hour12: false }); }

function renderLog() {
  if (device.log.length === lastLogLen) return;
  lastLogLen = device.log.length;
  const ol = $('log');
  ol.innerHTML = '';
  for (const e of device.log.slice(-60).reverse()) {
    const li = document.createElement('li');
    li.className = e.level;
    const t = document.createElement('time');
    t.textContent = fmtTime(e.t);
    li.append(t, document.createTextNode(e.message));
    ol.appendChild(li);
  }
}

function updateMachineUI(s) {
  const badge = $('stateBadge');
  badge.textContent = s.state;
  badge.className = `badge s-${s.state.toLowerCase()}`;
  $('stateInfo').textContent = s.jobId
    ? `job ${s.jobId}${s.state === STATES.RUNNING ? ` · frame ${s.frame + 1}/${s.frameCount}` : ''}`
    : (s.state === STATES.DISCONNECTED ? '' : 'no job loaded');
  const st = s.state;
  $('mConnect').textContent = st === STATES.DISCONNECTED ? 'Connect' : 'Disconnect';
  $('mConnect').disabled = st === STATES.RUNNING;
  $('mLoad').disabled = !(st === STATES.SAFE || st === STATES.READY || st === STATES.ARMED) || !state.job || state.jobStale;
  $('mPrepare').disabled = st !== STATES.SAFE || !s.interlockClosed;
  $('mArm').disabled = st !== STATES.READY || !s.jobId;
  $('mStart').disabled = st !== STATES.ARMED;
  $('mStop').disabled = st !== STATES.RUNNING;
  $('mDisarm').disabled = !(st === STATES.ARMED || st === STATES.RUNNING);
  $('mReset').disabled = st !== STATES.FAULT;
  $('mEstop').disabled = st === STATES.DISCONNECTED;
  $('interlock').checked = s.interlockClosed;
  renderLog();
}
device.onChange(updateMachineUI);

$('mConnect').onclick = () => (device.state === STATES.DISCONNECTED ? device.connect() : device.disconnect());
$('mLoad').onclick = () => { if (state.job && !state.jobStale) device.loadJob(state.job); };
$('mPrepare').onclick = () => device.prepare();
$('mArm').onclick = () => device.arm($('operator').value);
$('mStart').onclick = () => device.start();
$('mStop').onclick = () => device.stop();
$('mDisarm').onclick = () => device.disarm();
$('mEstop').onclick = () => device.emergencyStop();
$('mReset').onclick = () => device.resetFault();
$('interlock').onchange = (e) => device.setInterlock(e.target.checked);

// Show what the machine is playing: voxels from the job package itself.
function syncMachineOutput() {
  const running = device.state === STATES.RUNNING && device.job;
  if (running && machineJobId !== device.job.id) {
    const j = device.job;
    const pos = new Float32Array(j.voxelsMm.length);
    for (let i = 0; i < pos.length; i++) pos[i] = j.voxelsMm[i] / 1000;
    const col = new Float32Array(pos.length).fill(0.85);
    if (j.coloursRgb) for (let i = 0; i < col.length; i++) col[i] = j.coloursRgb[i] / 255;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(toThree(pos), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    machinePoints.geometry.dispose();
    machinePoints.geometry = geo;
    machineJobId = j.id;
  }
  machinePoints.visible = !!running;
  editorPoints.visible = !running && state.mode === 'optical';
  state.model && (state.model.wrapper.visible = !running && state.mode === 'visual');
  const banner = $('banner');
  if (running) {
    banner.textContent = `Machine output (simulated) · job ${device.job.id} · frame ${device.frame + 1}/${device.job.animation.frameCount}`;
    banner.className = 'banner machine';
    voxelMaterial.size = Math.max(device.job.voxelSizeMm / 1000 * 0.8, 0.006);
  } else {
    banner.textContent = state.mode === 'visual' ? 'Editor · visual preview' : 'Editor · optical simulation (voxels)';
    banner.className = 'banner';
    voxelMaterial.size = Math.max((state.voxelMm / 1000) * 0.8, 0.006);
  }
}

// ---------------------------------------------------------------- viewing
const triCams = VIEW_ANGLES.map(() => new THREE.PerspectiveCamera(40, 1, 0.05, 100));
function positionCameraAt(cam, angleDeg) {
  const [lx, ly, lz] = viewerPosition(angleDeg, viewDistance(), eyeHeight());
  cam.position.set(lx, lz, ly);
  cam.lookAt(0, state.volume.z / 2, 0);
}

function setView(kind, angle) {
  state.view = kind;
  $('stage').classList.toggle('tri', kind === 'tri');
  $('trilabels').hidden = kind !== 'tri';
  $('legend').hidden = kind === 'tri';
  for (const [id, on] of [['viewOrbit', kind === 'orbit' && angle === undefined], ['viewL', angle === -90], ['viewC', angle === 0], ['viewR', angle === 90], ['viewTri', kind === 'tri']]) {
    $(id).classList.toggle('on', on);
  }
  if (kind === 'orbit' && angle !== undefined) {
    positionCameraAt(camera, angle);
    controls.target.set(0, state.volume.z / 2, 0);
    controls.update();
  }
}
$('viewOrbit').onclick = () => setView('orbit');
$('viewL').onclick = () => setView('orbit', -90);
$('viewC').onclick = () => setView('orbit', 0);
$('viewR').onclick = () => setView('orbit', 90);
$('viewTri').onclick = () => setView('tri');

const MODE_NOTES = {
  visual: 'Visual preview shows the 3D model itself. It is not a prediction of what an optical engine can draw.',
  optical: 'Optical simulation shows only the voxels the compiler would send, with no lighting or surfaces. Brightness, colour and visibility on real hardware are not simulated and must be measured.',
};
function setMode(mode) {
  state.mode = mode;
  $('modeVisual').classList.toggle('on', mode === 'visual');
  $('modeOptical').classList.toggle('on', mode === 'optical');
  $('modeNote').textContent = MODE_NOTES[mode];
}
$('modeVisual').onclick = () => setMode('visual');
$('modeOptical').onclick = () => setMode('optical');

// ---------------------------------------------------------------- controls wiring
function bindRange(id, outId, onChange, fmt) {
  const el = $(id);
  const out = $(outId);
  const apply = () => { const v = parseFloat(el.value); out.textContent = fmt(v); onChange(v); };
  el.addEventListener('input', () => { apply(); dirtyPlacement = true; });
  apply();
}
bindRange('size', 'o_size', (v) => { state.size = v; }, (v) => `${v.toFixed(2)} m`);
bindRange('px', 'o_px', (v) => { state.pos[0] = v; }, (v) => `${v.toFixed(2)} m`);
bindRange('py', 'o_py', (v) => { state.pos[1] = v; }, (v) => `${v.toFixed(2)} m`);
bindRange('pz', 'o_pz', (v) => { state.pos[2] = v; }, (v) => `${v.toFixed(2)} m`);
bindRange('yaw', 'o_yaw', (v) => { state.yaw = v; }, (v) => `${v.toFixed(0)}°`);
bindRange('spin', 'o_spin', (v) => { state.spin = v; }, (v) => `${v.toFixed(0)}°/s`);
bindRange('vox', 'o_vox', (v) => { state.voxelMm = v; }, (v) => `${v.toFixed(0)} mm`);
$('samples').addEventListener('input', () => { dirtyResample = true; });
bindRange('samples', 'o_samples', (v) => { state.samples = Math.round(v); }, (v) => Math.round(v).toLocaleString());

for (const [id, key] of [['volX', 'x'], ['volY', 'y'], ['volZ', 'z']]) {
  $(id).addEventListener('input', () => {
    const v = parseFloat($(id).value);
    if (!(v > 0)) return;
    state.volume[key] = Math.min(v, 50);
    rebuildVolumeGuides();
    if (state.view !== 'tri') { /* keep user camera */ }
    dirtyPlacement = true;
  });
}
$('dur').addEventListener('input', () => {
  const v = parseFloat($('dur').value);
  if (!(v >= 1)) return;
  state.durationS = Math.min(v, 120);
  $('scrub').max = state.durationS;
  dirtyPlacement = true;
});
$('fps').addEventListener('change', () => { state.fps = parseInt($('fps').value, 10); dirtyPlacement = true; });

$('sample').addEventListener('change', () => {
  const kind = $('sample').value;
  adoptModel(buildSample(kind), $('sample').selectedOptions[0].textContent.replace('Sample: ', ''));
  dirtyPlacement = true;
});

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej));
    adoptModel(gltf.scene, f.name);
    dirtyPlacement = true;
  } catch (err) {
    $('modelInfo').textContent = `Could not import "${f.name}": ${err && err.message ? err.message : err}. GLB files with embedded data work best.`;
  }
  e.target.value = '';
});

$('compile').onclick = compile;
$('download').onclick = downloadJob;

$('play').addEventListener('change', () => { state.playing = $('play').checked; });
$('scrub').addEventListener('input', () => {
  state.playing = false;
  $('play').checked = false;
  state.previewT = parseFloat($('scrub').value);
});

// ---------------------------------------------------------------- loop
function resize() {
  const stage = $('stage');
  const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe($('stage'));

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (dirtyResample) { resample(); dirtyResample = false; dirtyPlacement = true; }
  if (dirtyPlacement) { updatePlacement(); dirtyPlacement = false; }

  device.tick(dt * 1000);
  if (state.playing) {
    state.previewT += dt;
    if (state.previewT > state.durationS) state.previewT = 0;
    $('scrub').value = state.previewT;
  }
  $('tlabel').textContent = `${state.previewT.toFixed(2)} s`;

  syncMachineOutput();
  const running = device.state === STATES.RUNNING;
  const yaw = running ? device.currentYawDeg() : state.spin * state.previewT;
  pivot.rotation.y = -(yaw * Math.PI) / 180;

  controls.update();
  const W = $('stage').clientWidth, H = $('stage').clientHeight;
  if (state.view === 'tri') {
    renderer.setScissorTest(true);
    const w = Math.floor(W / 3);
    // each pane is letterboxed to a near-square aspect so the whole volume stays in frame
    const h = Math.min(H, Math.round(w * 1.25));
    const y0 = Math.floor((H - h) / 2);
    renderer.setClearColor(0x05070d, 1);
    renderer.clear();
    triCams.forEach((cam, i) => {
      positionCameraAt(cam, VIEW_ANGLES[i]);
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
      renderer.setViewport(i * w, y0, w, h);
      renderer.setScissor(i * w, y0, w, h);
      renderer.render(scene, cam);
    });
    renderer.setScissorTest(false);
  } else {
    renderer.setViewport(0, 0, W, H);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- start
rebuildVolumeGuides();
setMode('optical');
adoptModel(buildSample('knot'), 'Torus knot');
updateMachineUI(device.snapshot());
resize();
requestAnimationFrame(frame);

// Small hook for automated checks.
window.__air = { state, device, compile, get job() { return state.job; } };
