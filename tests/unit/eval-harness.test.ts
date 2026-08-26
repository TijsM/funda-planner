/** The runner, the scorecard and the diff — the pure parts, which is where the
 *  money maths and the statistics live.
 *
 *  Nothing here touches the network or the filesystem's run directories. What is
 *  worth pinning is exactly the code that would otherwise be trusted: a grid
 *  that quietly drops an axis spends the wrong amount, a spend estimate that
 *  rounds the wrong way approves a render past the ceiling, and a bootstrap that
 *  resamples the wrong unit calls every wobble a finding.
 */
import { describe, expect, it } from 'vitest';
import { expandGrid, outputSize, parseArgs, planSpend, statusUrlOf } from '../../scripts/eval/run.mjs';
import { METRICS, WEIGHTED, composite, mean, table } from '../../scripts/eval/score.mjs';
import { bootstrapCI, compare, isEmptyBaseline } from '../../scripts/eval/diff.mjs';
import { MAX_USD_PER_IMAGE, metaOf } from '../../src/data/providers';
import baseline from '../../eval/baseline.json';

/* A frame per plan, the shape expandGrid wants. Deliberately not from a real
   fixture: this is about the grid's arithmetic, not about any plan's geometry. */
const frames = (ids: string[]) =>
  Object.fromEntries(ids.map(id => [id, { width: 1200, height: 1800 }])) as Record<
    string, { width: number; height: number }>;

describe('parseArgs', () => {
  /* A flag that is silently ignored is a sweep that spends money on a grid
     nobody asked for: `--seed 3` instead of `--seeds 3` would run one seed and
     be written up as three. */
  it('refuses a flag it does not recognise instead of ignoring it', () => {
    expect(() => parseArgs(['--seed', '3'])).toThrow(/unknown flag --seed/);
    expect(() => parseArgs(['--plans'])).toThrow(/--plans needs a value/);
  });

  /* Every axis is validated against what actually exists, because a typo that
     survives parsing is discovered by the vendor rather than by us — and the
     vendor charges for the discovery. */
  it('refuses a plan, view, control or provider that does not exist', () => {
    expect(() => parseArgs(['--plans', 'studio-24'])).toThrow(/no fixture plan "studio-24"/);
    expect(() => parseArgs(['--views', 'plan'])).toThrow(/unknown view/);
    expect(() => parseArgs(['--controls', 'canny'])).toThrow(/unknown control/);
    expect(() => parseArgs(['--providers', 'midjourney'])).toThrow(/unknown provider/);
  });

  /* `ink` is a pass but not a control signal — it is the reference image itself.
     Offering it as `--controls ink` would send the plan twice and score the
     result as a control arm. */
  it('does not accept the reference pass as a control signal', () => {
    expect(() => parseArgs(['--controls', 'ink'])).toThrow(/unknown control "ink"/);
    expect(parseArgs(['--controls', 'none,line,depth,seg,change']).controls)
      .toEqual(['none', 'line', 'depth', 'seg', 'change']);
  });

  /* Two spellings on purpose — a sweep says how MANY seeds, a repro says WHICH —
     and a count has to resolve to the committed list rather than to random
     numbers, or no cell can ever be paired against the baseline again. */
  it('reads a seed count and an explicit seed list, and keeps the count deterministic', () => {
    expect(parseArgs(['--seeds', '2']).seeds).toEqual(parseArgs(['--seeds', '2']).seeds);
    expect(parseArgs(['--seeds', '2']).seeds).toHaveLength(2);
    expect(parseArgs(['--seeds', '4']).seeds).toHaveLength(4);
    expect(parseArgs(['--seeds', '99,100']).seeds).toEqual([99, 100]);
    /* A count past the committed list is a list of one big seed, not a silent
       truncation to however many we happen to ship. */
    expect(parseArgs(['--seeds', '4242']).seeds).toEqual([4242]);
  });

  /* app/api/render/route.ts reads controlScale and deliberately drops strength.
     A strength sweep would send four bodies differing in a field nobody reads,
     render four identical cells, and report that strength does nothing — a wrong
     answer, not a failed one. This test is the tripwire on that refusal: if the
     route ever grows the field, it fails and points at the note to lift. */
  it('refuses to sweep a dial the render route does not read', () => {
    expect(() => parseArgs(['--strength', '0.4,0.8'])).toThrow(/--strength is not wired up/);
    expect(() => parseArgs(['--strength', '0.4,0.8'])).toThrow(/Sweep --control-scale instead/);
    /* control-scale is the dial that IS read, and must stay sweepable */
    expect(parseArgs(['--control-scale', '0.4,0.6,0.8,1.0']).controlScale)
      .toEqual([0.4, 0.6, 0.8, 1.0]);
  });

  it('defaults to every plan, the orthographic view and no control map', () => {
    const o = parseArgs([]);
    expect(o.plans).toHaveLength(10);
    expect(o.views).toEqual(['top']);
    expect(o.controls).toEqual(['none']);
    /* The default provider is what ships, so a bare `pnpm eval` measures today's
       behaviour rather than an experiment. */
    expect(o.providers).toEqual(['flux2-max']);
    expect(o.dry).toBe(false);
    expect(o.yes).toBe(false);
  });
});

