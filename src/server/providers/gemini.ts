import 'server-only';

import { PHOTO_MIME, metaOf, missingEnvMessage, type ProviderMeta } from '@data/providers';
import {
  ProviderError, assertAffordable, controlLegend, estimateUsd, num, obj, refLegend,
  spareSlots, str, transportFailure, underHost, usableRefs,
  type GenerateArgs, type PollResult, type Provider, type SubmitResult,
} from './types';

/** Google's Gemini image models, behind the same Provider contract as the rest.
 *
 *  Verified against ai.google.dev/gemini-api/docs (the image-generation guide and
 *  the pricing page) on 2026-09-03. The current surface is the INTERACTIONS API —
 *  one POST to /v1beta/interactions with a `model`, an `input` array of typed
 *  parts, and a `response_format` naming the picture wanted back. The older
 *  generateContent shape is not used here.
 *
 *  IT IS SYNCHRONOUS, like OpenAI's endpoint and unlike BFL's and fal's: the
 *  request blocks for the length of the render and answers with the finished
 *  image as base64. The Provider contract is submit-then-poll, so this file
 *  bridges the two exactly the way openai.ts does — the in-flight request is held
 *  IN THIS PROCESS (see `HELD`) and polls are answered from it. The same honest
 *  limitation follows: a server restart or a second instance between submit and
 *  poll loses a render that has been paid for, and `poll` says so by name.
 *
 *  IT HAS A MENU, NOT A CANVAS. The endpoint takes an aspect ratio from a fixed
 *  list and a size class, not a width and height. Both menus were read out of the
 *  endpoint's own refusals on 2026-09-03 rather than a doc page: fourteen ratios
 *  (see `ASPECTS`) and the sizes '512', '1K', '2K', '4K' — of which this file asks
 *  for 1K or 2K, because 4K is $0.24 at the pro rate and over every ceiling the
 *  app has, and 512 is below the useful floor for a room. `nearestAspect` maps
 *  what the app asked for onto that menu, and the status route reads the real
 *  dimensions back out of the delivered bytes, so the stored render describes the
 *  file rather than the request.
 *
 *  IT ANSWERS JPEG, AND ONLY JPEG. Every other provider here draws a PNG, and
 *  this one cannot be asked to. Probed against the live endpoint on 2026-09-03:
 *
 *      The value 'image/png' is not supported for 'response_format.mime_type'.
 *      Supported values: 'image/jpeg'.
 *
 *  — and the same refusal for image/webp. That is a fact about the vendor, not a
 *  preference of ours, and it reaches further than this file: the renders bucket
 *  allowed image/png alone, `renderImagePath` hardcoded a .png extension, and the
 *  status route sniffed a PNG header to record the size. All three now take the
 *  format from the bytes, because the alternative — transcoding a lossy JPEG into
 *  a bigger PNG on the server to keep one hardcoded string true — spends CPU and
 *  a native image dependency to lose quality.
 *
 *  SUBMIT
 *    POST https://generativelanguage.googleapis.com/v1beta/interactions
 *    headers  x-goog-api-key: <GEMINI_API_KEY>
 *    body     { model, input: [{type:'text',...}, {type:'image',...}...],
 *               response_format: { type:'image', aspect_ratio, image_size, mime_type } }
 *    → 200 whose `steps` array carries the picture — see `outputOf`, which is
 *      written from a transcript of a real answer and not from the field names
 *      the client libraries expose, the mistake that made the first draft of
 *      this file fail every live render.
 *
 *  WHY THE HELD MAP IS STILL HERE, given the answer above has an `id` and
 *  `object: 'interaction'`. Both halves were probed on 2026-09-03:
 *    · GET /v1beta/interactions/{id} works, and returns the completed
 *      interaction with its image intact. So a finished render IS retrievable
 *      from Google by a process that knows its id.
 *    · `background: true` is a real parameter of this endpoint and these models
 *      refuse it by name — "Model 'gemini-3.1-flash-image' does not support
 *      background interactions" — so the POST cannot be made to hand back an id
 *      up front. (`gemini-3-pro-image-preview` DOES accept it and answers
 *      immediately with status 'in_progress'.)
 *  The id therefore only exists once the blocking POST has already returned,
 *  which is precisely the moment the held entry is filled in anyway. Nothing is
 *  recoverable that was not already in hand, so the bridge stays as it is — but
 *  if Google ever lets these models take `background`, the retrieval endpoint is
 *  waiting and this provider becomes a genuinely asynchronous one like BFL's.
 *
 *  There is no polling and no delivery host, so — as with OpenAI — the finished
 *  image never has a URL. `poll` hands it back as a `data:` URI and
 *  `fetchDelivery` decodes that without touching the network.
 */

