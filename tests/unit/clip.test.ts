import { describe, it, expect } from 'vitest';
import {
  CLIP_MARK, PASTE_OFFSET, blankProject, clipCount, clipOfFloor, clipOfSelection, clipText,
  cloneFloor, copyName, insertFloor, makeItem, newFloor, parseClip, pasteObjects,
} from '@engine/index';
import type { ClipObjects } from '@engine/io/clip';
import type { Floor, SelRef, Wall } from '@engine/types';

/** A floor with one wall, one opening in it, one room and one sofa — enough
 *  that every branch of a copy has something to carry. */
function fixture(): Floor {
  const f = newFloor('Ground floor', 0);
  const w: Wall = {
    id: 'w1', a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, t: 10,
    openings: [{ id: 'o1', at: 0.25, type: 'door', width: 90, flip: 0, side: 0 }],
  };
  f.walls.push(w);
  f.walls.push({ id: 'w2', a: { x: 0, y: 300 }, b: { x: 400, y: 300 }, t: 10, openings: [] });
  f.areas.push({
    id: 'a1', name: 'Woonkamer', color: '#eee', nx: 0, ny: 0, label: true,
    poly: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
  });
  f.items.push({ ...makeItem('sofa3', { x: 200, y: 150 }), id: 'i1' });
  f.notes.push({ id: 'n1', x: 50, y: 50, text: 'hier', size: 20, rot: 0, color: '#000' });
  f.dims.push({ id: 'd1', a: { x: 0, y: 400 }, b: { x: 400, y: 400 } });
  f.lines.push({ id: 'l1', a: { x: 0, y: 500 }, b: { x: 100, y: 500 }, arrow: 1 });
  return f;
}

const sel = (t: SelRef['t'], id: string): SelRef[] => [{ t, id }];

describe('copying a selection', () => {
  it('carries every kind of object, openings included', () => {
    const f = fixture();
    const all: SelRef[] = [
      { t: 'wall', id: 'w1' }, { t: 'area', id: 'a1' }, { t: 'item', id: 'i1' },
      { t: 'note', id: 'n1' }, { t: 'dim', id: 'd1' }, { t: 'line', id: 'l1' },
      { t: 'opening', id: 'o1' },
    ];
    const c = clipOfSelection(f, all)!;
    expect(clipCount(c)).toBe(7);
    expect(c.openings[0].wallId).toBe('w1');
  });

  it('is null when nothing is selected', () => {
    expect(clipOfSelection(fixture(), [])).toBeNull();
  });

  it('survives the clipboard as text', () => {
    const f = fixture();
    const c = clipOfSelection(f, sel('item', 'i1'))!;
    const back = parseClip(clipText(c));
    expect(back).not.toBeNull();
    expect(back!.kind).toBe('objects');
    expect(clipCount(back!)).toBe(1);
  });

  it('leaves somebody else’s clipboard alone', () => {
    expect(parseClip('just some text a person copied')).toBeNull();
    expect(parseClip('')).toBeNull();
    expect(parseClip(`{"mark":"${CLIP_MARK}"`)).toBeNull();          // ours, but truncated
    expect(parseClip('{"mark":"other/clip@1","kind":"objects"}')).toBeNull();
  });
});

