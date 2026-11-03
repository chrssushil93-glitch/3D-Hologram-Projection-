// Radix-2 FFT (in place). Forward kernel e^{-i...}; inverse is normalised by 1/N per dimension.
const twCache = new Map();

function twiddles(n) {
  let t = twCache.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const nsin = new Float64Array(n / 2); // -sin: forward kernel imaginary part
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      nsin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    t = { cos, nsin };
    twCache.set(n, t);
  }
  return t;
}

export function isPowerOfTwo(n) { return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0; }

export function fft1d(re, im, inverse = false) {
  const n = re.length;
  if (!isPowerOfTwo(n)) throw new RangeError('FFT length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const { cos, nsin } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = inverse ? -nsin[k * step] : nsin[k * step];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** 2D FFT of an n x n field stored row-major in (re, im). */
export function fft2d(re, im, n, inverse = false) {
  for (let r = 0; r < n; r++) fft1d(re.subarray(r * n, (r + 1) * n), im.subarray(r * n, (r + 1) * n), inverse);
  const cr = new Float64Array(n), ci = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < n; r++) { cr[r] = re[r * n + c]; ci[r] = im[r * n + c]; }
    fft1d(cr, ci, inverse);
    for (let r = 0; r < n; r++) { re[r * n + c] = cr[r]; im[r * n + c] = ci[r]; }
  }
}