describe('outputSize', () => {
  /* flux-general-cn bills by rounding UP to the nearest megapixel, so the budget
     stretches to exactly 1 MP and 1024x1024 (1.05 MP) bills as two — $0.15,
     past the ceiling. The size has to be chosen under the rounding, not under
     the raw rate, or the harness asks for a render the route must refuse. */
  it('keeps a whole-megapixel biller inside one megapixel', () => {
    const meta = metaOf('flux-general-cn');
    const { width, height } = outputSize(meta, 1200, 1800, 4_000_000);
    expect(width * height).toBeLessThanOrEqual(1_000_000);
    expect(width % meta.dimStep).toBe(0);
    expect(height % meta.dimStep).toBe(0);
  });

  /* The ceiling is not advice. Whatever --target-pixels asks for, no provider may
     be handed a size whose single image costs more than a dime. */
  it('never returns a size that costs more than the ceiling, on any provider', () => {
    for (const meta of [metaOf('flux2-max'), metaOf('flux2-flex'), metaOf('z-image-cn'),
      metaOf('flux-general-cn'), metaOf('qwen-edit')]) {
      const { width, height } = outputSize(meta, 1200, 1800, 4_000_000);
      const mp = meta.billsWholeMegapixels
        ? Math.max(1, Math.ceil((width * height) / 1e6))
        : (width * height) / 1e6;
      expect(mp * (meta.usdPerMegapixel ?? 0)).toBeLessThanOrEqual(MAX_USD_PER_IMAGE + 1e-9);
    }
  });

  /* The MIN_DIM floor raises one side without touching the other, so a violent
     aspect ratio can land back OVER the budget the scaling just brought it
     under. No real plan is 1x4000; wrong arithmetic waits. */
  it('does not let a violent aspect ratio climb back over the budget', () => {
    const { width, height } = outputSize(metaOf('flux2-max'), 1, 4000, 1_048_576);
    expect(width * height).toBeLessThanOrEqual(1_048_576);
    expect(width).toBeGreaterThanOrEqual(metaOf('flux2-max').minDim);
  });

  it('keeps the plan\'s aspect ratio to within a step', () => {
    const { width, height } = outputSize(metaOf('flux2-max'), 1200, 1800, 1_048_576);
    expect(height / width).toBeCloseTo(1.5, 1);
  });
});

