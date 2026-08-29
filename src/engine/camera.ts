import type { Area, Floor, Pt, Wall } from './types';
import { bboxOf, clamp, dist, distToSeg, polyArea, pointInPoly, polyCentroid, unitNormal } from './geometry';
import { shellBBox } from './model';
import { openingSpan } from './shapes';

/** A virtual camera standing inside the plan, and the pinhole maths that turns
 *  the plan into what it sees.
 *
 *  Everything above this file works in two dimensions because a floor plan is
 *  two-dimensional. This one adds the third, and it can only do so because the
 *  document already carries the missing number: `catalog.ts`'s `Z` table gives
 *  every object a height, and `heightOfItem` answers for the custom ones. That
 *  table was added for the top-down depth pass, where it says how far a surface
 *  is from a camera pointing straight down. Read from a camera standing on the
 *  floor it says something much stronger — where the object's top edge crosses
 *  the picture — and that is the whole of what an eye-level conditioning image
 *  needs and a top-down drawing does not contain.
 *
 *  Angles follow `Item.rot`: degrees, measured from +x, increasing towards +y.
 *  Because y grows downward (Floorplanner's convention, see `types.ts`) that is
 *  clockwise as the plan is drawn, so yaw 0 looks east, 90 looks south, 270
 *  looks north — up the page.
 *
 *  Heights are a third axis this codebase has never had to name: `z` grows
 *  UPWARD from the floor, which is the opposite sense to the y that grows down
 *  the page. Both conventions are right in their own plane and neither can be
 *  changed, so the one place they meet is `camBasis` below. */

export interface Cam {
  /** where the camera stands, in plan centimetres */
  x: number; y: number;
  /** eye height above the floor, centimetres */
  z: number;
  /** which way it looks, degrees — the same convention as `Item.rot` */
  yaw: number;
  /** how far above the horizon it tilts, degrees. Positive looks up. */
  pitch: number;
  /** horizontal field of view, degrees */
  fov: number;
}

/** A point in the world the camera sees: the plan's x and y, plus height. */
export interface V3 { x: number; y: number; z: number }

/** Storey height. The one number the document does not carry anywhere: a plan
 *  has no ceiling in it. 260 cm is the Dutch post-war norm and is already the
 *  figure `catalog.ts` gives the things it calls floor-to-ceiling — a column, a
 *  duct, a stair enclosure are all `z: 260` there, with the comment "these run
 *  floor to ceiling, so they are the storey itself". Taking the same number
 *  keeps one answer to the question rather than two that drift. */
export const CEILING_CM = 260;

/** Standing eye height. Not the 170 cm of an average Dutch adult's eyes: an
 *  interior photograph is taken from a tripod at chest-to-chin height, because
 *  a lens at full standing height looks down on the furniture and makes a room
 *  read as smaller than it is. Estate agents shoot at about this. */
export const EYE_CM = 155;

/** Horizontal field of view. Interior photography is wide — 16-24 mm on full
 *  frame, which is 74-97° — because a domestic room cannot be seen from far
 *  enough back to shoot it at a normal focal length. 75° is the conservative end
 *  of that, wide enough to hold a whole Dutch living room from its far corner
 *  and not so wide that the near end of the sofa bows. */
export const DEFAULT_FOV = 75;

/** Where a door's head and a window's head and sill sit. Invented rather than
 *  read off the document, because a floor plan is a horizontal cut and says
 *  nothing about any of them.
 *
 *  Dutch conventions: an interior door leaf is 201.5 or 231 cm and its frame a
 *  little over, so 210 is the common case; a window sill in a living room sits
 *  at about 90 and the head lines through with the doors. Shared by both, which
 *  is what makes an opening read as belonging to the same building as the one
 *  beside it.
 *
 *  Here beside `CEILING_CM` rather than in `scene.ts` where they are extruded,
 *  because the sight-line maths below has to know whether the eye is inside a
 *  doorway — and `scene.ts` imports this file, so it cannot be the other way
 *  round. */
export const DOOR_HEAD_CM = 210;
export const WINDOW_SILL_CM = 90;
export const WINDOW_HEAD_CM = 210;

