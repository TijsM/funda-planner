/** METRIC 3 — roomIou: did each room keep its shape, and does that decay with
 *  how late the room was mentioned in the prompt?
 *
 *  WHAT IT MEASURES  For every room in the sidecar we take the polygon we asked
 *  for, map it onto the render with the transform envelopeIou recovered, drop a
 *  seed at the polygon's deepest interior point, and flood-fill outwards in the
 *  render until we hit an edge. The IoU of that fill against the polygon is the
 *  score: it asks "is there a region of this shape, in this place, bounded by
 *  something the render drew as a wall".
 *
 *  THERE IS NO ABSOLUTE GOOD HERE, and an earlier version of this header claimed
 *  one (">0.85 per room, a slope steeper than -0.02 is bad"). Both numbers are
 *  unreachable. Scoring the conditioning images against their own sidecars — a
 *  perfect input, the metric's ceiling by definition — measures:
 *      per-room IoU     0.00 to 0.96, varying by ROOM, not by render
 *      per-plan slope    +0.220 (studio-26) to -0.176 (nl-second)
 *  so four of the seven multi-room fixtures fail a -0.02 line on a drawing that
 *  is exactly right. Read a DIFFERENCE against the self-score, per plan and per
 *  rank — which is what `pnpm eval:diff` prints and why it prints it by rank.
 *
 *  AND THE SLOPE IS CONFOUNDED, which is worse than noisy. rank is planFacts'
 *  ordering and planFacts sorts by DESCENDING AREA, so rank and room size are the
 *  same variable: over the fixtures, corr(rank, log areaM2) = -0.73, and this
 *  metric's own ceiling rises with area (corr(iou, log areaM2) = +0.29 on the
 *  self-score, because a flood fill and a dilated Sobel edge eat a larger share
 *  of a small room). "Described later" and "smaller" cannot be told apart by this
 *  number alone. `areaM2` is returned per room so the two can be separated at the
 *  call site; nothing here does it for you, and a slope quoted without it is not
 *  evidence about word order.
 *
 *  IT RETURNS NO MEAN, DELIBERATELY. A single blended room score is exactly the
 *  number that would hide the effect: two runs can average the same and disagree
 *  completely about which rooms failed. Aggregate at the call site, keeping rank.
 *
 *  A room the prompt never named carries rank null in the sidecar, is scored like
 *  any other, and is kept OUT of rankSlope: it has no position to correlate with.
 *  Arithmetic on null quietly makes it rank 0, which put an unranked garden at
 *  the head of the regression and tilted the one number this file exists for.
 *
 *  SPEED  ~80 ms on a 1 MP render at the default 512 px working resolution. A
 *  room smaller than a few pixels at that resolution cannot be scored and is
 *  returned with note 'degenerate' rather than a made-up zero.
 */

import { grey, downscaleGrey, sobel, thinEdges } from './pixels.mjs';
import {
  deepestPoint, downscaleMask, fillPoly, floodFill, iouOfMasks, mapPoly, newMask,
} from './mask.mjs';
import { footprintMask } from './envelope.mjs';

/** @typedef {import('./pixels.mjs').Pixels} Pixels */
/** @typedef {import('./mask.mjs').Transform} Transform */

/** Anything a flood fill may not cross: an edge the render drew, or the world
 *  outside the building. The footprint is in there because without it one gap in
 *  an outer wall lets a room's fill escape into the background and swallow the
 *  entire picture, and the room then scores near zero for a reason that has
 *  nothing to do with its shape. */
function barriers(px, res, opts) {
  const { grey: g, k } = downscaleGrey(grey(px), res);
  const edges = thinEdges(sobel(g), opts.edgeThresh ?? 10);
  const foot = downscaleMask(footprintMask(px, opts), res);
  const w = g.width, h = g.height;
  const bar = new Uint8Array(w * h);
  const r = opts.dilate ?? 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edges[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) bar[yy * w + xx] = 1;
        }
      }
    }
  }
  /* foot may round to a different grid than g by a pixel; guard the index rather
     than trusting the two downscales to agree. */
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fy = Math.min(foot.height - 1, y), fx = Math.min(foot.width - 1, x);
      if (!foot.data[fy * foot.width + fx]) bar[y * w + x] = 1;
    }
  }
  return { bar, width: w, height: h, k };
}

/**
 * @param {Pixels} px the render
 * @param {{ frame: { width: number, height: number }, rooms: { id: string, name: string, poly: [number, number][], rank: number | null, areaM2?: number }[] }} truth
 * @param {Transform} transform from envelopeIou
 * @param {{ maxSide?: number, edgeThresh?: number, dilate?: number, tol?: number }} [opts]
 * @returns {{ rooms: { rank: number | null, id: string, name: string, iou: number, areaM2: number | null, note?: string }[], rankSlope: number | null }}
 */
export function roomIou(px, truth, transform, opts = {}) {
  const res = opts.maxSide ?? 512;
  const { bar, width: w, height: h, k } = barriers(px, res, opts);
  const passable = (i) => !bar[i];
  /* The transform maps truth-frame pixels to render pixels; the working grid is
     the render scaled by k, so both parts of the transform pick up that k. */
  const grid = { dx: transform.dx * k, dy: transform.dy * k, scale: transform.scale * k };

  const rooms = [];
  /* Unranked rooms last, and never compared with a subtraction: `0 - null` is 0,
     so a null rank sorts as though it were the first room in the prompt. */
  const order = [...truth.rooms].sort((a, b) => {
    if (a.rank == null || b.rank == null) return (a.rank == null ? 1 : 0) - (b.rank == null ? 1 : 0);
    return a.rank - b.rank;
  });
  for (const room of order) {
    const poly = mapPoly(grid, room.poly);
    const want = fillPoly(newMask(w, h), poly);
    const seed = deepestPoint(want);
    const base = { rank: room.rank ?? null, id: room.id, name: room.name, areaM2: room.areaM2 ?? null };
    if (seed.depth < 2) { rooms.push({ ...base, iou: 0, note: 'degenerate' }); continue; }

    /* The deepest point can still land on a piece of furniture the render drew,
       and a seed on a barrier fills nothing. Walk out a short spiral for the
       nearest passable pixel that is still inside the room we asked for. */
    let sx = seed.x, sy = seed.y, ok = passable(sy * w + sx);
    for (let r = 1; !ok && r <= 6; r++) {
      for (let dy = -r; dy <= r && !ok; dy++) {
        for (let dx = -r; dx <= r && !ok; dx++) {
          const x = seed.x + dx, y = seed.y + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (!want.data[y * w + x] || !passable(y * w + x)) continue;
          sx = x; sy = y; ok = true;
        }
      }
    }
    if (!ok) { rooms.push({ ...base, iou: 0, note: 'seed blocked' }); continue; }
    rooms.push({ ...base, iou: iouOfMasks(floodFill(w, h, sx, sy, passable), want) });
  }

  return { rooms, rankSlope: slope(rooms) };
}

/** Least squares of iou against rank. It is the hypothesis in one number, and
 *  the only aggregate in this file that does not blur which room failed. */
function slope(rooms) {
  const pts = rooms.filter((r) => r.rank != null && r.note !== 'degenerate');
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((s, r) => s + r.rank, 0) / n;
  const my = pts.reduce((s, r) => s + r.iou, 0) / n;
  let num = 0, den = 0;
  for (const r of pts) { num += (r.rank - mx) * (r.iou - my); den += (r.rank - mx) ** 2; }
  return den === 0 ? null : num / den;
}
