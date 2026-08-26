/** The sweep: plans x views x providers x control signals x scales x seeds.
 *
 *  It paints every conditioning image and control map in Node with the same
 *  `planFrame`/`paintPass` the browser uses, writes the ground-truth sidecar
 *  beside them, then talks HTTP to a running app exactly as the browser does —
 *  POST /api/render, GET /api/render/status — so the sweep exercises the real
 *  route, the real cost ceiling and the real provider code rather than a copy of
 *  them that can drift.
 *
 *  THE MONEY. Nothing is submitted until the estimate has been printed and
 *  `--yes` given, and the estimate is built from the same src/data/providers.ts
 *  the server enforces `assertAffordable` from. On top of that:
 *    - `--budget` (default $10) refuses a sweep whose estimate exceeds it, so a
 *      fat-fingered `--seeds 8` cannot quietly become a hundred dollars.
 *    - a cell whose single image would breach MAX_USD_PER_IMAGE is refused here
 *      as well as at the route, because a refusal after the submit arrives too
 *      late to be worth anything.
 *    - a run resumes into its own directory: a cell that already has a
 *      render.png is skipped, so a sweep that dies at image 180 of 240 is
 *      restarted for the price of the sixty that are left.
 *
 *  THE PREFLIGHT, and why it costs one image. The route does read `provider`,
 *  `controls` and `controlScale` — but a sweep cannot afford to take that on
 *  trust, because the failure is silent and expensive in both directions: a route
 *  that ignored the field would draw 240 FLUX.2 [max] images at eleven times the
 *  quoted price and file them as a ControlNet measurement, and a wrong key fails
 *  every cell one at a time. So the first thing the sweep does is submit one
 *  image and check which vendor's host the polling URL came back on. A mismatch
 *  aborts before the second image; a bad key aborts for nothing, since a rejected
 *  key is refused before the vendor bills anything. It cannot tell two providers
 *  of the SAME vendor apart ([max] from [flex], both api.bfl.ai) and reports
 *  `vendor` rather than claiming a verification it did not make.
 *
 *  `strength` is the one field of the contract the route deliberately does not
 *  read, so `parseArgs` refuses to sweep it rather than measuring a dial nobody
 *  is turning. See the note there.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { engine, fromRoot, loadPlan, PLANS } from './plans.mjs';
import { truthFor } from './truth.mjs';

const { planFrame, framedFloor } = await engine('frame.ts');
const { paintPass, PASS_KINDS } = await engine('passes.ts');
const { buildPrompt } = await engine('prompt.ts');
const {
  PROVIDER_META, DEFAULT_PROVIDER, MAX_USD_PER_IMAGE, metaOf, estimateUsd, maxAffordablePixels,
  affordableDims,
} = await fromRoot('src/data/providers.ts');

const RUNS = fileURLToPath(new URL('../../eval/runs/', import.meta.url));

/* ── the grid ────────────────────────────────────────────────────── */

/** Seeds are taken from this list in order rather than rolled, and the list is
 *  committed, because `eval:diff` pairs a run against the baseline on
 *  (plan, seed). A random seed makes every cell unpairable and turns the whole
 *  comparison into two independent means, which is the one thing the statistics
 *  section of the brief forbids. */
const SEEDS = [7, 1234, 20260818, 99991, 424242, 31337, 555, 8080];

/** No control map at all — the arm that reproduces what ships today, and the
 *  control condition every other arm has to be read against. */
const NO_CONTROL = 'none';

const VIEWS = ['top', 'eye', 'iso', 'sketch'];
const CONTROL_KINDS = PASS_KINDS.filter(k => k !== 'ink');

/** 1 MP. FLUX.2 bills per output megapixel and every fal model prices per
 *  megapixel per image, so output size is a money dial before it is a quality
 *  one; 1 MP is what the app itself aims at. */
const TARGET_PIXELS = 1_048_576;

/** The conditioning image's longest side. `planFrame`'s own default, which is
 *  what RenderModal asks for, so the sweep conditions on the same picture the
 *  app sends rather than a sharper one nobody ships. */
const MAX_PX = 1800;

const DEFAULTS = {
  plans: PLANS.map(p => p.id),
  views: ['top'],
  providers: [DEFAULT_PROVIDER],
  controls: [NO_CONTROL],
  controlScale: [null],
  strength: [null],
  seeds: 1,
  budget: 10,
  targetPixels: TARGET_PIXELS,
  maxPx: MAX_PX,
  concurrency: 2,
  timeout: 240_000,
  furniture: true,
  dimensions: false,
  baseUrl: process.env.EVAL_BASE_URL || 'http://localhost:3500',
};

