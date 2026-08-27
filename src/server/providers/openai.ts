import 'server-only';

import { PHOTO_MIME, metaOf, missingEnvMessage, type ProviderMeta } from '@data/providers';
import {
  ProviderError, assertAffordable, controlLegend, estimateUsd, num, obj, refLegend,
  spareSlots, str, transportFailure, underHost, usableRefs,
  type GenerateArgs, type PollResult, type Provider, type SubmitResult,
} from './types';

/** OpenAI's image models, behind the same Provider contract as BFL and fal.
 *
 *  Verified against developers.openai.com/api/docs (the guide, the pricing table
 *  and the /v1/images/edits reference) on 2026-08-26. Two things make this the
 *  odd one out on this list, and both of them shape everything below.
 *
 *  IT IS SYNCHRONOUS. There is no queue and no job id: `POST /v1/images/edits`
 *  blocks for the length of the render and answers with the finished PNG as
 *  base64. The docs describe background mode for the Responses API only, and say
 *  nothing about the image tools running in it, so there is no async path here to
 *  use. The Provider contract is submit-then-poll, so this file bridges the two
 *  by holding the in-flight request IN THIS PROCESS (see `HELD`) and answering
 *  polls from it. That is a real limitation, not a detail: a server restart or a
 *  second instance between the submit and the poll loses a render that has
 *  already been paid for. It is fine for `next dev` and for one long-running
 *  server, and it is why `poll` says so by name when the job is not here.
 *
 *  IT BILLS FOR THE INPUT. Every other provider on this list prices output
 *  megapixels and nothing else; OpenAI prices tokens, and an input image is
 *  thousands of them. Their own arithmetic for a high-fidelity input is "65
 *  image tokens base, 129 per 512 px tile, plus 4160 for a square image or 6240
 *  for anything closer to portrait or landscape" — so the plan alone, at
 *  REFERENCE_MAX_PX, is about 7800 tokens before a single pixel is drawn. That
 *  figure, not the output size, is what decides which model can be offered under
 *  a $0.10 ceiling at all: see the note on the price in `src/data/providers.ts`.
 *
 *  SUBMIT
 *    POST https://api.openai.com/v1/images/edits
 *    headers  Authorization: Bearer <OPENAI_API_KEY>
 *    body     multipart/form-data, `image[]` once per input image
 *    → 200 { data: [{ b64_json }], size, quality, output_format, usage }
 *
 *  There is no polling and no delivery host, so the finished image never has a
 *  URL. `poll` hands it back as a `data:` URI and `fetchDelivery` decodes that
 *  without touching the network — the status route's download path then works
 *  unchanged, which is the whole reason for the shape.
 *
 *  NOT RUN AGAINST A LIVE RENDER. The key in this deployment authenticates and
 *  the account behind it has no credits: every call answers HTTP 429
 *  `insufficient_quota` / `credit_balance_exhausted`. That is worth reading
 *  twice, because 429 is the status a rate limit arrives on and the obvious
 *  mapping — retry, it will clear — would have the client poll for three minutes
 *  on an account that will never answer. `httpFailure` tells the two apart by
 *  code, which is the one path here that has been exercised for real.
 */

/* ── the wire ────────────────────────────────────────────────────── */

const EDITS = 'https://api.openai.com/v1/images/edits';

/** Read per call, never at module scope — CI runs `pnpm build` with no secrets,
 *  and a module-level assertion turns a missing var into a red build. */
function openaiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new ProviderError(500, missingEnvMessage(metaOf('openai-image-mini')), false);
  return key;
}

/** Every OpenAI address this file will touch. `underHost` and not
 *  `endsWith('openai.com')`: the latter also matches `evilopenai.com`, which is
 *  a domain anybody can buy. */
export function openaiKeyedUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!underHost(u.hostname, 'api.openai.com')) return null;
  return u;
}

