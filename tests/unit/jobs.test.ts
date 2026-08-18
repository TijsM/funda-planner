import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_INFLIGHT, POLL_TIMEOUT_MS, SEED_MAX, acceptJob, applyPoll, applySettings, busy, failJob,
  inFlight, nextSeed, outputDims, parseSeed, pollDelay, promptKeyOf, settingsOf, startJob,
  timedOut, type JobState, type PollResponse, type RenderJob,
} from '@state/renders';
import { poll, type PollResult } from '../../src/server/providers/bfl';
import type { RenderRecord, RenderSettings } from '@shell/renders';

/** The render lifecycle, end to end but offline: BFL's eight statuses through
 *  the adapter's mapping, then the same answers folded into the job state.
 *
 *  `fetch` is replaced wholesale rather than intercepted, so a mistake here is
 *  a TypeError, never a request that reaches api.bfl.ai and costs a credit. */

const SETTINGS: RenderSettings = {
  view: 'top', room: '*', style: '', furniture: true,
  dimensions: true, roomLabels: false, imgMeasures: true,
};

const job = (over: Partial<RenderJob> = {}): RenderJob => ({
  id: 'j1', jobId: '', pollUrl: '', projectId: 'p1', floorId: 'f1', parentId: null,
  prompt: 'Reproduce exactly the layout in the reference image.',
  settings: SETTINGS, seed: 7, width: 832, height: 1168, startedAt: 1000, progress: null,
  ...over,
});

const empty: JobState = { jobs: {}, sessionCount: 0 };

/* ── the adapter's status table ───────────────────────────────────── */

const realFetch = globalThis.fetch;
let calls: string[] = [];

/** Answers every poll with one payload. Records the URL so "never touched the
 *  network" is an assertion rather than a hope. */
function answer(payload: unknown, status = 200) {
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const POLL_URL = 'https://api.eu1.bfl.ai/v1/get_result?id=abc';

beforeAll(() => { process.env.FLUX_API_KEY = 'test-key-never-sent-anywhere'; });
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; });

/* Every status BFL documents, plus `Failed` (in every official sample but not in
   the OpenAPI enum) and two the adapter has never heard of. */
const STATUSES: { name: string; payload: Record<string, unknown>; expect: PollResult['status']; retryable?: boolean }[] = [
  { name: 'Pending', payload: { status: 'Pending' }, expect: 'pending' },
  { name: 'Reasoning', payload: { status: 'Reasoning', progress: 0.1 }, expect: 'pending' },
  { name: 'Generating', payload: { status: 'Generating', progress: 0.6 }, expect: 'pending' },
  { name: 'Ready', payload: { status: 'Ready', result: { sample: 'https://delivery.eu1.bfl.ai/x.png' } }, expect: 'ready' },
  { name: 'Request Moderated', payload: { status: 'Request Moderated', details: { 'Moderation Reasons': ['nsfw'] } }, expect: 'failed', retryable: false },
  { name: 'Content Moderated', payload: { status: 'Content Moderated' }, expect: 'failed', retryable: true },
  { name: 'Error', payload: { status: 'Error', details: { reason: 'upstream blew up' } }, expect: 'failed', retryable: true },
  { name: 'Task not found', payload: { status: 'Task not found' }, expect: 'failed', retryable: false },
  { name: 'Failed', payload: { status: 'Failed' }, expect: 'failed', retryable: false },
  { name: 'an unrecognised status', payload: { status: 'Rendering Sideways' }, expect: 'failed', retryable: false },
  { name: 'no status field at all', payload: { id: 'abc' }, expect: 'failed', retryable: false },
];

