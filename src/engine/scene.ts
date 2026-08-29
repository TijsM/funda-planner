import type { Floor, Item, Pt, Wall } from './types';
import type { V3 } from './camera';
import { CEILING_CM, DOOR_HEAD_CM, WINDOW_HEAD_CM, WINDOW_SILL_CM } from './camera';
import { CAT_BY_KIND } from './catalog';
import { heightOfItem } from './custom';
import { shellBBox } from './model';
import { unitNormal } from './geometry';
import { itemQuad, openingSpan } from './shapes';

/** The plan as a solid, which is the thing an eye-level camera can actually be
 *  pointed at.
 *
 *  Nothing here is modelled. Walls become slabs, objects become boxes the height
 *  of their `Z` entry, openings become holes with reveals. That crudeness is the
 *  design and not a first cut: `docs/RENDER-FIDELITY-RESEARCH.md` §2 option 8
 *  reaches the same conclusion from the literature — ControlRoom3D, Ctrl-Room,
 *  SpatialGen and CHOrD all condition on rendered depth and segmentation buffers
 *  of exactly this kind of massing, and Autodesk's head-to-head found that with
 *  depth and normal maps "the staircase, mezzanine railing, and hallway corridor
 *  closely match the original layout" while a screenshot alone had "the spatial
 *  proportions reinterpreted". Boxes carry position, size and occlusion, which
 *  is all a control channel reads. A modelled sofa would carry style too, which
 *  is the half of the picture the diffusion model is for.
 *
 *  Faces are convex where it matters and never reused: this rebuilds from the
 *  document on every render, because it is 3 ms of work and a cached scene is a
 *  scene that disagrees with the plan. */

export type FaceClass = 'floor' | 'room' | 'ceiling' | 'wall' | 'window' | 'item';

export interface Face {
  /** A simple planar polygon in world centimetres, z up. Convex except for
   *  `room`, which is whatever outline somebody traced. */
  pts: V3[];
  cls: FaceClass;
  /** what the segmentation pass colours it by — an area id for a room, a
   *  catalogue group for an object, `''` where the class is the whole answer */
  key: string;
  /** unit normal, pointing out of the solid. Cached because the shaded pass and
   *  the hidden-line pass both want it per pixel and Newell's method is not
   *  free. */
  n: V3;
  /** the object this face belongs to, for the change map's freedom question */
  item?: Item;
}

/** How far the room floors sit above the base slab. Half a millimetre: enough
 *  that the depth test picks the traced room over the untraced ground beneath it
 *  every time, and far too little to see. Two coplanar surfaces would otherwise
 *  fight pixel by pixel and the segmentation map would come out speckled with
 *  two classes, which to an encoder is a floor made of two materials. */
const ROOM_LIFT = 0.05;

export interface SceneOpts {
  /** off for a massing of the empty shell; the walls stay either way */
  furniture?: boolean;
  /** storey height, centimetres */
  ceiling?: number;
}

/* ── building it ────────────────────────────────────────────────── */

/** Newell's method: works on any planar polygon and does not care which three
 *  vertices you would have picked, which a cross product of the first three
 *  does — and the first three vertices of a traced room are quite often nearly
 *  collinear. */
function normalOf(pts: V3[]): V3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    x += (a.y - b.y) * (a.z + b.z);
    y += (a.z - b.z) * (a.x + b.x);
    z += (a.x - b.x) * (a.y + b.y);
  }
  const L = Math.hypot(x, y, z) || 1;
  return { x: x / L, y: y / L, z: z / L };
}

const face = (pts: V3[], cls: FaceClass, key = '', item?: Item): Face =>
  ({ pts, cls, key, n: normalOf(pts), ...(item ? { item } : {}) });

/** A flat polygon at one height, from a plan outline. */
const slab = (poly: Pt[], z: number, cls: FaceClass, key = ''): Face =>
  face(poly.map(p => ({ x: p.x, y: p.y, z })), cls, key);

/** One rectangular panel of wall, given the two ends of its footprint line and
 *  the two heights it spans. Wound so the four corners trace the rectangle
 *  rather than crossing it. */
const panel = (a: Pt, b: Pt, z0: number, z1: number, cls: FaceClass, key = ''): Face =>
  face([
    { x: a.x, y: a.y, z: z0 }, { x: b.x, y: b.y, z: z0 },
    { x: b.x, y: b.y, z: z1 }, { x: a.x, y: a.y, z: z1 },
  ], cls, key);

/** Every face of one wall: two long elevations cut around the openings, the two
 *  end caps, and the reveals — the jamb, head and sill surfaces inside each
 *  aperture.
 *
 *  The reveals are what make a doorway read as a hole through something. Without
 *  them a door is a rectangle of nothing in a plane of nothing, and both the
 *  depth map and the render take it for a dark painting on the wall. With them
 *  the aperture has a thickness, and the thickness is the wall's own. */
