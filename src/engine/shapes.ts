import type { Item, Opening, Pt, Wall } from './types';
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

/** Where an opening starts and stops along its wall, in centimetres from `a`,
 *  with the wall's own unit vectors alongside. Null when it has been squeezed to
 *  nothing — a 0-width doorway is not a doorway.
 *
 *  One answer to "where is this door", shared by the plan, the control maps and
 *  the eye-level massing. They used to hold three copies of this clamp, and a
 *  door that lands 4 cm apart on two of them is a mullion the render will build.
 */
export interface OpeningSpan {
  n: ReturnType<typeof unitNormal>;
  /** distance along the wall from `a` */
  t0: number; t1: number;
  width: number;
}

export function openingSpan(w: Wall, op: Opening): OpeningSpan | null {
  const n = unitNormal(w.a, w.b);
  const c = clamp(op.at, 0, 1) * n.L, half = Math.min(op.width, n.L) / 2;
  const t0 = clamp(c - half, 0, n.L), t1 = clamp(c + half, 0, n.L);
  if (t1 - t0 < 0.5) return null;
  return { n, t0, t1, width: t1 - t0 };
}

/** An object's footprint, rotated. Deliberately the box and not the glyph: a
 *  glyph's interior is hatch and detail, which a control encoder reads as
 *  texture and repeats as texture — and which an eye-level massing render would
 *  have to invent a mesh for. */
export function itemQuad(i: Item): Pt[] {
  const r = ((i.rot || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const hw = i.w / 2, hh = i.h / 2;
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const).map(([x, y]) => ({
    x: i.x + x * c - y * s,
    y: i.y + x * s + y * c,
  }));
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
