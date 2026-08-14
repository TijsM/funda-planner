import type { Area, Floor, Item, Project, Pt, SelObj, SelRef, Wall } from './types';
import { bboxOf, polyArea, R2, uid } from './geometry';
import { CAT_BY_KIND, GROUP_TONE, ROOM_SWATCHES, toneFor } from './catalog';

export const SCHEMA = 2;

export function newFloor(name: string, level: number): Floor {
  return { id: uid(), name, level, walls: [], areas: [], items: [], notes: [], dims: [], lines: [], ref: null };
}

export function newProject(name?: string): Project {
  return {
    schema: SCHEMA, id: uid(), name: name || 'Untitled plan',
    createdAt: Date.now(), updatedAt: Date.now(), source: null,
    floors: [newFloor('Ground floor', 0)],
  };
}

/** Fills in anything an older save is missing. Runs on every load, so it must
 *  be idempotent and must never overwrite a deliberate user choice. */
export function migrate(p: Project): Project {
  p.floors = p.floors || [];
  p.floors.forEach((f, i) => {
    f.id = f.id || uid();
    f.walls = f.walls || []; f.areas = f.areas || []; f.items = f.items || [];
    f.notes = f.notes || []; f.dims = f.dims || []; f.lines = f.lines || [];
    if (f.level == null) f.level = i;
    if (f.ref === undefined) f.ref = null;
    /* the listing advertises a bitmap per floor; resolve it once, lazily sized */
    if (!f.ref && f.refUrl) f.ref = { src: f.refUrl, x: 0, y: 0, w: 0, h: 0 };
    f.walls.forEach(w => { w.openings = w.openings || []; w.t = w.t || 10; });
  });
  return p;
}

/** An emptied label means "show nothing" rather than "fall back to the
 *  catalogue name" — remember that choice so it survives a reload. */
export function setLabel(o: Item, v: string): void {
  o.label = v;
  if (String(v).trim()) delete o.noLabel; else o.noLabel = 1;
}

/** what actually gets drawn under an object */
export function labelOf(i: Item): string {
  const c = CAT_BY_KIND[i.kind];
  return i.label || (!i.noLabel && c ? c.name : '');
}

/** The description as the prompt should see it: newlines and runs of space
 *  collapsed, because it is spliced into a line-oriented brief. */
export const descOf = (o: { desc?: string }): string =>
  String(o.desc ?? '').replace(/\s+/g, ' ').trim();

/** Empty means absent. There is no "deliberately cleared" state to remember —
 *  unlike a label, a description has no default to fall back to. */
export function setDesc(o: Item | Area, v: string): void {
  if (String(v).trim()) o.desc = v; else delete o.desc;
}

export function makeItem(kind: string, at: Pt): Item {
  const c = CAT_BY_KIND[kind];
  if (!c) throw new Error(`unknown catalogue kind: ${kind}`);
  return {
    id: uid(), kind, x: at.x, y: at.y, w: c.w, h: c.h, rot: 0,
    color: toneFor(c), label: c.name,
  };
}

/* ── bounds ─────────────────────────────────────────────────────── */

export function contentBBox(f: Floor | null | undefined) {
  if (!f) return null;
  const pts: Pt[] = [];
  f.walls.forEach(w => { pts.push(w.a, w.b); });
  f.areas.forEach(a => pts.push(...a.poly));
  f.lines.forEach(l => { pts.push(l.a, l.b); });
  f.dims.forEach(d => { pts.push(d.a, d.b); });
  f.items.forEach(i => {
    const r = Math.hypot(i.w, i.h) / 2;
    pts.push({ x: i.x - r, y: i.y - r }, { x: i.x + r, y: i.y + r });
  });
  f.notes.forEach(n => pts.push({ x: n.x - 60, y: n.y - 20 }, { x: n.x + 60, y: n.y + 20 }));
  if (f.ref) pts.push({ x: f.ref.x, y: f.ref.y }, { x: f.ref.x + f.ref.w, y: f.ref.y + f.ref.h });
  return pts.length ? bboxOf(pts) : null;
}

/** the building only — walls and rooms. Orientation and the AI reference frame
 *  use this so a chair dropped off the edge cannot rotate every compass point. */
export function shellBBox(f: Floor) {
  const pts: Pt[] = [];
  f.walls.forEach(w => pts.push(w.a, w.b));
  f.areas.forEach(a => pts.push(...a.poly));
  return pts.length ? bboxOf(pts) : contentBBox(f);
}

