import type { Area, Floor, Item, Opening, Pt, Wall } from './types';
import type { Frame } from './frame';
import { CAT_BY_KIND } from './catalog';
import { heightOfItem } from './custom';
import { clamp, unitNormal } from './geometry';
import { paint } from './render';
import { pathPoly, wallQuad } from './shapes';

type Ctx = CanvasRenderingContext2D;

/** The conditioning images, drawn from the same vector geometry as the plan.
 *
 *  FLUX.2 reads its input_image semantically — the vendor says so outright, and
 *  there is no strength, no conditioning scale and no control map in the body —
 *  which is why our renders drift: the camera tilts into a dollhouse view, walls
 *  wander, and chair counts change. Prompting cannot fix that (arXiv:2503.06884
 *  on counting, arXiv:2507.08039 on position), so the geometry has to travel as
 *  pixels instead of prose. We already hold the plan as vectors, so a line map,
 *  a depth map, a segmentation map and a per-pixel change map cost us nothing to
 *  emit — and they are the currency of every provider that does accept a control
 *  map with a dial on it.
 *
 *  Every pass is deterministic and none of them draws text. Lettering on a
 *  conditioning image bleeds through into the render, and on a control channel
 *  it would be baked into the structure rather than merely copied. */

export type PassKind = 'ink' | 'line' | 'depth' | 'seg' | 'change';
export const PASS_KINDS: readonly PassKind[] = ['ink', 'line', 'depth', 'seg', 'change'];

export interface PassInput {
  /** The floor the frame was measured from — `framedFloor()` from './frame'
   *  when the frame was taken with `measures`, or the plan itself. Handing a
   *  different one here paints ink the frame did not budget for. */
  floor: Floor;
  frame: Frame;
  pass: PassKind;
  /** off for a reference of the empty shell; the walls stay either way */
  furniture?: boolean;
  /** the room the brief is scoped to, so the pass frames what the brief describes */
  room?: string;
}

/* ── the numbers every pass agrees on ───────────────────────────── */

/** The plan is cut at 1.2 m, the height a floor plan is conventionally sliced
 *  at, so the depth pass and the plan itself describe the same slice. */
const CUT_CM = 120;

/** The floor as a grey. Not 0: black is reserved for "nothing here", and a
 *  floor that reads as void is how a depth encoder invents a hole. */
const FLOOR_DEPTH = 0.16;

/** Denoise strengths for the change map, in the units differential diffusion
 *  wants: 0 is frozen, 1 is free. Walls and openings are the survey and must
 *  not move at all; fitted joinery is where it is because a kitchen fits the
 *  room; loose furniture may be restyled; open floor is the model's to fill. */
const CHANGE = { wall: 0.05, joinery: 0.2, loose: 0.4, floor: 0.9 };

/** Groups that are built in rather than carried in. A kitchen run redrawn
 *  60 cm to the left is a different flat, not a different sofa. */
const FITTED_GROUPS = new Set(['Kitchen', 'Bathroom', 'Structure']);

const grey = (v: number) => `rgb(${v},${v},${v})`;
const g8 = (unit: number) => Math.round(clamp(unit, 0, 1) * 255);

/** A colour both as bytes and as CSS, because the enclosure fill below writes
 *  pixels directly and the rest of the file fills paths. */
type RGB = readonly [number, number, number];
const rgbOf = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Beyond the plan: no floor, no ceiling, nothing to place. What depth and seg
 *  ground on, and — see `groundEnclosed` — the one value nothing inside the walls
 *  may keep. */
const VOID: RGB = [0, 0, 0];

/* ── geometry the passes share ──────────────────────────────────── */

/** An object's footprint, rotated. Deliberately the box and not the glyph: a
 *  glyph's interior is hatch and detail, which a control encoder reads as
 *  texture and repeats as texture. */
