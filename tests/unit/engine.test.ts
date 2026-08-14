import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATALOG, CAT_BY_KIND, blankProject, buildPrompt, contentBBox, fmlToProject, migrate,
  newProject, parseFundaSource, parseProject, planFacts, pointInPoly, polyArea, polyCentroid,
  rotPt, serializeProject, setLabel, setDesc, descOf, labelOf, makeItem, newArea, bearing,
  shellBBox, snapAngle, snapPoint, axisLock,
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

describe('compass bearings', () => {
  it('reads a facing vector, y-down', () => {
    expect(bearing(0, -1)).toBe('north');
    expect(bearing(0, 1)).toBe('south');
    expect(bearing(1, 0)).toBe('east');
    expect(bearing(-1, 0)).toBe('west');
    expect(bearing(1, -1)).toBe('north-east');
    expect(bearing(-1, 1)).toBe('south-west');
    expect(bearing(0, 0)).toBe('central');
  });
});

describe('openings report the wall they are in, not their own octant', () => {
  /* A run of windows across one elevation used to come back as two diagonals,
     so a plain rectangle reported all four and the light direction said
     nothing. Facing is a property of the wall. */
  const rect = () => {
    const p = blankProject('x', false);
    const f = p.floors[0];
    f.walls.forEach(w => { w.openings = []; });
    return { p, f };
  };

  it('puts three windows spread along the top wall all in the north', () => {
    const { f } = rect();
    const top = f.walls.find(w => w.a.y === 0 && w.b.y === 0)!;
    [0.15, 0.5, 0.85].forEach((at, i) =>
      top.openings.push({ id: `w${i}`, at, type: 'window', width: 80, flip: 0, side: 0 }));
    expect(planFacts(f).windowSides).toEqual([['north', 3]]);
  });

  it('reports exactly the two glazed elevations of a rectangle', () => {
    const { f } = rect();
    const byY = (y: number) => f.walls.find(w => w.a.y === y && w.b.y === y)!;
    byY(0).openings.push({ id: 'a', at: 0.3, type: 'window', width: 80, flip: 0, side: 0 });
    byY(1000).openings.push({ id: 'b', at: 0.7, type: 'window', width: 80, flip: 0, side: 0 });
    const sides = planFacts(f).windowSides.map(([d]) => d);
    expect(sides.sort()).toEqual(['north', 'south']);
    expect(sides.some(d => d.includes('-'))).toBe(false);
  });

  it('says so plainly rather than listing five or more elevations', () => {
    const p = blankProject('x', false);
    const f = p.floors[0];
    f.walls.forEach(w => { w.openings = []; });
    /* an octagon-ish shell: one glazed wall facing each way */
    f.walls.length = 0;
    const R = 400;
    for (let i = 0; i < 8; i++) {
      const a = { x: R * Math.cos((i / 8) * 6.2832), y: R * Math.sin((i / 8) * 6.2832) };
      const b = { x: R * Math.cos(((i + 1) / 8) * 6.2832), y: R * Math.sin(((i + 1) / 8) * 6.2832) };
      f.walls.push({ id: `w${i}`, a, b, t: 20,
        openings: [{ id: `o${i}`, at: 0.5, type: 'window', width: 100, flip: 0, side: 0 }] });
    }
    expect(planFacts(f).windowSides.length).toBeGreaterThanOrEqual(5);
    const out = buildPrompt(p, f, { view: 'top', furniture: false, dimensions: false });
    expect(out).toMatch(/nearly every elevation/i);
    expect(out).not.toMatch(/Windows on the .*and.*sides/);
  });
});

describe('the area headline stays coherent with the footprint', () => {
  it('drops the room total when the rooms do not account for the building', () => {
    const p = blankProject('Open plan', false);
    const f = p.floors[0];
    /* 8 × 10 m of walls, but only a 1 m² polygon drawn */
    f.areas[0].poly = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect(planFacts(f).mapped).toBe(false);

    const out = buildPrompt(p, f, { view: 'top', furniture: false, dimensions: true });
    const subject = out.split('\n')[3];
    expect(subject).toContain('overall footprint 8.0 × 10.0 m');
    expect(subject).not.toMatch(/m² over/);          // no 1.0 m² inside an 80 m² shell
  });

  it('keeps the total when the rooms do cover the plan, and counts them properly', () => {
    const p = blankProject('Mapped', false);
    const f = p.floors[0];
    f.areas[0].name = 'Woonkamer';
    expect(planFacts(f).mapped).toBe(true);
    const subject = buildPrompt(p, f, { view: 'top', furniture: false, dimensions: true })
      .split('\n')[3];
    expect(subject).toMatch(/80\.0 m² over 1 named room, overall footprint 8\.0 × 10\.0 m/);
  });
});

