import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  sampleTriangles, normalizePoints, placePoints, checkInsideVolume, voxelize,
  boundingBox, rotateYaw, viewerPosition, DEFAULT_VOLUME,
} from '../src/spatial.js';
import { compileJob, verifyJobChecksum, JOB_SCHEMA } from '../src/job.js';
import { SimulatedDevice, STATES } from '../src/device.js';
import { sha256Hex } from '../src/sha256.js';

// A unit cube as indexed triangles in LumaGrid coordinates.
const cubePositions = new Float32Array([
  0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
  0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
]);
const cubeIndices = new Uint16Array([
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
  1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
]);

function scenePoints(size = 1, position = [0, 0, 1], yawDeg = 0, count = 4000) {
  const raw = sampleTriangles(cubePositions, cubeIndices, count, 7);
  const { points } = normalizePoints(raw);
  return placePoints(points, { size, position, yawDeg });
}

test('sha256 matches node crypto', () => {
  for (const s of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'LumaGrid ' + 'é'.repeat(100)]) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
  }
});

test('sampling is deterministic and stays on the mesh bounds', () => {
  const a = sampleTriangles(cubePositions, cubeIndices, 500, 3);
  const b = sampleTriangles(cubePositions, cubeIndices, 500, 3);
  assert.deepEqual(Array.from(a), Array.from(b));
  const bb = boundingBox(a);
  for (let k = 0; k < 3; k++) {
    assert.ok(bb.min[k] >= -1e-6 && bb.max[k] <= 1 + 1e-6);
  }
});

test('sampling is area weighted', () => {
  // Two triangles in the z=0 plane: one with 9x the area of the other.
  const pos = new Float32Array([0, 0, 0, 3, 0, 0, 0, 3, 0, 10, 10, 0, 11, 10, 0, 10, 11, 0]);
  const pts = sampleTriangles(pos, null, 20000, 5);
  let big = 0;
  for (let i = 0; i < pts.length; i += 3) if (pts[i] < 5) big++;
  const share = big / 20000;
  assert.ok(Math.abs(share - 0.9) < 0.02, `share ${share}`);
});

test('normalizePoints centres and scales largest dimension to 1', () => {
  const raw = sampleTriangles(cubePositions, cubeIndices, 2000, 1);
  const { points, extent } = normalizePoints(raw);
  assert.ok(Math.abs(extent - 1) < 0.05);
  const bb = boundingBox(points);
  const largest = Math.max(...bb.size);
  assert.ok(Math.abs(largest - 1) < 1e-5);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs((bb.min[k] + bb.max[k]) / 2) < 1e-5);
});

test('placePoints applies size, position and yaw', () => {
  const pts = placePoints(new Float32Array([0.5, 0, 0]), { size: 2, position: [1, 2, 3], yawDeg: 90 });
  assert.ok(Math.abs(pts[0] - 1) < 1e-6);
  assert.ok(Math.abs(pts[1] - 3) < 1e-6);
  assert.ok(Math.abs(pts[2] - 3) < 1e-6);
});

test('default volume is 2 x 1 x 2 m and inside check works', () => {
  assert.deepEqual({ ...DEFAULT_VOLUME }, { x: 2, y: 1, z: 2 });
  assert.equal(checkInsideVolume(scenePoints(1, [0, 0, 1]), DEFAULT_VOLUME).ok, true);
  const tooBig = checkInsideVolume(scenePoints(1.8, [0, 0, 1]), DEFAULT_VOLUME);
  assert.equal(tooBig.ok, false); // 1.8 m cube is deeper than the 1 m depth
  assert.ok(tooBig.outside > 0);
  const belowFloor = checkInsideVolume(scenePoints(1, [0, 0, 0.2]), DEFAULT_VOLUME);
  assert.equal(belowFloor.ok, false);
});

