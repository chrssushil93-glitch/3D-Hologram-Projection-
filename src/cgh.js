// LumaGrid AIR - Computer-generated hologram (CGH) bench simulation.
//
// Turns the voxels of a compiled job into a phase-only hologram for an idealised spatial light
// modulator (SLM), then numerically propagates the light to check what the hologram would form.
//
// This is a SIMULATION of an optical bench, not a model of any real machine:
//  - the SLM is ideal (perfect phase response, no pixel crosstalk, no zero-order or noise terms)
//  - illumination is a perfect, uniform plane wave
//  - the job's metre-scale volume is mapped onto a millimetre-scale bench volume (see makeBench)
// Metrics describe how well the algorithm can focus light on the requested points under those
// assumptions. They say nothing about brightness, safety or visibility of a physical display.
import { fft2d, isPowerOfTwo } from './fft.js';

const TWO_PI = 2 * Math.PI;

/**
 * Bench geometry. Optical axis = LumaGrid Y (depth). Bench x = LumaGrid X, bench y = LumaGrid Z
 * (measured from the volume's mid-height). The SLM is at depth 0; points sit at zCentre +- depthSpan/2.
 * Defaults keep the whole scene below the SLM's Nyquist diffraction angle.
 */
export function makeBench({
  n = 256,
  pitchM = 12.5e-6,
  wavelengthM = 532e-9,
  zCentreM = 0.2,
  depthSpanM = 0.02,
} = {}) {
  if (!isPowerOfTwo(n)) throw new RangeError('SLM size n must be a power of two');
  const apertureHalf = (n * pitchM) / 2;
  return { n, pitchM, wavelengthM, zCentreM, depthSpanM, lateralHalfM: apertureHalf * 0.5 };
}

/** Map job voxels (millimetres, LumaGrid axes) to bench points [x, y, z] in metres. */
export function mapJobToBench(voxelsMm, volume, bench, maxPoints = Infinity) {
  const total = Math.floor(voxelsMm.length / 3);
  const stride = total > maxPoints ? total / maxPoints : 1;
  const count = Math.min(total, maxPoints);
  const s = bench.lateralHalfM / Math.max(volume.x / 2, volume.z / 2);
  const out = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const src = Math.min(total - 1, Math.floor(i * stride)) * 3;
    const xm = voxelsMm[src] / 1000, ym = voxelsMm[src + 1] / 1000, zm = voxelsMm[src + 2] / 1000;
    out[i * 3] = xm * s;
    out[i * 3 + 1] = (zm - volume.z / 2) * s;
    out[i * 3 + 2] = bench.zCentreM + (ym / volume.y) * bench.depthSpanM;
  }
  return out;
}

/** Points whose hologram fringes are finer than the SLM can display (they alias). */
export function countAliased(points, bench) {
  const { n, pitchM, wavelengthM } = bench;
  const half = (n * pitchM) / 2;
  const limit = wavelengthM / (2 * pitchM); // max sin(theta) the pixel pitch can represent
  let aliased = 0;
  for (let j = 0; j < points.length; j += 3) {
    const x = points[j], y = points[j + 1], z = points[j + 2];
    const dx = Math.abs(x) + half, dy = Math.abs(y) + half;
    const rho = Math.hypot(dx, dy);
    if (rho / Math.hypot(rho, z) > limit) aliased++;
  }
  return { aliased, maxSinTheta: limit };
}

/**
 * Point-source (zone-plate superposition) phase hologram: the conjugate field of every target point
 * is summed on the SLM plane and only the phase is kept. Returns phase in [-pi, pi), row-major.
 */
export function computeHologram(points, bench, { phaseLevels = 256 } = {}) {
  const { n, pitchM: p, wavelengthM } = bench;
  const k = TWO_PI / wavelengthM;
  const re = new Float64Array(n * n), im = new Float64Array(n * n);
  const xs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = (i - n / 2) * p;
  for (let j = 0; j < points.length; j += 3) {
    const xj = points[j], yj = points[j + 1], zj = points[j + 2];
    const z2 = zj * zj;
    for (let iy = 0; iy < n; iy++) {
      const dy = xs[iy] - yj;
      const dy2 = dy * dy + z2;
      const row = iy * n;
      for (let ix = 0; ix < n; ix++) {
        const dx = xs[ix] - xj;
        const ph = -k * (Math.sqrt(dx * dx + dy2) - zj); // converging wave toward the point
        re[row + ix] += Math.cos(ph);
        im[row + ix] += Math.sin(ph);
      }
    }
  }
  const phase = new Float32Array(n * n);
  for (let i = 0; i < phase.length; i++) {
    let a = Math.atan2(im[i], re[i]);
    if (phaseLevels > 0 && phaseLevels < 65536) {
      const q = Math.round(((a + Math.PI) / TWO_PI) * phaseLevels) % phaseLevels;
      a = (q / phaseLevels) * TWO_PI - Math.PI;
    }
    phase[i] = a;
  }
  return phase;
}

/** Angular-spectrum propagation of a complex field by distance z. Returns new { re, im }. */
export function propagate(re, im, bench, z) {
  const { n, pitchM: p, wavelengthM: lambda } = bench;
  const R = Float64Array.from(re), I = Float64Array.from(im);
  fft2d(R, I, n, false);
  const k = TWO_PI / lambda, df = 1 / (n * p);
  for (let iy = 0; iy < n; iy++) {
    const fy = (iy < n / 2 ? iy : iy - n) * df;
    for (let ix = 0; ix < n; ix++) {
      const fx = (ix < n / 2 ? ix : ix - n) * df;
      const a = (lambda * fx) ** 2 + (lambda * fy) ** 2;
      const idx = iy * n + ix;
      if (a >= 1) { R[idx] = 0; I[idx] = 0; continue; } // evanescent
      const ph = k * z * Math.sqrt(1 - a);
      const c = Math.cos(ph), s = Math.sin(ph);
      const r = R[idx], i = I[idx];
      R[idx] = r * c - i * s;
      I[idx] = r * s + i * c;
    }
  }
  fft2d(R, I, n, true);
  return { re: R, im: I };
}

