import type { BBox, Floor, View } from './types';
import { contentBBox } from './model';

/** Where a plan sits on a canvas, worked out from the geometry alone.
 *
 *  This maths used to live inside `renderFloorCanvas()` in the browser shell,
 *  so Node could not frame a plan the way the app does — and a control map
 *  framed differently from the reference beside it is a control map for a
 *  different picture. Pure, so the harness and the browser agree by
 *  construction rather than by inspection. */

export interface FrameOpts {
  /** longest side in pixels */
  maxPx?: number;
  /** a generator reference: no dimension chains, no notes, a tight margin */
  clean?: boolean;
  /** dimension chains are drawn, so the margin has to make room for them */
  measures?: boolean;
}

export interface Frame { width: number; height: number; view: View; bbox: BBox }

/** The floor as the frame sees it: the same object unless a measured print has
 *  to drop annotation stranded out in the margin.
 *
 *  A measured print frames the building, not its annotation. Floorplanner's own
 *  dimension chains sit metres off the walls, and letting them set the bounds
 *  rendered the plan at half the scale it could be — which is why everything
 *  came out small and the chains looked scattered. So keep only annotation that
 *  sits against the building, and drop what is stranded: the chains this
 *  renderer draws now say the same thing, closer in. A measure line the user
 *  placed themselves is next to what it measures, so it survives.
 *
 *  Whatever paints inside a frame must paint THIS floor, or it draws ink the
 *  frame did not budget for. */
export function framedFloor(f: Floor, opts: FrameOpts = {}): Floor {
  if (!opts.measures) return f;
  const bb = contentBBox({ ...f, dims: [], lines: [], notes: [], ref: null });
  if (!bb) return f;
  const m = 130;                                      // cm of slack, about a wall's reach
  const near = (p: { x: number; y: number }) =>
    p.x >= bb.x0 - m && p.x <= bb.x1 + m && p.y >= bb.y0 - m && p.y <= bb.y1 + m;
  return {
    ...f,
    dims: f.dims.filter(d => near(d.a) && near(d.b)),
    lines: f.lines.filter(l => near(l.a) && near(l.b)),
    /* the same rule catches the "© Zibber" boilerplate the .fml ships, which
       sits a couple of metres under the plan and stretched the page */
    notes: f.notes.filter(n => near(n)),
  };
}

/** The canvas size and view that fit a floor, or null when there is nothing on
 *  it to fit. Returns no canvas of its own: the browser makes one, Node makes
 *  another, and both frame the plan identically. */
export function planFrame(f: Floor, opts: FrameOpts = {}): Frame | null {
  const framed = framedFloor(f, opts);

  /* Frame on what will actually be drawn, and nothing else. A clean reference
     hides the dimension chains and the notes, so counting them here framed the
     picture around ink that is not in it — and an imported plan's chains sprawl
     a metre past the walls, which made the frame much wider than the building
     without making it taller. The plan then sat in a letterbox, and the
     generator filled the spare bands with an invented title block and captions
     of its own. */
  const b = contentBBox({
    ...framed,
    notes: opts.clean ? [] : framed.notes,
    dims: opts.clean ? [] : framed.dims,
    ref: null,
  });
  if (!b) return null;

  const maxPx = opts.maxPx ?? 1800;
  const fit = (pad: number) => {
    const wCm = b.x1 - b.x0 + pad * 2;
    const hCm = b.y1 - b.y0 + pad * 2;
    return { wCm, hCm, zoom: Math.max(0.15, Math.min(maxPx / Math.max(wCm, hCm), 6)) };
  };

  /* The dimension chains are drawn at a fixed pixel offset, so the margin has
     to be a fixed number of pixels too — which means solving for it once the
     scale is known, rather than picking a distance in centimetres. */
  let pad = opts.clean ? 40 : 70;
  if (opts.measures) pad = Math.max(pad, 88 / fit(pad).zoom);
  const { wCm, hCm, zoom } = fit(pad);

  return {
    width: Math.round(wCm * zoom),
    height: Math.round(hCm * zoom),
    view: { zoom, px: (-b.x0 + pad) * zoom, py: (-b.y0 + pad) * zoom },
    bbox: b,
  };
}
