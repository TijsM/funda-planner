import type { Area, Dim, Floor, Item, Line, Note, Opening, Pt, SelRef, Wall } from '../types';
import { R2, clamp, closestOnSeg, dist, distToSeg, uid } from '../geometry';
import { resolveSel } from '../model';

/** What a copy is, on the clipboard and in memory.
 *
 *  It is JSON text carrying a marker, so the system clipboard can hold it and a
 *  paste into another tab — or another plan — works without a server. Anything
 *  without the marker is somebody else's clipboard and is left alone. */

export const CLIP_MARK = 'plattegrond-studio/clip@1';

/** how far a paste with no pointer position lands from the original, in cm */
export const PASTE_OFFSET = 25;

export interface ClipObjects {
  mark: string;
  kind: 'objects';
  /** The plan this was copied from, when the copier knew it.
   *
   *  Only object photos read it. A `PhotoRef` names bytes that live per plan, so
   *  a paste into a DIFFERENT plan has to copy those bytes across before the
   *  reference means anything — see `adoptPhotos` in `src/shell/photos.ts`.
   *  Optional because a clip written by an older build does not have it, and the
   *  honest reading of "no origin" is "assume it is not this one". */
  project?: string;
  walls: Wall[]; areas: Area[]; items: Item[]; notes: Note[]; dims: Dim[]; lines: Line[];
  /** An opening has no position of its own — it is a hole in a wall. The wall it
   *  came from is remembered so a paste on the same floor puts it back there. */
  openings: { op: Opening; wallId: string }[];
  /** the centre of what was copied, so a paste can land under the pointer */
  cx: number; cy: number;
}

export interface ClipFloor { mark: string; kind: 'floor'; floor: Floor; project?: string }

export type Clip = ClipObjects | ClipFloor;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const emptyClip = (): ClipObjects => ({
  mark: CLIP_MARK, kind: 'objects',
  walls: [], areas: [], items: [], notes: [], dims: [], lines: [], openings: [],
  cx: 0, cy: 0,
});

/** where an opening sits in the world, for the copy's centre */
function openingPt(w: Wall, op: Opening): Pt {
  return { x: w.a.x + (w.b.x - w.a.x) * op.at, y: w.a.y + (w.b.y - w.a.y) * op.at };
}

export function clipOfSelection(f: Floor, sel: SelRef[], projectId?: string): ClipObjects | null {
  const objs = resolveSel(f, sel);
  if (!objs.length) return null;
  const c = emptyClip();
  if (projectId) c.project = projectId;
  const pts: Pt[] = [];

  for (const o of objs) {
    if (o.t === 'opening') {
      c.openings.push({ op: clone(o.o), wallId: o.wall.id });
      pts.push(openingPt(o.wall, o.o));
    } else if (o.t === 'wall') {
      c.walls.push(clone(o.o)); pts.push(o.o.a, o.o.b);
    } else if (o.t === 'dim') {
      c.dims.push(clone(o.o)); pts.push(o.o.a, o.o.b);
    } else if (o.t === 'line') {
      c.lines.push(clone(o.o)); pts.push(o.o.a, o.o.b);
    } else if (o.t === 'area') {
      c.areas.push(clone(o.o)); pts.push(...o.o.poly);
    } else if (o.t === 'item') {
      c.items.push(clone(o.o)); pts.push({ x: o.o.x, y: o.o.y });
    } else {
      c.notes.push(clone(o.o)); pts.push({ x: o.o.x, y: o.o.y });
    }
  }

  /* The centre of the points rather than of a bounding box: a paste should put
     the thing the pointer is over under the pointer, and for one object those
     are the same number anyway. */
  if (pts.length) {
    c.cx = R2(pts.reduce((s, p) => s + p.x, 0) / pts.length);
    c.cy = R2(pts.reduce((s, p) => s + p.y, 0) / pts.length);
  }
  return c;
}

export const clipOfFloor = (f: Floor, projectId?: string): ClipFloor =>
  ({ mark: CLIP_MARK, kind: 'floor', floor: clone(f), ...(projectId ? { project: projectId } : {}) });

export const clipText = (c: Clip) => JSON.stringify(c);

/** How many things a clip holds — what a toast reports. */
export function clipCount(c: Clip): number {
  if (c.kind === 'floor') return 1;
  return c.walls.length + c.areas.length + c.items.length
    + c.notes.length + c.dims.length + c.lines.length + c.openings.length;
}

/** Accepts anything and returns a clip or null. Never throws: the argument is
 *  whatever happened to be on the clipboard, which is usually not ours. */
export function parseClip(raw: string): Clip | null {
  if (!raw || raw.indexOf(CLIP_MARK) < 0) return null;
  let c: Clip;
  try { c = JSON.parse(raw) as Clip; } catch { return null; }
  if (!c || c.mark !== CLIP_MARK) return null;

  if (c.kind === 'floor') {
    if (!c.floor || !Array.isArray(c.floor.walls)) return null;
    return c;
  }
  if (c.kind !== 'objects') return null;
  const e = emptyClip();
  return {
    ...e, ...c,
    walls: c.walls ?? [], areas: c.areas ?? [], items: c.items ?? [],
    notes: c.notes ?? [], dims: c.dims ?? [], lines: c.lines ?? [],
    openings: (c.openings ?? []).filter(x => x && x.op),
    cx: Number(c.cx) || 0, cy: Number(c.cy) || 0,
  };
}

/* ── pasting ────────────────────────────────────────────────────── */

function nearestWall(f: Floor, at: Pt | null, within: number): Wall | null {
  if (!at) return null;
  let best: Wall | null = null, bd = within;
  for (const w of f.walls) {
    const d = distToSeg(at, w.a, w.b);
    if (d <= bd) { bd = d; best = w; }
  }
  return best;
}

