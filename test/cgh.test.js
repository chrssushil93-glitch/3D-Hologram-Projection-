import test from 'node:test';
import assert from 'node:assert/strict';
import { fft1d, fft2d } from '../src/fft.js';
import {
  makeBench, mapJobToBench, countAliased, computeHologram, propagate, reconstructPlane,
  evaluateHologram, analyzeJob, planeDepths,
} from '../src/cgh.js';
import { compileJob } from '../src/job.js';
import { sampleTriangles, normalizePoints, placePoints, DEFAULT_VOLUME } from '../src/spatial.js';

test('fft1d matches a naive DFT and inverts cleanly', () => {
  const n = 16;
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 1.3) + i / 7);
  const im = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.4));
  const R = Float64Array.from(re), I = Float64Array.from(im);
  fft1d(R, I);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      sr += re[t] * Math.cos(a) - im[t] * Math.sin(a);
      si += re[t] * Math.sin(a) + im[t] * Math.cos(a);
    }
    assert.ok(Math.abs(R[k] - sr) < 1e-9 && Math.abs(I[k] - si) < 1e-9, `bin ${k}`);
  }
  fft1d(R, I, true);
  for (let t = 0; t < n; t++) assert.ok(Math.abs(R[t] - re[t]) < 1e-9 && Math.abs(I[t] - im[t]) < 1e-9);
  assert.throws(() => fft1d(new Float64Array(12), new Float64Array(12)));
});

test('fft2d round trip', () => {
  const n = 8;
  const re = Float64Array.from({ length: n * n }, (_, i) => Math.sin(i));
  const im = new Float64Array(n * n);
  const R = Float64Array.from(re), I = Float64Array.from(im);
  fft2d(R, I, n, false);
  fft2d(R, I, n, true);
  for (let i = 0; i < n * n; i++) assert.ok(Math.abs(R[i] - re[i]) < 1e-9 && Math.abs(I[i]) < 1e-9);
});

test('propagation conserves power and is reversible', () => {
  const bench = makeBench({ n: 64 });
  const n = bench.n;
  const re = new Float64Array(n * n), im = new Float64Array(n * n);
  for (let y = 24; y < 40; y++) for (let x = 20; x < 44; x++) { re[y * n + x] = 1; }
  const fwd = propagate(re, im, bench, 0.05);
  const power = (f) => f.re.reduce((s, v, i) => s + v * v + f.im[i] * f.im[i], 0);
  assert.ok(Math.abs(power(fwd) / power({ re, im }) - 1) < 1e-6);
  const back = propagate(fwd.re, fwd.im, bench, -0.05);
  let err = 0;
  for (let i = 0; i < n * n; i++) err = Math.max(err, Math.abs(back.re[i] - re[i]));
  assert.ok(err < 1e-6, `round-trip error ${err}`);
});

test('bench rejects non power-of-two SLM sizes', () => {
  assert.throws(() => makeBench({ n: 100 }));
});

test('a single point focuses at its pixel and depth', () => {
  const bench = makeBench({ n: 128 });
  const z = bench.zCentreM;
  const x = 20 * bench.pitchM, y = -12 * bench.pitchM;
  const pts = new Float64Array([x, y, z]);
  const phase = computeHologram(pts, bench);
  const I = reconstructPlane(phase, bench, z);
  let best = 0, bi = 0, total = 0;
  for (let i = 0; i < I.length; i++) { total += I[i]; if (I[i] > best) { best = I[i]; bi = i; } }
  const px = bi % bench.n, py = Math.floor(bi / bench.n);
  assert.equal(px, 128 / 2 + 20);
  assert.equal(py, 128 / 2 - 12);
  assert.ok(best / (total / I.length) > 100, 'sharp focus');
});