describe('the provider status table', () => {
  for (const s of STATUSES) {
    it(`maps ${s.name} to ${s.expect}`, async () => {
      answer(s.payload);
      const r = await poll(POLL_URL);
      expect(r.status).toBe(s.expect);
      if (r.status === 'failed') expect(r.retryable).toBe(s.retryable);
      /* the polling URL is cluster-specific — a rebuilt one answers "Task not
         found", so it has to go out exactly as it came in */
      expect(calls).toEqual([POLL_URL]);
    });
  }

  it('reads only result.sample on Ready, never result.seed', async () => {
    answer({ status: 'Ready', result: { sample: 'https://delivery.eu1.bfl.ai/x.png', seed: 999 } });
    const r = await poll(POLL_URL);
    expect(r).toEqual({ status: 'ready', imageUrl: 'https://delivery.eu1.bfl.ai/x.png', cost: null });
  });

  it('calls Ready-without-an-image a failure rather than handing back nothing', async () => {
    answer({ status: 'Ready', result: null });
    const r = await poll(POLL_URL);
    expect(r.status).toBe('failed');
  });

  it('gives every failure its own sentence', async () => {
    const said = new Set<string>();
    for (const s of STATUSES) {
      answer(s.payload);
      const r = await poll(POLL_URL);
      if (r.status === 'failed') said.add(r.error);
    }
    /* "The render failed at the provider." on all seven would leave the user
       re-rolling a seed against a moderation block that will never pass. */
    expect(said.size).toBe(STATUSES.filter(s => s.expect === 'failed').length);
    for (const line of said) expect(line.length).toBeGreaterThan(20);
  });

  it('surfaces the provider\'s own words for a moderation block', async () => {
    answer({ status: 'Request Moderated', details: { 'Moderation Reasons': ['contains a person', 'nudity'] } });
    const r = await poll(POLL_URL);
    expect(r.status === 'failed' && r.error).toContain('contains a person; nudity');
  });

  /* BFL answers a bad key with 422, the same status it uses for a malformed
     body — so the plain 422 path phrased a server misconfiguration as though the
     plan were at fault, and the person pressing Generate was shown only
     "Invalid API key format" with nothing to act on. */
  it('names the variable when the provider rejects the key, rather than blaming the request', async () => {
    answer({ detail: 'Invalid API key format' }, 422);
    await expect(poll(POLL_URL)).rejects.toMatchObject({
      message: expect.stringContaining('FLUX_API_KEY'),
    });
    answer({ detail: 'Invalid API key format' }, 422);
    await expect(poll(POLL_URL)).rejects.toMatchObject({
      message: expect.stringContaining('dashboard.bfl.ai'),
    });
  });

  it('still blames the request when the 422 really is about a field', async () => {
    answer({ detail: [{ loc: ['body', 'width'], msg: 'must be a multiple of 16', type: 'value_error' }] }, 422);
    await expect(poll(POLL_URL)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('multiple of 16'),
    });
  });
});

/* ── terminality: the loop has to stop ────────────────────────────── */

/** What `/api/render/status` hands the poller, derived from the adapter's own
 *  answer exactly as `app/api/render/status/route.ts` derives it. */
function asClient(r: PollResult): PollResponse {
  if (r.status === 'pending') return { status: 'pending', progress: r.progress };
  if (r.status === 'ready') return { status: 'ready', image: 'iVBORw0KGgo=' };
  return { status: 'failed', error: r.error, retryable: r.retryable };
}

describe('folding a poll into the job', () => {
  const running = startJob(empty, job({ jobId: 'abc', pollUrl: POLL_URL }));

  for (const s of STATUSES) {
    it(`${s.name} ${s.expect === 'pending' ? 'keeps' : 'settles'} the job`, async () => {
      answer(s.payload);
      const next = applyPoll(running, 'j1', asClient(await poll(POLL_URL)));
      expect('j1' in next.jobs).toBe(s.expect === 'pending');
    });
  }

  it('never loops on a status it does not recognise', async () => {
    /* The failure this guards against is a client that treats "unknown" as "keep
       polling" and then spins for the whole three minutes over a typo. */
    answer({ status: 'Rendering Sideways' });
    const res = asClient(await poll(POLL_URL));

    let s = running;
    let folds = 0;
    while (inFlight(s).length && folds < 500) { s = applyPoll(s, 'j1', res); folds++; }
    expect(folds).toBe(1);
  });

  it('reports progress while pending and drops it on the way out', async () => {
    answer({ status: 'Generating', progress: 0.42 });
    const mid = applyPoll(running, 'j1', asClient(await poll(POLL_URL)));
    expect(mid.jobs.j1.progress).toBe(0.42);
    /* the map is replaced, not mutated — zustand's set() is a shallow top-level
       merge, so writing into the old object notifies nobody */
    expect(mid.jobs).not.toBe(running.jobs);
    expect(running.jobs.j1.progress).toBeNull();
  });

  it('ignores a poll for a job that was already given up on', async () => {
    answer({ status: 'Generating' });
    const res = asClient(await poll(POLL_URL));
    const after = failJob(running, 'j1');
    expect(applyPoll(after, 'j1', res)).toBe(after);
  });
});