describe('expandGrid', () => {
  /* Every axis multiplies. An axis silently dropped is a sweep that answers a
     different question than the one it printed a price for. */
  it('multiplies every axis, and gives every cell a distinct id', () => {
    const plans = ['studio-26', 'nl-first'];
    const cells = expandGrid({
      plans, views: ['top', 'iso'], providers: ['z-image-cn'],
      controls: ['none', 'line', 'depth'], controlScale: [0.4, 0.8], strength: [null],
      seeds: [7, 1234], targetPixels: 1_048_576,
    }, frames(plans));
    expect(cells).toHaveLength(2 * 2 * 1 * 3 * 2 * 1 * 2);
    expect(new Set(cells.map(c => c.id)).size).toBe(cells.length);
  });

  /* The research sweep, exactly as the brief specifies it: 10 plans x 3 control
     signals x 4 strengths x 2 seeds, on the cheapest provider, under ten
     dollars. If this ever stops being true the docs are lying about the price. */
  it('prices the research sweep the brief asks for under ten dollars', () => {
    const plans = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const cells = expandGrid({
      plans, views: ['top'], providers: ['z-image-cn'],
      controls: ['line', 'depth', 'seg'], controlScale: [0.4, 0.6, 0.8, 1.0],
      strength: [null], seeds: [7, 1234], targetPixels: 1_048_576,
    }, frames(plans));
    expect(cells).toHaveLength(240);
    const total = cells.reduce((s, c) => s + (c.usd ?? 0), 0);
    expect(total).toBeLessThan(10);
    /* Not merely under ten: it should be a couple of dollars, which is the whole
       reason z-image is the rig the harness sweeps on. A regression that made it
       $9.90 would still pass a "< 10" assertion. */
    expect(total).toBeLessThan(2.5);
  });

  /* A map handed to a model with no control channel arrives as another semantic
     reference picture, not as geometry. That is a legitimate arm to sweep — it
     is the A/B against FLUX.2 — but conflating it with a real ControlNet arm
     would file the two under one result. */
  it('records whether the provider can actually accept the map it is sent', () => {
    const plans = ['p'];
    const [semantic] = expandGrid({
      plans, views: ['top'], providers: ['flux2-max'], controls: ['line'],
      controlScale: [null], strength: [null], seeds: [7], targetPixels: 1_048_576,
    }, frames(plans));
    const [real] = expandGrid({
      plans, views: ['top'], providers: ['z-image-cn'], controls: ['line'],
      controlScale: [null], strength: [null], seeds: [7], targetPixels: 1_048_576,
    }, frames(plans));
    expect(semantic.controlsAccepted).toBe(false);
    expect(real.controlsAccepted).toBe(true);
    /* seg has no published FLUX.1-dev ControlNet, so flux-general-cn cannot take
       it even though it takes line and depth. */
    const [noSeg] = expandGrid({
      plans, views: ['top'], providers: ['flux-general-cn'], controls: ['seg'],
      controlScale: [null], strength: [null], seeds: [7], targetPixels: 1_048_576,
    }, frames(plans));
    expect(noSeg.controlsAccepted).toBe(false);
  });

  /* The id is the pairing key for every future diff. A dial that changed without
     changing the id would silently overwrite the cell it should be compared
     against — and `--control-scale 0.4` vs `0.8` is exactly that dial. */
  it('puts every swept dial into the cell id, so two arms cannot collide', () => {
    const plans = ['p'];
    const cells = expandGrid({
      plans, views: ['top'], providers: ['z-image-cn'], controls: ['line'],
      controlScale: [0.4, 0.8], strength: [0.55], seeds: [7], targetPixels: 1_048_576,
    }, frames(plans));
    expect(cells[0].id).not.toBe(cells[1].id);
    expect(cells[0].id).toContain('cs0.4');
    expect(cells[1].id).toContain('cs0.8');
    expect(cells[0].id).toContain('st0.55');
    /* Safe as a directory name on any platform the run directory lands on. */
    for (const c of cells) expect(c.id).toMatch(/^[A-Za-z0-9_.+-]+$/);
  });
});

describe('planSpend', () => {
  const opts = { budget: 10 };
  const cell = (over: Partial<Record<string, unknown>> = {}) => ({
    provider: 'z-image-cn', width: 1024, height: 1024, usd: 0.0067, ...over,
  }) as never;

  /* The budget is the guard against a fat-fingered grid. It refuses rather than
     warns, because a warning printed above a 240-line render log is a warning
     nobody reads until the invoice. */
  it('refuses a sweep whose estimate is past the budget', () => {
    const cells = Array.from({ length: 4000 }, () => cell());
    const { refusals, total } = planSpend(cells, opts);
    expect(total).toBeGreaterThan(10);
    expect(refusals.join(' ')).toMatch(/past the --budget/);
  });

  /* An unpriced provider cannot be shown to be under a ceiling, so it is refused
     rather than guessed at — the same call assertAffordable makes on the server,
     made before any money moves rather than after. */
  it('refuses a provider that publishes no price at all', () => {
    const { refusals } = planSpend([cell({ usd: null })], opts);
    expect(refusals.join(' ')).toMatch(/publishes no price/);
  });

  /* The per-image ceiling is checked here as well as at the route, and the
     refusal names a smaller size, because "no" without a next step sends the
     reader to the source to work out which flag to change. */
  it('refuses a single image past the ceiling and names a size that fits', () => {
    const { refusals } = planSpend(
      [cell({ provider: 'flux2-max', width: 2048, height: 2048, usd: 0.29 })], opts);
    expect(refusals.join(' ')).toMatch(/past the \$0.10 ceiling/);
    expect(refusals.join(' ')).toMatch(/fits — lower --target-pixels/);
  });

  it('lets an affordable sweep through with no refusals, and totals it per provider', () => {
    const { refusals, total, byProvider } = planSpend(
      [cell(), cell(), cell({ provider: 'flux2-max', usd: 0.0734 })], opts);
    expect(refusals).toEqual([]);
    expect(total).toBeCloseTo(0.0868, 4);
    expect(byProvider.get('z-image-cn').n).toBe(2);
    expect(byProvider.get('flux2-max').n).toBe(1);
  });

  /* The preflight is a real image and costs real money, so it belongs in the
     total the operator agrees to rather than as a surprise line afterwards. */
  it('counts the preflight image in the total', () => {
    const bare = planSpend([cell()], opts, 0).total;
    expect(planSpend([cell()], opts, 0.05).total).toBeCloseTo(bare + 0.05, 6);
  });
});