describe('pasting', () => {
  it('offsets a copy when there is no pointer, and renews its id', () => {
    const f = fixture();
    const c = clipOfSelection(f, sel('item', 'i1'))!;
    const r = pasteObjects(f, c);
    expect(f.items).toHaveLength(2);
    const copy = f.items[1];
    expect(copy.id).not.toBe('i1');
    expect(copy.x).toBe(200 + PASTE_OFFSET);
    expect(copy.y).toBe(150 + PASTE_OFFSET);
    expect(r.sel).toEqual([{ t: 'item', id: copy.id }]);
  });

  it('lands under the pointer when there is one', () => {
    const f = fixture();
    const c = clipOfSelection(f, sel('item', 'i1'))!;
    pasteObjects(f, c, { x: 1000, y: 900 });
    expect(f.items[1].x).toBe(1000);
    expect(f.items[1].y).toBe(900);
  });

  it('keeps a group’s shape, moving it as one', () => {
    const f = fixture();
    const c = clipOfSelection(f, [{ t: 'item', id: 'i1' }, { t: 'note', id: 'n1' }])!;
    const dx = f.items[0].x - f.notes[0].x;
    pasteObjects(f, c, { x: 0, y: 0 });
    expect(f.items[1].x - f.notes[1].x).toBe(dx);
  });

  it('gives a copied wall’s openings fresh ids of their own', () => {
    const f = fixture();
    const c = clipOfSelection(f, sel('wall', 'w1'))!;
    pasteObjects(f, c);
    const copy = f.walls[2];
    expect(copy.id).not.toBe('w1');
    expect(copy.openings).toHaveLength(1);
    expect(copy.openings[0].id).not.toBe('o1');
    expect(copy.openings[0].at).toBe(0.25);
  });

  it('steps a duplicated opening along its own wall', () => {
    const f = fixture();
    const c = clipOfSelection(f, sel('opening', 'o1'))!;
    const r = pasteObjects(f, c);
    const ops = f.walls[0].openings;
    expect(ops).toHaveLength(2);
    expect(ops[1].id).not.toBe('o1');
    expect(ops[1].at).toBeGreaterThan(ops[0].at);
    /* fully inside the wall, both of them */
    ops.forEach(o => {
      expect(o.at).toBeGreaterThanOrEqual(o.width / 2 / 400);
      expect(o.at).toBeLessThanOrEqual(1 - o.width / 2 / 400);
    });
    expect(r.skipped).toBe(0);
  });

  it('puts an opening into the wall the pointer is on', () => {
    const f = fixture();
    const c = clipOfSelection(f, sel('opening', 'o1'))!;
    pasteObjects(f, c, { x: 300, y: 302 });          // hard against w2
    expect(f.walls[0].openings).toHaveLength(1);
    expect(f.walls[1].openings).toHaveLength(1);
    expect(f.walls[1].openings[0].at).toBeCloseTo(0.75, 2);
  });

  it('narrows an opening that will not fit its new wall', () => {
    const f = fixture();
    f.walls[1].b = { x: 100, y: 300 };               // a 1 m wall
    const c = clipOfSelection(f, sel('opening', 'o1'))!;
    pasteObjects(f, c, { x: 50, y: 300 });
    expect(f.walls[1].openings[0].width).toBe(90);
    f.walls[1].b = { x: 60, y: 300 };                // 60 cm — the 90 cm door cannot fit
    pasteObjects(f, c, { x: 30, y: 300 });
    expect(f.walls[1].openings[1].width).toBe(50);
  });

  it('reports an opening with no wall to sit in', () => {
    const f = fixture();
    const c = clipOfSelection(f, sel('opening', 'o1'))!;
    const empty = newFloor('Empty', 1);
    const r = pasteObjects(empty, c);
    expect(r.sel).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it('pastes into a different floor, which is the point of the clipboard', () => {
    const f = fixture();
    const text = clipText(clipOfSelection(f, sel('area', 'a1'))!);
    const other = newFloor('Upstairs', 1);
    const c = parseClip(text);
    expect(c?.kind).toBe('objects');
    pasteObjects(other, c as ClipObjects);
    expect(other.areas).toHaveLength(1);
    expect(other.areas[0].name).toBe('Woonkamer');
    expect(other.areas[0].id).not.toBe('a1');
  });
});

describe('copying a floor', () => {
  it('renews every id and keeps everything else', () => {
    const f = fixture();
    f.fmlDesignId = 4711;
    const copy = cloneFloor(f, 'Ground floor copy');
    expect(copy.id).not.toBe(f.id);
    expect(copy.walls[0].id).not.toBe('w1');
    expect(copy.walls[0].openings[0].id).not.toBe('o1');
    expect(copy.areas[0].id).not.toBe('a1');
    expect(copy.items[0].id).not.toBe('i1');
    expect(copy.notes[0].id).not.toBe('n1');
    expect(copy.dims[0].id).not.toBe('d1');
    expect(copy.lines[0].id).not.toBe('l1');
    /* the drawing itself is untouched */
    expect(copy.walls[0].a).toEqual(f.walls[0].a);
    expect(copy.areas[0].name).toBe('Woonkamer');
    /* and it no longer claims to be the imported design */
    expect(copy.fmlDesignId).toBeUndefined();
    expect(f.fmlDesignId).toBe(4711);
  });

  it('shares nothing with the original', () => {
    const f = fixture();
    const copy = cloneFloor(f, 'x');
    copy.walls[0].a.x = 999;
    expect(f.walls[0].a.x).toBe(0);
  });

  it('rides the clipboard as a floor, not as loose objects', () => {
    const c = parseClip(clipText(clipOfFloor(fixture())))!;
    expect(c.kind).toBe('floor');
    expect(clipCount(c)).toBe(1);
  });

  it('names a copy once, however many times it is copied', () => {
    expect(copyName('Ground floor', [])).toBe('Ground floor copy');
    expect(copyName('Ground floor', ['Ground floor copy'])).toBe('Ground floor copy 2');
    expect(copyName('Ground floor copy', ['Ground floor copy'])).toBe('Ground floor copy 2');
    expect(copyName('Ground floor copy 2', ['Ground floor copy'])).toBe('Ground floor copy 2');
    expect(copyName('', [])).toBe('Floor copy');
  });

  it('lands directly above its original and pushes the rest up', () => {
    const p = blankProject('x', false);
    p.floors.push(newFloor('First', 1), newFloor('Attic', 2));
    const at = insertFloor(p.floors, cloneFloor(p.floors[0], 'Ground copy'), 0);
    expect(at).toBe(1);
    expect(p.floors.map(f => f.name)).toEqual(['Ground floor', 'Ground copy', 'First', 'Attic']);
    expect(p.floors.map(f => f.level)).toEqual([0, 1, 2, 3]);
  });
});
