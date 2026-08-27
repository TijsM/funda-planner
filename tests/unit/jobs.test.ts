import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import {
  DEFAULT_CONTROL_SCALE, MAX_INFLIGHT, POLL_TIMEOUT_MS, SEED_MAX, acceptJob,
  applyPoll, applySettings, attachedControls, busy, failJob, inFlight, nextSeed,
  outputDims, parseSeed, pollDelay, promptControls, promptKeyOf, settingsOf, startJob,
  submittedSettings, timedOut,
  type JobState, type PollResponse, type RenderJob,
} from '@state/renders';
import {
  CONTROL_KINDS, DEFAULT_PROVIDER, PROVIDER_META, ceilingUsd, estimateUsd, metaOf,
  modelLabelOf, type ControlKind,
} from '@data/providers';
import { fmlToProject } from '@engine/index';
import { PASS_KINDS } from '@engine/passes';
import type { Fml } from '@engine/io/funda';
import { statusUrl } from '@shell/jobs';
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
  provider: DEFAULT_PROVIDER, controls: [], controlScale: DEFAULT_CONTROL_SCALE,
};

/** `settingsOf` reads the store, where none of the three provider fields is
 *  optional — a settings value on a record may be missing them, the live state
 *  never is. */
const STORE = { ...SETTINGS, provider: DEFAULT_PROVIDER, controls: [], controlScale: DEFAULT_CONTROL_SCALE };

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

  it('names the provider in a local poll, and nothing but the row in a cloud one', () => {
    /* The status route checks the pollUrl against the named provider's own hosts
       and nothing else, so an unnamed local job is tried as FLUX.2 — and every
       fal render then dies at that check having already been paid for. Cloud mode
       must NOT carry it: the row holds the provider, and a browser-supplied one
       would be a second answer to a question the row has already settled. */
    const fal = job({ jobId: 'abc', pollUrl: 'https://queue.fal.run/x', settings: { ...SETTINGS, provider: 'z-image-cn' } });
    const local = statusUrl(fal);
    expect(local).toContain('provider=z-image-cn');
    expect(local).toContain(`pollUrl=${encodeURIComponent('https://queue.fal.run/x')}`);
    expect(statusUrl({ ...fal, renderId: 'row-1' })).toBe('/api/render/status?renderId=row-1');

    /* settings from before the picker name nobody, and the route refuses the
       literal string "undefined" by name rather than falling back */
    const legacy = job({ jobId: 'abc', pollUrl: POLL_URL, settings: { ...SETTINGS, provider: undefined } });
    expect(statusUrl(legacy)).toContain(`provider=${DEFAULT_PROVIDER}`);
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

  it('carries exactly the ten settings, and nothing else from the store', () => {
    expect(Object.keys(settingsOf({ ...STORE, style: 'x' })).sort())
      .toEqual(['controlScale', 'controls', 'dimensions', 'furniture', 'imgMeasures',
        'provider', 'room', 'roomLabels', 'style', 'view']);
  });

  /* The row is a receipt. It said "line, depth, segments" while flux-general was
     handed one of them, and re-running that receipt then attached maps the picture
     never had — a re-run that is not a re-run. */
  it('records the maps that were sent, not the ones that were ticked', () => {
    const chosen = { ...STORE, provider: 'flux-general-cn', controls: ['seg', 'depth', 'line'] as ControlKind[] };
    expect(settingsOf(chosen).controls).toEqual(['seg', 'depth', 'line']);
    expect(submittedSettings(chosen).controls).toEqual(['depth']);
    /* and nothing else about the settings is touched on the way through */
    expect({ ...submittedSettings(chosen), controls: [] }).toEqual({ ...settingsOf(chosen), controls: [] });
  });

  /* The store's array outlives the record: a settings value that aliases it is a
     receipt that changes when someone ticks another map, and re-running it would
     then send maps the render never had. */
  it('copies the control list instead of aliasing the store\'s', () => {
    const live = { ...STORE, controls: ['line'] as ControlKind[] };
    const captured = settingsOf(live);
    live.controls.push('depth');
    expect(captured.controls).toEqual(['line']);
  });

  /* The reference carries no annotation on any setting now, so there is no flag
     left to restore. A record written in the window when it did keeps the key —
     it is a fact about how that render was made — and "use these settings" simply
     has nothing to do with it. */
  it('ignores the retired annotation flag on an old record', () => {
    const old = { ...record, settings: { ...SETTINGS, imgLabels: true } };
    expect('imgLabels' in applySettings(old, 'p1', 0)).toBe(false);
  });
});

