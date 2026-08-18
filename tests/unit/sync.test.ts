// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, maybePush, noteLocalChange, resetSync, startSync } from '@data/sync';
import type { Project } from '@engine/types';

/** The half of the plan sync that has no network in it: the size ceiling that
 *  decides a document is not going up at all, and the clock that decides how
 *  often the ones that are allowed actually do.
 *
 *  Supabase is replaced wholesale rather than intercepted, so a mistake here is
 *  a TypeError, never a request that reaches a real project. Every upsert the
 *  module attempts is recorded, which is what lets "did not push" be an
 *  assertion instead of an absence. */

const db = vi.hoisted(() => ({
  /** every row handed to `plans.upsert`, in order */
  upserts: [] as Record<string, unknown>[],
  /** who the session says is signed in; null is a client that is not */
  userId: 'user-1' as string | null,
}));

vi.mock('@data/supabase', () => {
  const fake = {
    auth: {
      getUser: async () => ({ data: { user: db.userId ? { id: db.userId } : null } }),
    },
    from: () => ({
      upsert: (row: Record<string, unknown>) => {
        db.upserts.push(row);
        return { select: () => ({ single: async () => ({ data: { id: 'row-1' }, error: null }) }) };
      },
    }),
  };
  return { client: () => fake, requireClient: () => fake };
});

const T0 = 1_700_000_000_000;

/* Duplicated from sync.ts, which keeps it private — deliberately, because the
   interval is nobody else's business. If it is retuned there and not here, the
   burst tests below fail rather than quietly stop testing anything. */
const PUSH_INTERVAL_MS = 8_000;

/** Lets whatever `maybePush` started actually run. `flushSync` awaits an
 *  in-flight push, so this is also the honest way to observe one that was
 *  started without being awaited. */
const settle = async () => { await flushSync(); };

/** A minimal but real document. `big` inflates the one field that actually makes
 *  a plan huge in the wild: a traced reference bitmap inlined as a data URL. */
const project = (over: Partial<Project> = {}, big = 0): Project => ({
  schema: 3,
  id: 'p1',
  name: 'Pieter Kleijnstraat 19',
  createdAt: T0 - 60_000,
  updatedAt: T0,
  source: { url: 'https://funda.nl/x', address: 'Rosmalen', title: null, projectId: 44432123, fetchedAt: T0 },
  floors: [{
    id: 'f1', name: 'Begane grond', level: 0,
    walls: [], areas: [], items: [], notes: [], dims: [], lines: [],
    ref: big ? { src: `data:image/png;base64,${'A'.repeat(big)}` } : null,
  }] as unknown as Project['floors'],
  ...over,
});

let said: { message: string; kind?: string }[] = [];
let stop: (() => void) | null = null;

beforeEach(() => {
  /* Date and nothing else: the pushes are promises rather than timers, and a
     faked setTimeout would mean nothing this file awaits ever resolves. */
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db.upserts = [];
  db.userId = 'user-1';
  said = [];
  resetSync();
  stop = startSync((message, kind) => said.push({ message, kind }));
});

afterEach(() => {
  stop?.();
  stop = null;
  resetSync();
  vi.useRealTimers();
});

/* ── the size ceiling ─────────────────────────────────────────────── */

describe('the oversized-document guard', () => {
  it('lets an ordinary document through', async () => {
    noteLocalChange(project());
    await flushSync();
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).toMatchObject({ client_id: 'p1', owner_id: 'user-1', floor_count: 1 });
    expect(said).toEqual([]);
  });

  it('refuses a document past the ceiling and says why, in megabytes', async () => {
    noteLocalChange(project({}, 5 * 1024 * 1024));
    await flushSync();

    expect(db.upserts).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0].kind).toBe('err');
    expect(said[0].message).toContain('“Pieter Kleijnstraat 19” is 5 MB');
    /* It has to name the cause and the way out, because nothing else in the app
       will ever mention it again. */
    expect(said[0].message).toContain('reference image');
    expect(said[0].message).toContain('stays saved in this browser');
  });

  /* Eight seconds is not a long time to wait between identical toasts. */
  it('complains once per plan, not once per push', async () => {
    const huge = project({}, 5 * 1024 * 1024);
    for (let i = 0; i < 4; i++) {
      noteLocalChange(huge);
      vi.setSystemTime(T0 + i * 60_000);
      await flushSync();
    }
    expect(said).toHaveLength(1);
    expect(db.upserts).toEqual([]);
  });

  /* Removing the reference image is the documented fix, so the plan has to be
     able to come back — and to complain again if it grows a second one. */
  it('forgets the complaint once the plan fits again', async () => {
    noteLocalChange(project({}, 5 * 1024 * 1024));
    await flushSync();
    noteLocalChange(project());
    await flushSync();
    expect(db.upserts).toHaveLength(1);

    noteLocalChange(project({}, 5 * 1024 * 1024));
    await flushSync();
    expect(said).toHaveLength(2);
    expect(db.upserts).toHaveLength(1);
  });

  it('says it separately for each plan that is too big', async () => {
    noteLocalChange(project({ id: 'p1', name: 'One' }, 5 * 1024 * 1024));
    await flushSync();
    noteLocalChange(project({ id: 'p2', name: 'Two' }, 5 * 1024 * 1024));
    await flushSync();
    expect(said.map(s => s.message.slice(0, 6))).toEqual(['“One” ', '“Two” ']);
  });

  /* resetSync is sign-out: the next account must not inherit the last one's
     complaint and therefore never hear about its own oversized plan. */
  it('starts complaining again after a sign-out', async () => {
    const huge = project({}, 5 * 1024 * 1024);
    noteLocalChange(huge);
    await flushSync();
    resetSync();
    noteLocalChange(huge);
    await flushSync();
    expect(said).toHaveLength(2);
  });
});