/** The finished image, which has no delivery host at all — the bytes came back
 *  in the submit response, so what `poll` reports is a `data:` URI and this is
 *  the guard for it.
 *
 *  Deliberately strict about the whole string rather than just the prefix: this
 *  value reaches `fetchDelivery`, which decodes it, and "starts with data:image"
 *  would also accept an SVG carrying script or a payload with a second header
 *  spliced into it. PNG and base64 or nothing. */
const PNG_DATA = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

export function openaiDeliveryUrl(raw: string): URL | null {
  if (!PNG_DATA.test(raw)) return null;
  try { return new URL(raw); } catch { return null; }
}

/** Hands back the bytes `poll` already had, shaped as the Response the status
 *  route's download path expects. No fetch happens: there is nothing to fetch,
 *  and routing a multi-megabyte `data:` URI through undici to get a buffer we
 *  are already holding would be a network stack's worth of ways to fail at a
 *  step that cannot fail. */
export async function openaiFetchDelivery(src: URL): Promise<Response> {
  const raw = src.toString();
  if (!PNG_DATA.test(raw)) {
    throw new ProviderError(502, 'The finished render is not a PNG data URI. Refusing to decode it.', false);
  }
  const bytes = Buffer.from(raw.slice(raw.indexOf(',') + 1), 'base64');
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) },
  });
}

/* ── the output size ─────────────────────────────────────────────── */

/** The only sizes `/v1/images/edits` documents as an enum: `auto`, `1024x1024`,
 *  `1536x1024`, `1024x1536`.
 *
 *  The image-generation guide describes a far wider range for gpt-image-2 — any
 *  pair of 16-px multiples up to 3840 a side — and the two pages disagree. The
 *  narrow read is the one taken here, because of which way each mistake fails:
 *  asking for a size the endpoint does not take is a 400 after the request has
 *  been built, while asking for one it does take is never wrong. `auto` is not
 *  used either, because a size we did not choose is a price we did not check.
 *
 *  Consequence, stated because it is a real one: the app asks for a size derived
 *  from the plan's own aspect ratio (`outputDims`) and this provider answers with
 *  the nearest of three. The status route already reads the delivered PNG's own
 *  dimensions back out of its IHDR and records those, so the stored render
 *  describes the file rather than the request. */
const SIZES: readonly { width: number; height: number }[] = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];

/** The offered size whose aspect ratio is closest to the one asked for, compared
 *  in log space so 3:2 and 2:3 are the same distance from square. */
export function nearestSize(width: number, height: number): { width: number; height: number } {
  const want = Math.log(Math.max(1, width) / Math.max(1, height));
  let best = SIZES[0];
  let bestGap = Infinity;
  for (const size of SIZES) {
    const gap = Math.abs(Math.log(size.width / size.height) - want);
    if (gap < bestGap) { bestGap = gap; best = size; }
  }
  return { width: best.width, height: best.height };
}

/* ── what the request says ───────────────────────────────────────── */

/** Medium, and not by default. `quality` moves the output token count by a
 *  factor of sixteen — on gpt-image-2 it is 160 tokens at low and 2560 at high
 *  for a square image — so it is the single biggest lever on what a render
 *  costs, and leaving it at `auto` would let the vendor choose the bill. Low is
 *  visibly worse at the one thing this product wants, which is a photorealistic
 *  interior; high does not fit under the ceiling once the input images are
 *  counted. */
const QUALITY = 'medium';

/** Which models accept `input_fidelity`, which is to say: none of them, and the
 *  field is not sent.
 *
 *  It was sent as `high` on every request, on the reasoning that the plan is a
 *  thin black line drawing and a model reading a downsampled copy of it puts the
 *  walls somewhere else. That reasoning still holds; the field does not. The API
 *  answered a real request with
 *
 *      input_fidelity high is not supported for gpt-image-1-mini
 *
 *  — a 400 before a pixel is drawn, so the mini model reads our reference at its
 *  own default detail and there is no way to pay for more. gpt-image-2 needs no
 *  such request: the guide says it processes every input at high fidelity and
 *  does not allow the field to be changed, so sending it there would be, at
 *  best, redundant and at worst the same 400.
 *
 *  That difference is not a detail of this file, it is why both models are in
 *  the picker: the cheap one cannot be told to look closely, and looking closely
 *  at the plan is what the reference is for. */