/* ── the wire ────────────────────────────────────────────────────── */

const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/** Read per call, never at module scope — CI runs `pnpm build` with no secrets,
 *  and a module-level assertion turns a missing var into a red build. */
function geminiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new ProviderError(500, missingEnvMessage(metaOf('gemini-flash-image')), false);
  return key;
}

/** Every Google address this file will touch. `underHost` and not
 *  `endsWith(...)`: the sloppy spelling also matches a domain anybody can buy. */
export function geminiKeyedUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!underHost(u.hostname, 'generativelanguage.googleapis.com')) return null;
  return u;
}

/** The finished image, which has no delivery host at all — the bytes came back in
 *  the submit response, so what `poll` reports is a `data:` URI and this is the
 *  guard for it. Whole-string strict for the same reason openai.ts is: this value
 *  reaches `fetchDelivery`, and "starts with data:image" would also accept an SVG
 *  carrying script. JPEG and base64 or nothing — see the note above for why this
 *  is the one provider whose output is not a PNG. */
const JPEG_DATA = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

export function geminiDeliveryUrl(raw: string): URL | null {
  if (!JPEG_DATA.test(raw)) return null;
  try { return new URL(raw); } catch { return null; }
}

export async function geminiFetchDelivery(src: URL): Promise<Response> {
  const raw = src.toString();
  if (!JPEG_DATA.test(raw)) {
    throw new ProviderError(502, 'The finished render is not a JPEG data URI. Refusing to decode it.', false);
  }
  const bytes = Buffer.from(raw.slice(raw.indexOf(',') + 1), 'base64');
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.byteLength) },
  });
}

/* ── the output menu ─────────────────────────────────────────────── */

/** The aspect ratios the endpoint documents, and nothing else — asking for a
 *  ratio off this list is a 400 after the body has been built. */
const ASPECTS: readonly { name: string; ratio: number }[] = [
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
  /* The extreme four. This whole list is the endpoint's own refusal message,
     copied verbatim — send it '7:13' and it names all fourteen. They exist for
     the plan a camera looks straight down — a corridor or a galley kitchen —
     where the nearest of the ordinary ratios would letterbox the shot rather
     than frame it. */
  '1:4', '4:1', '1:8', '8:1',
].map((name) => {
  const [w, h] = name.split(':').map(Number);
  return { name, ratio: w / h };
});

/** The menu entry closest to what was asked for, compared in log space so 3:2
 *  and 2:3 are the same distance from square — the same arithmetic as
 *  `nearestSize` in openai.ts, against a longer menu. */
export function nearestAspect(width: number, height: number): string {
  const want = Math.log(Math.max(1, width) / Math.max(1, height));
  let best = ASPECTS[0];
  let bestGap = Infinity;
  for (const a of ASPECTS) {
    const gap = Math.abs(Math.log(a.ratio) - want);
    if (gap < bestGap) { bestGap = gap; best = a; }
  }
  return best.name;
}

/** The only output format the endpoint offers, probed rather than assumed — see
 *  the note at the top of the file. Named because four places have to agree on
 *  it: the request, the guard, the data URI and the failure message. */
export const OUT_MIME = 'image/jpeg';

