/** METRIC 6 — phashDistance: a tripwire, never a target.
 *
 *  WHAT IT MEASURES  Hamming distance between the perceptual hashes of two
 *  images: greyscale, 32x32, DCT-II, the low-frequency 8x8 block thresholded at
 *  its own median. Classic pHash, so the numbers mean what they mean everywhere
 *  else, except that the DC term is dropped rather than thresholded — 63
 *  informative bits, and a distance of 0..63.
 *
 *  GOOD/BAD do not apply — it has no good direction. It answers one question
 *  about two renders taken at the SAME SEED: did the change we just made change
 *  the picture at all? 0 means we shipped a no-op and the scorecard's movement
 *  is noise. Under about 10 is a crop, a recompression or a small edit; over
 *  about 25 is a different picture.
 *
 *  NEVER OPTIMISE IT. Driving a hash distance up or down is trivial and means
 *  nothing about whether the plan came out right; it is here so that a prompt
 *  tweak that quietly did nothing is visible in one line instead of being
 *  argued about from thumbnails.
 *
 *  SPEED  ~15 ms per image.
 */

import { grey, downscaleGrey } from './pixels.mjs';

/** @typedef {import('./pixels.mjs').Pixels} Pixels */

const N = 32;

/** Cosine basis for a 32-point DCT-II, built once. Recomputing it inside the
 *  transform is 90% of the runtime of this metric. */
const COS = (() => {
  const t = new Float64Array(N * N);
  for (let u = 0; u < N; u++) for (let x = 0; x < N; x++) t[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  return t;
})();

/** Force to exactly N x N by box-averaging, whatever the aspect ratio. Aspect is
 *  deliberately thrown away: a 1024x768 render and the same picture at 512x384
 *  must hash identically or the tripwire fires on a resize. */
function squash(g) {
  const out = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    const y0 = Math.floor((y * g.height) / N), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * g.height) / N));
    for (let x = 0; x < N; x++) {
      const x0 = Math.floor((x * g.width) / N), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * g.width) / N));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += g.data[yy * g.width + xx]; n++; }
      out[y * N + x] = s / n;
    }
  }
  return out;
}

/** @param {Pixels} px @returns {Uint8Array} 63 bits, one per byte */
export function phash(px) {
  /* Downscale before squashing so the 32x32 box average is over a manageable
     number of source pixels rather than a million per cell. */
  const { grey: g } = downscaleGrey(grey(px), 256);
  const a = squash(g);

  const rows = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < N; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += a[y * N + x] * COS[u * N + x];
      rows[y * N + u] = s;
    }
  }
  const dct = new Float64Array(N * N);
  for (let u = 0; u < N; u++) {
    for (let v = 0; v < N; v++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rows[y * N + u] * COS[v * N + y];
      dct[v * N + u] = s;
    }
  }

  const vals = [];
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) if (u || v) vals.push(dct[v * N + u]);
  /* The DC term is left out before taking the median: it carries the image's
     overall brightness and dwarfs every other coefficient, so including it puts
     the threshold miles above all 63 of the terms that actually carry shape. */
  const sorted = [...vals].sort((p, q) => p - q);
  const med = sorted[31];   /* 63 values, so the middle one is an element, not a mean */

  const bits = new Uint8Array(63);
  for (let i = 0; i < 63; i++) bits[i] = vals[i] > med ? 1 : 0;
  return bits;
}

/** @param {Pixels | Uint8Array} a @param {Pixels | Uint8Array} b @returns {number} 0..63 */
export function phashDistance(a, b) {
  const ha = a instanceof Uint8Array ? a : phash(a);
  const hb = b instanceof Uint8Array ? b : phash(b);
  let d = 0;
  for (let i = 0; i < ha.length; i++) if (ha[i] !== hb[i]) d++;
  return d;
}