/* ── the clock ───────────────────────────────────────────────────── */

describe('noteLocalChange and maybePush', () => {
  it('noteLocalChange touches nothing on its own', async () => {
    noteLocalChange(project());
    noteLocalChange(project({ name: 'renamed' }));
    await new Promise(r => setTimeout(r, 0));
    expect(db.upserts).toEqual([]);
  });

  /* The editor calls this on every save, including the one that follows a
     closed plan. */
  it('ignores a null project', async () => {
    noteLocalChange(null);
    await flushSync();
    expect(db.upserts).toEqual([]);
  });

  it('pushes on the first tick after a change', async () => {
    noteLocalChange(project());
    maybePush();
    await settle();
    expect(db.upserts).toHaveLength(1);
  });

  it('does nothing when there is nothing pending', async () => {
    noteLocalChange(project());
    maybePush();
    await settle();
    maybePush();
    await new Promise(r => setTimeout(r, 0));
    expect(db.upserts).toHaveLength(1);
  });

  it('holds a burst of edits inside the interval to one push', async () => {
    noteLocalChange(project());
    maybePush();
    await settle();

    for (let t = 1_000; t < PUSH_INTERVAL_MS; t += 1_000) {
      vi.setSystemTime(T0 + t);
      noteLocalChange(project({ name: `edit at ${t}` }));
      maybePush();
    }
    await new Promise(r => setTimeout(r, 0));
    expect(db.upserts).toHaveLength(1);
  });

  it('pushes again once the interval has elapsed, and sends the latest version', async () => {
    noteLocalChange(project());
    maybePush();
    await settle();

    vi.setSystemTime(T0 + 4_000);
    noteLocalChange(project({ name: 'first edit' }));
    maybePush();
    await new Promise(r => setTimeout(r, 0));
    expect(db.upserts).toHaveLength(1);

    vi.setSystemTime(T0 + 4_000 + PUSH_INTERVAL_MS);
    noteLocalChange(project({ name: 'second edit' }));
    maybePush();
    await settle();
    expect(db.upserts).toHaveLength(2);
    /* The pending slot holds one document, not a queue — the interval exists to
       collapse the burst, so only the newest version is ever sent. */
    expect(db.upserts[1]).toMatchObject({ name: 'second edit' });
  });

  /* flushSync is what starting a render and hiding the tab both call, and
     neither can afford to be told "not yet". */
  it('flushSync ignores the interval entirely', async () => {
    noteLocalChange(project());
    await flushSync();
    noteLocalChange(project({ name: 'immediately after' }));
    await flushSync();
    expect(db.upserts).toHaveLength(2);
  });

  /* No session means no owner_id, and a row without one is a row RLS would
     refuse anyway. */
  it('pushes nothing when nobody is signed in', async () => {
    db.userId = null;
    noteLocalChange(project());
    await flushSync();
    expect(db.upserts).toEqual([]);
    expect(said).toEqual([]);
  });
});

/* ── the tombstone ────────────────────────────────────────────────── */

describe('deleting a plan stays deleted', () => {
  /** Regression. `rowOf` used to emit `deleted_at: null`, and PostgREST turns an
   *  upsert into ON CONFLICT DO UPDATE over exactly the columns in the payload —
   *  so every background push cleared the tombstone and a deleted plan came back
   *  in the library, minus the renders that had been hard-deleted with it. Two
   *  independent reviewers found this; it is worth a test that cannot rot. */
  it('never sends deleted_at, so a push cannot un-delete a plan', async () => {
    noteLocalChange(project());
    await flushSync();

    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).not.toHaveProperty('deleted_at');
  });

  it('still sends everything the library list is built from', async () => {
    noteLocalChange(project());
    await flushSync();

    /* If a column stops being written the library shows a plan with no address
       or no floor count, which reads as a corrupt plan rather than a sync bug. */
    expect(db.upserts[0]).toMatchObject({
      client_id: 'p1',
      name: 'Pieter Kleijnstraat 19',
      address: 'Rosmalen',
      source_url: 'https://funda.nl/x',
      funda_project_id: 44432123,
      floor_count: 1,
      owner_id: 'user-1',
    });
  });
});
