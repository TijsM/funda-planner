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

/** What an object photograph is encoded as, everywhere.
 *
 *  Here, in the file both halves of the server boundary already import, because
 *  three places need to agree on it and none of them may import the others: the
 *  browser encodes the JPEG (`src/shell/photos.ts`), the route sniffs the bytes
 *  to prove they are one (`app/api/render/route.ts`), and fal has to declare it
 *  in a data: URI (`src/server/providers/fal.ts`). A mime that disagrees across
 *  those three is a 422 nobody can read. */
export const PHOTO_MIME = 'image/jpeg';

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
  /** This provider's own ceiling per image, when the global one is the wrong
   *  number for it. Absent means `MAX_USD_PER_IMAGE`, which is what every
   *  provider that sells output megapixels is held to.
   *
   *  It exists for the one model here that bills for its INPUT. A ceiling is a
   *  promise about what one press of Generate may cost, and $0.10 was set when
   *  every provider on the list priced the picture it drew. A model that charges
   *  for the plan, and again for each photograph attached to it, cannot be
   *  compared with those on the same number — so it carries its own, stated in
   *  the picker beside its price rather than hidden in a constant. */
  maxUsdPerImage?: number;
  /** empty = the model has no control channel at all and any map we send can
   *  only ride along as another semantic reference image */
  acceptsControls: ControlKind[];
  /** How many reference images this model takes IN TOTAL, the plan included.
   *
   *  1 means there is exactly one slot and the plan is in it — nothing else can
   *  be sent, so object photographs cannot reach that provider at all and the
   *  panel says so rather than dropping them quietly.
   *
   *  It is a total rather than a count of spare slots because that is how the
   *  vendors document it, and because the arithmetic that matters — what is left
   *  after the plan and any semantic control maps — belongs in one place
   *  (`attachedPhotos`) rather than in each of these numbers. */
  maxReferences: number;
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
  OPENAI_API_KEY: 'Create one at platform.openai.com/api-keys and add it to .env as OPENAI_API_KEY.',
  GEMINI_API_KEY: 'Create one at aistudio.google.com/apikey and add it to .env as GEMINI_API_KEY.',
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
    /* `input_image` plus `input_image_2 … _8` — api.bfl.ai/openapi.json, and the
       reason object photographs are possible at all. Seven of these eight slots
       were unused until photos landed. */
    maxReferences: 8,
    maxOutputPixels: 4_000_000,
    dimStep: DIM_STEP,
    minDim: MIN_DIM,
    needsEnv: 'FLUX_API_KEY',
    /* BFL answers `cost` in credits and their docs put a credit at $0.01. Enough
       to compare a quote with the ceiling; transcribed, not observed, so the
       comparison logs rather than refuses. */
    quoteUsdPerUnit: 0.01,
    note: 'What ships today. Best prompt adherence, eight reference slots, no control map, priciest per megapixel.',
  },
  {
    id: 'flux2-flex',
    label: 'FLUX.2 [flex]',
    usdPerMegapixel: 0.05,
    acceptsControls: [],
    /* same request schema as [max] upstream — see the note there */
    maxReferences: 8,
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
    /* One, and it is not spare: on this endpoint `image_url` IS the control
       image — there is no separate reference channel to put a photograph in. */
    maxReferences: 1,
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
    /* The reference goes in `image_url` and the map into `controlnets[0]`; there
       is no third image input on this endpoint. */
    maxReferences: 1,
    maxOutputPixels: 4_000_000,
    dimStep: DIM_STEP,
    minDim: MIN_DIM,
    needsEnv: 'FAL_KEY',
    note: 'The only one here with a genuine ControlNet and a negative prompt. Rounds up to whole megapixels.',
  },
  {
    id: 'qwen-edit',
    label: 'Qwen Image Edit 2511',
    /* fal.ai/models/fal-ai/qwen-image-edit-2511: "Your request will cost $0.03
       per megapixel" — the same rate the retired -plus endpoint charged, read off
       the model page on 2026-09-03. The id stays 'qwen-edit' because it is stored
       on render rows; the endpoint moved to 2511 because that release targets
       image drift directly and carries the family's geometric-reasoning work,
       which is the one thing this app buys an edit model for. */
    usdPerMegapixel: 0.03,
    /* Multi-image editing, not control: extra maps arrive as more reference
       pictures in image_urls, the same deal FLUX.2 offers. */
    acceptsControls: [],
    /* Three is OUR cap, not fal's — the docs state no maximum for `image_urls`
       and only the worked example passes three. See `qwenBody` in
       src/server/providers/fal.ts for why it is capped at all. */
    maxReferences: 3,
    maxOutputPixels: 4_000_000,
    dimStep: DIM_STEP,
    minDim: MIN_DIM,
    needsEnv: 'FAL_KEY',
    note: 'Apache-2.0 weights with native geometry conditioning, takes up to three reference images at once.',
  },
  {
    id: 'gemini-flash-image',
    label: 'Gemini 3.1 Flash Image',
    /* Token-priced like OpenAI's models, so a flat pessimistic estimate is the
       only honest shape — see the mini's note below for how to read one of these.
       Rates from ai.google.dev/gemini-api/docs/pricing on 2026-09-03:
         output   a 2K image is 1680 output-image tokens at $60/1M → $0.101; a 1K
                  image is 1120 → $0.067. The adapter asks for 2K only when the
                  request wants more than a megapixel and a half, so $0.101 is the
                  dear case, not the every case.
         input    $0.50/1M for text and image alike. Eleven input images (the
                  plan and ten photographs) at Google's own per-image equivalence
                  (~560-1120 tokens each) → under $0.007.
         prompt   2000 tokens → $0.001.
                                                                    ------
                                                                    ≈$0.109
       Over the global dime by a cent at 2K, which is why it carries its own
       ceiling — the same licence GPT Image 2 has, at a third of a dime instead
       of three and a half. */
    usdPerMegapixel: null,
    flatUsdPerImage: 0.11,
    maxUsdPerImage: 0.12,
    /* No control channel in the Interactions API — a map can only ride along as
       another named reference picture, the same deal FLUX.2 offers. */
    acceptsControls: [],
    /* Google documents up to 14 reference images with a cap of 10 OBJECT
       references on this model, and an object photograph is what this app
       attaches. The plan takes one slot, so ten photographs fit — the widest
       photo budget of any provider here. */
    maxReferences: 11,
    /* '2K' output: 2048 on the long side, so about 4 MP at 1:1 and less at any
       other ratio. The adapter maps whatever is asked for onto Google's fixed
       menu of aspect ratios and the 1K/2K sizes. */
    maxOutputPixels: 4_000_000,
    dimStep: DIM_STEP,
    minDim: MIN_DIM,
    needsEnv: 'GEMINI_API_KEY',
    note: 'The 2026 editing-arena leader ("Nano Banana 2") and the widest photo budget here: ten'
      + ' object photographs. Reads the plan at full fidelity. No seed, fixed aspect-ratio menu.',
  },
  {
    id: 'gemini-pro-image',
    label: 'Gemini 3 Pro Image',
    /* Same shape as the flash model above, at the premium rates. Pricing page,
       2026-09-03: a 1K/2K image is $0.134 flat (1120 output tokens at $120/1M);
       input is $2.00/1M — Google's own equivalence is "$0.0011 per image" — so
       the plan plus six photographs is under $0.01, and a 2000-token prompt is
       $0.004. Worst case ≈ $0.148; 4K exists upstream ($0.24) and is not asked
       for, because no ceiling here can carry it. */
    usdPerMegapixel: null,
    flatUsdPerImage: 0.15,
    maxUsdPerImage: 0.16,
    acceptsControls: [],
    /* The Pro model's documented object-reference cap is 6, not 10 — the premium
       tier trades reference breadth for editing fidelity. Plan plus six. */
    maxReferences: 7,
    maxOutputPixels: 4_000_000,
    dimStep: DIM_STEP,
    minDim: MIN_DIM,
    needsEnv: 'GEMINI_API_KEY',
    note: 'The strongest structure-preserving editor measured in 2026 ("Nano Banana Pro"), for the'
      + ' render that has to be right. Dearer than the flash model; takes six photographs. No seed.',
  },
  {
    id: 'openai-image-mini',
    label: 'GPT Image 1 Mini',
    /* THE ONLY PROVIDER HERE THAT DOES NOT SELL MEGAPIXELS. OpenAI prices images
       in tokens — text in, image in, image out, at three different rates — so
       there is no per-megapixel figure to put above and a flat price is the only
       honest shape. `null` and not `0`: nothing about this is free, and
       `estimateUsd` reads a null rate as "unpriced" and would refuse the render
       outright if the flat price were missing too.

       The flat figure is arithmetic, not a quote off a pricing page, so here is
       the arithmetic. Rates per 1M tokens, from developers.openai.com's pricing
       table on 2026-08-26: text in $2.00, image in $2.50, image out $8.00. Token
       counts from their image guide, for the worst case this provider can be
       handed:
         output   1584 tokens (medium quality, 1024×1536 — the priciest of the
                  three sizes the edits endpoint offers)          → $0.0127
         input    4 images × 7853 tokens. Their rule for a high-fidelity input is
                  "65 base, 129 per 512 px tile, plus 6240 for a non-square
                  image", and 7853 is that for a 1800×1200 reference, which is
                  REFERENCE_MAX_PX                                → $0.0785
         prompt   2000 tokens, i.e. all of MAX_PROMPT_CHARS       → $0.0040
                                                                    ------
                                                                    $0.0952

       That is a 5% margin under the ceiling on token counts nobody here has seen
       a bill for, which is thin and is meant to be read as thin. `receipt()` in
       src/server/providers/openai.ts logs what OpenAI actually metered on every
       render, itemised, so the first one that goes through replaces this estimate
       with a bill. */
    usdPerMegapixel: null,
    flatUsdPerImage: 0.095,
    /* No control channel of any kind in the images API, so a map can only ride
       along as another reference picture — the same deal FLUX.2 and Qwen offer,
       and at $2.50 per 1M input tokens it is a deal with a price on it. */
    acceptsControls: [],
    /* The edits endpoint's documented cap on input images, one of which is
       always the plan. Every one of them is billed, which is what makes this
       number a budget rather than a capability. */
    maxReferences: 4,
    /* 1536×1024, the largest of the three sizes `/v1/images/edits` documents.
       Not a rate limit but a hard menu: the endpoint takes 1024×1024, 1536×1024
       and 1024×1536 and nothing else, so `nearestSize` in the server half maps
       whatever aspect ratio the plan has onto the closest of the three. The step
       and minimum below are therefore only about what this app's own route will
       accept on the way in — they are not constraints OpenAI has. */
    maxOutputPixels: 1_572_864,
    dimStep: DIM_STEP,
    minDim: MIN_DIM,
    needsEnv: 'OPENAI_API_KEY',
    note: 'Cheapest way to test the OpenAI flow, and it reads the plan at low fidelity — it refuses the high-fidelity setting outright, so fine lines get downsampled before it sees them. Bills for input images too. No seed, three fixed output sizes.',
  },
  {
    id: 'openai-image-2',
    label: 'GPT Image 2',
    /* The same token pricing as the mini above and the same shape of estimate,
       at rates that make it the most expensive render this app can ask for.
       Per 1M tokens, from developers.openai.com's pricing table on 2026-08-26:
       text in $5.00, image in $8.00, image out $30.00. Worst case, same token
       counts as the mini's note:
         output   1584 tokens (medium quality, 1024×1536)         → $0.0475
         input    4 images × 7853 tokens                          → $0.2513
         prompt   2000 tokens                                     → $0.0100
                                                                    ------
                                                                    $0.3088

       The plan on its own — no photographs, no maps — is $0.120 of that, which
       is already over the global $0.10 ceiling. That is the whole reason
       `maxUsdPerImage` exists: this model cannot be held to a number that was
       set when every provider on the list billed for the picture it drew and
       nothing else. The ceiling below is the worst case rounded up, so a render
       is refused only if the estimate is wrong, never because a photograph was
       attached.

       WHY IT IS HERE AT ALL, given the mini is a third of the price: the mini
       rejects `input_fidelity: high` with a 400, so it reads our reference
       downsampled — and the reference is a thin black line drawing whose whole
       job is to say where the walls are. This model processes every input at
       high fidelity and cannot be asked to do otherwise. Fidelity of the plan is
       what we are paying the difference for. */
    usdPerMegapixel: null,
    flatUsdPerImage: 0.31,
    /* The number one press of Generate may cost on this provider, stated rather
       than inherited. Every photograph attached is another ~$0.06 of it, which
       is why the panel prints the figure next to the model. */
    maxUsdPerImage: 0.35,
    acceptsControls: [],
    maxReferences: 4,
    maxOutputPixels: 1_572_864,
    dimStep: DIM_STEP,
    minDim: MIN_DIM,
    needsEnv: 'OPENAI_API_KEY',
    note: 'Reads the plan at full fidelity, which is what the mini cannot do. The dearest render here by a wide margin: it bills for every input image, so each photograph you attach costs about six cents on top. No seed, three fixed output sizes.',
  },
];