const SENDS_INPUT_FIDELITY: readonly string[] = [];

/** OpenAI's per-1M-token rates, from the pricing table on 2026-08-26, kept next
 *  to the model they price so the receipt below can be computed rather than
 *  guessed. Only the mini model is offered today; gpt-image-2's rates are here
 *  because the reason it is NOT offered is arithmetic, and arithmetic with the
 *  numbers hidden is an opinion. */
interface Rates { textIn: number; imageIn: number; imageOut: number }
const RATES: Record<string, Rates> = {
  'gpt-image-1-mini': { textIn: 2.00, imageIn: 2.50, imageOut: 8.00 },
  'gpt-image-2': { textIn: 5.00, imageIn: 8.00, imageOut: 30.00 },
};

/** What OpenAI actually metered, in dollars — the only real receipt any provider
 *  on this list produces.
 *
 *  BFL quotes credits at submit and fal quotes nothing, so until now the "did
 *  this cost what we said it would" check had almost nothing to check. This one
 *  is exact and itemised, which matters because the flat price in
 *  `src/data/providers.ts` is a pessimistic estimate built from published token
 *  arithmetic and has never been compared with a bill. The first successful
 *  render replaces that estimate with evidence; this is what logs it. */
function receipt(model: string, usage: unknown): { usd: number | null; line: string } {
  const u = obj(usage);
  const rate = RATES[model];
  if (!u || !rate) return { usd: null, line: 'not metered' };
  const details = obj(u.input_tokens_details);
  const textIn = num(details?.text_tokens) ?? 0;
  const imageIn = num(details?.image_tokens) ?? 0;
  const out = num(u.output_tokens) ?? 0;
  const usd = (textIn * rate.textIn + imageIn * rate.imageIn + out * rate.imageOut) / 1e6;
  return {
    usd,
    line: `$${usd.toFixed(4)} (textIn=${textIn} imageIn=${imageIn} out=${out})`,
  };
}

/** The multipart body. One `image[]` part per input image, the plan always
 *  first, because every legend and every brief this app writes numbers the plan
 *  as image 1.
 *
 *  Photographs before conditioning maps, the same order and for the same reason
 *  as `references()` in bfl.ts and `qwenBody` in fal.ts: a photo of the actual
 *  sofa is what the render is for, and a map handed to a model with no control
 *  channel is an experiment. */
export function editForm(meta: ProviderMeta, model: string, args: GenerateArgs): FormData {
  const size = nearestSize(args.width, args.height);
  const photos = usableRefs(meta, args.refs);
  const extra = (args.controls ?? []).slice(0, Math.max(0, spareSlots(meta) - photos.length));
  const legend = [refLegend(photos, 2, args.prompt), controlLegend(extra, args.prompt)]
    .filter(Boolean).join(' ');

  const form = new FormData();
  form.set('model', model);
  form.set('prompt', legend ? `${args.prompt} ${legend}` : args.prompt);
  form.set('size', `${size.width}x${size.height}`);
  form.set('quality', QUALITY);
  /* Empty today; see `SENDS_INPUT_FIDELITY` for why the field is not sent at
     all, and why that is a fact about the models rather than a preference. */
  if (SENDS_INPUT_FIDELITY.includes(model)) form.set('input_fidelity', 'high');
  /* PNG because the render bucket accepts nothing else, and because a JPEG of a
     freshly generated interior is a second lossy pass over an image nobody has
     looked at yet. */
  form.set('output_format', 'png');
  /* An interior render is not a cutout. Left at `auto` the model is free to
     answer with a transparent background, which in a filmstrip of rooms reads as
     a broken thumbnail. */
  form.set('background', 'opaque');
  /* Pinned for the same reason as fal's `num_images`: the ceiling weighs ONE
     image, and a default that moved under us would multiply the bill against a
     guard that had already approved it. */
  form.set('n', '1');
  /* No seed field exists on this endpoint — see the note in `openaiSubmit`. */

  form.append('image[]', new Blob([Buffer.from(args.imageBase64, 'base64')], { type: 'image/png' }), 'plan.png');
  for (const photo of photos) {
    form.append('image[]', new Blob([Buffer.from(photo.base64, 'base64')], { type: PHOTO_MIME }), `${photo.id}.jpg`);
  }
  for (const control of extra) {
    form.append('image[]', new Blob([Buffer.from(control.base64, 'base64')], { type: 'image/png' }), `${control.kind}.png`);
  }
  return form;
}

