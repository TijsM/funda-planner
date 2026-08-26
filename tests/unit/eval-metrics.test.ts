import { describe, it, expect, afterAll } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { textPixelFraction, closeTextWorker } from '../../scripts/eval/metrics/text.mjs';
import { envelopeIou, footprintMask } from '../../scripts/eval/metrics/envelope.mjs';
import { roomIou } from '../../scripts/eval/metrics/rooms.mjs';
import { lineF1 } from '../../scripts/eval/metrics/lines.mjs';
import { orthoScore } from '../../scripts/eval/metrics/ortho.mjs';
import { phashDistance } from '../../scripts/eval/metrics/phash.mjs';
import { composite, scorePixels } from '../../scripts/eval/score.mjs';

/** Every image in this file is drawn here, so the right answer is known by
 *  construction rather than by looking at it. A metric that is subtly wrong is
 *  worse than no metric — every later decision gets made from its number — and
 *  the only defence is a case where the truth is arithmetic, not judgement. */

type Pt = [number, number];
type Xf = { dx: number; dy: number; scale: number };

const ID: Xf = { dx: 0, dy: 0, scale: 1 };
const map = (t: Xf, p: Pt): Pt => [p[0] * t.scale + t.dx, p[1] * t.scale + t.dy];

/** A three-room flat: two rooms across the top, one across the bottom. Ranks are
 *  the order buildPrompt would describe them in. */
const TRUTH = {
  plan: 'synthetic',
  floor: 'ground',
  frame: { width: 400, height: 300 },
  envelope: [[40, 30], [360, 30], [360, 270], [40, 270]] as Pt[],
  rooms: [
    { id: 'a', name: 'Living', rank: 0, areaM2: 30, poly: [[40, 30], [200, 30], [200, 150], [40, 150]] as Pt[] },
    { id: 'b', name: 'Kitchen', rank: 1, areaM2: 24, poly: [[200, 30], [360, 30], [360, 150], [200, 150]] as Pt[] },
    { id: 'c', name: 'Bedroom', rank: 2, areaM2: 36, poly: [[40, 150], [360, 150], [360, 270], [40, 270]] as Pt[] },
  ],
};

function pixels(w: number, h: number, draw: (c: any) => void) {
  const cv = createCanvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  draw(ctx);
  return ctx.getImageData(0, 0, w, h);
}

