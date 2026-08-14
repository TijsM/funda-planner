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
  function outlineOf(kind: string) {
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
    const e = CAT_BY_KIND[kind];
    e.draw(o as never, e.w, e.h, 0.5);
    return { pts, e };
  }

  for (const kind of ['sofaL', 'sofaChaise']) {
    it(`${kind} leaves the far corner as open floor`, () => {
      const { pts, e } = outlineOf(kind);
      expect(pts).toHaveLength(6);                       // an L, not a rectangle
      /* the notch: deep inside the corner opposite the two arms */
      expect(pointInPoly({ x: e.w / 2 - 20, y: e.h / 2 - 20 }, pts)).toBe(false);
      /* and the two arms are solid */
      expect(pointInPoly({ x: -e.w / 2 + 20, y: -e.h / 2 + 20 }, pts)).toBe(true);
      expect(pointInPoly({ x: e.w / 2 - 20, y: -e.h / 2 + 20 }, pts)).toBe(true);
      expect(pointInPoly({ x: -e.w / 2 + 20, y: e.h / 2 - 20 }, pts)).toBe(true);
    });
  }

  it('a straight sofa fills its whole footprint, which is the contrast', () => {
    const { pts, e } = outlineOf('sofa3');
    expect(pointInPoly({ x: e.w / 2 - 20, y: e.h / 2 - 20 }, pts)).toBe(true);
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
