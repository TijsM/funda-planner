/** METRIC 2 — envelopeIou: did the render keep the building's footprint?
 *
 *  WHAT IT MEASURES  We register the render against the plan with a small search
 *  over translation and uniform scale, then take the IoU of the outer footprint
 *  the render actually drew against the envelope polygon we fed it. The search
 *  is small because it is not a search for anything unknown: the render was
 *  conditioned on our own framing, so identity is already a good guess and the
 *  optimiser only has to clean up the generator's drift.
 *
 *  THE BOUNDS ARE NOT A DETAIL. A free similarity fit is not a fidelity metric:
 *  let it choose any scale and it will shrink the plan onto a completely wrong
 *  blob and report 0.9 for it — a 120x80 box scoring 0.90 against a 320x240
 *  building is what made us bound it. Scale is confined to 0.7..1.4 of the size
 *  our own framing implies and the shift to a quarter of the frame; a render
 *  that needs more than that has not drawn our building.
 *
 *  GOOD  > 0.9 with frameScale near 1.
 *  BAD   < 0.7, or a frameScale far from 1 — the generator re-framed the
 *        building, which is the dollhouse-tilt failure showing up as area. READ
 *        frameScale, NOT iou ALONE: a render that blew the building up to fill
 *        the whole page still scores 0.99, because a similarity fit cannot tell
 *        "re-cropped" from "wrong footprint" and must not pretend to. frameScale
 *        is the transform's scale over the one our framing implies, so it is the
 *        same number whatever resolution the provider returned.
 *
 *  The fit is to INKED EXTENT on both sides: the footprint the render drew
 *  includes its own wall thickness, and the sidecar's envelope is the outer edge
 *  of ours (truth.mjs traces the filled wall raster, not a centreline). They
 *  agree to the difference between the two wall thicknesses, so the recovered
 *  scale carries a fraction of a percent of bias — small, but the room polygons
 *  underneath it are area outlines, half a wall further in, which is what
 *  lineF1's tolerance is really sized for.
 *
 *  The transform it returns is the point of the whole file. roomIou and lineF1
 *  both need the render and the plan in the same coordinates, and letting each
 *  of them search again would let them disagree about where the building is —
 *  three metrics measuring three different registrations is worse than none.
 *
 *  SPEED  ~260 ms on a 1 MP render, the most expensive metric here: the pattern
 *  search runs on masks downscaled to 96, 192 and 384 px, and only the footprint
 *  extraction sees full resolution.
 */

import { countMask, downscaleMask, fillPoly, largestComponent, moments, newMask } from './mask.mjs';

/** @typedef {import('./pixels.mjs').Pixels} Pixels */
/** @typedef {import('./mask.mjs').Mask} Mask */
/** @typedef {import('./mask.mjs').Transform} Transform */

/** Everything the render drew, as opposed to the paper it drew it on.
 *
 *  Flood-filled inwards from the border rather than thresholded: a plan render
 *  is mid-grey floors, white walls and black lines all at once, and no single
 *  luminance threshold separates "building" from "background" across that. What
 *  does separate them is connectivity to the frame edge — and it gets holes
 *  right for free, since a courtyard unreachable from the border stays inside.
 *
 *  @param {Pixels} px
 *  @param {{ tol?: number }} [opts] tol is RGB distance from the border's own median colour
 *  @returns {Mask} */