function polyPath(ctx: any, poly: Pt[], t: Xf) {
  ctx.beginPath();
  poly.forEach((p, i) => {
    const [x, y] = map(t, p);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.closePath();
}

/** The plan as an image: grey floor, black walls. `rooms` lets a test draw a
 *  divider somewhere other than where the truth says it is. */
function planImage(w: number, h: number, t: Xf, rooms: Pt[][] = TRUTH.rooms.map(r => r.poly)) {
  return pixels(w, h, ctx => {
    polyPath(ctx, TRUTH.envelope, t);
    ctx.fillStyle = '#dcdcdc';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4 * t.scale;
    ctx.stroke();
    ctx.lineWidth = 3 * t.scale;
    for (const poly of rooms) { polyPath(ctx, poly, t); ctx.stroke(); }
  });
}

describe('textPixelFraction', () => {
  afterAll(async () => { await closeTextWorker(); });

  /* The A/B this metric exists for: labels baked into the conditioning image
     versus none. If it cannot see the words it cannot answer the question. */
  it('finds the words that were rendered and reports what they were', async () => {
    const img = pixels(600, 400, ctx => {
      ctx.fillStyle = '#000';
      ctx.font = 'bold 48px sans-serif';
      ctx.fillText('KITCHEN', 40, 120);
      ctx.fillText('BEDROOM', 40, 220);
    });
    const { fraction, tokens } = await textPixelFraction(img);
    expect(tokens.map((t: any) => t.text.toUpperCase())).toEqual(expect.arrayContaining(['KITCHEN', 'BEDROOM']));
    expect(fraction).toBeGreaterThan(0.01);
    expect(fraction).toBeLessThan(0.2);
  }, 60_000);

  /* THE test for this metric, and the one whose absence hid a total failure.
     A render that bleeds ONE word is the arm of the A/B that decides the
     argument, and under tesseract.js's default segmentation mode — PSM 6,
     one-uniform-block-of-text — a lone WOONKAMER on a plan came back as two
     rejected fragments and nothing kept. Two words on a plan read fine, and two
     words on a white page read fine, so neither of those can pin this down: the
     case has to be one word, on a drawing. */
  it('finds a single word bled onto a drawing, not only words on a white page', async () => {
    const bled = (label: string) => pixels(1000, 750, ctx => {
      const t: Xf = { dx: 0, dy: 0, scale: 2.5 };
      polyPath(ctx, TRUTH.envelope, t);
      ctx.fillStyle = '#dcdcdc';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 4 * t.scale;
      ctx.stroke();
      ctx.lineWidth = 3 * t.scale;
      for (const r of TRUTH.rooms) { polyPath(ctx, r.poly, t); ctx.stroke(); }
      ctx.fillStyle = '#000';
      ctx.font = 'bold 36px sans-serif';
      ctx.fillText(label, 150, 250);
    });
    for (const label of ['WOONKAMER', 'KEUKEN']) {
      const { fraction, tokens } = await textPixelFraction(bled(label));
      expect(tokens.map((t: any) => t.text.toUpperCase())).toContain(label);
      expect(fraction).toBeGreaterThan(0.001);
    }
  }, 60_000);

  it('reads nothing off a blank sheet', async () => {
    const { fraction, tokens } = await textPixelFraction(pixels(600, 400, () => {}));
    expect(tokens).toHaveLength(0);
    expect(fraction).toBe(0);
  }, 60_000);

  /* OCR runs on a downscaled copy, so every box comes back in the wrong units
     unless it is divided out. Reported raw, a token drawn at x=300 in a 1600 px
     render lands at 187 and anyone overlaying the boxes on the render to see
     WHERE the lettering bled would be pointed at the wrong room. */
  it('reports the word box in the pixels the caller handed us, not the downscaled copy', async () => {
    const img = pixels(1600, 1000, ctx => {
      ctx.fillStyle = '#000';
      ctx.font = 'bold 90px sans-serif';
      ctx.fillText('KEUKEN', 300, 500);
    });
    const { tokens } = await textPixelFraction(img);
    const word = tokens.find((t: any) => t.text.toUpperCase().includes('KEUKEN'));
    if (!word) throw new Error(`no KEUKEN in ${JSON.stringify(tokens.map((t: any) => t.text))}`);
    expect(word.bbox.x0).toBeGreaterThan(260);
    expect(word.bbox.x0).toBeLessThan(360);
    /* The baseline is 500, so the cap height sits just above it. */
    expect(word.bbox.y1).toBeGreaterThan(440);
    expect(word.bbox.y1).toBeLessThan(540);
  }, 60_000);

  /* The failure that shaped the filter: under the default segmentation mode
     Tesseract reads the word "HIER" at confidence 43 out of a picture of nothing
     but rectangles, in a box covering the whole frame. Unfiltered, a bare plan
     scored 0.65 and the A/B was dead. The other arm of the A/B is this one, so a
     false positive here is as fatal as a false negative above. */
  it('does not invent words in a drawing that has none', async () => {
    const { fraction, tokens } = await textPixelFraction(planImage(600, 400, { dx: 60, dy: 40, scale: 1.2 }));
    expect(tokens).toHaveLength(0);
    expect(fraction).toBe(0);
  }, 60_000);

  /* A photorealistic render is the picture this metric actually scores, and
     gradients, furniture edges and floorboards are what it has to stay silent
     about. PSM 11 invented three words on exactly this image. */
  it('reads nothing off a textured render that has no lettering', async () => {
    const { fraction, tokens } = await textPixelFraction(scene(0, '#efe8dd', '#8c8880').px);
    expect(tokens).toHaveLength(0);
    expect(fraction).toBe(0);
  }, 60_000);
});

describe('envelopeIou', () => {
  /* The registration is the load-bearing part: roomIou and lineF1 both inherit
     the transform it returns, so an error here is an error in all three. */
  it('recovers a known translation and scale and scores the footprint near 1', () => {
    const truthXf: Xf = { dx: 30, dy: 20, scale: 1.15 };
    const { iou, transform } = envelopeIou(planImage(500, 400, truthXf), TRUTH);
    /* Checked by where the transform PUTS the building, not by the raw dx: the
       fit is to inked extent, so a 4 px wall on a 320 px building reads about
       1.5% large in scale and takes dx with it. The two errors cancel where it
       matters and the centre lands within a pixel. */
    const centre = (t: Xf) => map(t, [200, 150]);
    const got = centre(transform), want = centre(truthXf);
    expect(Math.hypot(got[0] - want[0], got[1] - want[1])).toBeLessThan(2);
    expect(Math.abs(transform.scale - truthXf.scale)).toBeLessThan(0.03);
    expect(iou).toBeGreaterThan(0.95);
  });

  /* A building touching the frame edge splits the background in two. Flood
     filling from one corner leaves the far half counted as building. */
  it('keeps the background outside even when the plan touches the frame edge', () => {
    const img = pixels(200, 200, ctx => { ctx.fillStyle = '#888'; ctx.fillRect(0, 60, 120, 80); });
    const m = footprintMask(img);
    let n = 0;
    for (let i = 0; i < m.data.length; i++) n += m.data[i];
    expect(n).toBeGreaterThan(120 * 80 * 0.95);
    expect(n).toBeLessThan(120 * 80 * 1.1);
  });

  /* Why the search is bounded. Unbounded, the fit shrank a 120x80 box onto a
     320x240 building and reported 0.90 for a render that kept nothing. */
  it('scores a render that kept nothing of the footprint far below one', () => {
    const wrong = pixels(400, 300, ctx => { ctx.fillStyle = '#dcdcdc'; ctx.fillRect(250, 200, 120, 80); });
    expect(envelopeIou(wrong, TRUTH).iou).toBeLessThan(0.4);
  });

  /* Providers return whatever resolution they return, not the one we framed at,
     and a smaller render is the case that broke: downscaleMask leaves a mask
     alone when it is already under the level's resolution, so at level 384 a
     200 px render sat at full size against a truth mask at 0.96 and the true
     scale of 0.5 fell outside the 0.7 floor. A pixel-perfect copy at half
     resolution scored 0.80 on the envelope and 0.2 on every room. */
  it('registers a render the provider returned smaller than the frame we framed', () => {
    const small = planImage(200, 150, { dx: 0, dy: 0, scale: 0.5 });
    const { iou, transform, frameScale } = envelopeIou(small, TRUTH);
    expect(iou).toBeGreaterThan(0.95);
    expect(Math.abs(transform.scale - 0.5)).toBeLessThan(0.03);
    expect(Math.abs(frameScale - 1)).toBeLessThan(0.05);
    /* The transform is the point: the metrics downstream have to be usable on it. */
    for (const r of roomIou(small, TRUTH, transform).rooms) expect(r.iou).toBeGreaterThan(0.7);
    expect(lineF1(small, TRUTH, transform).f1).toBeGreaterThan(0.9);
  });

  /* A similarity fit cannot tell "the generator re-cropped our framing" from
     "the generator drew the wrong building", so it scores a render that blew the
     plan up to fill the whole page at 0.99 — correctly, and uselessly. frameScale
     and coverage are what make that visible, and score.mjs has to read them:
     the iou alone calls this a pass. */
  it('flags a re-framed render that the footprint IoU alone calls a pass', () => {
    const bleed = pixels(400, 300, ctx => {
      ctx.fillStyle = '#dcdcdc';
      ctx.fillRect(0, 0, 400, 300);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, 396, 296);
    });
    const got = envelopeIou(bleed, TRUTH);
    expect(got.iou).toBeGreaterThan(0.9);
    expect(got.frameScale).toBeGreaterThan(1.15);
    expect(got.coverage).toBeGreaterThan(0.9);

    const honest = envelopeIou(planImage(400, 300, ID), TRUTH);
    expect(Math.abs(honest.frameScale - 1)).toBeLessThan(0.05);
    expect(honest.coverage).toBeLessThan(0.75);
  });

  /* The other end of the same failure, and the one that was scoring silently.
     footprintMask floods in from every border pixel matching the border's own
     median colour, so an image with NO background is background everywhere by
     that test: the fill takes the whole frame and the footprint comes back
     EMPTY, not full. That is coverage 0 and envelope 0 — a confident zero on an
     image nothing could be measured from — where the test above got 0.96 out of
     the same picture merely because it had a rim round it. Both ends have to
     read as unregistered, which is why score.mjs now has a floor as well as a
     ceiling. */
  it('reports no coverage at all, not full coverage, when the render has no background', () => {
    const flat = pixels(400, 300, ctx => {
      ctx.fillStyle = '#8c8c8c';
      ctx.fillRect(0, 0, 400, 300);
    });
    const got = envelopeIou(flat, TRUTH);
    expect(got.coverage).toBe(0);
    expect(got.iou).toBe(0);
    /* and the transform still describes our own framing, so the metrics
       downstream are handed a guess rather than a scale of 1 that is only right
       when the two resolutions happen to match */
    expect(got.transform.scale).toBeCloseTo(1, 6);
  });
});

describe('roomIou', () => {
  const frame = planImage(400, 300, ID);
  const { transform } = envelopeIou(frame, TRUTH);

  it('scores every room high when the render drew the rooms it was given', () => {
    const { rooms, rankSlope } = roomIou(frame, TRUTH, transform);
    expect(rooms.map((r: any) => r.rank)).toEqual([0, 1, 2]);
    for (const r of rooms) expect(r.iou).toBeGreaterThan(0.8);
    expect(rankSlope).not.toBeNull();
    expect(Math.abs(rankSlope as number)).toBeLessThan(0.05);
  });

  /* The whole hypothesis is per-room, so a moved wall must show up on the rooms
     it bounds and nowhere else. A blended score would hide exactly this. */
  it('drops only the rooms whose shared wall moved', () => {
    const clean = roomIou(frame, TRUTH, transform).rooms;
    const moved: Pt[][] = [
      [[40, 30], [260, 30], [260, 150], [40, 150]],
      [[260, 30], [360, 30], [360, 150], [260, 150]],
      TRUTH.rooms[2].poly,
    ];
    const got = roomIou(planImage(400, 300, ID, moved), TRUTH, transform).rooms;
    expect(got[0].iou).toBeLessThan(0.8);
    expect(got[1].iou).toBeLessThan(0.8);
    expect(got[2].iou).toBeGreaterThan(0.8);
    expect(Math.abs(got[2].iou - clean[2].iou)).toBeLessThan(0.05);
  });

  /* truth.mjs gives rank null to any area the prompt never named — a garden bed,
     an unlabelled cupboard. `0 - null` is 0, so before this test such a room
     sorted as though it were the first room described AND entered the regression
     at rank 0, tilting the one number the whole file exists to produce. */
  it('scores a room the prompt never named but keeps it out of the rank slope', () => {
    const withGarden = {
      ...TRUTH,
      rooms: [
        TRUTH.rooms[0], TRUTH.rooms[1],
        { ...TRUTH.rooms[2], id: 'g', name: 'Tuin', rank: null as number | null },
      ],
    };
    const { rooms, rankSlope } = roomIou(frame, withGarden, transform);
    expect(rooms.map((r: any) => r.rank)).toEqual([0, 1, null]);
    expect(rooms[2].iou).toBeGreaterThan(0.8);
    /* Two ranked rooms scoring alike: the slope is theirs alone, and the third
       room's iou cannot move it whatever it is. */
    expect(Math.abs(rankSlope as number)).toBeLessThan(0.05);
    expect(rankSlope).toBe(roomIou(frame, { ...TRUTH, rooms: TRUTH.rooms.slice(0, 2) }, transform).rankSlope);
  });

  /* A room too small to raster at the working resolution is our limitation, not
     the render's, and must not be reported as a zero someone will average in. */
  it('says degenerate rather than zero for a room smaller than the working grid', () => {
    const tiny = { ...TRUTH, rooms: [{ id: 't', name: 'Meterkast', rank: 0, areaM2: 0.3, poly: [[100, 100], [102, 100], [102, 102], [100, 102]] as Pt[] }] };
    expect(roomIou(frame, tiny, transform).rooms[0].note).toBe('degenerate');
  });
});

describe('lineF1', () => {
  /* Framed as the harness frames it: the plan fills the render, at whatever
     resolution the provider returned. */
  const frame = planImage(600, 450, { dx: 0, dy: 0, scale: 1.5 });
  const { transform } = envelopeIou(frame, TRUTH);

  it('scores a drawing against its own walls near one', () => {
    const { f1, precision, recall } = lineF1(frame, TRUTH, transform);
    expect(precision).toBeGreaterThan(0.85);
    expect(recall).toBeGreaterThan(0.95);
    expect(f1).toBeGreaterThan(0.9);
  });

  /* 20 px is well past the matching tolerance, so a moved wall has to cost both
     sides: the render's edge matches no wall, and the wall matches no edge. */
  it('falls materially when one wall moves 20 px', () => {
    const same = lineF1(frame, TRUTH, transform).f1;
    const shifted: Pt[][] = [
      [[40, 30], [200, 30], [200, 170], [40, 170]],
      [[200, 30], [360, 30], [360, 170], [200, 170]],
      [[40, 170], [360, 170], [360, 270], [40, 270]],
    ];
    const moved = lineF1(planImage(600, 450, { dx: 0, dy: 0, scale: 1.5 }, shifted), TRUTH, transform).f1;
    expect(moved).toBeLessThan(same - 0.1);
  });
});

describe('orthoScore', () => {
  it('scores an axis-parallel drawing high', () => {
    expect(orthoScore(planImage(500, 400, { dx: 20, dy: 20, scale: 1.1 })).score).toBeGreaterThan(0.9);
  });

  /* The dollhouse tilt, faked: rotate and shear so neither family of walls stays
     on an axis. This is our own proxy, so the test pins the gap it must show,
     not an absolute value it must hit. */
  it('scores the same drawing under a perspective-ish shear far lower', () => {
    const flat = orthoScore(planImage(600, 500, { dx: 60, dy: 60, scale: 1 })).score;
    const tilted = pixels(600, 500, ctx => {
      ctx.translate(300, 250);
      ctx.rotate((18 * Math.PI) / 180);
      ctx.transform(1, 0.22, 0, 1, 0, 0);
      ctx.translate(-200, -150);
      polyPath(ctx, TRUTH.envelope, ID);
      ctx.fillStyle = '#dcdcdc';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.lineWidth = 3;
      for (const r of TRUTH.rooms) { polyPath(ctx, r.poly, ID); ctx.stroke(); }
    });
    expect(orthoScore(tilted).score).toBeLessThan(0.5);
    expect(flat - orthoScore(tilted).score).toBeGreaterThan(0.4);
  });
});

/** A render-like picture: a graded floor, furniture blocks, floorboard lines.
 *  The line drawings above are the wrong subject for a perceptual hash — a bare
 *  raster puts almost all its energy in a handful of DCT coefficients, so a 3%
 *  crop flips as many bits as an unrelated picture does and the tripwire cannot
 *  tell the two apart. Renders are what this metric is ever pointed at. */
function scene(shift: number, from: string, to: string, k = 1) {
  const W = 480 * k, H = 360 * k;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#5a4632';
  [[40, 40, 120, 90], [220, 60, 150, 70], [60, 200, 90, 120], [260, 190, 170, 130], [180, 150, 60, 60]]
    .forEach(([x, y, w, h], i) => ctx.fillRect((x + shift) * k, (y + shift * (i % 2)) * k, w * k, h * k));
  ctx.strokeStyle = '#22222240';
  ctx.lineWidth = 3 * k;
  for (let i = 0; i < 10; i++) { ctx.beginPath(); ctx.moveTo(0, i * 36 * k); ctx.lineTo(W, i * 36 * k); ctx.stroke(); }
  return { px: ctx.getImageData(0, 0, W, H), cv };
}

describe('phashDistance', () => {
  const a = scene(0, '#f2ece2', '#8f8c85');

  it('is zero for the same picture twice', () => {
    expect(phashDistance(a.px, scene(0, '#f2ece2', '#8f8c85').px)).toBe(0);
  });

  /* The tripwire fires on "nothing changed". It must not fire on a re-encode or
     a couple of per cent of crop, or every run of the sweep looks like a change. */
  it('stays small for the same picture cropped slightly', () => {
    const cv = createCanvas(480, 360);
    const ctx = cv.getContext('2d');
    ctx.drawImage(a.cv, 10, 8, 460, 344, 0, 0, 480, 360);
    const d = phashDistance(a.px, ctx.getImageData(0, 0, 480, 360));
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(12);
  });

  /* Two providers at two output resolutions are the same sweep, and comparing a
     1024 px render with the 512 px one it replaced must not read as "the picture
     changed". Aspect and resolution are both squashed away before hashing. */
  it('does not fire when the same picture arrives at another resolution', () => {
    expect(phashDistance(a.px, scene(0, '#f2ece2', '#8f8c85', 2).px)).toBeLessThan(3);
    expect(phashDistance(a.px, scene(0, '#f2ece2', '#8f8c85', 0.5).px)).toBeLessThan(3);
  });

  it('is large for an unrelated picture', () => {
    expect(phashDistance(a.px, scene(90, '#243b55', '#a9d6c8').px)).toBeGreaterThan(20);
  });
});

/* The sweep runs hundreds of images. A metric that takes seconds each turns a
   re-score into an overnight job, and nobody re-scores. */
describe('cost', () => {
  it('scores a one-megapixel image in well under a second per metric', () => {
    const big = planImage(1000, 1000, { dx: 100, dy: 100, scale: 2.4 });
    const t0 = Date.now();
    const { transform } = envelopeIou(big, TRUTH);
    const t1 = Date.now();
    roomIou(big, TRUTH, transform);
    const t2 = Date.now();
    lineF1(big, TRUTH, transform);
    const t3 = Date.now();
    orthoScore(big);
    const t4 = Date.now();
    phashDistance(big, big);
    const t5 = Date.now();
    for (const ms of [t1 - t0, t2 - t1, t3 - t2, t4 - t3, t5 - t4]) expect(ms).toBeLessThan(1000);
  });
});

/* The gate score.mjs puts in front of the composite. A cell nobody could
   register has to be excluded, not averaged in as a zero — and until a floor was
   added beside the ceiling, the commonest way to be unregisterable (a render
   with no background, so the footprint fill comes back empty) sailed straight
   through as a confident composite of 0.000 with no flag on it. */
describe('the unregistered gate', () => {
  /* scorePixels reads the whole sidecar, not just the geometry the metrics above
     need, so the fixture has to be a complete one. Nothing here scores the items
     or the seats — object counting is the documented gap — but a partial sidecar
     would not typecheck against what the sweep actually writes. */
  const FULL = { ...TRUTH, items: [], openings: [], expectedSeats: 0 };

  it('flags a render with no background and refuses to score it', async () => {
    const flat = pixels(400, 300, ctx => {
      ctx.fillStyle = '#8c8c8c';
      ctx.fillRect(0, 0, 400, 300);
    });
    const m = await scorePixels(flat, FULL);
    expect(m.envelope.coverage).toBe(0);
    expect(m.flags).toContain('unregistered');
    expect(m.note).toBe('unregistered');
    expect(composite(m)).toBeNull();
  });

  it('still scores an honest render of the same plan', async () => {
    const m = await scorePixels(planImage(400, 300, ID), FULL);
    expect(m.envelope.coverage).toBeGreaterThan(0.02);
    expect(m.flags ?? []).not.toContain('unregistered');
    expect(composite(m)).toBeGreaterThan(0);
  });
});
