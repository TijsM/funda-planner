/** Binary rasters and the geometry that turns the ground-truth sidecar's vector
 *  polygons into them. Pure: arrays in, arrays out, no canvas, no filesystem.
 *
 *  We hold the truth as vectors and never have to extract it from the input, so
 *  every "did the render keep this shape" question reduces to rasterising a
 *  polygon here and comparing masks. Keeping that in one file means one scanline
 *  rule and one fill convention rather than four subtly different ones.
 */

/** @typedef {{ width: number, height: number, data: Uint8Array }} Mask */
/** @typedef {[number, number][]} Poly */
/** Maps truth-frame pixels onto render pixels: render = truth * scale + (dx, dy). */
/** @typedef {{ dx: number, dy: number, scale: number }} Transform */

export const IDENTITY = { dx: 0, dy: 0, scale: 1 };

/** @param {number} w @param {number} h @returns {Mask} */
export function newMask(w, h) {
  return { width: w, height: h, data: new Uint8Array(w * h) };
}

/** @param {Transform} t @param {Poly} poly @returns {Poly} */
export function mapPoly(t, poly) {
  return poly.map(([x, y]) => [x * t.scale + t.dx, y * t.scale + t.dy]);
}

/** Even-odd scanline fill, sampling at pixel centres. Even-odd rather than
 *  non-zero because a plan's polygons arrive from the editor with no winding
 *  discipline at all — a room traced clockwise and one traced anticlockwise must
 *  both fill.
 *  @param {Mask} m @param {Poly} poly */
export function fillPoly(m, poly) {
  const n = poly.length;
  if (n < 3) return m;
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of poly) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const y0 = Math.max(0, Math.ceil(minY - 0.5)), y1 = Math.min(m.height - 1, Math.floor(maxY - 0.5));
  const xs = [];
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % n];
      if (ay === by) continue;
      /* Half-open in y so a vertex exactly on the scanline is counted once, not
         twice — the classic double-count that leaves horizontal seams unfilled. */
      if ((cy >= ay && cy < by) || (cy >= by && cy < ay)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const sx = Math.max(0, Math.ceil(xs[i] - 0.5)), ex = Math.min(m.width - 1, Math.floor(xs[i + 1] - 0.5));
      for (let x = sx; x <= ex; x++) m.data[y * m.width + x] = 1;
    }
  }
  return m;
}

/** @param {Mask} m @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} r radius in px */
export function strokeLine(m, x0, y0, x1, y1, r = 0.5) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len));
  const ri = Math.max(0, Math.round(r - 0.5));
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + ((x1 - x0) * s) / steps), y = Math.round(y0 + ((y1 - y0) * s) / steps);
    for (let dy = -ri; dy <= ri; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= m.height) continue;
      for (let dx = -ri; dx <= ri; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= m.width) continue;
        m.data[yy * m.width + xx] = 1;
      }
    }
  }
  return m;
}

/** @param {Mask} m @param {Poly} poly @param {number} r */
export function strokePoly(m, poly, r = 0.5) {
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    strokeLine(m, ax, ay, bx, by, r);
  }
  return m;
}

/** @param {Mask} m @returns {number} */
export function countMask(m) {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i];
  return n;
}

/** Two masks ON THE SAME GRID. Thrown rather than tolerated: the loop below walks
 *  one flat index through both, so two masks of different dimensions compare
 *  row 0 of one against a diagonal smear of the other and return a plausible
 *  number for it — two identical 50x50 squares, one on a 100x100 grid and one on
 *  a 50x50 grid, scored 0.333 instead of 1. A silently wrong IoU is the one
 *  failure this whole file cannot afford.
 *  @param {Mask} a @param {Mask} b @returns {number} 0..1, and 0 when both are empty */
export function iouOfMasks(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`iouOfMasks: ${a.width}x${a.height} against ${b.width}x${b.height}`);
  }
  let inter = 0, uni = 0;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i], y = b.data[i];
    if (x & y) inter++;
    if (x | y) uni++;
  }
  return uni === 0 ? 0 : inter / uni;
}

/** @param {Mask} m @returns {{ area: number, cx: number, cy: number }} */
export function moments(m) {
  let area = 0, sx = 0, sy = 0;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (!m.data[y * m.width + x]) continue;
      area++; sx += x + 0.5; sy += y + 0.5;
    }
  }
  return area ? { area, cx: sx / area, cy: sy / area } : { area: 0, cx: m.width / 2, cy: m.height / 2 };
}

/** 4-connected flood fill from a seed over pixels where `passable(i)` holds.
 *  An explicit stack of indices, not recursion: a 1 MP room blows the call
 *  stack long before it finishes.
 *  @param {number} w @param {number} h @param {number} sx @param {number} sy
 *  @param {(i: number) => boolean} passable @returns {Mask} */