/** '1K' or '2K'. The endpoint also offers '512' and '4K'; neither is asked for —
 *  the 4K image is $0.24 at the pro rate, over every ceiling this app has, and
 *  512 is too small to read a room off. 2K only when the request actually wants
 *  more than 1K can carry, because the 2K image costs half as much again on the
 *  flash model. */
export function imageSize(width: number, height: number): '1K' | '2K' {
  return width * height > 1_500_000 ? '2K' : '1K';
}

/* ── what the request says ───────────────────────────────────────── */

/** The interactions body. The text part first and the plan always the FIRST
 *  image, because every legend and every brief this app writes numbers the plan
 *  as image 1. Photographs before conditioning maps, the same order and for the
 *  same reason as `references()` in bfl.ts: a photo of the actual sofa is what
 *  the render is for, and a map handed to a model with no control channel is an
 *  experiment. */
export function interactionBody(meta: ProviderMeta, model: string, args: GenerateArgs): Record<string, unknown> {
  const photos = usableRefs(meta, args.refs);
  const extra = (args.controls ?? []).slice(0, Math.max(0, spareSlots(meta) - photos.length));
  const legend = [refLegend(photos, 2, args.prompt), controlLegend(extra, args.prompt)]
    .filter(Boolean).join(' ');
  return {
    model,
    input: [
      { type: 'text', text: legend ? `${args.prompt} ${legend}` : args.prompt },
      { type: 'image', mime_type: 'image/png', data: args.imageBase64 },
      ...photos.map((p) => ({ type: 'image', mime_type: PHOTO_MIME, data: p.base64 })),
      ...extra.map((c) => ({ type: 'image', mime_type: 'image/png', data: c.base64 })),
    ],
    /* JPEG because it is the only value this endpoint accepts — see the note at
       the top of the file. The aspect and size are the whole of the sizing logic. */
    response_format: {
      type: 'image',
      aspect_ratio: nearestAspect(args.width, args.height),
      image_size: imageSize(args.width, args.height),
      mime_type: OUT_MIME,
    },
  };
}

/* ── reading a refusal ───────────────────────────────────────────── */

/** The Interactions API answers a failure as `{ error: { message, code } }`,
 *  which is none of the three shapes already read in this directory AND not the
 *  `{ code, message, status }` that Google's older APIs use either — verified
 *  live on 2026-09-03, where a bad enum gave:
 *
 *      { "steps": [], "error": { "message": "The value '7:13' is not supported
 *        for 'response_format.aspect_ratio'. Supported values: ...",
 *        "code": "invalid_request" } }
 *
 *  `code` is a STRING here, not the HTTP number, so it is read as one; `status`
 *  is read as a fallback for the endpoints that still speak the old dialect. */
function errorOf(payload: unknown): { message: string | null; code: string | null } {
  const e = obj(obj(payload)?.error);
  if (!e) return { message: null, code: null };
  return { message: str(e.message), code: str(e.code) ?? str(e.status) };
}

function httpFailure(res: Response, payload: unknown): ProviderError {
  const { message, code } = errorOf(payload);
  const said = message ? ` Google said: ${message}` : '';

  switch (res.status) {
    case 400:
      return new ProviderError(400, message
        ?? 'Google rejected the request as malformed but named no field.', false);
    case 401:
    case 403:
      return new ProviderError(502, 'Google rejected the API key. GEMINI_API_KEY on the server is wrong, expired or has no access to this model — replace it with a key from aistudio.google.com/apikey.', false);
    case 404:
      return new ProviderError(502, `Google has no such model or endpoint.${said}`, false);
    case 429:
      /* Google phrases a rate limit and an exhausted quota through the same 429
         RESOURCE_EXHAUSTED, and only the message tells them apart. A daily or
         billing quota will not clear inside the client's three-minute budget, so
         it is terminal; a per-minute limit is worth the retry. */
      return /per day|daily|billing|plan/i.test(message ?? '')
        ? new ProviderError(402, `Out of quota at Google, so nothing can be rendered on it. Check the plan at aistudio.google.com.${said}`, false)
        : new ProviderError(429, `Google is rate-limiting this key. Try again in a moment.${said}`, true);
    case 500:
    case 502:
    case 503:
    case 504:
      return new ProviderError(503, `Google is failing on its side (HTTP ${res.status}${code ? ` ${code}` : ''}). Try again in a moment.`, true);
    default:
      return new ProviderError(502, `Google answered an unexpected HTTP ${res.status}.${said}`, false);
  }
}

