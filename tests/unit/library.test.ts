import { describe, expect, it } from 'vitest';
import { entryOf, mergeEntries, type LibraryEntry } from '@data/library';
import type { Project } from '@engine/types';

/** The library index: one summary per plan, and the merge that decides what the
 *  list shows when this browser and the account disagree about a plan.
 *
 *  `mergeEntries` is the entire conflict-resolution policy, so the tests that
 *  matter are the ones that pin the losing side: which copy is discarded, and
 *  what survives it anyway. */

const entry = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id: 'p1', name: 'Pieter Kleijnstraat 19', address: 'Rosmalen', url: 'https://funda.nl/x',
  updatedAt: 1_000, nf: 3,
  ...over,
});

const ids = (rows: LibraryEntry[]) => rows.map(r => r.id);

describe('entryOf', () => {
  const project = (over: Partial<Project> = {}): Project => ({
    schema: 3, id: 'p1', name: 'A house', createdAt: 1, updatedAt: 2_000,
    source: { url: 'https://funda.nl/x', address: 'Rosmalen', title: null, projectId: 44432123, fetchedAt: 5 },
    floors: [{ id: 'f1' }, { id: 'f2' }] as unknown as Project['floors'],
    ...over,
  });

  it('takes the address and url out of the source block', () => {
    expect(entryOf(project())).toEqual({
      id: 'p1', name: 'A house', address: 'Rosmalen', url: 'https://funda.nl/x',
      updatedAt: 2_000, nf: 2,
    });
  });

  /* A plan started from scratch has no listing behind it, and the library still
     has to render a row for it rather than printing "null". */
  it('gives a plan with no listing empty strings, not nulls', () => {
    const e = entryOf(project({ source: null }));
    expect(e.address).toBe('');
    expect(e.url).toBe('');
  });

  /* The account decides this, not the document — so a fresh entry must not
     claim to be synced before anything has been pushed. */
  it('does not invent a synced flag', () => {
    expect(entryOf(project()).synced).toBeUndefined();
  });
});

describe('mergeEntries', () => {
  it('keeps one entry per id and lets the newer updatedAt win', () => {
    const local = entry({ name: 'renamed here', updatedAt: 2_000 });
    const cloud = entry({ name: 'renamed elsewhere', updatedAt: 1_000, synced: true });
    expect(mergeEntries([local], [cloud])).toEqual([{ ...local, synced: true }]);
  });

  /* Argument order must not decide anything — the same two versions merge to
     the same answer whichever list they arrive in. */
  it('does not care which list the winner came from', () => {
    const local = entry({ name: 'renamed here', updatedAt: 2_000 });
    const cloud = entry({ name: 'renamed elsewhere', updatedAt: 1_000, synced: true });
    expect(mergeEntries([cloud], [local])).toEqual(mergeEntries([local], [cloud]));
  });

  /* `synced` says "this plan exists in the account", which is true regardless of
     which version of it is the newest — so it has to survive the copy that
     loses on the timestamp, and it is the only field that does. */
  it('carries the synced flag off the losing copy', () => {
    const stale = entry({ updatedAt: 1_000, synced: true });
    const fresher = entry({ updatedAt: 9_000, nf: 4 });
    const [merged] = mergeEntries([stale], [fresher]);
    expect(merged).toMatchObject({ updatedAt: 9_000, nf: 4, synced: true });
  });

  it('leaves a plan that is only in this browser unsynced', () => {
    const [merged] = mergeEntries([entry({ updatedAt: 1 })], [entry({ updatedAt: 2 })]);
    expect(merged.synced).toBeFalsy();
  });

  it('sorts newest first, across lists', () => {
    const rows = mergeEntries(
      [entry({ id: 'a', updatedAt: 10 }), entry({ id: 'c', updatedAt: 30 })],
      [entry({ id: 'b', updatedAt: 20 })],
    );
    expect(ids(rows)).toEqual(['c', 'b', 'a']);
  });

  /* An exact tie is a real case — two devices saving inside the same
     millisecond — and it must not throw away a plan or duplicate one. */
  it('keeps exactly one copy when the timestamps are identical', () => {
    const rows = mergeEntries([entry({ name: 'first' })], [entry({ name: 'second', synced: true })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].synced).toBe(true);
  });

  it('merges more than two lists', () => {
    const rows = mergeEntries(
      [entry({ id: 'a', updatedAt: 5 })],
      [entry({ id: 'a', updatedAt: 15, name: 'newest' })],
      [entry({ id: 'a', updatedAt: 10, synced: true })],
    );
    expect(rows).toEqual([{ ...entry({ id: 'a', updatedAt: 15, name: 'newest' }), synced: true }]);
  });

  /* The library modal opens before either half of the list has landed, and an
     empty merge is what it renders from. */
  it('survives no lists at all, and lists with nothing in them', () => {
    expect(mergeEntries()).toEqual([]);
    expect(mergeEntries([], [])).toEqual([]);
    expect(mergeEntries([], [entry()])).toEqual([entry()]);
  });
});
