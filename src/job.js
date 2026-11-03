// LumaGrid AIR - Spatial compiler and hardware-neutral job package.
import { sha256Hex } from './sha256.js';
import { checkInsideVolume, voxelize, rotateYaw } from './spatial.js';

export const JOB_SCHEMA = 'lumagrid.air.job/0.1';

/**
 * Optical backends known to the platform. Only the simulation backend is executable today.
 * No physical performance figures are claimed for the experimental backends: they must come from
 * measured results on validated hardware.
 */
export const BACKENDS = Object.freeze({
  simulation: {
    id: 'simulation',
    label: 'Virtual machine (simulation)',
    available: true,
    maxVoxelsPerFrame: 200000,
    colourChannels: ['R', 'G', 'B'],
    note: 'Software-only. Says nothing about what a physical optical engine can achieve.',
  },
  'plasma-cgh': {
    id: 'plasma-cgh',
    label: 'Plasma voxels + CGH (research)',
    available: false,
    maxVoxelsPerFrame: null,
    colourChannels: [],
    note: 'Research-stage. Needs a validated optical engine, laser-safety engineering and a vendor adapter.',
  },
  'slm-cgh': {
    id: 'slm-cgh',
    label: 'SLM computer-generated hologram (research)',
    available: false,
    maxVoxelsPerFrame: null,
    colourChannels: [],
    note: 'Research-stage. Needs an SLM adapter and calibration data.',
  },
});

const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Compile a placed scene into a hardware-neutral job package.
 * @param {object} scene
 * @param {Float32Array} scene.points placed points (LumaGrid coordinates, metres)
 * @param {Uint8Array} [scene.colours] optional rgb per point (0-255)
 * @param {{x:number,y:number,z:number}} scene.volume
 * @param {number} scene.voxelSize metres
 * @param {{spinDegPerSec:number, durationMs:number, fps:number}} scene.animation
 * @param {string} [scene.backend]
 * @param {string} [scene.name]
 * @returns {{job:object|null, report:object}}
 */
export function compileJob(scene) {
  const backend = BACKENDS[scene.backend || 'simulation'];
  const checks = [];
  const add = (id, ok, detail, severity = 'error') => checks.push({ id, ok, detail, severity: ok ? 'info' : severity });

  add('backend-known', !!backend, backend ? backend.label : `Unknown backend "${scene.backend}"`);
  if (!backend) return { job: null, report: { ok: false, checks } };
  add('backend-available', backend.available, backend.available ? 'Backend can execute jobs' : backend.note);

  const anim = { spinDegPerSec: 0, durationMs: 10000, fps: 30, ...(scene.animation || {}) };
  add('animation-valid', anim.fps > 0 && anim.fps <= 120 && anim.durationMs > 0, `${anim.fps} fps, ${anim.durationMs} ms`);

  const inside = checkInsideVolume(scene.points, scene.volume);
  add('geometry-present', inside.total > 0, `${inside.total} source points`);
  add('inside-volume', inside.outside === 0, inside.outside === 0 ? 'All points inside the volume' : `${inside.outside} points outside the volume`);

  // Animated rotation sweeps points around the vertical axis: check the worst case too.
  let animOutside = 0;
  if (inside.total > 0 && anim.spinDegPerSec !== 0) {
    const sweep = Math.min(360, Math.abs(anim.spinDegPerSec) * anim.durationMs / 1000);
    const steps = Math.max(2, Math.ceil(sweep / 15) + 1);
    for (let s = 0; s < steps; s++) {
      const deg = (sweep * s) / (steps - 1) * Math.sign(anim.spinDegPerSec);
      animOutside = Math.max(animOutside, checkInsideVolume(rotateYaw(scene.points, deg), scene.volume).outside);
    }
    add('animation-inside-volume', animOutside === 0, animOutside === 0 ? 'Spin stays inside the volume' : `Spin pushes up to ${animOutside} points outside the volume`);
  }

  const voxelSize = scene.voxelSize;
  add('voxel-size', voxelSize > 0, `${voxelSize} m`);
  if (!(voxelSize > 0) || inside.total === 0) return { job: null, report: { ok: false, checks } };

  const { voxels, indexMap } = voxelize(scene.points, voxelSize);
  const maxV = backend.maxVoxelsPerFrame;
  add('voxel-budget', maxV == null ? false : voxels.length / 3 <= maxV,
    maxV == null ? 'Backend has no measured voxel budget' : `${voxels.length / 3} voxels (limit ${maxV})`);

  const mm = new Int32Array(voxels.length);
  for (let i = 0; i < voxels.length; i++) mm[i] = Math.round(voxels[i] * 1000);

  let colours = null;
  if (scene.colours && scene.colours.length === scene.points.length) {
    colours = new Uint8Array(indexMap.length * 3);
    indexMap.forEach((src, n) => {
      colours[n * 3] = scene.colours[src * 3];
      colours[n * 3 + 1] = scene.colours[src * 3 + 1];
      colours[n * 3 + 2] = scene.colours[src * 3 + 2];
    });
  }
  if (colours) add('colour-channels', backend.colourChannels.length === 3, `RGB requested; backend channels: ${backend.colourChannels.join('') || 'none'}`);

  const frameCount = Math.max(1, Math.round((anim.durationMs / 1000) * anim.fps));
  const payload = {
    schema: JOB_SCHEMA,
    name: scene.name || 'Untitled hologram',
    backend: backend.id,
    volume: { x: scene.volume.x, y: scene.volume.y, z: scene.volume.z, unit: 'm', axes: 'X=width, Y=depth, Z=height' },
    voxelSizeMm: round(voxelSize * 1000, 3),
    voxelCount: voxels.length / 3,
    voxelsMm: Array.from(mm),
    coloursRgb: colours ? Array.from(colours) : null,
    animation: {
      type: 'yaw-spin',
      spinDegPerSec: round(anim.spinDegPerSec, 3),
      fps: anim.fps,
      durationMs: anim.durationMs,
      frameCount,
      pivotMm: [0, 0],
    },
    viewing: { arcDeg: 180, checkAnglesDeg: [-90, 0, 90], environment: 'night' },
    claims: 'This job describes geometry only. It makes no claim about brightness, colour, size or visibility on any physical display.',
  };

  const checksum = sha256Hex(JSON.stringify(payload));
  const job = { ...payload, id: `air-${checksum.slice(0, 12)}`, checksum, createdAt: new Date().toISOString() };

  const errors = checks.filter((c) => !c.ok && c.severity === 'error');
  return {
    job: errors.length === 0 ? job : null,
    report: { ok: errors.length === 0, voxelCount: job.voxelCount, frameCount, checks, jobPreview: errors.length ? job : undefined },
  };
}

/** Recompute a job's checksum to verify integrity (device side). */
export function verifyJobChecksum(job) {
  const { id, checksum, createdAt, ...payload } = job;
  const actual = sha256Hex(JSON.stringify(payload));
  return actual === checksum;
}