/* ── the rest of the machine ──────────────────────────────────────── */

describe('the in-flight slot', () => {
  it('is claimed before the request goes out, so a double click buys one credit', () => {
    expect(busy(empty)).toBe(false);
    const one = startJob(empty, job());
    expect(busy(one)).toBe(true);
    expect(inFlight(one)).toHaveLength(MAX_INFLIGHT);
  });

  it('counts a session render when the provider accepts it, not when it is clicked', () => {
    const started = startJob(empty, job());
    expect(started.sessionCount).toBe(0);
    const accepted = acceptJob(started, 'j1', 'abc', POLL_URL);
    expect(accepted.sessionCount).toBe(1);
    expect(accepted.jobs.j1).toMatchObject({ jobId: 'abc', pollUrl: POLL_URL });
  });

  it('does not resurrect a job that has already settled', () => {
    expect(acceptJob(empty, 'j1', 'abc', POLL_URL)).toBe(empty);
    expect(failJob(empty, 'j1')).toBe(empty);
  });

  it('frees the slot on failure, and keeps the credit that was spent', () => {
    const accepted = acceptJob(startJob(empty, job()), 'j1', 'abc', POLL_URL);
    const after = failJob(accepted, 'j1');
    expect(busy(after)).toBe(false);
    expect(after.sessionCount).toBe(1);
  });
});

describe('the poll schedule', () => {
  it('backs off instead of hammering for three minutes', () => {
    expect(pollDelay(0)).toBe(1000);
    expect(pollDelay(9_999)).toBe(1000);
    expect(pollDelay(10_000)).toBe(2500);
    expect(pollDelay(59_999)).toBe(2500);
    expect(pollDelay(60_000)).toBe(4000);
    expect(pollDelay(175_000)).toBe(4000);
  });

  it('gives up at three minutes, not before', () => {
    const j = job({ startedAt: 0 });
    expect(timedOut(j, POLL_TIMEOUT_MS)).toBe(false);
    expect(timedOut(j, POLL_TIMEOUT_MS + 1)).toBe(true);
  });
});

describe('the numbers the request is built from', () => {
  it('lands on multiples of 16 at roughly a megapixel', () => {
    for (const [w, h] of [[1800, 1800], [1800, 1013], [1013, 1800], [640, 480], [3000, 400]]) {
      const d = outputDims(w, h);
      expect(d.width % 16).toBe(0);
      expect(d.height % 16).toBe(0);
      expect(d.width).toBeGreaterThanOrEqual(64);
      expect(d.height).toBeGreaterThanOrEqual(64);
      /* rounding down, never up: up can push the product past the provider's
         4 MP ceiling, and every megapixel is billed */
      expect(d.width * d.height).toBeLessThanOrEqual(1_000_000);
    }
  });

  it('keeps the plan\'s aspect ratio rather than squaring it off', () => {
    const d = outputDims(1800, 1013);
    expect(d.width).toBeGreaterThan(d.height);
    expect(d.width / d.height).toBeCloseTo(1800 / 1013, 1);
    /* the reference is 1800 px and ~3.2 MP; sending it back at that size is
       legal and roughly three times the price */
    expect(d.width).toBeLessThan(1800);
  });

  it('never asks for a side the provider will refuse', () => {
    const d = outputDims(1, 4000);
    expect(d.width).toBe(64);
    /* the point of the case: the MIN_DIM clamp raises one side without touching
       the other, and asserting only the width let 64x63232 — 4.05 MP, past the
       provider's ceiling and a 400 from our own route — pass as correct */
    expect(d.width * d.height).toBeLessThanOrEqual(4_000_000);
    expect(d.width % 16).toBe(0);
    expect(d.height % 16).toBe(0);
  });

  it('keeps every ordinary shape under the ceiling and on the grid', () => {
    for (const [w, h] of [[1800, 1200], [1200, 1800], [900, 900], [1800, 300], [64, 4000]]) {
      const d = outputDims(w, h);
      expect(d.width * d.height).toBeLessThanOrEqual(4_000_000);
      expect(d.width % 16).toBe(0);
      expect(d.height % 16).toBe(0);
      expect(d.width).toBeGreaterThanOrEqual(64);
      expect(d.height).toBeGreaterThanOrEqual(64);
    }
  });
});