/* ── the bill ────────────────────────────────────────────────────── */

/** Google's per-1M-token rates, from ai.google.dev/gemini-api/docs/pricing on
 *  2026-09-03, kept next to the models they price so the receipt below is
 *  arithmetic rather than a feeling. Text and image input are the same rate on
 *  both models, which is why there is one `input` figure and not two. */
interface Rates { input: number; imageOut: number }
const RATES: Record<string, Rates> = {
  'gemini-3.1-flash-image': { input: 0.50, imageOut: 60.00 },
  'gemini-3-pro-image': { input: 2.00, imageOut: 120.00 },
};

/** One modality's token count out of a `*_tokens_by_modality` array. */
function modality(list: unknown, want: string): number {
  if (!Array.isArray(list)) return 0;
  for (const entry of list) {
    const e = obj(entry);
    if (e && str(e.modality)?.toLowerCase() === want) return num(e.tokens) ?? 0;
  }
  return 0;
}

/** What Google actually metered, in dollars.
 *
 *  The flat price in src/data/providers.ts is pessimistic arithmetic off the
 *  pricing page; this is the same arithmetic over the counts Google reports for
 *  the render that just ran. The live usage block, transcribed 2026-09-03:
 *
 *      { total_tokens: 1631, total_input_tokens: 272,
 *        input_tokens_by_modality: [ {text,14}, {image,258} ],
 *        total_cached_tokens: 0, total_output_tokens: 1359,
 *        output_tokens_by_modality: [ {image,1120} ],
 *        total_thought_tokens: 0, ... }
 *
 *  1120 output-image tokens for a 1K frame is exactly what the estimate in
 *  providers.ts assumed, so that arithmetic is now confirmed rather than hoped.
 *
 *  ONE LINE IS MISSING ON PURPOSE. `total_output_tokens` exceeds the image
 *  tokens — 1359 against 1120 above — because the model also emits text
 *  alongside the picture, and the pricing page quotes no text-output rate for an
 *  image model. Rather than invent one, the count is reported in the log line and
 *  left out of the total, which therefore reads as a floor. At the observed ~240
 *  tokens it is cents-on-the-dollar of a render, and `overCeiling` watches the
 *  vendor's own quote, not this figure. */
function receipt(model: string, usage: unknown): { usd: number | null; line: string } {
  const u = obj(usage);
  const rate = RATES[model];
  if (!u || !rate) return { usd: null, line: 'not metered' };
  const input = num(u.total_input_tokens) ?? 0;
  const imageOut = modality(u.output_tokens_by_modality, 'image');
  const textOut = Math.max(0, (num(u.total_output_tokens) ?? 0) - imageOut);
  const usd = (input * rate.input + imageOut * rate.imageOut) / 1e6;
  const unpriced = textOut === 0 ? '' : `, plus ${textOut} output text tokens the pricing page quotes no rate for`;
  return { usd, line: `$${usd.toFixed(4)} (in=${input} imageOut=${imageOut}${unpriced})` };
}

/* ── reading the picture out ─────────────────────────────────────── */

