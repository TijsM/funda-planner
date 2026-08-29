import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import {
  CEILING_CM, DOOR_HEAD_CM, EYE_CM, NEAR_CM, WINDOW_SILL_CM, autoCam, camBasis, camInside,
  camRoom, newCam, normaliseCam, povFrame, project, sightLine, sightPolygon, toView, type Cam,
} from '@engine/camera';
import { buildScene, triangulate } from '@engine/scene';
import { idsInShot, paintPovPass, rasterizeFloor } from '@engine/pov';
import { PASS_KINDS, SEG_WALL, segObjectColor, segRoomColors, type PassKind } from '@engine/passes';
import { makeItem, newProject } from '@engine/model';
import { buildPrompt, headWords } from '@engine/prompt';
import type { Floor, Opening, Wall } from '@engine/types';

/** The eye-level renderer, drawn through @napi-rs/canvas onto real pixels.
 *
 *  The same rule as `passes.test.ts`: every assertion is a property of the
 *  bitmap, not of the calls that made it. What goes wrong with a conditioning
 *  image is never that a method was not called — and in three dimensions it is
 *  usually a sign, which produces a picture that looks entirely plausible and is
 *  mirrored, inside out, or of the room next door. */

/* ── a room to stand in ─────────────────────────────────────────── */

let seq = 0;
const id = (p: string) => `${p}${++seq}`;

const wall = (
  ax: number, ay: number, bx: number, by: number, openings: Opening[] = [], t = 20,
): Wall => ({ id: id('w'), a: { x: ax, y: ay }, b: { x: bx, y: by }, t, openings });

const opening = (at: number, type: 'door' | 'window', width: number): Opening =>
  ({ id: id('o'), at, type, width });

/** `newProject` and NOT `blankProject`, which is the app's "new plan" command
 *  and comes furnished with a room, a door and a window. */
const emptyFloor = (): Floor => newProject('fixture').floors[0];

/** The box: 600 cm across, 700 cm deep, walls 20 cm thick, with one room traced
 *  over the whole of it. Optionally a window in the far (south) wall and a door
 *  in the near (north) one, which is behind every camera below.
 *
 *  Axis-aligned and deliberately deeper than it is wide, so that from `SOUTH`
 *  the bottom of the frame lands on floor rather than on the foot of the far
 *  wall — every expectation below is worked out by hand from those numbers and
 *  a shallower room quietly changes what each sample is looking at. */
function boxRoom(openings: { window?: boolean; door?: boolean } = {}): Floor {
  const f = emptyFloor();
  f.walls = [
    wall(0, 0, 600, 0, openings.door ? [opening(0.5, 'door', 90)] : []),
    wall(600, 0, 600, 700),
    wall(600, 700, 0, 700, openings.window ? [opening(0.5, 'window', 200)] : []),
    wall(0, 700, 0, 0),
  ];
  f.areas = [{
    id: 'room-box',
    poly: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 700 }, { x: 0, y: 700 }],
    name: 'Box', color: '#DDD', nx: 0, ny: 0, label: true,
  }];
  return f;
}

/** Standing 100 cm inside the near wall, on the room's axis, looking south —
 *  down the page, +y, which is yaw 90. Every directional expectation below is
 *  anchored on this: the far wall's inner face is 590 cm ahead and dead centre,
 *  and the bottom row of the frame lands on floor 303 cm out. */
const SOUTH: Cam = newCam({ x: 300, y: 100, z: EYE_CM, yaw: 90 });

interface Shot { w: number; h: number; d: Uint8ClampedArray; at: (fx: number, fy: number) => [number, number, number] }

function shoot(floor: Floor, cam: Cam, pass: PassKind, maxPx = 320): Shot {
  const fr = povFrame(cam, { maxPx });
  const cv = createCanvas(fr.width, fr.height);
  const ctx = cv.getContext('2d');
  paintPovPass(ctx as never, { floor, frame: fr, pass });
  const d = ctx.getImageData(0, 0, fr.width, fr.height).data;
  return {
    w: fr.width, h: fr.height, d,
    /** the pixel at a fraction of the way across and down the frame */
    at(fx, fy) {
      const x = Math.min(fr.width - 1, Math.max(0, Math.round(fx * fr.width)));
      const y = Math.min(fr.height - 1, Math.max(0, Math.round(fy * fr.height)));
      const i = (y * fr.width + x) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    },
  };
}

const key = (c: [number, number, number]) => (c[0] << 16) | (c[1] << 8) | c[2];
const keyOf = (css: string) => {
  const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(css)!;
  return key([+m[1], +m[2], +m[3]]);
};

function histogram(s: Shot): Map<number, number> {
  const h = new Map<number, number>();
  for (let i = 0; i < s.d.length; i += 4) {
    const k = key([s.d[i], s.d[i + 1], s.d[i + 2]]);
    h.set(k, (h.get(k) || 0) + 1);
  }
  return h;
}

/* ── the projection ─────────────────────────────────────────────── */