/** Where a pasted opening sits along its wall.
 *
 *  Onto a wall the pointer picked out, it goes where the pointer is. Back onto
 *  its own wall — which is what ⌘D and a paste with no pointer do — it steps one
 *  width along, so the copy is visibly beside the original rather than exactly
 *  on top of it. Either way it stays fully inside the wall. */
function placeOpening(w: Wall, op: Opening, at: Pt | null, sameWall: boolean): number {
  const L = dist(w.a, w.b) || 1;
  const half = Math.min(0.49, op.width / 2 / L);
  if (at && !sameWall) return clamp(closestOnSeg(at, w.a, w.b).t, half, 1 - half);
  const step = op.width / L + 0.04;
  const fwd = op.at + step;
  return clamp(fwd <= 1 - half ? fwd : op.at - step, half, 1 - half);
}

export interface PasteResult {
  sel: SelRef[];
  /** openings that found no wall to sit in — the caller says so out loud */
  skipped: number;
}

/** Drops a copy into a floor, with fresh ids throughout, and hands back what
 *  should now be selected. Mutates `f`, like every other edit in this app. */
export function pasteObjects(f: Floor, c: ClipObjects, at: Pt | null = null): PasteResult {
  const dx = at ? R2(at.x - c.cx) : PASTE_OFFSET;
  const dy = at ? R2(at.y - c.cy) : PASTE_OFFSET;
  const move = (p: Pt) => { p.x = R2(p.x + dx); p.y = R2(p.y + dy); };
  const sel: SelRef[] = [];

  c.walls.forEach(src => {
    const w = clone(src);
    w.id = uid(); move(w.a); move(w.b);
    w.openings = (w.openings ?? []).map(op => ({ ...op, id: uid() }));
    f.walls.push(w);
    sel.push({ t: 'wall', id: w.id });
  });
  c.areas.forEach(src => {
    const a = clone(src);
    a.id = uid(); a.poly.forEach(move);
    f.areas.push(a);
    sel.push({ t: 'area', id: a.id });
  });
  c.items.forEach(src => {
    const i = clone(src);
    i.id = uid(); move(i as unknown as Pt);
    f.items.push(i);
    sel.push({ t: 'item', id: i.id });
  });
  c.notes.forEach(src => {
    const n = clone(src);
    n.id = uid(); move(n as unknown as Pt);
    f.notes.push(n);
    sel.push({ t: 'note', id: n.id });
  });
  c.dims.forEach(src => {
    const d = clone(src);
    d.id = uid(); move(d.a); move(d.b);
    f.dims.push(d);
    sel.push({ t: 'dim', id: d.id });
  });
  c.lines.forEach(src => {
    const l = clone(src);
    l.id = uid(); move(l.a); move(l.b);
    f.lines.push(l);
    sel.push({ t: 'line', id: l.id });
  });

  let skipped = 0;
  for (const e of c.openings) {
    /* The wall under the pointer wins — that is what the person aimed at. With
       no pointer, or nothing near it, the opening goes home to the wall it was
       copied from; failing that, to whichever wall is closest at any distance. */
    const own = f.walls.find(w => w.id === e.wallId) ?? null;
    const w = nearestWall(f, at, 150) ?? own ?? nearestWall(f, at, Infinity) ?? null;
    if (!w) { skipped++; continue; }
    const op = clone(e.op);
    op.id = uid();
    op.width = Math.max(20, Math.min(op.width, dist(w.a, w.b) - 10));
    op.at = placeOpening(w, op, at, w === own);
    w.openings = w.openings ?? [];
    w.openings.push(op);
    sel.push({ t: 'opening', id: op.id });
  }

  return { sel, skipped };
}

/* ── floors ─────────────────────────────────────────────────────── */

/** A floor with every id renewed, so the copy shares nothing with its original
 *  and a selection can never resolve to the wrong one. */
export function cloneFloor(f: Floor, name: string): Floor {
  const c = clone(f);
  c.id = uid();
  c.name = name;
  (c.walls ?? []).forEach(w => {
    w.id = uid();
    (w.openings ?? []).forEach(op => { op.id = uid(); });
  });
  (c.areas ?? []).forEach(a => { a.id = uid(); });
  (c.items ?? []).forEach(i => { i.id = uid(); });
  (c.notes ?? []).forEach(n => { n.id = uid(); });
  (c.dims ?? []).forEach(d => { d.id = uid(); });
  (c.lines ?? []).forEach(l => { l.id = uid(); });
  /* A Floorplanner design id names one imported drawing. Two floors claiming
     the same one would be a lie about where the copy came from — and the
     re-import that reads it would overwrite whichever it found first. */
  delete c.fmlDesignId;
  return c;
}

/** “Ground floor” → “Ground floor copy” → “Ground floor copy 2”, never
 *  “… copy copy”: a copy of a copy is still a copy of the same floor. */
export function copyName(base: string, taken: string[]): string {
  const root = String(base ?? '').replace(/ copy(\s+\d+)?$/i, '').trim() || 'Floor';
  let n = `${root} copy`;
  for (let i = 2; taken.includes(n); i++) n = `${root} copy ${i}`;
  return n;
}

/** Files a floor into a project directly above `after`, shoving everything that
 *  was above it up a level so the stack keeps its order. Returns the index it
 *  landed at. */
export function insertFloor(floors: Floor[], f: Floor, after: number): number {
  const src = floors[after];
  const lv = src ? src.level : floors.length - 1;
  floors.forEach(x => { if (x.level > lv) x.level += 1; });
  f.level = lv + 1;
  const at = Math.min(after + 1, floors.length);
  floors.splice(at, 0, f);
  return at;
}