export const floorArea = (f: Floor) => f.areas.reduce((s, a) => s + polyArea(a.poly), 0);

/* ── selection ──────────────────────────────────────────────────── */

export function findOpening(f: Floor, id: string): { op: Floor['walls'][0]['openings'][0]; wall: Wall } | null {
  for (const w of f.walls) for (const op of w.openings) if (op.id === id) return { op, wall: w };
  return null;
}

export function resolveSel(f: Floor | null, sel: SelRef[]): SelObj[] {
  if (!f) return [];
  const out: SelObj[] = [];
  for (const s of sel) {
    if (s.t === 'opening') {
      const r = findOpening(f, s.id);
      if (r) out.push({ t: 'opening', o: r.op, wall: r.wall });
      continue;
    }
    const bag: Record<string, { id: string }[]> = {
      wall: f.walls, area: f.areas, item: f.items, note: f.notes, dim: f.dims, line: f.lines,
    };
    const o = (bag[s.t] || []).find(x => x.id === s.id);
    if (o) out.push({ t: s.t, o } as SelObj);
  }
  return out;
}

/** visit every movable point of a selection, for nudging and group rotation */
export function eachSelPoint(f: Floor, sel: SelRef[], fn: (p: Pt) => void): void {
  for (const s of resolveSel(f, sel)) {
    if (s.t === 'wall' || s.t === 'dim' || s.t === 'line') { fn(s.o.a); fn(s.o.b); }
    else if (s.t === 'area') s.o.poly.forEach(fn);
    else if (s.t === 'item' || s.t === 'note') fn(s.o as unknown as Pt);
  }
}

/* ── starters ───────────────────────────────────────────────────── */

export function blankProject(name: string, garden: boolean): Project {
  const p = newProject(name);
  const f = p.floors[0];
  const rect = (W: number, H: number): Pt[] =>
    [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];

  if (garden) {
    f.name = 'Garden';
    const W = 900, H = 1400, c = rect(W, H);
    for (let i = 0; i < 4; i++)
      f.walls.push({ id: uid(), a: { ...c[i] }, b: { ...c[(i + 1) % 4] }, t: 14, openings: [] });
    f.areas.push({ id: uid(), poly: c.map(q => ({ ...q })), name: 'Garden', color: '#C9D3C0', nx: 0, ny: 0, label: true });
    f.items.push({ ...makeItem('terrace', { x: W / 2, y: 200 }) });
    f.items.push({ ...makeItem('lawn', { x: W / 2, y: 830 }), w: 780, h: 620 });
  } else {
    const W = 800, H = 1000, c = rect(W, H);
    for (let i = 0; i < 4; i++)
      f.walls.push({ id: uid(), a: { ...c[i] }, b: { ...c[(i + 1) % 4] }, t: 24, openings: [] });
    f.walls[0].openings.push({ id: uid(), at: 0.5, type: 'window', width: 180, flip: 0, side: 0 });
    f.walls[3].openings.push({ id: uid(), at: 0.5, type: 'door', width: 95, flip: 0, side: 0 });
    f.areas.push({ id: uid(), poly: c.map(q => ({ ...q })), name: 'Room', color: ROOM_SWATCHES[0], nx: 0, ny: 0, label: true });
  }
  return p;
}

/** drop an opening into the emptiest stretch of a wall */
export function addOpening(w: Wall, type: 'door' | 'window') {
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  const width = Math.min(type === 'door' ? 90 : 120, Math.max(20, L - 20));
  w.openings = w.openings || [];
  let at = 0.5, best = -1;
  for (let i = 1; i <= 9; i++) {
    const c = i / 10;
    const gap = w.openings.length ? Math.min(...w.openings.map(o => Math.abs(o.at - c))) : 1;
    if (gap > best) { best = gap; at = c; }
  }
  const op = { id: uid(), at, type, width, flip: 0 as const, side: 0 as const };
  w.openings.push(op);
  return op;
}

export function newArea(centre: Pt, half: number, index: number): Area {
  return {
    id: uid(), name: '', color: ROOM_SWATCHES[index % ROOM_SWATCHES.length], nx: 0, ny: 0, label: true,
    poly: [
      { x: R2(centre.x - half), y: R2(centre.y - half) }, { x: R2(centre.x + half), y: R2(centre.y - half) },
      { x: R2(centre.x + half), y: R2(centre.y + half) }, { x: R2(centre.x - half), y: R2(centre.y + half) },
    ],
  };
}

export { GROUP_TONE };
