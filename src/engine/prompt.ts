import type { Area, BBox, Floor, Item, Pt } from './types';
import { bboxOf, bearing, compass, polyArea, polyCentroid, pointInPoly, unitNormal } from './geometry';
import { BRIEF_NAME, CAT_BY_KIND, SEATS } from './catalog';
import { descOf, hasPhotos, labelOf, photosOf, shellBBox } from './model';
import { camRoom, shotAddress, type Cam } from './camera';
import { idsInShot } from './pov';

export type ViewKind = 'top' | 'eye' | 'iso' | 'sketch';

/** Structurally the same union as ControlKind in src/server/providers/types.ts,
 *  declared again here because the engine may not import from src/server — this
 *  file runs in the browser. String-literal unions are structurally compatible,
 *  so the two stay assignable in both directions without an import. */
export type ControlKind = 'line' | 'depth' | 'seg' | 'change';

export interface PromptOpts {
  view: ViewKind;
  /** an area id, or '*' for the whole floor */
  room?: string;
  style?: string;
  furniture: boolean;
  dimensions: boolean;
  /** The control maps going out as extra reference images, in the order they are
   *  attached: image 1 is always the plan, then the PHOTOGRAPHS below, and the
   *  maps after them. An unnamed map is worse than no map — the model treats a
   *  depth ramp as a material and paints the grey. Omit this and the brief is
   *  byte-identical to what it was before control maps existed. */
  controls?: ControlKind[];
  /** The object photographs going out as reference images, in attach order —
   *  images 2 … 2+n, ahead of any control map, which is the order
   *  `references()` in src/server/providers/bfl.ts actually fills the slots in.
   *
   *  Each one has to be named, for a stronger version of the reason a map does:
   *  an unannounced photograph of a sofa in a showroom is a picture of a room,
   *  and what comes back is that room. Omit this and the brief is byte-identical
   *  to what it was before photos existed. */
  photos?: PhotoBrief[];
  /** Where the camera stood, on the eye-level view.
   *
   *  Present, image 1 stops being a floor plan and becomes a grey massing render
   *  taken from this exact point — so the brief has to stop describing a drawing
   *  seen from above and start describing a photograph to be taken from where
   *  the model is already standing. That is a different set of sentences, not a
   *  different adjective, which is why this is a field and not a flag. */
  camera?: Cam | null;
}

/** One photograph, as the brief refers to it. */
export interface PhotoBrief {
  /** the item's or area's id, so the OBJECTS table can point its row at the
   *  image number this photograph was given, and so the sentence naming the
   *  photograph can quote the object's number on the picture. Without it the
   *  binding between a row and a picture exists only in the wording. */
  objId: string;
  /** what it is a photograph of, lower case: "sofa" */
  label: string;
  /** the room it belongs to, for disambiguating two sofas */
  room: string;
  /** what this angle shows, when the person said — `PhotoRef.note` */
  note?: string;
}

interface RoomFact { a: Area; name: string; area: number; c: Pt; items: Item[]; fitted: number; where: string }

export interface PlanFacts {
  rooms: RoomFact[];
  loose: Item[];
  doors: number;
  windowSides: [string, number][];
  w: number; h: number;
  /** the building's own bounds, so positions can be phrased against it */
  bbox: BBox;
  /** fitted objects still carrying no name at all — geometry with no meaning */
  anonFitted: number;
  total: number;
  /** Do the drawn room polygons actually account for the building? When they do
   *  not, `total` is a fraction of the real floor and must not be presented as
   *  its area — an unmapped open plan reported 1.9 m² inside a 74 m² footprint. */
  mapped: boolean;
  notes: string[];
}

/** Does this object say anything the brief can use? An object imported from the
 *  listing with no name, no description and no photograph is a rectangle with no
 *  meaning — dozens of them would flood the OBJECTS table, so they are counted
 *  as `anonFitted` and described once instead.
 *
 *  Module scope rather than a closure inside `planFacts`, because `buildPrompt`
 *  has to recount them for the camera's shot and two spellings of "anonymous"
 *  would disagree the day one of them gained a clause. */
const speaks = (i: Item) => !i.fromFunda || !!descOf(i) || !!labelOf(i).trim() || hasPhotos(i);

