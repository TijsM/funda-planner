/** This run against the committed baseline: per-metric mean, the difference, and
 *  a bootstrap confidence interval on the DIFFERENCE.
 *
 *  The table exists to stop us reading noise as progress. Three rules make it do
 *  that, and all three are the brief's rather than a choice:
 *
 *  PAIR, NEVER COMPARE TWO MEANS. Cells are matched by id — which carries plan,
 *  view, provider, control, scale, strength and seed — and only matched cells are
 *  differenced. Two independent means over grids that are not the same grid will
 *  differ for reasons that have nothing to do with the change under test.
 *
 *  RESAMPLE PLANS, NOT CELLS. Twenty-four cells of one plan are twenty-four looks
 *  at the same building, not twenty-four independent observations; bootstrapping
 *  over cells would report an interval several times too narrow and call every
 *  wobble significant. Plans are the unit, so the interval reflects the ten
 *  buildings we actually have.
 *
 *  AN INTERVAL THAT STRADDLES ZERO IS NOISE. Marked as such in its own column,
 *  because a "+0.03" with no interval beside it will be repeated as a finding by
 *  whoever reads it next.
 *
 *  Never FID at this sample size, and no p-values: an interval on the difference
 *  says how big the effect might be, which is the question, where a p-value only
 *  says whether zero is excluded.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METRICS, fmt, mean, table } from './score.mjs';
import { phashDistance } from './metrics/index.mjs';

const BASELINE = fileURLToPath(new URL('../../eval/baseline.json', import.meta.url));

/** Resamples. 2000 is past the point where the percentile bounds stop moving in
 *  the third decimal, and the whole loop is milliseconds over ten plans. */
const RESAMPLES = 2000;

/** Below this there is no interval worth printing. A bootstrap over three plans
 *  resamples the same three buildings and produces a confidence interval whose
 *  confidence is entirely fictional; saying so is more useful than a number. */
const MIN_PLANS = 4;

/** Seeded so the same two scorecards always produce the same interval. An
 *  unseeded bootstrap makes the table move when nothing else has, which is
 *  exactly the false signal this file exists to suppress. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The paired difference for one metric, resampled over plans.
 *
 *  `byPlan` is one mean difference per plan. The statistic is the unweighted mean
 *  of those, so a plan that happens to carry more cells does not get more say in
 *  whether the change worked — the plans are the sample.
 *
 *  `lo`, `hi` and `noise` are all null together, and only when there were too few
 *  plans to bootstrap — which is a refusal to give an interval, not an interval
 *  of zero width. The JSDoc is load-bearing: this module is imported from a
 *  strict .ts test, and a return type that omits a field makes reading it an
 *  error there rather than here.
 *
 *  @param {number[]} byPlan
 *  @param {{ resamples?: number, seed?: number }} [opts]
 *  @returns {{ diff: number, lo: number | null, hi: number | null,
 *              noise: boolean | null, flat?: boolean, plans: number } | null} */
export function bootstrapCI(byPlan, { resamples = RESAMPLES, seed = 20260818 } = {}) {
  const xs = byPlan.filter(v => Number.isFinite(v));
  if (!xs.length) return null;
  const diff = mean(xs);
  if (xs.length < MIN_PLANS) return { diff, lo: null, hi: null, noise: null, plans: xs.length };

  const rand = rng(seed);
  const stats = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[(rand() * xs.length) | 0];
    stats[b] = s / xs.length;
  }
  const sorted = Array.from(stats).sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  const lo = at(0.025), hi = at(0.975);
  /* `<= 0 <=` and not `< 0 <`: an interval whose bound sits exactly on zero has
     not excluded zero.
     `flat` separates "we cannot tell these apart" from "these are the same
     number in every cell" — both straddle zero, but the second is a metric that
     did not move at all, which is a different and much more useful fact. */
  return { diff, lo, hi, noise: lo <= 0 && hi >= 0, flat: lo === 0 && hi === 0 && diff === 0,
    plans: xs.length };
}

/** Groups matched cells by plan and reduces each plan to its mean difference. */
function perPlan(pairs, value) {
  const byPlan = new Map();
  for (const { run, base } of pairs) {
    const a = value(run), b = value(base);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (!byPlan.has(run.plan)) byPlan.set(run.plan, []);
    byPlan.get(run.plan).push(a - b);
  }
  return [...byPlan.entries()].map(([plan, ds]) => ({ plan, diff: mean(ds), n: ds.length }));
}

