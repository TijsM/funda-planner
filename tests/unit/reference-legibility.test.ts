import { describe, expect, it } from 'vitest';
import {
  blankProject, briefObjects, buildPrompt, drawnBBox, makeItem, objectName, planFrame, setLabel,
} from '@engine/index';
import type { Floor, Item, PhotoRef } from '@engine/types';

/** What the conditioning image may and may not say.
 *
 *  Every rule here was learned from a render that went wrong, and the two
 *  failures were opposite ends of the same mistake. The object captions came
 *  first: sized off the drawing at 11 px whatever the canvas, which is 0.7% of
 *  an 1800 px reference and about a pixel and a half after a model's 8×
 *  downsample. The objects that failed were exactly the ones whose identity
 *  lived only in that lettering — a fireplace came back as a cabinet, two oak
 *  vitrines as a white bookcase.
 *
 *  So they were replaced with numbered discs at 2% of the image, legible by
 *  construction. The next render came back with nine black roundels painted onto
 *  the floor. There is no size at which our annotation is read as annotation: the
 *  picture is the thing being copied, and everything on it is geometry. Identity
 *  moved into the brief's words, where being wrong costs nothing, and the
 *  conditioning image is now glyph-free by rule. */

const REFERENCE_PX = 1800;
const photo = (id: string): PhotoRef => ({ id, w: 1024, h: 768, bytes: 1000, addedAt: 1 });

describe('the conditioning image carries no writing', () => {
  /** The app's own reference options, as `referenceOpts` builds them — asserted
   *  here against the painter directly so this test does not need a DOM. */
  async function ink(f: Floor): Promise<number> {
    const { createCanvas } = await import('@napi-rs/canvas');
    const { paint } = await import('@engine/render');
    const frame = planFrame(f, { clean: true, maxPx: 1200 })!;
    const cv = createCanvas(frame.width, frame.height);
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    paint(g as unknown as CanvasRenderingContext2D, {
      floor: f, view: frame.view, width: frame.width, height: frame.height,
      layers: { rooms: true, areas: false, furn: true, dims: false, notes: false },
      grid: false, roomLabels: false, measures: false,
      objectLabels: false, hatchFixtures: false,
    });
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) n++;
    return n;
  }

  it('draws not one dark mark more when every object is named', () => {
    const p = blankProject('naming', false);
    const f = p.floors[0];
    const a = makeItem('sofa3', { x: 300, y: 300 });
    const b = makeItem('dt6', { x: 500, y: 700 });
    f.items.push(a, b);

    return ink(f).then(async before => {
      setLabel(a, 'Oude eiken vitrinekast, 208 hoog');
      setLabel(b, 'Eettafel met kuipstoeltjes');
      f.areas[0].name = 'Woonkamer met open keuken';
      /* Exactly equal, not merely close. A name that reaches the picture at all
         is a name the model will draw, and this is the assertion that catches a
         caption creeping back in behind a default. */
      expect(await ink(f)).toBe(before);
    });
  });
});

