import type { BBox, Floor, Handle, Item, Pt, SelObj, View } from './types';
import { clamp, dist, R2, rotPt } from './geometry';
import { contentBBox } from './model';
import { openingRect, wallQuad } from './shapes';

export const toScreen = (v: View, wx: number, wy: number): Pt => ({ x: wx * v.zoom + v.px, y: wy * v.zoom + v.py });
export const toWorld = (v: View, sx: number, sy: number): Pt => ({ x: (sx - v.px) / v.zoom, y: (sy - v.py) / v.zoom });
/** one screen pixel, expressed in world centimetres */
export const upx = (v: View) => 1 / v.zoom;

export function fitTo(b: BBox | null, w: number, h: number, pad = 60): View {
  if (!b) return { zoom: 0.3, px: w / 2, py: h / 2 };
  const zoom = clamp(
    Math.min((w - pad * 2) / Math.max(50, b.x1 - b.x0), (h - pad * 2) / Math.max(50, b.y1 - b.y0)),
    0.02, 6,
  );
  return { zoom, px: w / 2 - ((b.x0 + b.x1) / 2) * zoom, py: h / 2 - ((b.y0 + b.y1) / 2) * zoom };
}

export const fitFloor = (f: Floor | null, w: number, h: number) => fitTo(contentBBox(f), w, h);

export function zoomAt(v: View, sx: number, sy: number, factor: number): View {
  const w = toWorld(v, sx, sy);
  const zoom = clamp(v.zoom * factor, 0.02, 12);
  return { zoom, px: sx - w.x * zoom, py: sy - w.y * zoom };
}

/* ── snapping ───────────────────────────────────────────────────── */

export interface SnapCfg { on: boolean; grid: number; view: View }

/** grid, or an existing endpoint when one is within reach */
export function snapPoint(f: Floor | null, p: Pt, cfg: SnapCfg, skipWallId?: string): Pt {
  if (!cfg.on) return { x: R2(p.x), y: R2(p.y) };
  const tol = 11 * upx(cfg.view);
  let best: Pt | null = null, bd = tol;
  if (f) {
    const cands: Pt[] = [];
    f.walls.forEach(w => { if (skipWallId !== w.id) cands.push(w.a, w.b); });
    f.areas.forEach(a => cands.push(...a.poly));
    for (const c of cands) { const d = dist(p, c); if (d < bd) { bd = d; best = { x: c.x, y: c.y }; } }
  }
  if (best) return best;
  const g = cfg.grid;
  return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
}

/** 15° increments with the length rounded to the grid; `free` releases it */
export function snapAngle(from: Pt, to: Pt, cfg: SnapCfg, free?: boolean): Pt {
  if (free) return to;
  const dx = to.x - from.x, dy = to.y - from.y;
  const L = Math.hypot(dx, dy);
  const step = Math.PI / 12;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  if (!cfg.on) return { x: R2(from.x + Math.cos(a) * L), y: R2(from.y + Math.sin(a) * L) };
  const Lg = Math.max(cfg.grid, Math.round(L / cfg.grid) * cfg.grid);
  return { x: R2(from.x + Math.cos(a) * Lg), y: R2(from.y + Math.sin(a) * Lg) };
}

/** lock to the axis, measured from the end that stays put */
export function axisLock(p: Pt, anchor: Pt): Pt {
  return Math.abs(p.x - anchor.x) >= Math.abs(p.y - anchor.y)
    ? { x: p.x, y: anchor.y }
    : { x: anchor.x, y: p.y };
}

/* ── handles ────────────────────────────────────────────────────── */

const CORNERS: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
/** Midpoints of the four sides, in the same clockwise-from-top-left order. A 0
 *  means "leave this axis alone", which is the whole difference from a corner. */
const SIDES: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** Corners first: they are listed ahead of the sides so that on an object too
 *  small to separate them, `hitHandle` returns the corner. Resizing one axis by
 *  accident is a worse surprise than resizing two on purpose. */