export function planFacts(f: Floor): PlanFacts {
  /* Orient against the building, not the content bounds — a chair dropped
     outside the walls must not rotate every room's compass point. */
  const b = shellBBox(f) ?? { x0: 0, y0: 0, x1: 100, y1: 100 };

  const rooms: RoomFact[] = f.areas
    .map(a => ({ a, name: (a.name || '').trim(), area: polyArea(a.poly), c: polyCentroid(a.poly) }))
    .filter(r => r.name && r.area > 10000) /* ignore cupboards under 1 m² */
    .sort((x, y) => y.area - x.area)
    .map(r => {
      const w = compass(r.c, b);
      return {
        ...r,
        items: [] as Item[],
        fitted: 0,
        where: w === 'central' ? 'centrally placed' : `on the ${w} side`,
      };
    });

  /* Fitted objects imported from the listing arrive anonymous — the .fml carries
     no names, only geometry — and dozens of unnamed boxes would flood the brief.
     But one the user has named or described is the opposite of noise: a staircase
     left out of the text is how a render grows a corridor that is not there.
     A PHOTOGRAPH counts for the same reason and more strongly: someone went and
     took a picture of that thing. Leaving it out of the table left the brief
     naming a photograph of an object no row mentioned and no badge numbered,
     which is how a kitchen photo came to be described as "object, kitchen" and
     then ignored. */
  const used = new Set<string>();
  rooms.forEach(r => {
    r.items = f.items.filter(i => {
      if (used.has(i.id) || !speaks(i)) return false;
      if (!pointInPoly({ x: i.x, y: i.y }, r.a.poly)) return false;
      used.add(i.id);
      return true;
    });
    r.fitted = f.items.filter(i => i.fromFunda && pointInPoly({ x: i.x, y: i.y }, r.a.poly)).length;
  });

  const windows: string[] = [], doors: string[] = [];
  const mid = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  f.walls.forEach(w => {
    if (!w.openings.length) return;
    /* Which way the wall faces, not where the opening sits along it. Tallying
       the opening's own octant made a run of windows across one elevation come
       back as two diagonals, so a plain rectangle reported all four — which
       says nothing about where the light comes from. */
    const n = unitNormal(w.a, w.b);
    const c = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
    const out = (c.x - mid.x) * n.x + (c.y - mid.y) * n.y < 0 ? -1 : 1;
    const dir = bearing(n.x * out, n.y * out);
    w.openings.forEach(o => (o.type === 'window' ? windows : doors).push(dir));
  });
  const tally = (arr: string[]): [string, number][] => {
    const c: Record<string, number> = {};
    arr.forEach(s => { c[s] = (c[s] || 0) + 1; });
    return Object.entries(c).sort((a, b2) => b2[1] - a[1]);
  };

  const total = f.areas.reduce((s, a) => s + polyArea(a.poly), 0);
  const footprint = Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));

  return {
    rooms,
    /* top-to-bottom, then left-to-right: the order a person reads a plan out loud */
    loose: f.items
      .filter(i => !used.has(i.id) && speaks(i))
      .sort((p, q) => (p.y - q.y) || (p.x - q.x)),
    bbox: b,
    anonFitted: f.items.filter(i => i.fromFunda && !speaks(i)).length,
    doors: doors.length,
    windowSides: tally(windows),
    w: (b.x1 - b.x0) / 100,
    h: (b.y1 - b.y0) / 100,
    total,
    mapped: total >= footprint * 0.55,
    notes: f.notes
      .map(n => String(n.text).replace(/\s+/g, ' ').trim())
      .filter(t => t && !/geen rechten|©|zibber/i.test(t)),
  };
}

/** One row of the brief's OBJECTS table, and one numbered badge on the picture.
 *
 *  The number is the whole point of this type. It is the only binding between a
 *  shape on the conditioning image and a name in the brief that survives being
 *  drawn: the captions that used to carry it are 0.7% of the image height and
 *  unreadable to the model (see `badges` in ./render.ts). So the list is built
 *  once, here, and both halves read it — the painter for the discs, `buildPrompt`
 *  for the `#` column and for the sentences that name each photograph.
 *
 *  Read in the order a person reads a plan out loud: rooms largest first, each
 *  room's objects top-to-bottom then left-to-right, then whatever sits outside
 *  every room. */
export interface BriefObject { item: Item; room: string; n: number }

export function briefObjects(
  f: Floor,
  opts: Pick<PromptOpts, 'room' | 'furniture'>,
  facts?: PlanFacts,
): BriefObject[] {
  if (!opts.furniture) return [];
  const F = facts ?? planFacts(f);
  const only = opts.room && opts.room !== '*' ? F.rooms.find(r => r.a.id === opts.room) : undefined;
  const rooms = only ? [only] : F.rooms;
  const read = (p: Item, q: Item) => (p.y - q.y) || (p.x - q.x);

  const out: BriefObject[] = [];
  rooms.forEach(r => r.items.slice().sort(read)
    .forEach(item => out.push({ item, room: r.name, n: out.length + 1 })));
  /* A room-scoped brief renders that room and nothing else, so nothing outside
     it is numbered — an unexplained number on the picture is worse than none. */
  if (!only) F.loose.forEach(item => out.push({ item, room: '', n: out.length + 1 }));
  return out;
}

/** An object on the plan that carries at least one photograph, and where it is.
 *
 *  Derived here rather than in the render panel so the checkbox list, the attach
 *  order and the sentences in the brief are all the same list in the same order.
 *  Two of those three name image numbers, and a panel that disagrees with the
 *  brief about which image is the sofa is worse than either alone. */
export interface PhotoSubject {
  /** the item's or area's id — what the panel's tick state keys on */
  objId: string;
  /** what it is, lower case: "sofa", "kitchen island" */
  label: string;
  /** the room it sits in, '' for something outside every room */
  room: string;
  /** the photos, in the document's own priority order. The note travels with the
   *  id because the brief says it out loud beside the image number, and the
   *  panel that lists them has no other route to it. */
  photos: { id: string; note?: string }[];
}

/** Every photographed object in scope, in the order the slots should be spent.
 *
 *  Rooms largest first, and inside a room the room's own photographs before its
 *  contents, then its objects by footprint descending — the wall and floor set
 *  the space, and a three-seat sofa is more of the picture than a side table. It
 *  is a starting order, not a ruling: the panel's checkboxes are what actually
 *  decide, and this is what they are listed in.
 *
 *  Deliberately NOT filtered the way `planFacts` filters items. That function
 *  drops fitted objects imported from the listing unless someone named them,
 *  because dozens of anonymous boxes would flood the brief — but attaching a
 *  photograph to one is a far stronger statement of intent than typing a name,
 *  and an object whose photo the panel refused to list would be inexplicable. */
export function photoSubjects(f: Floor, room?: string): PhotoSubject[] {
  const scoped = room && room !== '*';
  const areas = f.areas
    .map(a => ({ a, size: polyArea(a.poly) }))
    .sort((x, y) => y.size - x.size)
    .map(x => x.a);

  const out: PhotoSubject[] = [];
  const used = new Set<string>();
  const bySize = (p: Item, q: Item) => (q.w * q.h) - (p.w * p.h);

  for (const a of areas) {
    const inside = f.items.filter(i => !used.has(i.id) && pointInPoly({ x: i.x, y: i.y }, a.poly));
    inside.forEach(i => used.add(i.id));
    if (scoped && a.id !== room) continue;
    const name = (a.name || '').trim();
    if (photosOf(a).length) {
      out.push({
        objId: a.id,
        label: name.toLowerCase() || 'room',
        room: name,
        photos: photosOf(a).map(p => ({ id: p.id, note: p.note })),
      });
    }
    inside.filter(i => photosOf(i).length).sort(bySize).forEach(i => out.push({
      objId: i.id,
      label: objectName(i),
      room: name,
      photos: photosOf(i).map(p => ({ id: p.id, note: p.note })),
    }));
  }

  /* Outside every room. Only for a whole-floor brief, the same rule the OBJECTS
     table follows: a room-scoped render draws that room and nothing else. */
  if (!scoped) {
    f.items
      .filter(i => !used.has(i.id) && photosOf(i).length)
      .sort(bySize)
      .forEach(i => out.push({
        objId: i.id,
        label: objectName(i),
        room: '',
        photos: photosOf(i).map(p => ({ id: p.id, note: p.note })),
      }));
  }
  return out;
}

