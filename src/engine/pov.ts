import type { Floor, Pt } from './types';
import type { Face, FaceClass } from './scene';
import type { PovFrame, V3 } from './camera';
import { NEAR_CM, povFrame, project, toView, type Cam } from './camera';
import { buildScene, triangulate, type SceneOpts } from './scene';
import { clamp } from './geometry';
import {
  CHANGE, SEG_INTERIOR, SEG_WALL, itemFreedom, objectHue, segObjectColor, segRoomColors,
  type PassKind,
} from './passes';

type Ctx = CanvasRenderingContext2D;

/** The plan seen from inside it: the same five conditioning channels
 *  `passes.ts` emits from above, drawn instead through a camera standing on the
 *  floor.
 *
 *  Everything in `passes.ts` fills paths on a 2D context because a top-down plan
 *  is already flat. From eye level it is not, and the two things it needs that a
 *  Canvas cannot do are occlusion and per-pixel distance — a chair in front of a
 *  wall must hide the wall, and the depth map must say how far away each of them
 *  is. So this file rasterises: one z-buffered sweep over the massing, into two
 *  buffers that hold, per pixel, how far away the nearest surface is and which
 *  face it belongs to. Every pass is then a read of those two buffers and costs
 *  a single linear scan. Five maps, one rasterisation, and no possibility of two
 *  of them disagreeing about what is in front of what — which is the property
 *  `frame.ts` fought for on the top-down side, obtained here by construction.
 *
 *  No text, ever, for the reason stated at the top of `passes.ts`: a mark on a
 *  control channel is geometry. */

/* ── the buffers ────────────────────────────────────────────────── */

export interface PovBuffers {
  width: number; height: number;
  /** distance from the camera along its own axis, centimetres. `Infinity` where
   *  the ray left the building without meeting anything. */
  depth: Float32Array;
  /** index into `faces`, or -1 for that same nothing */
  face: Int32Array;
  faces: Face[];
  /** the nearest and furthest surface actually drawn, for normalising depth */
  near: number; far: number;
}

/** Plane constants per face, for the coplanarity test the line pass makes at
 *  every pixel. Precomputed once rather than 2 million times. */
interface Plane { nx: number; ny: number; nz: number; d: number }

const planeOf = (f: Face): Plane => ({
  nx: f.n.x, ny: f.n.y, nz: f.n.z,
  d: f.n.x * f.pts[0].x + f.n.y * f.pts[0].y + f.n.z * f.pts[0].z,
});

/** Are these two faces lying in the same surface? Sign-blind, because nothing
 *  gives the two halves of a wall the same winding and a normal that points the
 *  other way is still the same plane.
 *
 *  Used to suppress edges that are joins rather than corners: the four panels a
 *  wall is cut into around a doorway are one wall, and a line drawn where two of
 *  them meet is a line the render will build as a mullion. */
function coplanar(a: Plane, b: Plane): boolean {
  const dot = a.nx * b.nx + a.ny * b.ny + a.nz * b.nz;
  if (Math.abs(dot) < 0.9995) return false;
  return Math.abs(a.d - (dot > 0 ? b.d : -b.d)) < 0.6;
}

/** Clip one face's vertices against the near plane, in camera space.
 *
 *  A polygon crossing behind the lens cannot simply be dropped — that is the
 *  wall you are standing against, and dropping it puts a hole in the middle of
 *  the picture. Nor can it be projected: the perspective divide sends a point
 *  behind the camera to a coordinate on the far side of the frame, drawing the
 *  wall inside out. So it is cut, on the one plane that matters. */
function clipNear(v: V3[]): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    const ain = a.z >= NEAR_CM, bin = b.z >= NEAR_CM;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (NEAR_CM - a.z) / (b.z - a.z);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: NEAR_CM });
    }
  }
  return out;
}

