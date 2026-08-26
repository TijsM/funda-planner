# The render evaluation harness

Our renders drift: the camera comes back as a three-quarter dollhouse tilt instead of orthographic,
walls and proportions wander (worse for rooms listed later in the prompt), furniture moves, chair
counts change, and our own lettering bleeds into the output.

The vendor documents the cause. FLUX.2's `input_image` is a **semantic** reference channel, not a
spatial control channel — docs.bfl.ai: *"Instead of dedicated ControlNet inputs, FLUX.2 uses its
multi-reference editing system to achieve structural control… FLUX.2 interprets structure
semantically."* The `/v1/flux-2-max` body has no `strength`, no `conditioning_scale`, no control map
and no negative prompt, so this cannot be prompted away. Two findings say the same thing directly:
[arXiv:2507.08039](https://arxiv.org/abs/2507.08039) measures spatial position through text at 0.41
quadrant F1 against 96% shape F1, and [arXiv:2503.06884](https://arxiv.org/abs/2503.06884) is titled
*"Text-to-Image Diffusion Models Cannot Count, and Prompt Refinement Cannot Help"*.

So geometry has to travel as **pixels** rather than prose. We already hold the plan as vectors, so a
line map, a depth map, a segmentation map and a per-pixel change map cost us nothing to emit.

**None of that is proven on architectural plans.** This harness exists so the next decision is
measured rather than eyeballed, and so is part of the build rather than an afterthought.

---

## Two things to read before you believe a number

**1. Object counting is not implemented.** There is no chair-count metric and there will not be one
until there is an open-vocabulary detector behind it. The sidecar carries `expectedSeats`, so the gap
is one detector away — but a heuristic ("count the dark blobs near the table") would be believed by
everyone who read the scorecard and would be wrong. The gap is documented in
`scripts/eval/metrics/index.mjs` and in `score.mjs` and stays visible. Chair counting remains an
eyeball job today.

**2. `orthoScore` is our own construction, not a published metric.** It is our proxy for "is this
actually orthographic or is it a dollhouse tilt", it counts axis-aligned gradient energy, and **no
paper backs it** — do not cite one. It is only meaningful as a *difference between two conditions*,
never as an absolute, and a render full of axis-aligned texture (floorboards, tiling) scores higher
than its walls deserve. Of the metrics here, only `lineF1` follows a published method
([ControlNet++, arXiv:2404.07987](https://arxiv.org/abs/2404.07987) §4).

---

## The method

From ControlNet++: run an extractor over the **generated** image, recover the condition, and compare
it with the condition that went in. Our unfair advantage is that we never have to extract the input —
we hold the ground truth as vectors and `scripts/eval/truth.mjs` writes it out as pixels of the same
frame the conditioning image was painted in.

```
scripts/eval/plans.mjs        the ten fixture plans, parsed through the app's own loader
scripts/eval/truth.mjs        the ground-truth sidecar for a plan + frame
scripts/eval/metrics/*.mjs    one file per metric, each pure over pixel buffers
scripts/eval/score.mjs        scores one run  -> scorecard.json
scripts/eval/run.mjs          the sweep: plans x seeds x views x providers -> renders -> scores
scripts/eval/diff.mjs         a run against eval/baseline.json, as a table
eval/baseline.json            committed; eval/runs/<stamp>/ is gitignored output
```

### The ten plans, and what each one catches

The set is ten hand-picked floors rather than one big one so that a score which falls on only one of
them tells you *which* failure moved. `openplan-tables` is the chair count; `nl-ground-garden` is the
marginal unmapped-rooms case; `house-unnamed` names no rooms at all, so every sidecar rank is null.
`scripts/eval/plans.mjs` states the purpose of each one beside its id.

---

## The metrics

| Metric | What it means | Direction | Weight in composite |
|---|---|---|---|
| `envelope IoU` | Registers the render against the plan over translation and scale, then IoU of the outer footprint. Returns the transform every later metric reuses. | higher | 0.35 |
| `room IoU (ranked)` | Per-room IoU **keyed by rank** — rank being the room's position in the prompt's `LOCKED` block. | higher | 0.30 |
| `line F1` | Sobel edges on the render against our wall raster, with a small dilation tolerance. F1 not IoU: edges are a long-tailed binary problem. | higher | 0.25 |
| `ortho score` \* | Fraction of long straight segments that are axis-parallel and consistent with the plan's own wall angles. | higher | 0.10 |
| `rank slope` | Least-squares slope of room IoU against rank. **The hypothesis under test.** Negative = later rooms drift more. | higher (toward 0) | 0 |
| `frame scale` | Scale the registration recovered. 1.00 = the render kept our framing. | neither | 0 |
| `coverage` | Fraction of the render the footprint mask claimed. Near 1 means **no background was found** and the IoU beside it is meaningless. | neither | 0 |
| `text fraction` / `text tokens` | OCR (tesseract.js) over the render: how much of it is lettering, and which words. | lower | 0 |
| `phash` | Perceptual hash. A **regression tripwire** between two same-seed renders. | — | 0 |

\* our own construction — see above.

**Why `text` and `phash` carry no weight.** The lettering fraction runs 0.0001–0.01, so any weighted
contribution is swamped noise, while *"three confident tokens came back"* is a clean yes/no answer to
the A/B that metric exists to settle — read `text tokens`, not `text fraction`. And `phash` is a
guardrail: weighting it would make "look different from the baseline" worth points.

`rank slope` is reported and unweighted on purpose. It is the *result*, not a target — optimising a
slope directly is satisfied by making every room equally bad.

### What a good value looks like

**Not 1.0.** Scoring our own conditioning image against its own sidecar does not give a perfect
score, because a flood fill and a Sobel operator lose real accuracy on a perfect drawing. These are
the **ceilings**, measured over all ten plans (`pnpm eval:score <dir> --self`):

| Metric | Ceiling (reference image) | Ceiling (line control map) |
|---|---|---|
| envelope IoU | **0.949** | 0.944 |
| room IoU (ranked) | **0.520** | 0.435 |
| line F1 | **0.625** | 0.549 |
| ortho score | **0.947** | 0.917 |
| coverage | 0.748 | 0.744 |
| text tokens | **0.00** | 0.00 |
| composite | **0.739** | 0.690 |

Read a render against those, not against 1.0. A render at `line F1` 0.55 is close to as good as this
metric can report; a scorecard read against 1.0 says every render ever made is broken. Room IoU in
particular has a ceiling near **0.52**, because the flood fill needs an edge along every wall and a
photoreal render often has a soft shadow there instead.

Per-rank room IoU on our own reference is *not* flat either — `0: 0.59, 1: 0.65, 2: 0.52, 3: 0.21,
4: 0.43` — because later ranks are systematically the small rooms (a 4 m² toilet is a harder fill
than a 38 m² living room). **Rank decay must therefore be read as a difference against this baseline,
never as an absolute**, or the metric's own bias will be reported as the model's.

Regenerate these numbers whenever the plan set or a metric changes:

```bash
pnpm eval --dry --controls none,line --out eval/runs/ceiling
pnpm eval:score eval/runs/ceiling --self
```

Both commands are free — no key, no running app, nothing submitted.

---

## Running a sweep

The harness talks HTTP to a **locally running app** exactly as the browser does, so it exercises the
real route including the real cost ceiling.

```bash
pnpm dev                                   # the app must be up; default http://localhost:3500
pnpm eval --dry                            # conditioning images + sidecars + briefs. Free.
pnpm eval                                  # prints the estimate and refuses to spend
pnpm eval --yes                            # actually spends it
pnpm eval:score eval/runs/<stamp>          # -> scorecard.json
pnpm eval:diff  eval/runs/<stamp>          # -> the table, against eval/baseline.json
```

Override the app's address with `EVAL_BASE_URL` or `--base-url`. **Cloud mode cannot be swept**: it
keeps the polling URL server-side (deliberately — that is what stops one account polling another's
job), so the harness has no way to collect the image and says so rather than timing out.

### The grid

| Flag | Default | Notes |
|---|---|---|
| `--plans` | all ten | comma-separated fixture ids |
| `--views` | `top` | `top,eye,iso,sketch` — but see the warning below |
| `--providers` | `flux2-max` | what ships today, so a bare run measures current behaviour |
| `--controls` | `none` | `none,line,depth,seg,change`; `none` is the no-control arm |
| `--control-scale` | not sent | e.g. `0.4,0.6,0.8,1.0` |
| `--seeds` | `1` | a **count** (from a committed list) or an explicit list |
| `--budget` | `10` | dollars; refuses a sweep that would exceed it |
| `--target-pixels` | `1048576` | 1 MP. A money dial before it is a quality one |
| `--concurrency` | `2` | see the warning below |
| `--out` | `eval/runs/<stamp>` | point at an existing run to **resume** it |

Seeds come from a committed list rather than being rolled, because `eval:diff` pairs on
`(plan, seed)` — a random seed makes every cell unpairable and reduces the whole comparison to two
independent means, which is exactly what the diff refuses to print.

**Only `top` is fully measurable.** Every geometric metric registers the render against a top-down
polygon, so on an `iso`, `eye` or `sketch` render `envelope IoU`, `room IoU` and `line F1` are
comparing a perspective picture with a floor plan and their numbers mean nothing. Such a sweep is
still worth running — `orthoScore` and the lettering count are exactly how you measure *"did it come
back as a dollhouse tilt"* — but the three structural columns must not be read. The runner prints this
warning before it spends anything.

**There is no `--strength` sweep.** `app/api/render/route.ts` accepts `controlScale` and deliberately
drops `strength` (nothing on the panel sets it, and each provider's own low starting value is a
considered number rather than a request-overridable default). A strength sweep would therefore send
bodies differing in a field nobody reads, render identical cells, and report that strength does
nothing — so the runner refuses the flag instead of measuring that. `--control-scale` is the dial the
route does read, and it is the one the research sweep turns.

### Money, and the four guards

1. **The estimate is printed first** and nothing is submitted without `--yes`.
2. **`--budget` (default $10)** refuses a sweep whose estimate exceeds it, so `--seeds 8` cannot
   quietly become a hundred dollars. The refusal names the flag to change.
3. **The per-image ceiling** (`MAX_USD_PER_IMAGE`, $0.10, set by the product owner) is enforced here
   as well as in `assertAffordable` on the server, and output sizes are clamped to fit it. A provider
   that publishes **no** price is refused outright — an unpriced call cannot be shown to be under a
   ceiling.
4. **Runs resume.** A cell that already has a `render.png` is skipped, so a sweep that dies at image
   180 of 240 restarts for the price of the sixty that are left.

Exit codes: `0` fine, `1` refused (budget, ceiling, no `--yes`, failed preflight), `2` bad usage.

### The preflight, and why it costs one image

The route reads `provider`, `controls` and `controlScale`. But *"the route reads the field"* and
*"the job landed at the vendor we asked for"* are different claims, and only the second one makes a
scorecard citable — a route that silently substituted a provider would draw 240 FLUX.2 [max] images
at eleven times the quoted price and file them as a ControlNet measurement.

That cannot be checked for free, so the sweep submits **one** image first and checks which vendor's
host the polling URL came back on. A mismatch aborts having spent one image and says which file to
look at. A rejected key aborts for nothing, since a bad key is refused before the vendor bills
anything — which makes this also the cheapest way to discover a broken `FAL_KEY` before committing to
240 images. The result is recorded in the run's `manifest.json` as `providerVerified`:

| Value | Meaning |
|---|---|
| `yes` | the job was on the expected vendor's host, and only one provider uses that host |
| `vendor` | right vendor, but `[max]` and `[flex]` share `api.bfl.ai` — **which model drew it is not something this check can see** |
| `no` | the route substituted a provider. The sweep stopped. |
| `dry` / `not checked` | no verification happened; **do not cite the scorecard** |

`eval:diff` prints a warning above any table whose run was never verified. Skip the preflight with
`--no-preflight` only when you already know the route honours the field.

> **Concurrency.** `--concurrency 2` is a compromise and is **untested against vendor rate limits**.
> A 240-image sweep is roughly two hours at 1 and an hour at 2. If a sweep starts failing in bursts,
> drop to 1 and resume into the same `--out` directory — nothing already rendered is paid for twice.

---

## The research sweep

The sweep the research recommends: **10 plans × 3 control signals × 4 strengths × 2 seeds = 240
images**, on the cheapest provider that has a real control channel with a dial on it.

```bash
pnpm eval \
  --providers z-image-cn \
  --controls line,depth,seg \
  --control-scale 0.4,0.6,0.8,1.0 \
  --seeds 2 \
  --yes
```

**Estimated cost: $1.61** — $1.6071 for the 240 images at 1184×864 (about $0.0067 each), plus one
preflight image. Comfortably inside the $10 budget and inside the $0.10-per-image ceiling.

For contrast, the identical grid on what ships today (`--providers flux2-max`) estimates **$17.38**
and is **refused by the budget** — and would measure nothing about control maps anyway, since FLUX.2
has no control channel to put them in. That gap is the reason z-image is the rig to sweep on.

> **This sweep has never been run.** There is no `FAL_KEY` in this deployment, so every fal code path
> is derived from the vendor's docs and has never touched a socket. The first real call should be a
> single 1 MP z-image render (about $0.0065), not a 240-image sweep.

A cell that sends a control map to a provider with no control channel is recorded as
`controlsAccepted: false`. That is a legitimate arm — it is the A/B for "does an unnamed map help a
purely semantic model" — but it is not a ControlNet measurement and the flag stops the two being
conflated.

---

## Reading the diff

```bash
pnpm eval:diff eval/runs/<stamp>
```

```
metric             baseline     run    diff  CI low  CI high    verdict
-----------------  --------  ------  ------  ------  -------  ---------
envelope IoU          0.947   0.985  +0.038  -0.000    0.115      noise
room IoU (ranked)     0.477   0.646  +0.168   0.115    0.217     better
line F1               0.587   0.784  +0.197   0.113    0.290     better
rank slope           -0.092  -0.135  -0.043  -0.181    0.075      noise
text tokens            0.00    0.00   +0.00    0.00     0.00  unchanged
composite             0.714   0.828  +0.114   0.072    0.175     better
```

Three rules make this table worth reading, and all three are deliberate:

- **Paired, never two means.** Cells are matched by id — plan, view, provider, control, scale,
  strength, seed — and only matched cells are differenced. Two means over grids that are not the same
  grid differ for reasons unrelated to the change under test. If nothing matches, the diff refuses to
  print rather than falling back to unpaired means.
- **Plans are the resampling unit.** Twenty-four cells of one plan are twenty-four looks at the same
  building, not twenty-four observations. Bootstrapping over cells would report an interval several
  times too narrow and call every wobble significant.
- **An interval that straddles zero is `noise`.** Marked in its own column, because a "+0.03" with no
  interval beside it gets repeated as a finding by whoever reads it next.

Verdicts: `better` / `WORSE` (interval clears zero), `noise` (it does not), `unchanged` (the metric
did not move at all — a different and more useful fact), `too few plans` (**fewer than 4** — a
bootstrap over three plans resamples the same three buildings and its confidence is fictional, so no
interval is printed at all).

2000 resamples, seeded and reproducible: an unseeded bootstrap makes the table move when nothing else
has, which is the false signal this file exists to suppress. No p-values, and **never FID at this
sample size**.

The per-rank block below the table is the one result the sweep exists to produce. A change that lifts
rank 0 and drops rank 5 has not fixed rank decay, and the blended `room IoU` row cannot show that.

The `phash` tripwire is last. If every paired render is byte-identical in appearance, whatever changed
never reached the image and every difference above it is scoring noise.

### The baseline

`eval/baseline.json` **ships honestly empty** — no invented numbers, because every later diff is
measured against it and would then be measured against fiction. `eval:diff` detects that and says so
instead of printing a table. Populate it from a run you trust:

```bash
pnpm eval:score eval/runs/<stamp>
pnpm eval:diff  eval/runs/<stamp> --promote
```

Promote only a run whose manifest says `providerVerified` `yes` or `vendor`. Compare two runs directly
with `--baseline <path>` instead of touching the committed file.

---

## Known limits

- **Registration cannot tell "re-cropped our framing" from "drew the wrong building."** A similarity
  fit has no way to. `frameScale` and `coverage` are reported so the caller can see it, but a
  scorecard that prints only the IoU will show a re-framed render as a pass. A `coverage` near 1 means
  no background was found and the IoU beside it is meaningless, not good — those cells score `null`
  and are excluded from the composite rather than averaging a fake 0.99 into it.
- **`roomIou` depends on the render drawing something edge-like along every wall.** With a soft shadow
  instead of a wall line the fill leaks into the neighbouring room and both scores drop for a reason
  that is not shape drift. Watch for adjacent rooms failing together.
- **`textPixelFraction` rests on Tesseract's layout analysis** and has only been verified against
  synthetic plans and one synthetic render. It has already been silently blind once (the default page
  segmentation mode could not see a single word bled onto a drawing), so re-verify it against the
  first real renders from both A/B arms before trusting a null result.
- **The depth pass clamps everything above the 1.2 m cut plane** to the same value, so a wardrobe top
  and a wall top are indistinguishable in that channel. Arguably correct for a plan cut at 1.2 m, but
  it discards real height information — the first thing to question if the dollhouse tilt persists.
- **The geometric metrics assume an orthographic render.** See the `--views` warning above: on a
  non-`top` view only `orthoScore` and the lettering count carry meaning.
- **Every conditioning number is a starting point, not a tuned value** (control scale 0.75, strength
  0.55, guidance 3.5). The harness exists to move them; do not read them as findings.
