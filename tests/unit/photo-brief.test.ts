import { describe, expect, it } from 'vitest';
import { blankProject, buildPrompt, headWords, makeItem, photoSubjects } from '@engine/index';
import type { Floor, Item, PhotoRef } from '@engine/types';

/** What the brief says about object photographs, and which objects the panel is
 *  offered in the first place.
 *
 *  The thing under test throughout is the NUMBERING. Every sentence here names
 *  an image by ordinal, the request fills the slots in one particular order, and
 *  a brief that calls image 3 the sofa when slot 3 holds a depth map is worse
 *  than a brief that says nothing: the model reproduces the ramp as a sofa. */

const photo = (id: string, note?: string): PhotoRef =>
  ({ id, w: 1024, h: 768, bytes: 180_000, addedAt: 1, ...(note ? { note } : {}) });

/** A flat with two named rooms, a sofa and a table in the big one, a bed in the
 *  small one, and a bin outside both. */
function flat(): Floor {
  const p = blankProject('Photo flat', false);
  const f = p.floors[0];
  f.areas[0].name = 'Living room';
  f.areas[0].poly = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 500 }, { x: 0, y: 500 }];
  f.areas.push({
    id: 'bed-area', name: 'Bedroom', color: '#ccc', nx: 0, ny: 0, label: true,
    poly: [{ x: 0, y: 500 }, { x: 400, y: 500 }, { x: 400, y: 900 }, { x: 0, y: 900 }],
  });
  const put = (kind: string, x: number, y: number): Item => {
    const i = makeItem(kind, { x, y });
    f.items.push(i);
    return i;
  };
  put('sofa3', 300, 200);
  put('dt6', 150, 400);
  put('bed140', 200, 700);
  put('bin', 1200, 1200);
  return f;
}

const byLabel = (f: Floor, label: string): Item =>
  f.items.find(i => (i.label ?? '').toLowerCase().includes(label))!;

describe('photoSubjects', () => {
  it('offers only objects that actually carry a photograph', () => {
    const f = flat();
    expect(photoSubjects(f)).toEqual([]);
    byLabel(f, 'sofa').photos = [photo('a')];
    expect(photoSubjects(f).map(s => s.objId)).toEqual([byLabel(f, 'sofa').id]);
  });

  it('puts the room before its contents and the bigger object first', () => {
    const f = flat();
    f.areas[0].photos = [photo('room')];
    byLabel(f, 'sofa').photos = [photo('sofa')];
    byLabel(f, 'table 6p').photos = [photo('table')];
    const subs = photoSubjects(f);
    /* the room sets the shell; a 3-seat sofa is more of the picture than a table */
    expect(subs.map(s => s.label)).toEqual(['living room', 'three-seat sofa', 'dining table with six chairs']);
    expect(subs[0].room).toBe('Living room');
  });

  it('keeps a room-scoped brief to that room', () => {
    const f = flat();
    byLabel(f, 'sofa').photos = [photo('sofa')];
    byLabel(f, 'double').photos = [photo('bed')];
    byLabel(f, 'bin').photos = [photo('bin')];
    const bedroom = f.areas.find(a => a.name === 'Bedroom')!;
    /* the item's label is the tray's "Double 140"; the brief calls it a double
       bed — see BRIEF_NAME in catalog.ts */
    expect(photoSubjects(f, bedroom.id).map(s => s.label)).toEqual(['double bed']);
    /* and the whole floor includes the one outside every room */
    expect(photoSubjects(f, '*').map(s => s.label)).toContain('wheelie bin');
  });

  /* A photo on an imported fitted block is the strongest statement of intent
     there is — far stronger than typing a name, which is all `planFacts` asks
     for. An object whose photo the panel refused to list would be inexplicable. */
  it('lists a fitted object from the listing once it has a photo', () => {
    const f = flat();
    /* Built by hand, the way `fmlToProject` builds one: a kind the catalogue has
       never heard of, no name, and `fromFunda` set. */
    const fitted: Item = {
      id: 'fitted-1', kind: 'fixture', x: 100, y: 100, w: 200, h: 60, rot: 0,
      fromFunda: 1, noLabel: 1, photos: [photo('kitchen')],
    };
    f.items.push(fitted);
    expect(photoSubjects(f).map(s => s.objId)).toContain(fitted.id);
  });

  it('carries each photo note, in the document own order', () => {
    const f = flat();
    byLabel(f, 'sofa').photos = [photo('front', 'from the front'), photo('side')];
    const [sub] = photoSubjects(f);
    expect(sub.photos).toEqual([{ id: 'front', note: 'from the front' }, { id: 'side', note: undefined }]);
  });
});