/** One z-buffered sweep over the massing.
 *
 *  Depth is interpolated as 1/z, which is the only quantity that varies linearly
 *  across a triangle once it has been projected — interpolating z itself is the
 *  classic way to get a floor that bows up in the middle of the frame. Nothing
 *  is back-face culled: the faces come out of `scene.ts` wound however the plan
 *  happened to be drawn, and asking sixty walls to agree about which way is
 *  outwards is a bug per wall. The depth test settles it instead, at the cost of
 *  some overdraw that never leaves the buffer. */
export function rasterize(faces: Face[], fr: PovFrame): PovBuffers {
  const w = fr.width, h = fr.height, n = w * h;
  const inv = new Float32Array(n);                 // 1/z, 0 meaning nothing yet
  const face = new Int32Array(n).fill(-1);

  for (let fi = 0; fi < faces.length; fi++) {
    const poly = clipNear(faces[fi].pts.map(p => toView(fr.basis, p)));
    if (poly.length < 3) continue;
    const sc: Pt[] = poly.map(p => project(fr, p));
    const iz = poly.map(p => 1 / p.z);

    for (const [a, b, c] of triangulate(poly)) {
      const x0 = sc[a].x, y0 = sc[a].y, x1 = sc[b].x, y1 = sc[b].y, x2 = sc[c].x, y2 = sc[c].y;
      let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
      if (!Number.isFinite(area) || Math.abs(area) < 1e-9) continue;
      /* One winding from here down, so the inside test is three ">= 0"s rather
         than three sign comparisons against a variable. */
      let ax = x0, ay = y0, bx = x1, by = y1, ia = iz[a], ib = iz[b];
      if (area < 0) { ax = x1; ay = y1; bx = x0; by = y0; ia = iz[b]; ib = iz[a]; area = -area; }
      const cx = x2, cy = y2, ic = iz[c];

      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
      if (minX > maxX || minY > maxY) continue;

      const invArea = 1 / area;
      for (let py = minY; py <= maxY; py++) {
        const sy = py + 0.5;
        const row = py * w;
        for (let px = minX; px <= maxX; px++) {
          const sx = px + 0.5;
          const l0 = ((bx - ax) * (sy - ay) - (by - ay) * (sx - ax)) * invArea;
          if (l0 < 0) continue;
          const l1 = ((cx - bx) * (sy - by) - (cy - by) * (sx - bx)) * invArea;
          if (l1 < 0) continue;
          const l2 = 1 - l0 - l1;
          if (l2 < 0) continue;
          /* l0 is opposite vertex a, l1 opposite b, l2 opposite c — so the
             weights pair with the far vertex of each edge, not the near one. */
          const z = l1 * ia + l2 * ib + l0 * ic;
          const i = row + px;
          if (z > inv[i]) { inv[i] = z; face[i] = fi; }
        }
      }
    }
  }

  const depth = new Float32Array(n);
  let near = Infinity, far = 0;
  for (let i = 0; i < n; i++) {
    if (!inv[i]) { depth[i] = Infinity; continue; }
    const d = 1 / inv[i];
    depth[i] = d;
    if (d < near) near = d;
    if (d > far) far = d;
  }
  return { width: w, height: h, depth, face, faces, near, far };
}

/** The massing for one floor, rasterised. The scene is rebuilt every call — see
 *  the note at the top of `scene.ts` about why nothing here is cached. */
export function rasterizeFloor(f: Floor, fr: PovFrame, opts: SceneOpts = {}): PovBuffers {
  return rasterize(buildScene(f, opts), fr);
}

/* ── what the camera can see ────────────────────────────────────── */

/** The resolution the visibility question is answered at.
 *
 *  Deliberately not the reference image's. This is a yes/no question about a few
 *  dozen objects, and 480 × 320 answers it in a few milliseconds where
 *  1800 × 1200 costs a tenth of a second every time the camera moves. The aspect
 *  and the field of view are `povFrame`'s own, so the edges of this frame are the
 *  edges of the picture that will be sent — a smaller frame here would answer a
 *  different question. */
const IN_SHOT_PX = 480;