function itemQuad(i: Item): Pt[] {
  const r = ((i.rot || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const hw = i.w / 2, hh = i.h / 2;
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const).map(([x, y]) => ({
    x: i.x + x * c - y * s,
    y: i.y + x * s + y * c,
  }));
}

/** The two jambs of an opening, or null when it has collapsed to nothing. The
 *  same clamping `render.ts` does, so a gap lands in the same place on the
 *  control map as it does on the drawing beside it. */
function jambs(w: Wall, op: Opening) {
  const n = unitNormal(w.a, w.b);
  const c = clamp(op.at, 0, 1) * n.L, half = Math.min(op.width, n.L) / 2;
  const t0 = clamp(c - half, 0, n.L), t1 = clamp(c + half, 0, n.L);
  if (t1 - t0 < 0.5) return null;
  const P = (t: number): Pt => ({ x: w.a.x + n.ux * t, y: w.a.y + n.uy * t });
  return { n, p0: P(t0), p1: P(t1), width: t1 - t0 };
}

/** The slab of wall an opening replaces. A hair proud of the wall face so it
 *  covers the band whole — a sliver of wall left behind on a control map is a
 *  1 px mullion the model will happily build. */
function apertureQuad(w: Wall, j: NonNullable<ReturnType<typeof jambs>>): Pt[] {
  const e = (w.t / 2) * 1.02, n = j.n;
  return [
    { x: j.p0.x + n.x * e, y: j.p0.y + n.y * e }, { x: j.p1.x + n.x * e, y: j.p1.y + n.y * e },
    { x: j.p1.x - n.x * e, y: j.p1.y - n.y * e }, { x: j.p0.x - n.x * e, y: j.p0.y - n.y * e },
  ];
}

function fillPoly(g: Ctx, pts: Pt[], colour: string) {
  if (pts.length < 3) return;
  g.fillStyle = colour;
  pathPoly(g, pts);
  g.fill();
}

/** Screen space cleared to `colour`, then world space. Alpha and dashes are
 *  reset rather than assumed: a caller reusing one context across passes would
 *  otherwise blend two flat regions into a third colour that means nothing. */
function ground(g: Ctx, frame: Frame, colour: string) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.setLineDash([]);
  g.fillStyle = colour;
  g.fillRect(0, 0, frame.width, frame.height);
  g.translate(frame.view.px, frame.view.py);
  g.scale(frame.view.zoom, frame.view.zoom);
  g.lineJoin = 'round';
  g.lineCap = 'butt';
}

/** Ground the frame in `hole`, then paint everything the walls enclose in
 *  `floor` — whether or not anyone traced a room over it.
 *
 *  depth and seg used to take their floor from the Area polygons alone, so a room
 *  nobody had drawn read pure black: the same value as the ground outside the
 *  building, on the one channel that carries the third dimension. Measured over
 *  the eval fixtures, 81% of the interior of `unmapped-open` was that black, and
 *  the note on FLOOR_DEPTH above says what black means — a floor that reads as
 *  void is how a depth encoder invents a hole. Tracing a room is not what puts a
 *  floor in it, and `planFacts` already has a `mapped` flag because untraced
 *  open-plan floors are a case the app expects to meet.
 *
 *  Enclosure is a raster question and not a vector one: the union of sixty wall
 *  quads is a boundary problem, and it is at the T-junctions and the mitred
 *  corners that such code goes quietly wrong. So the walls are drawn instead, the
 *  border is flooded, and whatever is neither wall nor reachable from outside is
 *  inside. The wall mass drawn here is deliberately whole — the passes cut their
 *  openings back to floor afterwards, and a barrier with the doorways already
 *  taken out of it would let the flood in through them, after which "outside" is
 *  the whole frame.
 *
 *  Any coverage at all counts as wall, antialiased edges included, and the flood
 *  is 4-connected so a diagonal run of wall pixels seals against it. Both biases
 *  point the same way: the barrier errs thick and the interior errs a pixel
 *  small, which nothing can see because the walls are painted over the top of it.
 *
 *  A plan with no closed loop in it — a garden, half a survey, a plan being drawn
 *  — leaves nothing unreached, so the rewrite puts `hole` back over every pixel
 *  and the pass is byte-for-byte what it was before this existed. Which is also
 *  what a breached barrier degrades to, measured: seeded at the border, the worst
 *  a leak can do is find nothing enclosed and change nothing. Seeded inside it
 *  would answer "the whole frame is floor" instead, and that asymmetry is the
 *  reason the seed is where it is.
 *
 *  One getImageData, one putImageData and two linear passes over the buffer. That
 *  is 7 ms per megapixel measured through @napi-rs/canvas, ten times the 0.6 ms
 *  the rest of the depth pass costs — a readback is the one thing a GPU-backed
 *  2D canvas is bad at, and sixty quads are the thing it is best at. Both depth
 *  and seg pay it, so a 1800 px reference set spends about 40 ms here in total,
 *  which the panel can afford and a tighter loop could not. */