describe('object descriptions', () => {
  /* a fresh project per test — descriptions are written into the document */
  const plan = () => {
    const q = parseProject(serializeProject(
      fmlToProject(fml, { ...parseFundaSource(listing), url: 'https://www.funda.nl/x' }),
    ))!;
    return { q, f: q.floors[1] };
  };
  const base = { view: 'top' as const, furniture: true, dimensions: true };

  it('is absent on everything by default', () => {
    const { f } = plan();
    expect(f.items.some(i => 'desc' in i)).toBe(false);
    expect(f.areas.some(a => 'desc' in a)).toBe(false);
    expect(descOf(makeItem('sofa3', { x: 0, y: 0 }))).toBe('');
    expect(descOf(newArea({ x: 0, y: 0 }, 100, 0))).toBe('');
  });

  it('removes the field again when emptied, rather than storing ""', () => {
    const i = makeItem('sofa3', { x: 0, y: 0 });
    setDesc(i, 'dark green velvet');
    expect(i.desc).toBe('dark green velvet');
    setDesc(i, '   ');
    expect('desc' in i).toBe(false);
  });

  it('puts a room description into that room\'s line', () => {
    const { q, f } = plan();
    const woon = f.areas.find(a => a.name === 'Woonkamer')!;
    setDesc(woon, 'wide oak floorboards, low winter light');
    const out = buildPrompt(q, f, base);
    const line = out.split('\n').find(l => l.startsWith('- Woonkamer'))!;
    expect(line).toContain('wide oak floorboards, low winter light');
    /* ends as its own sentence, so it cannot run into the generated prose */
    expect(line).toMatch(/low winter light\.( |$)/);
  });

  /* every item on this floor is a fitted one imported from the listing, so a
     furniture list only exists once something is actually placed */
  const furnish = (f: ReturnType<typeof plan>['f']) => {
    const woon = f.areas.find(a => a.name === 'Woonkamer')!;
    const c = polyCentroid(woon.poly);
    const sofa = makeItem('sofa3', c);
    const rug = makeItem('rug', { x: c.x + 1, y: c.y + 1 });
    f.items.push(sofa, rug);
    return { woon, sofa, rug };
  };

  it('puts an object description next to that object, and says to follow it', () => {
    const { q, f } = plan();
    const { sofa } = furnish(f);
    setDesc(sofa, 'dark green velvet, mid-century, low back');

    const out = buildPrompt(q, f, base);
    const line = out.split('\n').find(l => l.startsWith('- Woonkamer'))!;
    expect(line).toMatch(/sofa 3-seat \(\d+×\d+ cm\) — dark green velvet, mid-century, low back/);
    /* a described list carries commas, so its entries separate on semicolons */
    expect(line).toContain('; ');
    expect(out).toMatch(/deliberate instructions/i);
  });

  it('leaves the brief untouched when nothing is described', () => {
    const { q, f } = plan();
    furnish(f);
    const out = buildPrompt(q, f, base);
    expect(out).not.toMatch(/deliberate instructions/i);
    const list = out.split('\n').find(l => l.startsWith('- Woonkamer'))!.split('Contains: ')[1];
    expect(list).toMatch(/, /);        // still comma-joined
    expect(list).not.toContain(';');
  });

  it('collapses newlines a user pasted in', () => {
    const { q, f } = plan();
    const woon = f.areas.find(a => a.name === 'Woonkamer')!;
    setDesc(woon, 'oak floors\n\nbrass  fittings\n');
    const out = buildPrompt(q, f, base);
    expect(out).toContain('oak floors brass fittings');
    expect(out.split('\n').filter(l => l.startsWith('- Woonkamer'))).toHaveLength(1);
  });

  it('surfaces a described fitted object, which is otherwise skipped', () => {
    const { q, f } = plan();
    const woon = f.areas.find(a => a.name === 'Woonkamer')!;
    const c = polyCentroid(woon.poly);
    const fitted = { ...makeItem('sofa3', c), fromFunda: 1 as const, label: 'Kitchen run' };
    f.items.push(fitted);

    expect(buildPrompt(q, f, base)).not.toContain('kitchen run');
    setDesc(fitted, 'matte black cabinetry, brass handles');
    const out = buildPrompt(q, f, base);
    expect(out).toContain('matte black cabinetry, brass handles');
  });

  it('drops object descriptions with the furniture, but keeps room ones', () => {
    const { q, f } = plan();
    const woon = f.areas.find(a => a.name === 'Woonkamer')!;
    setDesc(woon, 'plastered walls');
    const sofa = makeItem('sofa3', polyCentroid(woon.poly));
    setDesc(sofa, 'dark green velvet');
    f.items.push(sofa);

    const out = buildPrompt(q, f, { ...base, furniture: false });
    expect(out).toContain('plastered walls');
    expect(out).not.toContain('dark green velvet');
  });

  it('survives a save and reload', () => {
    const { q, f } = plan();
    setDesc(f.areas[0], 'sunken seating');
    const back = parseProject(serializeProject(q))!;
    expect(back.floors[1].areas[0].desc).toBe('sunken seating');
  });
});