/** The per-rank room IoU difference, which is the one result the whole sweep is
 *  built to produce: the hypothesis is that rooms named later in the brief drift
 *  further, so a change that lifts rank 0 and drops rank 5 has not helped and a
 *  single blended room number would have called it a win. */
function rankRows(pairs, opts) {
  const ranks = new Map();
  const iousByRank = c => {
    const m = new Map();
    for (const r of c.metrics?.rooms?.rooms ?? []) {
      if (r.rank === null || r.note === 'degenerate') continue;
      m.set(r.rank, r.iou);
    }
    return m;
  };
  for (const { run, base } of pairs) {
    const a = iousByRank(run), b = iousByRank(base);
    for (const [rank, av] of a) {
      const bv = b.get(rank);
      if (!Number.isFinite(bv)) continue;
      if (!ranks.has(rank)) ranks.set(rank, new Map());
      const byPlan = ranks.get(rank);
      if (!byPlan.has(run.plan)) byPlan.set(run.plan, []);
      byPlan.get(run.plan).push(av - bv);
    }
  }
  return [...ranks.entries()].sort((a, b) => a[0] - b[0]).map(([rank, byPlan]) => {
    const ci = bootstrapCI([...byPlan.values()].map(mean), opts);
    /* Room IoU is higher-is-better, so a rank whose interval clears zero on the
       low side has genuinely improved AT THAT POSITION — which is the only place
       rank decay can be read. */
    const verdict = !ci ? 'unpaired'
      : ci.noise === null ? `too few plans (${ci.plans} < ${MIN_PLANS})`
      : ci.flat ? 'unchanged'
      : ci.noise ? 'noise'
      : ci.diff > 0 ? 'better' : 'WORSE';
    return [
      `rank ${rank}`, byPlan.size,
      ci && ci.diff >= 0 ? `+${fmt(ci.diff)}` : fmt(ci?.diff),
      ci?.lo === null || !ci ? '—' : fmt(ci.lo), ci?.hi === null || !ci ? '—' : fmt(ci.hi),
      verdict,
    ];
  });
}

/** Same seed, same cell, two runs: any phash distance at all means the picture
 *  changed. A tripwire and never a target — it says "something moved", not
 *  "something improved", and a prompt tweak that reads as an improvement with a
 *  distance of 0 changed nothing at all and the improvement is measurement
 *  noise. */
function phashRows(pairs) {
  const ds = [];
  for (const { run, base } of pairs) {
    if (!run.metrics?.phash || !base.metrics?.phash) continue;
    ds.push(phashDistance(
      Uint8Array.from(Buffer.from(run.metrics.phash, 'hex')),
      Uint8Array.from(Buffer.from(base.metrics.phash, 'hex')),
    ));
  }
  if (!ds.length) return null;
  return { n: ds.length, mean: mean(ds), max: Math.max(...ds), identical: ds.filter(d => d === 0).length };
}

const readJson = p => JSON.parse(readFileSync(p, 'utf8'));

/** True when the committed baseline has never been populated. It ships honestly
 *  empty rather than with invented numbers, so this is the normal state until the
 *  first real sweep, not an error. */
export const isEmptyBaseline = b => !b || !Array.isArray(b.cells) || b.cells.length === 0;

/** A cell whose registration failed measured nothing: its metrics are the zeros a
 *  failed search returns, not zeros the render earned. `composite()` in score.mjs
 *  already refuses to blend one — every per-metric row here has to refuse it too,
 *  or an unregistered cell's fake 0 lands in the envelope, rooms and lines means
 *  AND inside their confidence intervals, which is how a run that could not be
 *  measured comes to read as a run that got worse. */
const measured = c => c.scored && !c.metrics?.note;

