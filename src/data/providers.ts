/** Every fact about an image provider that is not a secret and not a fetch.
 *
 *  This file exists because of one constraint: `src/server/providers/*` opens
 *  with `import 'server-only'`, so the picker in the render panel cannot import
 *  a Provider to find out what it is called or what it costs. Both halves import
 *  this one instead — the browser for the list, `src/server/providers/index.ts`
 *  to build its Provider objects on top of. Nothing here may reach for
 *  `process.env`, `fetch` or `document`.
 *
 *  Prices were read off the vendors' own model pages on 2026-08-18 and each one
 *  says below which page said it. They are the reason the ceiling can be
 *  enforced at all: a provider that will not quote a price cannot be shown to be
 *  under one, and `assertAffordable` in the server half refuses it for exactly
 *  that reason.
 */

export type ControlKind = 'line' | 'depth' | 'seg' | 'change';

/** The same four at runtime, for a picker to list and a route to validate
 *  against. Written as the keys of a Record rather than as an array so the list
 *  and the union cannot drift: a kind added to `ControlKind` with no line here is
 *  a missing property, and a line here that is not a kind is an excess one. Both
 *  are compile errors, which is the only kind of reminder that survives a rebase.
 *
 *  Here rather than beside the passes that draw them because the render route
 *  needs it too, and a server route has no business importing the browser's
 *  store. That the engine can actually draw all four — `PASS_KINDS` minus `ink`,
 *  which is the reference image and not a control channel — is asserted in
 *  jobs.test.ts, where a sixth pass appearing in the engine and staying invisible
 *  in the picker is reported as the mismatch it is. */
export const CONTROL_KINDS = Object.keys(
  { line: 1, depth: 1, seg: 1, change: 1 } satisfies Record<ControlKind, 1>,
) as ControlKind[];

export interface ProviderMeta {
  /** stable, stored on the render record — renaming one orphans every row that
   *  says it drew the image, so these strings are as good as a schema */
  id: string;
  label: string;
  /** null = the vendor publishes no price. Not "free": unknown. */
  usdPerMegapixel: number | null;
  flatUsdPerImage?: number | null;
  /** empty = the model has no control channel at all and any map we send can
   *  only ride along as another semantic reference image */
  acceptsControls: ControlKind[];
  maxOutputPixels: number;
  dimStep: number;
  minDim: number;
  needsEnv: string;
  /** fal bills FLUX.1 [dev] "by rounding up to the nearest megapixel", so 1.05 MP
   *  costs what 2 MP costs. The ceiling maths has to round the same way or it
   *  approves a render that arrives at twice the quoted price. */
  billsWholeMegapixels?: boolean;
  /** Dollars per unit of whatever the vendor quotes back at submit. BFL quotes
   *  credits at 1 credit = $0.01; fal quotes nothing, so this is absent and its
   *  quote can never be compared with anything. Without a unit a quote is a bare
   *  number, and comparing a bare number to a dollar ceiling is how you get an
   *  alarm on every render or on none of them. */
  quoteUsdPerUnit?: number;
  /** one line for the picker — what this provider is actually for */
  note: string;
}

/** What to say when `needsEnv` is not set on the server, phrased for whoever has
 *  to fix it: the variable by name and where the key comes from.
 *
 *  One sentence per vendor, here, because there were four. Both routes composed
 *  their own from the metadata — a variable name and nothing actionable — while
 *  the sentences that said where to get a key sat in the server-only vendor files
 *  with no accessor on the Provider interface, so the person who saw the message
 *  never saw the useful half. The vendor's dashboard URL is not a secret. */
const KEY_SOURCE: Record<string, string> = {
  FLUX_API_KEY: 'Create one at dashboard.bfl.ai and add it to .env as FLUX_API_KEY.',
  FAL_KEY: 'Create one at fal.ai/dashboard/keys and add it to .env as FAL_KEY.',
};

export function missingEnvMessage(p: ProviderMeta): string {
  const how = KEY_SOURCE[p.needsEnv] ?? `Set ${p.needsEnv} in the environment.`;
  return `${p.needsEnv} is not set on the server, so nothing can be rendered with ${p.label}. ${how}`;
}

/** THE SPENDING CEILING. The product owner set it: no single image may cost more
 *  than this. It is enforced in `assertAffordable`, not merely documented here. */
export const MAX_USD_PER_IMAGE = 0.10;

/* Comparing money in floats: 2 MP × $0.05 is $0.1 to the last bit today and one
   refactor away from being $0.10000000000000002, which would refuse a render
   that costs exactly the ceiling. */
const EPS = 1e-9;

/* Every provider here takes an explicit width and height, and 16 is the coarsest
   step any of them insists on (BFL's), so one step fits all — which is what lets
   `outputDims()` in src/state/renders.ts stay a single calculation instead of
   one per provider. */
const DIM_STEP = 16;
const MIN_DIM = 64;