/** How much of the frame something has to hold to be worth mentioning at all.
 *
 *  About a dining chair fifteen metres away: at that size it is a smudge, and a
 *  photograph of it would spend a reference slot and a billed megapixel on
 *  something nobody could identify in the render either. Nearer than that,
 *  everything clears it comfortably — a chair at eight metres is 0.4%, at three
 *  metres 2.9% — so it decides only the far tail, which is what a threshold
 *  should do. */
const IN_SHOT_MIN = 0.0015;

/** How much of an OBJECT has to be unhidden before the brief calls it an object
 *  in the room.
 *
 *  The size threshold above is not enough on its own, and the gap between them
 *  is a measured failure rather than a hypothetical. A dining table standing in
 *  the next room, with one corner showing past the edge of a partition, was
 *  4.4% visible and still cleared 0.15% of the frame — so it went into the
 *  OBJECTS table under "each one is already drawn on the plan; keep it exactly
 *  where it is", addressed "right of frame, close to the camera", and the render
 *  came back with a whole dining table and six chairs in the foreground of a
 *  photograph of a kitchen.
 *
 *  Dropping it from the text does not erase it from the picture: the massing
 *  reference still carries the sliver, so the model still draws whatever is
 *  actually there. What stops is the text promoting a sliver into a subject.
 *  That asymmetry is why the cut can afford to be strict — a thing wrongly kept
 *  is drawn twice life-size in the foreground; a thing wrongly dropped is still
 *  in image 1.
 *
 *  Measured against the same object rendered with no architecture in the way, so
 *  it is occlusion this counts and nothing else: an object half out of frame is
 *  clipped identically in both passes and scores 1, and so is one half hidden
 *  behind a nearer sofa. Only walls, doorways and floors move this number. */
const IN_SHOT_COVERAGE = 0.4;

/** Every object and room the camera can actually see, by the id `photoSubjects`
 *  keys on — an `Item.id` or an `Area.id`.
 *
 *  Read off the face buffer rather than computed from the frustum, and that is
 *  the whole reason it is trustworthy: a frustum test says an object is in front
 *  of the camera, which is not the same as being in the picture. A sofa in the
 *  next room is in front of the camera. The face buffer has already resolved
 *  every wall in the way, so "is it in the shot" reduces to "does it own any
 *  pixels", and the answer agrees with the reference image by construction
 *  instead of by a second piece of geometry that has to be kept in step. */
export function idsInShot(f: Floor, cam: Cam): Set<string> {
  const fr = povFrame(cam, { maxPx: IN_SHOT_PX });
  const scene = buildScene(f);
  const full = rasterize(scene, fr);
  /* The same objects with the building taken away, which is what makes the
     coverage ratio mean "hidden" rather than "small" or "half out of frame".
     A second sweep, and a cheap one: a few dozen boxes against several hundred
     wall panels. */
  const bare = rasterize(scene.filter(x => x.cls === 'item'), fr);

  const seen = tally(full);
  const whole = tally(bare);
  const floorPx = Math.max(1, Math.round(full.face.length * IN_SHOT_MIN));

  const out = new Set<string>();
  for (const [id, n] of seen) {
    if (n < floorPx) continue;
    /* Rooms and windows are exempt from the coverage rule, and deliberately: a
       room IS a space you can see part of — a doorway with the next room's floor
       showing through it is worth describing — where an object is a thing the
       brief either tells the model to draw or does not. `whole` has no entry for
       them, so the absence is the exemption. */
    const un = whole.get(id);
    if (un !== undefined && n / un < IN_SHOT_COVERAGE) continue;
    out.add(id);
  }
  return out;
}

/** Pixels per id in one sweep — an `Item.id` for a box, an `Area.id` for a room
 *  floor, an `Opening.id` for a pane of glass. */
function tally(buf: PovBuffers): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < buf.face.length; i++) {
    const fi = buf.face[i];
    if (fi < 0) continue;
    const fa = buf.faces[fi];
    const id = fa.cls === 'item' ? fa.item?.id
      : fa.cls === 'room' || fa.cls === 'window' ? fa.key || undefined
        : undefined;
    if (id) out.set(id, (out.get(id) || 0) + 1);
  }
  return out;
}