/** How close a surface may come before it is clipped away, in centimetres.
 *  A whole centimetre rather than a hair, because the projection divides by this
 *  and a surface at a hundredth of a centimetre projects to a coordinate no
 *  raster loop should be asked to walk. */
export const NEAR_CM = 1;

export const newCam = (o: Partial<Cam> = {}): Cam => ({
  x: 0, y: 0, z: EYE_CM, yaw: 0, pitch: 0, fov: DEFAULT_FOV, ...o,
});

/** Every angle pulled into range and every distance made finite, because a
 *  camera arrives from a stored render setting, a number field and a drag, and
 *  exactly one of those three can be trusted. A camera below the floor or past
 *  the ceiling is not a viewpoint anybody meant; a fov of 179 is a projection
 *  whose focal length is nearly zero. */
export function normaliseCam(c: Partial<Cam> | null | undefined): Cam {
  const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  return {
    x: num(c?.x, 0),
    y: num(c?.y, 0),
    z: clamp(num(c?.z, EYE_CM), 5, CEILING_CM - 5),
    yaw: ((num(c?.yaw, 0) % 360) + 360) % 360,
    pitch: clamp(num(c?.pitch, 0), -60, 60),
    fov: clamp(num(c?.fov, DEFAULT_FOV), 20, 130),
  };
}

/* ── the projection ─────────────────────────────────────────────── */

/** The camera's own three axes in world coordinates, plus where it stands.
 *
 *  `f` is the way it looks, `r` is its right hand and `u` is its up. The sign
 *  work is all in here and is worth stating once: y grows DOWN the page and z
 *  grows UP off the floor, so a camera facing north — up the page — has a
 *  forward of (0, -1, 0), and its right hand points east, (1, 0, 0). That is
 *  `r = (-sin yaw, cos yaw, 0)`, which is the forward vector turned a quarter
 *  turn the way the page reads as clockwise. Get this backwards and every render
 *  comes out mirrored, which is the one error a plausible-looking picture hides
 *  best. `camera.test.ts` pins all three axes against that worked example. */
export interface CamBasis { o: V3; f: V3; r: V3; u: V3 }

export function camBasis(c: Cam): CamBasis {
  const yaw = (c.yaw * Math.PI) / 180, pitch = (c.pitch * Math.PI) / 180;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return {
    o: { x: c.x, y: c.y, z: c.z },
    f: { x: cy * cp, y: sy * cp, z: sp },
    r: { x: -sy, y: cy, z: 0 },
    u: { x: -cy * sp, y: -sy * sp, z: cp },
  };
}

/** What the camera sees, sized. `focal` is in pixels: the distance from the
 *  pinhole to the picture at which the given horizontal fov fills the width. */
export interface PovFrame { width: number; height: number; cam: Cam; basis: CamBasis; focal: number }

export interface PovFrameOpts {
  /** longest side in pixels */
  maxPx?: number;
  /** width ÷ height. 3:2 by default — the shape of a photograph, and of the
   *  landscape frame every interior shot in a listing is cropped to. */
  aspect?: number;
}

export function povFrame(cam: Cam, opts: PovFrameOpts = {}): PovFrame {
  const c = normaliseCam(cam);
  const aspect = Math.max(0.2, Math.min(opts.aspect ?? 3 / 2, 5));
  const maxPx = Math.max(64, Math.round(opts.maxPx ?? 1800));
  const width = aspect >= 1 ? maxPx : Math.round(maxPx * aspect);
  const height = aspect >= 1 ? Math.round(maxPx / aspect) : maxPx;
  return {
    width, height, cam: c, basis: camBasis(c),
    focal: width / 2 / Math.tan((c.fov * Math.PI) / 360),
  };
}

/** A world point in the camera's own frame: `z` is the distance along the way it
 *  is looking, which is what the depth test and the perspective divide both
 *  want, and is NOT the world height of the same name. */
export function toView(b: CamBasis, p: V3): V3 {
  const dx = p.x - b.o.x, dy = p.y - b.o.y, dz = p.z - b.o.z;
  return {
    x: dx * b.r.x + dy * b.r.y + dz * b.r.z,
    y: dx * b.u.x + dy * b.u.y + dz * b.u.z,
    z: dx * b.f.x + dy * b.f.y + dz * b.f.z,
  };
}