describe('camBasis', () => {
  /** The one worked example the file's own comment is written around, and the
   *  only defence against a render that is mirrored — which is the error a
   *  plausible picture hides best, because a symmetrical room looks identical
   *  either way and an asymmetrical one just looks like a different room. */
  it('faces north up the page, with east on its right hand', () => {
    /* y grows DOWN the page, so north — the top — is -y, which is yaw 270. */
    const b = camBasis(newCam({ yaw: 270 }));
    expect(b.f.x).toBeCloseTo(0);
    expect(b.f.y).toBeCloseTo(-1);
    expect(b.r.x).toBeCloseTo(1);            // east, i.e. screen right
    expect(b.r.y).toBeCloseTo(0);
    expect(b.u.z).toBeCloseTo(1);            // and up is up
  });

  it('keeps its three axes orthonormal at every pitch', () => {
    for (const pitch of [-45, -10, 0, 17, 50]) {
      const b = camBasis(newCam({ yaw: 33, pitch }));
      const dot = (p: typeof b.f, q: typeof b.f) => p.x * q.x + p.y * q.y + p.z * q.z;
      for (const v of [b.f, b.r, b.u]) expect(dot(v, v)).toBeCloseTo(1);
      expect(dot(b.f, b.r)).toBeCloseTo(0);
      expect(dot(b.f, b.u)).toBeCloseTo(0);
      expect(dot(b.r, b.u)).toBeCloseTo(0);
    }
  });
});

describe('project', () => {
  const fr = povFrame(SOUTH, { maxPx: 600 });

  it('puts what the camera looks at in the middle of the frame', () => {
    const straightAhead = { x: 300, y: 690, z: EYE_CM };
    const p = project(fr, toView(fr.basis, straightAhead));
    expect(p.x).toBeCloseTo(fr.width / 2, 4);
    expect(p.y).toBeCloseTo(fr.height / 2, 4);
  });

  it('puts the floor below the middle and the ceiling above it', () => {
    const floorY = project(fr, toView(fr.basis, { x: 300, y: 690, z: 0 })).y;
    const ceilY = project(fr, toView(fr.basis, { x: 300, y: 690, z: CEILING_CM })).y;
    expect(floorY).toBeGreaterThan(fr.height / 2);
    expect(ceilY).toBeLessThan(fr.height / 2);
  });

  /** Facing +y, the camera's right hand points to -x. Getting this backwards is
   *  the mirrored render, and it is invisible in a symmetrical room. */
  it('puts a point to the camera-right of the axis on the right of the frame', () => {
    const p = project(fr, toView(fr.basis, { x: 100, y: 690, z: EYE_CM }));
    expect(p.x).toBeGreaterThan(fr.width / 2);
    const q = project(fr, toView(fr.basis, { x: 500, y: 690, z: EYE_CM }));
    expect(q.x).toBeLessThan(fr.width / 2);
  });

  it('makes the same thing smaller the further away it is', () => {
    const span = (y: number) =>
      project(fr, toView(fr.basis, { x: 400, y, z: EYE_CM })).x
      - project(fr, toView(fr.basis, { x: 200, y, z: EYE_CM })).x;
    expect(Math.abs(span(200))).toBeGreaterThan(Math.abs(span(800)));
  });

  /** The fov is horizontal, and it is the field the frame's width subtends —
   *  not its diagonal and not its height, which is a factor of 1.5 out on a 3:2
   *  frame and looks like "the render is slightly too zoomed in". */
  it('fills exactly the frame width with the field of view', () => {
    const f = povFrame(newCam({ x: 0, y: 0, yaw: 0, fov: 90 }), { maxPx: 600 });
    /* at 90° horizontal, the frustum's edge is at 45°: x = z */
    expect(project(f, { x: 100, y: 0, z: 100 }).x).toBeCloseTo(f.width, 4);
    expect(project(f, { x: -100, y: 0, z: 100 }).x).toBeCloseTo(0, 4);
  });
});

describe('normaliseCam', () => {
  it('pulls every field into a range a projection can survive', () => {
    const c = normaliseCam({ x: NaN, y: 5, z: 9999, yaw: -90, pitch: 400, fov: 0 });
    expect(c.x).toBe(0);
    expect(c.y).toBe(5);
    expect(c.z).toBeLessThan(CEILING_CM);
    expect(c.z).toBeGreaterThan(0);
    expect(c.yaw).toBe(270);
    expect(Math.abs(c.pitch)).toBeLessThanOrEqual(60);
    expect(c.fov).toBeGreaterThan(0);
  });

  it('leaves a camera somebody actually placed alone', () => {
    const c: Cam = { x: 412, y: -80, z: 150, yaw: 33, pitch: -5, fov: 75 };
    expect(normaliseCam(c)).toEqual(c);
  });
});

/* ── the massing ────────────────────────────────────────────────── */

