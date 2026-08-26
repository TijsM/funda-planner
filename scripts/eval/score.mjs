/** Scores one run: every (render.png, truth.json) pair a sweep left behind, and
 *  the vocabulary run.mjs and diff.mjs both report in.
 *
 *  The method is ControlNet++ (arXiv:2404.07987): run an extractor over the
 *  GENERATED image, recover the condition, compare it with the condition that
 *  went in. What is ours rather than theirs is that we never extract the input —
 *  truth.mjs already wrote it as vectors-turned-pixels, in the frame the
 *  conditioning image was painted in.
 *
 *  CALIBRATION, and the first thing to read before believing a number. Scoring
 *  our own conditioning image against its own sidecar does NOT give 1.0: on
 *  studio-26 the `ink` reference self-scores envelope 0.97, rooms 0.46-0.51 and
 *  lineF1 0.38. Those are the metrics' ceilings, not failures — a flood fill and
 *  a Sobel operator lose that much on a perfect drawing. A render at lineF1 0.35
 *  is therefore excellent and a scorecard read against 1.0 says every render
 *  ever made is broken. `--self` scores the reference images instead of the
 *  renders and costs nothing; run it once per plan set and keep the numbers
 *  beside the sweep. docs/EVAL.md tabulates them.
 *
 *  Object counting is NOT here. Doing it honestly needs an open-vocabulary
 *  detector; a heuristic ("count the dark blobs near the table") would be
 *  believed by everyone who read the scorecard and would be wrong. The sidecar
 *  carries `expectedSeats` so the gap is one detector away, and the gap stays
 *  visible rather than filled with a guess.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  closeTextWorker, envelopeIou, lineF1, loadPixels, orthoScore, phash, roomIou, textPixelFraction,
} from './metrics/index.mjs';

/* ── the scorecard's vocabulary ──────────────────────────────────── */

/** Every column a scorecard can carry, in the order a table prints them.
 *
 *  `weight` is the share of the composite; 0 means reported but never scored
 *  against. Two metrics are deliberately weightless. phash is a regression
 *  tripwire — weighting a guardrail turns it into something worth gaming. And
 *  text is a GATE, not a term: the fraction of a render that is lettering runs
 *  0.0001-0.01, so any weighted contribution is swamped noise, while "three
 *  confident tokens came back" is a clean yes/no answer to the A/B that metric
 *  exists to settle. Read `textTokens`, not `text`.
 */
export const METRICS = [
  { key: 'envelope', label: 'envelope IoU', higher: true, weight: 0.35,
    of: m => m.envelope?.iou ?? null },
  { key: 'rooms', label: 'room IoU (ranked)', higher: true, weight: 0.30,
    of: m => m.rooms?.mean ?? null },
  { key: 'lines', label: 'line F1', higher: true, weight: 0.25,
    of: m => m.lines?.f1 ?? null },
  { key: 'ortho', label: 'ortho score*', higher: true, weight: 0.10,
    of: m => m.ortho?.score ?? null },
  { key: 'rankSlope', label: 'rank slope', higher: true, weight: 0,
    of: m => m.rooms?.rankSlope ?? null },
  { key: 'frameScale', label: 'frame scale', higher: null, weight: 0,
    of: m => m.envelope?.frameScale ?? null },
  { key: 'coverage', label: 'coverage', higher: null, weight: 0,
    of: m => m.envelope?.coverage ?? null },
  { key: 'text', label: 'text fraction', higher: false, weight: 0,
    of: m => m.text?.fraction ?? null },
  /* A count, so two decimals: printed to three it reads as a fraction, and the
     whole point of this row is that "0.15 tokens per render" is a number of
     words and not a proportion of the picture. */
  { key: 'textTokens', label: 'text tokens', higher: false, weight: 0, dp: 2,
    of: m => (m.text ? m.text.tokens.length : null) },
];

/** The metrics the composite is actually built from. */
export const WEIGHTED = METRICS.filter(m => m.weight > 0);