/* ── which maps actually go out ───────────────────────────────────── */

/** The picker offers four maps; what reaches the provider is a narrower list, and
 *  every narrowing here is one the vendor's own wire contract forces. Getting this
 *  wrong is not a cosmetic bug: the brief numbers the attached images from the
 *  same array, so a list that disagrees with what was sent describes image 2 and
 *  attaches image 3. */
describe('the maps that actually go', () => {
  it('offers exactly the passes that can draw a control map, and not the reference', () => {
    expect(CONTROL_KINDS).toEqual(['line', 'depth', 'seg', 'change']);
    /* The list is declared beside `ControlKind` in @data/providers, where the
       render route can reach it without importing the browser's store — so this
       is the only thing left tying it to the engine that has to draw them. A
       sixth pass added there and left out here would otherwise be invisible in
       the picker; `ink` is the reference image, never a control channel. */
    expect([...CONTROL_KINDS].sort()).toEqual(PASS_KINDS.filter(k => k !== 'ink').sort());
  });

  /* z-image reads `usableControls(...)[0]` and flux-general sends a single-element
     `controlnets` array — fal's reference says one. A second map would be accepted
     and ignored, and a sweep would file "line + depth" having measured line. */
  it('hands a real control channel exactly one map', () => {
    expect(attachedControls('z-image-cn', ['line', 'depth', 'seg'])).toEqual(['line']);
    expect(attachedControls('flux-general-cn', ['depth', 'line'])).toEqual(['depth']);
  });

  /* Dropped, never demoted. Sending a segmentation map to flux-general as an
     extra reference picture would be a different experiment from the one that was
     asked for, run at the same price. */
  it('drops a kind the control channel does not take rather than sending it another way', () => {
    expect(attachedControls('flux-general-cn', ['seg', 'change'])).toEqual([]);
    expect(attachedControls('z-image-cn', ['change', 'seg'])).toEqual(['seg']);
  });

  /* Each attached map buys the brief a sentence in the opening block BFL
     documents a 30-80 word window for; all four put it at 160 words, where the
     end of it is no longer being read. */
  it('caps a provider with no control channel at two, in the order they were ticked', () => {
    expect(attachedControls('flux2-max', ['depth', 'line', 'seg', 'change'])).toEqual(['depth', 'line']);
    expect(attachedControls('qwen-edit', ['change', 'seg'])).toEqual(['change', 'seg']);
  });

  /* The brief says "Image 2 is…" and "Image 3 is…" off this array. Two copies of
     one kind would attach the same picture twice and burn a slot describing it. */
  it('never attaches the same kind twice', () => {
    expect(attachedControls('flux2-max', ['line', 'line', 'depth'])).toEqual(['line', 'depth']);
  });

  /* Idempotent, and it has to be: a record stores the narrowed list, so "use these
     settings" runs it through here a second time. If the second pass narrowed
     further, the restored prompt would go stale on arrival and be rebuilt over —
     which is exactly the hand-edited prompt that render was made from. */
  it('narrows to a list that narrows to itself', () => {
    for (const p of PROVIDER_META) {
      const once = attachedControls(p.id, CONTROL_KINDS);
      expect(attachedControls(p.id, once)).toEqual(once);
    }
  });

  it('falls back to the default provider rather than attaching nothing at all', () => {
    expect(attachedControls(undefined, ['line'])).toEqual(attachedControls(DEFAULT_PROVIDER, ['line']));
    expect(attachedControls('a-provider-that-was-renamed', ['line'])).toEqual(['line']);
  });

  /* The sentences describe pictures the model is handed. On z-image the map IS
     `image_url` — it replaces the reference — so a brief calling it image 2 names
     an image nobody sent, and one calling image 1 the plan is simply wrong. */
  it('tells the brief about the reference riders and nothing about a control channel', () => {
    expect(promptControls('flux2-max', ['depth', 'line'])).toEqual(['depth', 'line']);
    expect(promptControls('qwen-edit', ['line'])).toEqual(['line']);
    expect(promptControls('z-image-cn', ['line'])).toEqual([]);
    expect(promptControls('flux-general-cn', ['line'])).toEqual([]);
  });
});