/* ── reading a refusal ───────────────────────────────────────────── */

/** OpenAI answers every failure as `{ error: { message, type, code, param } }`,
 *  which is neither BFL's `detail` nor fal's, so it gets its own reader. */
function errorOf(payload: unknown): { message: string | null; code: string | null } {
  const e = obj(obj(payload)?.error);
  if (!e) return { message: null, code: null };
  return { message: str(e.message), code: str(e.code) ?? str(e.type) };
}

/** The one thing about this integration that has been tested against the live
 *  API: an account with no credits answers HTTP 429 with code
 *  `credit_balance_exhausted`, and a 429 mapped the obvious way — rate limited,
 *  try again — makes the client poll for its full three minutes and then report
 *  a timeout, for a request that was refused in two seconds and will be refused
 *  for as long as the balance is zero. The code is what separates the two. */
async function httpFailure(res: Response, payload: unknown): Promise<ProviderError> {
  const { message, code } = errorOf(payload);
  const said = message ? ` OpenAI said: ${message}` : '';
  const outOfCredit = code !== null && /quota|credit|billing/i.test(code);

  switch (res.status) {
    case 400:
      /* A rejected body and a blocked prompt both land here, and both are ours to
         fix rather than to retry, so the vendor's own sentence goes through. */
      return new ProviderError(400, message
        ?? 'OpenAI rejected the request as malformed but named no field.', false);
    case 401:
      return new ProviderError(502, 'OpenAI rejected the API key. OPENAI_API_KEY on the server is wrong or expired — replace it with a key from platform.openai.com/api-keys.', false);
    case 403:
      return new ProviderError(502, `OpenAI refused the request. The key has no access to this model, or the organisation is not verified for image generation.${said}`, false);
    case 404:
      /* The model name is the likely cause and it is a deployment's problem, not
         a person's — naming it saves reading a stack trace. */
      return new ProviderError(502, `OpenAI has no such model or endpoint.${said}`, false);
    case 429:
      return outOfCredit
        ? new ProviderError(402, `Out of credit at OpenAI, so nothing can be rendered on it. Add credits at platform.openai.com/settings/organization/billing.${said}`, false)
        : new ProviderError(429, 'OpenAI is rate-limiting this key. Try again in a moment.', true);
    case 500:
    case 502:
    case 503:
    case 504:
      return new ProviderError(503, `OpenAI is failing on its side (HTTP ${res.status}). Try again in a moment.`, true);
    default:
      return new ProviderError(502, `OpenAI answered an unexpected HTTP ${res.status}.${said}`, false);
  }
}

/* ── the render held between submit and poll ─────────────────────── */

/** One synchronous render, in flight or finished, waiting for the poll that
 *  collects it.
 *
 *  This is the bridge described at the top of the file, and every field on it is
 *  about surviving the gap rather than about the render. `settled` is what makes
 *  a poll cheap: the request is started once and never awaited by a poll, so a
 *  poll answers "pending" in microseconds instead of holding an HTTP connection
 *  open for the length of a render. */
interface Held {
  at: number;
  settled: PollResult | null;
}

const HELD = new Map<string, Held>();

/* Long enough to cover the client's own three-minute budget with room for a
   render that finishes just as it gives up, short enough that a few megabytes of
   PNG do not sit in memory for the life of the process. */