function groundEnclosed(g: Ctx, frame: Frame, f: Floor, hole: RGB, floor: RGB) {
  ground(g, frame, rgbOf(hole));
  /* Three quads is the least that can enclose anything, so a floor with fewer
     skips the flood rather than paying a megapixel to be told there is nothing
     inside — and the commonest plan with no walls at all is a garden. */
  if (f.walls.length < 3) return;
  f.walls.forEach(w => fillPoly(g, wallQuad(w), 'rgb(255,255,255)'));

  const w = frame.width, h = frame.height, n = w * h;
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const WALL = 1, OUTSIDE = 2;
  const state = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) if (d[p]) state[i] = WALL;

  /* Seeded from every border pixel that is not wall, which does the work the
     harness gets from padding its grid with a ring of empty cells: a region out
     of doors has to touch the border somewhere, and the pixel where it touches
     is part of it. A courtyard that touches nothing does read as interior, and
     that is the right answer — the walls do enclose it. */
  const stack = new Int32Array(n);
  let top = 0;
  const push = (i: number) => { if (!state[i]) { state[i] = OUTSIDE; stack[top++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push(n - w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (top > 0) {
    const i = stack[--top], x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const c = state[i] ? hole : floor;
    d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

/* ── the segmentation palette ───────────────────────────────────── */

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function hsl(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `rgb(${Math.round(f(0) * 255)},${Math.round(f(8) * 255)},${Math.round(f(4) * 255)})`;
}

/** The flat colour one object gets, keyed by its catalogue group — and by
 *  'door' / 'window' for an opening, which is an object as far as a
 *  segmentation encoder is concerned and emphatically not a wall.
 *
 *  Hashed rather than allocated from a list, so adding a group cannot renumber
 *  the others. The keys are a fixed set, so whether any two of them collide is
 *  a static fact and `passes.test.ts` asserts it stays false. */
export function segObjectColor(key: string): string {
  return hsl(hash32(`object:${key}`) % 360, 0.72, 0.32);
}

/** Every room on one floor, mapped to the flat colour the seg pass gives it.
 *
 *  The hue is hashed off the area id, so a room keeps its colour between runs
 *  and when its neighbours are edited — a segmentation channel that reshuffles
 *  is a different scene each time, which is the opposite of control. Hashes
 *  collide though, and two rooms sharing a colour are one room to the encoder,
 *  so a taken hue is walked on by the golden angle until it is free. Assigned
 *  in id order, so which of a colliding pair moves does not depend on the order
 *  the rooms happen to sit in the document.
 *
 *  That walk is the one thing that breaks the stability above, and it cannot be
 *  had both ways: telling a collision apart means looking at the other rooms.
 *  Distinctness wins — a room that changed colour between two renders is an
 *  inconsistency, whereas two rooms sharing one is a false statement about the
 *  plan — so deleting a room does hand its hue back to whichever room walked off
 *  it, about one plan in a hundred. Pinned by two tests in passes.test.ts.
 *
 *  Rooms sit light and objects dark, so the two bands stay legible as bands
 *  even where a hash puts a room and a sideboard on the same hue. */
export function segRoomColors(f: Floor): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<number>();
  [...f.areas].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).forEach(a => {
    let h = hash32(`room:${a.id}`) % 360;
    for (let i = 0; taken.has(h) && i < 360; i++) h = Math.round(h + 137.5) % 360;
    taken.add(h);
    out.set(a.id, hsl(h, 0.5, 0.62));
  });
  return out;
}

/** Wall mass. White, because it is the one region every map agrees about and
 *  the one the model must not move. */
export const SEG_WALL = 'rgb(255,255,255)';

/** Floor inside the walls that no Area covers — a class of its own, because it is
 *  neither a room the plan names nor the ground outside the building.
 *
 *  Achromatic, which is what makes it collision-proof: every room and every object
 *  hue comes out of `hsl()` at 0.5 or 0.72 saturation and so can never be grey, no
 *  matter which way the golden-angle walk above sends it. A shared colour would
 *  tell the encoder the untraced floor and some bedroom are one region. */
const SEG_INTERIOR_RGB: RGB = [112, 112, 112];
export const SEG_INTERIOR = rgbOf(SEG_INTERIOR_RGB);

/* ── the passes ─────────────────────────────────────────────────── */

export function paintPass(g: Ctx, input: PassInput): void {
  const { floor: f, frame, pass, furniture = true } = input;
  const items = furniture ? f.items : [];

  if (pass === 'ink') {
    /* One code path with the app's reference image, so the harness measures what
       we actually send — and what we send carries no glyphs at all. It used to
       carry numbered discs; the model painted them into the render as black
       roundels on the floor, which is the same failure the captions had before
       them in a louder font. Every pass here is a control channel, and a mark in
       a control channel is geometry. */
    paint(g, {
      floor: f,
      view: frame.view,
      width: frame.width,
      height: frame.height,
      dpr: 1,
      layers: { rooms: true, areas: false, furn: furniture, dims: false, notes: false },
      grid: false,
      live: false,
      roomLabels: false,
      vignette: false,
      measures: false,
      objectLabels: false,
      hatchFixtures: false,
      /* the renderer's sizes are tuned for a screen canvas; a reference is 2-4× that */
      textScale: Math.max(1, Math.min(frame.width, frame.height) / 900),
    });
    return;
  }

  if (pass === 'line') line(g, f, frame, items);
  else if (pass === 'depth') depth(g, f, frame, items);
  else if (pass === 'seg') seg(g, f, frame, items);
  else change(g, f, frame, items);
  /* back to screen space, as paint() leaves it: a caller that stamps anything
     on top afterwards must not have to know a pass ran in world coordinates */
  g.setTransform(1, 0, 0, 1, 0, 0);
}

/** Black on white: wall mass, openings, room boundaries and object footprints.
 *
 *  Strokes are floored at a few pixels rather than drawn hairline. The published
 *  line ControlNets were trained at 512-1328 px on photographic edge maps, and
 *  a control encoder downsamples through a VAE before it sees anything — a
 *  1 px architectural line does not survive that, it dissolves into grey and
 *  takes the wall it described with it. */
function line(g: Ctx, f: Floor, frame: Frame, items: Item[]) {
  ground(g, frame, '#FFFFFF');
  const px = 1 / frame.view.zoom;                       // one device pixel, in cm
  const heavy = Math.max(3, Math.min(frame.width, frame.height) / 420) * px;
  const light = heavy * 0.7;

  /* room boundaries first: a wall drawn over one says the same thing better */
  g.strokeStyle = '#000000';
  g.lineWidth = light;
  f.areas.forEach(a => { if (a.poly.length > 2) { pathPoly(g, a.poly); g.stroke(); } });

  /* footprints, before the walls, so joinery pushed into a wall does not leave
     a line running through the wall band */
  items.forEach(i => { pathPoly(g, itemQuad(i)); g.stroke(); });

  /* the wall as its own mass: a centreline stroked at the wall's real thickness,
     floored so a 6 cm partition is still a line and not a suggestion */
  f.walls.forEach(w => {
    g.lineWidth = Math.max(w.t, heavy);
    g.beginPath(); g.moveTo(w.a.x, w.a.y); g.lineTo(w.b.x, w.b.y); g.stroke();
  });

  /* openings: the gap, then the marks that say which kind of gap it is */
  f.walls.forEach(w => w.openings.forEach(op => {
    const j = jambs(w, op);
    if (!j) return;
    fillPoly(g, apertureQuad(w, j), '#FFFFFF');
    const ht = w.t / 2, n = j.n;
    g.lineWidth = light;
    [j.p0, j.p1].forEach(p => {                          // jambs
      g.beginPath();
      g.moveTo(p.x + n.x * ht, p.y + n.y * ht);
      g.lineTo(p.x - n.x * ht, p.y - n.y * ht);
      g.stroke();
    });
    if (op.type === 'window') {
      g.beginPath(); g.moveTo(j.p0.x, j.p0.y); g.lineTo(j.p1.x, j.p1.y); g.stroke();
    } else {
      const hinge = op.flip ? j.p1 : j.p0;
      const along = op.flip ? -1 : 1, side = op.side ? -1 : 1;
      const a0 = Math.atan2(n.y * side, n.x * side);
      const a1 = Math.atan2(n.uy * along, n.ux * along);
      let d = a1 - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      g.beginPath(); g.arc(hinge.x, hinge.y, j.width, a0, a1, d < 0); g.stroke();
      g.beginPath();
      g.moveTo(hinge.x, hinge.y);
      g.lineTo(hinge.x + n.x * side * j.width, hinge.y + n.y * side * j.width);
      g.stroke();
    }
  }));
}

/** Near is white. The floor is the far plane, the wall tops at the 1.2 m cut are
 *  the near one, and every object's top sits proportionally between them.
 *
 *  This is the only pass carrying the third dimension, so it is the one that can
 *  answer the dollhouse tilt: a depth map that is flat across the whole plan
 *  describes a scene viewed straight down, and there is no other channel in
 *  which we can say that at all. */
function depth(g: Ctx, f: Floor, frame: Frame, items: Item[]) {
  const FLOOR_G = g8(FLOOR_DEPTH);
  /* Black is beyond the plan; inside the walls there is a floor at the far plane
     whether or not a room was ever traced over it. */
  groundEnclosed(g, frame, f, VOID, [FLOOR_G, FLOOR_G, FLOOR_G]);
  /* Clamped at the cut, because that is what a cut is: a wardrobe that reaches
     2 m is sliced at 1.2 m like everything else, and the plan shows its section,
     not its top. Letting it run past 1 would put a piece of furniture in front
     of the wall it stands against. */
  const at = (z: number) => grey(g8(FLOOR_DEPTH + (1 - FLOOR_DEPTH) * clamp(z / CUT_CM, 0, 1)));
  const FLOOR = grey(FLOOR_G);

  /* The same far plane again, and no longer redundant only because a room may be
     drawn where no wall encloses it — the garden bed on `nl-ground-garden` is a
     floor the flood above cannot reach. */
  f.areas.forEach(a => fillPoly(g, a.poly, FLOOR));
  /* Shortest first, so where two footprints overlap the taller surface survives.
     Painting in document order encodes the ORDER OF THE DOCUMENT instead of the
     height: a rug added after the wardrobe it lies under punched a floor-level
     hole straight through it (measured: grey 44 where the wardrobe reads 255,
     and 255 back again when the two are swapped in the document), which is the
     hole this pass exists to prevent. A depth map is a max over what is there.
     Array.prototype.sort is stable, so items of equal height keep their
     document order and the pass stays deterministic. */
  [...items]
    .sort((p, q) => heightOfItem(p) - heightOfItem(q))
    .forEach(i => fillPoly(g, itemQuad(i), at(heightOfItem(i))));
  f.walls.forEach(w => fillPoly(g, wallQuad(w), at(CUT_CM)));

  /* An opening is where the cut plane meets glass or air rather than masonry,
     so it drops back to the floor plane — a door left at wall height is a wall,
     and the model walls up the doorway accordingly. */
  f.walls.forEach(w => w.openings.forEach(op => {
    const j = jambs(w, op);
    if (j) fillPoly(g, apertureQuad(w, j), FLOOR);
  }));
}

/** Flat colour per region: one per room, one per catalogue group, one for the
 *  floor no room was traced on, one for the wall mass, and one each for doors and
 *  windows — an opening painted as wall
 *  is a wall to the encoder, and that a door is not a wall is the whole point.
 *  No strokes and no alpha anywhere: an edge blended between two classes is a
 *  third class that does not exist. */
function seg(g: Ctx, f: Floor, frame: Frame, items: Item[]) {
  /* The untraced floor is a region and gets a class, the same reasoning as depth:
     painted as nothing it would be the ground outside the building, and a
     building whose middle is the garden is not the plan we are describing. */
  groundEnclosed(g, frame, f, VOID, SEG_INTERIOR_RGB);
  const rooms = segRoomColors(f);
  /* Keyed off this same floor's areas, so every id is present. Asserted rather
     than defaulted: falling back to a colour would paint a room as whichever
     class the fallback named, and the least wrong of those is still a lie about
     what is in the room. */
  f.areas.forEach((a: Area) => fillPoly(g, a.poly, rooms.get(a.id)!));
  items.forEach(i => fillPoly(g, itemQuad(i), segObjectColor(CAT_BY_KIND[i.kind]?.group || 'Other')));
  f.walls.forEach(w => fillPoly(g, wallQuad(w), SEG_WALL));
  f.walls.forEach(w => w.openings.forEach(op => {
    const j = jambs(w, op);
    if (j) fillPoly(g, apertureQuad(w, j), segObjectColor(op.type));
  }));
}

/** How much of each pixel the model may repaint, for differential diffusion.
 *  Black is frozen, white is free.
 *
 *  The ground is the open-floor value and the rooms need no fill of their own:
 *  beyond the walls is the surround, as free as the floor is, and nothing we
 *  drew out there is a measurement. Openings are deliberately left at the
 *  wall's value — a doorway that may drift 20 cm is a doorway that will. */
function change(g: Ctx, f: Floor, frame: Frame, items: Item[]) {
  ground(g, frame, grey(g8(CHANGE.floor)));
  const freedom = (i: Item) =>
    (i.fromFunda || FITTED_GROUPS.has(CAT_BY_KIND[i.kind]?.group || ''))
      ? CHANGE.joinery : CHANGE.loose;
  /* Freest first, so where two footprints overlap the more frozen value wins —
     the same rule the walls already follow by being painted last. In document
     order a rug dropped over a kitchen run unfroze the run (measured: 102, the
     loose value, where the joinery reads 51), and a worktop the model is free to
     move 60 cm is a different flat. Stable sort, so equal values keep their
     document order. */
  [...items]
    .sort((p, q) => freedom(q) - freedom(p))
    .forEach(i => fillPoly(g, itemQuad(i), grey(g8(freedom(i)))));
  f.walls.forEach(w => fillPoly(g, wallQuad(w), grey(g8(CHANGE.wall))));
}