/** A camera-space point on the picture. Screen y runs down, camera up runs up,
 *  hence the subtraction. Callers must have clipped to `z >= NEAR_CM` first —
 *  this divides, and a point behind the lens projects to a plausible coordinate
 *  on the wrong side of the frame. */
export function project(fr: PovFrame, v: V3): Pt {
  return {
    x: fr.width / 2 + (fr.focal * v.x) / v.z,
    y: fr.height / 2 - (fr.focal * v.y) / v.z,
  };
}

/** Where something sits IN THE PICTURE, in the words somebody describing the
 *  photograph would use.
 *
 *  The plan-relative address `placeOf` writes — "against the left wall, upper" —
 *  is read off a drawing seen from above, and from a camera standing in the room
 *  it points at the wrong block: the left wall of the plan is behind you, or on
 *  your right, depending entirely on which way you turned. Its job in the brief
 *  is identification, picking out which of four rectangles a row is talking
 *  about, and an identification that is wrong is worse than none.
 *
 *  Two coarse axes and no more. Position through prose measures 0.41 quadrant F1
 *  (arXiv:2507.08039) and the picture carries the exact answer already, so this
 *  is deliberately the resolution of a caption rather than of a coordinate. */
export function shotAddress(c: Cam, p: Pt): string {
  const b = camBasis(c);
  const v = toView(b, { x: p.x, y: p.y, z: c.z });
  if (v.z <= NEAR_CM) return 'behind the camera';
  /* -1 at the left edge of frame, +1 at the right, because the fov is the field
     the width subtends — the same relation `povFrame` builds its focal from. */
  const u = (v.x / v.z) / Math.tan((c.fov * Math.PI) / 360);
  const side = u < -0.33 ? 'left of frame' : u > 0.33 ? 'right of frame' : 'centre of frame';
  const depth = v.z < 220 ? 'close to the camera' : v.z < 500 ? 'mid-distance' : 'at the back';
  return `${side}, ${depth}`;
}

/* ── choosing one for the user ──────────────────────────────────── */

/** Rooms are polygons and openings are on walls, so which windows belong to a
 *  room is a question neither object answers. Near the boundary is the whole
 *  test: a window is in the wall the room is drawn against, and the room's
 *  outline is traced along that wall's face. */
const OPENING_REACH = 45;

interface Aim { at: Pt; kind: 'window' | 'door' | 'centre' }

/** The point in a room worth pointing a camera at. A window, because that is
 *  where the light and the view are and it is what an estate agent shoots
 *  towards; the widest one when there are several, since it is the one that
 *  makes the room. Failing that a door, which at least gives the picture depth
 *  past the near wall. Failing both, the middle of the room. */
function aimFor(f: Floor, poly: Pt[]): Aim {
  let best: { at: Pt; width: number; kind: 'window' | 'door' } | null = null;
  for (const w of f.walls) {
    const n = unitNormal(w.a, w.b);
    for (const op of w.openings) {
      const t = clamp(op.at, 0, 1) * n.L;
      const at = { x: w.a.x + n.ux * t, y: w.a.y + n.uy * t };
      let near = Infinity;
      for (let i = 0; i < poly.length; i++) {
        near = Math.min(near, distToSeg(at, poly[i], poly[(i + 1) % poly.length]));
      }
      if (near > OPENING_REACH + w.t) continue;
      /* A window outranks any door, however wide the door: they are different
         pictures, not two sizes of the same one. */
      const rank = (k: string, wd: number) => (k === 'window' ? 1e6 : 0) + wd;
      if (!best || rank(op.type, op.width) > rank(best.kind, best.width)) {
        best = { at, width: op.width, kind: op.type };
      }
    }
  }
  return best ? { at: best.at, kind: best.kind } : { at: polyCentroid(poly), kind: 'centre' };
}

/** How far off the walls the camera stands. A lens pressed against the plaster
 *  sees the room through a keyhole and puts the near wall's corner in shot; a
 *  step back from it is what a photographer actually does. */