test('voxelize reduces density and snaps to grid', () => {
  const pts = scenePoints(0.5, [0, 0, 1], 0, 20000);
  const coarse = voxelize(pts, 0.05);
  const fine = voxelize(pts, 0.01);
  assert.ok(coarse.voxels.length < fine.voxels.length);
  assert.ok(fine.voxels.length / 3 <= 20000);
  const cell = (coarse.voxels[0] / 0.05) - 0.5;
  assert.ok(Math.abs(cell - Math.round(cell)) < 1e-4);
  assert.throws(() => voxelize(pts, 0));
});

test('rotateYaw preserves height and distance from the axis', () => {
  const pts = new Float32Array([1, 0, 0.7]);
  const r = rotateYaw(pts, 90);
  assert.ok(Math.abs(r[0]) < 1e-6 && Math.abs(r[1] - 1) < 1e-6 && Math.abs(r[2] - 0.7) < 1e-6);
});

test('viewer positions cover the 180 degree arc in front of the volume', () => {
  const [lx, ly] = viewerPosition(-90, 3, 1.5);
  const [cx, cy] = viewerPosition(0, 3, 1.5);
  const [rx, ry] = viewerPosition(90, 3, 1.5);
  assert.ok(Math.abs(lx + 3) < 1e-9 && Math.abs(ly) < 1e-9);
  assert.ok(Math.abs(cx) < 1e-9 && Math.abs(cy + 3) < 1e-9);
  assert.ok(Math.abs(rx - 3) < 1e-9 && Math.abs(ry) < 1e-9);
});

const baseScene = (over = {}) => ({
  points: scenePoints(0.6, [0, 0, 1]),
  volume: { ...DEFAULT_VOLUME },
  voxelSize: 0.02,
  animation: { spinDegPerSec: 36, durationMs: 10000, fps: 30 },
  backend: 'simulation',
  name: 'cube',
  ...over,
});

test('compileJob produces a verifiable hardware-neutral package', () => {
  const { job, report } = compileJob(baseScene());
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
  assert.equal(job.schema, JOB_SCHEMA);
  assert.equal(job.animation.frameCount, 300);
  assert.equal(job.voxelsMm.length, job.voxelCount * 3);
  assert.equal(job.viewing.arcDeg, 180);
  assert.match(job.claims, /no claim/i);
  assert.equal(verifyJobChecksum(job), true);
  const tampered = { ...job, voxelsMm: job.voxelsMm.slice(0, -3) };
  assert.equal(verifyJobChecksum(tampered), false);
});

test('compileJob rejects geometry outside the volume', () => {
  const { job, report } = compileJob(baseScene({ points: scenePoints(1.8, [0, 0, 1]) }));
  assert.equal(job, null);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((c) => c.id === 'inside-volume' && !c.ok));
});

test('compileJob catches a spin that sweeps geometry out of the volume', () => {
  // 0.9 m cube fits statically (depth 1 m) but its corners swing outside when it rotates.
  const pts = scenePoints(0.9, [0, 0, 1], 0, 6000);
  assert.equal(checkInsideVolume(pts, DEFAULT_VOLUME).ok, true);
  const { job, report } = compileJob(baseScene({ points: pts }));
  assert.equal(job, null);
  assert.ok(report.checks.some((c) => c.id === 'animation-inside-volume' && !c.ok));
});

test('compileJob refuses unavailable research backends and unknown backends', () => {
  const plasma = compileJob(baseScene({ backend: 'plasma-cgh' }));
  assert.equal(plasma.job, null);
  assert.ok(plasma.report.checks.some((c) => c.id === 'backend-available' && !c.ok));
  const unknown = compileJob(baseScene({ backend: 'nope' }));
  assert.equal(unknown.job, null);
});

test('compileJob carries colours through voxelization', () => {
  const pts = scenePoints(0.6, [0, 0, 1], 0, 3000);
  const colours = new Uint8Array(pts.length).fill(200);
  const { job } = compileJob(baseScene({ points: pts, colours }));
  assert.equal(job.coloursRgb.length, job.voxelCount * 3);
});

function readyDevice() {
  const { job } = compileJob(baseScene());
  const dev = new SimulatedDevice();
  assert.equal(dev.connect().ok, true);
  assert.equal(dev.loadJob(job).ok, true);
  return { dev, job };
}