/** Intensity |U|^2 at depth z for a phase-only hologram lit by a unit plane wave. */
export function reconstructPlane(phase, bench, z) {
  const n2 = phase.length;
  const re = new Float64Array(n2), im = new Float64Array(n2);
  for (let i = 0; i < n2; i++) { re[i] = Math.cos(phase[i]); im[i] = Math.sin(phase[i]); }
  const f = propagate(re, im, bench, z);
  const out = new Float32Array(n2);
  for (let i = 0; i < n2; i++) out[i] = f.re[i] * f.re[i] + f.im[i] * f.im[i];
  return out;
}

/** Depth planes (metres) used to check the reconstruction. */
export function planeDepths(bench, planes = 9) {
  const zMin = bench.zCentreM - bench.depthSpanM / 2;
  const step = planes > 1 ? bench.depthSpanM / (planes - 1) : 0;
  return Array.from({ length: planes }, (_, i) => zMin + i * step);
}

/**
 * Score the hologram: for every target point, take the brightest pixel (3x3) on its depth plane and
 * compare to the plane's mean intensity. A point counts as formed when that ratio is >= detectAt.
 */
export function evaluateHologram(phase, points, bench, { planes = 9, detectAt = 5 } = {}) {
  const { n, pitchM: p } = bench;
  const depths = planeDepths(bench, planes);
  const zMin = depths[0];
  const step = planes > 1 ? bench.depthSpanM / (planes - 1) : 1;
  const byPlane = new Map();
  for (let j = 0; j < points.length; j += 3) {
    const idx = planes > 1 ? Math.max(0, Math.min(planes - 1, Math.round((points[j + 2] - zMin) / step))) : 0;
    if (!byPlane.has(idx)) byPlane.set(idx, []);
    byPlane.get(idx).push(j);
  }
  const ratios = [];
  let effNum = 0, effDen = 0;
  const perPlane = [];
  for (const [idx, list] of [...byPlane.entries()].sort((a, b) => a[0] - b[0])) {
    const I = reconstructPlane(phase, bench, depths[idx]);
    let total = 0;
    for (let i = 0; i < I.length; i++) total += I[i];
    const mean = total / I.length;
    const lit = new Set();
    const planeRatios = [];
    for (const j of list) {
      const cx = Math.round(points[j] / p + n / 2), cy = Math.round(points[j + 1] / p + n / 2);
      let peak = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        lit.add(y * n + x);
        if (I[y * n + x] > peak) peak = I[y * n + x];
      }
      planeRatios.push(peak / mean);
    }
    let litPower = 0;
    for (const i of lit) litPower += I[i];
    effNum += litPower; effDen += total;
    ratios.push(...planeRatios);
    perPlane.push({ index: idx, zM: depths[idx], points: list.length, meanRatio: avg(planeRatios) });
  }
  ratios.sort((a, b) => a - b);
  return {
    points: ratios.length,
    meanPeakToMean: avg(ratios),
    medianPeakToMean: ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0,
    minPeakToMean: ratios.length ? ratios[0] : 0,
    detectedFraction: ratios.length ? ratios.filter((r) => r >= detectAt).length / ratios.length : 0,
    detectAt,
    // share of the light that lands on the target pixels (3x3 around each point) on its own plane
    efficiency: effDen ? effNum / effDen : 0,
    perPlane,
  };
}

function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

/** Full pipeline for a compiled job package. */
export function analyzeJob(job, { n = 256, maxPoints = 250, phaseLevels = 256, planes = 9 } = {}) {
  const bench = makeBench({ n });
  const points = mapJobToBench(job.voxelsMm, job.volume, bench, maxPoints);
  const usedPoints = points.length / 3;
  const alias = countAliased(points, bench);
  const t0 = Date.now();
  const phase = computeHologram(points, bench, { phaseLevels });
  const metrics = evaluateHologram(phase, points, bench, { planes });
  return {
    bench, phase, points, usedPoints,
    totalVoxels: job.voxelCount,
    phaseLevels,
    aliased: alias.aliased,
    planeDepths: planeDepths(bench, planes),
    metrics,
    computeMs: Date.now() - t0,
    caveat: 'Ideal-SLM simulation on a scaled bench volume. Not a prediction of any physical display.',
  };
}

/** 8-bit greyscale of the phase pattern (0..2pi -> 0..255). */
export function phaseToGray(phase) {
  const out = new Uint8ClampedArray(phase.length);
  for (let i = 0; i < phase.length; i++) out[i] = Math.round(((phase[i] + Math.PI) / TWO_PI) * 255);
  return out;
}

/** 8-bit greyscale of an intensity plane, scaled to its peak with a square-root curve for visibility. */
export function intensityToGray(I) {
  let max = 0;
  for (let i = 0; i < I.length; i++) if (I[i] > max) max = I[i];
  const out = new Uint8ClampedArray(I.length);
  if (max <= 0) return out;
  for (let i = 0; i < I.length; i++) out[i] = Math.round(255 * Math.sqrt(I[i] / max));
  return out;
}
