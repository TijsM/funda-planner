import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATALOG, CAT_BY_KIND, blankProject, buildPrompt, contentBBox, fmlToProject, migrate,
  newProject, parseFundaSource, parseProject, planFacts, pointInPoly, polyArea, polyCentroid,
  rotPt, serializeProject, setLabel, labelOf, shellBBox, snapAngle, snapPoint, axisLock,
  fitTo, zoomAt, toScreen, toWorld, handlesFor, hitTest, resolveSel,
} from '@engine/index';
import type { Fml } from '@engine/io/funda';
import type { Item, Layers, View } from '@engine/types';

const FIX = path.join(__dirname, '..', 'fixtures');
const listing = fs.readFileSync(path.join(FIX, 'funda-listing.html'), 'utf8');
const fml = JSON.parse(fs.readFileSync(path.join(FIX, 'floorplanner-project.fml'), 'utf8')) as Fml;
const LAYERS: Layers = { rooms: true, areas: true, furn: true, dims: true, notes: true };

describe('geometry', () => {
  const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 200 }, { x: 0, y: 200 }];
  it('computes area and centroid', () => {
    expect(polyArea(sq)).toBe(20000);
    expect(polyCentroid(sq)).toEqual({ x: 50, y: 100 });
  });
  it('tests containment', () => {
    expect(pointInPoly({ x: 50, y: 50 }, sq)).toBe(true);
    expect(pointInPoly({ x: 150, y: 50 }, sq)).toBe(false);
  });
  it('rotates about the origin', () => {
    const r = rotPt(10, 0, 90);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(10);
  });
});