describe('buildScene', () => {
  it('gives a bare box a floor, a ceiling and four walls', () => {
    const faces = buildScene(boxRoom());
    const of = (cls: string) => faces.filter(f => f.cls === cls).length;
    expect(of('floor')).toBe(1);
    expect(of('ceiling')).toBe(1);
    expect(of('room')).toBe(1);
    expect(of('wall')).toBeGreaterThan(4);
    expect(faces.every(f => f.pts.length >= 3)).toBe(true);
  });

  /** A plan with fewer than three walls cannot enclose anything, and the
   *  commonest one is a garden. The same threshold `groundEnclosed` uses. */
  it('puts no ceiling over a plan that encloses nothing', () => {
    const f = boxRoom();
    f.walls = f.walls.slice(0, 2);
    expect(buildScene(f).some(x => x.cls === 'ceiling')).toBe(false);
  });

  it('glazes a window and leaves a doorway open', () => {
    const glazed = buildScene(boxRoom({ window: true }));
    expect(glazed.filter(f => f.cls === 'window')).toHaveLength(1);
    const g = glazed.find(f => f.cls === 'window')!;
    /* the glass spans sill to head and nothing below it */
    expect(Math.min(...g.pts.map(p => p.z))).toBeCloseTo(WINDOW_SILL_CM);
    /* a door is a hole: no face of its own, at any height */
    expect(buildScene(boxRoom({ door: true })).some(f => f.cls === 'window')).toBe(false);
  });

  /** The elevation is cut around every aperture. A wall that still spans the
   *  full height where a door is, is a walled-up doorway in the render. */
  it('cuts the wall away where an opening is', () => {
    const plain = buildScene(boxRoom());
    const holed = buildScene(boxRoom({ door: true }));
    /* Covers the doorway, rather than having a vertex in it: an uncut elevation
       is ONE panel running the length of the wall, so its only x values are 0
       and 600 and a vertex test would call the unbroken wall broken. */
    const spansDoorway = (faces: ReturnType<typeof buildScene>) => faces.some(f => {
      const x = f.pts.map(p => p.x), z = f.pts.map(p => p.z);
      return f.cls === 'wall'
        && f.pts.every(p => Math.abs(p.y) < 11)              // either face of the north wall
        && Math.min(...x) <= 255 && Math.max(...x) >= 345    // right across the doorway
        && Math.min(...z) < 1 && Math.max(...z) > DOOR_HEAD_CM;
    });
    expect(spansDoorway(plain)).toBe(true);
    expect(spansDoorway(holed)).toBe(false);
  });

  it('stands every object on the floor at its catalogue height', () => {
    const f = boxRoom();
    f.items = [makeItem('sofa3', { x: 300, y: 200 })];
    const boxes = buildScene(f).filter(x => x.cls === 'item');
    expect(boxes.length).toBe(5);                            // four sides and a top
    const top = Math.max(...boxes.flatMap(b => b.pts.map(p => p.z)));
    expect(top).toBeCloseTo(85);                             // Z.sofa3
    expect(Math.min(...boxes.flatMap(b => b.pts.map(p => p.z)))).toBeCloseTo(0);
    expect(buildScene(f, { furniture: false }).some(x => x.cls === 'item')).toBe(false);
  });
});

describe('triangulate', () => {
  const area = (pts: { x: number; y: number; z: number }[], tris: [number, number, number][]) =>
    tris.reduce((sum, [a, b, c]) => sum + Math.abs(
      (pts[b].x - pts[a].x) * (pts[c].y - pts[a].y) - (pts[b].y - pts[a].y) * (pts[c].x - pts[a].x),
    ) / 2, 0);

  it('covers a convex outline exactly once', () => {
    const sq = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }];
    expect(area(sq, triangulate(sq))).toBeCloseTo(100);
  });

  /** The case a triangle fan gets wrong, and the reason this exists at all: a
   *  room traced round a chimney breast. A fan would paint floor across the
   *  notch, which is a floor where the plan says there is masonry. */
  it('covers a concave outline without spilling into the notch', () => {
    const ell = [
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 4, z: 0 },
      { x: 4, y: 4, z: 0 }, { x: 4, y: 10, z: 0 }, { x: 0, y: 10, z: 0 },
    ];
    expect(area(ell, triangulate(ell))).toBeCloseTo(64);      // 100 - 36
  });

  it('handles a vertical outline, which projects to a line on the floor', () => {
    const panel = [
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 5 }, { x: 0, y: 0, z: 5 },
    ];
    expect(triangulate(panel)).toHaveLength(2);
  });
});

/* ── the rasteriser ─────────────────────────────────────────────── */

describe('rasterize', () => {
  it('leaves nothing unpainted from inside a closed room', () => {
    const buf = rasterizeFloor(boxRoom(), povFrame(SOUTH, { maxPx: 240 }));
    expect([...buf.face].every(v => v >= 0)).toBe(true);
  });

  /** The depth test, stated as the thing it is for. A box between the camera
   *  and the far wall must be what the camera sees; painted in document order
   *  instead, whichever was added last wins and the sofa is behind the wall. */
  it('lets the nearer surface win, whatever order it was added in', () => {
    const bare = rasterizeFloor(boxRoom(), povFrame(SOUTH, { maxPx: 240 }));
    const f = boxRoom();
    f.items = [makeItem('wardr', { x: 300, y: 250 })];        // 200 cm tall, right in front
    const blocked = rasterizeFloor(f, povFrame(SOUTH, { maxPx: 240 }));
    const mid = Math.floor(bare.face.length / 2) + bare.width / 2;
    expect(blocked.depth[mid]).toBeLessThan(bare.depth[mid]);
    expect(blocked.faces[blocked.face[mid]].cls).toBe('item');
  });

  /** A wall the camera is standing against crosses the near plane. Dropped, it
   *  leaves a hole in the middle of the picture; projected uncut, it is drawn
   *  inside out across the whole frame. */
  it('clips rather than drops a surface the camera is inside', () => {
    /* Backed into the north-west corner. The floor and ceiling slabs both run
       from behind the camera to in front of it, so both cross the near plane. */
    const tight = newCam({ x: 25, y: 25, z: EYE_CM, yaw: 45 });
    const buf = rasterizeFloor(boxRoom(), povFrame(tight, { maxPx: 240 }));
    expect([...buf.face].every(v => v >= 0)).toBe(true);
    expect(buf.near).toBeGreaterThanOrEqual(NEAR_CM);
  });

  it('reports the range of what it actually drew', () => {
    const buf = rasterizeFloor(boxRoom(), povFrame(SOUTH, { maxPx: 240 }));
    expect(buf.near).toBeGreaterThan(0);
    expect(buf.far).toBeGreaterThan(buf.near);
    /* the far wall's inner face is 590 cm out, and the corners of the room a
       little more — nothing in a closed box is further away than its diagonal */
    expect(buf.far).toBeLessThan(1000);
  });
});