const HELD_TTL_MS = 300_000;

/* A bound on how much this map can ever hold, because every entry is a finished
   PNG as base64 and nothing outside this file deletes them. MAX_INFLIGHT in the
   client is 1, so anything past a handful is a leak rather than a queue. */
const HELD_MAX = 8;

function sweep(): void {
  const cutoff = Date.now() - HELD_TTL_MS;
  for (const [id, held] of HELD) if (held.at < cutoff) HELD.delete(id);
  /* Oldest first, which is Map insertion order — a cap that dropped the newest
     would throw away the render somebody is currently waiting for. */
  while (HELD.size > HELD_MAX) {
    const oldest = HELD.keys().next().value;
    if (oldest === undefined) break;
    HELD.delete(oldest);
  }
}

/** The handle a poll comes back with.
 *
 *  It has to be an https URL on the vendor's own host, because that is what the
 *  routes check before polling and what `keyedUrl` is for — so it is minted on
 *  api.openai.com even though it is NEVER FETCHED. There is nothing upstream to
 *  fetch: the render is finished or in flight in this process, and this string
 *  is only how a later request names it. */
const heldUrl = (id: string): string => `${EDITS}?held=${encodeURIComponent(id)}`;

const gone = (error: string, retryable = false): PollResult => ({ status: 'failed', error, retryable });

/* ── submit and poll ─────────────────────────────────────────────── */

async function openaiSubmit(meta: ProviderMeta, model: string, args: GenerateArgs): Promise<SubmitResult> {
  assertAffordable(meta, args.width, args.height);
  const key = openaiKey();
  const form = editForm(meta, model, args);

  /* Not a vendor's id: there is no submit response to read one from until the
     render has finished, and the whole point of this handle is to exist before
     that. Random and namespaced so it cannot be confused with a BFL or fal job
     id in a log line. */
  const id = `openai-${crypto.randomUUID()}`;
  const held: Held = { at: Date.now(), settled: null };
  sweep();
  HELD.set(id, held);

  const size = nearestSize(args.width, args.height);
  if (args.seed !== null) {
    /* Said once, at submit, rather than swallowed: the panel has a seed lock and
       a re-roll button, and on this provider both do nothing — `/v1/images/edits`
       documents no seed parameter, so two runs of the same plan are two different
       images and there is no way to ask for the first one again. */
    console.log(`[render] ${id} ${meta.id} ignores seed=${args.seed} — OpenAI's images endpoint has no seed parameter.`);
  }
  if (size.width !== args.width || size.height !== args.height) {
    console.log(`[render] ${id} ${meta.id} asked for ${args.width}×${args.height}, drawing ${size.width}×${size.height} — the endpoint offers three sizes.`);
  }

  /* Started and deliberately NOT awaited. The request blocks for the length of
     the render, and awaiting it here would hold the browser's submit open for a
     minute — which is not what any other provider does and not what the client's
     poll loop is built for. The promise is owned by `held` from now on.
     `.catch` on the same expression, not later: an unawaited rejection is an
     unhandled one, and in Node that is a process-level event. */
  void (async () => {
    let res: Response;
    try {
      /* No hop guard, unlike BFL and fal: this is one POST to a fixed address we
         wrote ourselves, not a URL a vendor handed back, so there is no Location
         header in the path that could move it. */
      res = await fetch(EDITS, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: form,
        cache: 'no-store',
        /* Generous, and it has to be: this single request covers the queueing,
           the render and the upload of a multi-megabyte body. The client gives up
           at three minutes, so anything past that is time nobody is waiting for. */
        signal: AbortSignal.timeout(170_000),
      });
    } catch (e) {
      const failure = transportFailure(e, 'render');
      held.settled = gone(failure.message, failure.retryable);
      return;
    }

    let payload: unknown = null;
    try { payload = await res.json(); } catch { payload = null; }

    if (!res.ok) {
      const failure = await httpFailure(res, payload);
      /* Recorded rather than thrown: nothing is awaiting this, and the poll is
         where a failure has somebody to tell. */
      held.settled = gone(failure.message, failure.retryable);
      console.warn(`[render] ${id} ${meta.id} refused by OpenAI (HTTP ${res.status}): ${failure.message}`);
      return;
    }

    const data = obj(payload)?.data;
    const first = Array.isArray(data) ? obj(data[0]) : null;
    const b64 = first ? str(first.b64_json) : null;
    if (!b64) {
      held.settled = gone('OpenAI answered the render without any image data in it.');
      return;
    }

    const bill = receipt(model, obj(payload)?.usage);
    /* The number this whole integration's price rests on, and the first thing to
       read after a render that actually went through: `flatUsdPerImage` for this
       provider is a pessimistic estimate from published token arithmetic, and
       this line is the bill it should be replaced with. */
    console.log(`[render] ${id} ${meta.id} metered ${bill.line} against an estimate of $${(estimateUsd(meta, args.width, args.height) ?? 0).toFixed(4)}`);

    held.at = Date.now();
    held.settled = {
      status: 'ready',
      imageUrl: `data:image/png;base64,${b64}`,
      /* Dollars, not the vendor's own unit. OpenAI meters tokens of three
         different kinds at three different rates, so there is no single number
         it "quotes" — the itemised sum is the only honest scalar, and unlike
         BFL's credits it needs no conversion factor anybody could get wrong. */
      cost: bill.usd,
    };
  })();

  return {
    id,
    pollUrl: heldUrl(id),
    /* Nothing is quoted at submit because nothing has happened at submit — the
       render has not run and OpenAI meters it afterwards. The estimate stands
       alone here, and the real figure arrives on the PollResult. */
    cost: null,
    usd: estimateUsd(meta, args.width, args.height),
  };
}