test('focus is depth selective', () => {
  // Depth of focus scales with the SLM aperture; the 256 px bench has a tight focus (measured:
  // on-axis intensity falls to ~1% of peak at 20 mm defocus, ~48% on the smaller 128 px bench).
  const bench = makeBench({ n: 256 });
  const z = bench.zCentreM;
  const phase = computeHologram(new Float64Array([0, 0, z]), bench);
  const c = 128 * 256 + 128;
  const peak = (zz) => reconstructPlane(phase, bench, zz)[c];
  assert.ok(peak(z) > 10 * peak(z + 0.02), 'defocused 20 mm away is much dimmer');
  assert.ok(peak(z) > 10 * peak(z - 0.02), 'and on the near side too');
});

test('alias check flags geometry the SLM cannot represent', () => {
  const bench = makeBench({ n: 256 });
  const ok = countAliased(new Float64Array([0, 0, bench.zCentreM]), bench);
  assert.equal(ok.aliased, 0);
  const tooClose = countAliased(new Float64Array([0, 0, 0.02]), bench);
  assert.equal(tooClose.aliased, 1);
});

test('hologram is deterministic and coarse phase levels hurt quality', () => {
  const bench = makeBench({ n: 128 });
  const pts = new Float64Array([
    0.0003, 0.0002, 0.195, -0.0004, 0.0001, 0.2, 0.0001, -0.0003, 0.205, -0.0002, -0.0004, 0.21,
  ]);
  const a = computeHologram(pts, bench), b = computeHologram(pts, bench);
  assert.deepEqual(Array.from(a), Array.from(b));
  const fine = evaluateHologram(computeHologram(pts, bench, { phaseLevels: 256 }), pts, bench);
  const coarse = evaluateHologram(computeHologram(pts, bench, { phaseLevels: 2 }), pts, bench);
  assert.ok(fine.meanPeakToMean > coarse.meanPeakToMean, `${fine.meanPeakToMean} vs ${coarse.meanPeakToMean}`);
  assert.equal(fine.detectedFraction, 1);
});

test('planeDepths spans the bench depth range', () => {
  const bench = makeBench({ n: 128 });
  const d = planeDepths(bench, 5);
  assert.equal(d.length, 5);
  assert.ok(Math.abs(d[0] - (bench.zCentreM - bench.depthSpanM / 2)) < 1e-12);
  assert.ok(Math.abs(d[4] - (bench.zCentreM + bench.depthSpanM / 2)) < 1e-12);
});

function cubeJob() {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  const { points } = normalizePoints(sampleTriangles(pos, idx, 4000, 3));
  const placed = placePoints(points, { size: 0.6, position: [0, 0, 1] });
  const { job } = compileJob({
    points: placed, volume: { ...DEFAULT_VOLUME }, voxelSize: 0.05,
    animation: { spinDegPerSec: 0, durationMs: 1000, fps: 30 }, backend: 'simulation',
  });
  return job;
}

test('job voxels map into the bench volume without aliasing', () => {
  const job = cubeJob();
  assert.ok(job, 'job compiles');
  const bench = makeBench({ n: 256 });
  const pts = mapJobToBench(job.voxelsMm, job.volume, bench, 100);
  assert.equal(pts.length / 3, 100);
  const half = bench.lateralHalfM + 1e-9;
  const zMin = bench.zCentreM - bench.depthSpanM / 2 - 1e-9, zMax = bench.zCentreM + bench.depthSpanM / 2 + 1e-9;
  for (let i = 0; i < pts.length; i += 3) {
    assert.ok(Math.abs(pts[i]) <= half && Math.abs(pts[i + 1]) <= half);
    assert.ok(pts[i + 2] >= zMin && pts[i + 2] <= zMax);
  }
  assert.equal(countAliased(pts, bench).aliased, 0);
});

test('analyzeJob forms most points of a real job', () => {
  const job = cubeJob();
  const r = analyzeJob(job, { n: 128, maxPoints: 60, planes: 5 });
  assert.equal(r.usedPoints, 60);
  assert.equal(r.aliased, 0);
  assert.equal(r.phase.length, 128 * 128);
  assert.ok(r.metrics.detectedFraction > 0.8, `detected ${r.metrics.detectedFraction}`);
  assert.ok(r.metrics.efficiency > 0 && r.metrics.efficiency < 1);
  assert.match(r.caveat, /Not a prediction/);
});