describe('statusUrlOf', () => {
  /* The status route measures the pollUrl against the named provider's own hosts
     and nothing else, so a poll that names nobody is tried as flux2-max and a
     queue.fal.run URL dies at that check — after the image has been submitted and
     billed. `--providers z-image-cn` is the sweep docs/EVAL.md tells you to run,
     so leaving this field out threw away every image in it. The browser's
     `statusUrl` in src/shell/jobs.ts had the same hole and is pinned the same way. */
  it('names the provider a job belongs to, not just the job', () => {
    const url = statusUrlOf('http://localhost:3500', {
      jobId: 'req-1',
      pollUrl: 'https://queue.fal.run/fal-ai/z-image/turbo/controlnet/requests/req-1/status',
      provider: 'z-image-cn',
    });
    expect(url).toContain('provider=z-image-cn');
    expect(url).toContain(`pollUrl=${encodeURIComponent(
      'https://queue.fal.run/fal-ai/z-image/turbo/controlnet/requests/req-1/status')}`);
    expect(url).toContain('jobId=req-1');
  });
});

describe('composite', () => {
  const metrics = (over = {}) => ({
    envelope: { iou: 0.8, frameScale: 1, coverage: 0.7 },
    rooms: { mean: 0.5, rankSlope: -0.1, rooms: [] },
    lines: { f1: 0.4, precision: 0.4, recall: 0.4, predPixels: 1, truthPixels: 1000 },
    ortho: { score: 0.9 },
    text: { fraction: 0, tokens: [], rejected: 0 },
    ...over,
  });

  it('weights the four structural metrics and nothing else', () => {
    expect(WEIGHTED.map(m => m.key)).toEqual(['envelope', 'rooms', 'lines', 'ortho']);
    expect(WEIGHTED.reduce((s, m) => s + m.weight, 0)).toBeCloseTo(1, 9);
    expect(composite(metrics())).toBeCloseTo(0.8 * 0.35 + 0.5 * 0.3 + 0.4 * 0.25 + 0.9 * 0.1, 9);
  });

  /* phash is a guardrail: weighting it would make "look different from the
     baseline" worth points. And the text fraction is a gate, not a term — at
     0.0001-0.01 any weight it carried would be swamped noise while the token
     count answers the A/B outright. */
  it('gives no weight to the tripwire or to the lettering fraction', () => {
    for (const key of ['text', 'textTokens', 'rankSlope', 'frameScale', 'coverage']) {
      expect(METRICS.find(m => m.key === key)!.weight).toBe(0);
    }
    const bled = composite(metrics({ text: { fraction: 0.02, tokens: ['KEUKEN'], rejected: 0 } }));
    expect(bled).toBeCloseTo(composite(metrics())!, 9);
  });

  /* A footprint IoU that covered the whole frame means no background was found,
     so the similarity fit registered against nothing and its 0.99 is meaningless
     rather than excellent. Averaging it in is how a scorecard launders a failed
     registration into progress. */
  it('refuses to score a cell whose registration found no background', () => {
    expect(composite({ ...metrics(), note: 'unregistered' })).toBeNull();
  });

  /* Renormalised over what actually produced a number, so one missing metric
     does not read as a zero for that metric. */
  it('renormalises rather than counting a missing metric as zero', () => {
    const partial = composite({ ...metrics(), lines: null, ortho: null });
    expect(partial).toBeCloseTo((0.8 * 0.35 + 0.5 * 0.3) / 0.65, 9);
  });
});

