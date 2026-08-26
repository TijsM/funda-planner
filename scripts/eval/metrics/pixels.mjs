/** Decoding and greyscale plumbing shared by every metric.
 *
 *  This is the ONLY file under metrics/ that touches the filesystem or a canvas.
 *  Every metric itself is a pure function over a Pixels buffer, so a metric can
 *  be exercised from a synthetic image built in a test without a PNG ever
 *  existing on disk — which is how the tests know the right answer.
 *
 *  Pixels is deliberately shaped like ImageData: { width, height, data } with
 *  RGBA bytes. getImageData() returns exactly that, so no adapter is needed on
 *  either side.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';

/** @typedef {{ width: number, height: number, data: Uint8ClampedArray }} Pixels */
/** @typedef {{ width: number, height: number, data: Float32Array }} Grey */

/** @param {string | Buffer | URL} src @returns {Promise<Pixels>} */
export async function loadPixels(src) {
  const img = await loadImage(src);
  const cv = createCanvas(img.width, img.height);
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

/** @param {Pixels} px @returns {Buffer} */
export function toPng(px) {
  const cv = createCanvas(px.width, px.height);
  const ctx = cv.getContext('2d');
  const id = ctx.createImageData(px.width, px.height);
  id.data.set(px.data);
  ctx.putImageData(id, 0, 0);
  return cv.toBuffer('image/png');
}

/** Rec. 709 luma, 0..255, kept as floats so the Sobel below never rounds twice.
 *  Alpha is composited onto white: a transparent PNG margin is background, and
 *  treating it as black would draw a false edge round the whole image.
 *  @param {Pixels} px @returns {Grey} */
export function grey(px) {
  const n = px.width * px.height;
  const out = new Float32Array(n);
  const d = px.data;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255;
    const r = d[i * 4] * a + 255 * (1 - a);
    const g = d[i * 4 + 1] * a + 255 * (1 - a);
    const b = d[i * 4 + 2] * a + 255 * (1 - a);
    out[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return { width: px.width, height: px.height, data: out };
}

/** Box-average downscale. Averaging, not sampling: a 1 px wall line survives a
 *  4x reduction as a grey smear that Sobel still finds, where nearest-neighbour
 *  drops it entirely on three rows out of four and the line score collapses for
 *  a reason that has nothing to do with the render.
 *  @param {Grey} g @param {number} maxSide @returns {{ grey: Grey, k: number }} */
export function downscaleGrey(g, maxSide) {
  const k = Math.min(1, maxSide / Math.max(g.width, g.height));
  if (k >= 1) return { grey: g, k: 1 };
  const w = Math.max(1, Math.round(g.width * k));
  const h = Math.max(1, Math.round(g.height * k));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * g.height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * g.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * g.width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * g.width) / w));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += g.data[yy * g.width + xx]; n++; }
      out[y * w + x] = s / n;
    }
  }
  /* The honest k is the one the output dimensions imply, not the requested one:
     the rounding above is what later transforms have to be scaled by. */
  return { grey: { width: w, height: h, data: out }, k: w / g.width };
}

/** @param {Grey} g @returns {Pixels} */
export function greyToPixels(g) {
  const d = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0; i < g.width * g.height; i++) {
    const v = Math.max(0, Math.min(255, g.data[i]));
    d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  return { width: g.width, height: g.height, data: d };
}

/** Sobel with 3x3 kernels, magnitude in intensity units (the /8 is the kernel's
 *  own gain, so a 255-step edge answers 255 and thresholds mean something across
 *  images of different sizes).
 *  @param {Grey} g @returns {{ mag: Float32Array, gx: Float32Array, gy: Float32Array, width: number, height: number }} */
export function sobel(g) {
  const { width: w, height: h, data } = g;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = data[i - w - 1], b = data[i - w], c = data[i - w + 1];
      const d = data[i - 1], f = data[i + 1];
      const p = data[i + w - 1], q = data[i + w], r = data[i + w + 1];
      const sx = (c + 2 * f + r - a - 2 * d - p) / 8;
      const sy = (p + 2 * q + r - a - 2 * b - c) / 8;
      gx[i] = sx; gy[i] = sy; mag[i] = Math.hypot(sx, sy);
    }
  }
  return { mag, gx, gy, width: w, height: h };
}

/** Canny's non-maximum suppression, quantised to the four 45-degree directions.
 *  Without it a 4 px wall in the render answers with a 4 px thick edge band, and
 *  lineF1's precision then measures our own blur radius rather than the render.
 *  @returns {Uint8Array} 1 where the pixel is a thinned edge above `thresh` */
export function thinEdges(s, thresh) {
  const { mag, gx, gy, width: w, height: h } = s;
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < thresh) continue;
      const ang = ((Math.atan2(gy[i], gx[i]) * 180) / Math.PI + 180) % 180;
      let a, b;
      if (ang < 22.5 || ang >= 157.5) { a = mag[i - 1]; b = mag[i + 1]; }
      else if (ang < 67.5) { a = mag[i - w + 1]; b = mag[i + w - 1]; }
      else if (ang < 112.5) { a = mag[i - w]; b = mag[i + w]; }
      else { a = mag[i - w - 1]; b = mag[i + w + 1]; }
      if (m >= a && m >= b) out[i] = 1;
    }
  }
  return out;
}
