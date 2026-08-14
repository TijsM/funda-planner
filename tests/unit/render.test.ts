import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATALOG, CAT_BY_KIND, blankProject, fmlToProject, handlesFor, parseFundaSource, pointInPoly,
  resolveSel,
} from '@engine/index';
import { paint } from '@engine/render';
import type { Fml } from '@engine/io/funda';
import type { Draft, Layers, Pt, View } from '@engine/types';

/** A canvas that records nothing but refuses non-finite arguments. NaN in a
 *  path silently draws nothing in a real browser, which is exactly the class
 *  of bug that is invisible until someone screenshots it. */
function recordingCtx() {
  const calls: Record<string, number> = {};
  const NOOP = [
    'beginPath', 'moveTo', 'lineTo', 'closePath', 'stroke', 'fill', 'arc', 'ellipse', 'rect',
    'strokeRect', 'fillRect', 'clearRect', 'save', 'restore', 'translate', 'rotate', 'scale',
    'setTransform', 'transform', 'clip', 'quadraticCurveTo', 'bezierCurveTo', 'setLineDash',
    'fillText', 'strokeText', 'drawImage', 'arcTo',
  ];
  const o: Record<string, unknown> = {};
  for (const m of NOOP) {
    o[m] = (...args: unknown[]) => {
      calls[m] = (calls[m] || 0) + 1;
      for (const v of args) {
        if (typeof v === 'number' && !Number.isFinite(v)) {
          throw new Error(`${m}() received a non-finite argument: ${args.join(', ')}`);
        }
      }
    };
  }
  o.createRadialGradient = () => ({ addColorStop() {} });
  o.createLinearGradient = () => ({ addColorStop() {} });
  o.measureText = () => ({ width: 40 });
  o.getLineDash = () => [];
  return { ctx: new Proxy(o, { get: (t, k) => (k in t ? t[k as string] : undefined), set: () => true }), calls };
}

const FIX = path.join(__dirname, '..', 'fixtures');
const fml = JSON.parse(fs.readFileSync(path.join(FIX, 'floorplanner-project.fml'), 'utf8')) as Fml;
const listing = fs.readFileSync(path.join(FIX, 'funda-listing.html'), 'utf8');
const LAYERS: Layers = { rooms: true, areas: true, furn: true, dims: true, notes: true };
const VIEW: View = { zoom: 0.25, px: 60, py: 60 };

describe('paint', () => {
  const project = fmlToProject(fml, parseFundaSource(listing));

  it('draws every imported floor, live and flat, without NaN', () => {
    for (const floor of project.floors) {
      for (const live of [true, false]) {
        const { ctx } = recordingCtx();
        const sel = resolveSel(floor, [
          ...(floor.walls[0] ? [{ t: 'wall' as const, id: floor.walls[0].id }] : []),
          ...(floor.areas[0] ? [{ t: 'area' as const, id: floor.areas[0].id }] : []),
          ...(floor.items[0] ? [{ t: 'item' as const, id: floor.items[0].id }] : []),
        ]);
        expect(() => paint(ctx as never, {
          floor, view: VIEW, width: 1200, height: 800, layers: LAYERS, live,
          selection: sel, handles: handlesFor(sel, VIEW),
        })).not.toThrow();
      }
    }
  });

  it('draws every draft state', () => {
    const floor = project.floors[1];
    const drafts: Draft[] = [
      { kind: 'wall', pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }], t: 10, cur: { x: 200, y: 50 } },
      { kind: 'room', pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], cur: { x: 0, y: 100 } },
      { kind: 'measure', a: { x: 0, y: 0 }, cur: { x: 300, y: 400 } },
      { kind: 'cal', a: { x: 0, y: 0 }, b: { x: 200, y: 0 } },
    ];
    for (const draft of drafts) {
      const { ctx } = recordingCtx();
      expect(() => paint(ctx as never, {
        floor, view: VIEW, width: 1200, height: 800, layers: LAYERS, live: true, draft,
        marquee: { x0: 1, y0: 1, x1: 99, y1: 99 }, snapHint: { x: 10, y: 10 },
        place: { kind: 'sofa3', x: 50, y: 50 },
      })).not.toThrow();
    }
  });

  it('actually puts marks on the canvas', () => {
    const { ctx, calls } = recordingCtx();
    paint(ctx as never, { floor: project.floors[1], view: VIEW, width: 1200, height: 800, layers: LAYERS });
    expect(calls.stroke + calls.fill).toBeGreaterThan(100);
  });

  it('honours the layer switches', () => {
    const floor = project.floors[1];
    const all = recordingCtx();
    paint(all.ctx as never, { floor, view: VIEW, width: 1200, height: 800, layers: LAYERS });
    const none = recordingCtx();
    paint(none.ctx as never, {
      floor, view: VIEW, width: 1200, height: 800,
      layers: { rooms: false, areas: false, furn: false, dims: false, notes: false },
    });
    expect(none.calls.fill).toBeLessThan(all.calls.fill);
  });
});

