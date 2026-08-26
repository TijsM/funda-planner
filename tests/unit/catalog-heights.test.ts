import { describe, expect, it } from 'vitest';
import { CATALOG, CAT_BY_KIND, DEFAULT_Z, GROUP_Z, heightOf, Z } from '@engine/catalog';

/** Object heights, which exist for one consumer: the depth pass, which ramps
 *  them to grey levels in the control map it sends the generator. A wrong
 *  number there is not a wrong pixel, it is a wardrobe the model builds shorter
 *  than the coffee table in front of it — so these tests guard the ordering and
 *  the completeness rather than any individual figure. */

const kinds = CATALOG.flatMap(g => g.items.map(i => i.kind));

describe('heightOf', () => {
  /* The depth pass has no fallback of its own: an object it cannot get a height
     for is a hole in the map, and holes read as floor. */
  it('gives every catalogue entry a height', () => {
    expect(kinds.filter(k => CAT_BY_KIND[k].z === undefined)).toEqual([]);
    expect(kinds.filter(k => !Number.isFinite(heightOf(k)))).toEqual([]);
  });

  /* Z is hand-maintained beside a table it does not share a shape with, so a
     kind renamed on one side and not the other has to fail here rather than
     quietly leaving the object flat on the floor. */
  it('has no height for a kind that is not in the catalogue', () => {
    expect(Object.keys(Z).filter(k => !kinds.includes(k))).toEqual([]);
  });

  /* A pool's water sits at grade. `z || fallback` would swallow that 0 and hand
     the depth pass waist height, raising the one thing on the plan that is
     definitively not raised. */
  it('keeps a height of zero instead of falling through to a default', () => {
    expect(Z.pool).toBe(0);
    expect(heightOf('pool')).toBe(0);
  });

  /* Plans are serialised with the kinds that existed when they were saved, so a
     build reading a newer plan meets kinds it has never heard of. */
  it('falls back to waist height for a kind it has never heard of', () => {
    expect(heightOf('teleporter')).toBe(DEFAULT_Z);
  });

  /* The group defaults are the net for an object added tomorrow without a
     height. They must cover every group that exists — and must currently catch
     nothing, because a default silently standing in for a real figure is how
     the ordering below rots without a test noticing. */
  it('has a group default for every group, and uses none of them today', () => {
    const groups = CATALOG.map(g => g.group);
    expect(groups.filter(g => GROUP_Z[g] === undefined)).toEqual([]);
    expect(kinds.filter(k => heightOf(k) !== Z[k])).toEqual([]);
  });
});

describe('relative heights', () => {
  /* The grey ramp only ever encodes the order, so this is the whole contract:
     each of these pairs is a silhouette a person would notice inverted. */
  it('stacks the furniture the way a room actually stacks', () => {
    const order = ['wardr', 'kcount', 'dt6', 'coffee', 'rug'];
    const hs = order.map(heightOf);
    expect(hs).toEqual([...hs].sort((a, b) => b - a));
    expect(new Set(hs).size).toBe(hs.length);      // ties would blur in the ramp
  });

  it('puts a chair back above the table it tucks under, and a stool below it', () => {
    expect(heightOf('chair')).toBeGreaterThan(heightOf('dt6'));
    expect(heightOf('stool')).toBeLessThanOrEqual(heightOf('bar'));
  });

  /* A staircase that did not rise a full storey came back as a step up onto a
     landing; anything spanning floor to ceiling has to read as the storey. */
  it('runs the structural objects the full height of the storey', () => {
    for (const k of ['stairU', 'stairS', 'column', 'colR', 'duct'])
      expect(heightOf(k)).toBe(260);
  });

  /* Floor coverings are the reference plane. If a rug reads as furniture the
     model puts a plinth under it. */
  it('leaves floor coverings on the floor', () => {
    for (const k of ['rug', 'rugRound', 'lawn', 'terrace', 'path', 'stepstone', 'pool'])
      expect(heightOf(k)).toBeLessThanOrEqual(2);
  });

  /* Worktop-height kitchen units are one continuous surface from above; a
     dishwasher or oven sunk to its own carcass height would punch a hole in it. */
  it('levels everything built into the kitchen run with the worktop', () => {
    for (const k of ['kcount', 'kcorner', 'kisland', 'sink', 'sink2', 'oven', 'dishw'])
      expect(heightOf(k)).toBe(heightOf('kcount'));
    expect(heightOf('pantry')).toBeGreaterThan(heightOf('kcount'));
    expect(heightOf('hood')).toBeGreaterThan(heightOf('kcount'));
  });

  /* Nothing indoors may reach the ceiling except the things that are meant to:
     an object taller than the storey clips the whole ramp flat. */
  it('keeps indoor objects under the ceiling', () => {
    const indoor = new Set(['Living', 'Dining', 'Bedroom', 'Kitchen', 'Bathroom', 'Decoration']);
    for (const g of CATALOG.filter(c => indoor.has(c.group)))
      for (const i of g.items) expect(heightOf(i.kind)).toBeLessThan(260);
  });
});