/** What the interaction produced: the finished image, and any words the model
 *  said instead of one.
 *
 *  READ OFF THE LIVE ENDPOINT ON 2026-09-03, not off an SDK's field names. The
 *  first draft of this function looked for `output_image.data` — which is what
 *  the client libraries expose and is nowhere in the REST answer — so every real
 *  render failed with "answered without any image data in it" while the unit
 *  tests passed, because the fixture had been written from the same guess. The
 *  shape below is a transcript of an actual 200:
 *
 *      { id: 'v1_Chd...', object: 'interaction', status: 'completed',
 *        model: 'gemini-3.1-flash-image', usage: { ... }, created, updated,
 *        steps: [ { type: 'thought', signature: '<opaque, 1.9MB>' },
 *                 { type: 'model_output',
 *                   content: [ { type: 'image',
 *                                mime_type: 'image/jpeg',
 *                                data: '/9j/4AAQ...' } ] } ] }
 *
 *  So the picture is one content part of one step, and the model's thinking is a
 *  sibling step ahead of it. Only `content` arrays are walked, which is why the
 *  thought step — a bare `signature`, no content — is skipped without a special
 *  case for it.
 *
 *  The LAST image wins. A model that revises its own work emits the finished
 *  frame last, and taking the first would hand back a draft.
 *
 *  Text is collected on the same pass and never mistaken for success. It is what
 *  makes a refusal legible: when a safety filter or an impossible instruction
 *  stops the render, this endpoint answers 200 with a model_output step whose
 *  content is prose, and the alternative to reading it is telling the person
 *  waiting that nothing came back. */
interface Output {
  image: { data: string; mime: string | null } | null;
  text: string | null;
}

function outputOf(payload: unknown): Output {
  const steps = obj(payload)?.steps;
  let image: Output['image'] = null;
  const said: string[] = [];
  if (Array.isArray(steps)) {
    for (const step of steps) {
      const content = obj(step)?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const p = obj(part);
        if (!p) continue;
        const data = str(p.data);
        if (str(p.type) === 'image' && data) {
          image = { data, mime: str(p.mime_type) ?? str(p.mimeType) };
          continue;
        }
        const text = str(p.text);
        if (str(p.type) === 'text' && text) said.push(text);
      }
    }
  }
  return { image, text: said.join(' ').trim() || null };
}

/* ── the render held between submit and poll ─────────────────────── */

/** The same bridge openai.ts builds, for the same reason: the vendor is
 *  synchronous and the contract is submit-then-poll. See the notes there — every
 *  constant below makes the same bargain. */
interface Held {
  at: number;
  settled: PollResult | null;
}

const HELD = new Map<string, Held>();
const HELD_TTL_MS = 300_000;
const HELD_MAX = 8;

function sweep(): void {
  const cutoff = Date.now() - HELD_TTL_MS;
  for (const [id, held] of HELD) if (held.at < cutoff) HELD.delete(id);
  while (HELD.size > HELD_MAX) {
    const oldest = HELD.keys().next().value;
    if (oldest === undefined) break;
    HELD.delete(oldest);
  }
}

/** Minted on Google's own host even though it is never fetched, because the
 *  routes check a polling URL against `keyedUrl` before touching it. */
const heldUrl = (id: string): string => `${INTERACTIONS}?held=${encodeURIComponent(id)}`;

const gone = (error: string, retryable = false): PollResult => ({ status: 'failed', error, retryable });

/* ── submit and poll ─────────────────────────────────────────────── */