describe('the OBJECTS table, which is where identity lives now', () => {
  function flat(): Floor {
    const p = blankProject('numbered', false);
    const f = p.floors[0];
    f.areas[0].name = 'Living room';
    f.areas[0].poly = [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 1000 }, { x: 0, y: 1000 }];
    return f;
  }

  it('lists objects in the order a person reads a plan out loud', () => {
    const f = flat();
    const sofa = makeItem('sofa3', { x: 400, y: 800 });
    const table = makeItem('dt6', { x: 400, y: 300 });
    f.items.push(sofa, table);

    const listed = briefObjects(f, { furniture: true });
    /* top-to-bottom: the table is nearer the top of the plan, so it is read first */
    expect(listed.map(o => o.item.id)).toEqual([table.id, sofa.id]);

    const out = buildPrompt(f, { view: 'top', furniture: true, dimensions: false });
    const rows = out.split('\n').filter(l => /^Living room \| (dining|three)/.test(l));
    expect(rows[0]).toContain('dining table with six chairs');
    expect(rows[1]).toContain('three-seat sofa');
  });

  it('lists nothing when the furniture is not listed', () => {
    const f = flat();
    f.items.push(makeItem('sofa3', { x: 400, y: 800 }));
    expect(briefObjects(f, { furniture: false })).toEqual([]);
  });

  /* An object with a photograph has to be in the table, or the sentence naming
     that photograph points at a row that does not exist. This is how a kitchen
     photo came to be described as "object, kitchen" and then ignored. */
  it('lists an unnamed fitted block once it carries a photograph', () => {
    const f = flat();
    const fitted: Item = {
      id: 'kitchen-run', kind: 'fixture', x: 400, y: 100, w: 300, h: 60, rot: 0,
      fromFunda: 1, noLabel: 1,
    };
    f.items.push(fitted);
    expect(briefObjects(f, { furniture: true })).toEqual([]);

    fitted.photos = [photo('p1')];
    const listed = briefObjects(f, { furniture: true });
    expect(listed.map(o => o.item.id)).toEqual(['kitchen-run']);
    expect(objectName(listed[0].item)).toBe('fitted unit');
  });

  it('never calls anything "object"', () => {
    const bare: Item = { id: 'x', kind: 'fixture', x: 0, y: 0, w: 50, h: 50, rot: 0, noLabel: 1 };
    expect(objectName(bare)).toBe('unnamed object');
    bare.fromFunda = 1;
    expect(objectName(bare)).toBe('fitted unit');
    const named = makeItem('sofa3', { x: 0, y: 0 });
    setLabel(named, 'Bank van oma');
    expect(objectName(named)).toBe('bank van oma');
  });

  /* The whole replacement for the annotation, in one assertion: the sentence
     that names a photograph and the row that describes the object have to point
     at the same block in the same words, because words are all there is. */
  it('addresses a photographed object the same way its row does', () => {
    const f = flat();
    const table = makeItem('dt6', { x: 400, y: 300 });
    const sofa = makeItem('sofa3', { x: 400, y: 800 });
    sofa.photos = [photo('p1')];
    f.items.push(table, sofa);

    const out = buildPrompt(f, {
      view: 'top', furniture: true, dimensions: false,
      photos: [{ objId: sofa.id, label: 'three-seat sofa', room: 'Living room' }],
    });
    const line = out.split('\n').find(l => l.startsWith('Image 2:'))!;
    const where = line.replace(/^Image 2: three-seat sofa, living room, /, '').replace(/\.$/, '');
    expect(where).toBeTruthy();
    expect(where).not.toContain('Image');
    /* and the same phrase is the row's Where cell */
    const row = out.split('\n').find(l => l.includes('| three-seat sofa |'))!;
    expect(row).toContain(`| ${where} |`);
  });
});

describe('what the reference is framed to', () => {
  /* The render came back with a title block and dimension chains drawn down both
     sides, and with the building at 1:1.38 where the plan is 1:1.81. Both are
     the same cause: a metre of blank paper either side of the plan, because the
     frame bounded every object by the circle it would sweep if it spun. */
  it('leaves no blank band for the model to fill', () => {
    const p = blankProject('framing', false);
    const f = p.floors[0];
    /* the shell is 800 × 1000; a 265 cm run stands against the east wall */
    const run = makeItem('sofa3', { x: 760, y: 500 });
    run.w = 80; run.h = 265;
    f.items.push(run);

    const b = drawnBBox(f)!;
    expect(b.x1 - b.x0).toBe(800);
    const frame = planFrame(f, { clean: true, maxPx: REFERENCE_PX })!;
    /* the picture is the building plus the 40 cm margin on each side, and the
       plan's own aspect survives to the pixel */
    expect(frame.width / frame.height).toBeCloseTo(880 / 1080, 2);
  });
});