/* ── the passes ─────────────────────────────────────────────────── */

describe('paintPovPass', () => {
  it('draws no two passes the same', () => {
    const shots = PASS_KINDS.map(p => shoot(boxRoom({ window: true }), SOUTH, p).d.join(','));
    expect(new Set(shots).size).toBe(PASS_KINDS.length);
  });

  it('is deterministic', () => {
    const a = shoot(boxRoom({ window: true }), SOUTH, 'ink');
    const b = shoot(boxRoom({ window: true }), SOUTH, 'ink');
    expect(a.d.join(',')).toBe(b.d.join(','));
  });

  describe('depth', () => {
    /** Near is white, the same sentence the top-down pass is written under. A
     *  depth map with the sign flipped is a room turned inside out, and it is
     *  the single most consequential bit in this file. */
    it('makes the floor at your feet brighter than the far wall', () => {
      const s = shoot(boxRoom(), SOUTH, 'depth');
      const underfoot = s.at(0.5, 0.97)[0];
      const farWall = s.at(0.5, 0.5)[0];
      expect(underfoot).toBeGreaterThan(farWall + 40);
    });

    /** The reason the ramp is logarithmic. Measured on `nl-ground`, straight
     *  inverse depth put everything past 3 m inside twelve grey levels of black
     *  because the camera stood 95 cm off the near wall. */
    it('spreads a room across the range instead of crushing it into black', () => {
      const corner = newCam({ x: 60, y: 60, z: EYE_CM, yaw: 55 });
      const s = shoot(boxRoom(), corner, 'depth', 200);
      const levels = new Set<number>();
      for (let i = 0; i < s.d.length; i += 4) levels.add(s.d[i] >> 4);
      /* at least half of the sixteen coarse bands are occupied */
      expect(levels.size).toBeGreaterThanOrEqual(8);
    });
  });

  describe('seg', () => {
    it('paints the wall mass the same white the plan does', () => {
      const s = shoot(boxRoom(), SOUTH, 'seg');
      expect(key(s.at(0.5, 0.5))).toBe(keyOf(SEG_WALL));
    });

    /** The palette is shared with `passes.ts` on purpose: a room that is one
     *  colour from above and another from inside is two rooms to an encoder. */
    it('gives the floor the same colour the top-down map gives that room', () => {
      const f = boxRoom();
      const s = shoot(f, SOUTH, 'seg');
      expect(key(s.at(0.5, 0.97))).toBe(keyOf(segRoomColors(f).get('room-box')!));
    });

    /** A window painted as wall is a wall to the encoder, and a ceiling painted
     *  as wall is a room with no top to it. Both are regions in their own right
     *  and both take a colour of their own — out of the same hashed palette, so
     *  neither can collide with a room or a catalogue group. */
    it('paints the ceiling and the glass as classes of their own', () => {
      const h = histogram(shoot(boxRoom({ window: true }), SOUTH, 'seg'));
      for (const k of ['ceiling', 'window']) {
        expect(h.get(keyOf(segObjectColor(k))) ?? 0, k).toBeGreaterThan(20);
      }
    });

    it('has no gradients: every region is one exact colour', () => {
      const f = boxRoom({ window: true });
      f.items = [makeItem('sofa3', { x: 300, y: 300 })];
      const s = shoot(f, SOUTH, 'seg');
      const palette = new Set<number>([
        key([0, 0, 0]), keyOf(SEG_WALL), keyOf(segObjectColor('ceiling')),
        keyOf(segObjectColor('window')), keyOf(segObjectColor('Living')),
      ]);
      segRoomColors(f).forEach(c => palette.add(keyOf(c)));
      let exact = 0;
      for (const [k, n] of histogram(s)) if (palette.has(k)) exact += n;
      expect(exact / (s.w * s.h)).toBeGreaterThan(0.99);
    });
  });

  describe('line', () => {
    it('is ink or paper and almost nothing in between', () => {
      const s = shoot(boxRoom({ window: true }), SOUTH, 'line');
      let mid = 0;
      for (let i = 0; i < s.d.length; i += 4) if (s.d[i] > 24 && s.d[i] < 231) mid++;
      expect(mid / (s.w * s.h)).toBeLessThan(0.01);
    });

    /** The whole reason the edges are read off the face buffer instead of by
     *  projecting every polygon: a wall cut into four panels around a doorway is
     *  one wall, and a line where two of them meet is a mullion the render will
     *  build. */
    it('draws the corners of a room but not the seams inside one wall', () => {
      const plain = shoot(boxRoom(), SOUTH, 'line');
      const holed = shoot(boxRoom({ door: true }), SOUTH, 'line');
      const inked = (s: Shot) => {
        let n = 0;
        for (let i = 0; i < s.d.length; i += 4) if (s.d[i] < 128) n++;
        return n;
      };
      /* a room has corners */
      expect(inked(plain)).toBeGreaterThan(0);
      /* and the door in the wall BEHIND the camera adds none of its own */
      expect(inked(holed)).toBe(inked(plain));
    });
  });

  describe('ink', () => {
    /** The failure this pass was rebuilt to prevent: at one point the floor and
     *  the wall standing on it came out the same grey, because the light's swing
     *  was wider than the gap between their tones. A junction that is not there
     *  is a picture in which the room has no walls. */
    it('keeps the floor, the walls and the ceiling apart', () => {
      const s = shoot(boxRoom(), SOUTH, 'ink');
      const floor = s.at(0.5, 0.97)[0];
      const wall = s.at(0.5, 0.5)[0];
      const ceiling = s.at(0.5, 0.03)[0];
      expect(wall - floor).toBeGreaterThan(20);
      expect(ceiling - wall).toBeGreaterThan(20);
    });

    /** A window is the bright thing in an interior photograph, and the render
     *  puts daylight wherever this picture is brightest. */
    it('blows the glass out brighter than anything around it', () => {
      const s = shoot(boxRoom({ window: true }), SOUTH, 'ink');
      expect(s.at(0.5, 0.44)[0]).toBeGreaterThan(s.at(0.5, 0.75)[0] + 60);
    });

    it('outlines an object even where its shading matches the wall behind it', () => {
      const f = boxRoom();
      f.items = [makeItem('sofa3', { x: 300, y: 640 })];      // pushed against the far wall
      const s = shoot(f, SOUTH, 'ink', 400);
      /* somewhere down the sofa's silhouette there is ink */
      let dark = 0;
      for (let i = 0; i < s.d.length; i += 4) if (s.d[i] < 40) dark++;
      expect(dark).toBeGreaterThan(20);
    });
  });

  describe('change', () => {
    it('freezes the shell and frees the floor', () => {
      const s = shoot(boxRoom(), SOUTH, 'change');
      expect(s.at(0.5, 0.5)[0]).toBeLessThan(40);             // the far wall
      expect(s.at(0.5, 0.97)[0]).toBeGreaterThan(200);        // the floor at your feet
    });
  });
});

