/** METRIC 5 — orthoScore: is it actually orthographic, or a dollhouse tilt?
 *
 *  THIS IS OUR OWN CONSTRUCTION, NOT A PUBLISHED METHOD. There is no paper
 *  behind it and none should be cited for it. It is a proxy we invented for one
 *  specific failure we keep seeing — asking for a flat top-down view and getting
 *  a three-quarter dollhouse — and it should be trusted only as far as a proxy
 *  goes: as a difference between two conditions, never as a truth claim.
 *
 *  WHAT IT MEASURES  Every pixel with a strong gradient votes, weighted by that
 *  gradient's strength, for the direction of the edge running through it. The
 *  score is the share of that total edge energy pointing along an axis of the
 *  plan (0 or 90 degrees by default, or the plan's own wall angles when they are
 *  passed in). Tilt the camera and the two families of walls swing off-axis
 *  together, and the share collapses.
 *
 *  GOOD  > 0.8 on a genuine orthographic plan view.
 *  BAD   < 0.5, which in practice has meant a perspective camera.
 *
 *  It counts gradient energy rather than detecting line segments and measuring
 *  their length. A Hough transform at 1 MP costs more than this whole harness's
 *  time budget, and every segment detector has thresholds of its own that would
 *  become the thing we are really measuring. The cost of the shortcut is that a
 *  render full of axis-aligned texture — floorboards, tiling — scores higher
 *  than its walls deserve, so never read it without envelopeIou beside it.
 *
 *  SPEED  ~10 ms on a 1 MP image.
 */

import { grey, downscaleGrey, sobel } from './pixels.mjs';

/** @typedef {import('./pixels.mjs').Pixels} Pixels */

/**
 * @param {Pixels} px
 * @param {{ angles?: number[], tolDeg?: number, maxSide?: number, magThresh?: number, marginFrac?: number }} [opts]
 *        angles are LINE directions in degrees, not gradient directions
 * @returns {{ score: number, tolDeg: number, angles: number[], energy: number, sampled: number }}
 */
export function orthoScore(px, opts = {}) {
  const angles = (opts.angles ?? [0, 90]).map((a) => ((a % 180) + 180) % 180);
  const tol = opts.tolDeg ?? 6;
  const thresh = opts.magThresh ?? 12;
  const { grey: g } = downscaleGrey(grey(px), opts.maxSide ?? 512);
  const { mag, gx, gy, width: w, height: h } = sobel(g);
  /* Skip the outer rim. Renders arrive with a border, a mount or a JPEG edge
     often enough, and four perfectly axis-parallel frame lines would score a
     dollhouse render as orthographic all on their own. */
  const m = Math.max(2, Math.round(Math.min(w, h) * (opts.marginFrac ?? 0.02)));

  let energy = 0, aligned = 0, sampled = 0;
  for (let y = m; y < h - m; y++) {
    for (let x = m; x < w - m; x++) {
      const i = y * w + x;
      const v = mag[i];
      if (v < thresh) continue;
      /* The gradient is normal to the edge, so the line's own direction is the
         gradient turned 90 degrees; without that the "axis-parallel" test is
         satisfied by exactly the wrong walls. */
      const line = (((Math.atan2(gy[i], gx[i]) * 180) / Math.PI + 90) % 180 + 180) % 180;
      let near = 180;
      for (const a of angles) {
        const d = Math.abs(line - a);
        near = Math.min(near, Math.min(d, 180 - d));
      }
      energy += v; sampled++;
      if (near <= tol) aligned += v;
    }
  }
  return { score: energy ? aligned / energy : 0, tolDeg: tol, angles, energy, sampled };
}