/* ── reading the buffers out ────────────────────────────────────── */

type RGB = [number, number, number];

/** The seg palette is written as CSS because every pass in `passes.ts` fills a
 *  path with it. This file writes bytes, so it has to read those strings back —
 *  which is worth it: a room that is one colour from above and another from
 *  inside is two rooms to an encoder, and sharing `segRoomColors` is what makes
 *  that impossible rather than merely unlikely. */
function bytesOf(css: string): RGB {
  const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(css);
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

/** Beyond the plan — the same black `passes.ts` grounds depth and seg on, and
 *  the same meaning: no floor, no ceiling, nothing to place. */
const VOID: RGB = [0, 0, 0];

/** Base colour per surface class for the shaded massing, before the light.
 *
 *  These were six greys until the 2026-09 research sweep: practitioner evidence
 *  (PH's Archviz workflow feeds a colour-coded mesh; texturemap's "the value of a
 *  render is inversely proportional to how much the model had to invent") is that
 *  flat SEMANTIC colour on the reference measurably improves adherence over bare
 *  grey — the model no longer has to decide whether a dark horizontal plane is a
 *  floor or a shadow. So each class now carries a muted placeholder colour in its
 *  material's own family: wood-toned room floors, plaster-off-white walls, a
 *  near-white ceiling. Placeholder, not decoration — the brief still says to
 *  replace every one of them with a real material.
 *
 *  The LUMINANCE of each entry is the old grey, kept on purpose: the tone gaps
 *  between classes were tuned against `AMBIENT` below so that a lit floor never
 *  meets a shadowed wall (see that note), and chroma is added around those values
 *  rather than instead of them. Windows stay pure white because a window IS the
 *  bright thing in an interior photograph, and the render puts daylight wherever
 *  this picture is brightest. The `item` entry is a fallback — a placed object
 *  takes a muted hue of its own from `itemInk` below. */
type RGBf = readonly [number, number, number];

const INK: Record<FaceClass, RGBf> = {
  floor: [0.32, 0.32, 0.32],               // untraced slab: no room, no material claim
  room: [0.46, 0.35, 0.25],                // a traced floor: warm timber family
  ceiling: [0.81, 0.8, 0.78],
  wall: [0.75, 0.72, 0.66],                // plaster, just off the ceiling's white
  window: [1, 1, 1],
  item: [0.55, 0.55, 0.55],
};

/** The muted colour one object group wears in the massing: the same hue its
 *  segmentation colour owns (`objectHue` — shared so the two pictures are one
 *  statement about which block is which), at a quarter of the saturation and the
 *  item class's own luminance. Muted because this is a picture read as a picture:
 *  a saturated teal sofa is an instruction to buy a teal sofa, where a grey-teal
 *  one says "this block is one object, distinct from its neighbours" and leaves
 *  the palette to the STYLE block. */
function itemInk(key: string): RGBf {
  const h = objectHue(key);
  const l = 0.55, s = 0.25;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/** Classes whose `INK` entry is the finished colour, with no light applied.
 *
 *  A window because it is the source and not a surface catching one. A ceiling
 *  because it faces down and the key light comes from above, so it can only ever
 *  take the ambient — lighting it computes one constant and then hides it inside
 *  two other constants, where nobody can see that the ceiling had come out
 *  darker than the brightest wall in the room it is over. Saying the value
 *  outright is what let it be chosen. */
const UNLIT = new Set<FaceClass>(['window', 'ceiling']);

/** A key light from over the camera's left shoulder and high, fixed in the
 *  world rather than to the camera. World-fixed so that turning the camera
 *  round the room does not swim the shading across the walls — the same room
 *  photographed twice should be lit the same way both times, which is what makes
 *  two renders of one plan look like one flat. */
const LIGHT: V3 = (() => {
  const v = { x: 0.34, y: -0.52, z: 0.78 };
  const L = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / L, y: v.y / L, z: v.z / L };
})();

/** How much of a surface is lit before the light reaches it. High, because this
 *  is a massing model and not a lighting study: a face in shadow still has to
 *  read its own tone, and a control encoder cannot tell a dark wall from a
 *  missing one.
 *
 *  It is also what keeps the classes apart. At 0.55 the swing between a lit and
 *  an unlit face was wider than the luminance gap between two `INK` entries, so a floor
 *  turned towards the light came out the same grey as the wall standing on it
 *  and the junction between them disappeared — on the one picture whose job is
 *  to say where the walls are. Narrowing the light lets tone win; the edges
 *  drawn over the top do the rest. */
const AMBIENT = 0.62;

/* ── the passes ─────────────────────────────────────────────────── */

export interface PovPassInput {
  floor: Floor;
  frame: PovFrame;
  pass: PassKind;
  /** off for a massing of the empty shell; the walls stay either way */
  furniture?: boolean;
  /** A rasterisation to read instead of taking a fresh one. Five passes off one
   *  sweep is the whole point of the buffers; pass the same object to each. */
  buffers?: PovBuffers;
}

/** Draws one conditioning channel of the eye-level view onto `g`.
 *
 *  Mirrors `paintPass` from `passes.ts` deliberately, down to the argument
 *  shape, because `files.ts` chooses between them on one flag and everything
 *  downstream — the modal's preview, the control maps, the eval harness — must
 *  not care which of the two drew the picture. */
export function paintPovPass(g: Ctx, input: PovPassInput): void {
  const { floor: f, frame: fr, pass } = input;
  const buf = input.buffers ?? rasterizeFloor(f, fr, { furniture: input.furniture });
  const img = g.createImageData(fr.width, fr.height);
  const px = img.data;

  if (pass === 'line') writeLine(px, buf);
  else if (pass === 'depth') writeDepth(px, buf);
  else if (pass === 'seg') writeSeg(px, buf, f);
  else if (pass === 'change') writeChange(px, buf);
  else writeInk(px, buf, fr);

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.putImageData(img, 0, 0);
}

const put = (px: Uint8ClampedArray, i: number, c: RGB) => {
  const p = i * 4;
  px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255;
};

const grey = (px: Uint8ClampedArray, i: number, v: number) => {
  const g8 = Math.round(clamp(v, 0, 1) * 255);
  put(px, i, [g8, g8, g8]);
};

/** Near is white, which is the same sentence the top-down depth pass is written
 *  under — there it means high above the floor, here it means close to the lens,
 *  and in both it means "the surface in front".
 *
 *  Normalised across the picture rather than to an absolute range in metres,
 *  because that is what every published depth conditioner was trained on: MiDaS
 *  and its descendants emit relative depth, and a map keyed to real centimetres
 *  would put a whole small bedroom in the top eighth of the range and hand the
 *  encoder eight distinguishable values.
 *
 *  Logarithmic in distance, which is the one choice here worth arguing about.
 *  Straight inverse depth is what MiDaS emits and was the first thing this did —
 *  and on a real plan it fails, because a camera standing 95 cm off the near wall
 *  and looking 7 m down the room spends 80% of the range on that wall and leaves
 *  everything past 3 m inside twelve grey levels of black. Measured on the
 *  `nl-ground` fixture. Linear in distance has the opposite fault and flattens
 *  the near half, which is the half — the sofa, the worktop, the doorway — a
 *  render has to get right. Log is the scale-invariant representation the depth
 *  literature actually works in (Eigen et al., and every descendant), it sits
 *  between the two, and it holds a domestic 1-8 m range across the full ramp. */
function writeDepth(px: Uint8ClampedArray, b: PovBuffers) {
  const near = Math.log(Math.max(b.near, NEAR_CM));
  const far = Math.log(Math.max(b.far, b.near * 1.05 + 1));
  const span = far - near || 1;
  for (let i = 0; i < b.depth.length; i++) {
    const d = b.depth[i];
    if (!Number.isFinite(d)) { put(px, i, VOID); continue; }
    grey(px, i, (far - Math.log(d)) / span);
  }
}

/** Flat colour per region, from the same palette the top-down map uses. */
function writeSeg(px: Uint8ClampedArray, b: PovBuffers, f: Floor) {
  const rooms = segRoomColors(f);
  const interior = bytesOf(SEG_INTERIOR);
  const wall = bytesOf(SEG_WALL);
  const ceiling = bytesOf(segObjectColor('ceiling'));
  const window = bytesOf(segObjectColor('window'));
  /* One entry per face rather than per pixel: `segObjectColor` hashes a string,
     and a hash per pixel is two million of them. */
  const colour = b.faces.map((fa): RGB => {
    if (fa.cls === 'wall') return wall;
    if (fa.cls === 'ceiling') return ceiling;
    if (fa.cls === 'window') return window;
    if (fa.cls === 'floor') return interior;
    if (fa.cls === 'room') return bytesOf(rooms.get(fa.key) ?? SEG_INTERIOR);
    return bytesOf(segObjectColor(fa.key || 'Other'));
  });
  for (let i = 0; i < b.face.length; i++) {
    const fi = b.face[i];
    put(px, i, fi < 0 ? VOID : colour[fi]);
  }
}

/** How much of each pixel the model may repaint. Black is frozen, white is free.
 *
 *  The shell is the survey and stays put; the floor and whatever daylight is
 *  beyond the windows are the model's to fill; furniture is as free as
 *  `itemFreedom` says it is, which is the same answer the top-down map gives —
 *  a fitted kitchen is joinery from every angle. */
function writeChange(px: Uint8ClampedArray, b: PovBuffers) {
  const v = b.faces.map(fa => {
    if (fa.cls === 'wall' || fa.cls === 'ceiling' || fa.cls === 'window') return CHANGE.wall;
    if (fa.cls === 'item' && fa.item) return itemFreedom(fa.item);
    return CHANGE.floor;
  });
  for (let i = 0; i < b.face.length; i++) {
    const fi = b.face[i];
    grey(px, i, fi < 0 ? CHANGE.floor : v[fi]);
  }
}

/** Where one surface stops and the next begins, thickened by `r` pixels.
 *
 *  Taken off the face buffer rather than by projecting edges and testing each
 *  against the depth, which is the textbook way and is wrong here — it draws the
 *  seams inside a wall as confidently as it draws its corners. What we want is
 *  the outline of every distinct surface, so the test is per pixel: my neighbour
 *  belongs to a different face, and that face is not lying in my own plane.
 *  Doorway reveals therefore get their edges (a different plane) and the four
 *  panels one wall is cut into around a door do not (the same one).
 *
 *  A room's own floor against the untraced slab half a millimetre under it is
 *  coplanar and so draws nothing, which is right: that boundary is a fact about
 *  what somebody traced, not about the building. It belongs on the segmentation
 *  map, where it is, and a line there would be a skirting board the render
 *  builds. */
function edgeMask(b: PovBuffers, r: number): Uint8Array {
  const { width: w, height: h, face } = b;
  const planes = b.faces.map(planeOf);
  const edge = new Uint8Array(w * h);

  const breaks = (i: number, j: number) => {
    const a = face[i], c = face[j];
    if (a === c) return false;
    if (a < 0 || c < 0) return true;                       // silhouette against nothing
    return !coplanar(planes[a], planes[c]);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if ((x + 1 < w && breaks(i, i + 1)) || (y + 1 < h && breaks(i, i + w))) edge[i] = 1;
    }
  }
  if (r < 1) return edge;

  /* Separable dilation: a horizontal max then a vertical one, which is a square
     brush at two passes over the buffer instead of r² work per pixel. */
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -r; k <= r && !v; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w && edge[y * w + xx]) v = 1;
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -r; k <= r && !v; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 1;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Hidden-line: black where two surfaces meet, white everywhere else.
 *
 *  Thickened, because the published line conditioners were trained at 512-1328 px
 *  on photographic edge maps and everything is downsampled through a VAE before a
 *  control encoder sees it; a one-pixel architectural line does not survive that,
 *  it dissolves into grey and takes the wall it described with it. The same
 *  reasoning, and the same arithmetic, as `line()` in `passes.ts`. */