/* ── placing one ────────────────────────────────────────────────── */

describe('autoCam', () => {
  it('stands inside the room it names, looking at its window', () => {
    const f = boxRoom({ window: true });
    const c = autoCam(f)!;
    expect(c).not.toBeNull();
    expect(camInside(f, c)).toBe(true);
    expect(camRoom(f, c)?.id).toBe('room-box');
    /* the window is in the south wall, so it must be looking south-ish: yaw 90 */
    expect(Math.abs(c.yaw - 90)).toBeLessThan(60);
  });

  it('stands back from what it is looking at rather than on top of it', () => {
    const f = boxRoom({ window: true });
    const c = autoCam(f)!;
    /* the window is at y = 700; a camera worth the name is not next to it */
    expect(c.y).toBeLessThan(350);
    expect(sightLine(f, c)).toBeGreaterThan(150);
  });

  it('is the same camera every time it is asked', () => {
    const f = boxRoom({ window: true });
    expect(autoCam(f)).toEqual(autoCam(f));
  });

  it('falls back to the building when no room has been traced', () => {
    const f = boxRoom({ window: true });
    f.areas = [];
    const c = autoCam(f)!;
    expect(c).not.toBeNull();
    expect(camInside(f, c)).toBe(true);
  });

  it('has nothing to guess from on an empty floor', () => {
    expect(autoCam(emptyFloor())).toBeNull();
  });
});

