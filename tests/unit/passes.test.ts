import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import {
  blankProject, contentBBox, fmlToProject, makeItem, parseFundaSource, pointInPoly, polyArea, wallQuad,
} from '@engine/index';
import { CATALOG, CAT_BY_KIND, heightOf } from '@engine/catalog';
import {
  PASS_KINDS, SEG_INTERIOR, SEG_WALL, paintPass, segObjectColor, segRoomColors, type PassKind,
} from '@engine/passes';
import { planFrame, type FrameOpts } from '@engine/frame';
import type { Fml } from '@engine/io/funda';
import type { Floor, Item, Pt } from '@engine/types';

/** The control-map passes, drawn through @napi-rs/canvas onto real pixels.
 *
 *  Everything here is a property of the bitmap rather than of the calls that
 *  made it, because what goes wrong with a conditioning image is never that a
 *  method was not called — it is that the picture the encoder receives says
 *  something we did not mean. */

const FIX = path.join(__dirname, '..', 'fixtures');
const fml = JSON.parse(fs.readFileSync(path.join(FIX, 'floorplanner-project.fml'), 'utf8')) as Fml;
const listing = fs.readFileSync(path.join(FIX, 'funda-listing.html'), 'utf8');
const project = fmlToProject(fml, parseFundaSource(listing));
const GROUND = project.floors[1];
const UPSTAIRS = project.floors[2];

/* small enough to keep five passes per floor quick, large enough that a 3 px
   minimum stroke is still a minimum rather than the whole wall */
const REF: FrameOpts = { clean: true, maxPx: 600 };

/** A context that refuses to draw text. A control map with lettering on it does
 *  not merely leak the words into the render the way our reference image did —
 *  it bakes them into the structure the model is being told to follow. */
function noText(ctx: object): CanvasRenderingContext2D {
  return new Proxy(ctx, {
    get(t, k) {
      if (k === 'fillText' || k === 'strokeText')
        return () => { throw new Error(`a pass drew text with ${String(k)}()`); };
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) { Reflect.set(t, k, v); return true; },
  }) as CanvasRenderingContext2D;
}

interface Shot { w: number; h: number; d: Uint8ClampedArray; px: (p: Pt) => [number, number, number] }

function shoot(floor: Floor, pass: PassKind, opts: FrameOpts = REF, furniture = true): Shot {
  const frame = planFrame(floor, opts);
  if (!frame) throw new Error('nothing to frame');
  const cv = createCanvas(frame.width, frame.height);
  const ctx = cv.getContext('2d');
  paintPass(noText(ctx), { floor, frame, pass, furniture });
  const d = ctx.getImageData(0, 0, frame.width, frame.height).data;
  const w = frame.width, h = frame.height;
  return {
    w, h, d,
    /** the pixel a world point lands on */
    px(p: Pt) {
      const x = Math.round(p.x * frame.view.zoom + frame.view.px);
      const y = Math.round(p.y * frame.view.zoom + frame.view.py);
      const i = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    },
  };
}

const key = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
const keyOf = (css: string) => {
  const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(css);
  if (!m) throw new Error(`not an rgb() colour: ${css}`);
  return key(+m[1], +m[2], +m[3]);
};

/** A cheap fingerprint of a bitmap. Deep-equalling two million-byte buffers is
 *  slower than drawing them. */
function sig(d: Uint8ClampedArray): number {
  let h = 2166136261;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function histogram(s: Shot): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < s.d.length; i += 4) {
    const k = key(s.d[i], s.d[i + 1], s.d[i + 2]);
    out.set(k, (out.get(k) || 0) + 1);
  }
  return out;
}

/** an object's footprint, the same rotated box the passes fill */
function quadOf(i: Item): Pt[] {
  const r = ((i.rot || 0) * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
  const hw = i.w / 2, hh = i.h / 2;
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const)
    .map(([x, y]) => ({ x: i.x + x * c - y * sn, y: i.y + x * sn + y * c }));
}

/** A point of bare floor: inside a room, clear of every wall, object and
 *  opening. Found by search rather than assumed, because the fixture is a real
 *  imported plan whose rooms are full. */