/** A footprint IoU this close to the whole frame means only a rim of background
 *  was found, so the similarity fit had nothing to register against and the IoU
 *  beside it is meaningless rather than good. Such a cell reports its numbers
 *  and is excluded from the composite — averaging a fake 0.99 in is how a
 *  scorecard launders a failed registration into progress. */
const COVERAGE_MAX = 0.90;

/** And the other end of the same failure, which is the one that actually bites.
 *  `footprintMask` floods inwards from every border pixel matching the border's
 *  own median colour, so a render with no background AT ALL is background
 *  everywhere by that test and comes back empty: coverage 0.000, envelope 0.000,
 *  every room 'seed blocked', lineF1 0, ortho 0. Without a floor here that cell
 *  scored a confident composite of exactly 0.000 and no flag — indistinguishable
 *  from a render that drew the wrong building, and averaged into every mean as
 *  though it were one. The ten fixture plans self-score 0.48 to 0.85, so 0.02 is
 *  two orders of magnitude clear of anything measurable. */
const COVERAGE_MIN = 0.02;

/** Our own framing is the identity guess, so a render that kept it lands at
 *  1.00. Outside this band the generator re-cropped the plan — a real finding,
 *  not a broken measurement, so the cell still scores and carries the flag. */
const FRAME_SCALE_BAND = [0.85, 1.20];

/** One weighted mean over the metrics that have a weight, renormalised over
 *  whichever of them actually produced a number. Null when the registration
 *  failed: a composite is for ranking two runs against each other and must
 *  never be the thing that hides a cell nobody could measure. */
export function composite(metrics) {
  if (!metrics || metrics.note === 'unregistered') return null;
  let sum = 0, w = 0;
  for (const m of WEIGHTED) {
    const v = m.of(metrics);
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    sum += v * m.weight; w += m.weight;
  }
  return w ? sum / w : null;
}

/* ── scoring one image ──────────────────────────────────────────── */

/** Every metric over one decoded render and its sidecar.
 *
 *  envelopeIou runs FIRST and its transform is handed to roomIou and lineF1
 *  rather than letting either register again — three metrics that disagree
 *  about where the building is cannot be compared with one another.
 *
 *  @param {import('./metrics/pixels.mjs').Pixels} px
 *  @param {import('./truth.mjs').Truth} truth */
export async function scorePixels(px, truth) {
  const envelope = envelopeIou(px, truth);
  const rooms = roomIou(px, truth, envelope.transform);
  const lines = lineF1(px, truth, envelope.transform);
  const ortho = orthoScore(px);
  const text = await textPixelFraction(px);

  /* Ranked rooms only. An area the prompt never named has rank null and cannot
     speak to rank decay, and a `degenerate` room scored zero because the fill
     found nothing would drag a mean that is supposed to be about shape. Both
     stay in `rooms.rooms` where they can be read; neither is averaged. */
  const ranked = rooms.rooms.filter(r => r.rank !== null && r.note !== 'degenerate');
  const usable = ranked.length ? ranked : rooms.rooms.filter(r => r.note !== 'degenerate');

  const flags = [];
  if (envelope.coverage > COVERAGE_MAX || envelope.coverage < COVERAGE_MIN) flags.push('unregistered');
  if (envelope.frameScale < FRAME_SCALE_BAND[0] || envelope.frameScale > FRAME_SCALE_BAND[1]) {
    flags.push('reframed');
  }
  /* Recall is computed over the truth raster the transform actually landed
     inside the frame, so walls pushed off the edge are clipped out rather than
     counted as misses — a registration that failed outright then reads as good
     recall over the sliver still in view. truthPixels is the only thing that
     shows it, which is why it is a flag and not a footnote. */
  if (lines.truthPixels < 0.5 * (truth.rooms.length + 1) * 100) flags.push('thin-truth');
  if (text.tokens.length) flags.push('lettering');

  return {
    envelope: {
      iou: envelope.iou, frameScale: envelope.frameScale, coverage: envelope.coverage,
      transform: envelope.transform,
    },
    rooms: {
      /* A mean is offered for the composite and for a table, and the per-rank
         list is kept beside it, because the hypothesis under test is about how
         the score DECAYS with rank — a run reported as one blended number
         cannot answer the only question it was run to answer. */
      mean: usable.length ? usable.reduce((s, r) => s + r.iou, 0) / usable.length : null,
      rankSlope: rooms.rankSlope,
      rooms: rooms.rooms,
    },
    lines,
    ortho: { score: ortho.score, energy: ortho.energy, tolDeg: ortho.tolDeg },
    text: { fraction: text.fraction, tokens: text.tokens.map(t => t.text), rejected: text.rejected },
    /* Hex so a scorecard diffs readably; phashDistance takes the bytes back. */
    phash: Buffer.from(phash(px)).toString('hex'),
    ...(flags.length ? { flags } : {}),
    ...(flags.includes('unregistered') ? { note: 'unregistered' } : {}),
  };
}