describe('the seed', () => {
  it('reads only a whole number in range', () => {
    expect(parseSeed('1234')).toBe(1234);
    expect(parseSeed(' 42 ')).toBe(42);
    expect(parseSeed('0')).toBe(0);
    expect(parseSeed(String(SEED_MAX))).toBe(SEED_MAX);
    for (const bad of ['', '  ', 'abc', '12.5', '-3', '1e5', String(SEED_MAX + 1)]) {
      expect(parseSeed(bad)).toBeNull();
    }
  });

  it('reuses a locked seed and rolls a fresh one otherwise', () => {
    expect(nextSeed('1234', true)).toBe(1234);
    /* a locked seed that does not parse is not a seed — roll rather than send
       something the provider will reject */
    expect(nextSeed('nonsense', true)).not.toBe(NaN);
    const rolled = nextSeed('1234', false);
    expect(Number.isInteger(rolled) && rolled >= 0 && rolled <= SEED_MAX).toBe(true);
  });
});

describe('"use these settings"', () => {
  const record: RenderRecord = {
    id: 'r9', projectId: 'p1', floorId: 'f2', parentId: 'r4',
    prompt: 'a hand-edited prompt, kept verbatim',
    settings: { ...SETTINGS, view: 'iso', style: 'brutalist', roomLabels: true },
    seed: 555, model: 'flux-2-pro', status: 'ready', blob: null,
    createdAt: 10, durationMs: 1,
  };

  it('restores the exact prompt and makes the next render its child', () => {
    const p = applySettings(record, 'p1', 0);
    expect(p.prompt).toBe(record.prompt);
    expect(p.view).toBe('iso');
    expect(p.style).toBe('brutalist');
    expect(p.roomLabels).toBe(true);
    expect(p.seed).toBe('555');
    expect(p.parentId).toBe('r9');
    expect(p.selectedId).toBe('r9');
  });

  it('marks the restored prompt as current, so nothing rebuilds over it', () => {
    const p = applySettings(record, 'p1', 0);
    expect(p.promptKey).toBe(promptKeyOf('p1', 'f2', 0, record.settings));
    expect(promptKeyOf('p1', 'f2', 0, record.settings)).not.toBe(promptKeyOf('p1', 'f1', 0, record.settings));
  });

  /* The document is mutated in place and only `rev` moves, so a key without it
     let an edited plan keep its old prompt while the reference image redrew —
     and the prompt is the half that gets sent to the paid provider. */
  it('goes stale when the plan underneath it changes', () => {
    expect(promptKeyOf('p1', 'f1', 1, record.settings))
      .not.toBe(promptKeyOf('p1', 'f1', 2, record.settings));
  });

  it('leaves the seed field empty when the render never had one', () => {
    expect(applySettings({ ...record, seed: null }, 'p1', 0).seed).toBe('');
  });

  it('carries exactly the seven settings, and nothing else from the store', () => {
    expect(Object.keys(settingsOf({ ...SETTINGS, style: 'x' })).sort())
      .toEqual(['dimensions', 'furniture', 'imgMeasures', 'room', 'roomLabels', 'style', 'view']);
  });
});