const list = s => String(s).split(',').map(v => v.trim()).filter(Boolean);
const nums = s => list(s).map(v => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${v}" is not a number`);
  return n;
});

/** Flags, and a hard error on an unknown one. A typo silently ignored is a sweep
 *  that spends money on a grid nobody asked for: `--seed 3` instead of `--seeds 3`
 *  would run one seed and read as three. */
export function parseArgs(argv) {
  const o = { ...DEFAULTS, dry: false, yes: false, preflight: true, out: null, note: '' };
  const take = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry': o.dry = true; break;
      case '--yes': o.yes = true; break;
      case '--no-preflight': o.preflight = false; break;
      case '--no-furniture': o.furniture = false; break;
      case '--dimensions': o.dimensions = true; break;
      case '--plans': o.plans = list(take(i, 'plans')); i++; break;
      case '--views': o.views = list(take(i, 'views')); i++; break;
      case '--providers': o.providers = list(take(i, 'providers')); i++; break;
      case '--controls': o.controls = list(take(i, 'controls')); i++; break;
      case '--control-scale': o.controlScale = nums(take(i, 'control-scale')); i++; break;
      case '--strength': o.strength = nums(take(i, 'strength')); i++; break;
      case '--seeds': o.seeds = take(i, 'seeds'); i++; break;
      case '--budget': o.budget = Number(take(i, 'budget')); i++; break;
      case '--target-pixels': o.targetPixels = Number(take(i, 'target-pixels')); i++; break;
      case '--max-px': o.maxPx = Number(take(i, 'max-px')); i++; break;
      case '--concurrency': o.concurrency = Number(take(i, 'concurrency')); i++; break;
      case '--timeout': o.timeout = Number(take(i, 'timeout')) * 1000; i++; break;
      case '--base-url': o.baseUrl = take(i, 'base-url'); i++; break;
      case '--out': o.out = take(i, 'out'); i++; break;
      case '--note': o.note = take(i, 'note'); i++; break;
      default:
        throw new Error(`unknown flag ${a}. See docs/EVAL.md.`);
    }
  }

  /* `--seeds 2` means the first two committed seeds; `--seeds 7,1234` means
     those two. Both spellings are wanted — a sweep says how MANY seeds, a repro
     says WHICH — and a count resolves against the committed list so it stays
     pairable with the baseline either way. */
  const raw = String(o.seeds);
  if (/^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= SEEDS.length) {
    o.seeds = SEEDS.slice(0, Number(raw));
  } else {
    o.seeds = nums(raw);
    if (!o.seeds.length) throw new Error('--seeds needs a count or a comma-separated list');
  }

  for (const p of o.plans) {
    if (!PLANS.some(x => x.id === p)) {
      throw new Error(`no fixture plan "${p}". Known: ${PLANS.map(x => x.id).join(', ')}`);
    }
  }
  for (const v of o.views) {
    if (!VIEWS.includes(v)) throw new Error(`unknown view "${v}". Known: ${VIEWS.join(', ')}`);
  }
  for (const c of o.controls) {
    if (c !== NO_CONTROL && !CONTROL_KINDS.includes(c)) {
      throw new Error(`unknown control "${c}". Known: ${NO_CONTROL}, ${CONTROL_KINDS.join(', ')}`);
    }
  }
  for (const id of o.providers) {
    if (!PROVIDER_META.some(p => p.id === id)) {
      throw new Error(`unknown provider "${id}". Known: ${PROVIDER_META.map(p => p.id).join(', ')}`);
    }
  }
  /* app/api/render/route.ts reads `controlScale` off the body and deliberately
     does NOT read `strength` — the comment there says so outright: nothing on the
     panel sets it, and each provider's own low starting value is a considered
     number rather than a default to be overridden from a request. So a
     `--strength 0.4,0.6,0.8` sweep would send four bodies that differ in a field
     nobody reads, render four identical cells, and report that strength has no
     effect. Refusing beats measuring that. Lift this the day the route grows the
     field, not before. */
  if (o.strength.some(v => v !== null)) {
    throw new Error('--strength is not wired up: app/api/render/route.ts accepts controlScale and'
      + ' deliberately drops strength, so every cell of a strength sweep would be an identical'
      + ' render and the sweep would report that strength does nothing. Sweep --control-scale'
      + ' instead, which the route does read.');
  }
  if (!(o.concurrency >= 1)) throw new Error('--concurrency must be at least 1');
  if (!(o.budget >= 0)) throw new Error('--budget must not be negative');
  if (!(o.targetPixels > 0)) throw new Error('--target-pixels must be positive');
  return o;
}

