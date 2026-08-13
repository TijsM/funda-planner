import type { Opening, Pt, Wall } from './types';
import { clamp, unitNormal } from './geometry';

export const INK = '#1E1B16';
export const PAPER = '#F3F0E7';
export const WALLC = '#241F19';
export const ACC = '#E4632C';
export const CYA = '#2F8C9E';
export const GHOST = '#C9C2B0';

export function hexA(hex: string | undefined, a: number): string {
  const h = (hex || '#888').replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const v = parseInt(n, 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

/** the four corners of a wall's footprint */
export function wallQuad(w: Wall): Pt[] {
  const n = unitNormal(w.a, w.b), h = w.t / 2;
  return [
    { x: w.a.x + n.x * h, y: w.a.y + n.y * h },
    { x: w.b.x + n.x * h, y: w.b.y + n.y * h },
    { x: w.b.x - n.x * h, y: w.b.y - n.y * h },
    { x: w.a.x - n.x * h, y: w.a.y - n.y * h },
  ];
}

/** the footprint of an opening, slightly proud of the wall so it hit-tests well */
export function openingRect(w: Wall, op: Opening): Pt[] {
  const n = unitNormal(w.a, w.b);
  const L = n.L, ht = (w.t / 2) * 1.4;
  const c = clamp(op.at, 0, 1) * L, half = Math.min(op.width, L) / 2;
  const t0 = clamp(c - half, 0, L), t1 = clamp(c + half, 0, L);
  const P = (t: number): Pt => ({ x: w.a.x + n.ux * t, y: w.a.y + n.uy * t });
  const p0 = P(t0), p1 = P(t1);
  return [
    { x: p0.x + n.x * ht, y: p0.y + n.y * ht },
    { x: p1.x + n.x * ht, y: p1.y + n.y * ht },
    { x: p1.x - n.x * ht, y: p1.y - n.y * ht },
    { x: p0.x - n.x * ht, y: p0.y - n.y * ht },
  ];
}

export function pathPoly(g: CanvasRenderingContext2D, pts: Pt[], close = true): void {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  if (close) g.closePath();
}

const GRID_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];

/** the coarsest step that still renders at least `minPx` apart */
export function gridStep(zoom: number, minPx = 9): number {
  for (const s of GRID_STEPS) if (s * zoom >= minPx) return s;
  return 10000;
}