test('device follows Safe -> Ready -> Armed -> Running and back', () => {
  const { dev } = readyDevice();
  assert.equal(dev.state, STATES.SAFE);
  assert.equal(dev.snapshot().emitting, false);
  assert.equal(dev.prepare().ok, true);
  assert.equal(dev.state, STATES.READY);
  assert.equal(dev.arm('Sushil').ok, true);
  assert.equal(dev.state, STATES.ARMED);
  assert.equal(dev.start().ok, true);
  assert.equal(dev.state, STATES.RUNNING);
  assert.equal(dev.snapshot().emitting, true);
  dev.tick(5000);
  assert.equal(dev.snapshot().frame, 150);
  assert.equal(dev.currentYawDeg(), 180);
  dev.tick(6000); // loops
  assert.equal(dev.snapshot().frame, 30);
  assert.equal(dev.stop().ok, true);
  assert.equal(dev.disarm().ok, true);
  assert.equal(dev.state, STATES.READY);
});

test('device refuses out-of-order commands', () => {
  const { dev } = readyDevice();
  assert.equal(dev.start().ok, false);
  assert.equal(dev.arm('x').ok, false); // not Ready
  dev.prepare();
  assert.equal(dev.arm('').ok, false); // operator required
  assert.equal(dev.arm('   ').ok, false);
  assert.equal(dev.state, STATES.READY);
});

test('device will not arm without a job', () => {
  const dev = new SimulatedDevice();
  dev.connect();
  dev.prepare();
  const r = dev.arm('op');
  assert.equal(r.ok, false);
  assert.match(r.error, /no job/);
});

test('device rejects tampered, wrong-schema and wrong-backend jobs', () => {
  const { job } = compileJob(baseScene());
  const dev = new SimulatedDevice();
  assert.equal(dev.loadJob(job).ok, false); // not connected
  dev.connect();
  assert.equal(dev.loadJob({ ...job, voxelCount: job.voxelCount + 1 }).ok, false);
  assert.equal(dev.loadJob({ ...job, schema: 'other' }).ok, false);
  const other = new SimulatedDevice({ backend: 'plasma-cgh' });
  other.connect();
  assert.equal(other.loadJob(job).ok, false);
});

test('emergency stop always wins and needs an on-site reset', () => {
  const { dev } = readyDevice();
  dev.prepare(); dev.arm('op'); dev.start();
  assert.equal(dev.emergencyStop().ok, true);
  assert.equal(dev.state, STATES.FAULT);
  assert.equal(dev.snapshot().emitting, false);
  assert.equal(dev.start().ok, false);
  assert.equal(dev.arm('op').ok, false);
  assert.equal(dev.resetFault().ok, true);
  assert.equal(dev.state, STATES.SAFE);
  assert.equal(dev.calibrated, false); // must recalibrate
});

test('opening the interlock latches a fault and blocks reset until closed', () => {
  const { dev } = readyDevice();
  dev.prepare(); dev.arm('op'); dev.start();
  dev.setInterlock(false);
  assert.equal(dev.state, STATES.FAULT);
  assert.equal(dev.resetFault().ok, false);
  dev.setInterlock(true);
  assert.equal(dev.resetFault().ok, true);
  assert.equal(dev.state, STATES.SAFE);
});

test('cannot prepare or arm with the interlock open', () => {
  const { dev } = readyDevice();
  dev.setInterlock(false); // Safe state: no fault, but blocked
  assert.equal(dev.state, STATES.SAFE);
  assert.equal(dev.prepare().ok, false);
});

test('device keeps an audit log and notifies listeners', () => {
  const { dev } = readyDevice();
  let calls = 0;
  const off = dev.onChange(() => calls++);
  dev.prepare();
  assert.ok(calls > 0);
  off();
  const before = calls;
  dev.arm('op');
  assert.equal(calls, before);
  assert.ok(dev.log.length >= 4);
  assert.ok(dev.log.some((l) => /Armed by op/.test(l.message)));
});