describe('the prompt the maps are named in', () => {
  const withMaps = (over: Partial<RenderSettings>): RenderSettings => ({ ...SETTINGS, ...over });

  /* A map attached to a brief that does not name it is the failure the sentences
     exist to prevent: an unannounced depth ramp comes back painted onto the floor
     as a grey gradient. So turning one on has to invalidate the prompt on screen. */
  it('goes stale the moment a map is attached', () => {
    const off = promptKeyOf('p1', 'f1', 0, withMaps({ controls: [] }));
    const on = promptKeyOf('p1', 'f1', 0, withMaps({ controls: ['line'] }));
    expect(on).not.toBe(off);
  });

  /* And stays current when the words cannot change. Ticking a map z-image cannot
     be given does not alter a syllable of the brief, and rebuilding for it would
     throw away a hand-edited prompt for nothing. */
  it('stays current when the map cannot reach the words', () => {
    const a = promptKeyOf('p1', 'f1', 0, withMaps({ provider: 'z-image-cn', controls: [] }));
    const b = promptKeyOf('p1', 'f1', 0, withMaps({ provider: 'z-image-cn', controls: ['line'] }));
    expect(b).toBe(a);
  });

  it('goes stale when a provider change moves the map out of the brief', () => {
    const rider = promptKeyOf('p1', 'f1', 0, withMaps({ provider: 'flux2-max', controls: ['line'] }));
    const channel = promptKeyOf('p1', 'f1', 0, withMaps({ provider: 'z-image-cn', controls: ['line'] }));
    expect(channel).not.toBe(rider);
  });

  /* Order is the numbering. line-then-depth and depth-then-line are two different
     briefs, and the one that does not match what was attached describes the wrong
     picture in both sentences. */
  it('treats the order the maps were ticked in as part of the prompt', () => {
    expect(promptKeyOf('p1', 'f1', 0, withMaps({ controls: ['line', 'depth'] })))
      .not.toBe(promptKeyOf('p1', 'f1', 0, withMaps({ controls: ['depth', 'line'] })));
  });

  it('reads a record from before the picker as a brief with no maps in it', () => {
    const old = { ...SETTINGS, provider: undefined, controls: undefined, controlScale: undefined };
    expect(promptKeyOf('p1', 'f1', 0, old))
      .toBe(promptKeyOf('p1', 'f1', 0, withMaps({ provider: DEFAULT_PROVIDER, controls: [] })));
  });
});

/* ── the money ───────────────────────────────────────────────────── */

/** The product owner's ceiling is $0.10 an image and `assertAffordable` enforces
 *  it server-side by refusing the call. Everything here is about not arriving
 *  there: a size the route will refuse reaches the user as a 400 about money,
 *  after they pressed Generate. */
