// LumaGrid AIR - Spatial engine.
// Coordinate model (LumaGrid internal): X = width, Y = depth, Z = height. Units: metres.
// The volume is centred on X and Y (origin at the middle of the floor plane) and spans Z from 0 to height.

export const DEFAULT_VOLUME = Object.freeze({ x: 2, y: 1, z: 2 }); // 2 x 1 x 2 m (width x depth x height)

export function mulberry32(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Area-weighted random surface sampling of a triangle mesh.
 * @param {ArrayLike<number>} positions flat xyz array (already in LumaGrid coordinates)
 * @param {ArrayLike<number>|null} indices triangle index list, or null for non-indexed triangles
 * @param {number} count number of points to produce
 * @returns {Float32Array} flat xyz points
 */
export function sampleTriangles(positions, indices, count, seed = 1) {
  const triCount = indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);
  const out = new Float32Array(count * 3);
  if (triCount === 0 || count <= 0) return new Float32Array(0);

  const vert = (tri, k) => {
    const i = indices ? indices[tri * 3 + k] : tri * 3 + k;
    return [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  };

  const cum = new Float64Array(triCount);
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    const a = vert(t, 0), b = vert(t, 1), c = vert(t, 2);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    total += 0.5 * Math.hypot(cx, cy, cz);
    cum[t] = total;
  }
  if (total === 0) return new Float32Array(0);

  const rand = mulberry32(seed);
  for (let n = 0; n < count; n++) {
    const target = rand() * total;
    let lo = 0, hi = triCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid + 1; else hi = mid;
    }
    const a = vert(lo, 0), b = vert(lo, 1), c = vert(lo, 2);
    let r1 = rand(), r2 = rand();
    if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
    const r3 = 1 - r1 - r2;
    out[n * 3] = a[0] * r3 + b[0] * r1 + c[0] * r2;
    out[n * 3 + 1] = a[1] * r3 + b[1] * r1 + c[1] * r2;
    out[n * 3 + 2] = a[2] * r3 + b[2] * r1 + c[2] * r2;
  }
  return out;
}

/** Total surface area of a triangle mesh (same input conventions as sampleTriangles). */
export function meshArea(positions, indices) {
  const triCount = indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    const ia = indices ? indices[t * 3] : t * 3;
    const ib = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const ic = indices ? indices[t * 3 + 2] : t * 3 + 2;
    const ux = positions[ib * 3] - positions[ia * 3], uy = positions[ib * 3 + 1] - positions[ia * 3 + 1], uz = positions[ib * 3 + 2] - positions[ia * 3 + 2];
    const vx = positions[ic * 3] - positions[ia * 3], vy = positions[ic * 3 + 1] - positions[ia * 3 + 1], vz = positions[ic * 3 + 2] - positions[ia * 3 + 2];
    total += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return total;
}

export function boundingBox(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = points[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Centre points on their bounding box and scale so the largest dimension is exactly 1. */
export function normalizePoints(points) {
  if (points.length === 0) return { points: new Float32Array(0), extent: 0 };
  const { min, max, size } = boundingBox(points);
  const extent = Math.max(size[0], size[1], size[2]) || 1;
  const out = new Float32Array(points.length);
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
  for (let i = 0; i < points.length; i += 3) {
    out[i] = (points[i] - cx) / extent;
    out[i + 1] = (points[i + 1] - cy) / extent;
    out[i + 2] = (points[i + 2] - cz) / extent;
  }
  return { points: out, extent };
}

/**
 * Place unit-normalised points in the volume.
 * @param {Float32Array} unit normalised points (largest dimension = 1)
 * @param {{size:number, position:[number,number,number], yawDeg?:number}} t size = largest object dimension in metres;
 *        position = object centre in volume coordinates; yawDeg = rotation about the vertical (Z) axis.
 */
export function placePoints(unit, { size = 1, position = [0, 0, 1], yawDeg = 0 } = {}) {
  const out = new Float32Array(unit.length);
  const yaw = (yawDeg * Math.PI) / 180;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (let i = 0; i < unit.length; i += 3) {
    const x = unit[i] * size, y = unit[i + 1] * size, z = unit[i + 2] * size;
    out[i] = x * c - y * s + position[0];
    out[i + 1] = x * s + y * c + position[1];
    out[i + 2] = z + position[2];
  }
  return out;
}

/** Volume bounds in LumaGrid coordinates. */
export function volumeBounds(volume) {
  return {
    min: [-volume.x / 2, -volume.y / 2, 0],
    max: [volume.x / 2, volume.y / 2, volume.z],
  };
}

/** Count points that fall outside the display volume. */
export function checkInsideVolume(points, volume) {
  const { min, max } = volumeBounds(volume);
  const eps = 1e-6;
  let outside = 0;
  const n = points.length / 3;
  for (let i = 0; i < points.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = points[i + k];
      if (v < min[k] - eps || v > max[k] + eps) { outside++; break; }
    }
  }
  return { total: n, outside, inside: n - outside, ok: outside === 0 && n > 0 };
}

/**
 * Reduce points to one voxel per grid cell (geometry density control).
 * @returns {{voxels:Float32Array, indexMap:Uint32Array}} voxel centres and, for each kept voxel, the index of the source point
 */
export function voxelize(points, voxelSize) {
  if (!(voxelSize > 0)) throw new RangeError('voxelSize must be > 0');
  const seen = new Map();
  const keep = [];
  for (let i = 0; i < points.length; i += 3) {
    const gx = Math.floor(points[i] / voxelSize);
    const gy = Math.floor(points[i + 1] / voxelSize);
    const gz = Math.floor(points[i + 2] / voxelSize);
    const key = `${gx},${gy},${gz}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      keep.push(i / 3);
    }
  }
  const voxels = new Float32Array(keep.length * 3);
  keep.forEach((src, n) => {
    voxels[n * 3] = (Math.floor(points[src * 3] / voxelSize) + 0.5) * voxelSize;
    voxels[n * 3 + 1] = (Math.floor(points[src * 3 + 1] / voxelSize) + 0.5) * voxelSize;
    voxels[n * 3 + 2] = (Math.floor(points[src * 3 + 2] / voxelSize) + 0.5) * voxelSize;
  });
  return { voxels, indexMap: Uint32Array.from(keep) };
}

/** Rotate points about the vertical axis through (cx, cy). Used for animation frames. */
export function rotateYaw(points, deg, cx = 0, cy = 0) {
  const out = new Float32Array(points.length);
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i] - cx, y = points[i + 1] - cy;
    out[i] = x * c - y * s + cx;
    out[i + 1] = x * s + y * c + cy;
    out[i + 2] = points[i + 2];
  }
  return out;
}

/** Viewer position on the 180-degree arc. Angle 0 = straight in front (viewer at -Y looking toward +Y). */
export function viewerPosition(angleDeg, distance, eyeHeight, centre = [0, 0]) {
  const a = (angleDeg * Math.PI) / 180;
  return [centre[0] + distance * Math.sin(a), centre[1] - distance * Math.cos(a), eyeHeight];
}

export const VIEW_ANGLES = Object.freeze([-90, 0, 90]);