/** The output size for one cell, snapped to the provider's step and clamped by
 *  the spending ceiling as well as by the model's own pixel limit.
 *
 *  The same shape as `outputDims()` in src/state/renders.ts, including the loop:
 *  the minimum-dimension floor raises one side without touching the other, so a
 *  violent aspect ratio can end up back OVER the ceiling the scaling just brought
 *  it under. No real floor plan is that thin; wrong arithmetic waits. */
export function outputSize(meta, frameW, frameH, target) {
  const budget = Math.min(target, maxAffordablePixels(meta), meta.maxOutputPixels);
  const cw = Math.max(1, Math.round(frameW)), ch = Math.max(1, Math.round(frameH));
  const scale = Math.sqrt(budget / (cw * ch));
  const snap = v => Math.max(meta.minDim, Math.floor((v * scale) / meta.dimStep) * meta.dimStep);
  let width = snap(cw), height = snap(ch);
  while (width * height > budget) {
    if (width >= height && width > meta.minDim) width -= meta.dimStep;
    else if (height > meta.minDim) height -= meta.dimStep;
    else break;
  }
  return { width, height };
}

const cellId = c => [
  c.plan, c.view, c.provider,
  c.controls.length ? c.controls.join('+') : NO_CONTROL,
  `cs${c.controlScale === null ? 'x' : c.controlScale}`,
  `st${c.strength === null ? 'x' : c.strength}`,
  `s${c.seed}`,
].join('__').replace(/[^A-Za-z0-9_.+-]/g, '-');

/** Every cell of the grid, in an order that keeps a plan's cells together — the
 *  conditioning images are painted once per plan and reused, and a run killed
 *  halfway should have finished plans rather than a stripe across all of them. */
export function expandGrid(opts, frames) {
  const cells = [];
  for (const plan of opts.plans) {
    for (const view of opts.views) {
      for (const provider of opts.providers) {
        const meta = metaOf(provider);
        for (const control of opts.controls) {
          const controls = control === NO_CONTROL ? [] : [control];
          for (const controlScale of opts.controlScale) {
            for (const strength of opts.strength) {
              for (const seed of opts.seeds) {
                const f = frames[plan];
                const out = outputSize(meta, f.width, f.height, opts.targetPixels);
                const c = {
                  plan, view, provider, controls, controlScale, strength, seed,
                  width: out.width, height: out.height,
                  usd: estimateUsd(meta, out.width, out.height),
                  /* A map sent to a provider with no control channel is not a
                     control map — it rides along as another semantic reference.
                     A legitimate arm to sweep, and recording which it was is what
                     stops a scorecard reading the two as one thing. */
                  controlsAccepted: controls.every(k => meta.acceptsControls.includes(k)),
                };
                cells.push({ ...c, id: cellId(c) });
              }
            }
          }
        }
      }
    }
  }
  return cells;
}

/* ── the estimate ────────────────────────────────────────────────── */

const usd = v => (v === null || v === undefined ? 'unpriced' : `$${v.toFixed(4)}`);

/** What the sweep will cost, per provider and in total, and every reason it must
 *  not start. Returns the refusals rather than exiting, so the estimate is
 *  always printed in full: a refusal that hides the numbers behind it tells you
 *  to change a flag without telling you what to change it to. */
export function planSpend(cells, opts, preflightUsd = 0) {
  const byProvider = new Map();
  for (const c of cells) {
    const g = byProvider.get(c.provider)
      ?? { n: 0, usd: 0, unpriced: 0, size: `${c.width}x${c.height}` };
    g.n++;
    if (c.usd === null) g.unpriced++; else g.usd += c.usd;
    byProvider.set(c.provider, g);
  }

  const unpriced = [...byProvider].filter(([, g]) => g.unpriced > 0).map(([id]) => id);
  const total = [...byProvider.values()].reduce((s, g) => s + g.usd, 0) + preflightUsd;

  const refusals = [];
  if (unpriced.length) {
    /* The ceiling is the reason. An unpriced call cannot be shown to be under a
       limit, so it is refused rather than guessed at — the same call
       `assertAffordable` makes on the server, made early enough to matter. */
    refusals.push(`${unpriced.join(', ')} publishes no price, so no image from it can be shown to cost`
      + ` less than the $${MAX_USD_PER_IMAGE.toFixed(2)} ceiling. Remove it from --providers.`);
  }
  const dear = cells.find(c => c.usd !== null && c.usd > MAX_USD_PER_IMAGE);
  if (dear) {
    const fits = affordableDims(metaOf(dear.provider), dear.width, dear.height);
    refusals.push(`${dear.provider} at ${dear.width}x${dear.height} is ${usd(dear.usd)} per image, past`
      + ` the $${MAX_USD_PER_IMAGE.toFixed(2)} ceiling.`
      + (fits ? ` ${fits.width}x${fits.height} fits — lower --target-pixels.` : ''));
  }
  if (total > opts.budget) {
    refusals.push(`The sweep estimates ${usd(total)}, past the --budget of $${opts.budget.toFixed(2)}.`
      + ' Shrink the grid, or raise --budget deliberately.');
  }
  return { byProvider, total, refusals };
}

