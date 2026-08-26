import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Floor } from '@engine/types';
import { planFrame } from '@engine/frame';
import { buildPrompt, planFacts } from '@engine/prompt';
import { SEATS } from '@engine/catalog';
import { type Fml, fmlToProject } from '@engine/io/funda';
import { parseProject, serializeProject } from '@engine/io/serialize';
import { PLANS, loadPlan, plans } from '../../scripts/eval/plans.mjs';
import { truthFor } from '../../scripts/eval/truth.mjs';

/** The frame every sidecar here is checked in: planFrame's clean reference, the
 *  one the sweep conditions on. A sidecar is only true of the picture it was
 *  framed with, so this asks for the frame the same way run.mjs has to — framing
 *  the plan some other way would prove nothing about the image we send. */
const cleanFrame = (f: Floor) => planFrame(f, { clean: true })!;

const FIX = path.join(__dirname, '..', 'fixtures');

/** The room names the brief actually lists, read out of the ROOMS table in the
 *  order they appear in it. Reading the prompt back is the point: nothing else
 *  proves the sidecar's rank is the rank the model was read to in. */
function promptRooms(f: Floor): string[] {
  const lines = buildPrompt(f, { view: 'top', room: '*', furniture: true, dimensions: false }).split('\n');
  const head = lines.indexOf('ROOMS');
  if (head < 0) return [];
  const out: string[] = [];
  for (let i = head + 2; i < lines.length && lines[i].trim(); i++) out.push(lines[i].split(' | ')[0]);
  return out;
}

const ALL = plans();

