import type { Floor, Hit, Layers, Pt, View } from './types';
import { dist, distToSeg, pointInPoly, polyArea } from './geometry';
import { openingRect } from './shapes';
import { upx } from './view';

/** Topmost-first, matching the paint order in reverse: notes, items, openings,
 *  walls, dimensions, lines, then the smallest room containing the point. */
export function hitTest(f: Floor | null, w: Pt, v: View, layers: Layers): Hit | null {
  if (!f) return null;
  const u = upx(v);
  const tol = 6 * u;

  if (layers.notes) {
    for (let i = f.notes.length - 1; i >= 0; i--) {
      if (dist(w, f.notes[i]) < 20 * u) return { t: 'note', o: f.notes[i] };
    }
  }
  if (layers.furn) {
    for (let i = f.items.length - 1; i >= 0; i--) {
      const it = f.items[i];
      const rad = (-(it.rot || 0) * Math.PI) / 180;
      const dx = w.x - it.x, dy = w.y - it.y;
      const px = dx * Math.cos(rad) - dy * Math.sin(rad);
      const py = dx * Math.sin(rad) + dy * Math.cos(rad);
      if (Math.abs(px) <= it.w / 2 + tol && Math.abs(py) <= it.h / 2 + tol) return { t: 'item', o: it };
    }
  }
  for (const wl of f.walls) {
    for (const op of wl.openings) if (pointInPoly(w, openingRect(wl, op))) return { t: 'opening', o: op, wall: wl };
  }
  for (const wl of f.walls) if (distToSeg(w, wl.a, wl.b) <= wl.t / 2 + tol) return { t: 'wall', o: wl };
  if (layers.dims) for (const d of f.dims) if (distToSeg(w, d.a, d.b) <= tol * 2) return { t: 'dim', o: d };
  for (const l of f.lines) if (distToSeg(w, l.a, l.b) <= tol * 2) return { t: 'line', o: l };

  if (layers.rooms) {
    let best: Floor['areas'][0] | null = null, ba = Infinity;
    for (const a of f.areas) {
      if (pointInPoly(w, a.poly)) {
        const A = polyArea(a.poly);
        if (A < ba) { ba = A; best = a; }
      }
    }
    if (best) return { t: 'area', o: best };
  }
  return null;
}

export function nearestWall(f: Floor | null, w: Pt, v: View) {
  if (!f) return null;
  let best: Floor['walls'][0] | null = null;
  let bd = 60 * upx(v);
  for (const wl of f.walls) {
    const d = distToSeg(w, wl.a, wl.b);
    if (d < bd) { bd = d; best = wl; }
  }
  return best;
}