function writeLine(px: Uint8ClampedArray, b: PovBuffers) {
  const edge = edgeMask(b, Math.max(1, Math.round(Math.min(b.width, b.height) / 420)));
  for (let i = 0; i < edge.length; i++) grey(px, i, edge[i] ? 0 : 1);
}

/** The picture a person looks at, and the one that goes as image 1: a massing
 *  render of the room in flat placeholder colours from where the camera stands,
 *  with its edges drawn over the top.
 *
 *  This is the eye-level answer to the plan drawing, and it is the whole reason
 *  the file exists. A top-down drawing does not contain what an eye-level camera
 *  needs — which wall is behind which, how much of the window the sofa cuts off,
 *  where the horizon falls — so no amount of conditioning on one produces a
 *  faithful photograph from the other. This does contain it.
 *
 *  The lines are not decoration and they are not there to make it pretty. A few
 *  flat colours lit by one lamp cannot keep every pair of touching surfaces apart:
 *  a sofa pushed against the wall behind it shares that wall's normal, so it
 *  takes the same light, and at some tone settings the two differ by a level
 *  or two. That is a picture in which a piece of furniture has no outline, handed
 *  to a model whose job is to draw it. Tone carries the form and the lines carry
 *  the boundaries — which is also, exactly, what the top-down reference does.
 *
 *  Void is white rather than black, and that is the one place this pass departs
 *  from every other. Elsewhere black means "beyond the plan" and is read as a
 *  fact about distance. Here it would be read as a picture: a black rectangle
 *  where a window is, which is a night shot of a room the brief has just
 *  described in daylight. Blown-out white is what an interior photograph actually
 *  does with a window it is not exposing for. */