describe('the size the panel asks for', () => {
  const SHAPES = [[1800, 1013], [1013, 1800], [1800, 1800], [1216, 832], [900, 900]] as const;

  it('stays under the spending ceiling on every provider, at every plan shape', () => {
    for (const p of PROVIDER_META) {
      for (const [w, h] of SHAPES) {
        const d = outputDims(w, h, p.id);
        const cost = estimateUsd(p, d.width, d.height);
        expect(cost).not.toBeNull();
        /* Each provider's own ceiling: a model that bills for the images it is
           HANDED cannot be held to a number set for models that bill only for
           the one they draw — see `ProviderMeta.maxUsdPerImage`. */
        expect(cost!, p.id).toBeLessThanOrEqual(ceilingUsd(p));
        expect(d.width % p.dimStep).toBe(0);
        expect(d.height % p.dimStep).toBe(0);
      }
    }
  });

  /* flux-general bills "rounded up to the nearest megapixel", so 1.05 MP costs
     $0.15 and is refused. Priced as a fraction it reads $0.079 and sails through —
     which is the mistake this pins: the aim has to come down to a whole megapixel
     rather than the ceiling's 1.33. */
  it('holds the round-up provider to one whole megapixel', () => {
    const d = outputDims(1800, 1013, 'flux-general-cn');
    expect(d.width * d.height).toBeLessThanOrEqual(1_000_000);
    expect(estimateUsd(metaOf('flux-general-cn'), d.width, d.height)).toBeCloseTo(0.075, 6);
  });

  /* The ceiling does not bite at 1 MP on anything today, which is exactly why this
     asks for three: the guard is invisible until the day the target moves or a
     vendor's price does, and an invisible guard is one nobody notices removing. */
  it('will not aim above what the ceiling buys, even when asked for three megapixels', () => {
    for (const p of PROVIDER_META) {
      const d = outputDims(1800, 1013, p.id, 3_000_000);
      const cost = estimateUsd(p, d.width, d.height);
      expect(cost).not.toBeNull();
      expect(cost!, p.id).toBeLessThanOrEqual(ceilingUsd(p));
    }
    /* The same request, two sizes: [max] has 1.43 MP of headroom under a dime,
       and flux-general has exactly one whole megapixel because it rounds up. */
    const max = outputDims(1800, 1013, 'flux2-max', 3_000_000);
    const gen = outputDims(1800, 1013, 'flux-general-cn', 3_000_000);
    expect(max.width * max.height).toBeGreaterThan(1_000_000);
    expect(gen.width * gen.height).toBeLessThanOrEqual(1_000_000);
  });

  it('does not shrink the picture on the providers the ceiling does not bite', () => {
    /* 1 MP is the aim everywhere; the ceiling only matters where it lands below
       it. If this ever fails, every render just got smaller for everyone. */
    const a = outputDims(1800, 1013, 'flux2-max');
    const b = outputDims(1800, 1013, 'z-image-cn');
    expect(a).toEqual(b);
    expect(a.width * a.height).toBeGreaterThan(900_000);
  });

  it('keeps the plan\'s aspect ratio whichever provider is chosen', () => {
    for (const p of PROVIDER_META) {
      const d = outputDims(1800, 1013, p.id);
      expect(d.width / d.height).toBeCloseTo(1800 / 1013, 1);
    }
  });
});

describe('which model a record says drew it', () => {
  it('names the provider that was actually used', () => {
    expect(modelLabelOf('z-image-cn')).toBe(metaOf('z-image-cn').label);
    expect(modelLabelOf('flux2-flex')).toBe('FLUX.2 [flex]');
  });

  /* A record written before there was a picker carries no provider id, and the
     only provider there was is the honest answer — not "unknown". */
  it('falls back to the only provider there used to be', () => {
    expect(modelLabelOf(undefined)).toBe(metaOf(DEFAULT_PROVIDER).label);
    expect(modelLabelOf(null)).toBe(metaOf(DEFAULT_PROVIDER).label);
  });
});

describe('re-running a record from before the picker', () => {
  const old: RenderRecord = {
    id: 'r1', projectId: 'p1', floorId: 'f1', parentId: null,
    prompt: 'a brief that never mentioned a map',
    settings: {
      view: 'top', room: '*', style: '', furniture: true,
      dimensions: true, roomLabels: false, imgMeasures: false,
    },
    seed: 3, model: 'flux-2-max', status: 'ready', blob: null,
    createdAt: 1, durationMs: 1,
  };

  /* The `imgLabels` precedent: an absent key is a fact about how that render was
     made, not a gap to fill from whatever is on screen. Re-running a FLUX.2
     render on z-image because z-image happened to be selected would answer a
     question nobody asked and file it under the old render's lineage. */
  it('re-runs as the provider it was, with no maps and the default dial', () => {
    const p = applySettings(old, 'p1', 0);
    expect(p.provider).toBe(DEFAULT_PROVIDER);
    expect(p.controls).toEqual([]);
    expect(p.controlScale).toBe(DEFAULT_CONTROL_SCALE);
  });

  it('does not hand the store an array the record still holds', () => {
    const rec = { ...old, settings: { ...old.settings, controls: ['line' as const] } };
    const p = applySettings(rec, 'p1', 0);
    (p.controls as string[]).push('depth');
    expect(rec.settings.controls).toEqual(['line']);
  });
});

/* ── the conditioning images ──────────────────────────────────────── */

/** The one thing about this half that cannot be checked by reading: whether the
 *  control maps come out of the same frame as the reference image beside them.
 *
 *  `renderFloorCanvas` reaches for `document` to make its canvas, and that is the
 *  only line of DOM in the path — @napi-rs/canvas answers the same API, which is
 *  what lets Node draw the plan at all. */