const STAND_OFF = 55;

/** Where to stand to see the most of a room while looking at `aim`: inside the
 *  outline, off the walls, and as far from the target as that allows.
 *
 *  Sampled on a grid rather than solved, because "inside a possibly concave
 *  polygon and at least this far from all of its edges" has no closed form worth
 *  writing for an L-shaped living room, and a 24×24 sweep of `pointInPoly` over
 *  one room is well under a millisecond. Deterministic: same room, same point,
 *  which is what stops the default camera moving between two openings of the
 *  same panel. */
function standPoint(poly: Pt[], aim: Pt): Pt {
  const b = bboxOf(poly);
  const N = 24;
  const edge = (p: Pt) => {
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) d = Math.min(d, distToSeg(p, poly[i], poly[(i + 1) % poly.length]));
    return d;
  };
  /* Two tries: the clearance a photographer wants, then whatever the room can
     actually give. A 3 m² box room has no point 55 cm off all four walls, and
     refusing to place a camera in it is worse than standing closer than ideal. */
  for (const want of [STAND_OFF, 12, 0]) {
    let best: Pt | null = null, bestD = -1;
    for (let iy = 0; iy <= N; iy++) {
      for (let ix = 0; ix <= N; ix++) {
        const p = { x: b.x0 + ((b.x1 - b.x0) * ix) / N, y: b.y0 + ((b.y1 - b.y0) * iy) / N };
        if (!pointInPoly(p, poly) || edge(p) < want) continue;
        const d = dist(p, aim);
        if (d > bestD) { bestD = d; best = p; }
      }
    }
    if (best) return best;
  }
  return polyCentroid(poly);
}

/** A camera nobody has placed yet: standing back in the room, looking at its
 *  window. Null only when there is nothing on the floor to stand in.
 *
 *  This is what the panel opens with, and it matters more than a default usually
 *  does: the alternative to a good guess is a person dragging a cone around a
 *  minimap to find out what the room looks like from anywhere at all. */
export function autoCam(f: Floor, roomId?: string | null): Cam | null {
  const named = roomId && roomId !== '*' ? f.areas.find(a => a.id === roomId) : undefined;
  const room: Area | undefined = named
    ?? [...f.areas].sort((a, b) => polyArea(b.poly) - polyArea(a.poly))[0];

  /* No room traced anywhere: stand in the building's own outline instead. An
     open-plan floor nobody has drawn rooms on is a case the app expects to meet
     — `planFacts` carries a `mapped` flag for exactly it. */
  const poly = room?.poly?.length && room.poly.length > 2 ? room.poly : shellPoly(f);
  if (!poly) return null;

  const aim = aimFor(f, poly);
  const at = standPoint(poly, aim.at);
  const dx = aim.at.x - at.x, dy = aim.at.y - at.y;
  return newCam({
    x: Math.round(at.x),
    y: Math.round(at.y),
    yaw: Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360),
  });
}

/** The building as a rectangle, for a floor with no rooms drawn on it. */
function shellPoly(f: Floor): Pt[] | null {
  const b = shellBBox(f);
  if (!b || b.x1 - b.x0 < 50 || b.y1 - b.y0 < 50) return null;
  return [
    { x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 },
  ];
}

/** Which room the camera is standing in, or null out in the hall. Read by the
 *  brief, which has to name the room it is describing, and by the panel, which
 *  says it back to the person aiming. */
export function camRoom(f: Floor, c: Cam): Area | null {
  for (const a of f.areas) if (a.poly.length > 2 && pointInPoly({ x: c.x, y: c.y }, a.poly)) return a;
  return null;
}

/** Is the camera inside the walls at all? A viewpoint out in the garden looking
 *  at the back of the building renders a wall filling the frame, and the honest
 *  moment to say so is while it is being aimed. */
export function camInside(f: Floor, c: Cam): boolean {
  if (camRoom(f, c)) return true;
  const b = shellBBox(f);
  return !!b && c.x >= b.x0 && c.x <= b.x1 && c.y >= b.y0 && c.y <= b.y1;
}

