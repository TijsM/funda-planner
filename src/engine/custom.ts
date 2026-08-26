import type { Item, Pt, Shape } from './types';
import { bboxOf, uid } from './geometry';
import { heightOf } from './catalog';

/** Custom kinds are namespaced so nothing has to ask whether a string is one of
 *  ours or one of theirs: `CAT_BY_KIND['x:ab12']` is undefined by construction,
 *  and every lookup in the engine already handles a kind it does not know by
 *  falling back to a plain block. That fallback is what a custom object used to
 *  get; now it is what a custom object gets only if its drawing is missing. */
export const CUSTOM_PREFIX = 'x:';

export const isCustomKind = (kind: string): boolean => kind.startsWith(CUSTOM_PREFIX);

/** Unit-space outlines, 0..1 on both axes. Offered as a starting point rather
 *  than a menu: most things a plan is missing are a rectangle with a corner taken
 *  out, and drawing that from four clicks is slower than dragging one. */
export const SHAPE_PRESETS: { id: string; name: string; poly?: Pt[]; round?: 1 }[] = [
  {
    id: 'rect',
    name: 'Rectangle',
    poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  },
  { id: 'round', name: 'Round', round: 1 },
  {
    id: 'ell',
    name: 'L-shape',
    poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.42 },
      { x: 0.42, y: 0.42 }, { x: 0.42, y: 1 }, { x: 0, y: 1 }],
  },
  {
    id: 'corner',
    name: 'Cut corner',
    poly: [{ x: 0, y: 0 }, { x: 0.7, y: 0 }, { x: 1, y: 0.3 },
      { x: 1, y: 1 }, { x: 0, y: 1 }],
  },
  {
    id: 'trap',
    name: 'Trapezium',
    poly: [{ x: 0.22, y: 0 }, { x: 0.78, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  },
];

/** Every point pulled inside the unit square and every duplicate dropped.
 *
 *  A drawing surface hands back whatever the pointer did — a point a hair outside
 *  the box because the cursor left it, two points on top of each other from a
 *  double click — and a polygon with a repeated vertex draws a spur that only
 *  shows up once it is scaled to three metres on a print. */
export function normalisePoly(pts: Pt[]): Pt[] {
  const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  const out: Pt[] = [];
  for (const p of pts) {
    const q = { x: clamp01(p.x), y: clamp01(p.y) };
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - q.x) < 1e-4 && Math.abs(last.y - q.y) < 1e-4) continue;
    out.push(q);
  }
  /* the closing point, if someone hands us one, is implied by the path */
  const a = out[0], z = out[out.length - 1];
  if (out.length > 2 && Math.abs(a.x - z.x) < 1e-4 && Math.abs(a.y - z.y) < 1e-4) out.pop();
  return out;
}

/** Pull the outline's own bounds onto the unit square.
 *
 *  The authoring canvas is a viewBox. Someone drawing a treadmill on a square
 *  leaves empty space around it, and that space is not the object. Without this
 *  the selection on the plan is the canvas and the ink is the treadmill, and
 *  those are two different rectangles. Already-tight outlines (a rectangle
 *  preset, an L that already touches every edge) come back unchanged. */
export function fitPoly(pts: Pt[]): Pt[] {
  if (pts.length < 1) return pts;
  const { x0, y0, x1, y1 } = bboxOf(pts);
  const sx = x1 - x0, sy = y1 - y0;
  if (sx < 1e-6 && sy < 1e-6) return pts.map(() => ({ x: 0.5, y: 0.5 }));
  return pts.map(p => ({
    x: sx < 1e-6 ? 0.5 : (p.x - x0) / sx,
    y: sy < 1e-6 ? 0.5 : (p.y - y0) / sy,
  }));
}

/** Is this outline something that can actually be drawn? Two points are a line,
 *  and a line filled and stroked reads as a scratch on the plan rather than an
 *  object with a footprint. */
export const drawablePoly = (pts: Pt[] | undefined): boolean => !!pts && pts.length >= 3;

export function newShape(o: {
  name: string; w: number; h: number; poly?: Pt[]; round?: 1; z?: number;
}): Shape {
  const poly = o.poly ? fitPoly(normalisePoly(o.poly)) : undefined;
  return {
    id: `${CUSTOM_PREFIX}${uid()}`,
    name: o.name.trim() || 'Object',
    w: Math.max(1, Math.round(o.w)),
    h: Math.max(1, Math.round(o.h)),
    ...(o.round ? { round: 1 as const } : {}),
    ...(!o.round && drawablePoly(poly) ? { poly } : {}),
    ...(o.z ? { z: Math.max(0, Math.round(o.z)) } : {}),
  };
}

/** Draws one custom shape into the space a catalogue glyph would have used:
 *  centred on the origin, `w`×`h` centimetres, with the fill and stroke the
 *  caller has already chosen. Same contract as every `Glyph` in the catalogue,
 *  which is why the renderer can call either without knowing which it has.
 *
 *  The outline is fitted first so a plan saved before we cropped the viewBox
 *  still draws as the object, not as the object floating inside the canvas it
 *  was drawn on. */
export function drawShape(g: CanvasRenderingContext2D, s: Shape, w: number, h: number): void {
  if (s.round || !drawablePoly(s.poly)) {
    g.beginPath();
    g.ellipse(0, 0, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    return;
  }
  g.beginPath();
  fitPoly(s.poly!).forEach((p, i) => {
    /* unit space is measured from the top-left of the footprint; the glyph
       contract puts the origin in the middle of it */
    const x = (p.x - 0.5) * w, y = (p.y - 0.5) * h;
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  });
  g.closePath();
  g.fill();
  g.stroke();
}

/** The height of one placed object, custom or catalogued.
 *
 *  `heightOf(kind)` cannot answer for a custom object: its kind is an id nothing
 *  has a table for, so it would come back as the waist-height default and the
 *  depth map would draw a 2 m cupboard at the height of a desk. */
export function heightOfItem(i: Item): number {
  return i.shape?.z ?? heightOf(i.kind);
}

/** The shapes a plan offers back in the tray, newest first — which is the order
 *  someone drawing three things in a row expects to find them in. */
export function shapesOf(shapes: Shape[] | undefined): Shape[] {
  return Array.isArray(shapes) ? shapes.slice().reverse() : [];
}