function wallFaces(w: Wall, ceiling: number, out: Face[]): void {
  const u = unitNormal(w.a, w.b);
  const L = u.L;
  if (L < 0.5) return;
  const h = w.t / 2;

  /** a point on the wall at distance `t` from `a`, offset `side` half-thicknesses */
  const P = (t: number, side: number): Pt => ({
    x: w.a.x + u.ux * t + u.x * h * side,
    y: w.a.y + u.uy * t + u.y * h * side,
  });

  /* Sorted and non-overlapping, because the elevation below walks them left to
     right with a cursor. Two openings drawn on top of each other is not a plan
     anyone meant, and the cursor turns the second into a no-op rather than into
     a panel with negative width. */
  const aps = w.openings
    .map(op => {
      const s = openingSpan(w, op);
      if (!s) return null;
      const z0 = op.type === 'window' ? WINDOW_SILL_CM : 0;
      const z1 = Math.min(op.type === 'window' ? WINDOW_HEAD_CM : DOOR_HEAD_CM, ceiling);
      return { id: op.id, t0: s.t0, t1: s.t1, z0, z1, type: op.type };
    })
    .filter((a): a is NonNullable<typeof a> => !!a && a.z1 > a.z0)
    .sort((a, b) => a.t0 - b.t0);

  for (const side of [1, -1]) {
    let cursor = 0;
    for (const a of aps) {
      if (a.t1 <= cursor) continue;
      const t0 = Math.max(a.t0, cursor);
      if (t0 - cursor > 0.5) out.push(panel(P(cursor, side), P(t0, side), 0, ceiling, 'wall'));
      /* the two strips the aperture leaves behind: under a window's sill, over
         every opening's head */
      if (a.z0 > 0.5) out.push(panel(P(t0, side), P(a.t1, side), 0, a.z0, 'wall'));
      if (ceiling - a.z1 > 0.5) out.push(panel(P(t0, side), P(a.t1, side), a.z1, ceiling, 'wall'));
      cursor = a.t1;
    }
    if (L - cursor > 0.5) out.push(panel(P(cursor, side), P(L, side), 0, ceiling, 'wall'));
  }

  /* End caps. Buried inside the neighbour at a corner, which costs a few pixels
     of overdraw and saves knowing which walls meet — and visible, correctly, on
     the free end of a stub wall. */
  out.push(panel(P(0, 1), P(0, -1), 0, ceiling, 'wall'));
  out.push(panel(P(L, 1), P(L, -1), 0, ceiling, 'wall'));

  for (const a of aps) {
    /* jambs, then the head, then a window's sill */
    out.push(panel(P(a.t0, 1), P(a.t0, -1), a.z0, a.z1, 'wall'));
    out.push(panel(P(a.t1, 1), P(a.t1, -1), a.z0, a.z1, 'wall'));
    out.push(face([
      { x: P(a.t0, 1).x, y: P(a.t0, 1).y, z: a.z1 }, { x: P(a.t1, 1).x, y: P(a.t1, 1).y, z: a.z1 },
      { x: P(a.t1, -1).x, y: P(a.t1, -1).y, z: a.z1 }, { x: P(a.t0, -1).x, y: P(a.t0, -1).y, z: a.z1 },
    ], 'wall'));
    if (a.z0 > 0.5) {
      out.push(face([
        { x: P(a.t0, 1).x, y: P(a.t0, 1).y, z: a.z0 }, { x: P(a.t1, 1).x, y: P(a.t1, 1).y, z: a.z0 },
        { x: P(a.t1, -1).x, y: P(a.t1, -1).y, z: a.z0 }, { x: P(a.t0, -1).x, y: P(a.t0, -1).y, z: a.z0 },
      ], 'wall'));
    }
    /* Glass fills a window and nothing fills a door, which is the difference
       between the two as far as a camera is concerned: one is a surface at a
       known distance, the other is a view of the next room. A door left glazed
       is a door the render walls up. */
    if (a.type === 'window') {
      /* The opening's own id rides in `key`, which the segmentation pass does not
         read on this class — it colours a window by its class, because that a
         window is not a wall is the whole point there. It is read by
         `idsInShot`, so the brief can say how many windows are actually in the
         picture instead of naming compass elevations that mean nothing from
         inside the room. */
      out.push(panel(P(a.t0, 0), P(a.t1, 0), a.z0, a.z1, 'window', a.id));
    }
  }
}

/** Every face of one object: a box on the floor, `Z` centimetres tall.
 *
 *  No bottom face — it is on the floor and nothing can see it — and no attempt
 *  at the shape a person drew. `itemQuad` is the footprint the top-down control
 *  maps already use, so an object occupies the same ground in both. */