export const PROVIDER_META: ProviderMeta[] = [
  {
    id: 'flux2-max',
    label: 'FLUX.2 [max]',
    /* bfl.ai's published rate for [max]; the live pricing page has moved to a
       calculator and no longer restates the per-megapixel figure, so this is the
       2026-08-18 research sweep's number and not a URL you can re-read today. */
    usdPerMegapixel: 0.07,
    /* FLUX.2 has no ControlNet input at all — docs.bfl.ai: "Instead of dedicated
       ControlNet inputs, FLUX.2 uses its multi-reference editing system… FLUX.2
       interprets structure semantically." Maps we hand it go in the spare
       input_image_N slots and are read as pictures, not as geometry. */
    acceptsControls: [],
    maxOutputPixels: 4_000_000,
    dimStep: DIM_STEP,
    minDim: MIN_DIM,
    needsEnv: 'FLUX_API_KEY',
    /* BFL answers `cost` in credits and their docs put a credit at $0.01. Enough
       to compare a quote with the ceiling; transcribed, not observed, so the
       comparison logs rather than refuses. */
    quoteUsdPerUnit: 0.01,
    note: 'What ships today. Best prompt adherence, no control map, priciest per megapixel.',
  },
  {
    id: 'flux2-flex',
    label: 'FLUX.2 [flex]',
    usdPerMegapixel: 0.05,
    acceptsControls: [],
    maxOutputPixels: 4_000_000,
    dimStep: DIM_STEP,
    minDim: MIN_DIM,
    needsEnv: 'FLUX_API_KEY',
    /* BFL answers `cost` in credits and their docs put a credit at $0.01. Enough
       to compare a quote with the ceiling; transcribed, not observed, so the
       comparison logs rather than refuses. */
    quoteUsdPerUnit: 0.01,
    note: 'Same family, cheaper, and the only BFL model that exposes guidance and step count.',
  },
  {
    id: 'z-image-cn',
    label: 'Z-Image Turbo ControlNet',
    /* fal.ai/models/fal-ai/z-image/turbo/controlnet: "Your request will cost
       $0.0065 per megapixel." Eleven of these fit in the price of one [max]
       render, which is the whole reason it is the rig the harness sweeps on. */
    usdPerMegapixel: 0.0065,
    acceptsControls: ['line', 'depth', 'seg'],
    maxOutputPixels: 4_000_000,
    dimStep: DIM_STEP,
    minDim: MIN_DIM,
    needsEnv: 'FAL_KEY',
    note: 'A real control channel with a strength dial, for about a penny a sweep.',
  },
  {
    id: 'flux-general-cn',
    label: 'FLUX.1 [dev] + ControlNet',
    /* fal.ai/models/fal-ai/flux-general/image-to-image: "Your request will cost
       $0.075 per megapixel. Images are billed by rounding up to the nearest
       megapixel." At that rounding a single megapixel is the only size that fits
       under the ceiling — 1024×1024 is 1.05 MP and bills as two. */
    usdPerMegapixel: 0.075,
    billsWholeMegapixels: true,
    /* Only the two kinds that have a published FLUX.1-dev ControlNet behind them.
       There is no segmentation ControlNet for this base model that we could name
       a real repo for, and inventing a `path` would fail at fal with a message
       about weights rather than about us.

       Two kinds accepted, one map sent: fal's API reference says `controlnets`
       "supports one controlnet currently", so the body in `fal.ts` takes the
       caller's first usable kind and drops the rest. This list is what the picker
       may offer, never a promise that both go in the same call. */
    acceptsControls: ['line', 'depth'],
    maxOutputPixels: 4_000_000,
    dimStep: DIM_STEP,
    minDim: MIN_DIM,
    needsEnv: 'FAL_KEY',
    note: 'The only one here with a genuine ControlNet and a negative prompt. Rounds up to whole megapixels.',
  },
  {
    id: 'qwen-edit',
    label: 'Qwen Image Edit Plus',
    /* fal.ai/models/fal-ai/qwen-image-edit-plus: "Your request will cost $0.03
       per megapixel." The research sweep put this at $0.02–0.03 with sources
       disagreeing; the model page is the source that can be re-read, it says the
       higher figure, and the pessimistic read is the one a ceiling is allowed to
       trust. */
    usdPerMegapixel: 0.03,
    /* Multi-image editing, not control: extra maps arrive as more reference
       pictures in image_urls, the same deal FLUX.2 offers. */
    acceptsControls: [],
    maxOutputPixels: 4_000_000,
    dimStep: DIM_STEP,
    minDim: MIN_DIM,
    needsEnv: 'FAL_KEY',
    note: 'Apache-2.0 weights, takes up to three reference images at once.',
  },
];

export const DEFAULT_PROVIDER = 'flux2-max';

export function metaOf(id: string | null | undefined): ProviderMeta {
  return PROVIDER_META.find((p) => p.id === id)
    ?? PROVIDER_META.find((p) => p.id === DEFAULT_PROVIDER)!;
}