describe('view transform', () => {
  const v: View = { zoom: 0.5, px: 100, py: 40 };
  it('round-trips screen and world', () => {
    const w = toWorld(v, 300, 240);
    expect(toScreen(v, w.x, w.y)).toEqual({ x: 300, y: 240 });
  });
  it('keeps the cursor anchored while zooming', () => {
    const z = zoomAt(v, 300, 240, 2);
    const before = toWorld(v, 300, 240), after = toWorld(z, 300, 240);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
  it('fits a box into a viewport', () => {
    const f = fitTo({ x0: 0, y0: 0, x1: 1000, y1: 500 }, 800, 600);
    expect(f.zoom).toBeGreaterThan(0);
    const c = toScreen(f, 500, 250);
    expect(c.x).toBeCloseTo(400);
    expect(c.y).toBeCloseTo(300);
  });
});

describe('snapping', () => {
  const cfg = { on: true, grid: 5, view: { zoom: 1, px: 0, py: 0 } };
  it('rounds to the grid', () => {
    expect(snapPoint(null, { x: 12.4, y: 7.9 }, cfg)).toEqual({ x: 10, y: 10 });
  });
  it('is bypassed when off', () => {
    expect(snapPoint(null, { x: 12.4, y: 7.9 }, { ...cfg, on: false })).toEqual({ x: 12.4, y: 7.9 });
  });
  it('constrains angles to 15°', () => {
    const p = snapAngle({ x: 0, y: 0 }, { x: 100, y: 8 }, cfg);
    expect(Math.round((Math.atan2(p.y, p.x) * 180) / Math.PI) % 15).toBe(0);
  });
  it('locks to the axis from the anchor', () => {
    expect(axisLock({ x: 300, y: 40 }, { x: 0, y: 0 })).toEqual({ x: 300, y: 0 });
    expect(axisLock({ x: 40, y: 300 }, { x: 0, y: 0 })).toEqual({ x: 0, y: 300 });
  });
});

describe('funda import', () => {
  const meta = parseFundaSource(listing);

  it('recovers the project and every plan', () => {
    expect(meta.projectId).toBe(187897594);
    expect(meta.plans).toHaveLength(5);
    expect(meta.plans.map(p => p.name)).toEqual([
      'Begane GrondTuin', 'Begane Grond', 'Eerste Verdieping', 'Berging', 'Tweede Verdieping',
    ]);
  });

  it('reads the address exactly, ignoring commented-out tags', () => {
    expect(meta.address).toBe('Pieter Kleijnstraat 19 5246 GS Rosmalen');
  });

  it('converts the geometry, floor by floor', () => {
    const p = fmlToProject(fml, { ...meta, url: 'https://www.funda.nl/x' });
    expect(p.floors.map(f => f.name)).toEqual([
      'Begane Grond Tuin', 'Begane Grond', 'Eerste Verdieping', 'Tweede Verdieping', 'Berging',
    ]);
    expect(p.floors.map(f => f.walls.length)).toEqual([64, 53, 30, 25, 11]);
    expect(p.floors.map(f => f.walls.reduce((s, w) => s + w.openings.length, 0))).toEqual([14, 12, 15, 10, 2]);
    expect(p.floors.reduce((s, f) => s + f.areas.length, 0)).toBe(38);
    expect(p.source?.projectId).toBe(187897594);
    expect(p.floors[1].areas.map(a => a.name)).toEqual(expect.arrayContaining(['Woonkamer', 'Keuken', 'Hal']));
  });

  it('normalises every floor into positive space against one origin', () => {
    const p = fmlToProject(fml, meta);
    for (const f of p.floors) {
      const b = contentBBox(f)!;
      expect(b.x0).toBeGreaterThanOrEqual(0);
      expect(b.y0).toBeGreaterThanOrEqual(0);
    }
  });

  it('rejects a page with no Floorplanner project', () => {
    const m = parseFundaSource('<html><title>Huis te koop: Nowhere 1 | Funda</title></html>');
    expect(m.projectId).toBeNull();
    expect(m.address).toBe('Nowhere 1');
  });
});

describe('model', () => {
  it('starters are usable', () => {
    const p = blankProject('x', false);
    expect(p.floors[0].walls).toHaveLength(4);
    expect(p.floors[0].walls.reduce((s, w) => s + w.openings.length, 0)).toBe(2);
    const g = blankProject('g', true);
    expect(g.floors[0].name).toBe('Garden');
    expect(g.floors[0].items).toHaveLength(2);
  });

  it('migrate is idempotent and fills gaps', () => {
    const p = JSON.parse(JSON.stringify(newProject())) as never;
    const once = migrate(p), twice = migrate(migrate(p));
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it('serialises and reads back', () => {
    const p = fmlToProject(fml, parseFundaSource(listing));
    const back = parseProject(serializeProject(p));
    expect(back.floors).toHaveLength(p.floors.length);
    expect(serializeProject(p).length).toBeLessThan(200_000); // stays localStorage-sized
  });

  it('rejects a file that is not a project', () => {
    expect(() => parseProject('{"nope":true}')).toThrow();
  });

  it('a cleared label means "show nothing", not "use the default"', () => {
    const it: Item = { id: 'a', kind: 'chair', x: 0, y: 0, w: 46, h: 48, rot: 0, label: 'Chair' };
    expect(labelOf(it)).toBe('Chair');
    setLabel(it, 'Bureaustoel');
    expect(labelOf(it)).toBe('Bureaustoel');
    setLabel(it, '');
    expect(labelOf(it)).toBe('');
    expect(it.noLabel).toBe(1);
    setLabel(it, 'Terug');
    expect(it.noLabel).toBeUndefined();
  });

  it('orients against the building, not stray objects', () => {
    const p = blankProject('x', false);
    const f = p.floors[0];
    const before = shellBBox(f)!;
    f.items.push({ id: 'z', kind: 'chair', x: 99999, y: 99999, w: 46, h: 48, rot: 0 });
    expect(shellBBox(f)).toEqual(before);
    expect(contentBBox(f)!.x1).toBeGreaterThan(before.x1); // content did grow
  });
});

describe('hit testing', () => {
  const v: View = { zoom: 1, px: 0, py: 0 };
  it('finds the wall, then the room beneath it', () => {
    const p = blankProject('x', false);
    const f = p.floors[0];
    // x=400 is the window in the middle of that wall, which correctly wins
    expect(hitTest(f, { x: 400, y: 0 }, v, LAYERS)?.t).toBe('opening');
    expect(hitTest(f, { x: 100, y: 0 }, v, LAYERS)?.t).toBe('wall');
    expect(hitTest(f, { x: 400, y: 500 }, v, LAYERS)?.t).toBe('area');
    expect(hitTest(f, { x: -500, y: -500 }, v, LAYERS)).toBeNull();
  });

  it('prefers the topmost object', () => {
    const p = blankProject('x', false);
    const f = p.floors[0];
    f.items.push({ id: 'i1', kind: 'chair', x: 400, y: 500, w: 46, h: 48, rot: 0 });
    expect(hitTest(f, { x: 400, y: 500 }, v, LAYERS)?.t).toBe('item');
    expect(hitTest(f, { x: 400, y: 500 }, v, { ...LAYERS, furn: false })?.t).toBe('area');
  });

  it('offers handles for a single selection only', () => {
    const p = blankProject('x', false);
    const f = p.floors[0];
    const sel = resolveSel(f, [{ t: 'wall', id: f.walls[0].id }]);
    expect(handlesFor(sel, v).map(h => h.k)).toEqual(['end', 'end']);
    const two = resolveSel(f, f.walls.slice(0, 2).map(w => ({ t: 'wall' as const, id: w.id })));
    expect(handlesFor(two, v)).toHaveLength(0);
  });
});

describe('catalogue', () => {
  it('has no duplicate kinds and sane dimensions', () => {
    const kinds = CATALOG.flatMap(g => g.items.map(i => i.kind));
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds.length).toBeGreaterThanOrEqual(120);
    for (const k of kinds) {
      const e = CAT_BY_KIND[k];
      expect(e.w, k).toBeGreaterThan(0);
      expect(e.h, k).toBeGreaterThan(0);
      expect(e.name.length, k).toBeGreaterThan(1);
    }
  });
});

describe('image-generator prompt', () => {
  const p = fmlToProject(fml, { ...parseFundaSource(listing), url: 'https://www.funda.nl/x' });
  const floor = p.floors[1];
  const base = { view: 'top' as const, furniture: true, dimensions: true };

  it('is written from the real geometry', () => {
    const out = buildPrompt(p, floor, base);
    expect(out).toContain('Pieter Kleijnstraat 19');
    expect(out).toContain('Woonkamer');
    expect(out).toMatch(/26\.\d m²/);
    expect(out).toMatch(/North is at the top/);
    expect(out).toMatch(/Windows on the .*(north|south|east|west)/);
    expect(out).toMatch(/Do not add, remove or rearrange walls/);
  });

  it('each viewpoint produces a different brief', () => {
    const seen = (['top', 'eye', 'iso', 'sketch'] as const).map(view => buildPrompt(p, floor, { ...base, view }));
    expect(new Set(seen).size).toBe(4);
    expect(seen[1]).toMatch(/eye level|24 mm/i);
    expect(seen[3]).toMatch(/watercolour/i);
  });

  it('can be scoped to one room', () => {
    const facts = planFacts(floor);
    const woon = facts.rooms.find(r => r.name === 'Woonkamer')!;
    const one = buildPrompt(p, floor, { ...base, room: woon.a.id });
    expect(one).toContain('Woonkamer');
    expect(one).not.toContain('Keuken');
  });

  it('drops measurements and furniture on request', () => {
    const out = buildPrompt(p, floor, { ...base, dimensions: false, furniture: false });
    expect(out).not.toMatch(/m²/);
  });

  it('folds in a free-text style', () => {
    expect(buildPrompt(p, floor, { ...base, style: 'warm oak' })).toContain('warm oak');
  });
});