describe('sightPolygon', () => {
  const pointIn = (poly: { x: number; y: number }[], pt: { x: number; y: number }) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if ((poly[i].y > pt.y) !== (poly[j].y > pt.y)
        && pt.x < ((poly[j].x - poly[i].x) * (pt.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) {
        inside = !inside;
      }
    }
    return inside;
  };

  /** The defect this replaced a circular wedge to fix. The wedge took ONE radius
   *  from the centre ray and swept it across the whole field of view, so it ran
   *  through masonry and out the other side — and what it laid over two rooms
   *  away was exactly what the brief was listing. The visibility test never
   *  agreed with it, being a depth buffer; only the picture of it was wrong,
   *  which is the worse of the two places. */
  it('stops at a wall instead of sweeping through it', () => {
    const f = boxRoom();
    f.walls.push(wall(0, 350, 600, 350));               // a solid partition
    const poly = sightPolygon(f, SOUTH);
    /* just this side of the partition is in view */
    expect(pointIn(poly, { x: 300, y: 320 })).toBe(true);
    /* the far side of it is not, at any offset across the frame */
    for (const x of [150, 300, 450]) {
      expect(pointIn(poly, { x, y: 500 }), `x=${x}`).toBe(false);
    }
  });

  /** A doorway is a hole from the floor to 210 cm and the eye is at 155, so the
   *  ray goes through — which is what the massing does, where a door is an
   *  absence of geometry. Glazing is the opposite case for the matching reason:
   *  `scene.ts` puts a pane across a window and the depth buffer stops there. */
  it('sees through a doorway and not through a window', () => {
    const doorway = boxRoom();
    doorway.walls.push(wall(0, 350, 600, 350, [opening(0.5, 'door', 220)]));
    expect(pointIn(sightPolygon(doorway, SOUTH), { x: 300, y: 500 })).toBe(true);

    const glazed = boxRoom();
    glazed.walls.push(wall(0, 350, 600, 350, [opening(0.5, 'window', 220)]));
    expect(pointIn(sightPolygon(glazed, SOUTH), { x: 300, y: 500 })).toBe(false);
  });

  /** The point of the whole change: the region drawn on the minimap and the set
   *  the brief is built from have to be one answer. A cone that covers an object
   *  the brief leaves out — or leaves out one the brief lists — is a second
   *  opinion about what is in the photograph. */
  it('agrees with idsInShot about what is in the picture', () => {
    const f = boxRoom();
    f.walls.push(wall(0, 350, 600, 350, [opening(0.5, 'door', 220)]));
    f.items = [
      { ...makeItem('sofa3', { x: 300, y: 250 }), id: 'near' },
      { ...makeItem('sofa3', { x: 300, y: 500 }), id: 'through' },
      { ...makeItem('sofa3', { x: 90, y: 500 }), id: 'walled' },
    ];
    const poly = sightPolygon(f, SOUTH);
    const seen = idsInShot(f, SOUTH);
    for (const it of f.items) {
      expect(pointIn(poly, { x: it.x, y: it.y }), it.id).toBe(seen.has(it.id));
    }
    /* and it is not vacuously agreeing by excluding everything */
    expect(seen.has('through')).toBe(true);
    expect(seen.has('walled')).toBe(false);
  });

  it('closes on the camera, so the region is a fan and not a ribbon', () => {
    const poly = sightPolygon(boxRoom(), SOUTH);
    expect(poly[0]).toEqual({ x: SOUTH.x, y: SOUTH.y });
    expect(poly.length).toBeGreaterThan(20);
  });
});

describe('sightLine', () => {
  it('measures to the wall ahead and ignores the ones behind', () => {
    /* from y = 100 looking south, the far wall's centreline is at y = 700 */
    expect(sightLine(boxRoom(), SOUTH)).toBeCloseTo(600, 0);
  });

  it('reports the near wall when the camera is turned round', () => {
    expect(sightLine(boxRoom(), newCam({ x: 300, y: 100, yaw: 270 }))).toBeCloseTo(100, 0);
  });
});

/* ── the brief the camera writes ────────────────────────────────── */