/** What a record says drew it. Used to be the constant `MODEL_LABEL` in
 *  `src/state/renders.ts`, back when there was one model and a hardcoded string
 *  could not be wrong; with five providers a record that names the wrong one is a
 *  record you cannot reproduce from — and the filmstrip shows this string, so a
 *  Z-Image render labelled FLUX.2 would send someone hunting the wrong dial. The
 *  provider id itself lives on `settings.provider`, which is what re-running
 *  reads.
 *
 *  Here rather than in the store because both record paths need it and they must
 *  agree: locally `src/shell/jobs.ts` writes the label, while in the account the
 *  render route writes the provider ID to `renders.model` (it is the only string
 *  that can poll the job again) and `src/data/cloudRenders.ts` resolves it on the
 *  way back out. Two spellings of this rule is how the same render comes to be
 *  labelled `flux2-max` in one tab and `FLUX.2 [max]` in another. `metaOf`'s
 *  fallback also fixes the rows written before any of this: they say
 *  `flux-2-max`, which is not an id, and flux2-max is what drew them. */
export function modelLabelOf(provider: string | null | undefined): string {
  return metaOf(provider).label;
}

/** Megapixels the vendor will actually charge for, which is not always the
 *  megapixels drawn — see `billsWholeMegapixels`. */
export function billedMegapixels(p: ProviderMeta, width: number, height: number): number {
  const mp = (width * height) / 1e6;
  /* Nobody sells less than one whole megapixel when they round up, including a
     640×640 thumbnail. */
  return p.billsWholeMegapixels ? Math.max(1, Math.ceil(mp)) : mp;
}

/** What one image at this size costs, in dollars, or null when the vendor
 *  publishes no price. Null is the answer that gets a render refused. */
export function estimateUsd(p: ProviderMeta, width: number, height: number): number | null {
  const flat = p.flatUsdPerImage ?? null;
  if (p.usdPerMegapixel === null) return flat;
  return (flat ?? 0) + billedMegapixels(p, width, height) * p.usdPerMegapixel;
}

/** The vendor's own quote in dollars, or null when its unit is unknown — which
 *  is not the same as free, and must not be read as agreement with our estimate. */
export function quotedUsdOf(p: ProviderMeta, quote: number | null | undefined): number | null {
  if (quote === null || quote === undefined || !Number.isFinite(quote)) return null;
  return p.quoteUsdPerUnit === undefined ? null : quote * p.quoteUsdPerUnit;
}

/** Did the vendor just charge us more than the ceiling allows? Answerable only
 *  after the money is gone, so it cannot refuse anything — but a render that
 *  cost more than a dime has to be visible the first time it happens rather than
 *  found later in a bill, because it means `estimateUsd` is pricing the wrong
 *  thing (input megapixels, a surcharge, a plan rate) and every ceiling check
 *  since has been theatre. */
export function overCeiling(quotedUsd: number | null | undefined): boolean {
  return typeof quotedUsd === 'number' && quotedUsd > MAX_USD_PER_IMAGE + EPS;
}

/** The largest output, in pixels, this provider can produce inside the ceiling.
 *  Zero means it cannot draw anything we are allowed to pay for — which is also
 *  the honest answer for a provider that will not say what it charges. */
export function maxAffordablePixels(p: ProviderMeta): number {
  const flat = p.flatUsdPerImage ?? null;
  const budget = MAX_USD_PER_IMAGE - (flat ?? 0);
  if (budget < -EPS) return 0;

  if (p.usdPerMegapixel === null) return flat === null ? 0 : p.maxOutputPixels;
  if (p.usdPerMegapixel <= 0) return p.maxOutputPixels;

  /* When the vendor rounds up to whole megapixels, only whole megapixels are
     buyable: at $0.075/MP the budget stretches to 1.33 MP and every pixel past
     the first million is billed as a second one. */
  const mp = p.billsWholeMegapixels
    ? Math.floor((budget + EPS) / p.usdPerMegapixel)
    : (budget + EPS) / p.usdPerMegapixel;
  return Math.min(p.maxOutputPixels, Math.floor(mp * 1e6));
}

/** The biggest width×height at this aspect ratio that stays under the ceiling,
 *  snapped down to the provider's step. Exists so the refusal can name a size
 *  the caller can actually retry with instead of just saying no. */
export function affordableDims(
  p: ProviderMeta, width: number, height: number,
): { width: number; height: number } | null {
  const budget = maxAffordablePixels(p);
  if (budget <= 0 || width <= 0 || height <= 0) return null;
  const scale = Math.sqrt(budget / (width * height));
  const snap = (v: number) => Math.max(p.minDim, Math.floor((v * scale) / p.dimStep) * p.dimStep);
  const w = snap(width), h = snap(height);
  /* Snapping down twice can still land a hair over when both sides round to the
     same step; one more step off the longer side is cheaper than a wrong quote. */
  if (w * h > budget) return w >= h ? { width: Math.max(p.minDim, w - p.dimStep), height: h }
    : { width: w, height: Math.max(p.minDim, h - p.dimStep) };
  return { width: w, height: h };
}