export function compare(runCard, baseCard, opts = {}) {
  const baseById = new Map(baseCard.cells.filter(measured).map(c => [c.id, c]));
  const pairs = runCard.cells
    .filter(c => measured(c) && baseById.has(c.id))
    .map(c => ({ run: c, base: baseById.get(c.id) }));

  const rows = [];
  for (const m of METRICS.concat([{ key: 'composite', label: 'composite', higher: true, of: c => c.composite }])) {
    const value = c => (m.key === 'composite' ? c.composite : m.of(c.metrics));
    const runMean = mean(pairs.map(p => value(p.run)));
    const baseMean = mean(pairs.map(p => value(p.base)));
    const ci = bootstrapCI(perPlan(pairs, value).map(p => p.diff), opts);
    rows.push({ metric: m.label, higher: m.higher, dp: m.dp, runMean, baseMean, ci });
  }

  return {
    pairs: pairs.length,
    runCells: runCard.cells.filter(c => c.scored).length,
    baseCells: baseCard.cells.filter(c => c.scored).length,
    /* Named in the output rather than silently absent: dropping cells is the right
       call and a table that does not say it dropped any reads as full coverage. */
    unregistered: runCard.cells.filter(c => c.scored && c.metrics?.note).length,
    plans: new Set(pairs.map(p => p.run.plan)).size,
    rows,
    ranks: rankRows(pairs, opts),
    phash: phashRows(pairs),
  };
}

function render(cmp, runCard, baseCard) {
  const out = ['', `DIFF  ${cmp.pairs} paired cells over ${cmp.plans} plans`
    + `  (run ${cmp.runCells} scored, baseline ${cmp.baseCells} scored)`
    + (cmp.unregistered ? `  — ${cmp.unregistered} unregistered, left out of every row` : '')];
  if (baseCard.run?.stamp) out.push(`      baseline: ${baseCard.run.stamp}`);
  if (runCard.run?.stamp) out.push(`      run:      ${runCard.run.stamp}`);

  /* Said here rather than only in the docs: a diff of two scorecards that
     measured different things looks exactly like a diff of two that did not. */
  const provider = runCard.run?.providerVerified;
  if (provider && provider !== 'yes' && provider !== 'vendor') {
    out.push('', `WARNING  this run's manifest says providerVerified="${provider}", so which model drew`
      + ' these images was never confirmed. Do not cite the table below.');
  }
  if (runCard.kind !== baseCard.kind) {
    out.push('', `WARNING  comparing a "${runCard.kind}" scorecard with a "${baseCard.kind}" one. A`
      + ' self-score is the metric\'s ceiling on our own drawing, not a render — these two are not'
      + ' the same quantity and the differences below are meaningless.');
  }

  out.push('', table(
    ['metric', 'baseline', 'run', 'diff', 'CI low', 'CI high', 'verdict'],
    cmp.rows.map(r => {
      const c = r.ci;
      const verdict = !c ? 'unpaired'
        : c.noise === null ? `too few plans (${c.plans} < ${MIN_PLANS})`
        : c.flat ? 'unchanged'
        : c.noise ? 'noise'
        : r.higher === null ? 'moved'
        : (c.diff > 0) === Boolean(r.higher) ? 'better' : 'WORSE';
      const dp = r.dp ?? 3;
      return [
        r.metric, fmt(r.baseMean, dp), fmt(r.runMean, dp),
        c ? (c.diff >= 0 ? `+${fmt(c.diff, dp)}` : fmt(c.diff, dp)) : '—',
        c && c.lo !== null ? fmt(c.lo, dp) : '—',
        c && c.hi !== null ? fmt(c.hi, dp) : '—',
        verdict,
      ];
    }),
  ));

  if (cmp.ranks.length) {
    out.push('', 'Room IoU by position in the prompt — a change that lifts rank 0 and drops rank 5',
      'has not fixed rank decay, and the blended row above cannot show that:', '',
      table(['rank', 'plans', 'diff', 'CI low', 'CI high', 'verdict'], cmp.ranks));
  }

  if (cmp.phash) {
    const p = cmp.phash;
    out.push('', `Perceptual hash tripwire: ${p.identical}/${p.n} cells byte-identical in appearance,`
      + ` mean distance ${fmt(p.mean, 1)}, worst ${p.max}.`);
    if (p.identical === p.n) {
      out.push('  Every paired render is pixel-for-pixel the same picture. Whatever changed did not'
        + ' reach the image, so every difference above is scoring noise.');
    }
  }

  out.push('', 'Rows marked "noise" have a confidence interval that straddles zero: the run and the',
    'baseline are not distinguishable on that metric at this sample size. Reading one as progress',
    'is the mistake this table exists to prevent.',
    '',
    `Bootstrap: ${RESAMPLES} resamples, plans as the unit, paired on cell id, seeded and reproducible.`,
    '* orthoScore is our own construction, not a published metric. See docs/EVAL.md.', '');
  return out.join('\n');
}

