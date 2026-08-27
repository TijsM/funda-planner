import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATALOG, CAT_BY_KIND, blankProject, buildPrompt, contentBBox, fmlToProject, migrate,
  newProject, parseFundaSource, parseProject, planFacts, pointInPoly, polyArea, polyCentroid,
  rotPt, serializeProject, setLabel, setDesc, descOf, labelOf, makeItem, newArea, bearing,
  shellBBox, snapAngle, snapPoint, axisLock,
  fitTo, zoomAt, toScreen, toWorld, handlesFor, cursorForHandle, hitTest, resolveSel, placeOf,
  STYLE_PRESETS, expandStyle, headWords,
} from '@engine/index';
import { SEATS } from '@engine/catalog';
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

  /* An item used to offer only its four corners, so either both dimensions
     changed or neither did. */
  const itemSel = (over: Partial<Item> = {}) => {
    const p = blankProject('x', false);
    const f = p.floors[0];
    f.items.push({ id: 'i1', kind: 'chair', x: 400, y: 500, w: 200, h: 100, rot: 0, ...over } as Item);
    return resolveSel(f, [{ t: 'item', id: 'i1' }]);
  };

  it('offers all four sides as well as the corners', () => {
    const hs = handlesFor(itemSel(), v);
    const res = hs.filter(h => h.k === 'res');
    expect(res).toHaveLength(8);
    expect(hs.filter(h => h.k === 'rot')).toHaveLength(1);
    const corners = res.filter(h => h.dir![0] && h.dir![1]);
    const sides = res.filter(h => !(h.dir![0] && h.dir![1]));
    expect(corners).toHaveLength(4);
    expect(sides).toHaveLength(4);
    /* every side exactly once, and never the no-op direction */
    expect(sides.map(h => h.dir!.join(',')).sort())
      .toEqual(['-1,0', '0,-1', '0,1', '1,0']);
  });

  it('puts the corners first, so a small object still resizes both ways', () => {
    const res = handlesFor(itemSel(), v).filter(h => h.k === 'res');
    /* hitHandle returns the first within range; on an object only a few pixels
       across the corner and side handles overlap, and the corner has to win */
    expect(res.slice(0, 4).every(h => h.dir![0] && h.dir![1])).toBe(true);
  });

  it('sits each side handle on the middle of its edge', () => {
    const hs = handlesFor(itemSel(), v).filter(h => h.k === 'res');
    const right = hs.find(h => h.dir![0] === 1 && h.dir![1] === 0)!;
    const c = toScreen(v, 400, 500);
    /* 200 wide, so the right edge is 100 cm out and the handle is level with
       the centre — no vertical offset at all */
    expect(right.sx).toBeCloseTo(toScreen(v, 500, 500).x, 6);
    expect(right.sy).toBeCloseTo(c.y, 6);
  });

  it('points the cursor along the axis the handle actually pulls', () => {
    const hs = handlesFor(itemSel(), v).filter(h => h.k === 'res');
    const dir = (x: number, y: number) => hs.find(h => h.dir![0] === x && h.dir![1] === y)!;
    expect(cursorForHandle(dir(1, 0))).toBe('ew-resize');
    expect(cursorForHandle(dir(0, 1))).toBe('ns-resize');
    expect(cursorForHandle(dir(1, 1))).toBe('nwse-resize');
    expect(cursorForHandle(dir(1, -1))).toBe('nesw-resize');
    expect(cursorForHandle(null)).toBe('default');
  });

  it('turns the cursor with the object, because the top edge is not always up', () => {
    const hs = handlesFor(itemSel({ rot: 90 }), v).filter(h => h.k === 'res');
    const right = hs.find(h => h.dir![0] === 1 && h.dir![1] === 0)!;
    expect(cursorForHandle(right)).toBe('ns-resize');
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

  /* The tray searches name, group and `alt`. A kitchen had no table in it at
     all, and the one round table in the catalogue was called "Round 6p" over in
     Dining — so the words a person actually types found nothing. */
  const finds = (q: string) => CATALOG.flatMap(g => g.items.filter(i =>
    [i.name, g.group, i.alt ?? ''].some(t => t.toLowerCase().includes(q.toLowerCase()))));

  it('finds a round table by the words someone would type', () => {
    for (const q of ['round table', 'ronde tafel', 'circular', 'keukentafel', 'bistro']) {
      expect(finds(q).length, q).toBeGreaterThan(0);
    }
  });

  /* The tray matches a contiguous substring, so "round table" only reaches an
     entry whose name or alt has those two words next to each other — which is
     why the 6-seater called "Round 6p" was invisible to the obvious query. */
  it('finds every round table, not just the ones named like one', () => {
    const kinds = finds('round table').map(i => i.kind);
    expect(kinds).toContain('dtr');
    expect(kinds).toContain('dtr4');
    expect(kinds).toContain('ktable');
  });

  /* A round four-seater existed only under Kitchen, where nobody laying out a
     dining room goes looking for it — and the Dining group's round series jumped
     straight from nothing to six. */
  it('has a round four-seater in the dining group, not only in the kitchen', () => {
    const dining = CATALOG.find(g => g.group === 'Dining')!.items;
    const round4 = dining.filter(i => /round/i.test(`${i.name} ${i.alt ?? ''}`) && SEATS[i.kind] === 4);
    expect(round4.map(i => i.kind)).toEqual(['dtr4']);
    /* square-on, or the circle glyph draws an ellipse */
    expect(round4[0].w).toBe(round4[0].h);
  });

  /* Every one of these floors has a hall cupboard and none of them could draw
     one: the Wardrobe is the bedroom's and 62 cm deep for hangers, and the Tall
     cabinet is a kitchen unit. */
  it('has a cupboard, by every word a person would call it', () => {
    for (const q of ['cupboard', 'kast', 'storage', 'closet']) {
      expect(finds(q).map(i => i.kind), q).toContain('cupbrd');
    }
    expect(CAT_BY_KIND.cupbrd.h).toBeLessThan(CAT_BY_KIND.wardr.h);
  });

  it('has a round table you can put in a kitchen', () => {
    const kitchen = CATALOG.find(g => g.group === 'Kitchen')!.items;
    const round = kitchen.filter(i => /round/i.test(`${i.name} ${i.alt ?? ''}`));
    expect(round.length).toBeGreaterThan(0);
    /* square-on so the circle glyph is a circle, not an ellipse */
    for (const t of round) expect(t.w, t.kind).toBe(t.h);
  });
});