describe('the eval fixture plans', () => {
  /* The sweep loads these through the app's own loader. A fixture that only the
     harness can read would score a file the product could never open. */
  it('all ten parse as real Plattegrond Studio projects and round-trip unchanged', () => {
    expect(ALL).toHaveLength(10);
    expect(new Set(ALL.map(p => p.id)).size).toBe(10);
    for (const p of ALL) {
      expect(p.project.floors).toHaveLength(1);
      expect(p.floor.walls.length).toBeGreaterThan(3);
      expect(p.floor.areas.length).toBeGreaterThan(0);
      /* ids are written into every sidecar, so a fixture that regenerates them
         on load would make two runs of the same plan incomparable */
      const again = parseProject(serializeProject(p.project));
      expect(serializeProject(again)).toBe(serializeProject(p.project));
      expect(again.floors[0].areas.map(a => a.id)).toEqual(p.floor.areas.map(a => a.id));
    }
  });

  /* Each of these is a failure mode we have actually shipped a render of. The
     set is only worth its runtime while it still contains all of them, and a
     later tidy-up that drops the unnamed-room plan would silently stop
     measuring the case the prompt has a whole branch for. */
  it('covers every case the sweep is meant to span', () => {
    const facts = ALL.map(p => ({ p, F: planFacts(p.floor) }));
    const tables = (f: Floor) => f.items.filter(i => SEATS[i.kind]).length;

    expect(facts.filter(({ p }) => /stair|trap/i.test(JSON.stringify(p.floor.items))).length).toBeGreaterThan(0);
    expect(facts.filter(({ p }) => tables(p.floor) >= 3).length).toBeGreaterThan(0);
    expect(facts.filter(({ F }) => !F.mapped).length).toBeGreaterThan(0);
    /* drawn but unnamed: polygons on the plan that the brief can never name */
    expect(facts.filter(({ p, F }) => p.floor.areas.length > 2 && !F.rooms.length).length).toBeGreaterThan(0);
    /* enough ranked rooms for rank-decay to have somewhere to decay */
    expect(Math.max(...facts.map(({ F }) => F.rooms.length))).toBeGreaterThanOrEqual(5);
    for (const { p } of facts) expect(p.catches.length).toBeGreaterThan(20);
    expect(PLANS.map(p => p.id)).toEqual(ALL.map(p => p.id));
  });

  /* The four nl-* plans are the imported .fml's own floors rather than lookalikes
     typed out by hand, and that is the whole reason they are in the set: the
     off-axis walls, the twelve 0.08 m² cupboards and the anonymous fitted blocks
     are exactly what a hand-built fixture tidies away and a real import does not.
     Hand-editing one of them to make a metric behave would be invisible without
     this. */
  it('keeps the four imported floors identical to the .fml they came from', () => {
    const fml = JSON.parse(fs.readFileSync(path.join(FIX, 'floorplanner-project.fml'), 'utf8')) as Fml;
    const src = fmlToProject(fml);
    /* geometry and openings, not ids: the fixtures carry stable readable ids of
       their own, which is the one thing they are allowed to differ in */
    const shape = (f: Floor) => JSON.stringify({
      walls: f.walls.map(w => [w.a, w.b, w.t, w.openings.map(o => [o.type, o.at, o.width])]),
      areas: f.areas.map(a => [a.name, a.poly]),
      items: f.items.map(i => [i.kind, i.x, i.y, i.w, i.h, i.rot]),
    });
    for (const id of ['nl-ground', 'nl-ground-garden', 'nl-first', 'nl-second']) {
      const mine = loadPlan(id);
      const theirs = src.floors.find(f => f.name === mine.floor.name);
      expect(theirs, id).toBeDefined();
      expect(shape(mine.floor), id).toBe(shape(theirs!));
    }
  });

  /* mapped:false is a branch of its own in buildPrompt, and only two plans in the
     set reach it — nl-ground-garden by less than a hundredth. Naming both, with
     the ratio each one lands on, is what makes a change to planFacts' 0.55 fail
     here: the coverage test above would stay green on unmapped-open alone while
     the marginal plan quietly turned into an ordinary mapped floor. */
  it('keeps one marginal and one extreme plan on the unmapped side of 0.55', () => {
    const ratio = (f: Floor) => {
      const { total, bbox: b } = planFacts(f);
      return total / ((b.x1 - b.x0) * (b.y1 - b.y0));
    };
    const garden = ratio(loadPlan('nl-ground-garden').floor);
    expect(garden).toBeGreaterThan(0.5);
    expect(garden).toBeLessThan(0.55);
    expect(ratio(loadPlan('unmapped-open').floor)).toBeLessThan(0.1);
    /* and nothing else drifted across it: two unmapped plans, eight mapped */
    const unmapped = ALL.filter(p => !planFacts(p.floor).mapped).map(p => p.id);
    expect(unmapped).toEqual(['nl-ground-garden', 'unmapped-open']);
  });
});

