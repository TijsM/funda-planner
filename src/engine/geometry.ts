import type { Pt, BBox } from './types';

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const R2 = (n: number) => Math.round(n * 100) / 100;
export const fmtM2 = (cm2: number) => (cm2 / 10000).toFixed(1);
export const uid = () =>
  Math.random().toString(36).slice(2, 9) + (Date.now() % 100000).toString(36);

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function polyArea(p: Pt[]): number {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const q = p[(i + 1) % n];
    s += p[i].x * q.y - q.x * p[i].y;
  }
  return Math.abs(s / 2);
}

export function bboxOf(pts: Pt[]): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

export function polyCentroid(p: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const q = p[(i + 1) % n];
    const f = p[i].x * q.y - q.x * p[i].y;
    a += f; cx += (p[i].x + q.x) * f; cy += (p[i].y + q.y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const b = bboxOf(p);
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInPoly(pt: Pt, p: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i].y > pt.y) !== (p[j].y > pt.y) &&
        pt.x < ((p[j].x - p[i].x) * (pt.y - p[i].y)) / (p[j].y - p[i].y) + p[i].x) inside = !inside;
  }
  return inside;
}

export function closestOnSeg(p: Pt, a: Pt, b: Pt): Pt & { t: number } {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  if (L < 1e-9) return { x: a.x, y: a.y, t: 0 };
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / L, 0, 1);
  return { x: a.x + t * dx, y: a.y + t * dy, t };
}

export const distToSeg = (p: Pt, a: Pt, b: Pt) => dist(p, closestOnSeg(p, a, b));

export function rotPt(x: number, y: number, deg: number): Pt {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: x * c - y * s, y: x * s + y * c };
}

/** unit normal + direction + length of a segment, the workhorse for walls */
export function unitNormal(a: Pt, b: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  return { x: -dy / L, y: dx / L, ux: dx / L, uy: dy / L, L };
}

/** top of the plan is north — the convention every floor plan already uses */
export function compass(p: Pt, b: BBox): string {
  const w = Math.max(1, b.x1 - b.x0), h = Math.max(1, b.y1 - b.y0);
  const fx = (p.x - b.x0) / w, fy = (p.y - b.y0) / h;
  const ns = fy < 0.34 ? 'north' : fy > 0.66 ? 'south' : '';
  const ew = fx < 0.34 ? 'west' : fx > 0.66 ? 'east' : '';
  return ns && ew ? `${ns}-${ew}` : ns || ew || 'central';
}