describe('bootstrapCI', () => {
  /* The whole point of the table. A difference whose interval contains zero is
     not a result, and without this it gets repeated as one. */
  it('marks a difference as noise when the interval straddles zero', () => {
    const ci = bootstrapCI([0.01, -0.02, 0.03, -0.01, 0.02, -0.03]);
    expect(ci!.noise).toBe(true);
  });

  it('does not mark a difference as noise when every plan moved the same way', () => {
    const ci = bootstrapCI([0.18, 0.21, 0.16, 0.24, 0.19, 0.22]);
    expect(ci!.noise).toBe(false);
    expect(ci!.lo).toBeGreaterThan(0);
    expect(ci!.diff).toBeCloseTo(0.2, 1);
  });

  /* Seeded on purpose: an unseeded bootstrap makes the table move when nothing
     else has, which is precisely the false signal this file exists to suppress. */
  it('gives the same interval twice for the same input', () => {
    const xs = [0.1, -0.05, 0.2, 0.02, -0.1, 0.15, 0.03, 0.07];
    expect(bootstrapCI(xs)).toEqual(bootstrapCI(xs));
    /* and a different one for a different seed, so the seed is really in use */
    expect(bootstrapCI(xs, { seed: 1 })!.lo).not.toBe(bootstrapCI(xs, { seed: 2 })!.lo);
  });

  /* A bootstrap over three plans resamples the same three buildings; the
     "confidence" in the interval it produces is entirely fictional. Saying so is
     more useful than printing it. */
  it('declines to give an interval over too few plans instead of inventing one', () => {
    const ci = bootstrapCI([0.2, 0.3, 0.25]);
    expect(ci!.lo).toBeNull();
    expect(ci!.noise).toBeNull();
    expect(ci!.plans).toBe(3);
    /* the observed difference is still reported — it is the CI that is withheld */
    expect(ci!.diff).toBeCloseTo(0.25, 6);
  });

  /* A metric that did not move at all is a different and much more useful fact
     than one we cannot resolve, and both straddle zero. */
  it('separates a metric that did not move from one that is merely noisy', () => {
    expect(bootstrapCI([0, 0, 0, 0, 0])!.flat).toBe(true);
    expect(bootstrapCI([0.01, -0.02, 0.03, -0.01, 0.02])!.flat).toBe(false);
  });

  it('has nothing to say about an empty sample', () => {
    expect(bootstrapCI([])).toBeNull();
    expect(bootstrapCI([Number.NaN, null as unknown as number])).toBeNull();
  });
});

