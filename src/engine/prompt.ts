import type { Area, BBox, Floor, Item, Pt, Project } from './types';
import { bearing, compass, polyArea, polyCentroid, pointInPoly, unitNormal } from './geometry';
import { CAT_BY_KIND } from './catalog';
import { descOf, labelOf, shellBBox } from './model';

export type ViewKind = 'top' | 'eye' | 'iso' | 'sketch';

export interface PromptOpts {
  view: ViewKind;
  /** an area id, or '*' for the whole floor */
  room?: string;
  style?: string;
  furniture: boolean;
  dimensions: boolean;
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

export const AI_VIEWS: Record<ViewKind, { lead: string; cam: string }> = {
  top: {
    lead: "Photorealistic top-down (bird's-eye) architectural visualisation of the furnished floor plan below, ceiling removed.",
    cam: 'Camera directly overhead, orthographic-looking, the whole floor filling the frame, walls cut cleanly at about 1.2 m height.',
  },
  eye: {
    lead: 'Photorealistic wide-angle interior photograph of the space described below.',
    cam: 'Camera at standing eye level (about 1.6 m), 24 mm lens, positioned in the {ROOM} looking across the room towards the windows.',
  },
  iso: {
    lead: 'A 3D isometric cutaway "dollhouse" view of the furnished floor plan below, ceiling removed.',
    cam: 'Isometric camera at roughly 45°, the whole floor visible, walls cut at about 1.2 m, soft studio lighting, clean architectural-model look.',
  },
  sketch: {
    lead: 'A hand-drawn watercolour and ink architectural illustration of the floor plan below, seen from above.',
    cam: "Loose confident linework, washes of colour, generous white paper margin, the feel of an architect's presentation sketch.",
  },
};

/** Close the user's free text off, so it cannot run into the generated prose
 *  that follows it on the same line. */
function sentence(s: string): string {
  return /[.!?;:]$/.test(s) ? s : `${s}.`;
}

/** `sofa (225×95 cm) — dark green velvet, low back`
 *
 *  Descriptions are free text and routinely contain commas, so a comma-joined
 *  list stops being parseable the moment one is written. Switch to semicolons
 *  only then — a plan with no descriptions reads exactly as it did before. */
function itemList(items: Item[], dim: boolean): string {
  const parts = items.map(i => {
    const nm = labelOf(i).toLowerCase() || 'object';
    const d = descOf(i);
    return (dim ? `${nm} (${Math.round(i.w)}×${Math.round(i.h)} cm)` : nm) + (d ? ` — ${d}` : '');
  });
  return parts.join(items.some(i => descOf(i)) ? '; ' : ', ');
}

/** Where a thing sits, phrased against the attached top-down drawing rather than
 *  in metres — "top-left" lands on the image, "x = 240 cm" does not. Objects
 *  pressed up against an elevation say so, because that is what stops a model
 *  floating a fireplace into the middle of the floor. */
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

export function buildPrompt(project: Project, f: Floor, opts: PromptOpts): string {
  const F = planFacts(f);
  const V = AI_VIEWS[opts.view] ?? AI_VIEWS.top;
  const only = opts.room && opts.room !== '*' ? F.rooms.find(r => r.a.id === opts.room) : undefined;
  const rooms = only ? [only] : F.rooms;
  const dim = opts.dimensions;
  const L: string[] = [];

  const addr = project.source?.address || project.name;
  L.push(V.lead, '');

  L.push('SUBJECT');
  L.push(only
    ? `The ${only.name} of ${addr}${dim ? ` — ${(only.area / 10000).toFixed(1)} m²` : ''}, on the ${f.name.toLowerCase()}.`
    : `${addr} — "${f.name}"${dim ? `, ${F.mapped
      ? `${(F.total / 10000).toFixed(1)} m² over ${F.rooms.length} named room${F.rooms.length === 1 ? '' : 's'}, overall footprint `
      : 'overall footprint '}${F.w.toFixed(1)} × ${F.h.toFixed(1)} m` : ''}.`);
  L.push('North is at the top of the plan.', '');

  L.push(only ? 'THE ROOM' : 'LAYOUT — reproduce exactly, do not invent or omit rooms');
  rooms.forEach(r => {
    const bits = [r.name];
    if (dim) bits.push(`${(r.area / 10000).toFixed(1)} m²`);
    if (!only) bits.push(r.where);
    const rd = descOf(r.a);
    /* an em-dash clause, the same convention the object list uses — and it
       avoids capitalising whatever word the user happened to start with */
    let line = rd ? `- ${bits.join(', ')} — ${sentence(rd)}` : `- ${bits.join(', ')}.`;
    if (opts.furniture) {
      if (r.items.length) {
        line += ' Contains: ' + itemList(r.items, dim) + '.';
      } else if (r.fitted) {
        line += ' Fitted units already in place (as drawn); no loose furniture.';
      } else {
        line += ' Empty — furnish it plausibly for its purpose.';
      }
    }
    L.push(line);
  });
  if (!only && opts.furniture && F.loose.length) {
    /* One line per object, each with where it actually is. A comma-separated bag
       of nouns leaves placement entirely to the model, which then moves things. */
    L.push('', 'OBJECTS — each one is already placed; keep it where the plan puts it');
    F.loose.forEach(i => {
      const nm = labelOf(i).toLowerCase() || 'object';
      const d = descOf(i);
      const size = dim ? ` (${Math.round(i.w)}×${Math.round(i.h)} cm)` : '';
      L.push(`- ${placeOf(i, F.bbox)}: ${nm}${size}.${d ? ` ${sentence(d)}` : ''}`);
    });
  }
  /* Said once, wherever the stair happens to be listed — inside a named room or
     out on the floor. An unexplained stair-shaped block is what a render turns
     into a corridor that does not exist. */
  if (opts.furniture && rooms.flatMap(r => r.items).concat(only ? [] : F.loose)
    .some(i => STAIRS.test(labelOf(i)))) {
    L.push('', 'The staircase goes up to the floor above: draw it as an enclosed run of'
      + ' steps, not as furniture and not as a corridor.');
  }
  /* Outside the block above on purpose: a floor can consist of nothing but
     anonymous fitted blocks, and that is precisely when this needs saying. */
  if (!only && opts.furniture && F.anonFitted) {
    L.push('', `${F.anonFitted} unnamed fitted block${F.anonFitted === 1 ? ' is' : 's are'} drawn on the plan`
      + ' — kitchen units, sanitary ware, built-in joinery. Reproduce them as built-in cabinetry'
      + ' against the wall they touch. They are never open floor, a passage or a corridor.');
  }
  /* The descriptions are the one part of this brief a person actually wrote —
     say so, or the model treats them as flavour text alongside the geometry. */
  const listed = rooms.flatMap(r => r.items).concat(only ? [] : F.loose);
  if (rooms.some(r => descOf(r.a)) || (opts.furniture && listed.some(i => descOf(i)))) {
    L.push('');
    L.push('These are deliberate instructions from the person who drew the plan, '
      + 'not suggestions: reproduce every described room and object as described.');
  }
  L.push('');

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
    L.push(`${F.doors} doorway${F.doors === 1 ? '' : 's'} connect the rooms. Do not add windows or doors that are not listed.`, '');
  }

  if (opts.style?.trim()) L.push('STYLE', opts.style.trim(), '');
  if (F.notes.length) {
    L.push('NOTES FROM THE PLAN');
    F.notes.slice(0, 8).forEach(n => L.push(`- ${n}`));
    L.push('');
  }

  L.push('RENDER');
  L.push(V.cam.replace('{ROOM}', rooms[0]?.name || 'main room'));
  L.push(opts.view !== 'sketch'
    ? 'Natural daylight, realistic materials and shadows, high detail, no people, no text or labels anywhere in the image.'
    : 'No photographic realism, no text or labels in the image.');
  L.push('');
  L.push('Match the attached floor plan image exactly: same room shapes, same proportions, same relative positions. Do not add, remove or rearrange walls.');

  return L.join('\n');
}

export const CATALOG_NAME = (kind: string) => CAT_BY_KIND[kind]?.name ?? kind;