/** The fallback for anything that predates the picker: every render row and every
 *  saved settings blob written before providers existed was drawn by FLUX.2 [max],
 *  so an absent id resolves to it — see `providerOf` and the status route. This is
 *  a fact about history, not a recommendation; do not change it when the default
 *  choice moves. */
export const DEFAULT_PROVIDER = 'flux2-max';

/** What a fresh panel starts on — separate from the history fallback above on
 *  purpose. The 2026-09 research sweep put Gemini's flash image model top of the
 *  editing arenas for exactly this job (keep the input's geometry, retexture it),
 *  with the widest photo budget on the list and a cheaper worst case than the
 *  model it displaces. Existing saved settings keep whatever they say. */
export const DEFAULT_PICK = 'gemini-flash-image';

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
export function overCeiling(quotedUsd: number | null | undefined, p?: ProviderMeta): boolean {
  return typeof quotedUsd === 'number' && quotedUsd > ceilingUsd(p) + EPS;
}

/** What one image on this provider is allowed to cost. The global ceiling unless
 *  the provider states its own — see `ProviderMeta.maxUsdPerImage`. */
export function ceilingUsd(p?: ProviderMeta | null): number {
  return p?.maxUsdPerImage ?? MAX_USD_PER_IMAGE;
}

/** The largest output, in pixels, this provider can produce inside the ceiling.
 *  Zero means it cannot draw anything we are allowed to pay for — which is also
 *  the honest answer for a provider that will not say what it charges. */
export function maxAffordablePixels(p: ProviderMeta): number {
  const flat = p.flatUsdPerImage ?? null;
  const budget = ceilingUsd(p) - (flat ?? 0);
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