/* ── the command ─────────────────────────────────────────────────── */

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const promote = argv.includes('--promote');
  const self = argv.includes('--self');
  const positional = argv.filter((a, i) =>
    !a.startsWith('--') && !(i > 0 && ['--baseline', '--boot-seed'].includes(argv[i - 1])));

  const dir = positional[0];
  if (!dir) {
    console.error('usage: pnpm eval:diff <run-dir> [--baseline <path>] [--promote] [--self]\n'
      + '  --baseline  compare against another run\'s scorecard.json instead of eval/baseline.json\n'
      + '  --promote   after printing, copy this run\'s scorecard into eval/baseline.json\n'
      + '  --self      diff the selfscore.json files rather than the render scorecards');
    process.exit(2);
  }

  const cardName = self ? 'selfscore.json' : 'scorecard.json';
  const runPath = existsSync(resolve(dir)) && resolve(dir).endsWith('.json')
    ? resolve(dir) : join(resolve(dir), cardName);
  if (!existsSync(runPath)) {
    console.error(`No ${cardName} at ${runPath}. Score the run first:\n  pnpm eval:score ${dir}`
      + `${self ? ' --self' : ''}`);
    process.exit(2);
  }
  const runCard = readJson(runPath);

  const basePath = flag('baseline') ? resolve(flag('baseline')) : BASELINE;
  const baseCard = existsSync(basePath) ? readJson(basePath) : null;

  const doPromote = () => {
    writeFileSync(BASELINE, `${JSON.stringify({
      comment: `Promoted from ${runCard.run?.stamp ?? runPath} on ${new Date().toISOString()}.`
        + ' Every eval:diff is measured against these numbers, so promote only a run whose manifest'
        + ' says providerVerified yes or vendor, and whose grid is the one the next run will sweep.',
      promotedFrom: runPath,
      ...runCard,
    }, null, 2)}\n`);
    console.log(`Promoted ${runPath} to ${BASELINE}`);
    if (runCard.kind === 'self') {
      /* A self-score is the metric's ceiling on our own drawing. As a baseline it
         is a legitimate reference for "did the conditioning images change", and
         a completely invalid one for "did the renders get better" — diff refuses
         to cross the two kinds, but the file should say which it holds. */
      console.log('  NOTE this is a SELF-SCORE baseline: a ceiling for the conditioning images, not'
        + ' a record of any render. eval:diff will refuse to compare it with a render scorecard.');
    }
    console.log('');
  };

  if (isEmptyBaseline(baseCard)) {
    console.log([
      '',
      `The baseline at ${basePath} is unpopulated — it ships empty on purpose, with no invented`,
      'numbers in it, because a baseline of made-up values is worse than none: every later diff',
      'would be measured against fiction.',
      '',
      'Score a run you trust and promote it:',
      `  pnpm eval:score ${dir}`,
      `  pnpm eval:diff  ${dir} --promote`,
      '',
      'Until then read the scorecard on its own, and read it against the self-score ceiling',
      `(pnpm eval:score <dir> --self) rather than against 1.0. See docs/EVAL.md.`,
      '',
    ].join('\n'));
    if (promote) doPromote();
    process.exit(0);
  }

  /* Declared before the empty-baseline branch, and called from both: the very
     first baseline is promoted against an EMPTY one, so a promote that only ran
     after a successful diff could never populate the file it is for. */
  const seed = Number(flag('boot-seed', '20260818'));
  const cmp = compare(runCard, baseCard, { seed });
  if (!cmp.pairs) {
    console.error(`\nNothing to compare: no cell id appears in both scorecards. The two runs swept`
      + ' different grids, so there is no paired difference to report — and two unpaired means are'
      + ' exactly what this table refuses to print.\n');
    process.exit(1);
  }
  console.log(render(cmp, runCard, baseCard));

  if (promote) doPromote();
}