/** The camera is the one instruction the model was quietly ignoring: "orthographic-
 *  looking" read as a suggestion and came back as a 3/4 dollhouse shot every time.
 *  `cam` is a hard spec, and it is stated at the top of the brief rather than 25
 *  lines down, where anything still unsaid has already been decided.
 *
 *  Every one of these is now half the length it was. BFL's guide puts the useful
 *  window at 30-80 words and says attention falls off with word order, so a
 *  120-word camera paragraph was spending the model's attention on its own tail:
 *  the clauses that mattered ("zero perspective") sat behind clauses that only
 *  restated them ("no vanishing point, no angled 3D shot"). `headWords()` below
 *  pins the whole opening block to that budget.
 *
 *  `out` is what the image is made of rather than where it is seen from — kept
 *  beside the camera because both are technical output settings, and both are
 *  outranked on purpose by the STYLE block at the very bottom. */
export const AI_VIEWS: Record<ViewKind, { lead: string; cam: string; out: string }> = {
  top: {
    lead: "Photorealistic top-down (bird's-eye) visualisation of the floor plan below, ceiling removed.",
    cam: 'Strict orthographic top-down projection, perpendicular to the floor: zero perspective,'
      + ' no tilt, no visible inner wall faces. Walls cut at worktop height, the plan filling the frame.',
    out: 'Realistic materials and shadows, no people. No text, numbers or dimension lines.',
  },
  eye: {
    lead: 'Photorealistic wide-angle interior photograph of the space described below.',
    cam: 'Camera at standing eye level, wide-angle lens, in the {ROOM} looking towards the windows.',
    out: 'Natural daylight, realistic materials and shadows, no people. No text, numbers or'
      + ' dimension lines.',
  },
  iso: {
    lead: 'A 3D isometric cutaway "dollhouse" view of the floor plan below, ceiling removed.',
    cam: 'Isometric camera at roughly 45°, one angle across the whole floor, no perspective'
      + ' convergence. Walls cut at worktop height, soft studio light, clean architectural-model look.',
    out: 'Realistic materials and shadows, no people. No text, numbers or dimension lines.',
  },
  sketch: {
    lead: 'A hand-drawn watercolour and ink illustration of the floor plan below, seen from above.',
    cam: "Directly overhead, square to the page. Loose confident linework, washes of colour,"
      + " white paper margin, an architect's presentation sketch.",
    out: 'No photographic realism. No text, numbers or dimension lines.',
  },
};

/** Style labels people actually type, expanded into the concrete materials,
 *  colours and light the word is supposed to mean. A bare "Scandinavian" is one
 *  token competing with a hundred others; the expansion is something the model
 *  can act on. The typed words are never replaced — they are stated first and
 *  said to win, because they are the part a person chose. */
export interface StylePreset { label: string; alt?: string[]; tokens: string }

export const STYLE_PRESETS: StylePreset[] = [
  { label: 'Scandinavian', alt: ['scandi', 'nordic'],
    tokens: 'pale oak or ash floors, white and off-white walls, light birch furniture, wool and linen textiles, matte black or brushed steel fittings, cool even daylight' },
  { label: 'Japandi', alt: ['japandi', 'wabi'],
    tokens: 'pale timber and paper-white plaster, low unfussy furniture, black-stained wood, ceramics and raw linen, muted greige and clay tones, soft diffused light' },
  { label: 'Mid-century modern', alt: ['mid-century', 'midcentury', 'mid century'],
    tokens: 'warm walnut and teak, tapered legs, mustard, olive and burnt-orange upholstery, terrazzo or cork flooring, brass fittings, globe pendant lights' },
  { label: 'Industrial', alt: ['loft'],
    tokens: 'exposed brick and raw concrete, blackened steel frames, reclaimed timber, dark metal fittings, factory pendant lamps, large-format grey floor' },
  { label: 'Minimalist', alt: ['minimal'],
    tokens: 'seamless white and pale grey surfaces, micro-cement floors, handleless flush joinery, almost no ornament, hidden lighting, one or two restrained accent tones' },
  { label: 'Modern farmhouse', alt: ['farmhouse', 'landelijk'],
    tokens: 'wide plank oak floors, painted panelling, cream and sage tones, natural stone worktops, aged brass, woven baskets and linen, warm afternoon light' },
  { label: 'Coastal', alt: ['beach house', 'kust'],
    tokens: 'whitewashed timber, pale sand and soft blue tones, rattan and rope textures, sheer curtains, chalky matte paint, bright airy daylight' },
  { label: 'Art deco', alt: ['deco'],
    tokens: 'deep emerald and navy, velvet upholstery, fluted panelling, polished brass and gold, marble with strong veining, geometric inlay floors, warm lamplight' },
  { label: 'Bohemian', alt: ['boho', 'eclectic'],
    tokens: 'layered patterned rugs, terracotta and ochre, rattan and cane, plants throughout, mixed timbers, macramé and textured throws, warm low light' },
  { label: 'Classic Dutch', alt: ['jaren 30', 'dutch classic', 'herenhuis'],
    tokens: 'herringbone parquet, panelled doors with high skirting, deep window reveals, muted heritage greens and greys, brass ironmongery, an ensuite of period mouldings' },
];

/** The first preset the typed style actually names, or null for free text.
 *  Bounded on both sides so "decorative" cannot match "deco". */