/** How far a ray from the camera travels before it meets something it cannot
 *  see past, or Infinity.
 *
 *  A doorway is not such a thing: it is a hole from the floor to 210 cm, and an
 *  eye at 155 cm is inside that, so the ray goes through into the next room —
 *  which is exactly what the massing does, where a door is an absence of
 *  geometry. A window IS such a thing, for the matching reason: `scene.ts` puts
 *  a pane of glass across it and the depth buffer stops there, so a sight line
 *  that carried on past a window would describe a picture nobody is sent.
 *
 *  Agreeing with the massing is the whole requirement here. This is drawn on a
 *  minimap as the region the camera can see, and a cone that disagrees with
 *  `idsInShot` is a second opinion about what is in the photograph. */
function solidHit(w: Wall, from: Pt, z: number, dx: number, dy: number): number {
  const ex = w.b.x - w.a.x, ey = w.b.y - w.a.y;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-9) return Infinity;                 // parallel
  const qx = w.a.x - from.x, qy = w.a.y - from.y;
  const t = (qx * ey - qy * ex) / den;                       // along the ray
  const s = (dx * qy - qx * dy) / -den;                      // 0..1 along the wall
  if (!(t > 1 && s >= 0 && s <= 1)) return Infinity;

  const L = Math.hypot(ex, ey);
  for (const op of w.openings) {
    if (op.type !== 'door') continue;                        // glazing stops the eye
    const span = openingSpan(w, op);
    if (!span) continue;
    const u = s * L;
    if (u >= span.t0 && u <= span.t1 && z >= 0 && z <= DOOR_HEAD_CM) return Infinity;
  }
  return t;
}

/** The distance to the nearest wall the camera is looking at — how much room the
 *  shot actually has, ignoring furniture. Under a metre or so and the picture is
 *  a close-up of plaster, which is the one failure a person cannot see on a
 *  minimap. Straight through an open doorway it is the far room's wall, because
 *  that is what the lens is actually looking at. */
export function sightLine(f: Floor, c: Cam): number {
  const b = camBasis(c);
  let best = Infinity;
  for (const w of f.walls) best = Math.min(best, solidHit(w, b.o, c.z, b.f.x, b.f.y));
  return best;
}

/** How many rays the region below is traced with. Ninety-seven across the fov
 *  puts one every 0.8° at the default 75°, which on a 268 px minimap is finer
 *  than a pixel at any distance the cone is drawn to. Fixed rather than adaptive
 *  because the whole sweep is a few thousand segment intersections — well under
 *  a millisecond, and it runs on every pointermove of a drag. */
const SIGHT_RAYS = 96;

/** What the camera can actually see, as a polygon on the plan: the eye, then the
 *  first solid thing along each ray across the field of view.
 *
 *  This exists because the alternative was a lie. The minimap used to draw the
 *  view as a circular wedge — one radius, taken from the centre ray, swept
 *  across the whole fov — so it ran straight through walls and out the other
 *  side. Someone looking at it saw the cone lying over a dining table two rooms
 *  away and reasonably concluded the camera could see through masonry. The
 *  visibility test never thought so, being a depth buffer; only the picture of
 *  it did, which is the worse of the two places for a thing to be wrong.
 *
 *  Furniture is deliberately not traced. A sofa does not bound what the shot is
 *  OF, and a cone with a bite out of it for every wardrobe is unreadable at
 *  268 px — the walls are the shape of the room and the shape is the point. */
export function sightPolygon(f: Floor, c: Cam, maxCm = 2000): Pt[] {
  const cam = normaliseCam(c);
  const from = { x: cam.x, y: cam.y };
  const half = (cam.fov * Math.PI) / 360;
  const yaw = (cam.yaw * Math.PI) / 180;
  const out: Pt[] = [from];
  for (let i = 0; i <= SIGHT_RAYS; i++) {
    const a = yaw - half + (2 * half * i) / SIGHT_RAYS;
    const dx = Math.cos(a), dy = Math.sin(a);
    let best = maxCm;
    for (const w of f.walls) {
      const t = solidHit(w, from, cam.z, dx, dy);
      if (t < best) best = t;
    }
    out.push({ x: from.x + dx * best, y: from.y + dy * best });
  }
  return out;
}