describe('buildPrompt, with a camera placed', () => {
  const base = { view: 'eye' as const, room: '*', furniture: true, dimensions: true };
  const room = () => {
    const f = boxRoom({ window: true, door: true });
    f.items = [makeItem('sofa3', { x: 300, y: 600 })];
    return f;
  };

  it('stops describing a drawing and starts describing the shot', () => {
    const f = room();
    const out = buildPrompt(f, { ...base, camera: autoCam(f)! });
    expect(out).toMatch(/Shot from exactly where image 1 was shot/);
    expect(out).toMatch(/grey untextured 3D model/);
    /* and says what the grey is FOR — without this the model reads it as a
       colour scheme and returns a grey room */
    expect(out).toMatch(/give every grey surface a real material/i);
    /* the rule that survives on every branch */
    expect(out).toMatch(/Do not add, remove or rearrange walls/);
  });

  it('names the room the camera is standing in', () => {
    const f = room();
    expect(buildPrompt(f, { ...base, camera: autoCam(f)! })).toMatch(/in the box/);
  });

  /** There is no north in a photograph taken from inside a room. The line is a
   *  fact about a drawing seen from above, and it stays on every other view. */
  it('drops the compass', () => {
    const f = room();
    expect(buildPrompt(f, { ...base, camera: autoCam(f)! })).not.toMatch(/North is at the top/);
    expect(buildPrompt(f, base)).toMatch(/North is at the top/);
    expect(buildPrompt(f, { ...base, view: 'top' })).toMatch(/North is at the top/);
  });

  /** The camera's two sentences replace the view's guesswork rather than joining
   *  it. Both at once would give the model two cameras and let it pick — and the
   *  words are the half it weighs more heavily late in a brief, which is the
   *  wrong half. */
  it('replaces the guessed camera rather than adding to it', () => {
    const f = room();
    const out = buildPrompt(f, { ...base, camera: autoCam(f)! });
    expect(out).not.toMatch(/looking towards the windows/);
    expect(buildPrompt(f, base)).toMatch(/looking towards the windows/);
  });

  /** Same budget as every other view. The first draft of these two sentences
   *  came to 116 words against the 80 BFL's guide documents, which is how the
   *  enumeration and the "do not move the camera" clause came out. */
  it('stays inside the documented word window', () => {
    const f = room();
    const n = headWords(buildPrompt(f, { ...base, camera: autoCam(f)! }));
    expect(n).toBeLessThanOrEqual(80);
    expect(n).toBeGreaterThanOrEqual(30);
  });

  /** The failure this whole branch exists for, and it was not the model
   *  inventing: the tables are read as the authority on what is in the room —
   *  LOCKED says "do not invent or omit", OBJECTS says "each one is already
   *  drawn on the plan; keep it exactly where it is" — so a brief listing the
   *  whole floor's furniture had a camera pointed at a kitchen render the
   *  dining table, the fireplace and the staircase from three rooms away too.
   *  It was obeying us. */
  it('lists only the objects the camera can see', () => {
    const f = boxRoom({ window: true });
    f.items = [
      { ...makeItem('sofa3', { x: 300, y: 550 }), id: 'ahead', label: 'Front sofa' },
      { ...makeItem('wardr', { x: 300, y: 40 }), id: 'behind', label: 'Back wardrobe' },
    ];
    /* case-insensitive: `objectName` lowercases a label for the table */
    const out = buildPrompt(f, { ...base, camera: SOUTH });
    expect(out).toMatch(/front sofa/i);
    expect(out).not.toMatch(/back wardrobe/i);
    /* and with no camera the whole floor is described, as it always was */
    const all = buildPrompt(f, base);
    expect(all).toMatch(/front sofa/i);
    expect(all).toMatch(/back wardrobe/i);
  });

  it('says outright that the tables are one photograph and not the floor', () => {
    const f = room();
    expect(buildPrompt(f, { ...base, camera: autoCam(f)! }))
      .toMatch(/what this one photograph shows, not the whole floor/);
  });

  /** A compass bearing is corroborated by nothing a person standing in the room
   *  can see, and the plan-relative address points at the wrong block entirely:
   *  the left wall of the drawing is behind you, or on your right, depending
   *  only on which way you turned. */
  it('addresses objects from the camera rather than from the plan', () => {
    const f = boxRoom({ window: true });
    f.items = [{ ...makeItem('sofa3', { x: 120, y: 550 }), id: 'left', label: 'Corner sofa' }];
    const out = buildPrompt(f, { ...base, camera: SOUTH });
    /* facing +y, the camera's right hand points to -x, so a sofa at x = 120 is
       on its right — the opposite of the "left" a top-down reading would give */
    expect(out).toMatch(/corner sofa \| right of frame/i);
    expect(out).not.toMatch(/against the .* wall/);
    /* the ROOMS table drops its compass column with it */
    expect(out).not.toMatch(/^Room \| Where/m);
  });

  it('describes the daylight by what is in shot, not by which elevation', () => {
    const f = room();
    const seen = buildPrompt(f, { ...base, camera: autoCam(f)! });
    expect(seen).toMatch(/window is in shot|windows are in shot/);
    expect(seen).toMatch(/Do not add windows or doors that are not in the picture/);
    expect(seen).not.toMatch(/Windows on the .* side/);
    /* turned to face the blank wall, it says so rather than inventing one */
    const away = buildPrompt(f, { ...base, camera: newCam({ x: 300, y: 600, z: EYE_CM, yaw: 270 }) });
    expect(away).toMatch(/No window is in shot/);
  });

  /** A floor total invites the rest of the floor into the frame — and it is the
   *  one number in this brief that is shaped like something to draw. */
  it('drops the floor total and the floor-wide counts', () => {
    const f = room();
    const out = buildPrompt(f, { ...base, dimensions: true, camera: autoCam(f)! });
    expect(out).not.toMatch(/over \d+ named rooms?/);
    expect(out).not.toMatch(/doorways? connects? the rooms/);
  });

  /** An unannounced depth ramp comes back painted onto the floor as a grey
   *  gradient — that is why every attached map gets a sentence. A ramp announced
   *  with the WRONG sentence is that, plus an instruction to build the room
   *  inside out: from above brighter means higher off the floor, and from a
   *  camera in the room it means nearer the lens. */
  it('describes the depth map by distance, not by height', () => {
    const f = room();
    const cam = autoCam(f)!;
    const withCam = buildPrompt(f, { ...base, camera: cam, controls: ['depth', 'line'] });
    expect(withCam).toMatch(/brighter is nearer the camera/);
    expect(withCam).not.toMatch(/higher above the floor/);
    /* and from above it still says the thing that is true from above */
    expect(buildPrompt(f, { ...base, view: 'top', controls: ['depth'] }))
      .toMatch(/brighter is higher above the floor/);
  });

  /** The camera is a fact about the eye-level view, and the brief for every
   *  other one has to be untouched by it — otherwise a stored camera silently
   *  rewrites a top-down render's prompt. */
  it('changes nothing on any other view', () => {
    const f = room();
    const cam = autoCam(f)!;
    for (const view of ['top', 'iso', 'sketch'] as const) {
      expect(buildPrompt(f, { ...base, view }), view)
        .toBe(buildPrompt(f, { ...base, view, camera: cam }));
    }
  });

  /** An eye-level brief with no camera placed is exactly the brief it was before
   *  any of this existed — which is also the picture it gets, since
   *  `referenceOpts` falls back to the plan drawing in the same case. */
  it('is unchanged when no camera has been placed', () => {
    const f = room();
    expect(buildPrompt(f, { ...base, camera: null })).toBe(buildPrompt(f, base));
  });
});

/* ── what the camera can see ────────────────────────────────────── */