describe('image-generator prompt', () => {
  const p = fmlToProject(fml, { ...parseFundaSource(listing), url: 'https://www.funda.nl/x' });
  const floor = p.floors[1];
  const base = { view: 'top' as const, furniture: true, dimensions: true };

  it('is written from the real geometry', () => {
    const out = buildPrompt(floor, base);
    /* the street address steers nothing in an image and pulls the model towards
       whatever real building it half-remembers, so it is not in the brief */
    expect(out).not.toContain('Pieter Kleijnstraat');
    expect(out).toContain('Begane Grond');
    expect(out).toContain('Woonkamer');
    expect(out).toMatch(/26\.\d m²/);
    expect(out).toMatch(/North is at the top/);
    expect(out).toMatch(/Windows on the .*(north|south|east|west)/);
    expect(out).toMatch(/Do not add, remove or rearrange walls/);
  });

  /* Both used to be the last two lines of a 27-line brief, read after every room
     had already been placed — and the renders came back as tilted dollhouses
     with drifting far-end geometry. */
  it('states the camera and the reference image before any geometry', () => {
    const out = buildPrompt(floor, base);
    expect(out.indexOf('CAMERA AND OUTPUT')).toBeLessThan(out.indexOf('ROOMS'));
    expect(out.indexOf('REFERENCE')).toBeLessThan(out.indexOf('ROOMS'));
    /* style is the only block allowed to move, so it is read last */
    const styled = buildPrompt(floor, { ...base, style: 'Japandi' });
    expect(styled.indexOf('LOCKED')).toBeLessThan(styled.indexOf('STYLE'));
    expect(styled.trimEnd().endsWith('the LOCKED block still wins.')).toBe(true);
  });

  /* Front-loading the camera was only half the fix: it was still 120 words of
     it, and BFL's guide says attention falls off with word order and puts the
     useful window at 30-80 words. The clauses that mattered were sitting behind
     clauses that only restated them. */
  it('keeps the block before the LOCKED tables inside the documented word window', () => {
    for (const view of ['top', 'eye', 'iso', 'sketch'] as const) {
      const n = headWords(buildPrompt(floor, { ...base, view }));
      expect(n, view).toBeLessThanOrEqual(80);
      expect(n, view).toBeGreaterThanOrEqual(30);
    }
    /* the tables below the line are data and stay as long as the plan needs */
    expect(buildPrompt(floor, base).split(/\s+/).length).toBeGreaterThan(120);
  });

  /* Every attachment costs words at the most expensive end of the brief, so an
     extra one has to be a sentence, not a paragraph. */
  it('adds one short sentence per attached map and no more', () => {
    const plain = headWords(buildPrompt(floor, base));
    const one = headWords(buildPrompt(floor, { ...base, controls: ['line'] }));
    const two = headWords(buildPrompt(floor, { ...base, controls: ['line', 'depth'] }));
    /* the first map pays for the "keep the arrangement" sentence as well */
    expect(one - plain).toBeLessThanOrEqual(35);
    expect(two - one).toBeLessThanOrEqual(20);
  });

  it('makes the top-down camera a constraint rather than a hint', () => {
    const out = buildPrompt(floor, base);
    expect(out).toMatch(/strict orthographic/i);
    expect(out).toMatch(/zero perspective/i);
    expect(out).not.toMatch(/orthographic-looking/);
    /* the isometric view is the one that genuinely wants the tilt */
    const iso = buildPrompt(floor, { ...base, view: 'iso' });
    expect(iso).toMatch(/45°/);
    expect(iso).not.toMatch(/zero perspective/i);
  });

  it('each viewpoint produces a different brief', () => {
    const seen = (['top', 'eye', 'iso', 'sketch'] as const).map(view => buildPrompt(floor, { ...base, view }));
    expect(new Set(seen).size).toBe(4);
    expect(seen[1]).toMatch(/eye level|24 mm/i);
    expect(seen[3]).toMatch(/watercolour/i);
  });

  /* An unannounced map is worse than no map: a depth ramp handed over in
     silence comes back painted onto the floor as a grey gradient. The lead
     sentence is BFL's own published phrasing for holding a layout. */
  it('names every control map it sends, numbered from image 2', () => {
    const out = buildPrompt(floor, { ...base, controls: ['line', 'depth', 'seg'] });
    expect(out).toContain('Keep the exact spatial arrangement from image 1');
    expect(out).toMatch(/Image 2 is a line drawing/);
    expect(out).toMatch(/Image 3 is a depth map/);
    expect(out).toMatch(/Image 4 is a segmentation map/);
    /* stated before any geometry, where the word order still buys attention */
    expect(out.indexOf('Image 2')).toBeLessThan(out.indexOf('LOCKED'));
    /* and each one says it is a control, not something to draw */
    expect(out.match(/Do not render it\./g)).toHaveLength(3);
    /* the vendor's sentence replaces our own "match it exactly" rather than
       joining it — saying the same thing twice is two lines of the opening
       budget for one instruction — but the walls rule is not in theirs */
    expect(out).not.toContain('Match image 1 exactly');
    expect(out).toContain('Do not add, remove or rearrange walls.');
  });

  /* A change mask says the opposite thing depending on which way round the
     polarity is stated, and the expensive way round is the one that repaints
     what had to be preserved. paintPass draws white where a re-render is
     allowed, so that is what the sentence has to claim. */
  it('states the change mask the same way round as the mask is painted', () => {
    const out = buildPrompt(floor, { ...base, controls: ['change'] });
    expect(out).toMatch(/Image 2 is a change mask: white may be re-rendered, black must come through unchanged/);
  });

  /* The whole option has to be free for the provider that takes no maps: FLUX.2
     accepts none, and today's users must not get a different brief because the
     code learned a new word. */
  it('is byte-identical to the old brief when no map is attached', () => {
    const plain = buildPrompt(floor, base);
    expect(buildPrompt(floor, { ...base, controls: [] })).toBe(plain);
    expect(buildPrompt(floor, { ...base, controls: undefined })).toBe(plain);
    expect(plain).not.toContain('Keep the exact spatial arrangement');
  });

  it('can be scoped to one room', () => {
    const facts = planFacts(floor);
    const woon = facts.rooms.find(r => r.name === 'Woonkamer')!;
    const one = buildPrompt(floor, { ...base, room: woon.a.id });
    expect(one).toContain('Woonkamer');
    expect(one).not.toContain('Keuken');
    /* The walls rule was a closing line that ran on every brief until the
       front-loading moved the reference block to the top and left the
       room-scoped branch without one — and a room-scoped brief is the one most
       likely to grow a wall, because the reference shows three rooms the model
       has just been told not to draw. It still has to fit the word window. */
    expect(one).toContain('Do not add, remove or rearrange walls.');
    expect(headWords(one)).toBeLessThanOrEqual(80);
  });

  it('drops measurements and furniture on request', () => {
    const out = buildPrompt(floor, { ...base, dimensions: false, furniture: false });
    expect(out).not.toMatch(/m²/);
  });

  it('folds in a free-text style', () => {
    expect(buildPrompt(floor, { ...base, style: 'warm oak' })).toContain('warm oak');
  });

  /* A style is two words in a box; the image model needs materials, colours and
     light. The expansion says what the word means without taking the words the
     person actually typed away from them. */
  /* The brief no longer talks about the picture's annotation, because there is
     none to talk about. It described captions, then numbered discs, and each
     time the description was a mitigation for ink we had put there ourselves —
     the discs came back painted onto the render's floor as black roundels. The
     one thing left to say about text is the positive ban in CAMERA AND OUTPUT,
     and a brief that does not discuss writing is a brief less likely to produce
     any: FLUX.2 has no negative prompt to push against. */
  it('says nothing about annotation on the picture, on any setting', () => {
    const out = buildPrompt(floor, base);
    expect(out).not.toMatch(/black disc/i);
    expect(out).not.toMatch(/# column/i);
    expect(out).not.toMatch(/captions/i);
    expect(out).not.toMatch(/draw none of/i);
    /* The ban names NUMBERS, and it has to: the render came back with eight
       dimension labels on it, lettered from "1.2 m" in the camera line and
       "6.2 × 11.2 m" under LOCKED. Both numerals are gone from the brief and the
       ban says the word out loud. Still short — the opening block is on a word
       budget. */
    expect(out).toMatch(/no text, numbers or dimension lines/i);
  });

  it('expands a style it recognises, and keeps the typed words on top', () => {
    const out = buildPrompt(floor, { ...base, style: 'Scandinavian, matte black accents' });
    expect(out).toContain('Scandinavian, matte black accents.');
    expect(out).toContain('Scandinavian here means:');
    expect(out).toMatch(/pale oak/);
    expect(out).toMatch(/the words above win/);
  });

  it('passes free text through untouched when it names no style it knows', () => {
    const out = buildPrompt(floor, { ...base, style: 'like my grandmother\'s house' });
    expect(out).toContain("like my grandmother's house.");
    expect(out).not.toContain('here means:');
  });

  it('matches a style label on whole words only', () => {
    expect(expandStyle('Art deco')?.label).toBe('Art deco');
    expect(expandStyle('mid-century modern')?.label).toBe('Mid-century modern');
    expect(expandStyle('boho')?.label).toBe('Bohemian');
    /* "decorative plasterwork" is not Art deco */
    expect(expandStyle('decorative plasterwork')).toBe(null);
    expect(expandStyle('')).toBe(null);
  });

  it('every preset expands into something concrete', () => {
    for (const p of STYLE_PRESETS) {
      expect(p.tokens.length, p.label).toBeGreaterThan(40);
      expect(expandStyle(p.label)?.label, p.label).toBe(p.label);
    }
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
    const out = buildPrompt(f, { view: 'top', furniture: false, dimensions: false });
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

    const out = buildPrompt(f, { view: 'top', furniture: false, dimensions: true });
    const subject = out.split('\n').find(l => l.startsWith('"'))!;
    expect(subject).not.toMatch(/m² over/);          // no 1.0 m² inside an 80 m² shell
    /* And no footprint either, mapped or not: "8.0 × 10.0 m" is shaped like a
       dimension chain and the model drew one. See the comment above this line in
       prompt.ts. */
    expect(subject).not.toMatch(/footprint/);
    expect(subject).not.toMatch(/×/);
  });

  it('keeps the total when the rooms do cover the plan, and counts them properly', () => {
    const p = blankProject('Mapped', false);
    const f = p.floors[0];
    f.areas[0].name = 'Woonkamer';
    expect(planFacts(f).mapped).toBe(true);
    const subject = buildPrompt(f, { view: 'top', furniture: false, dimensions: true })
      .split('\n').find(l => l.startsWith('"'))!;
    /* The area the rooms actually account for, and nothing shaped like a
       dimension chain — see the sibling test above. */
    expect(subject).toMatch(/80\.0 m² over 1 named room/);
    expect(subject).not.toMatch(/footprint/);
  });
});

describe('placeOf puts a position into words', () => {
  /* placeOf no longer feeds the brief — position through prose measures 0.41
     quadrant F1 (arXiv:2507.08039) against the same fact drawn pixel-exact on
     the reference, so the OBJECTS table dropped its Position column. The
     function stays, and stays pinned down here: the eval harness reports where
     an object actually landed, and a person reads that report. */
  const b = { x0: 0, y0: 0, x1: 600, y1: 1200 };
  const at = (x: number, y: number) => placeOf({ ...makeItem('chair', { x, y }) }, b);

  it('names the cell of the plan, not a coordinate', () => {
    expect(at(40, 300)).toBe('against the left wall, upper');
    expect(at(100, 100)).toBe('top-left');          // 1 m in is not "against"
    expect(at(300, 50)).toBe('against the top wall, centre');
    expect(at(300, 600)).toBe('the middle of the floor');
    expect(at(150, 600)).toBe('middle-left');
    expect(at(450, 600)).toBe('middle-right');
    expect(at(300, 1160)).toBe('against the bottom wall, centre');
    expect(at(560, 600)).toBe('against the right wall, middle');
  });

  it('prefers the wall an object is pressed against', () => {
    /* 40 cm from the left edge is against that wall, whatever cell it is in */
    expect(at(40, 200)).toMatch(/^against the left wall/);
    expect(at(40, 1000)).toMatch(/^against the left wall/);
    /* and 2 m in from it is not */
    expect(at(150, 300)).not.toMatch(/against/);
  });

  it('lists them in the order a plan is read, top to bottom', () => {
    const p = blankProject('x', false);
    const f = p.floors[0];
    f.areas = [];
    const add = (y: number, name: string) => {
      const i = makeItem('chair', { x: 400, y });
      setLabel(i, name);
      f.items.push(i);
    };
    add(900, 'gamma'); add(200, 'alpha'); add(550, 'beta');

    const out = buildPrompt(f, { view: 'top', furniture: true, dimensions: false });
    expect(planFacts(f).loose.map(i => labelOf(i))).toEqual(['alpha', 'beta', 'gamma']);
    expect(out.indexOf('alpha')).toBeLessThan(out.indexOf('beta'));
    expect(out.indexOf('beta')).toBeLessThan(out.indexOf('gamma'));
    /* one row each — not a comma list. The row no longer says where the object
       is; the drawing does. The reading order still matters, because word order
       is what the model weighs (BFL's guide) and a plan reads top to bottom. */
    expect(out).not.toMatch(/Elsewhere on the floor/);
    expect(out).toMatch(/OBJECTS/);
  });

  /* Position is back in the table, doing a different job. As an instruction it
     is the weaker channel — the pixels say where the sofa is exactly — but as
     the ADDRESS of a row it is the only channel there is, now that nothing may
     be written on the picture. It is scoped to the room for that reason: what
     has to be resolved is which of this room's four blocks the row means. */
  it('addresses an object by where it sits in its own room', () => {
    const p = blankProject('x', false);
    const f = p.floors[0];
    const sofa = makeItem('sofa3', { x: 40, y: 200 });
    setLabel(sofa, 'sofa');
    f.items.push(sofa);

    const said = placeOf(sofa, shellBBox(f)!);
    expect(said).toBe('against the left wall, upper');

    const out = buildPrompt(f, { view: 'top', furniture: true, dimensions: true });
    const row = out.split('\n').find(l => / \| sofa \| /.test(l))!;
    expect(row).toBeTruthy();
    /* the column is named Where, and it carries the phrase placeOf builds */
    expect(out).toMatch(/^Room \| Object \| Where \| Size \| Notes$/m);
    expect(row).toContain('against the left wall');
    /* and never a number: nothing in this brief points at a mark on the picture */
    expect(out).not.toMatch(/^# \|/m);
  });

  /* A size in the text is an invitation to letter the render with it — the same
     way our own dimension captions came back drawn on the floor — and the
     drawing already carries the size to the pixel. So a measurement appears only
     when someone asked for measurements; the OBJECTS table loses the column
     entirely rather than emitting an empty one. */
  it('emits no size at all unless measurements were asked for', () => {
    const p = blankProject('x', false);
    const f = p.floors[0];
    const sofa = makeItem('sofa3', { x: 400, y: 500 });
    setLabel(sofa, 'sofa');
    f.items.push(sofa);

    const off = buildPrompt(f, { view: 'top', furniture: true, dimensions: false });
    expect(off).toMatch(/^Room \| Object \| Where \| Notes$/m);
    expect(off).not.toMatch(/\bcm\b/);
    expect(off).not.toMatch(/\| Size \|/);

    const on = buildPrompt(f, { view: 'top', furniture: true, dimensions: true });
    expect(on).toMatch(/^Room \| Object \| Where \| Size \| Notes$/m);
    expect(on).toMatch(/\| \d+×\d+ cm \|/);
  });

  it('tells the model a staircase is a staircase', () => {
    const p = blankProject('x', false);
    const f = p.floors[0];
    const i = makeItem('stairU', { x: 400, y: 500 });
    setLabel(i, 'stairs up');
    f.items.push(i);
    const out = buildPrompt(f, { view: 'top', furniture: true, dimensions: true });
    expect(out).toMatch(/staircase goes up to the floor above/);
    expect(out).toMatch(/not as furniture and not as a corridor/);

    /* and it says so even when the stair sits inside a named room */
    f.areas[0].name = 'Hal';
    expect(buildPrompt(f, { view: 'top', furniture: true, dimensions: true }))
      .toMatch(/not as furniture and not as a corridor/);
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
    const out = buildPrompt(f, base);
    const line = out.split('\n').find(l => l.startsWith('Woonkamer |'))!;
    expect(line).toContain('wide oak floorboards, low winter light');
    /* last column, so nothing generated can run on after it */
    expect(line).toMatch(/low winter light(;|$)/);
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

    const out = buildPrompt(f, base);
    const line = out.split('\n').find(l => l.includes('| three-seat sofa |'))!;
    /* Room | Object | Where | Size | Notes, in that order and nothing else. The
       Where cell is the row's address: it is how this line and the sentence that
       names a photograph of this sofa point at the same rectangle, now that
       nothing may be written on the picture itself. */
    expect(line).toMatch(/^Woonkamer \| three-seat sofa \| [a-z-]+[^|]*\| \d+×\d+ cm \| dark green velvet, mid-century, low back$/);
    /* the header says the Notes column is an instruction, so it is not restated */
    expect(out).not.toMatch(/deliberate instructions/i);
  });

  it('leaves the brief untouched when nothing is described', () => {
    const { q, f } = plan();
    furnish(f);
    const out = buildPrompt(f, base);
    const rows = out.split('\n').filter(l => /^Woonkamer \| (three-seat sofa|rug) \|/.test(l));
    expect(rows).toHaveLength(2);
    /* an undescribed object still gets its own row — the Notes cell is simply
       empty. Five columns: Room | Object | Where | Size | Notes. */
    for (const r of rows) expect(r.split(' | ')).toHaveLength(5);
    expect(rows.every(r => r.endsWith('| —'))).toBe(true);
  });

  it('collapses newlines a user pasted in', () => {
    const { q, f } = plan();
    const woon = f.areas.find(a => a.name === 'Woonkamer')!;
    setDesc(woon, 'oak floors\n\nbrass  fittings\n');
    const out = buildPrompt(f, base);
    expect(out).toContain('oak floors brass fittings');
    expect(out.split('\n').filter(l => l.startsWith('Woonkamer |'))).toHaveLength(1);
  });

  it('surfaces a fitted object once it has a name or a description', () => {
    const { q, f } = plan();
    const woon = f.areas.find(a => a.name === 'Woonkamer')!;
    const c = polyCentroid(woon.poly);

    /* anonymous is noise: the .fml ships dozens of unnamed boxes */
    const anon = { ...makeItem('sofa3', c), fromFunda: 1 as const, label: '', noLabel: 1 as const };
    f.items.push(anon);
    expect(buildPrompt(f, base)).not.toMatch(/three-seat sofa/i);

    /* but a name the user typed is the opposite — leaving the staircase out of
       the text is how a render grows a corridor that is not in the plan */
    const named = { ...makeItem('sofa3', c), fromFunda: 1 as const, label: 'Kitchen run' };
    f.items.push(named);
    expect(buildPrompt(f, base).toLowerCase()).toContain('kitchen run');

    setDesc(named, 'matte black cabinetry, brass handles');
    expect(buildPrompt(f, base)).toContain('matte black cabinetry, brass handles');
  });

  it('warns that unnamed fitted blocks are joinery, not floor', () => {
    const { q, f } = plan();
    expect(planFacts(f).anonFitted).toBeGreaterThan(0);
    const out = buildPrompt(f, base);
    expect(out).toMatch(/unnamed fitted block/i);
    expect(out).toMatch(/never open floor, a passage or a corridor/i);
  });

  it('drops object descriptions with the furniture, but keeps room ones', () => {
    const { q, f } = plan();
    const woon = f.areas.find(a => a.name === 'Woonkamer')!;
    setDesc(woon, 'plastered walls');
    const sofa = makeItem('sofa3', polyCentroid(woon.poly));
    setDesc(sofa, 'dark green velvet');
    f.items.push(sofa);

    const out = buildPrompt(f, { ...base, furniture: false });
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