describe('compare', () => {
  const cell = (id: string, plan: string, iou: number) => ({
    id, plan, seed: 7, scored: true,
    composite: iou,
    metrics: {
      envelope: { iou, frameScale: 1, coverage: 0.7 },
      rooms: { mean: iou, rankSlope: -0.1, rooms: [{ rank: 0, id: 'a', name: 'A', iou }] },
      lines: { f1: iou, truthPixels: 1000 },
      ortho: { score: 0.9 },
      text: { fraction: 0, tokens: [] },
      phash: '00',
    },
  });
  const card = (cells: unknown[], kind = 'render') => ({ kind, run: null, cells } as never);

  /* Only matched cells are differenced. Two independent means over grids that are
     not the same grid differ for reasons that have nothing to do with the change
     under test, which is the comparison the brief forbids outright. */
  it('pairs on cell id and ignores a cell the other side does not have', () => {
    const run = card([cell('a', 'p1', 0.8), cell('b', 'p2', 0.8), cell('only-here', 'p3', 0.1)]);
    const base = card([cell('a', 'p1', 0.6), cell('b', 'p2', 0.6), cell('only-there', 'p4', 0.9)]);
    const cmp = compare(run, base);
    expect(cmp.pairs).toBe(2);
    expect(cmp.plans).toBe(2);
    const envelope = cmp.rows.find(r => r.metric === 'envelope IoU')!;
    expect(envelope.ci!.diff).toBeCloseTo(0.2, 9);
  });

  /* An unregistered cell measured nothing: the registration search failed and the
     zeros are its own, not the render's. composite() already refuses to blend one,
     and the per-metric rows have to refuse it too — otherwise a run whose images
     could not be measured reads as a run that got worse, which is the one way this
     table could actively mislead. */
  it('leaves an unregistered cell out of every row, and says that it did', () => {
    const dud = { ...cell('c', 'p3', 0), metrics: { ...cell('c', 'p3', 0).metrics, note: 'unregistered' } };
    const run = card([cell('a', 'p1', 0.8), cell('b', 'p2', 0.8), dud]);
    const base = card([cell('a', 'p1', 0.8), cell('b', 'p2', 0.8), cell('c', 'p3', 0.8)]);
    const cmp = compare(run, base);
    expect(cmp.pairs).toBe(2);
    expect(cmp.unregistered).toBe(1);
    /* Nothing moved, so every interval must straddle zero — with the dud averaged
       in, envelope IoU would have read as a 0.27 drop. */
    const envelope = cmp.rows.find(r => r.metric === 'envelope IoU')!;
    expect(envelope.ci!.diff).toBeCloseTo(0, 9);
  });

  /* Twenty cells of one plan are twenty looks at the same building. Resampling
     over cells would report an interval several times too narrow and call every
     wobble significant; the plan is the unit, so twenty cells of one plan carry
     no more weight in the interval than one cell of one plan. */
  it('weights a plan by being a plan, not by how many cells it happens to carry', () => {
    const many = Array.from({ length: 20 }, (_, i) => cell(`p1-${i}`, 'p1', 0.9));
    const one = [cell('p2-0', 'p2', 0.1)];
    const base = [...many, ...one].map(c => ({ ...c, metrics: { ...c.metrics,
      envelope: { ...c.metrics.envelope, iou: 0.5 } } }));
    const cmp = compare(card([...many, ...one]), card(base));
    /* +0.4 on one plan and -0.4 on the other, so the plan-weighted mean is 0.
       Cell-weighted it would be +0.36 and would read as a large improvement. */
    expect(cmp.rows.find(r => r.metric === 'envelope IoU')!.ci!.diff).toBeCloseTo(0, 6);
  });

  it('reports nothing to compare when the two grids do not overlap at all', () => {
    const cmp = compare(card([cell('x', 'p1', 0.8)]), card([cell('y', 'p2', 0.6)]));
    expect(cmp.pairs).toBe(0);
  });

  /* The scorecard stores a phash as hex so it diffs readably, and the tripwire
     has to decode it back to the 63 one-per-byte bits phashDistance compares. A
     storage format that round-tripped wrong would report every pair as identical
     — a tripwire that never fires, which is worse than no tripwire because it
     reads as a clean bill of health. */
  it('decodes the stored hex phash back into a real distance', () => {
    const withHash = (id: string, plan: string, hex: string) => {
      const c = cell(id, plan, 0.8);
      return { ...c, metrics: { ...c.metrics, phash: hex } };
    };
    const same = '000101'.repeat(21);
    const other = `010001${'000101'.repeat(20)}`;
    const run = card([withHash('a', 'p1', same), withHash('b', 'p2', other)]);
    const base = card([withHash('a', 'p1', same), withHash('b', 'p2', same)]);
    const { phash } = compare(run, base);
    expect(phash!.n).toBe(2);
    /* one cell unchanged, one moved — so the tripwire distinguishes them */
    expect(phash!.identical).toBe(1);
    expect(phash!.max).toBeGreaterThan(0);
  });
});

describe('the committed baseline', () => {
  /* It ships empty on purpose. A baseline of invented numbers is worse than
     none, because every later diff would then be measured against fiction — and
     nobody reading a table can tell which of those they are looking at. */
  it('is honestly empty, and says in the file why', () => {
    expect(baseline.cells).toEqual([]);
    expect(isEmptyBaseline(baseline)).toBe(true);
    expect(baseline.comment).toMatch(/UNPOPULATED/);
    /* No stray numbers anywhere in it that a reader could mistake for a result. */
    expect(baseline.scoredAt).toBeNull();
    expect(baseline.run).toBeNull();
  });

  it('is recognised as unpopulated however it goes missing', () => {
    expect(isEmptyBaseline(null)).toBe(true);
    expect(isEmptyBaseline({})).toBe(true);
    expect(isEmptyBaseline({ cells: [] })).toBe(true);
    expect(isEmptyBaseline({ cells: [{ id: 'a' }] })).toBe(false);
  });
});

describe('table', () => {
  /* Every eval script prints through this one, so a scorecard and a diff line up
     in the same terminal. */
  it('lines the columns up and rules them off under the header', () => {
    const out = table(['metric', 'mean'], [['envelope IoU', '0.947'], ['line F1', '0.587']]);
    const rows = out.split('\n');
    expect(rows[1]).toMatch(/^-+ {2}-+$/);
    expect(new Set(rows.map(r => r.length)).size).toBe(1);
  });

  it('has a dash for a metric that produced no number, never a zero', () => {
    expect(mean([])).toBeNull();
    expect(table(['a'], [[null]])).toContain('');
  });
});