/* ── scoring a run directory ─────────────────────────────────────── */

const readJson = p => JSON.parse(readFileSync(p, 'utf8'));

/** The cell directories of a run, in a stable order so two scorecards of the
 *  same run compare line by line. */
export function cellDirs(runDir) {
  const root = join(runDir, 'cells');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(root, e.name, 'cell.json')))
    .map(e => join(root, e.name))
    .sort();
}

/** Which image a cell is scored from, resolved against the run directory
 *  because a cell's conditioning images are shared by every cell of the same
 *  plan and live in refs/, not in the cell's own folder.
 *
 *  `--self` reads the conditioning image instead of the render: free, needs no
 *  key and no running app, and the only way to learn what a metric's ceiling is
 *  on this plan set. When a cell attached control maps, the first of them is the
 *  honest self-target — it is the picture the provider was asked to obey. */
function imageFor(runDir, cell, self) {
  const at = rel => (rel ? join(runDir, rel) : null);
  const candidates = self
    ? [at(cell.files?.controls?.[(cell.controls ?? [])[0]]), at(cell.files?.reference)]
    : [at(cell.files?.render)];
  return candidates.find(p => p && existsSync(p)) ?? null;
}

/** Scores every finished cell of a run. Cells with no image are reported as
 *  unscored rather than dropped: a sweep that failed half its submits must not
 *  read as a sweep that scored well on the half that worked. */
export async function scoreRun(runDir, opts = {}) {
  const { self = false, onCell = null } = opts;
  const dirs = cellDirs(runDir);
  const cells = [];

  for (const dir of dirs) {
    const cell = readJson(join(dir, 'cell.json'));
    const truthPath = cell.files?.truth ? join(runDir, cell.files.truth) : '';
    const img = imageFor(runDir, cell, self);

    const row = {
      id: cell.id, plan: cell.plan, seed: cell.seed, view: cell.view,
      provider: cell.provider, controls: cell.controls ?? [],
      controlScale: cell.controlScale ?? null, strength: cell.strength ?? null,
      status: cell.status, usd: cell.usd ?? null,
    };

    if (!img || !existsSync(truthPath)) {
      cells.push({ ...row, scored: false, reason: img ? 'no sidecar' : 'no image' });
      if (onCell) onCell(cells[cells.length - 1]);
      continue;
    }

    const px = await loadPixels(img);
    const metrics = await scorePixels(px, readJson(truthPath));
    cells.push({ ...row, scored: true, metrics, composite: composite(metrics) });
    if (onCell) onCell(cells[cells.length - 1]);
  }

  const manifestPath = join(runDir, 'manifest.json');
  return {
    run: existsSync(manifestPath) ? readJson(manifestPath) : null,
    scoredAt: new Date().toISOString(),
    /* Stamped on the scorecard because a self-score and a render score are not
       comparable numbers and a file that does not say which it is will be read
       as whichever the reader expected. */
    kind: self ? 'self' : 'render',
    cells,
  };
}

/* ── reporting ───────────────────────────────────────────────────── */