async function openaiPoll(pollUrl: string): Promise<PollResult> {
  const target = openaiKeyedUrl(pollUrl);
  const id = target?.searchParams.get('held');
  if (!id) {
    throw new ProviderError(400, 'That polling URL does not name an OpenAI render held on this server.', false);
  }

  const held = HELD.get(id);
  if (!held) {
    /* The honest failure of the design at the top of this file, phrased so the
       person reading it knows it is not their plan or their prompt. Terminal:
       there is nothing to wait for, because the thing that would answer is not
       in this process. */
    return gone('This render was handed to OpenAI by a server that is no longer holding it — OpenAI has no queue to collect a finished image from, so the app keeps it in memory between starting the render and picking it up, and a restart loses it. The credit is spent. Generate it again.');
  }

  /* Touched on every poll so a render nobody has collected yet is not swept out
     from under the client that is still asking for it. */
  held.at = Date.now();
  if (!held.settled) return { status: 'pending', progress: null };

  const settled = held.settled;
  /* Dropped as it is handed over: it is several megabytes of base64, the status
     route is about to write those bytes somewhere durable, and a second poll for
     the same render is the client double-asking rather than a case to serve. */
  HELD.delete(id);
  return settled;
}

function openaiProvider(meta: ProviderMeta, model: string): Provider {
  return {
    ...meta,
    submit: (args) => openaiSubmit(meta, model, args),
    poll: openaiPoll,
    deliveryUrl: openaiDeliveryUrl,
    keyedUrl: openaiKeyedUrl,
    fetchDelivery: (src) => openaiFetchDelivery(src),
  };
}

export const gptImageMini: Provider = openaiProvider(metaOf('openai-image-mini'), 'gpt-image-1-mini');
/** The flagship, and the expensive half of the pair. It is offered because it
 *  reads every input at high fidelity and the mini cannot be asked to — see
 *  `SENDS_INPUT_FIDELITY` — and it carries its own spending ceiling because it
 *  bills for the plan and for every photograph attached to it. */
export const gptImage2: Provider = openaiProvider(metaOf('openai-image-2'), 'gpt-image-2');