export function expandStyle(text: string): StylePreset | null {
  const s = ` ${text.toLowerCase().replace(/[^a-z0-9°]+/g, ' ')} `;
  const has = (w: string) => s.includes(` ${w.toLowerCase().replace(/[^a-z0-9°]+/g, ' ')} `);
  return STYLE_PRESETS.find(p => has(p.label) || (p.alt ?? []).some(has)) ?? null;
}

/** Close the user's free text off, so it cannot run into the generated prose
 *  that follows it on the same line. */
function sentence(s: string): string {
  return /[.!?;:]$/.test(s) ? s : `${s}.`;
}

/** One cell of one of the tables below. Descriptions are free text and routinely
 *  carry newlines and the odd pipe; either one turns a row into nonsense. */
function cell(s: string): string {
  const flat = s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  return flat || '—';
}

/** What each attached map is, one clause each. Saying nothing is not neutral: an
 *  unannounced depth ramp gets rendered as a grey gradient painted on the floor,
 *  and a segmentation map as flat blocks of colour. The sentences are short on
 *  purpose — they sit in the opening block, where word order still costs. */
const CONTROL_LINES: Record<ControlKind, string> = {
  line: 'a line drawing of this plan: every wall, opening and object edge',
  depth: 'a depth map: brighter is higher above the floor, not a colour',
  seg: 'a segmentation map: one flat colour per room and object, not a material',
  change: 'a change mask: white may be re-rendered, black must come through unchanged',
};

/** The two whose sentence stops being true from inside the room.
 *
 *  Depth is the one that matters and it is not a nuance: from above, brighter is
 *  higher off the floor; from a camera standing in the room, brighter is nearer
 *  the lens. Those are different pictures and the wrong caption is worse than no
 *  caption at all — the note on `MAX_REFERENCE_MAPS` in `state/renders.ts` says
 *  what an unannounced ramp comes back as, and a misannounced one is that plus
 *  an instruction to build the room inside out. `line` is the same drawing
 *  either way; only the word "plan" is wrong, and a brief that calls a
 *  photograph a plan is inviting the dollhouse back. */
const CONTROL_LINES_POV: Partial<Record<ControlKind, string>> = {
  line: 'a line drawing of this same view: every wall, opening and object edge',
  depth: 'a depth map of this same view: brighter is nearer the camera, not a colour',
};

/** The words before the LOCKED tables — the ones BFL's guide says are read with
 *  the most attention, and the budget the tests hold us to: 78 words for a plain
 *  top-down brief, against 157 before. The tables below are data and are allowed
 *  to be long; this is not. Each opt-in extra (captions, a control map) buys
 *  itself one more sentence up here and the tests cap what one may cost, so the
 *  ceiling is per feature rather than a single number that quietly slips. */
export function headWords(prompt: string): number {
  const cut = prompt.indexOf('\nLOCKED');
  return (cut < 0 ? prompt : prompt.slice(0, cut)).split(/\s+/).filter(Boolean).length;
}

/** Where a thing sits, phrased against the attached top-down drawing rather than
 *  in metres — "top-left" lands on the image, "x = 240 cm" does not. Objects
 *  pressed up against an elevation say so, because that is what stops a model
 *  floating a fireplace into the middle of the floor.
 *
 *  No longer used by buildPrompt: position through prose measures 0.41 quadrant
 *  F1 (arXiv:2507.08039) against the same fact drawn in pixels, so the OBJECTS
 *  table stopped carrying it. Still exported, and still the right function for
 *  anything that has to phrase a position in words — the eval harness reports
 *  where an object landed, and that report is read by a person. */
export function placeOf(i: Item, b: BBox): string {
  const w = Math.max(1, b.x1 - b.x0), h = Math.max(1, b.y1 - b.y0);
  const fx = (i.x - b.x0) / w, fy = (i.y - b.y0) / h;
  const band = (t: number, lo: string, mid: string, hi: string) => (t < 1 / 3 ? lo : t > 2 / 3 ? hi : mid);
  const vert = band(fy, 'upper', 'middle', 'lower');

  /* against a wall: measured in centimetres, since a fraction of a 12 m plan is
     a metre and a half and would call half the floor "against the wall" */
  const reach = 90;
  if (i.x - b.x0 < reach) return `against the left wall, ${vert}`;
  if (b.x1 - i.x < reach) return `against the right wall, ${vert}`;
  const horiz = band(fx, 'left', 'centre', 'right');
  if (i.y - b.y0 < reach) return `against the top wall, ${horiz}`;
  if (b.y1 - i.y < reach) return `against the bottom wall, ${horiz}`;

  const row = band(fy, 'top', 'middle', 'bottom');
  const col = band(fx, 'left', 'centre', 'right');
  return row === 'middle' && col === 'centre' ? 'the middle of the floor' : `${row}-${col}`;
}

/** How the brief points at one object, in words, without any annotation on the
 *  picture to lean on: where it sits inside its own room.
 *
 *  Scoped to the room rather than the floor because that is the disambiguation
 *  that has to work. Two rooms both have something against their left wall; what
 *  the model has to resolve is which of the four blocks in THIS room is the
 *  vitrine, and "against the left wall, upper" separates them. Against the whole
 *  floor's bbox, every object in a small room would answer the same way.
 *
 *  Falls back to the floor for anything outside every room — a staircase in the
 *  circulation, a meter cupboard — which is exactly where a floor-wide bearing is
 *  the honest answer. */
export function objectAddress(o: BriefObject, F: PlanFacts): string {
  const room = o.room ? F.rooms.find(r => r.name === o.room) : undefined;
  return placeOf(o.item, room ? bboxOf(room.a.poly) : F.bbox);
}

/** A staircase read as anonymous geometry is how a plan grows a corridor. */
const STAIRS = /stair|trap\b/i;