describe('the conditioning images', () => {
  const FIX = path.join(__dirname, '..', 'fixtures');
  const fml = JSON.parse(fs.readFileSync(path.join(FIX, 'floorplanner-project.fml'), 'utf8')) as Fml;
  const GROUND = fmlToProject(fml).floors[1];

  let realDoc: unknown;
  let files: typeof import('@shell/files');

  beforeAll(async () => {
    realDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
      createElement: (tag: string) => {
        if (tag !== 'canvas') throw new Error(`the shell asked for a <${tag}>, which this shim has none of`);
        return createCanvas(1, 1);
      },
    };
    files = await import('@shell/files');
  });
  afterAll(() => { (globalThis as { document?: unknown }).document = realDoc; });

  /* `room` is in here because the numbering on the picture is scoped the way the
     brief is: a room-scoped render numbers that room's objects and no others. */
  const REF = { furniture: true, roomLabels: false, imgMeasures: false, imgLabels: true, room: '*' };

  it('frames every control map exactly like the reference beside it', () => {
    const opts = files.referenceOpts(REF);
    const ref = files.renderFloorCanvas(GROUND, opts);
    expect(ref).not.toBeNull();
    const maps = files.renderControlCanvases(GROUND, ['line', 'depth'], opts);
    expect(maps.map(m => m.kind)).toEqual(['line', 'depth']);
    for (const m of maps) {
      expect([m.canvas.width, m.canvas.height]).toEqual([ref!.width, ref!.height]);
    }
  });

  /* `measures` changes the margin the frame solves for, and no pass draws a
     dimension chain — so it would be easy to leave it out of the map's options and
     never notice, until every map was framed tighter than the picture it
     conditions. The reference and the maps have to move together. */
  it('moves the maps when the reference reframes for measurements', () => {
    const plain = files.renderFloorCanvas(GROUND, files.referenceOpts(REF));
    const measured = files.renderFloorCanvas(GROUND, files.referenceOpts({ ...REF, imgMeasures: true }));
    expect(measured!.width).not.toBe(plain!.width);
    const map = files.renderControlCanvases(GROUND, ['line'], files.referenceOpts({ ...REF, imgMeasures: true }))[0];
    expect([map.canvas.width, map.canvas.height]).toEqual([measured!.width, measured!.height]);
  });

  /* The print path's default is 3600 px and `planFrame`'s contract default is
     1800. Reading the frame's default here would have halved every PNG export
     without a single test noticing. */
  it('still exports the print at print resolution', () => {
    const print = files.renderFloorCanvas(GROUND, { measures: true });
    expect(Math.max(print!.width, print!.height)).toBeGreaterThan(1800);
    const reference = files.renderFloorCanvas(GROUND, files.referenceOpts(REF));
    expect(Math.max(reference!.width, reference!.height)).toBe(files.REFERENCE_MAX_PX);
  });

  it('draws a map that is not the plan', () => {
    const opts = files.referenceOpts(REF);
    const ink = files.renderFloorCanvas(GROUND, opts);
    const seg = files.renderFloorCanvas(GROUND, { ...opts, pass: 'seg' });
    /* Same bytes would mean `pass` was ignored and we had just paid to send the
       reference image twice. */
    expect(files.pngBase64(seg!)).not.toBe(files.pngBase64(ink!));
  });

  it('hands the provider raw base64, with no data: container in it', () => {
    const b64 = files.pngBase64(files.renderFloorCanvas(GROUND, { ...files.referenceOpts(REF), pass: 'line' })!);
    expect(b64.startsWith('data:')).toBe(false);
    /* every PNG starts with the same eight-byte signature, so this is the cheap
       way to say "these are the bytes of an image and not a URL to one" */
    expect(b64.startsWith('iVBORw0KGgo')).toBe(true);
  });

  it('returns nothing for a floor with nothing on it, rather than a blank map', () => {
    const empty = { ...GROUND, walls: [], areas: [], items: [], dims: [], lines: [], notes: [], ref: null };
    expect(files.renderFloorCanvas(empty, { pass: 'line' })).toBeNull();
    expect(files.renderControlCanvases(empty, ['line', 'depth'], {})).toEqual([]);
  });
});
