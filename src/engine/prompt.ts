import type { Area, BBox, Floor, Item, Pt } from './types';
import { bearing, compass, polyArea, polyCentroid, pointInPoly, unitNormal } from './geometry';
import { CAT_BY_KIND, SEATS } from './catalog';
import { descOf, labelOf, shellBBox } from './model';

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
  /** Are the object names baked into the reference image? It is an image
   *  setting, not a prompt one — but the brief makes a claim about the picture
   *  it is attached to, and that claim has to be true either way. */
  imgLabels?: boolean;
  /** The control maps going out as extra reference images, in the order they are
   *  attached: image 1 is always the plan, image 2 is controls[0], and so on. An
   *  unnamed map is worse than no map — the model treats a depth ramp as a
   *  material and paints the grey. Omit this and the brief is byte-identical to
   *  what it was before control maps existed. */
  controls?: ControlKind[];
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
     left out of the text is how a render grows a corridor that is not there. */
  const speaks = (i: Item) => !i.fromFunda || !!descOf(i) || !!labelOf(i).trim();

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
      + ' no tilt, no visible inner wall faces. Walls cut at 1.2 m, the plan filling the frame.',
    out: 'Realistic materials and shadows, no people, no text or labels anywhere in the render.',
  },
  eye: {
    lead: 'Photorealistic wide-angle interior photograph of the space described below.',
    cam: 'Camera at eye level (1.6 m), 24 mm lens, standing in the {ROOM} looking towards the windows.',
    out: 'Natural daylight, realistic materials and shadows, no people, no text or labels anywhere in the render.',
  },
  iso: {
    lead: 'A 3D isometric cutaway "dollhouse" view of the floor plan below, ceiling removed.',
    cam: 'Isometric camera at roughly 45°, one angle across the whole floor, no perspective'
      + ' convergence. Walls cut at 1.2 m, soft studio light, clean architectural-model look.',
    out: 'Realistic materials and shadows, no people, no text or labels anywhere in the render.',
  },
  sketch: {
    lead: 'A hand-drawn watercolour and ink illustration of the floor plan below, seen from above.',
    cam: "Directly overhead, square to the page. Loose confident linework, washes of colour,"
      + " white paper margin, an architect's presentation sketch.",
    out: 'No photographic realism, no text or labels in the render.',
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

/** A staircase read as anonymous geometry is how a plan grows a corridor. */
const STAIRS = /stair|trap\b/i;

export function buildPrompt(f: Floor, opts: PromptOpts): string {
  const F = planFacts(f);
  const V = AI_VIEWS[opts.view] ?? AI_VIEWS.top;
  const only = opts.room && opts.room !== '*' ? F.rooms.find(r => r.a.id === opts.room) : undefined;
  const rooms = only ? [only] : F.rooms;
  const dim = opts.dimensions;
  const L: string[] = [];

  /* Camera first, and the reference image second — the two instructions the whole
     product rests on used to be the last two lines of the brief, read after every
     room had already been placed. Fidelity fell off with distance from the top,
     so what must not be reinterpreted is now what is read first. */
  L.push(V.lead, '');
  L.push('CAMERA AND OUTPUT');
  L.push(V.cam.replace('{ROOM}', rooms[0]?.name || 'main room'));
  L.push(V.out, '');

  L.push('REFERENCE');
  /* BFL's own published phrasing for holding a layout, verbatim, and then one
     clause per map. FLUX.2 takes no control map and no strength dial, so on that
     provider these are still semantic references — the sentence is what makes
     them mean anything at all; on a provider that does take them it agrees with
     the control channel instead of arguing with it. It replaces our own "match
     it exactly", which says the same thing in words nobody published. */
  const maps = (opts.controls ?? []).filter(k => k in CONTROL_LINES);
  if (maps.length) {
    L.push('Keep the exact spatial arrangement from image 1 — same composition, same positioning of elements.');
  }
  /* The walls rule is on every branch. It used to be a closing line that ran
     unconditionally, and front-loading the brief lost it for a room-scoped one —
     the brief most likely to grow a wall, since the model can see three rooms it
     has just been told not to draw. "Exactly as drawn" was carrying it
     implicitly, and implicit is what the camera line taught us not to trust; the
     room sentence is three words shorter to pay for the seven. */
  L.push(only
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
  maps.forEach((k, n) => L.push(`Image ${n + 2} is ${CONTROL_LINES[k]}. Do not render it.`));
  /* The captions matter more now that the brief no longer says where anything
     is: the drawing is what the model copies, and an unnamed grey block on it is
     whatever the model decides it is. Saying the captions are a key — read, not
     drawn — is what keeps them out of the render, which is otherwise exactly
     where our own lettering ends up. */
  if (opts.imgLabels) {
    L.push('The reference image is annotated: the captions name each block on the plan and are a'
      + ' key for reading it. Read them, draw none of the lettering.');
  }
  L.push('North is at the top.', '');

  /* One heading over everything the drawing already decided, so the model has a
     line to draw between what it may reinterpret and what it may not. The Notes
     columns are the one part of this brief a person actually wrote — said here
     once, rather than as a paragraph of meta-commentary further down. */
  L.push('LOCKED — reproduce exactly. Room shapes, sizes, positions and openings are'
    + ' fixed, and every Notes cell below is an instruction from the person who drew'
    + ' the plan, not a suggestion. Do not invent or omit rooms or objects.');
  L.push(only
    ? `The ${only.name}${dim ? ` — ${(only.area / 10000).toFixed(1)} m²` : ''}, on the ${f.name.toLowerCase()}.`
    : `"${f.name}"${dim ? ` — ${F.mapped
      ? `${(F.total / 10000).toFixed(1)} m² over ${F.rooms.length} named room${F.rooms.length === 1 ? '' : 's'}, overall footprint `
      : 'overall footprint '}${F.w.toFixed(1)} × ${F.h.toFixed(1)} m` : ''}.`);
  L.push('');

  /* Columns, not sentences: the same fifteen facts in a fixed order, with no
     connective prose for the model to weigh differently one row to the next. */
  L.push(only ? 'THE ROOM' : 'ROOMS');
  const roomCols = ['Room', ...(dim ? ['Size'] : []), ...(only ? [] : ['Where']), 'Notes'];
  L.push(roomCols.join(' | '));
  rooms.forEach(r => {
    const notes = [descOf(r.a)];
    if (opts.furniture && !r.items.length) {
      notes.push(r.fitted
        ? 'fitted units already in place as drawn, no loose furniture'
        : 'empty — furnish it plausibly for its purpose');
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
      ...(only ? [] : [cell(r.where.replace(/^on the /, '').replace(/ side$/, ''))]),
      cell(notes.filter(Boolean).join('; ')),
    ].join(' | '));
  });
  L.push('');

  if (opts.furniture) {
    /* No Position column any more. Every object still gets its own row — a name
       buried in a room line let the model put it anywhere in that room, and it
       did — but where it goes is the drawing's job: position stated in prose
       measures 0.41 quadrant F1 (arXiv:2507.08039) while the same fact sits
       pixel-exact on the reference. Two channels disagreeing about a sofa is
       strictly worse than one, and prose is the one that loses. Sizes stay
       behind `dimensions`, because that toggle is a person asking for
       measurements; nothing emits a size they did not ask for. */
    const rows: string[][] = [];
    rooms.forEach(r => r.items
      .slice()
      .sort((p, q) => (p.y - q.y) || (p.x - q.x))
      .forEach(i => rows.push(objRow(i, r.name, dim, !!only))));
    if (!only) F.loose.forEach(i => rows.push(objRow(i, '', dim, false)));

    if (rows.length) {
      L.push('OBJECTS — each one is already drawn on the plan; keep it exactly where it is');
      L.push([...(only ? [] : ['Room']), 'Object', ...(dim ? ['Size'] : []), 'Notes'].join(' | '));
      rows.forEach(r => L.push(r.join(' | ')));
      L.push('');
    }
  }

  /* Said once, wherever the stair happens to be listed — inside a named room or
     out on the floor. An unexplained stair-shaped block is what a render turns
     into a corridor that does not exist. */
  const listed = rooms.flatMap(r => r.items).concat(only ? [] : F.loose);
  if (opts.furniture && listed.some(i => STAIRS.test(labelOf(i)))) {
    L.push('The staircase goes up to the floor above: draw it as an enclosed run of'
      + ' steps, not as furniture and not as a corridor.', '');
  }
  /* The chairs are on the plan, drawn and counted, and the model was reading
     them as decoration: a six-seater came back with eight seats because the
     reference had eight blobs round it and nothing in the text said the blobs
     were furniture with a number. Say both — what they are, and that the count
     is the drawing's, not the model's to round up. */
  const seated = listed.filter(i => SEATS[i.kind]);
  if (opts.furniture && seated.length) {
    const total = seated.reduce((n, i) => n + SEATS[i.kind], 0);
    L.push(`The small squares around every table are chairs — ${total} across`
      + ` ${seated.length} table${seated.length === 1 ? '' : 's'}. Copy the number and the sides`
      + ' drawn at each table; a side with no chair drawn on it gets none.', '');
  }
  /* Outside the block above on purpose: a floor can consist of nothing but
     anonymous fitted blocks, and that is precisely when this needs saying. */
  if (!only && opts.furniture && F.anonFitted) {
    L.push(`${F.anonFitted} unnamed fitted block${F.anonFitted === 1 ? ' is' : 's are'} drawn on the plan`
      + ' — kitchen units, sanitary ware, built-in joinery. Render them as built-in cabinetry'
      + ' against the wall they touch, never open floor, a passage or a corridor.', '');
  }

  if (!only) {
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

/** One row of the OBJECTS table, in the column order the header promises. */
function objRow(i: Item, room: string, dim: boolean, only: boolean): string[] {
  return [
    ...(only ? [] : [cell(room)]),
    cell(labelOf(i).toLowerCase() || 'object'),
    ...(dim ? [`${Math.round(i.w)}×${Math.round(i.h)} cm`] : []),
    cell(descOf(i)),
  ];
}

export const CATALOG_NAME = (kind: string) => CAT_BY_KIND[kind]?.name ?? kind;