describe('the brief, with photographs attached', () => {
  const base = { view: 'top' as const, furniture: true, dimensions: true };

  const brief = (over: Partial<Parameters<typeof buildPrompt>[1]> = {}) => {
    const f = flat();
    byLabel(f, 'sofa').photos = [photo('a')];
    return buildPrompt(f, { ...base, ...over });
  };

  it('says nothing at all when no photograph is attached', () => {
    expect(brief()).not.toMatch(/photograph/i);
  });

  it('names each photograph by image number and says it is not a scene', () => {
    const out = brief({
      photos: [{ objId: 'x', label: 'sofa', room: 'Living room' }],
    });
    expect(out).toMatch(/Image 2 photographs an object already on the plan/);
    /* The clause this test exists for. Without it a render drew the photographed
       sofa twice — once at its own number and once in the largest empty space it
       could find, which happened to be where a round dining table is. A photograph
       is evidence about an object that is already placed, not a request for one. */
    expect(out).toMatch(/in the one place named below and nowhere else: never a second copy/);
    expect(out).toMatch(/Image 2: sofa, living room\./);
    expect(out).toMatch(/ignore their backgrounds and lighting/i);
  });

  /* A photograph is taken at eye level and the render is drawn from above, and
     what survives that translation is not the same in both directions. From
     above, a kitchen's form is invisible and only its colour and material can
     carry; at eye level the form is the point. The brief used to promise
     "reproduce it exactly" either way, which is how a white shaker kitchen came
     back as dark marble. */
  it('asks for what the camera can actually show', () => {
    const above = brief({ view: 'top', photos: [{ objId: 'x', label: 'sofa', room: '' }] });
    expect(above).toMatch(/Seen from above, give each object below its photograph's colour, material and finish/);
    expect(above).not.toMatch(/same design, colour, material/);

    const iso = brief({ view: 'iso', photos: [{ objId: 'x', label: 'sofa', room: '' }] });
    expect(iso).toMatch(/Seen from above/);

    const inside = brief({ view: 'eye', photos: [{ objId: 'x', label: 'sofa', room: '' }] });
    expect(inside).toMatch(/Reproduce each pictured object exactly — same design, colour, material/);
    expect(inside).not.toMatch(/Seen from above/);
  });

  it('numbers the photographs before the control maps, as the slots are filled', () => {
    const out = brief({
      photos: [
        { objId: 'x', label: 'sofa', room: 'Living room' },
        { objId: 'y', label: 'bed', room: 'Bedroom' },
      ],
      controls: ['line', 'depth'],
    });
    expect(out).toMatch(/Images 2-3 photograph objects/);
    expect(out).toMatch(/Image 2: sofa, living room\./);
    expect(out).toMatch(/Image 3: bed, bedroom\./);
    expect(out).toMatch(/Image 4 is a line drawing/);
    expect(out).toMatch(/Image 5 is a depth map/);
  });

  it('quotes the note beside the image it belongs to', () => {
    const out = brief({
      photos: [{ objId: 'x', label: 'sofa', room: '', note: 'the oak legs' }],
    });
    expect(out).toMatch(/Image 2: sofa \(the oak legs\)\./);
  });

  /* The table is what the model reads as the authority on what is in the room,
     so the row itself carries the image number — two words, and only when a
     photograph went. */
  it('adds a Photo column to the OBJECTS table, and only then', () => {
    const f = flat();
    const sofa = byLabel(f, 'sofa');
    sofa.photos = [photo('a')];
    const without = buildPrompt(f, base);
    expect(without).not.toMatch(/\| Photo \|/);

    const with_ = buildPrompt(f, {
      ...base,
      photos: [{ objId: sofa.id, label: 'sofa', room: 'Living room' }],
    });
    expect(with_).toMatch(/\| Photo \|/);
    /* the sofa's row says which image it is; the table's says nothing */
    const rows = with_.split('\n').filter(l => l.includes(' | '));
    expect(rows.find(l => l.includes('three-seat sofa'))).toMatch(/image 2/);
    expect(rows.find(l => l.includes('dining table with six chairs'))).toMatch(/\| — \|/);
  });

  /* Words at the top of the brief are the most expensive words there are — BFL
     puts the useful window at 30-80 and says attention falls off with order. A
     feature may buy itself a sentence; it may not buy a paragraph.
     
     The first photograph is dear: 34 words of shared instruction plus the
     15-word "keep the exact spatial arrangement" line it shares with the maps.
     Both are load-bearing. Without the first, a photograph of a showroom comes
     back as a showroom; without the second, the model is free to rearrange the
     plan around the object it has just been handed. Every photograph after it
     costs one clause.

     The cap moved once, from 60 to 66, and the reason is in the render that
     bought it: the model drew the photographed sofa twice — at its own number
     and again in the largest empty space, which was where a round dining table
     is. The clause that fixed it ("at the numbers below and nowhere else: never
     a second copy") is worth six words of an already-overspent block. A cap is a
     drift guard, not physics; moving it deliberately is the point of having it. */
  it('spends one sentence on the set and one short line per photograph', () => {
    const f = flat();
    const plain = headWords(buildPrompt(f, base));
    const one = headWords(buildPrompt(f, {
      ...base, photos: [{ objId: 'x', label: 'sofa', room: 'Living room' }],
    }));
    const three = headWords(buildPrompt(f, {
      ...base,
      photos: [
        { objId: 'x', label: 'sofa', room: 'Living room' },
        { objId: 'y', label: 'bed', room: 'Bedroom' },
        { objId: 'z', label: 'wheelie bin', room: '' },
      ],
    }));
    /* the first photo pays for the shared instruction as well */
    expect(one - plain).toBeLessThanOrEqual(66);
    /* every one after it is a clause, not a case */
    expect(three - one).toBeLessThanOrEqual(20);
  });
});

/* The opening block with photographs attached is past the 80 words the other
   budget test holds a plain brief to, and that is a knowing trade rather than an
   oversight — the same one the control-map comment in prompt.ts describes. What
   must not happen is drift: a paragraph creeping in one clause at a time until
   the instruction that matters is at word 200, where nothing is read. */
describe('the opening block with photographs', () => {
  it('stays inside a stated ceiling even with a full set attached', () => {
    const f = flat();
    const photos = Array.from({ length: 7 }, (_, n) => ({
      objId: `o${n}`, label: 'sofa', room: 'Living room',
    }));
    const n = headWords(buildPrompt(f, {
      view: 'top', furniture: true, dimensions: true, photos, controls: ['line', 'depth'],
    }));
    expect(n).toBeLessThanOrEqual(196);
  });
});

/* A render came back with a café table and two chairs standing in a 3.6 m²
   entrance hall. That was not the model inventing furniture — it was the brief
   asking for it, in a sentence written with empty bedrooms in mind. */
describe('an empty room', () => {
  const roomOf = (m2: number): Floor => {
    const p = blankProject('empty', false);
    const f = p.floors[0];
    const side = Math.sqrt(m2 * 10_000);
    f.areas[0].name = 'Entrance';
    f.areas[0].poly = [
      { x: 0, y: 0 }, { x: side, y: 0 }, { x: side, y: side }, { x: 0, y: side },
    ];
    return f;
  };
  const noteFor = (m2: number) => {
    const out = buildPrompt(roomOf(m2), { view: 'top', furniture: true, dimensions: false });
    return out.split('\n').find(l => l.startsWith('Entrance |')) ?? '';
  };

  it('is furnished when it is big enough to hold furniture', () => {
    expect(noteFor(14)).toContain('furnish it plausibly for its purpose');
  });

  it('is left alone when it is a hall rather than a room', () => {
    expect(noteFor(3.6)).toContain('keep the floor clear, no furniture');
    expect(noteFor(3.6)).not.toContain('furnish it');
  });
});