export function buildPrompt(f: Floor, opts: PromptOpts): string {
  const F = planFacts(f);
  const V = AI_VIEWS[opts.view] ?? AI_VIEWS.top;
  /* The camera, on the one view that has one. Everything below reads
     `povCam` rather than `opts.camera` so that an eye-level brief with no camera
     placed keeps producing exactly the words it produced before this existed —
     which is also the picture it gets, since `referenceOpts` falls back to the
     plan drawing in the same case. */
  const povCam = opts.view === 'eye' && opts.camera ? opts.camera : null;
  const standing = povCam ? camRoom(f, povCam) : null;

  const only = opts.room && opts.room !== '*' ? F.rooms.find(r => r.a.id === opts.room) : undefined;

  /* Everything the camera can see, or null when there is no camera.
   *
   *  This is the difference between a brief for a floor plan and a brief for a
   *  photograph, and it is not a refinement — it is the whole of what "adjust
   *  the prompt to the camera" means. The tables below are read as the authority
   *  on what is in the room: the LOCKED heading says "do not invent or omit",
   *  and OBJECTS says "each one is already drawn on the plan; keep it exactly
   *  where it is". Handed the whole floor's furniture, a model pointed at a
   *  kitchen dutifully renders the dining table, the fireplace and the staircase
   *  from three rooms away as well — measured, on the first eye-level render
   *  that came back. It was obeying us.
   *
   *  So with a camera, the tables describe the shot. Objects out of frame or
   *  behind a wall are not mentioned; rooms the camera cannot see are not
   *  mentioned; and the compass, which is a fact about a drawing seen from
   *  above, gives way to where things sit in the picture. */
  const shot = povCam ? idsInShot(f, povCam) : null;
  const rooms = (only ? [only] : F.rooms).filter(r => !shot || shot.has(r.a.id));
  /* Every object the brief will list. Computed here rather than inside the
     OBJECTS block because the photograph sentences up in REFERENCE have to
     address the same objects the table does, and in the same words: a photograph
     that names something the table never mentions is worse than one that names
     nothing. */
  const listed = briefObjects(f, opts, F).filter(o => !shot || shot.has(o.item.id));
  /* How to point at one drawn block using nothing but words. This is the whole
     replacement for the annotation that used to be printed on the picture, and
     it is worth being clear about why words won. A caption is unreadable to the
     model at plan scale; a disc big enough to read gets painted into the render
     as a black roundel. There is no third option on the image. In the text there
     is no bleed at all — the worst a wrong phrase can do is describe the wrong
     sofa, and the drawing still says where the sofa is.
     From a camera the address is the camera's: see `shotAddress`. */
  const addressOf = new Map(listed.map(o => [
    o.item.id,
    povCam ? shotAddress(povCam, { x: o.item.x, y: o.item.y }) : objectAddress(o, F),
  ]));
  const dim = opts.dimensions;
  /* Image 1 is the plan, always. Everything else counts up from 2 — declared
     once here so the photograph lines, the map lines and the OBJECTS column
     cannot each have their own opinion about where the numbering starts. */
  const photoFrom = 2;
  const L: string[] = [];

  /* Camera first, and the reference image second — the two instructions the whole
     product rests on used to be the last two lines of the brief, read after every
     room had already been placed. Fidelity fell off with distance from the top,
     so what must not be reinterpreted is now what is read first. */
  L.push(V.lead, '');
  L.push('CAMERA AND OUTPUT');
  /* A placed camera replaces the view's own sentence rather than decorating it.
     "Looking towards the windows" is a guess about the shot; image 1 IS the shot,
     taken from the point the person chose, and the only thing left to say is that
     the lens does not move. Saying both would give the model two cameras and let
     it pick — and the words are the half it is documented to weigh more highly
     late in a brief, which is the wrong half here. */
  L.push(povCam
    ? `Shot from exactly where image 1 was shot${standing ? `, in the ${standing.name.toLowerCase()}` : ''}.`
      + ' Same viewpoint, same direction, same lens.'
    : V.cam.replace('{ROOM}', rooms[0]?.name || 'main room'));
  L.push(V.out, '');

  L.push('REFERENCE');
  /* BFL's own published phrasing for holding a layout, verbatim, and then one
     clause per map. FLUX.2 takes no control map and no strength dial, so on that
     provider these are still semantic references — the sentence is what makes
     them mean anything at all; on a provider that does take them it agrees with
     the control channel instead of arguing with it. It replaces our own "match
     it exactly", which says the same thing in words nobody published. */
  const maps = (opts.controls ?? []).filter(k => k in CONTROL_LINES);
  const photos = opts.photos ?? [];
  /* What image 1 is has to be said outright once the camera is placed, because
     it is no longer a floor plan. It is a grey model of this room seen from the
     lens — right geometry, no materials — and a model told only to "keep the
     spatial arrangement" of it reproduces the grey as a colour scheme. Naming
     what the greys are FOR is the whole instruction: geometry from the picture,
     everything else from the words below.

     Twenty-six words, and both halves of what it does not say are deliberate.
     It does not enumerate "every wall, window, doorway and object in the same
     place and size", because that is prose restating what the pixels already
     carry, through the channel arXiv:2507.08039 measures at 0.41 quadrant F1 —
     the same argument that took `placeOf` out of the OBJECTS table. And the
     camera line above no longer ends "do not move, tilt or widen the camera",
     because BFL's own guide says to describe what you want rather than what you
     do not; two positive sentences beat two positive sentences and a negative
     one, and the pair came to 116 words against the 80 the window allows. */
  if (povCam) {
    L.push('Image 1 is a grey untextured 3D model of this room, from that camera.'
      + ' Copy its geometry exactly and give every grey surface a real material.');
  } else if (maps.length || photos.length) {
    L.push('Keep the exact spatial arrangement from image 1 — same composition, same positioning of elements.');
  }
  /* The walls rule is on every branch. It used to be a closing line that ran
     unconditionally, and front-loading the brief lost it for a room-scoped one —
     the brief most likely to grow a wall, since the model can see three rooms it
     has just been told not to draw. "Exactly as drawn" was carrying it
     implicitly, and implicit is what the camera line taught us not to trust; the
     room sentence is three words shorter to pay for the seven. */
  L.push(povCam
    /* The room sentence and the match-exactly sentence are both already above,
       said better and about the right kind of picture. What is left is the rule
       every branch carries. */
    ? 'Do not add, remove or rearrange walls.'
    : only
      ? `Render only the ${only.name} from image 1, exactly as drawn.`
        + ' Do not add, remove or rearrange walls.'
      : maps.length
        ? 'Do not add, remove or rearrange walls.'
        : 'Match image 1 exactly: same shapes, same proportions, same positions.'
          + ' Do not add, remove or rearrange walls.');
  /* Numbered from the array, not deduplicated: the numbers have to match what the
     provider actually attached, so a caller that sends the same kind twice gets
     two lines rather than a brief whose Image 3 is the provider's Image 2.
     All four maps at once puts this block at 160 words, well past the documented
     80 — and there is no honest way to fix that here, because dropping a map's
     sentence is what gets a depth ramp painted onto the floor. How many maps are
     worth attaching is the provider's decision (`acceptsControls`), so the cap
     belongs where that choice is made, not in the sentence that describes it. */
  /* The photographs, before the maps, because that is the order the slots are
     filled in — see `references()` in src/server/providers/bfl.ts. A brief that
     numbers them the other way round describes a request that was never sent.
     One shared sentence for the whole set and one short line each: the shared
     one is where the actual instruction lives, and it is the clause people get
     wrong. "Not scenes to copy" is what stops the shop's showroom coming back
     around the sofa; "ignore the background" is what stops the wall behind it
     becoming this room's wall. */
  if (photos.length) {
    const span = photos.length === 1
      ? `Image ${photoFrom}`
      : `Images ${photoFrom}-${photoFrom + photos.length - 1}`;
    /* What a photograph can actually carry depends on the camera, and the brief
       used to promise the same thing either way. From above, the form of a
       kitchen or a sideboard is invisible — the only transferable facts are its
       colour, material and finish, and asking for the object "exactly" spends
       the model's attention on something the view cannot show. At eye level the
       form IS visible and is the whole point. So the sentence changes with the
       camera. This is why the photograph of a white shaker kitchen came back as
       dark marble under a top-down brief: nothing told the model which half of
       that picture it was supposed to use. */
    const overhead = opts.view === 'top' || opts.view === 'iso';
    L.push(`${span} ${photos.length === 1 ? 'photographs an object' : 'photograph objects'} already on`
      + ' the plan, in the one place named below and nowhere else: never a second copy. '
      + (overhead
        ? "Seen from above, give each object below its photograph's colour, material and finish."
        : 'Reproduce each pictured object exactly — same design, colour, material.')
      + ' Ignore their backgrounds and lighting.');
    /* Comma-separated and article-free — "Image 4: sofa, living room." A key
       rather than prose, which is what it is, and four words shorter per line
       than the sentence it replaced: with seven photographs attached that is the
       difference between an opening block of 190 words and one of 211, at the
       end where nothing is read anyway. */
    photos.forEach((p, n) => {
      /* Name, room, then where it sits — the same three facts, in the same order,
         as that object's row in the OBJECTS table below. They have to be the same
         words: this sentence and that row are two descriptions of one block on
         the picture, and a model reconciling them is a model deciding they might
         be two blocks. */
      const where = p.room ? `, ${p.room.toLowerCase()}` : '';
      const at = addressOf.get(p.objId);
      const note = p.note ? ` (${cell(p.note)})` : '';
      L.push(`Image ${photoFrom + n}: ${p.label}${where}${at ? `, ${at}` : ''}${note}.`);
    });
  }
  maps.forEach((k, n) => L.push(`Image ${photoFrom + photos.length + n} is`
    + ` ${(povCam && CONTROL_LINES_POV[k]) || CONTROL_LINES[k]}. Do not render it.`));
  /* Nothing here about lettering any more, and the silence is the point. The
     brief used to carry a sentence asking the model not to draw the captions we
     had printed on the reference — a negative instruction, which is the one
     thing BFL's guide says FLUX.2 is bad at, spent undoing something we did on
     purpose. The picture is clean now, so the only mention of text left in this
     brief is the positive one in CAMERA AND OUTPUT, and a brief that does not
     talk about writing is a brief less likely to produce any. */
  /* North is a fact about a drawing seen from above, and there is no such
     direction in a photograph taken from inside the room. Left in for every other
     view, where the tables below lean on it — see the note under ROOMS. */
  if (!povCam) L.push('North is at the top.');
  L.push('');

  /* One heading over everything the drawing already decided, so the model has a
     line to draw between what it may reinterpret and what it may not. The Notes
     columns are the one part of this brief a person actually wrote — said here
     once, rather than as a paragraph of meta-commentary further down. */
  L.push('LOCKED — reproduce exactly. Room shapes, sizes, positions and openings are'
    + ' fixed, and every Notes cell below is an instruction from the person who drew'
    + ' the plan, not a suggestion. Do not invent or omit rooms or objects.');
  /* The floor's own areas, and NOT its overall footprint. "6.2 × 11.2 m" is
     shaped exactly like a dimension chain, and the render came back with one
     drawn across all four sides of the picture — 1.2 and 6.2 lifted out of this
     line and the camera line above it and lettered in as measurements, which
     were wrong as measurements too. An area in m² is a quantity; a width × depth
     is an instruction to draw a dimension. Room sizes stay: they are per-room and
     the person asked for them. */
  L.push(povCam
    /* A floor total is a fact about the plan, and this is one photograph of part
       of it — quoting 78 m² over five rooms invites the other four into the
       frame. The second sentence is the counterweight to the LOCKED heading
       above, which on its own reads as "the floor has exactly these rooms". */
    ? `${standing ? `The ${standing.name.toLowerCase()}` : 'The space'}, on the ${f.name.toLowerCase()}`
      + `${dim && standing ? ` — ${(polyArea(standing.poly) / 10000).toFixed(1)} m²` : ''}.`
      + ' Everything listed below is what this one photograph shows, not the whole floor.'
    : only
      ? `The ${only.name}${dim ? ` — ${(only.area / 10000).toFixed(1)} m²` : ''}, on the ${f.name.toLowerCase()}.`
      : `"${f.name}"${dim && F.mapped
        ? ` — ${(F.total / 10000).toFixed(1)} m² over ${F.rooms.length} named room${F.rooms.length === 1 ? '' : 's'}`
        : ''}.`);
  L.push('');

  /* Columns, not sentences: the same fifteen facts in a fixed order, with no
     connective prose for the model to weigh differently one row to the next. */
  /* The compass column goes with the camera, for the same reason "North is at the
     top" did: it is corroborated by nothing a person standing in the room can
     see, and a room told it is "west" in a photograph with no west in it is a
     room being given a fact it can only misuse. */
  const roomWhere = !only && !povCam;
  if (rooms.length) L.push(only ? 'THE ROOM' : 'ROOMS');
  const roomCols = ['Room', ...(dim ? ['Size'] : []), ...(roomWhere ? ['Where'] : []), 'Notes'];
  if (rooms.length) L.push(roomCols.join(' | '));
  rooms.forEach(r => {
    const notes = [descOf(r.a)];
    if (opts.furniture && !r.items.length) {
      /* "Furnish it plausibly" is right for an empty bedroom and wrong for a
         3.6 m² hall, which is what a render proved: it came back with a café
         table and two chairs in the entrance, and that was our instruction, not
         the model inventing. Below the threshold a room with nothing drawn in it
         is a hall, a porch or a cupboard — circulation, not a space to fill. */
      const roomy = r.area >= 80_000;                 // 8 m²
      notes.push(r.fitted
        ? 'fitted units already in place as drawn, no loose furniture'
        : roomy
          ? 'empty — furnish it plausibly for its purpose'
          : 'empty — keep the floor clear, no furniture');
    }
    L.push([
      cell(r.name),
      ...(dim ? [`${(r.area / 10000).toFixed(1)} m²`] : []),
      /* "west", not "on the west side" — a column is not a sentence.
         A room keeps its compass side while the OBJECTS table dropped its
         Position column outright, and that asymmetry is deliberate but unmeasured:
         a room is corroborated twice over — by "North is at the top" and by which
         side the windows are on — where an object's quadrant is stated nowhere
         else, which is the case arXiv:2507.08039 measures at 0.41 F1. If a sweep
         shows rooms landing on the wrong side anyway, this column is the next
         thing to cut, and it is one line. */
      ...(roomWhere ? [cell(r.where.replace(/^on the /, '').replace(/ side$/, ''))] : []),
      cell(notes.filter(Boolean).join('; ')),
    ].join(' | '));
  });
  L.push('');

  if (opts.furniture) {
    /* The Where column is back, and it is doing a different job from the one it
       was cut for. As an INSTRUCTION prose position is weak — 0.41 quadrant F1
       (arXiv:2507.08039) against the same fact sitting pixel-exact on the
       reference — and two channels arguing about where a sofa goes is worse than
       one. As IDENTIFICATION it is the only channel left: the drawing says where
       every block is and refuses to say which is which, and the annotation that
       used to bridge that either could not be read or got painted into the
       render. "Against the left wall, upper" does not place the sofa; it picks
       out which of these four rectangles the row is talking about. Sizes stay
       behind `dimensions`, because that toggle is a person asking for
       measurements; nothing emits a size they did not ask for. */
    /* Which row has a photograph, and which image it is. Said twice on purpose:
       the REFERENCE block names the object in prose and this puts the number on
       the row itself, because the table is what the model reads as the authority
       on what is in the room. Two words a row, and only when photos went. */
    const shot = new Map<string, string[]>();
    photos.forEach((p, n) => {
      const at = shot.get(p.objId) ?? [];
      at.push(`image ${photoFrom + n}`);
      shot.set(p.objId, at);
    });
    const pics = shot.size > 0;

    const rows = listed.map(o => objRow(
      o, addressOf.get(o.item.id) ?? '', dim, !!only,
      pics ? shot.get(o.item.id) ?? [] : undefined,
    ));

    if (rows.length) {
      L.push('OBJECTS — each one is already drawn on the plan;'
        + ' keep it exactly where it is');
      L.push([...(only ? [] : ['Room']), 'Object', 'Where', ...(dim ? ['Size'] : []),
        ...(pics ? ['Photo'] : []), 'Notes'].join(' | '));
      rows.forEach(r => L.push(r.join(' | ')));
      L.push('');
    }
  }

  /* Said once, wherever the stair happens to be listed — inside a named room or
     out on the floor. An unexplained stair-shaped block is what a render turns
     into a corridor that does not exist. */
  const items = listed.map(o => o.item);
  if (opts.furniture && items.some(i => STAIRS.test(labelOf(i)))) {
    L.push('The staircase goes up to the floor above: draw it as an enclosed run of'
      + ' steps, not as furniture and not as a corridor.', '');
  }
  /* The chairs are on the plan, drawn and counted, and the model was reading
     them as decoration: a six-seater came back with eight seats because the
     reference had eight blobs round it and nothing in the text said the blobs
     were furniture with a number. Say both — what they are, and that the count
     is the drawing's, not the model's to round up. */
  const seated = items.filter(i => SEATS[i.kind]);
  if (opts.furniture && seated.length) {
    const total = seated.reduce((n, i) => n + SEATS[i.kind], 0);
    L.push(`The small squares around every table are chairs — ${total} across`
      + ` ${seated.length} table${seated.length === 1 ? '' : 's'}. Copy the number and the sides`
      + ' drawn at each table; a side with no chair drawn on it gets none.', '');
  }
  /* Outside the block above on purpose: a floor can consist of nothing but
     anonymous fitted blocks, and that is precisely when this needs saying. */
  /* Scoped to the shot with the rest of it: "fifteen unnamed fitted blocks are
     drawn on the plan" is an instruction to find room for fifteen of them, and
     from a camera in the hall none of them is in the picture at all. */
  const anonFitted = shot
    ? f.items.filter(i => i.fromFunda && !speaks(i) && shot.has(i.id)).length
    : F.anonFitted;
  if (!only && opts.furniture && anonFitted) {
    L.push(`${anonFitted} unnamed fitted block${anonFitted === 1 ? ' is' : 's are'}`
      + `${shot ? ' in this shot' : ' drawn on the plan'}`
      + ' — kitchen units, sanitary ware, built-in joinery. Render them as built-in cabinetry'
      + ' against the wall they touch, never open floor, a passage or a corridor.', '');
  }

  if (povCam) {
    /* Compass elevations are unusable from inside the room and the floor's total
       doorway count is about rooms this shot does not contain. What is left is
       the fact that matters to a photograph — how much daylight, and from where
       in the frame — plus the rule the block existed for. */
    L.push('OPENINGS AND LIGHT');
    const glazed = f.walls.flatMap(w => w.openings)
      .filter(op => op.type === 'window' && shot!.has(op.id));
    L.push(glazed.length
      ? `${glazed.length === 1 ? 'One window is' : `${glazed.length} windows are`} in shot`
        + ` — the daylight comes from ${glazed.length === 1 ? 'it' : 'them'}.`
      : 'No window is in shot — the daylight comes from off camera. Light the space'
        + ' softly and evenly, with no visible window.');
    L.push('Do not add windows or doors that are not in the picture.', '');
  } else if (!only) {
    L.push('OPENINGS AND LIGHT');
    if (F.windowSides.length >= 5) {
      /* A list of six or seven compass points is the same as saying nothing —
         state the fact instead of enumerating it. */
      L.push('Glazing on nearly every elevation — even daylight from all around.');
    } else if (F.windowSides.length) {
      const many = F.windowSides.some(([, n]) => n > 1);
      const sides = F.windowSides.map(([s, n]) => (many ? `${s} (${n})` : s));
      const list = sides.length > 1 ? `${sides.slice(0, -1).join(', ')} and ${sides[sides.length - 1]}` : sides[0];
      L.push(`Windows on the ${list} side${sides.length > 1 ? 's' : ''} — daylight comes from ${sides.length > 1 ? 'those directions' : 'that direction'}.`);
    } else {
      L.push('No windows are marked; light the space naturally and evenly.');
    }
    L.push(`${F.doors} doorway${F.doors === 1 ? ' connects' : 's connect'} the rooms. Do not add windows or doors that are not listed.`, '');
  }

  if (F.notes.length) {
    L.push('NOTES FROM THE PLAN');
    F.notes.slice(0, 8).forEach(n => L.push(`- ${n}`));
    L.push('');
  }

  /* Last, and the only block that is allowed to move: everything above it is the
     drawing, and a brief that ends on the geometry ends on the part the model
     must not touch. It sits after CAMERA AND OUTPUT deliberately — the two
     disagree about light and material whenever anyone types a style, and this is
     the one that should win. */
  if (opts.style?.trim()) {
    const typed = opts.style.trim();
    L.push('STYLE — vary freely within these bounds: materials, colour, finish, fittings and light');
    L.push(sentence(typed));
    const preset = expandStyle(typed);
    if (preset) {
      L.push(`${preset.label} here means: ${preset.tokens}.`);
      L.push('Where the words above disagree with that expansion, the words above win.');
    }
    L.push('Apply it consistently across the whole floor, to the fitted units and the flooring'
      + ' as much as the loose furniture. It overrides the daylight and material wording at the'
      + ' top of this brief. It changes how the space looks, never what is in it or where: the'
      + ' LOCKED block still wins.');
    L.push('');
  }

  return L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** One row of the OBJECTS table, in the column order the header promises.
 *
 *  `pics` is the image numbers this object was photographed in, when any object
 *  in the brief was — the column exists for the whole table or not at all, so an
 *  object without a photograph still gets the cell, holding a dash. */
function objRow(
  o: BriefObject, where: string, dim: boolean, only: boolean, pics?: string[],
): string[] {
  const i = o.item;
  return [
    ...(only ? [] : [cell(o.room)]),
    cell(objectName(i)),
    cell(where),
    ...(dim ? [`${Math.round(i.w)}×${Math.round(i.h)} cm`] : []),
    ...(pics === undefined ? [] : [cell(pics.join(', '))]),
    cell(descOf(i)),
  ];
}

/** What to call an object that nobody named.
 *
 *  Never the bare word "object", which is what this used to answer. A plan
 *  imported from a listing arrives with dozens of unnamed fitted blocks, and a
 *  person who attaches a photograph of their kitchen to one of them has said
 *  something far stronger than a name — but the brief then read "Image 4: object,
 *  kitchen", and the model ignored the photograph, which is the only reasonable
 *  thing to do with a sentence like that. The fallback says what the geometry
 *  actually knows: it is a fitted unit, and the numbered badge on the picture
 *  says which one. */
export function objectName(i: Item): string {
  const c = CAT_BY_KIND[i.kind];
  const label = String(i.label ?? '').trim();
  /* `makeItem` writes the catalogue's own name onto every placed object, so a
     label is only a person's words when it differs from it. Untouched, the brief
     gets the prose name instead: "Round 4p" is a fine tray label and a useless
     instruction — see BRIEF_NAME. */
  const own = label && (!c || label.toLowerCase() !== c.name.toLowerCase());
  if (own) return label.toLowerCase();

  /* Falls back past `noLabel`, deliberately. That flag means "draw no caption
     under this object", which was a decision about the picture — and the picture
     carries numbers now, not captions. Withholding the name from the TEXT as
     well would leave the model with a numbered shape and nothing to call it. */
  const prose = c ? BRIEF_NAME[i.kind] ?? c.name : i.shape?.name;
  if (prose) return prose.toLowerCase();
  return i.fromFunda ? 'fitted unit' : 'unnamed object';
}

export const CATALOG_NAME = (kind: string) => CAT_BY_KIND[kind]?.name ?? kind;