function printEstimate(cells, opts, spend, preflightUsd, skipped) {
  const rows = [...spend.byProvider].map(([id, g]) => {
    const meta = metaOf(id);
    return `  ${id.padEnd(16)} ${String(g.n).padStart(4)} images  ${g.size.padStart(11)}`
      + `  ${usd(g.n ? g.usd / g.n : 0).padStart(10)} each  ${usd(g.usd).padStart(10)}`
      + `  ${meta.acceptsControls.length ? `controls: ${meta.acceptsControls.join('/')}` : 'no control channel'}`;
  });
  console.log([
    '',
    `GRID  ${cells.length} images = ${opts.plans.length} plans x ${opts.views.length} views`
      + ` x ${opts.providers.length} providers x ${opts.controls.length} controls`
      + ` x ${opts.controlScale.length} scales x ${opts.strength.length} strengths`
      + ` x ${opts.seeds.length} seeds`,
    `      seeds ${opts.seeds.join(', ')}`,
    skipped ? `      ${skipped} already rendered in this directory, and skipped` : null,
    '',
    'ESTIMATED SPEND',
    ...rows,
    preflightUsd
      ? `  ${'preflight'.padEnd(16)}    1 image ${''.padStart(11)}  ${usd(preflightUsd).padStart(10)} each`
        + `  ${usd(preflightUsd).padStart(10)}  checks the route honours --providers`
      : null,
    `  ${'TOTAL'.padEnd(16)} ${''.padStart(4)}         ${''.padStart(11)}  ${''.padStart(10)}     `
      + `  ${usd(spend.total).padStart(10)}`,
    '',
    '  Prices come from src/data/providers.ts, read off the vendors\' own pages on 2026-08-18.',
    '  The vendor bills what it bills — this is our estimate of it, not a quote.',
    '',
  ].filter(l => l !== null).join('\n'));
}

/* ── conditioning images ─────────────────────────────────────────── */

/** The reference PNG, the control maps and the sidecar for one plan.
 *
 *  Painted once per plan and shared by every cell that uses it, so a 240-image
 *  sweep paints ten frames rather than 240. The sidecar is written from the SAME
 *  frame the images were painted in — a sidecar framed differently is a set of
 *  coordinates for a picture nobody rendered. */
function conditionPlan(plan, opts, dir, kinds) {
  const frameOpts = { clean: true, maxPx: opts.maxPx };
  const frame = planFrame(plan.floor, frameOpts);
  if (!frame) return null;
  /* Whatever paints inside a frame must paint the floor the frame was measured
     from. `clean` strands no annotation, so this is the plan itself today —
     going through framedFloor anyway is what keeps that true the day a sweep
     asks for a measured frame. */
  const floor = framedFloor(plan.floor, frameOpts);

  mkdirSync(dir, { recursive: true });
  const files = { controls: {} };
  for (const pass of ['ink', ...kinds]) {
    const cv = createCanvas(frame.width, frame.height);
    paintPass(cv.getContext('2d'), { floor, frame, pass, furniture: opts.furniture });
    const name = pass === 'ink' ? 'reference.png' : `control-${pass}.png`;
    writeFileSync(join(dir, name), cv.toBuffer('image/png'));
    if (pass === 'ink') files.reference = name; else files.controls[pass] = name;
  }

  writeFileSync(join(dir, 'truth.json'), `${JSON.stringify(truthFor(plan, frame), null, 2)}\n`);
  files.truth = 'truth.json';
  return { frame, files };
}

/* ── talking to the app ──────────────────────────────────────────── */

/** Which vendor's host a job of this provider's must come back on. Derived from
 *  `needsEnv` rather than listed per id, so a provider added to
 *  src/data/providers.ts is verified or reported unverifiable, never silently
 *  unchecked. */