describe('print measurements', () => {
  const project = fmlToProject(fml, parseFundaSource(listing));
  const floor = project.floors[1];
  const base = { floor, view: VIEW, width: 1200, height: 800, layers: LAYERS } as const;

  it('adds dimension chains and room sizes without NaN', () => {
    const off = recordingCtx();
    paint(off.ctx as never, base);
    const on = recordingCtx();
    expect(() => paint(on.ctx as never, { ...base, measures: true })).not.toThrow();
    /* two chains with witness lines and ticks, plus a size row per named room */
    expect(on.calls.fillText).toBeGreaterThan(off.calls.fillText);
    expect(on.calls.stroke).toBeGreaterThan(off.calls.stroke);

  });

  /* Counted exactly, on a floor with no labels of its own: two chain captions
     plus the scale bar — which a flat export never used to get at all, because
     paint() returns early when live is false, before the bar at the bottom. */
  it('adds exactly two captions and a scale bar', () => {
    const bare = { ...floor, areas: [], items: [], notes: [], dims: [], lines: [] };
    const off = recordingCtx();
    paint(off.ctx as never, { ...base, floor: bare });
    expect(off.calls.fillText ?? 0).toBe(0);

    const on = recordingCtx();
    paint(on.ctx as never, { ...base, floor: bare, measures: true });
    expect(on.calls.fillText).toBe(3);
    /* the two chain captions are haloed so they read over the plan; the bar,
       sitting in the margin, is not */
    expect(on.calls.strokeText).toBe(2);
  });

  it('survives a floor with nothing to measure', () => {
    const empty = { ...floor, walls: [], areas: [], items: [], notes: [], dims: [], lines: [] };
    const { ctx } = recordingCtx();
    expect(() => paint(ctx as never, { ...base, floor: empty, measures: true })).not.toThrow();
  });

  /* The prompt tells the model the reference carries no lettering. It has to be
     true: a label in the conditioning image bleeds through into the render. */
  it('the generator reference contains no text whatsoever', () => {
    const { ctx, calls } = recordingCtx();
    paint(ctx as never, {
      ...base,
      layers: { rooms: true, areas: false, furn: true, dims: false, notes: false },
      floor: { ...floor, notes: [] },
      roomLabels: false,
      objectLabels: false,
    });
    expect(calls.fillText ?? 0).toBe(0);
    expect(calls.strokeText ?? 0).toBe(0);
    expect(calls.fill).toBeGreaterThan(20);          // it did draw the plan
  });

  it('object labels are on by default, so the print keeps them', () => {
    const { calls } = (() => {
      const r = recordingCtx();
      paint(r.ctx as never, { ...base, roomLabels: false });
      return r;
    })();
    expect(calls.fillText).toBeGreaterThan(0);
  });
});