export const mean = xs => {
  const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

export const fmt = (v, dp = 3) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(dp);

/** A fixed-width table. Every eval script prints through this one so a scorecard
 *  and a diff line up in the same terminal. */
export function table(headers, rows) {
  const all = [headers, ...rows].map(r => r.map(c => String(c ?? '')));
  const w = headers.map((_, i) => Math.max(...all.map(r => (r[i] ?? '').length)));
  const line = r => r.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ');
  return [line(all[0]), w.map(n => '-'.repeat(n)).join('  '), ...all.slice(1).map(line)].join('\n');
}

/** Per-metric means over the scored cells, plus the per-rank room decay, which
 *  is printed as its own block because it is the one result the sweep exists to
 *  produce and a mean would erase it. */
export function summarise(card) {
  const scored = card.cells.filter(c => c.scored);
  const rows = METRICS.map(m => [m.label, fmt(mean(scored.map(c => m.of(c.metrics))), m.dp ?? 3)]);
  rows.push(['composite', fmt(mean(scored.map(c => c.composite)))]);

  const byRank = new Map();
  for (const c of scored) {
    for (const r of c.metrics.rooms.rooms) {
      if (r.rank === null || r.note === 'degenerate') continue;
      if (!byRank.has(r.rank)) byRank.set(r.rank, []);
      byRank.get(r.rank).push(r.iou);
    }
  }
  const ranks = [...byRank.entries()].sort((a, b) => a[0] - b[0])
    .map(([rank, ious]) => [`rank ${rank}`, ious.length, fmt(mean(ious))]);

  const flagged = new Map();
  for (const c of scored) for (const f of c.metrics.flags ?? []) flagged.set(f, (flagged.get(f) ?? 0) + 1);

  return { scored: scored.length, total: card.cells.length, rows, ranks, flags: flagged };
}

function report(card) {
  const s = summarise(card);
  const out = [
    '',
    `${card.kind === 'self' ? 'SELF-SCORE (conditioning images — this is the ceiling, not a render)' : 'SCORECARD'}`
      + `  ${s.scored}/${s.total} cells scored`,
    '',
    table(['metric', 'mean'], s.rows),
  ];
  if (s.ranks.length) {
    out.push('', 'Room IoU by position in the prompt — the decay IS the result:', '',
      table(['rank', 'n', 'IoU'], s.ranks));
  }
  if (s.flags.size) {
    out.push('', table(['flag', 'cells'], [...s.flags].map(([f, n]) => [f, n])));
  }
  const unscored = card.cells.filter(c => !c.scored);
  if (unscored.length) {
    out.push('', `${unscored.length} cell(s) not scored: `
      + [...new Set(unscored.map(c => c.reason))].join(', '));
  }
  /* orthoScore is ours. Printed under every table it appears in, because a
     number in a column looks exactly as published as the one above it. */
  out.push('', '* orthoScore is our own construction, not a published metric. See docs/EVAL.md.', '');
  return out.join('\n');
}

/* ── the command ─────────────────────────────────────────────────── */

if (import.meta.main) {
  const args = process.argv.slice(2);
  const self = args.includes('--self');
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir) {
    console.error('usage: pnpm eval:score <run-dir> [--self]\n'
      + '  --self  score the conditioning images instead of the renders (free, no key,\n'
      + '          and the only way to learn each metric\'s ceiling on this plan set)');
    process.exit(2);
  }
  const runDir = resolve(dir);
  if (!cellDirs(runDir).length) {
    console.error(`${runDir} holds no cells — is that a run directory?`);
    process.exit(2);
  }

  const card = await scoreRun(runDir, {
    self,
    onCell: c => process.stderr.write(
      c.scored ? `  ${c.id} composite=${fmt(c.composite)}\n` : `  ${c.id} — ${c.reason}\n`),
  });
  const out = join(runDir, self ? 'selfscore.json' : 'scorecard.json');
  writeFileSync(out, `${JSON.stringify(card, null, 2)}\n`);
  console.log(report(card));
  console.log(`Written to ${out}`);
  /* Tesseract's worker is a live handle: without this the process scores
     everything, prints the table and then simply never exits. */
  await closeTextWorker();
}