function vendorOf(meta) {
  if (meta.needsEnv === 'FLUX_API_KEY') return 'bfl.ai';
  if (meta.needsEnv === 'FAL_KEY') return 'fal.run';
  return null;
}

/** `underHost`, not `endsWith`: `endsWith('fal.run')` also matches `evilfal.run`.
 *  This one only reads our own server's answer rather than deciding where a key
 *  goes, but a check spelled right in one place and loose in another is the one
 *  that gets copied. */
const underHost = (host, domain) => host === domain || host.endsWith(`.${domain}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const errorOf = (payload, status) =>
  (payload && typeof payload.error === 'string' && payload.error.trim())
    || `the server answered HTTP ${status} without saying why`;

/** Submits one image and returns the handle to poll it with.
 *
 *  `provider`, `controls`, `controlScale` and `strength` go out whether or not
 *  today's route reads them: the route is the thing that has to grow, and a
 *  harness that withheld the fields would give it nothing to grow into. The
 *  preflight is what stops them being ignored in silence. */
async function submit(cell, refs, opts) {
  const body = {
    prompt: cell.prompt,
    imageBase64: refs.reference,
    width: cell.width,
    height: cell.height,
    seed: cell.seed,
    provider: cell.provider,
    ...(cell.controls.length
      ? { controls: cell.controls.map(k => ({ kind: k, base64: refs.controls[k] })) }
      : {}),
    ...(cell.controlScale === null ? {} : { controlScale: cell.controlScale }),
    ...(cell.strength === null ? {} : { strength: cell.strength }),
  };

  let res, payload = null;
  try {
    res = await fetch(`${opts.baseUrl}/api/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    try { payload = await res.json(); } catch { /* a proxy's HTML 502 is not JSON */ }
  } catch (e) {
    return { ok: false, error: `could not reach ${opts.baseUrl} (${e.message}). Is the app running?` };
  }
  if (!res.ok) return { ok: false, error: errorOf(payload, res.status) };

  const pollUrl = typeof payload?.pollUrl === 'string' ? payload.pollUrl : '';
  const jobId = typeof payload?.jobId === 'string' ? payload.jobId : '';
  if (!pollUrl) {
    /* Cloud mode answers with a row uuid and keeps the polling URL server-side,
       which is exactly what it is for — and it means the harness cannot poll at
       all without an authenticated session and a synced plan. Name the build
       that is running rather than timing out against a URL never returned. */
    if (typeof payload?.renderId === 'string') {
      return { ok: false, error: `the app at ${opts.baseUrl} is running in cloud mode: it answered with a`
        + ' render row id and keeps the polling URL server-side, so this harness cannot collect the'
        + ' image. Run the sweep against a local build.' };
    }
    return { ok: false, error: 'the route accepted the render but returned no pollUrl' };
  }
  /* The provider travels with the handle, not just with the cell. The status
     route checks the pollUrl against the named provider's hosts and nothing
     else, so a poll that names nobody is tried as flux2-max — and every fal cell
     in the sweep would be submitted, billed, and then thrown away at that check.
     `--providers z-image-cn` is the sweep docs/EVAL.md tells you to run. */
  return { ok: true, jobId, pollUrl, provider: cell.provider };
}

/** Where a submitted job is asked about. Exported so a test can pin the query,
 *  because the one field that is easy to leave out is the one that decides which
 *  vendor's allowlist the pollUrl is measured against — and leaving it out costs
 *  a whole sweep's worth of already-paid-for renders. */
export function statusUrlOf(baseUrl, job) {
  return `${baseUrl}/api/render/status?jobId=${encodeURIComponent(job.jobId)}`
    + `&provider=${encodeURIComponent(job.provider)}`
    + `&pollUrl=${encodeURIComponent(job.pollUrl)}`;
}

/** Polls one job to a conclusion, on the same backing-off schedule the browser
 *  uses. Returns the PNG bytes, never a URL: local mode hands the base64 back
 *  through the response because the delivery host serves no CORS header, and
 *  local mode is the only one this harness can drive. */