describe('annotation scales with the output resolution', () => {
  const project = fmlToProject(fml, parseFundaSource(listing));
  const floor = project.floors[1];
  const base = { floor, view: VIEW, width: 1200, height: 800, layers: LAYERS } as const;

  /** records what was written and where, plus the font in force at the time */
  function textCtx() {
    const out: { text: string; x: number; y: number; px: number }[] = [];
    let px = 0;
    const o: Record<string, unknown> = {};
    for (const m of [
      'beginPath', 'moveTo', 'lineTo', 'closePath', 'stroke', 'fill', 'arc', 'ellipse', 'rect',
      'strokeRect', 'fillRect', 'save', 'restore', 'translate', 'rotate', 'scale', 'setTransform',
      'clip', 'quadraticCurveTo', 'setLineDash', 'drawImage', 'strokeText',
    ]) o[m] = () => {};
    o.fillText = (text: string, x: number, y: number) => out.push({ text, x, y, px });
    o.measureText = () => ({ width: 40 });
    o.getLineDash = () => [];
    o.createRadialGradient = () => ({ addColorStop() {} });
    const ctx = new Proxy(o, {
      get: (t, k) => (k in t ? t[k as string] : undefined),
      set: (_t, k, v) => {
        if (k === 'font') px = parseFloat(String(v).match(/(\d+(?:\.\d+)?)px/)?.[1] ?? '0');
        return true;
      },
    });
    return { ctx, out };
  }

  it('multiplies the font size actually set', () => {
    const one = textCtx();
    paint(one.ctx as never, { ...base, measures: true });
    const three = textCtx();
    paint(three.ctx as never, { ...base, measures: true, textScale: 3 });

    const biggest = (r: typeof one.out) => Math.max(...r.map(t => t.px));
    expect(biggest(three.out)).toBeCloseTo(biggest(one.out) * 3, 1);
  });

  /* Twice now the stack has collided: the pitch was in screen pixels while the
     text was drawn at size × scale. One room, so every captured row belongs to
     the same stack and the gaps mean what they look like. */
  it('never stacks a room label on top of itself', () => {
    const solo = blankProject('x', false).floors[0];
    solo.areas[0].name = 'Woonkamer';
    solo.items = []; solo.dims = []; solo.lines = []; solo.notes = [];
    const view: View = { zoom: 1, px: 200, py: 200 };

    for (const textScale of [1, 2, 2.75, 4, 6]) {
      const { ctx, out } = textCtx();
      paint(ctx as never, {
        floor: solo, view, width: 1400, height: 1600, layers: LAYERS,
        measures: true, textScale,
      });
      const stack = out.filter(t => /Woonkamer|m²|×/.test(t.text)).sort((a, b) => a.y - b.y);
      expect(stack.length, `scale ${textScale}`).toBe(3);
      for (let i = 1; i < stack.length; i++) {
        const gap = stack[i].y - stack[i - 1].y;
        expect(gap, `scale ${textScale}: rows ${gap.toFixed(1)}px apart`)
          .toBeGreaterThanOrEqual(Math.max(stack[i].px, stack[i - 1].px));
      }
    }
  });

  it('drops the labels a small room can no longer hold', () => {
    const one = textCtx();
    paint(one.ctx as never, { ...base, measures: true });
    const big = textCtx();
    paint(big.ctx as never, { ...base, measures: true, textScale: 4 });
    /* the 0.1 m² cupboards earn a caption at 1× and not at 4× */
    expect(big.out.length).toBeLessThan(one.out.length);
  });
});

describe('catalogue glyphs', () => {
  it('every glyph survives its own size and absurd ones', () => {
    const entries = CATALOG.flatMap(g => g.items);
    expect(entries.length).toBeGreaterThanOrEqual(120);
    for (const e of entries) {
      for (const [w, h] of [[e.w, e.h], [4, 4], [2000, 1500], [e.w, 4]] as const) {
        const { ctx } = recordingCtx();
        expect(() => e.draw(ctx as never, w, h, 0.5), `${e.kind} @ ${w}×${h}`).not.toThrow();
      }
    }
  });
});

