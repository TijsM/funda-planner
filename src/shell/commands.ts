import type { Area, Dim, Floor, Item, Line, Note, Pt, SelRef, Wall } from '@engine/types';
import { R2, bboxOf, dist, rotPt, uid } from '@engine/geometry';
import { ROOM_SWATCHES, CAT_BY_KIND, toneFor } from '@engine/catalog';
import {
  addOpening, eachSelPoint, findOpening, makeItem, newArea, newFloor, resolveSel,
} from '@engine/model';
import { ed } from '@state/store';

/** Every mutation the UI can trigger, in one place, so components stay dumb and
 *  undo is pushed exactly once per user-visible action. */

const bagOf = (f: Floor) => ({
  wall: f.walls, area: f.areas, item: f.items, note: f.notes, dim: f.dims, line: f.lines,
} as Record<string, { id: string }[]>);

export function deleteSelection() {
  const s = ed();
  const f = s.floor();
  if (!f || !s.sel.length) return;
  s.pushUndo();
  const ids = (t: string) => s.sel.filter(x => x.t === t).map(x => x.id);
  const bag = bagOf(f);
  (['wall', 'area', 'item', 'note', 'dim', 'line'] as const).forEach(t => {
    const kill = ids(t);
    const arr = bag[t];
    for (let i = arr.length - 1; i >= 0; i--) if (kill.includes(arr[i].id)) arr.splice(i, 1);
  });
  ids('opening').forEach(id => {
    const r = findOpening(f, id);
    if (r) r.wall.openings.splice(r.wall.openings.indexOf(r.op), 1);
  });
  s.setSel([]);
  s.touch();
}

export function duplicateSelection() {
  const s = ed();
  const f = s.floor();
  if (!f || !s.sel.length) return;
  s.pushUndo();
  const off = 25;
  const out: SelRef[] = [];
  resolveSel(f, s.sel).forEach(o => {
    if (o.t === 'opening') return;
    const c = JSON.parse(JSON.stringify(o.o)) as { id: string };
    c.id = uid();
    if (o.t === 'wall' || o.t === 'dim' || o.t === 'line') {
      const w = c as unknown as Wall;
      w.a.x += off; w.a.y += off; w.b.x += off; w.b.y += off;
      if (o.t === 'wall' && w.openings) w.openings.forEach(op => { op.id = uid(); });
    } else if (o.t === 'area') {
      (c as unknown as Area).poly.forEach(p => { p.x += off; p.y += off; });
    } else {
      const i = c as unknown as Pt;
      i.x += off; i.y += off;
    }
    bagOf(f)[o.t].push(c);
    out.push({ t: o.t, id: c.id });
  });
  s.setSel(out);
  s.touch();
}

export function nudge(dx: number, dy: number) {
  const s = ed();
  const f = s.floor();
  if (!f || !s.sel.length) return;
  s.pushUndo();
  resolveSel(f, s.sel).forEach(o => {
    if (o.t === 'wall' || o.t === 'dim' || o.t === 'line') {
      o.o.a.x += dx; o.o.a.y += dy; o.o.b.x += dx; o.o.b.y += dy;
    } else if (o.t === 'area') {
      o.o.poly.forEach(p => { p.x += dx; p.y += dy; });
    } else if (o.t === 'opening') {
      const L = dist(o.wall.a, o.wall.b) || 1;
      o.o.at = Math.max(0, Math.min(1, o.o.at + (dx + dy) / L));
    } else {
      o.o.x += dx; o.o.y += dy;
    }
  });
  s.touch();
}

export function rotateSelection(deg = 90) {
  const s = ed();
  const f = s.floor();
  if (!f || !s.sel.length) return;
  s.pushUndo();
  const pts: Pt[] = [];
  eachSelPoint(f, s.sel, p => pts.push(p));
  if (pts.length) {
    const b = bboxOf(pts);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    eachSelPoint(f, s.sel, p => {
      const r = rotPt(p.x - cx, p.y - cy, deg);
      p.x = R2(cx + r.x); p.y = R2(cy + r.y);
    });
  }
  resolveSel(f, s.sel).forEach(o => {
    if (o.t === 'item') o.o.rot = R2((((o.o.rot || 0) + deg) % 360 + 360) % 360);
  });
  s.touch();
}

/* ── placing ────────────────────────────────────────────────────── */

export function placeCatalogItem(kind: string, at: Pt, keepArmed: boolean) {
  const s = ed();
  const f = s.floor();
  if (!f || !CAT_BY_KIND[kind]) return;
  s.pushUndo();
  const it = makeItem(kind, at);
  f.items.push(it);
  if (!keepArmed) s.patch({ place: null });
  s.setSel([{ t: 'item', id: it.id }]);
  s.touch();
}

export type SpecialKind = 'wall' | 'room' | 'note' | 'arrow' | 'measure';