describe('idsInShot', () => {
  /** Two sofas in one room, one in front of the camera and one behind it. This
   *  is the case the whole thing exists for: a photograph of the one behind is
   *  an instruction to draw a sofa that is not in the picture, sent to a model
   *  documented to reproduce every image it is given — and it is billed, because
   *  BFL meters input megapixels as well as output. */
  const twoSofas = () => {
    const f = boxRoom({ window: true });
    f.items = [
      { ...makeItem('sofa3', { x: 300, y: 500 }), id: 'ahead' },
      { ...makeItem('sofa3', { x: 300, y: 40 }), id: 'behind' },
    ];
    return f;
  };

  it('sees what is in front of the camera and not what is behind it', () => {
    const seen = idsInShot(twoSofas(), SOUTH);
    expect(seen.has('ahead')).toBe(true);
    expect(seen.has('behind')).toBe(false);
  });

  it('changes its mind when the camera turns round', () => {
    const f = twoSofas();
    const north = newCam({ x: 300, y: 600, z: EYE_CM, yaw: 270 });
    const seen = idsInShot(f, north);
    expect(seen.has('behind')).toBe(true);
    expect(seen.has('ahead')).toBe(true);
  });

  /** A frustum test would call this visible: the sofa IS in front of the camera.
   *  Reading the face buffer instead means every wall in the way has already
   *  been resolved, so the answer agrees with the picture that gets sent. */
  it('does not see through a wall', () => {
    const f = boxRoom();
    /* a partition across the middle of the room, and a sofa behind it */
    f.walls.push(wall(0, 350, 600, 350));
    f.items = [{ ...makeItem('sofa3', { x: 300, y: 500 }), id: 'nextdoor' }];
    expect(idsInShot(f, SOUTH).has('nextdoor')).toBe(false);
    /* and with a doorway in that partition, it does */
    f.walls[f.walls.length - 1] = wall(0, 350, 600, 350, [opening(0.5, 'door', 200)]);
    expect(idsInShot(f, SOUTH).has('nextdoor')).toBe(true);
  });

  /** The failure that produced a whole dining table and six chairs in the
   *  foreground of a photograph of a kitchen. A partition hid all but a corner
   *  of it — 4.4% of the object, measured — and that sliver still cleared the
   *  size threshold, so the brief listed it as an object to keep exactly where
   *  it is and the model obliged.
   *
   *  Dropping it does not erase it from the picture: the massing reference still
   *  carries the sliver. What stops is the text promoting a sliver into a
   *  subject. */
  it('ignores an object hidden down to a sliver, however near it is', () => {
    const partitioned = (gapFrom: number) => {
      const f = boxRoom();
      f.walls.push(wall(0, 350, gapFrom, 350));
      f.items = [{ ...makeItem('dt6', { x: 250, y: 520 }), id: 'table' }];
      return f;
    };
    /* Wide open, and most of the way open, it is a table in the room. */
    expect(idsInShot(partitioned(0), SOUTH).has('table')).toBe(true);
    expect(idsInShot(partitioned(240), SOUTH).has('table')).toBe(true);
    /* A corner past the edge of a wall is not. */
    expect(idsInShot(partitioned(320), SOUTH).has('table')).toBe(false);
  });

  /** The coverage rule is for objects only. A doorway with the next room's floor
   *  showing through it is worth describing, because a room is a space you can
   *  see part of — where an object is a thing the brief either tells the model
   *  to draw or does not. */
  it('still sees a room through a gap that only slivers an object', () => {
    const f = boxRoom();
    f.walls.push(wall(0, 350, 320, 350));
    f.areas.push({
      id: 'beyond',
      poly: [{ x: 0, y: 360 }, { x: 600, y: 360 }, { x: 600, y: 690 }, { x: 0, y: 690 }],
      name: 'Beyond', color: '#CCC', nx: 0, ny: 0, label: true,
    });
    f.items = [{ ...makeItem('dt6', { x: 250, y: 520 }), id: 'table' }];
    const seen = idsInShot(f, SOUTH);
    expect(seen.has('beyond')).toBe(true);
    expect(seen.has('table')).toBe(false);
  });

  it('answers for rooms as well as objects, by the same id photoSubjects uses', () => {
    expect(idsInShot(boxRoom(), SOUTH).has('room-box')).toBe(true);
  });

  /** Being in front of the camera is not the same as being in the picture: at
   *  fifteen metres a dining chair is a smudge, and its photograph would spend a
   *  reference slot and a billed megapixel on something nobody could identify in
   *  the render either. */
  it('drops what is too far away to read', () => {
    const f = emptyFloor();
    f.walls = [
      wall(0, 0, 600, 0), wall(600, 0, 600, 4000),
      wall(600, 4000, 0, 4000), wall(0, 4000, 0, 0),
    ];
    f.items = [
      { ...makeItem('chair', { x: 300, y: 400 }), id: 'near' },
      { ...makeItem('chair', { x: 300, y: 1800 }), id: 'far' },
    ];
    const seen = idsInShot(f, newCam({ x: 300, y: 100, z: EYE_CM, yaw: 90 }));
    expect(seen.has('near')).toBe(true);
    expect(seen.has('far')).toBe(false);
  });

  it('is deterministic', () => {
    const f = twoSofas();
    expect([...idsInShot(f, SOUTH)].sort()).toEqual([...idsInShot(f, SOUTH)].sort());
  });
});
