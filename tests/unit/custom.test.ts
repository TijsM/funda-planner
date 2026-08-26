import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import {
  CUSTOM_PREFIX, SHAPE_PRESETS, blankProject, drawShape, drawablePoly, fitPoly, heightOf, heightOfItem,
  isCustomKind, labelOf, makeCustomItem, makeItem, newShape, normalisePoly, parseProject,
  serializeProject, setLabel, shapesOf,
} from '@engine/index';
import { paint } from '@engine/render';
import { paintPass } from '@engine/passes';
import { planFrame } from '@engine/frame';
import type { Item, Pt, Shape } from '@engine/types';

const BIN: Pt[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

const shape = (o: Partial<Parameters<typeof newShape>[0]> = {}): Shape =>
  newShape({ name: 'Kliko', w: 60, h: 80, poly: BIN, z: 110, ...o });

describe('a shape someone drew for themselves', () => {
  it('is namespaced so it can never be mistaken for a catalogue kind', () => {
    const s = shape();
    expect(s.id.startsWith(CUSTOM_PREFIX)).toBe(true);
    expect(isCustomKind(s.id)).toBe(true);
    expect(isCustomKind('sofa3')).toBe(false);
    /* and two shapes drawn in the same breath are still two shapes */
    expect(shape().id).not.toBe(shape().id);
  });

  it('rounds the footprint and keeps a height it was given', () => {
    const s = shape({ w: 59.6, h: 80.2, z: 110.4 });
    expect([s.w, s.h, s.z]).toEqual([60, 80, 110]);
  });

  /* A drawing surface hands back whatever the pointer did. Two points on top of
     each other draw a spur that is invisible at 300 px and obvious on a print. */
  it('cleans up what a pointer actually produces', () => {
    const messy = [
      { x: -0.2, y: 0.5 },                     // dragged off the edge
      { x: 0.5, y: 1.4 },
      { x: 0.5, y: 1.4 },                      // a double click
      { x: 1, y: 0 },
      { x: 0, y: 0.5 },                        // closing point, implied by the path
    ];
    expect(normalisePoly([...messy, { x: 0, y: 0.5 }])).toEqual([
      { x: 0, y: 0.5 }, { x: 0.5, y: 1 }, { x: 1, y: 0 },
    ]);
  });

  it('crops unused canvas so the unit square is the drawing, not the viewBox', () => {
    const inset = [
      { x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }, { x: 0.8, y: 0.7 }, { x: 0.2, y: 0.7 },
    ];
    expect(fitPoly(inset)).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
    ]);
    /* already tight: a rectangle preset, an L that already touches every edge */
    expect(fitPoly(BIN)).toEqual(BIN);
    const ell = SHAPE_PRESETS.find(p => p.id === 'ell')!.poly!;
    expect(fitPoly(ell)).toEqual(ell);
    /* and doing it twice is the same as doing it once */
    expect(fitPoly(fitPoly(inset))).toEqual(fitPoly(inset));
  });

  it('refuses to make an outline out of two points', () => {
    expect(drawablePoly([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(false);
    /* and a shape built from one keeps no poly at all, so the renderer falls
       through to the ellipse rather than filling a hairline */
    expect(newShape({ name: 'x', w: 10, h: 10, poly: [{ x: 0, y: 0 }] }).poly).toBeUndefined();
  });

  it('says round with a flag rather than with forty points', () => {
    const s = newShape({ name: 'Bin', w: 40, h: 40, round: 1, poly: BIN });
    expect(s.round).toBe(1);
    expect(s.poly).toBeUndefined();
  });

  it('ships presets that are all drawable', () => {
    for (const p of SHAPE_PRESETS) {
      expect(p.round === 1 || drawablePoly(p.poly), p.name).toBe(true);
      /* unit space, or the same drawing means something different at every size */
      for (const q of p.poly ?? []) {
        expect(q.x, p.name).toBeGreaterThanOrEqual(0);
        expect(q.x, p.name).toBeLessThanOrEqual(1);
        expect(q.y, p.name).toBeGreaterThanOrEqual(0);
        expect(q.y, p.name).toBeLessThanOrEqual(1);
      }
    }
  });

  it('offers the tray the newest drawing first', () => {
    const a = shape({ name: 'A' }), b = shape({ name: 'B' });
    expect(shapesOf([a, b]).map(s => s.name)).toEqual(['B', 'A']);
    expect(shapesOf(undefined)).toEqual([]);
  });
});

describe('placing one', () => {
  it('takes the drawing with it, so nothing has to be looked up later', () => {
    const s = shape();
    const i = makeCustomItem(s, { x: 100, y: 200 });
    expect(i.kind).toBe(s.id);
    expect([i.w, i.h]).toEqual([60, 80]);
    expect(i.shape).toEqual(s);
    /* a copy, not the same object: editing the tray must not reshape what is
       already on the floor */
    expect(i.shape).not.toBe(s);
  });

  it('is named by its own drawing, because there is no catalogue row to fall back to', () => {
    const i = makeCustomItem(shape(), { x: 0, y: 0 });
    expect(labelOf(i)).toBe('Kliko');
    /* and a cleared label still means "show nothing" */
    setLabel(i, '');
    expect(labelOf(i)).toBe('');
  });

  /* The depth control map is conditioned on height, and a custom kind has no row
     in the height table — so without this it would come back as the waist-height
     default and a 2 m cupboard would read as a desk. */
  it('carries its own height into the depth map', () => {
    const i = makeCustomItem(shape({ z: 200 }), { x: 0, y: 0 });
    expect(heightOfItem(i)).toBe(200);
    expect(heightOf(i.kind)).toBe(75);                 // what the table can say
    /* a catalogue object still answers from the table */
    expect(heightOfItem(makeItem('wardr', { x: 0, y: 0 }))).toBe(heightOf('wardr'));
    /* and a shape drawn without a height falls back rather than reading as zero */
    const flat = makeCustomItem(newShape({ name: 'n', w: 10, h: 10, poly: BIN }), { x: 0, y: 0 });
    expect(heightOfItem(flat)).toBe(75);
  });

  it('survives a save and reload, drawing and all', () => {
    const p = blankProject('x', false);
    const s = shape();
    p.shapes = [s];
    p.floors[0].items.push(makeCustomItem(s, { x: 300, y: 300 }));

    const back = parseProject(serializeProject(p));
    expect(back.shapes?.[0]).toEqual(s);
    const item = back.floors[0].items.find(i => isCustomKind(i.kind))!;
    expect(item.shape?.poly).toEqual(s.poly);
    expect(labelOf(item)).toBe('Kliko');
  });
});

describe('drawing one', () => {
  /** what fraction of a canvas the shape actually covered */
  function inked(s: Shape, w = 200, h = 200): number {
    const cv = createCanvas(w, h);
    const g = cv.getContext('2d');
    g.translate(w / 2, h / 2);
    g.fillStyle = '#000'; g.strokeStyle = '#000';
    drawShape(g as never, s, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n / (w * h);
  }

  it('fills its whole footprint when it is a rectangle', () => {
    const rect = newShape({ name: 'r', w: 100, h: 100, poly: BIN });
    expect(inked(rect)).toBeGreaterThan(0.97);
  });

  /* A treadmill drawn in the middle of a square canvas used to land as a small
     block inside a large selection — the canvas was the footprint. The unused
     margin is not the object. */
  it('fills the footprint even when the drawing sat inside a larger canvas', () => {
    const inset = [
      { x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }, { x: 0.8, y: 0.7 }, { x: 0.2, y: 0.7 },
    ];
    const s = newShape({ name: 'treadmill', w: 205, h: 90, poly: inset });
    expect(s.poly).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
    ]);
    expect([s.w, s.h]).toEqual([205, 90]);
    expect(inked(s)).toBeGreaterThan(0.97);
    /* an older save that still carries the viewBox draws the same way */
    const old: Shape = { id: 'x:old', name: 't', w: 100, h: 100, poly: inset };
    expect(inked(old)).toBeGreaterThan(0.97);
  });

  /* An L is the case a bounding box cannot state: the notch is the shape. */
  it('leaves the notch of an L-shape empty', () => {
    const ell = newShape({ name: 'l', w: 100, h: 100, poly: SHAPE_PRESETS.find(p => p.id === 'ell')!.poly });
    const cover = inked(ell);
    expect(cover).toBeGreaterThan(0.55);
    expect(cover).toBeLessThan(0.78);
  });

  it('draws an ellipse for a round one, not a square', () => {
    const round = newShape({ name: 'o', w: 100, h: 100, round: 1 });
    /* π/4 of the box, give or take the stroke */
    expect(inked(round)).toBeGreaterThan(0.74);
    expect(inked(round)).toBeLessThan(0.84);
  });

  it('scales one drawing to any footprint', () => {
    const s = newShape({ name: 's', w: 40, h: 200, poly: BIN });
    /* the unit square fills whatever box it is handed, which is the whole point
       of authoring in unit space */
    expect(inked(s, 60, 300)).toBeGreaterThan(0.97);
  });

  it('never throws on a shape a person could actually save', () => {
    const cv = createCanvas(40, 40);
    const g = cv.getContext('2d');
    for (const p of SHAPE_PRESETS) {
      const s = newShape({ name: p.name, w: 1, h: 2000, poly: p.poly, round: p.round });
      expect(() => drawShape(g as never, s, s.w, s.h), p.name).not.toThrow();
    }
  });
});

describe('a drawn object on the plan', () => {
  const planWith = (i: Item) => {
    const p = blankProject('x', false);
    p.floors[0].items.push(i);
    return p.floors[0];
  };

  /* The renderer's fallback for a kind it does not know is a plain block. That is
     right for an anonymous imported footprint and wrong for something a person
     drew: an L-shaped counter would come back as a rectangle in every export. */
  it('is drawn as its outline, not as its bounding box', () => {
    const ell = newShape({ name: 'Counter', w: 300, h: 300, poly: SHAPE_PRESETS.find(p => p.id === 'ell')!.poly });
    const f = planWith(makeCustomItem(ell, { x: 400, y: 400 }));
    const fr = planFrame(f, { clean: true, maxPx: 500 })!;

    const cv = createCanvas(fr.width, fr.height);
    const g = cv.getContext('2d');
    paint(g as never, {
      floor: f, view: fr.view, width: fr.width, height: fr.height, dpr: 1,
      layers: { rooms: true, areas: false, furn: true, dims: false, notes: false },
      grid: false, live: false, roomLabels: false, objectLabels: false, vignette: false,
    });

    /* the notch sits at the bottom-right of the footprint in world space */
    const at = (wx: number, wy: number) => {
      const x = Math.round(wx * fr.view.zoom + fr.view.px), y = Math.round(wy * fr.view.zoom + fr.view.py);
      return g.getImageData(x, y, 1, 1).data;
    };
    const filled = at(300, 300);          // inside the L's arm
    const notch = at(490, 490);           // inside the bounding box, outside the L
    expect(filled[3]).toBeGreaterThan(8);
    expect(notch).not.toEqual(filled);
  });

  it('reaches the control maps at its own height', () => {
    const tall = newShape({ name: 'Cupboard', w: 100, h: 60, poly: BIN, z: 220 });
    const low = newShape({ name: 'Bench', w: 100, h: 60, poly: BIN, z: 45 });
    const f = planWith(makeCustomItem(tall, { x: 250, y: 400 }));
    f.items.push(makeCustomItem(low, { x: 550, y: 400 }));
    const fr = planFrame(f, { clean: true, maxPx: 400 })!;

    const cv = createCanvas(fr.width, fr.height);
    const g = cv.getContext('2d');
    paintPass(g as never, { floor: f, frame: fr, pass: 'depth' });
    const grey = (wx: number, wy: number) => g.getImageData(
      Math.round(wx * fr.view.zoom + fr.view.px), Math.round(wy * fr.view.zoom + fr.view.py), 1, 1,
    ).data[0];
    /* near is white: the taller object has to read brighter, or the one channel
       carrying the third dimension is lying about which is which */
    expect(grey(250, 400)).toBeGreaterThan(grey(550, 400));
  });
});