export function footprintMask(px, opts = {}) {
  const tol = opts.tol ?? 40;
  const { width: w, height: h, data } = px;
  const rs = [], gs = [], bs = [];
  const push = (x, y) => {
    const i = (y * w + x) * 4;
    const a = data[i + 3] / 255;
    rs.push(data[i] * a + 255 * (1 - a));
    gs.push(data[i + 1] * a + 255 * (1 - a));
    bs.push(data[i + 2] * a + 255 * (1 - a));
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { push(0, y); push(w - 1, y); }
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  const mr = med(rs), mg = med(gs), mb = med(bs);

  const near = (i) => {
    const j = i * 4;
    const a = data[j + 3] / 255;
    const r = data[j] * a + 255 * (1 - a) - mr;
    const g = data[j + 1] * a + 255 * (1 - a) - mg;
    const b = data[j + 2] * a + 255 * (1 - a) - mb;
    return Math.sqrt(r * r + g * g + b * b) <= tol;
  };

  /* One fill from a virtual pixel outside the frame, faked by seeding every
     border pixel that is background-coloured. Filling from a single corner is a
     bug: a building that touches the left edge cuts the background in two and
     the far half is then scored as part of the footprint. */
  const bg = newMask(w, h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const seed = (i) => { if (!bg.data[i] && near(i)) { bg.data[i] = 1; stack[top++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (top > 0) {
    const i = stack[--top];
    const x = i % w, y = (i - x) / w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }
  const fg = newMask(w, h);
  for (let i = 0; i < fg.data.length; i++) fg.data[i] = bg.data[i] ? 0 : 1;
  /* Largest component only: JPEG mosquito noise in the margin and a stray
     dimension tick both survive the fill as specks that would otherwise stretch
     the footprint's bounding box across the whole frame. */
  return largestComponent(fg);
}

/** IoU of `render` against `truth` mapped by (dx, dy, s), evaluated on the
 *  render's own grid. Counting the projected truth over that grid rather than
 *  scaling its area by s² keeps the arithmetic honest when the transform pushes
 *  part of the plan off the edge of the picture. */
function iouUnder(render, truth, dx, dy, s) {
  const { width: w, height: h, data: R } = render;
  const { width: tw, height: th, data: T } = truth;
  let inter = 0, uni = 0;
  for (let y = 0; y < h; y++) {
    const ty = Math.floor((y + 0.5 - dy) / s);
    const row = ty >= 0 && ty < th ? ty * tw : -1;
    for (let x = 0; x < w; x++) {
      const r = R[y * w + x];
      let t = 0;
      if (row >= 0) {
        const tx = Math.floor((x + 0.5 - dx) / s);
        if (tx >= 0 && tx < tw) t = T[row + tx];
      }
      if (r & t) inter++;
      if (r | t) uni++;
    }
  }
  return uni === 0 ? 0 : inter / uni;
}

/** Pattern search: try the 26 neighbours in (dx, dy, s), step to the best, halve
 *  the steps when none of them beats where we stand. Gradient descent needs a
 *  gradient and IoU over a pixel grid does not have one; a grid search fine
 *  enough to land within a pixel would be 10^5 evaluations of the same loop. */
function refine(render, truth, start, stepD, stepS, bounds) {
  const within = (t) => t.scale >= bounds.sMin && t.scale <= bounds.sMax
    && Math.abs(t.dx) <= bounds.dMax && Math.abs(t.dy) <= bounds.dMax;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const from = within(start) ? start : {
    dx: clamp(start.dx, -bounds.dMax, bounds.dMax),
    dy: clamp(start.dy, -bounds.dMax, bounds.dMax),
    scale: clamp(start.scale, bounds.sMin, bounds.sMax),
  };
  let best = { ...from }, bestIou = iouUnder(render, truth, from.dx, from.dy, from.scale);
  let d = stepD, s = stepS;
  for (let guard = 0; guard < 60 && (d > 0.2 || s > 0.002); guard++) {
    let moved = false;
    for (const ddx of [-d, 0, d]) {
      for (const ddy of [-d, 0, d]) {
        for (const ds of [-s, 0, s]) {
          if (!ddx && !ddy && !ds) continue;
          const cand = { dx: best.dx + ddx, dy: best.dy + ddy, scale: best.scale + ds };
          if (!within(cand)) continue;
          const v = iouUnder(render, truth, cand.dx, cand.dy, cand.scale);
          if (v > bestIou) { bestIou = v; best = cand; moved = true; }
        }
      }
    }
    if (!moved) { d /= 2; s /= 2; }
  }
  return { transform: best, iou: bestIou };
}

/** Registers a render footprint against a truth footprint.
 *
 *  Both masks arrive in their own full resolution; the returned transform maps
 *  TRUTH-FRAME pixels onto RENDER pixels, which is the direction every later
 *  metric needs (it holds the truth as vectors and has to draw them onto the
 *  render).
 *
 *  @param {Mask} renderMask @param {Mask} truthMask
 *  @param {{ levels?: number[], minScale?: number, maxScale?: number, maxShiftFrac?: number }} [opts]
 *  @returns {{ iou: number, transform: Transform, frameScale: number }} */
export function registerMasks(renderMask, truthMask, opts = {}) {
  const levels = opts.levels ?? [96, 192, 384];
  /* The scale our own framing implies: the render is the frame we painted,
     resized to whatever resolution the provider returned. This is what
     "identity" means in pixels, and both the seed and the bounds are relative to
     it — including in the early-out, so that a render whose footprint could not
     be found at all still hands roomIou and lineF1 our framing rather than a
     scale of 1 that is only right when the two resolutions happen to match. */
  const s0 = Math.max(renderMask.width, renderMask.height) / Math.max(truthMask.width, truthMask.height);
  if (!countMask(renderMask) || !countMask(truthMask)) {
    return { iou: 0, transform: { dx: 0, dy: 0, scale: s0 }, frameScale: 1 };
  }

  /* Bounds in PIXELS, converted per level, rather than stated in grid units.
     Grid units are only relative when BOTH masks were actually resized, and
     downscaleMask returns a mask untouched when it is already smaller than the
     level: a 200 px render of a 400 px frame reaches level 384 with the render
     at full size and the truth at 0.96, where the true scale of 0.5 becomes a
     grid scale of 0.52 — outside the 0.7 floor, clamped away, and a
     pixel-perfect copy at half resolution scored 0.80 with every room near 0.2. */
  const sMin = (opts.minScale ?? 0.7) * s0;
  const sMax = (opts.maxScale ?? 1.4) * s0;
  const dMax = (opts.maxShiftFrac ?? 0.25) * Math.max(renderMask.width, renderMask.height);

  let out = { iou: 0, transform: { dx: 0, dy: 0, scale: s0 } };
  for (const res of levels) {
    const R = downscaleMask(renderMask, res), T = downscaleMask(truthMask, res);
    const kR = R.width / renderMask.width, kT = T.width / truthMask.width;
    const g = kR / kT;   /* pixel scale to grid scale */
    const toGrid = (t) => ({ dx: t.dx * kR, dy: t.dy * kR, scale: t.scale * g });
    const toPx = (t) => ({ dx: t.dx / kR, dy: t.dy / kR, scale: t.scale / g });

    /* Two seeds, because each fails where the other works. Identity is right
       whenever the generator respected our framing, which is the common case and
       the one a moment fit can walk away from when the render has a shadow or a
       cropped balcony hanging off it. Moments are right when it did not. */
    const seeds = [toGrid(out.transform)];
    const mr = moments(R), mt = moments(T);
    const ms = Math.sqrt(mr.area / Math.max(1, mt.area));
    seeds.push({ dx: mr.cx - ms * mt.cx, dy: mr.cy - ms * mt.cy, scale: ms });

    let bestAtLevel = null;
    for (const seed of seeds) {
      /* The scale step is a proportion of the scale we expect, not an absolute
         0.08: at a level where the render was not resized the expected grid
         scale is nowhere near 1 and a fixed step is either a crawl or a leap. */
      const got = refine(R, T, seed, Math.max(2, res * 0.08), 0.08 * s0 * g, {
        sMin: sMin * g, sMax: sMax * g, dMax: dMax * kR,
      });
      if (!bestAtLevel || got.iou > bestAtLevel.iou) bestAtLevel = got;
    }
    out = { iou: bestAtLevel.iou, transform: toPx(bestAtLevel.transform) };
  }
  return { ...out, frameScale: out.transform.scale / s0 };
}

/**
 * `coverage` is the share of the render the footprint took up. It is not a score,
 * it is the sanity check on the one above it, and it fails at BOTH ends:
 *
 *   near 1  the fill found only a rim of background, so it is registering the
 *           paper. A full-bleed render inside a light border does this.
 *   near 0  the fill found a speck — or nothing at all. `footprintMask` seeds
 *           from every border pixel that matches the border's own median colour,
 *           so a render with NO background at all is entirely background by that
 *           test, floods completely, and comes back EMPTY rather than full:
 *           coverage 0.000, and `registerMasks` early-outs at iou 0. Measured on
 *           a flat full-bleed frame: coverage 0.000. Add texture until the border
 *           median stops matching the interior and the same picture jumps to
 *           0.996. Both ends are the same failure wearing opposite numbers.
 *
 * Either way the iou beside it is meaningless and the caller has to say so rather
 * than average it in — score.mjs flags both ends as 'unregistered' and drops the
 * cell out of the composite. For scale: the ten fixture plans self-score between
 * 0.48 and 0.85.
 *
 * @param {Pixels} px the render
 * @param {{ frame: { width: number, height: number }, envelope: [number, number][] }} truth the sidecar
 * @param {{ tol?: number, levels?: number[] }} [opts]
 * @returns {{ iou: number, transform: Transform, frameScale: number, coverage: number }}
 */
export function envelopeIou(px, truth, opts = {}) {
  const truthMask = fillPoly(newMask(truth.frame.width, truth.frame.height), truth.envelope);
  const foot = footprintMask(px, opts);
  const got = registerMasks(foot, truthMask, opts);
  return { ...got, coverage: countMask(foot) / (px.width * px.height) };
}

/** Exported for tests and for score.mjs, which draws the same truth footprint to
 *  report area error alongside the IoU. */
export function envelopeMask(truth) {
  return fillPoly(newMask(truth.frame.width, truth.frame.height), truth.envelope);
}
