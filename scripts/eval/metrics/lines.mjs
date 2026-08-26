/** METRIC 4 — lineF1: are the render's edges where our walls are?
 *
 *  WHAT IT MEASURES  Thinned Sobel edges from the render against a raster of the
 *  plan's own wall lines, matched with a few pixels of slack. Precision is the
 *  share of the render's edges that land on a wall we asked for; recall is the
 *  share of our walls the render drew something along. F1 of the two.
 *
 *  GOOD  > 0.6 on a plan-like render. This is not a metric where 1.0 is on the
 *        table: a photorealistic render has edges we never asked for — furniture,
 *        skirting, shadows — and they cost precision no matter how faithful the
 *        walls are. Read it as a difference between conditions, not an absolute.
 *  BAD   a recall collapse, which is the signature of walls that wandered: our
 *        line is there in the truth and the render put nothing within tolerance.
 *
 *  F1 AND NOT IoU, following ControlNet++ (arXiv:2404.07987 §4): edges are a
 *  long-tailed binary problem where one side of the comparison is a hairline. An
 *  IoU over one-pixel-wide sets is dominated by whether the two rasters happened
 *  to round the same way.
 *
 *  THE TOLERANCE IS NOT SLACK FOR THE GENERATOR, it is slack for us. Two of our
 *  own errors put our hairline off the render's edge with nothing wrong in the
 *  render: the sidecar's envelope is the OUTER edge of our walls while a room's
 *  polygon is its area outline, so the two rasters here sit half a wall apart to
 *  begin with; and envelopeIou fits to inked extent, so the transform we inherit
 *  carries a fraction of a percent of scale error, which lands as several pixels
 *  at the far corner of a large building. Hence a default of one percent of the
 *  working frame rather than a flat 3 px. It is still an order of magnitude
 *  tighter than the wall drift we are hunting.
 *
 *  READ truthPixels WHEN RECALL MOVES. Walls the transform pushes off the frame
 *  are clipped out of the raster instead of counting against recall, so a
 *  registration that failed outright reads as good recall over the sliver that
 *  stayed in view. truthPixels collapsing is that failure; envelopeIou's own
 *  score is the other half of it.
 *
 *  SPEED  ~60 ms on a 1 MP render at the default 768 px working resolution.
 */

import { grey, downscaleGrey, sobel, thinEdges } from './pixels.mjs';
import { distanceTransform, mapPoly, newMask, strokePoly } from './mask.mjs';

/** @typedef {import('./pixels.mjs').Pixels} Pixels */
/** @typedef {import('./mask.mjs').Mask} Mask */
/** @typedef {import('./mask.mjs').Transform} Transform */

/** The plan's lines drawn into the render's frame: the outer envelope plus every
 *  room boundary. Hairline by default — the tolerance below, not the stroke, is
 *  what absorbs the render's own wall thickness, and a thick truth raster would
 *  quietly inflate recall instead.
 *  @param {{ envelope: [number, number][], rooms: { poly: [number, number][] }[] }} truth
 *  @param {Transform} t @param {number} w @param {number} h @param {number} [r]
 *  @returns {Mask} */
export function wallRaster(truth, t, w, h, r = 0.5) {
  const m = newMask(w, h);
  if (truth.envelope?.length) strokePoly(m, mapPoly(t, truth.envelope), r);
  for (const room of truth.rooms ?? []) if (room.poly?.length) strokePoly(m, mapPoly(t, room.poly), r);
  return m;
}

/**
 * @param {Pixels} px the render
 * @param {{ envelope: [number, number][], rooms: { poly: [number, number][] }[] }} truth
 * @param {Transform} transform from envelopeIou
 * @param {{ maxSide?: number, edgeThresh?: number, tolPx?: number }} [opts]
 * @returns {{ f1: number, precision: number, recall: number, predPixels: number, truthPixels: number }}
 */
export function lineF1(px, truth, transform, opts = {}) {
  const res = opts.maxSide ?? 768;
  const { grey: g, k } = downscaleGrey(grey(px), res);
  const tol = opts.tolPx ?? Math.max(3, 0.01 * Math.max(g.width, g.height));
  const pred = thinEdges(sobel(g), opts.edgeThresh ?? 12);
  const w = g.width, h = g.height;

  const grid = { dx: transform.dx * k, dy: transform.dy * k, scale: transform.scale * k };
  const want = wallRaster(truth, grid, w, h);

  const predMask = { width: w, height: h, data: pred };
  const dToTruth = distanceTransform(want);
  const dToPred = distanceTransform(predMask);

  let tp = 0, np = 0, tr = 0, nt = 0;
  for (let i = 0; i < w * h; i++) {
    if (pred[i]) { np++; if (dToTruth[i] <= tol) tp++; }
    if (want.data[i]) { nt++; if (dToPred[i] <= tol) tr++; }
  }
  const precision = np ? tp / np : 0;
  const recall = nt ? tr / nt : 0;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { f1, precision, recall, predPixels: np, truthPixels: nt };
}