export function floodFill(w, h, sx, sy, passable) {
  const out = newMask(w, h);
  const s0 = Math.round(sy) * w + Math.round(sx);
  if (Math.round(sx) < 0 || Math.round(sx) >= w || Math.round(sy) < 0 || Math.round(sy) >= h) return out;
  if (!passable(s0)) return out;
  const stack = new Int32Array(w * h);
  let top = 0;
  stack[top++] = s0;
  out.data[s0] = 1;
  while (top > 0) {
    const i = stack[--top];
    const x = i % w, y = (i - x) / w;
    if (x > 0 && !out.data[i - 1] && passable(i - 1)) { out.data[i - 1] = 1; stack[top++] = i - 1; }
    if (x < w - 1 && !out.data[i + 1] && passable(i + 1)) { out.data[i + 1] = 1; stack[top++] = i + 1; }
    if (y > 0 && !out.data[i - w] && passable(i - w)) { out.data[i - w] = 1; stack[top++] = i - w; }
    if (y < h - 1 && !out.data[i + w] && passable(i + w)) { out.data[i + w] = 1; stack[top++] = i + w; }
  }
  return out;
}

/** @param {Mask} m @returns {Mask} the largest 4-connected component, or an empty mask */
export function largestComponent(m) {
  const { width: w, height: h, data } = m;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best = null, bestN = 0;
  for (let s = 0; s < data.length; s++) {
    if (!data[s] || seen[s]) continue;
    let top = 0, n = 0;
    const members = [];
    stack[top++] = s; seen[s] = 1;
    while (top > 0) {
      const i = stack[--top];
      members.push(i); n++;
      const x = i % w, y = (i - x) / w;
      if (x > 0 && data[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && data[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && data[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && data[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    if (n > bestN) { bestN = n; best = members; }
  }
  const out = newMask(w, h);
  if (best) for (const i of best) out.data[i] = 1;
  return out;
}

/** Area-average downscale, kept if at least half the source box was set. The
 *  registration search runs on these, and majority coverage is what keeps a
 *  small room from evaporating at 96 px while its neighbours survive — which
 *  would bias the fit towards the big rooms.
 *  @param {Mask} m @param {number} maxSide @returns {Mask} */
export function downscaleMask(m, maxSide) {
  const k = Math.min(1, maxSide / Math.max(m.width, m.height));
  if (k >= 1) return m;
  const w = Math.max(1, Math.round(m.width * k)), h = Math.max(1, Math.round(m.height * k));
  const out = newMask(w, h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * m.height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * m.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * m.width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * m.width) / w));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += m.data[yy * m.width + xx]; n++; }
      out.data[y * w + x] = s * 2 >= n ? 1 : 0;
    }
  }
  return out;
}

/** Two-pass chamfer distance to the nearest set pixel, weights 3 and 4 divided
 *  by 3 (Borgefors): about 2% worse than the true Euclidean distance, which is
 *  far inside the several-pixel tolerance anything here compares against, and it
 *  is one linear pass each way instead of a search.
 *  @param {Mask} m @returns {Float32Array} */
export function distanceTransform(m) {
  const { width: w, height: h, data } = m;
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = data[i] ? 0 : INF;
  const A = 3, B = 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (y > 0) {
        if (x > 0) v = Math.min(v, d[i - w - 1] + B);
        v = Math.min(v, d[i - w] + A);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + B);
      }
      if (x > 0) v = Math.min(v, d[i - 1] + A);
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (y < h - 1) {
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + B);
        v = Math.min(v, d[i + w] + A);
        if (x > 0) v = Math.min(v, d[i + w - 1] + B);
      }
      if (x < w - 1) v = Math.min(v, d[i + 1] + A);
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = d[i] >= INF ? INF : d[i] / A;
  return d;
}

/** The deepest interior point of a polygon raster. A concave room's centroid can
 *  sit in the corridor outside it, and seeding a flood fill there measures the
 *  corridor; the distance-transform maximum is always inside.
 *  @param {Mask} m @returns {{ x: number, y: number, depth: number }} */
export function deepestPoint(m) {
  const inv = { width: m.width, height: m.height, data: new Uint8Array(m.data.length) };
  for (let i = 0; i < m.data.length; i++) inv.data[i] = m.data[i] ? 0 : 1;
  /* A room touching the frame edge has no wall there to be far from, and its
     deepest point would slide out to the rim. Capping each depth by the distance
     to the border treats everything beyond the frame as wall, which is what the
     min against `edge` below is doing. */
  const d = distanceTransform(inv);
  let best = -1, bx = m.width / 2, by = m.height / 2;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      const i = y * m.width + x;
      if (!m.data[i]) continue;
      const edge = Math.min(x + 1, y + 1, m.width - x, m.height - y);
      const v = Math.min(d[i], edge);
      if (v > best) { best = v; bx = x; by = y; }
    }
  }
  return { x: bx, y: by, depth: best };
}