function writeInk(px: Uint8ClampedArray, b: PovBuffers, fr: PovFrame) {
  const shade = b.faces.map((fa): RGBf => {
    const base = fa.cls === 'item' ? itemInk(fa.key || 'Other') : INK[fa.cls];
    if (UNLIT.has(fa.cls)) return base;
    /* Flip the normal towards the camera before lighting it. Nothing culls back
       faces here, so half the surfaces in the scene face away from the eye
       through no fault of their own — lit as they are wound, a room's four walls
       come out in two different tones. */
    const c = fa.pts[0];
    const away = fa.n.x * (c.x - fr.cam.x) + fa.n.y * (c.y - fr.cam.y) + fa.n.z * (c.z - fr.cam.z);
    const s = away > 0 ? -1 : 1;
    const lam = Math.max(0, s * (fa.n.x * LIGHT.x + fa.n.y * LIGHT.y + fa.n.z * LIGHT.z));
    const lit = AMBIENT + (1 - AMBIENT) * lam;
    /* The light scales the colour, never re-hues it — a wall in shadow is a
       darker wall, not a browner one. */
    return [base[0] * lit, base[1] * lit, base[2] * lit];
  });
  const byte = (v: number) => Math.round(clamp(v, 0, 1) * 255);
  const colour = shade.map((c): RGB => [byte(c[0]), byte(c[1]), byte(c[2])]);
  const EDGE: RGB = [20, 20, 20];
  const PAPER: RGB = [255, 255, 255];
  /* Half the line pass's weight: this picture is read as a picture, and a stroke
     heavy enough to survive a control encoder reads here as a cartoon. */
  const edge = edgeMask(b, Math.max(1, Math.round(Math.min(b.width, b.height) / 900)));
  for (let i = 0; i < b.face.length; i++) {
    const fi = b.face[i];
    put(px, i, edge[i] ? EDGE : fi < 0 ? PAPER : colour[fi]);
  }
}