function bareFloor(f: Floor): Pt {
  const area = [...f.areas].sort((a, b) => polyArea(b.poly) - polyArea(a.poly))[0];
  const bb = contentBBox({ ...f, walls: [], items: [], notes: [], dims: [], lines: [], areas: [area], ref: null })!;
  const quads = f.items.map(quadOf), walls = f.walls.map(wallQuad);
  for (let gy = 1; gy < 40; gy++) {
    for (let gx = 1; gx < 40; gx++) {
      const p = { x: bb.x0 + ((bb.x1 - bb.x0) * gx) / 40, y: bb.y0 + ((bb.y1 - bb.y0) * gy) / 40 };
      if (!pointInPoly(p, area.poly)) continue;
      if (quads.some(q => pointInPoly(p, q))) continue;
      if (walls.some(q => pointInPoly(p, q))) continue;
      return p;
    }
  }
  throw new Error('no bare floor on this plan');
}

/** The centre of the widest opening of a kind, which is the point furthest from
 *  either jamb and so the fairest place to ask whether the gap was cut. */
function openingCentre(f: Floor, type: 'door' | 'window'): Pt {
  const found = f.walls
    .flatMap(w => w.openings.filter(o => o.type === type).map(o => ({ w, o })))
    .sort((a, b) => b.o.width - a.o.width)[0];
  if (!found) throw new Error(`no ${type} on this plan`);
  const { w, o } = found;
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  const t = Math.min(Math.max(o.at, 0), 1);
  return { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
}

/** The centre of a stretch of wall with no opening in it. */
function solidWall(f: Floor): Pt {
  for (const w of f.walls) {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (L < 120) continue;
    for (const t of [0.08, 0.5, 0.92]) {
      const clear = w.openings.every(op => Math.abs(op.at - t) * L > op.width / 2 + w.t);
      if (clear) return { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
    }
  }
  throw new Error('no solid wall on this plan');
}

describe('planFrame', () => {
  /** The fit maths as `renderFloorCanvas()` in src/shell/files.ts wrote it,
   *  transcribed. Every render's aspect ratio and scale comes out of these
   *  fifteen lines, so a silent drift here re-frames every picture the app has
   *  ever produced without anything failing. */
  function legacy(f: Floor, opts: { clean?: boolean; measures?: boolean; maxPx?: number }) {
    let framed = f;
    if (opts.measures) {
      const bb = contentBBox({ ...f, dims: [], lines: [], notes: [], ref: null });
      if (bb) {
        const m = 130;
        const near = (p: Pt) => p.x >= bb.x0 - m && p.x <= bb.x1 + m && p.y >= bb.y0 - m && p.y <= bb.y1 + m;
        framed = {
          ...f,
          dims: f.dims.filter(d => near(d.a) && near(d.b)),
          lines: f.lines.filter(l => near(l.a) && near(l.b)),
          notes: f.notes.filter(n => near(n)),
        };
      }
    }
    const b = contentBBox({
      ...framed,
      notes: opts.clean ? [] : framed.notes,
      dims: opts.clean ? [] : framed.dims,
      ref: null,
    });
    if (!b) return null;
    const maxPx = opts.maxPx ?? 3600;
    const fit = (pad: number) => {
      const wCm = b.x1 - b.x0 + pad * 2;
      const hCm = b.y1 - b.y0 + pad * 2;
      return { wCm, hCm, zoom: Math.max(0.15, Math.min(maxPx / Math.max(wCm, hCm), 6)) };
    };
    let pad = opts.clean ? 40 : 70;
    if (opts.measures) pad = Math.max(pad, 88 / fit(pad).zoom);
    const { wCm, hCm, zoom } = fit(pad);
    return {
      width: Math.round(wCm * zoom),
      height: Math.round(hCm * zoom),
      zoom,
      px: (-b.x0 + pad) * zoom,
      py: (-b.y0 + pad) * zoom,
    };
  }

  it('frames every fixture floor exactly as the browser export used to', () => {
    const cases = [
      { clean: true, maxPx: 1800 },                  // the generator reference
      { measures: true, maxPx: 3600 },               // the measured print
      { maxPx: 3600 },                               // a plain print
      { clean: true, measures: true, maxPx: 900 },
    ];
    for (const floor of project.floors) {
      for (const opts of cases) {
        const was = legacy(floor, opts)!;
        const now = planFrame(floor, opts)!;
        expect([now.width, now.height]).toEqual([was.width, was.height]);
        expect(now.view.zoom).toBeCloseTo(was.zoom, 10);
        expect(now.view.px).toBeCloseTo(was.px, 8);
        expect(now.view.py).toBeCloseTo(was.py, 8);
      }
    }
  });

  it('defaults to an 1800 px reference, and frames nothing as nothing', () => {
    /* 1800 is what RenderModal asks for today; a default that quietly differed
       from it would send the provider a different picture the first time
       somebody called planFrame() without opts. */
    const f = project.floors[0];
    const dflt = planFrame(f, { clean: true })!;
    expect(dflt).toEqual(planFrame(f, { clean: true, maxPx: 1800 }));
    expect(Math.max(dflt.width, dflt.height)).toBe(1800);
    expect(planFrame({ ...f, walls: [], areas: [], items: [], notes: [], dims: [], lines: [] })).toBeNull();
  });

  /* A clean reference hides the chains, so counting them framed the picture
     around ink that is not in it — an imported plan's chains sprawl a metre
     past the walls, the plan sat in a letterbox, and the generator filled the
     spare bands with a title block of its own. */
  it('ignores the dimension chains it is not going to draw', () => {
    const f = project.floors[3];                     // 17 chains, sprawling
    expect(f.dims.length).toBeGreaterThan(4);
    const withChains = { ...f, dims: f.dims };
    const without = { ...f, dims: [] };
    const a = planFrame(withChains, { clean: true, maxPx: 900 })!;
    const b = planFrame(without, { clean: true, maxPx: 900 })!;
    expect([a.width, a.height]).toEqual([b.width, b.height]);
  });
});

describe('paintPass', () => {
  it('never draws text, in any pass, on any floor', () => {
    /* The guard in `shoot` throws on fillText/strokeText, so this passes only
       because nothing reached for either — including `ink`, which shares
       paint() with the app and its room names, object labels and dimension
       captions. */
    for (const floor of [GROUND, UPSTAIRS]) {
      for (const pass of PASS_KINDS) expect(() => shoot(floor, pass)).not.toThrow();
    }
  });

  it('draws the same bytes twice for the same plan', () => {
    /* Seg hashes its hues off the area ids rather than allocating them in
       document order. A palette that shuffles between runs is a different
       scene each time, which is the opposite of a control map. */
    for (const pass of PASS_KINDS) {
      expect(sig(shoot(GROUND, pass).d)).toBe(sig(shoot(GROUND, pass).d));
    }
  });

  it('fills the frame it was given', () => {
    const frame = planFrame(GROUND, REF)!;
    const s = shoot(GROUND, 'line');
    expect([s.w, s.h]).toEqual([frame.width, frame.height]);
  });

  it('cuts an opening as a gap rather than masonry, in every pass that can say so', () => {
    /* The doorways were coming back walled up. Each channel has its own way of
       saying "not masonry here" and getting any one of them wrong is enough:
       ink and line must show a hole, depth must drop back to the floor plane
       (a door left at wall height IS a wall to a depth encoder), and seg must
       class it as door or window. `change` is deliberately absent — it freezes
       an opening at the wall's value, because a doorway free to drift 20 cm is
       a doorway that will. */
    const door = openingCentre(GROUND, 'door');
    const wall = solidWall(GROUND);

    const line = shoot(GROUND, 'line');
    expect(line.px(door)[0]).toBeGreaterThan(231);
    expect(line.px(wall)[0]).toBeLessThan(24);

    const depth = shoot(GROUND, 'depth');
    /* both openings: a window is glass at the cut plane, which is not masonry
       either, and only the line pass draws a mark across it */
    for (const t of ['door', 'window'] as const) {
      expect(depth.px(openingCentre(GROUND, t))[0]).toBeLessThan(80);
    }
    expect(depth.px(wall)[0]).toBeGreaterThan(240);

    const seg = shoot(GROUND, 'seg');
    for (const t of ['door', 'window'] as const) {
      const got = seg.px(openingCentre(GROUND, t));
      expect(key(got[0], got[1], got[2])).toBe(keyOf(segObjectColor(t)));
    }
  });

  it('leaves the walls standing when the furniture is dropped', () => {
    /* The flag has to reach every pass, not just `ink`. A control map still
       carrying a sofa the reference beside it does not have is an instruction to
       put the sofa back — and the empty-shell reference exists precisely to ask
       for a room without one. */
    for (const pass of PASS_KINDS) {
      expect(sig(shoot(GROUND, pass, REF, true).d)).not.toBe(sig(shoot(GROUND, pass, REF, false).d));
    }
    const bare = shoot(GROUND, 'seg', REF, false);
    const groups = new Set(GROUND.items.map(i => keyOf(segObjectColor(CAT_BY_KIND[i.kind]?.group || 'Other'))));
    for (const g of groups) expect(histogram(bare).get(g) || 0).toBe(0);
    expect(bare.px(solidWall(GROUND))[0]).toBe(255);
  });

  describe('line', () => {
    it('is ink or paper and almost nothing in between', () => {
      /* Bimodal on purpose: a control encoder pushes the map through a VAE
         before it sees it, and a drawing made of mid-greys comes out the other
         side as a smudge with no wall in it. The few percent allowed for are
         the antialiased edges of the strokes themselves. */
      const s = shoot(GROUND, 'line');
      let mid = 0, black = 0, white = 0;
      for (let i = 0; i < s.d.length; i += 4) {
        const v = s.d[i];
        if (v < 24) black++; else if (v > 231) white++; else mid++;
      }
      const n = s.d.length / 4;
      expect(white / n).toBeGreaterThan(0.5);
      expect(black / n).toBeGreaterThan(0.01);
      expect(mid / n).toBeLessThan(0.05);
    });

    it('draws the wall mass and leaves the doorways open', () => {
      const s = shoot(GROUND, 'line');
      expect(s.px(solidWall(GROUND))[0]).toBeLessThan(24);
      expect(s.px(bareFloor(GROUND))[0]).toBeGreaterThan(231);
    });
  });

  describe('depth', () => {
    it('is greyscale, with the wall tops nearer than the floor', () => {
      /* The one pass that carries the third dimension. If the wall tops and the
         floor came out at the same level the map would describe a flat sheet,
         and a flat sheet is exactly the dollhouse tilt we are trying to stop. */
      const s = shoot(GROUND, 'depth');
      for (let i = 0; i < s.d.length; i += 4) {
        if (s.d[i] !== s.d[i + 1] || s.d[i] !== s.d[i + 2]) throw new Error(`colour in the depth map at ${i / 4}`);
      }
      const wall = s.px(solidWall(GROUND))[0];
      const floor = s.px(bareFloor(GROUND))[0];
      expect(wall).toBeGreaterThan(240);
      expect(floor).toBeGreaterThan(0);              // floor is not void
      expect(floor).toBeLessThan(80);
      expect(wall - floor).toBeGreaterThan(150);
    });

    it('ramps every object between the floor and the cut', () => {
      /* A wardrobe reaches the 1.2 m cut and a rug does not rise off the floor;
         if these came back equal the depth map would be a silhouette, which is
         what the line pass already is. */
      const f = blankProject('Heights', false).floors[0];
      const wardrobe: Item = { ...makeItem('wardr', { x: 250, y: 300 }) };
      const rug: Item = { ...makeItem('rug', { x: 520, y: 720 }) };
      const floor: Floor = { ...f, items: [wardrobe, rug] };
      const s = shoot(floor, 'depth');
      const bare = s.px({ x: 400, y: 150 })[0];
      expect(heightOf('wardr')).toBeGreaterThan(heightOf('rug'));
      expect(s.px({ x: 250, y: 300 })[0]).toBeGreaterThan(s.px({ x: 520, y: 720 })[0]);
      expect(s.px({ x: 520, y: 720 })[0]).toBeGreaterThan(bare);
    });

    it('gives the overlap of two objects to the taller one, whatever order they were drawn in', () => {
      /* The test above put the wardrobe and the rug in different corners, which
         is why it stayed green while the pass painted in document order: a rug
         added AFTER the wardrobe it lies under punched a floor-level hole clean
         through it (grey 44 where the wardrobe reads 255), and swapping the two
         in the document changed the depth map. A depth map is a max over what is
         there, so the answer must not depend on the array. */
      const base = blankProject('Stack', false).floors[0];
      const at = { x: 400, y: 400 };
      const wardrobe: Item = { ...makeItem('wardr', at) };
      const rug: Item = { ...makeItem('rug', at) };
      expect(heightOf('wardr')).toBeGreaterThan(heightOf('rug'));
      const rugLast = shoot({ ...base, items: [wardrobe, rug] }, 'depth').px(at)[0];
      const rugFirst = shoot({ ...base, items: [rug, wardrobe] }, 'depth').px(at)[0];
      expect(rugLast).toBe(rugFirst);
      expect(rugLast).toBeGreaterThan(240);          // the wardrobe reaches the cut
    });
  });

  describe('seg', () => {
    it('gives every room its own flat colour', () => {
      /* Two rooms sharing a colour are one room to the encoder. The ids of an
         imported plan are freshly generated, so this ran green for a while on a
         palette that collided about once in sixty imports. */
      const s = shoot(UPSTAIRS, 'seg');
      const h = histogram(s);
      const palette = segRoomColors(UPSTAIRS);
      expect(new Set(palette.values()).size).toBe(UPSTAIRS.areas.length);
      const rooms = [...UPSTAIRS.areas].sort((a, b) => polyArea(b.poly) - polyArea(a.poly)).slice(0, 4);
      for (const a of rooms) expect(h.get(keyOf(palette.get(a.id)!)) || 0).toBeGreaterThan(40);
      expect(h.get(keyOf(SEG_WALL)) || 0).toBeGreaterThan(40);
    });

    it('never gives two catalogue groups the same colour', () => {
      /* A fixed set of keys, so a collision here is a static fact rather than
         bad luck — and it would merge, say, every bathroom fitting into the
         staircase. Adding a group is what would break this. */
      const keys = [...CATALOG.map(g => g.group), 'Other', 'door', 'window'];
      expect(new Set(keys.map(segObjectColor)).size).toBe(keys.length);
    });

    it('has no gradients: every region is one exact colour', () => {
      /* Flat is the whole contract of a segmentation channel — a blended edge
         is a class that does not exist. Only the antialiased boundary pixels
         may fall outside the palette. */
      const s = shoot(UPSTAIRS, 'seg');
      /* SEG_INTERIOR is in here as a class and not as slack: the floor between
         this plan's traced rooms is 0.12% of the frame, small enough that leaving
         it out would have gone on passing inside the 8% the antialiased edges
         are allowed, and it is a flat region like any other. */
      const palette = new Set<number>([key(0, 0, 0), keyOf(SEG_WALL), keyOf(SEG_INTERIOR)]);
      segRoomColors(UPSTAIRS).forEach(c => palette.add(keyOf(c)));
      UPSTAIRS.items.forEach(i => palette.add(keyOf(segObjectColor(CAT_BY_KIND[i.kind]?.group || 'Other'))));
      (['door', 'window'] as const).forEach(t => palette.add(keyOf(segObjectColor(t))));
      let exact = 0;
      for (const [k, n] of histogram(s)) if (palette.has(k)) exact += n;
      expect(exact / (s.w * s.h)).toBeGreaterThan(0.92);
    });

    it('keeps a room colour when another room is deleted', () => {
      /* Hashed rather than handed out in document order, so editing one room
         cannot repaint the rest of the plan for the next render.
         Ids are written out here rather than taken off the imported fixture,
         which generates fresh random ones per run: on that plan this test was
         sampling the palette instead of pinning it, and failed about one run in
         twenty whenever two of the eight rooms happened to hash to the same
         hue. The collision case is real and is the test below. */
      const ids = ['kitchen', 'living', 'bath', 'bed1', 'hall'];
      const areas = ids.map(id => ({ ...UPSTAIRS.areas[0], id }));
      const before = segRoomColors({ ...UPSTAIRS, areas });
      const after = segRoomColors({ ...UPSTAIRS, areas: areas.slice(1) });
      areas.slice(1).forEach(a => expect(after.get(a.id)).toBe(before.get(a.id)));

      /* and the surviving colour is one the pass actually lays down */
      const kept = { ...UPSTAIRS, areas: UPSTAIRS.areas.slice(1) };
      const k = keyOf(segRoomColors(kept).get(kept.areas[1].id)!);
      expect(histogram(shoot(kept, 'seg')).get(k)).toBeGreaterThan(0);
    });

    it('gives two rooms that hash alike distinct colours, and hands the hue back', () => {
      /* The walk cannot be removed in the name of stability. Exact distinctness
         and id-only stability cannot both hold — resolving a collision has to
         look at the other rooms — and distinctness wins: two rooms sharing a
         colour tells the encoder they are one region, which is a lie about the
         plan, where a recoloured room is only an inconsistency between renders.
         This is the price, pinned so nobody pays it by accident: `room-aaa` and
         `room-ahj` (found by search) both hash to hue 99, so the second walks,
         and deleting the first gives the hue back to it. */
      const pair = ['room-aaa', 'room-ahj'].map(id => ({ ...UPSTAIRS.areas[0], id }));
      const both = segRoomColors({ ...UPSTAIRS, areas: pair });
      expect(both.get('room-aaa')).not.toBe(both.get('room-ahj'));
      const alone = segRoomColors({ ...UPSTAIRS, areas: [pair[1]] });
      expect(alone.get('room-ahj')).toBe(both.get('room-aaa'));
    });
  });

  describe('the floor inside the walls', () => {
    /** blankProject's own 800×1000 shell — four walls, a window in the top wall
     *  and a door in the left one — with the traced room shrunk into one corner.
     *  The rest of the plan is then floor that is inside the walls and inside no
     *  Area, which is what an open-plan floor nobody has drawn rooms over looks
     *  like, and what depth and seg used to paint as void.
     *
     *  `walls` is how many of the four survive: 3 drops the left wall and leaves
     *  a U ten metres open down one side, which is a plan halfway drawn. */
    function shell(walls = 4, items: Item[] = []) {
      const base = blankProject('Enclosed', false).floors[0];
      const room = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 }];
      const floor: Floor = {
        ...base,
        walls: base.walls.slice(0, walls),
        areas: [{ ...base.areas[0], poly: room }],
        items,
      };
      return {
        floor,
        /* the corner the Area covers, a point of the shell it does not, the
           doorway itself, and a point out of doors a stride past that doorway */
        traced: { x: 150, y: 150 },
        untraced: { x: 600, y: 700 },
        doorway: { x: 0, y: 500 },
        outside: { x: -25, y: 500 },
      };
    }

    it('reads as floor in depth where no room was traced', () => {
      /* The bug this describe block exists for: depth painted a floor only under
         an Area, so the middle of an untraced plan came back at 0 — the same
         value as the ground outside the building, on the only channel that
         carries the third dimension. Measured over the eval fixtures, 81% of the
         interior of `unmapped-open` was that black, and the file's own note on
         FLOOR_DEPTH says a floor that reads as void is how a depth encoder
         invents a hole. */
      const s = shell();
      const d = shoot(s.floor, 'depth');
      expect(d.px(s.untraced)[0]).toBeGreaterThan(0);
      /* the same far plane as a traced floor, not some second-class grey: two
         floor levels in one flat is a step nobody built */
      expect(d.px(s.untraced)[0]).toBe(d.px(s.traced)[0]);
    });

    it('is a floor objects still ramp above', () => {
      /* The far plane has to stay the far plane. An interior painted at any
         height of its own would flatten the ramp the depth pass exists for, and
         a wardrobe level with the floor it stands on is the silhouette the line
         pass already draws. */
      const at = { x: 600, y: 700 };
      const s = shell(4, [{ ...makeItem('wardr', at) }]);
      const d = shoot(s.floor, 'depth');
      const bare = d.px({ x: 400, y: 700 })[0];        // untraced floor beside it
      expect(d.px(at)[0]).toBeGreaterThan(240);        // the wardrobe reaches the cut
      expect(bare).toBeGreaterThan(0);
      expect(bare).toBeLessThan(80);
    });

    it('is its own segmentation class, and takes no room colour with it', () => {
      /* Untraced floor is not a room and not the ground outside: given a room's
         hue it would merge with that room, given black it would say the middle of
         the building is the garden. Grey is what makes it safe — every room and
         object hue is saturated, so no hash can land on this value. */
      const s = shell();
      const g = shoot(s.floor, 'seg');
      const got = g.px(s.untraced);
      expect(key(got[0], got[1], got[2])).toBe(keyOf(SEG_INTERIOR));

      const rooms = segRoomColors(s.floor);
      const room = g.px(s.traced);
      expect(key(room[0], room[1], room[2])).toBe(keyOf(rooms.get(s.floor.areas[0].id)!));
      /* and nothing else in the palette is this colour, on the plans we have */
      const taken = new Set<number>([keyOf(SEG_WALL)]);
      for (const f of [GROUND, UPSTAIRS, s.floor]) segRoomColors(f).forEach(c => taken.add(keyOf(c)));
      [...CATALOG.map(c => c.group), 'Other', 'door', 'window']
        .forEach(k => taken.add(keyOf(segObjectColor(k))));
      expect(taken.has(keyOf(SEG_INTERIOR))).toBe(false);
    });

    it('does not follow a doorway out of the building', () => {
      /* The trap. Every pass cuts its openings back out of the wall mass, so a
         flood run against the walls as they are drawn walks in through the first
         doorway, finds nothing enclosed, and silently paints no floor at all —
         measured, that is the direction it fails in, and seeded from the inside
         instead it would call the whole frame floor. Hence a barrier of whole
         wall mass, which is what lets a doorway be a gap in the picture and a
         closed door to the flood at the same time. */
      const s = shell();
      s.floor.walls[3].openings[0] = { ...s.floor.walls[3].openings[0], width: 200 };
      const d = shoot(s.floor, 'depth');
      const g = shoot(s.floor, 'seg');

      expect(d.px(s.untraced)[0]).toBeGreaterThan(0);  // the inside was filled
      expect(d.px(s.outside)[0]).toBe(0);              // a stride past the door is not
      expect(g.px(s.outside)).toEqual([0, 0, 0]);
      /* the four corners of the frame, reached by clamping — out of doors in
         every direction, and the first thing a leak would flood */
      for (const p of [{ x: -1e6, y: -1e6 }, { x: 1e6, y: -1e6 }, { x: -1e6, y: 1e6 }, { x: 1e6, y: 1e6 }]) {
        expect(d.px(p)[0]).toBe(0);
        expect(g.px(p)).toEqual([0, 0, 0]);
      }
      /* and the gap is still cut in the drawing: not masonry in depth, a door in
         seg. The barrier is a scratch the passes overwrite, not something they
         leave standing. */
      expect(d.px(s.doorway)[0]).toBeLessThan(80);
      const door = g.px(s.doorway);
      expect(key(door[0], door[1], door[2])).toBe(keyOf(segObjectColor('door')));
    });

    it('leaves a plan with no closed loop exactly as it was', () => {
      /* A garden, or half a survey. There is nothing the walls enclose, and the
         fill has to answer that rather than filling in what it wishes were there
         — get the flood backwards and this is the plan that comes back as one
         solid floor from edge to edge. Today's behaviour is the traced Area and
         nothing else, so seg lays down no interior colour at all and depth's
         floor count is the room's own footprint. */
      const open = shell(3), closed = shell(4);
      expect(shoot(open.floor, 'depth').px(open.untraced)[0]).toBe(0);
      expect(histogram(shoot(open.floor, 'seg')).get(keyOf(SEG_INTERIOR)) || 0).toBe(0);
      expect(histogram(shoot(closed.floor, 'seg')).get(keyOf(SEG_INTERIOR)) || 0).toBeGreaterThan(40);

      /* Counted rather than sampled: the traced corner is a ninth of the shell,
         so a fill that had run anyway would show up here even if it had missed
         the one point above. */
      const floorPx = (f: Floor) => {
        const h = histogram(shoot(f, 'depth'));
        let n = 0;
        for (const [k, c] of h) if ((k >> 16) === (k & 255) && (k & 255) > 0 && (k & 255) < 80) n += c;
        return n;
      };
      const area = (f: Floor) => polyArea(f.areas[0].poly);
      expect(area(open.floor)).toBe(area(closed.floor));
      expect(floorPx(open.floor)).toBeLessThan(floorPx(closed.floor) * 0.25);
    });

    it('costs no more than a readback at the sizes the panel asks for', () => {
      /* The flood is a getImageData, a flood and a putImageData, and a readback
         is the one thing a GPU-backed canvas is bad at — it is ten times what the
         rest of the depth pass costs. Pinned loosely, as a tripwire for an
         accidental per-pixel allocation or a second flood, not as a benchmark. */
      const s = shell();
      const frame = planFrame(s.floor, { clean: true, maxPx: 1000 })!;
      const cv = createCanvas(frame.width, frame.height);
      const ctx = cv.getContext('2d');
      const run = () => {
        paintPass(noText(ctx), { floor: s.floor, frame, pass: 'depth', furniture: true });
        return ctx.getImageData(0, 0, frame.width, frame.height).data[0];
      };
      run();
      const t0 = performance.now();
      for (let i = 0; i < 5; i++) run();
      const ms = (performance.now() - t0) / 5;
      expect(frame.width * frame.height).toBeGreaterThan(500_000);
      expect(ms).toBeLessThan(120);
    });
  });

  describe('change', () => {
    it('is darkest on the walls and lightest on open floor', () => {
      /* Black is frozen. The survey — walls and openings — is the one thing a
         differential-diffusion pass must not let move; open floor is the model's
         to fill; the listing's fitted joinery sits between the two. */
      const s = shoot(GROUND, 'change');
      const wall = s.px(solidWall(GROUND))[0];
      const floor = s.px(bareFloor(GROUND))[0];
      const fitted = GROUND.items.find(i => i.fromFunda)!;
      const joinery = s.px({ x: fitted.x, y: fitted.y })[0];
      expect(wall).toBeLessThan(joinery);
      expect(joinery).toBeLessThan(floor);
      expect(wall).toBeLessThan(20);
      expect(floor).toBeGreaterThan(200);
      let min = 255;
      for (let i = 0; i < s.d.length; i += 4) min = Math.min(min, s.d[i]);
      expect(min).toBe(wall);
    });

    it('separates fitted joinery from loose furniture', () => {
      /* Four distinct bands, not three. Every item on the fixture plan is
         `fromFunda`, so the loose band went untested and a change map that
         froze the sofa along with the kitchen would have passed — which is the
         one thing this pass exists to prevent, since restyling the loose
         furniture is the whole point of asking for a render at all. */
      const base = blankProject('Bands', false).floors[0];
      const loose: Item = { ...makeItem('sofa2', { x: 200, y: 250 }) };
      const fitted: Item = { ...makeItem('kcount', { x: 600, y: 250 }) };
      /* the importer only ever brings in fitted things, so provenance alone is
         enough to freeze one — this sofa came off the listing, not off the tray */
      const imported: Item = { ...makeItem('sofa2', { x: 400, y: 700 }), fromFunda: 1 };
      const floor: Floor = { ...base, items: [loose, fitted, imported] };
      const s = shoot(floor, 'change');

      const at = (i: Item) => s.px({ x: i.x, y: i.y })[0];
      expect(CAT_BY_KIND['sofa2'].group).not.toBe(CAT_BY_KIND['kcount'].group);
      expect(s.px(solidWall(floor))[0]).toBeLessThan(at(fitted));
      expect(at(fitted)).toBeLessThan(at(loose));
      expect(at(loose)).toBeLessThan(s.px(bareFloor(floor))[0]);
      expect(at(imported)).toBe(at(fitted));
    });

    it('keeps joinery frozen under a rug laid on top of it', () => {
      /* The bands test above spaced its three items out, so the pass could paint
         in document order and still pass. A rug dropped over a kitchen run
         unfroze the run — 102, the loose value, where the joinery reads 51 — and
         a worktop the model is free to move 60 cm is a different flat. Walls are
         painted last for exactly this reason; items have to obey the same rule. */
      const base = blankProject('Overlap', false).floors[0];
      const at = { x: 400, y: 400 };
      const counter: Item = { ...makeItem('kcount', at) };
      const rug: Item = { ...makeItem('rug', at) };
      expect(CAT_BY_KIND['kcount'].group).toBe('Kitchen');       // fitted
      expect(CAT_BY_KIND['rug'].group).not.toBe('Kitchen');      // loose
      const rugLast = shoot({ ...base, items: [counter, rug] }, 'change').px(at)[0];
      const rugFirst = shoot({ ...base, items: [rug, counter] }, 'change').px(at)[0];
      expect(rugLast).toBe(rugFirst);
      const alone = shoot({ ...base, items: [counter] }, 'change').px(at)[0];
      expect(rugLast).toBe(alone);
    });
  });

  describe('ink', () => {
    it('is the clean reference the app already sends', () => {
      /* Same paint(), same layer set: rooms without their names, furniture
         without its labels, no chains and no notes. */
      const s = shoot(GROUND, 'ink');
      const paper = s.px({ x: -1e6, y: -1e6 });      // clamps to the top-left corner
      expect(paper).toEqual([243, 240, 231]);
      expect(s.px(solidWall(GROUND))[0]).toBeLessThan(60);
    });

    it('drops the furniture when it is asked to', () => {
      const frame = planFrame(GROUND, REF)!;
      const shotWith = (furniture: boolean) => {
        const cv = createCanvas(frame.width, frame.height);
        const ctx = cv.getContext('2d');
        paintPass(noText(ctx), { floor: GROUND, frame, pass: 'ink', furniture });
        return sig(ctx.getImageData(0, 0, frame.width, frame.height).data);
      };
      expect(shotWith(true)).not.toBe(shotWith(false));
    });
  });
});