async function collect(job, opts) {
  const started = Date.now();
  const url = statusUrlOf(opts.baseUrl, job);

  for (let attempt = 0; ; attempt++) {
    const waited = Date.now() - started;
    if (waited > opts.timeout) {
      return { ok: false, error: `no result after ${Math.round(waited / 1000)}s` };
    }
    await sleep(Math.min(5000, 1500 + attempt * 500));

    let res, payload = null;
    try {
      res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(90_000) });
      try { payload = await res.json(); } catch { /* not JSON */ }
    } catch {
      /* A dropped connection is not a failed render: the job is still running at
         the vendor and costs the same whether or not we are watching. */
      continue;
    }

    if (!res.ok) {
      if (payload?.retryable === true) continue;
      return { ok: false, error: errorOf(payload, res.status) };
    }
    if (payload?.status === 'pending') continue;
    if (payload?.status === 'failed') return { ok: false, error: errorOf(payload, 200) };
    if (payload?.status === 'ready' && typeof payload.image === 'string') {
      return {
        ok: true,
        bytes: Buffer.from(payload.image, 'base64'),
        cost: payload.cost ?? null,
        durationMs: Date.now() - started,
      };
    }
    return { ok: false, error: 'the poll answered with something that is not a job status' };
  }
}

/* ── the preflight ───────────────────────────────────────────────── */

/** One image, submitted mainly to find out which vendor actually drew it.
 *
 *  The cheapest honest answer to a question that cannot be asked for free. The
 *  route does read `provider`, but "reads the field" and "the job landed at the
 *  vendor we asked for" are different claims, and only the second one makes a
 *  scorecard citable. Where a mismatch is detectable the sweep stops here having
 *  spent one image; where two providers share a vendor it reports `vendor` and
 *  claims nothing more. */
async function preflight(cell, refs, opts) {
  const meta = metaOf(cell.provider);
  const expected = vendorOf(meta);
  const sent = await submit(cell, refs, opts);
  if (!sent.ok) return { ok: false, verified: 'no', error: sent.error };

  let host = '';
  try { host = new URL(sent.pollUrl).hostname; } catch { /* not a URL at all */ }

  if (!expected) {
    return { ok: true, verified: 'unverifiable', host, job: sent,
      why: `${cell.provider} names no key this check knows, so which vendor took the job cannot be seen` };
  }
  if (!host || !underHost(host, expected)) {
    return { ok: false, verified: 'no', host,
      error: `--providers asked for ${cell.provider}, whose jobs live on ${expected}, but the route`
        + ` returned a polling URL on ${host || 'no host at all'}. The app is substituting a provider,`
        + ' so check that app/api/render/route.ts resolves the request\'s `provider` field through'
        + ' PROVIDERS rather than importing one vendor directly. Every image in this sweep would be'
        + ' drawn by the wrong model and filed under the right one. Stopping here, one image spent.' };
  }

  /* The host proves the vendor, never the model: [max] and [flex] are both
     api.bfl.ai. Two providers behind one key is as far as this check reaches. */
  const sameVendor = PROVIDER_META.filter(p => vendorOf(p) === expected);
  return sameVendor.length > 1
    ? { ok: true, verified: 'vendor', host, job: sent,
        why: `the job is on ${host}, so the vendor is right; ${sameVendor.map(p => p.id).join(' and ')}`
          + ' share that host, so which of them drew it is not something this check can see' }
    : { ok: true, verified: 'yes', host, job: sent };
}

/* ── the sweep ───────────────────────────────────────────────────── */