describe('the ground-truth sidecar', () => {
  /* Every metric works in frame pixels and none of them re-derives the view. A
     polygon outside the frame is a metric comparing the render against geometry
     that is not on the conditioning image at all. */
  it('puts an envelope and every room inside the frame it was drawn in', () => {
    for (const p of ALL) {
      const frame = cleanFrame(p.floor);
      const t = truthFor(p, frame);

      expect(t.plan).toBe(p.id);
      expect(t.floor).toBe(p.floor.name);
      expect(t.frame).toEqual({ width: frame.width, height: frame.height });
      expect(t.envelope.length).toBeGreaterThanOrEqual(3);
      for (const [x, y] of t.envelope) {
        expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(frame.width);
        expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(frame.height);
      }
      expect(t.rooms).toHaveLength(p.floor.areas.length);
      for (const r of t.rooms) {
        expect(r.poly.length).toBeGreaterThanOrEqual(3);
        for (const [x, y] of r.poly) {
          expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(frame.width);
          expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(frame.height);
        }
      }
      expect(t.items).toHaveLength(p.floor.items.length);
      expect(t.openings).toHaveLength(p.floor.walls.reduce((n, w) => n + w.openings.length, 0));
      for (const o of t.openings) expect(o.width).toBeGreaterThan(0);
    }
  });

  /* The envelope must be the building, not its bounding box: an outline that
     shrank to a rectangle would hand envelopeIou a free 0.9 on an L-shaped house
     and hide exactly the wandering it is there to catch. */
  it('traces the drawn footprint rather than its bounding box', () => {
    for (const p of ALL) {
      const frame = cleanFrame(p.floor);
      const { envelope } = truthFor(p, frame);
      const xs = envelope.map(([x]) => x), ys = envelope.map(([, y]) => y);
      const box = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
      let a = 0;
      for (let i = 0; i < envelope.length; i++) {
        const q = envelope[(i + 1) % envelope.length];
        a += envelope[i][0] * q[1] - q[0] * envelope[i][1];
      }
      const area = Math.abs(a / 2);
      /* it fills most of its own bounds — this is a building, not a scattering */
      expect(area / box).toBeGreaterThan(0.5);
      expect(area / box).toBeLessThanOrEqual(1.0001);
    }
    /* the garden floor is the L-shaped one: its outline may not be its box */
    const garden = loadPlan('nl-ground-garden');
    const t = truthFor(garden, cleanFrame(garden.floor));
    expect(t.envelope.length).toBeGreaterThan(4);
  });

  /* If these two orderings ever drift apart, the rank-decay hypothesis quietly
     measures nothing: the sidecar would say "rank 3" about a room the brief
     mentioned first. The ordering lives in planFacts and is read, never
     recomputed — this is what proves that is still true of buildPrompt too. */
  it('ranks the rooms in the order the brief actually lists them', () => {
    for (const p of ALL) {
      const t = truthFor(p, cleanFrame(p.floor));
      const ranked = t.rooms
        .filter(r => r.rank !== null)
        .sort((a, b) => a.rank! - b.rank!);
      expect(ranked.map(r => r.rank)).toEqual(ranked.map((_, i) => i));
      expect(ranked.map(r => r.name)).toEqual(promptRooms(p.floor));
    }
  });

  /* A room the brief never names cannot be scored by rank, and pretending
     otherwise would key roomIou by a number the model was never told. */
  it('gives no rank to a room that is drawn but never named', () => {
    const p = loadPlan('house-unnamed');
    const t = truthFor(p, cleanFrame(p.floor));
    expect(t.rooms.length).toBe(4);
    expect(t.rooms.every(r => r.rank === null)).toBe(true);
    expect(promptRooms(p.floor)).toEqual([]);
    /* and the cupboards on the imported floor, which are drawn, named and too
       small for the brief to bother with */
    const nl = loadPlan('nl-ground');
    const kasten = truthFor(nl, cleanFrame(nl.floor)).rooms.filter(r => r.name === 'Kast');
    expect(kasten.length).toBeGreaterThan(0);
    expect(kasten.every(r => r.rank === null)).toBe(true);
  });

  /* The chair count is the one number the brief states out loud, and the sidecar
     is what a render is scored against. Two sources for it is how a six-seater
     comes back with eight and the scorecard calls it correct. */
  it('expects exactly the number of seats the brief tells the model to draw', () => {
    for (const p of ALL) {
      const t = truthFor(p, cleanFrame(p.floor));
      /* the counts, not the wording: the sentence around them is prose and gets
         rewritten, the two numbers in it are the contract */
      const line = buildPrompt(p.floor, { view: 'top', room: '*', furniture: true, dimensions: false })
        .split('\n').find(l => /are chairs/.test(l));
      if (!t.expectedSeats) { expect(line).toBeUndefined(); continue; }
      const said = line?.match(/\d+/g) ?? [];
      expect(Number(said[0])).toBe(t.expectedSeats);
      expect(Number(said[1])).toBe(p.floor.items.filter(i => SEATS[i.kind]).length);
    }
    expect(truthFor(loadPlan('openplan-tables'), cleanFrame(loadPlan('openplan-tables').floor)).expectedSeats).toBe(20);
  });
});