export const SPECIALS: Record<SpecialKind, { name: string; hint: string; icon: string }> = {
  wall: { name: 'Wall', hint: '3 m — drag the ends to place it', icon: 'i-wall' },
  room: { name: 'Room', hint: 'a 3×3 m area — drag the corners', icon: 'i-room' },
  note: { name: 'Text', hint: 'type straight into it', icon: 'i-text' },
  arrow: { name: 'Arrow', hint: 'point at something', icon: 'i-flip' },
  measure: { name: 'Measure', hint: 'live distance between two ends', icon: 'i-meas' },
};

export function placeSpecial(kind: SpecialKind, p: Pt, keepArmed: boolean) {
  const s = ed();
  const f = s.floor();
  if (!f) return;
  s.pushUndo();
  let sel: SelRef | null = null;

  if (kind === 'wall') {
    const w: Wall = { id: uid(), a: { x: R2(p.x - 150), y: p.y }, b: { x: R2(p.x + 150), y: p.y }, t: 10, openings: [] };
    f.walls.push(w); sel = { t: 'wall', id: w.id };
  } else if (kind === 'room') {
    const a = newArea(p, 150, f.areas.length);
    f.areas.push(a); sel = { t: 'area', id: a.id };
  } else if (kind === 'note') {
    const n: Note = { id: uid(), x: p.x, y: p.y, text: 'Type here', size: 34, rot: 0, color: '#E4632C' };
    f.notes.push(n); sel = { t: 'note', id: n.id };
  } else if (kind === 'arrow') {
    const l: Line = {
      id: uid(), a: { x: R2(p.x - 170), y: R2(p.y + 110) }, b: { x: R2(p.x + 60), y: R2(p.y - 60) },
      arrow: 1, color: '#E4632C',
    };
    f.lines.push(l); sel = { t: 'line', id: l.id };
  } else {
    const d: Dim = { id: uid(), a: { x: R2(p.x - 200), y: p.y }, b: { x: R2(p.x + 200), y: p.y } };
    f.dims.push(d); sel = { t: 'dim', id: d.id };
    if (!s.layers.dims) s.patch({ layers: { ...s.layers, dims: true } });
  }

  if (!keepArmed) s.patch({ place: null });
  s.setSel(sel ? [sel] : []);
  s.touch();
}

export function addOpeningTo(w: Wall, type: 'door' | 'window') {
  const s = ed();
  s.pushUndo();
  const op = addOpening(w, type);
  s.setSel([{ t: 'opening', id: op.id }]);
  s.touch();
}

/* ── floors ─────────────────────────────────────────────────────── */

export function addFloor() {
  const s = ed();
  if (!s.project) return;
  s.pushUndo();
  const lv = Math.max(...s.project.floors.map(f => f.level)) + 1;
  s.project.floors.push(newFloor(`Level ${lv}`, lv));
  s.patch({ floorIndex: s.project.floors.length - 1, sel: [] });
  s.touch();
}

export function removeFloor(i: number) {
  const s = ed();
  if (!s.project || s.project.floors.length < 2) {
    s.toast('A plan needs at least one floor.', 'err');
    return;
  }
  s.pushUndo();
  s.project.floors.splice(i, 1);
  s.patch({ floorIndex: Math.min(s.floorIndex, s.project.floors.length - 1), sel: [] });
  s.touch();
}

/* ── drafts ─────────────────────────────────────────────────────── */

export function commitDraft() {
  const s = ed();
  const f = s.floor();
  const d = s.draft;
  if (!f || !d) return;

  if (d.kind === 'wall' && d.pts.length >= 2) {
    s.pushUndo();
    const out: SelRef[] = [];
    for (let i = 0; i < d.pts.length - 1; i++) {
      if (dist(d.pts[i], d.pts[i + 1]) < 1) continue;
      const w: Wall = { id: uid(), a: { ...d.pts[i] }, b: { ...d.pts[i + 1] }, t: d.t, openings: [] };
      f.walls.push(w);
      out.push({ t: 'wall', id: w.id });
    }
    s.setSel(out);
  } else if (d.kind === 'room' && d.pts.length >= 3) {
    s.pushUndo();
    const a: Area = {
      id: uid(), poly: d.pts.map(p => ({ ...p })), name: '',
      color: ROOM_SWATCHES[f.areas.length % ROOM_SWATCHES.length], nx: 0, ny: 0, label: true,
    };
    f.areas.push(a);
    s.setSel([{ t: 'area', id: a.id }]);
  }
  s.patch({ draft: null, tool: 'select' });
  s.touch();
}

export const cancelDraft = () => ed().patch({ draft: null, snapHint: null, place: null });

/** the free-form colour/label edits the toolbars make */
export function setItemColor(o: Item, c: string) {
  const s = ed(); s.pushUndo(); o.color = c; s.touch();
}
export function setAreaColor(o: Area, c: string) {
  const s = ed(); s.pushUndo(); o.color = c; s.touch();
}
export { toneFor };