async function pool(items, n, worker) {
  const queue = items.slice();
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await worker(item);
  }));
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\nSee docs/EVAL.md for the flags and the research sweep's command.`);
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = opts.out ?? join(RUNS, stamp);
  mkdirSync(runDir, { recursive: true });

  /* Paint first, price second. The conditioning images are free, and a plan that
     cannot be framed at all must not turn up in an estimate as an image somebody
     is about to pay for. */
  const kinds = [...new Set(opts.controls.filter(c => c !== NO_CONTROL))];
  const frames = {}, refs = {}, unframed = [];
  for (const id of opts.plans) {
    const plan = loadPlan(id);
    const dir = join(runDir, 'refs', id);
    const built = conditionPlan(plan, opts, dir, kinds);
    if (!built) { unframed.push(id); continue; }
    frames[id] = built.frame;
    refs[id] = {
      rel: relative(runDir, dir),
      files: built.files,
      reference: readFileSync(join(dir, built.files.reference)).toString('base64'),
      controls: Object.fromEntries(kinds.map(k =>
        [k, readFileSync(join(dir, built.files.controls[k])).toString('base64')])),
    };
  }
  if (unframed.length) {
    console.warn(`Nothing to frame on: ${unframed.join(', ')} — dropped from the grid.`);
  }

  const cells = expandGrid({ ...opts, plans: opts.plans.filter(p => frames[p]) }, frames);
  if (!cells.length) { console.error('The grid is empty.'); process.exit(2); }

  for (const c of cells) {
    c.prompt = buildPrompt(loadPlan(c.plan).floor, {
      view: c.view,
      furniture: opts.furniture,
      dimensions: opts.dimensions,
      /* In exactly the order the request attaches them: image 1 is the plan,
         image 2 is controls[0]. buildPrompt does not deduplicate, so a brief
         built from a different list than the body sends describes the wrong
         image in every map sentence. */
      ...(c.controls.length ? { controls: c.controls } : {}),
    });
  }

  const done = new Set(cells
    .filter(c => existsSync(join(runDir, 'cells', c.id, 'render.png')))
    .map(c => c.id));
  const todo = cells.filter(c => !done.has(c.id));

  /* The cheapest cell in the grid, so the one image the preflight spends is the
     least it can be — and on a provider the sweep actually cares about. */
  const probe = todo.length
    ? todo.reduce((a, b) => ((a.usd ?? Infinity) <= (b.usd ?? Infinity) ? a : b))
    : null;
  const wantsPreflight = opts.preflight && !opts.dry && probe !== null;
  const preUsd = wantsPreflight ? (probe.usd ?? 0) : 0;
  const spend = planSpend(todo, opts, preUsd);
  printEstimate(cells, opts, spend, preUsd, done.size);

  /* Every geometric metric registers the render against a top-down polygon, so on
     an `iso`, `eye` or `sketch` render envelopeIou, roomIou and lineF1 are
     comparing a perspective picture with a plan and their numbers mean nothing.
     Such a sweep is still worth running — orthoScore and the lettering gate are
     exactly how you measure "did it come back as a dollhouse tilt" — but the
     scorecard's structural columns must not be read, and the warning belongs
     here, before the money, rather than in a footnote afterwards. */
  const offAxis = [...new Set(opts.views.filter(v => v !== 'top'))];
  if (offAxis.length) {
    console.warn(`NOTE  views ${offAxis.join(', ')} are not orthographic, and envelope IoU, room IoU`
      + ' and line F1 all register the render against a top-down plan — on these cells those three'
      + ' columns compare a perspective picture with a floor plan and are not interpretable.'
      + ' orthoScore and the lettering count still are.\n');
  }

  const unaccepted = cells.filter(c => c.controls.length && !c.controlsAccepted);
  if (unaccepted.length) {
    console.warn(`NOTE  ${unaccepted.length} cell(s) attach a control map to a provider with no control`
      + ' channel, so the map arrives as another semantic reference rather than as geometry. A'
      + ' legitimate arm; recorded as controlsAccepted:false so nothing conflates the two.\n');
  }

  const manifest = {
    stamp,
    note: opts.note,
    baseUrl: opts.baseUrl,
    dry: opts.dry,
    grid: {
      plans: opts.plans, views: opts.views, providers: opts.providers, controls: opts.controls,
      controlScale: opts.controlScale, strength: opts.strength, seeds: opts.seeds,
    },
    conditioning: {
      maxPx: opts.maxPx, furniture: opts.furniture, dimensions: opts.dimensions,
      targetPixels: opts.targetPixels,
    },
    cells: cells.length,
    estimatedUsd: spend.total,
    /* Until the preflight has run this says nothing, and it must not read as a
       pass: a scorecard whose manifest cannot say which model drew the images is
       a scorecard nobody may cite. */
    providerVerified: opts.dry ? 'dry' : 'not checked',
    unframed,
  };
  const saveManifest = () =>
    writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  saveManifest();

  const writeCell = (c, extra) => {
    const dir = join(runDir, 'cells', c.id);
    mkdirSync(dir, { recursive: true });
    const r = refs[c.plan];
    if (extra.bytes) writeFileSync(join(dir, 'render.png'), extra.bytes);
    /* The brief is written beside the image because it is half of what produced
       it, and a sweep that kept only the picture cannot say why two cells
       differ. */
    writeFileSync(join(dir, 'prompt.txt'), `${c.prompt}\n`);
    writeFileSync(join(dir, 'cell.json'), `${JSON.stringify({
      id: c.id, plan: c.plan, view: c.view, provider: c.provider,
      controls: c.controls, controlsAccepted: c.controlsAccepted,
      controlScale: c.controlScale, strength: c.strength, seed: c.seed,
      width: c.width, height: c.height, usd: c.usd, promptChars: c.prompt.length,
      files: {
        reference: join(r.rel, r.files.reference),
        truth: join(r.rel, r.files.truth),
        controls: Object.fromEntries(c.controls.map(k => [k, join(r.rel, r.files.controls[k])])),
        ...(extra.bytes ? { render: join('cells', c.id, 'render.png') } : {}),
      },
      ...extra.record,
    }, null, 2)}\n`);
  };

  if (opts.dry) {
    /* Every cell is written out, image-less. A dry run whose cells existed only
       in this process could not be scored at all, and `--self` on those cells —
       the metrics' ceiling on this plan set — is the most useful free thing the
       harness does. */
    for (const c of cells) writeCell(c, { record: { status: 'dry' } });
    console.log('DRY RUN — conditioning images, sidecars and briefs written; nothing submitted, nothing spent.');
    console.log(`  ${runDir}`);
    console.log('\nScore those images to learn each metric\'s ceiling on this plan set (also free):');
    console.log(`  pnpm eval:score ${runDir} --self\n`);
    return;
  }

  if (spend.refusals.length) {
    console.error(`REFUSED\n${spend.refusals.map(r => `  - ${r}`).join('\n')}\n`);
    process.exit(1);
  }
  if (!todo.length) {
    console.log('Every cell in this directory already has a render. Nothing to do.\n');
    return;
  }
  if (!opts.yes) {
    console.error('Nothing has been submitted. Re-run with --yes to spend the estimate above.\n');
    process.exit(1);
  }

  /* ── from here on, money moves ── */

  let preflightKept = false;
  if (wantsPreflight) {
    console.log(`PREFLIGHT  one ${probe.width}x${probe.height} image on ${probe.provider}`
      + ` (${usd(probe.usd)}), to check the route honours --providers…`);
    const pre = await preflight(probe, refs[probe.plan], opts);
    manifest.providerVerified = pre.verified;
    manifest.preflight = {
      provider: probe.provider, host: pre.host ?? null,
      error: pre.error ?? null, why: pre.why ?? null,
    };
    saveManifest();
    if (!pre.ok) {
      console.error(`\nPREFLIGHT FAILED\n  ${pre.error}\n`);
      process.exit(1);
    }
    console.log(`  ${pre.verified}${pre.why ? ` — ${pre.why}` : ` — jobs on ${pre.host}`}`);

    /* The preflight image is a real render of a real cell, so it is collected and
       kept rather than thrown away. Paying for it twice would be the only thing
       worse than paying for it once. */
    const got = await collect(pre.job, opts);
    if (got.ok) {
      writeCell(probe, { bytes: got.bytes, record: {
        status: 'ready', preflight: true, durationMs: got.durationMs,
        cost: got.cost, bytes: got.bytes.length,
      } });
      preflightKept = true;
      console.log(`  kept as ${probe.id}\n`);
    } else {
      console.warn(`  the preflight image itself did not arrive (${got.error}); it will be retried\n`);
    }
  }

  const queue = todo.filter(c => !(preflightKept && c.id === probe.id));
  console.log(`RENDERING  ${queue.length} images, ${opts.concurrency} at a time\n`);

  let n = 0, spent = preflightKept ? (probe.usd ?? 0) : 0, failed = 0;
  await pool(queue, opts.concurrency, async c => {
    const label = `[${++n}/${queue.length}] ${c.id}`;
    const sent = await submit(c, refs[c.plan], opts);
    if (!sent.ok) {
      failed++;
      console.warn(`${label}  SUBMIT FAILED — ${sent.error}`);
      writeCell(c, { record: { status: 'failed', error: sent.error } });
      return;
    }
    const got = await collect(sent, opts);
    if (!got.ok) {
      failed++;
      console.warn(`${label}  FAILED — ${got.error}`);
      writeCell(c, { record: { status: 'failed', error: got.error, jobId: sent.jobId } });
      return;
    }
    spent += c.usd ?? 0;
    writeCell(c, { bytes: got.bytes, record: {
      status: 'ready', jobId: sent.jobId, durationMs: got.durationMs,
      cost: got.cost, bytes: got.bytes.length,
    } });
    console.log(`${label}  ready in ${Math.round(got.durationMs / 1000)}s`
      + `  ${(got.bytes.length / 1024).toFixed(0)} kB  est ${usd(c.usd)}`);
  });

  manifest.finishedAt = new Date().toISOString();
  manifest.rendered = queue.length - failed + (preflightKept ? 1 : 0);
  manifest.failed = failed;
  manifest.estimatedSpentUsd = spent;
  saveManifest();

  console.log([
    '',
    `DONE  ${manifest.rendered} rendered, ${failed} failed`,
    `      estimated spend ${usd(spent)}`,
    `      ${runDir}`,
    '',
    'Next:',
    `  pnpm eval:score ${runDir}`,
    `  pnpm eval:diff  ${runDir}`,
    '',
  ].join('\n'));
}

if (import.meta.main) await main();