async function geminiSubmit(meta: ProviderMeta, model: string, args: GenerateArgs): Promise<SubmitResult> {
  assertAffordable(meta, args.width, args.height);
  const key = geminiKey();
  const body = interactionBody(meta, model, args);

  const id = `gemini-${crypto.randomUUID()}`;
  const held: Held = { at: Date.now(), settled: null };
  sweep();
  HELD.set(id, held);

  if (args.seed !== null) {
    /* Said once, at submit, rather than swallowed: the panel has a seed lock and
       on this provider it does nothing — the Interactions API documents no seed,
       so two runs of the same plan are two different images. */
    console.log(`[render] ${id} ${meta.id} ignores seed=${args.seed} — Google's Interactions API has no seed parameter.`);
  }

  /* Started and deliberately NOT awaited — the request blocks for the length of
     the render, and the promise is owned by `held` from now on. `.catch` folded
     into the same expression, because an unawaited rejection is a process-level
     event in Node. See openai.ts, which this mirrors line for line. */
  void (async () => {
    let res: Response;
    try {
      /* One POST to a fixed address we wrote ourselves — no Location header in
         the path that could move it, so no hop guard. */
      res = await fetch(INTERACTIONS, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
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
      const failure = httpFailure(res, payload);
      held.settled = gone(failure.message, failure.retryable);
      console.warn(`[render] ${id} ${meta.id} refused by Google (HTTP ${res.status}): ${failure.message}`);
      return;
    }

    const { image, text } = outputOf(payload);
    if (!image) {
      /* 200 with no picture in it. Three things can say why, in descending order
         of how much they explain: an `error` block, prose the model produced
         instead of an image (a safety stop reads like this), and the interaction
         `status`. Reported rather than flattened to "no image data", because that
         message is what sent this file back for a second look. */
      const { message } = errorOf(payload);
      const status = str(obj(payload)?.status);
      const why = message ?? text;
      const named = status && status !== 'completed' ? ` (status ${status})` : '';
      held.settled = gone(why
        ? `Google ran the render but returned no image${named}: ${why}`
        : `Google answered the render without any image data in it${named}.`);
      console.warn(`[render] ${id} ${meta.id} 200 with no image${named}${why ? `: ${why}` : ''}`);
      return;
    }
    if (image.mime && image.mime !== OUT_MIME) {
      /* The body asked for JPEG outright; anything else is the vendor changing
         the deal, and mislabelling the bytes downstream would put a file in the
         bucket whose contents disagree with its recorded type. */
      held.settled = gone(`Google answered with a ${image.mime} image after being asked for a ${OUT_MIME}.`);
      return;
    }

    /* What Google metered, priced. This used to read `usage.output_tokens`, a key
       that does not exist in the answer — see `receipt` for the real block. */
    const bill = receipt(model, obj(payload)?.usage);
    console.log(`[render] ${id} ${meta.id} metered ${bill.line} against an estimate of $${(estimateUsd(meta, args.width, args.height) ?? 0).toFixed(4)}`);

    held.at = Date.now();
    held.settled = {
      status: 'ready',
      /* Some encoders wrap base64; the delivery guard is whole-string strict, so
         whitespace is stripped before the URI is minted rather than after it is
         refused. */
      imageUrl: `data:${OUT_MIME};base64,${image.data.replace(/\s+/g, '')}`,
      cost: bill.usd,
    };
  })();

  return {
    id,
    pollUrl: heldUrl(id),
    cost: null,
    usd: estimateUsd(meta, args.width, args.height),
  };
}

async function geminiPoll(pollUrl: string): Promise<PollResult> {
  const target = geminiKeyedUrl(pollUrl);
  const id = target?.searchParams.get('held');
  if (!id) {
    throw new ProviderError(400, 'That polling URL does not name a Gemini render held on this server.', false);
  }

  const held = HELD.get(id);
  if (!held) {
    return gone('This render was handed to Google by a server that is no longer holding it — the Interactions API has no queue to collect a finished image from, so the app keeps it in memory between starting the render and picking it up, and a restart loses it. The credit is spent. Generate it again.');
  }

  held.at = Date.now();
  if (!held.settled) return { status: 'pending', progress: null };

  const settled = held.settled;
  HELD.delete(id);
  return settled;
}

function geminiProvider(meta: ProviderMeta, model: string): Provider {
  return {
    ...meta,
    submit: (args) => geminiSubmit(meta, model, args),
    poll: geminiPoll,
    deliveryUrl: geminiDeliveryUrl,
    keyedUrl: geminiKeyedUrl,
    fetchDelivery: (src) => geminiFetchDelivery(src),
  };
}

/** The default pick — see DEFAULT_PICK in src/data/providers.ts for why. */
export const geminiFlashImage: Provider = geminiProvider(metaOf('gemini-flash-image'), 'gemini-3.1-flash-image');
/** The quality tier: the strongest structure-preserving editor the 2026-09
 *  research sweep could find a measurement for, at half again the flash price. */
export const geminiProImage: Provider = geminiProvider(metaOf('gemini-pro-image'), 'gemini-3-pro-image');