describe('L-shaped seating', () => {
  /* Capture the first closed path a glyph builds — for these it is the outline
     itself, so the shape can be asserted rather than eyeballed. */
  function outlineOf(kind: string, size?: [number, number]) {
    const pts: Pt[] = [];
    let open = true;
    const o: Record<string, unknown> = {};
    for (const m of [
      'beginPath', 'stroke', 'fill', 'arc', 'save', 'restore', 'setLineDash', 'quadraticCurveTo',
      'translate', 'scale', 'rotate', 'fillText', 'rect',
    ]) o[m] = () => {};
    o.moveTo = (x: number, y: number) => { if (open) pts.push({ x, y }); };
    o.lineTo = (x: number, y: number) => { if (open) pts.push({ x, y }); };
    o.closePath = () => { open = false; };
    o.measureText = () => ({ width: 40 });
    const c = CAT_BY_KIND[kind];
    const e = { ...c, w: size ? size[0] : c.w, h: size ? size[1] : c.h };
    e.draw(o as never, e.w, e.h, 0.5);
    return { pts, e };
  }

  /** the deepest point of the notch — dead centre of the open corner */
  const notch = (e: { w: number; h: number }) => ({ x: e.w * .3, y: e.h * .3 });

  for (const kind of ['sofaL', 'sofaChaise']) {
    it(`${kind} leaves the far corner as open floor`, () => {
      const { pts, e } = outlineOf(kind);
      expect(pts).toHaveLength(6);                       // an L, not a rectangle
      expect(pointInPoly(notch(e), pts)).toBe(false);
      /* and the two arms are solid */
      expect(pointInPoly({ x: -e.w / 2 + 20, y: -e.h / 2 + 20 }, pts)).toBe(true);
      expect(pointInPoly({ x: e.w / 2 - 20, y: -e.h / 2 + 20 }, pts)).toBe(true);
      expect(pointInPoly({ x: -e.w / 2 + 20, y: e.h / 2 - 20 }, pts)).toBe(true);
    });
  }

  /* An L whose arms meet is a rectangle. Seat depth is physical, so it has to
     yield to the footprint rather than swallow the notch. */
  it('stays an L at any size, including a square and a tiny one', () => {
    for (const [w, h] of [[265, 200], [200, 200], [150, 150], [100, 100], [80, 80], [400, 150]]) {
      const { pts, e } = outlineOf('sofaL', [w, h]);
      const at = `${w}×${h}`;
      expect(pointInPoly(notch(e), pts), `${at} lost its notch`).toBe(false);
      /* the notch is a real area, not a sliver — measured off the inner corner,
         which the outline puts at index 3 */
      const inner = pts[3];
      expect((w / 2 - inner.x) / w, at).toBeGreaterThan(.4);
      expect((h / 2 - inner.y) / h, at).toBeGreaterThan(.4);
    }
  });

  it('a straight sofa fills its whole footprint, which is the contrast', () => {
    const { pts, e } = outlineOf('sofa3');
    expect(pointInPoly(notch(e), pts)).toBe(true);
  });

  it('is findable by the words a person would actually type', () => {
    /* the same match the tray and the Pro catalogue run */
    const hit = (q: string) => CATALOG.flatMap(g => g.items)
      .filter(i => [i.name, i.group, i.alt ?? ''].some(s => s.toLowerCase().includes(q)))
      .map(i => i.kind);

    expect(hit('l-shape')).toEqual(expect.arrayContaining(['sofaL', 'sofaChaise']));
    expect(hit('hoekbank')).toContain('sofaL');
    expect(hit('corner')).toContain('sofaL');
    expect(hit('sectional')).toContain('sofaL');
    expect(hit('chaise')).toEqual(['sofaChaise']);
    expect(hit('fauteuil')).toContain('armchair');
    /* an alias is a search key only — it must never reach the tile */
    expect(CAT_BY_KIND.sofaL.name).toBe('L-shaped sofa');
    expect(CATALOG.flatMap(g => g.items).every(i => !i.name.includes('hoekbank'))).toBe(true);
  });
});

describe('the blank starters render', () => {
  for (const garden of [false, true]) {
    it(garden ? 'garden' : 'plan', () => {
      const p = blankProject('x', garden);
      const { ctx, calls } = recordingCtx();
      paint(ctx as never, { floor: p.floors[0], view: VIEW, width: 900, height: 700, layers: LAYERS, live: true });
      expect(calls.fill).toBeGreaterThan(3);
    });
  }
});