export const RESIZE_DIRS: readonly (readonly [number, number])[] = [...CORNERS, ...SIDES];

/** Handles live in screen space so drawing and hit-testing cannot disagree. */
export function handlesFor(sel: SelObj[], v: View): Handle[] {
  if (sel.length !== 1) return [];
  const s = sel[0];
  const out: Handle[] = [];
  if (s.t === 'item') {
    const o: Item = s.o;
    RESIZE_DIRS.forEach((c, i) => {
      const p = rotPt((c[0] * o.w) / 2, (c[1] * o.h) / 2, o.rot || 0);
      const sc = toScreen(v, o.x + p.x, o.y + p.y);
      out.push({ k: 'res', i, dir: c, sx: sc.x, sy: sc.y, o, t: 'item' });
    });
    const rp = rotPt(0, -o.h / 2 - 26 / v.zoom, o.rot || 0);
    const rs = toScreen(v, o.x + rp.x, o.y + rp.y);
    out.push({ k: 'rot', sx: rs.x, sy: rs.y, o, t: 'item' });
  } else if (s.t === 'wall' || s.t === 'dim' || s.t === 'line') {
    (['a', 'b'] as const).forEach(key => {
      const sc = toScreen(v, s.o[key].x, s.o[key].y);
      out.push({ k: 'end', key, sx: sc.x, sy: sc.y, o: s.o, t: s.t });
    });
  } else if (s.t === 'area') {
    s.o.poly.forEach((p, i) => {
      const sc = toScreen(v, p.x, p.y);
      out.push({ k: 'vtx', i, sx: sc.x, sy: sc.y, o: s.o, t: 'area' });
    });
  }
  return out;
}

export function hitHandle(handles: Handle[], sp: Pt): Handle | null {
  for (const h of handles) if (Math.hypot(h.sx - sp.x, h.sy - sp.y) < 8) return h;
  return null;
}

/** The pointer over a handle, pointing the way the handle actually pulls. One
 *  cursor for everything said "resize" but not along which axis, which is the
 *  only thing a side handle has to communicate — and it lies outright on a
 *  rotated object, where the top edge is not up. */
export function cursorForHandle(h: Handle | null): string {
  if (!h) return 'default';
  if (h.k === 'rot') return 'grab';
  if (h.k !== 'res' || !h.dir) return 'nwse-resize';
  const p = rotPt(h.dir[0], h.dir[1], (h.o as Item).rot || 0);
  /* half a turn is enough: a handle and the one opposite pull along one line */
  const a = ((Math.atan2(p.y, p.x) * 180) / Math.PI + 360) % 180;
  if (a < 22.5 || a >= 157.5) return 'ew-resize';
  if (a < 67.5) return 'nwse-resize';
  if (a < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

/** screen-space bounds of a selection, for placing the on-object toolbar */
export function selScreenBBox(sel: SelObj[], v: View): BBox | null {
  const pts: Pt[] = [];
  for (const s of sel) {
    if (s.t === 'item') {
      CORNERS.forEach(c => {
        const r = rotPt((c[0] * s.o.w) / 2, (c[1] * s.o.h) / 2, s.o.rot || 0);
        pts.push(toScreen(v, s.o.x + r.x, s.o.y + r.y));
      });
    } else if (s.t === 'area') s.o.poly.forEach(p => pts.push(toScreen(v, p.x, p.y)));
    else if (s.t === 'wall') wallQuad(s.o).forEach(p => pts.push(toScreen(v, p.x, p.y)));
    else if (s.t === 'opening') openingRect(s.wall, s.o).forEach(p => pts.push(toScreen(v, p.x, p.y)));
    else if (s.t === 'dim' || s.t === 'line') {
      pts.push(toScreen(v, s.o.a.x, s.o.a.y), toScreen(v, s.o.b.x, s.o.b.y));
    } else if (s.t === 'note') {
      const c = toScreen(v, s.o.x, s.o.y);
      pts.push({ x: c.x - 60, y: c.y - 22 }, { x: c.x + 60, y: c.y + 22 });
    }
  }
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}