function itemFaces(i: Item, out: Face[]): void {
  const q = itemQuad(i);
  const h = heightOfItem(i);
  if (h < 0.5) return;                       // a painted-on line, not a solid
  const key = CAT_BY_KIND[i.kind]?.group || 'Other';
  for (let k = 0; k < q.length; k++) {
    const a = q[k], b = q[(k + 1) % q.length];
    out.push(face([
      { x: a.x, y: a.y, z: 0 }, { x: b.x, y: b.y, z: 0 },
      { x: b.x, y: b.y, z: h }, { x: a.x, y: a.y, z: h },
    ], 'item', key, i));
  }
  out.push(face(q.map(p => ({ x: p.x, y: p.y, z: h })), 'item', key, i));
}

/** The plan as faces a camera can be pointed at.
 *
 *  Floor and ceiling are one slab each over the building's bounding box rather
 *  than a traced interior. That is a deliberate approximation and it has one
 *  visible consequence, which is worth stating rather than discovering: looking
 *  out through an exterior window you see the cut edge of the slabs and then
 *  black, because nothing here models the outdoors. Black is what every other
 *  pass in this codebase already means by "beyond the plan" (`VOID` in
 *  `passes.ts`), and the brief tells the model what daylight is on the other
 *  side. The alternative — flooding the enclosed interior the way `passes.ts`
 *  does — is a raster answer, and this file needs polygons.
 *
 *  Traced rooms sit half a millimetre over the base slab so the segmentation map
 *  can name them. Untraced floor is a class of its own for the same reason it is
 *  in `passes.ts`: it is neither a room the plan names nor the ground outside. */
export function buildScene(f: Floor, opts: SceneOpts = {}): Face[] {
  const ceiling = opts.ceiling ?? CEILING_CM;
  const out: Face[] = [];

  const b = shellBBox(f);
  if (b && b.x1 > b.x0 && b.y1 > b.y0) {
    const rect = [
      { x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 },
    ];
    out.push(slab(rect, 0, 'floor'));
    /* Only under a roof. Three quads is the least that can enclose anything —
       the same threshold `groundEnclosed` uses — and the commonest plan with
       fewer walls than that is a garden, which has no ceiling. */
    if (f.walls.length >= 3) out.push(slab(rect, ceiling, 'ceiling'));
  }

  f.areas.forEach(a => { if (a.poly.length > 2) out.push(slab(a.poly, ROOM_LIFT, 'room', a.id)); });
  f.walls.forEach(w => wallFaces(w, ceiling, out));
  if (opts.furniture !== false) f.items.forEach(i => itemFaces(i, out));

  return out;
}

/* ── triangulation ──────────────────────────────────────────────── */

/** Ear clipping over a polygon's dominant plane, for the one face class that can
 *  be concave: a room somebody traced round a chimney breast.
 *
 *  Everything else this file emits is a rectangle, and a rectangle fans
 *  correctly — so this runs on a handful of polygons per plan and its O(n²) is
 *  not worth improving. Falls back to a fan if the outline defeats it (a
 *  self-intersecting trace), because a slightly wrong floor beats no floor: the
 *  depth map's own comment says a floor that reads as void is how an encoder
 *  invents a hole. */
export function triangulate(pts: readonly V3[]): [number, number, number][] {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  /* Drop the axis the polygon is flattest along, so the remaining two carry its
     real shape. A vertical wall panel projected onto xy would be a line. */
  const nv = normalOf(pts as V3[]);
  const ax = Math.abs(nv.x), ay = Math.abs(nv.y), az = Math.abs(nv.z);
  const flat = (p: V3): Pt => (az >= ax && az >= ay ? { x: p.x, y: p.y }
    : ax >= ay ? { x: p.y, y: p.z } : { x: p.z, y: p.x });
  const P = pts.map(flat);

  const area2 = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += P[i].x * P[(i + 1) % n].y - P[(i + 1) % n].x * P[i].y;
  const ccw = sum > 0;

  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const out: [number, number, number][] = [];

  let guard = n * n;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const a = P[i0], b = P[i1], c = P[i2];
      const cross = area2(a, b, c);
      if (ccw ? cross <= 0 : cross >= 0) continue;          // reflex, not an ear
      let clear = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        const p = P[j];
        const s0 = area2(a, b, p), s1 = area2(b, c, p), s2 = area2(c, a, p);
        const neg = s0 < 0 || s1 < 0 || s2 < 0, pos = s0 > 0 || s1 > 0 || s2 > 0;
        if (!(neg && pos)) { clear = false; break; }        // inside the ear
      }
      if (!clear) continue;
      out.push([i0, i1, i2]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);

  if (!out.length) for (let i = 1; i < n - 1; i++) out.push([0, i, i + 1]);
  return out;
}
