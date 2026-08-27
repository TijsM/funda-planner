import 'server-only';

import { metaOf, missingEnvMessage, quotedUsdOf, type ProviderMeta } from '@data/providers';
import {
  ProviderError, assertAffordable, controlLegend, detailLine, detailMsg, estimateUsd,
  hopSafeFetch as hopSafe, jsonBody, num, obj, refLegend, spareSlots, str, transportFailure,
  underHost, usableRefs,
  type GenerateArgs, type PollResult, type Provider, type SubmitResult,
} from './types';

/** Black Forest Labs, FLUX.2 — the whole wire contract, in one place.
 *
 *  Transcribed from BFL's live OpenAPI document, https://api.bfl.ai/openapi.json
 *  (and the matching pages under https://docs.bfl.ai/api-reference), read
 *  2026-08-14 and re-read 2026-08-18. Documented, not observed: the key in
 *  `.env` is rejected with 422 `{"detail":"Invalid API key format"}` before body
 *  validation, so nothing below has been proven against a live call yet.
 *
 *  SUBMIT
 *    POST https://api.bfl.ai/v1/flux-2-max   (or /v1/flux-2-flex)
 *    headers  x-key: <raw key>          — there is no `Authorization: Bearer`
 *                                         form; Bearer answers 403 "Not authenticated"
 *             content-type: application/json
 *             accept: application/json
 *    body     prompt            string   required
 *             input_image       string   RAW base64 — no "data:image/png;base64," prefix
 *             input_image_2 … _8         more references, same encoding, all optional
 *             width, height     number   multiple of 16, >= 64, width*height <= 4 MP.
 *                                        FLUX.2 has no aspect_ratio field: the ratio
 *                                        is these two numbers. Billing is per output
 *                                        megapixel, so 1800×1800 costs roughly 3× 1 MP,
 *                                        and [max]'s rate is about double [pro]'s.
 *             seed              number | null — null or omitted is random
 *             output_format     'png'    the flux-2-* default is jpeg
 *             safety_tolerance  2        0..5 on FLUX.2 (0..6 on kontext); above the
 *                                        model's own maximum is a 422
 *             (never send webhook_url — it removes polling_url from the response)
 *    [max]/[pro] only:
 *             disable_pup       true     stops BFL's own LLM rewriting the prompt and
 *                                        inventing rooms. Upstream default false.
 *    [flex] only, INSTEAD of disable_pup — it does not have that field at all:
 *             prompt_upsampling false    the same switch written the other way up, and
 *                                        upstream it defaults TRUE. See FLEX below.
 *             guidance          number   1.5..10, upstream default 5
 *             steps             integer  1..50, upstream default 50
 *    → 200 { id, polling_url, cost?, input_mp?, output_mp? }
 *
 *  POLL
 *    GET <polling_url>   verbatim, same x-key header. The URL is cluster-specific:
 *                        a hand-built /v1/get_result?id=… against the global host
 *                        answers "Task not found".
 *    → 200 { id, status, progress?, preview?, result?, details? }
 *    `result` is typed anyOf[{}, null] and `sample` is the only key ever promised —
 *    the seed we record is the seed we sent, never result.seed.
 *    `sample` is a signed https URL on delivery.*.bfl.ai, valid 10 minutes, and BFL
 *    serves no CORS headers there, so the browser cannot fetch it at all: the bytes
 *    have to be pulled down server-side.
 */

/* One constant, so swapping models is a one-line change. The string a record is
   filed under is no longer a second copy of it: `modelLabelOf` in
   `src/data/providers.ts` reads the label off this provider's own metadata, which
   both sides of the server boundary import.

   [max] and [pro] share one request schema upstream (`Flux2Inputs` in
   api.bfl.ai/openapi.json — same input_image, width/height, seed, disable_pup,
   safety_tolerance), so everything documented above holds for both and the
   fallback really is one line. Fallback: 'flux-2-pro' — roughly half the price
   per output megapixel and half the latency, one tier down on the two things
   this product is actually buying: editing consistency and prompt adherence. */
export const MODEL = 'flux-2-max';

const BASE = 'https://api.bfl.ai';

/* This model's own limits — multiples of 16 and >= 64 per side, 4 MP a side — are
   not constants here any more. They live in `src/data/providers.ts`, which the
   browser reads too, and each provider carries its own: the routes measure a
   request against whichever provider was chosen, and a constant named after this
   one is how a z-image render came to be validated against FLUX.2's ceiling. */

/** Said in one place because both routes check for the key and both must say the
 *  same thing when it is absent — and the words come from `@data/providers`, so
 *  what a person sees does not depend on which side noticed. */
const MISSING_KEY = missingEnvMessage(metaOf('flux2-max'));

export { ProviderError };
export type { PollResult, SubmitResult };

/* ── plumbing ────────────────────────────────────────────────────── */

/** Read per call, never at module scope — CI runs `pnpm build` with no secrets,
 *  and a module-level assertion turns a missing var into a red build. */
function apiKey(): string {
  const key = process.env.FLUX_API_KEY;
  if (!key) throw new ProviderError(500, MISSING_KEY, false);
  return key;
}

/** Upstream HTTP status → what the person waiting is told, and whether a retry
 *  is even worth offering. Every branch names the real cause. */
async function httpFailure(res: Response): Promise<ProviderError> {
  const payload = await jsonBody(res);
  switch (res.status) {
    case 401:
    case 403:
      /* BFL's own skills repo documents 401 here as well as 403 — the live
         rejection we have seen is 403 "Not authenticated" for a Bearer header. */
      return new ProviderError(502, 'The image provider rejected the API key.', false);
    case 402:
      return new ProviderError(402, 'Out of credits at the image provider. Top up at api.bfl.ai.', false);
    case 422: {
      const said = detailMsg(payload);
      /* BFL answers a bad key with 422 "Invalid API key format", not 401 — so it
         arrives down the same path as a malformed body and, phrased as that, it
         reads to the person pressing Generate as though the plan were at fault.
         It is a server configuration problem and only one person can fix it, so
         say which variable and where the replacement comes from. */
      if (said && /api[\s_-]?key/i.test(said)) {
        return new ProviderError(
          502,
          `The image provider rejected the API key (${said}). FLUX_API_KEY on the server is wrong or expired — replace it with a key from dashboard.bfl.ai/api/keys.`,
          false,
        );
      }
      return new ProviderError(400, said
        ?? 'The image provider rejected the request as malformed but named no field.', false);
    }
    case 429:
      /* Not a rate limit but a concurrency cap: 24 tasks active at once across
         the account (only kontext-max is lower, at 6). Waiting for one to settle
         clears it. */
      return new ProviderError(429, 'The provider is at capacity (24 concurrent jobs). Try again in a moment.', true);
    case 500:
    case 502:
    case 503:
    case 504:
      return new ProviderError(503, `The image provider is failing on its side (HTTP ${res.status}). Try again in a moment.`, true);
    default:
      return new ProviderError(502, `The image provider answered an unexpected HTTP ${res.status}.`, false);
  }
}

/** The only hosts the API key may ever be shown. The polling URL arrives from
 *  the browser, so this is the line between "poll a job" and "hand our key to
 *  whatever host the caller named". */
export function bflUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!underHost(u.hostname, 'bfl.ai')) return null;
  return u;
}

const OFF_HOST = 'The image provider redirected off bfl.ai. Refusing to follow it with the API key attached.';

/** Kept at its old three-argument shape because `app/api/render/status/route.ts`
 *  calls it to pull the finished PNG down; the hop-by-hop reasoning it exists for
 *  now lives in `types.ts`, where fal needs it too. */
export async function hopSafeFetch(url: URL, init: RequestInit, hops = 3): Promise<Response> {
  return hopSafe(url, init, bflUrl, OFF_HOST, hops);
}

/* ── the two calls ───────────────────────────────────────────────── */

/** What goes in `input_image` and `input_image_2 … _8`.
 *
 *  PHOTOGRAPHS FIRST, then conditioning maps, and the order is a judgement
 *  rather than a convention. A photo of the sofa someone actually bought is the
 *  thing they are paying this render to show; a control map handed to FLUX.2 is
 *  an experiment — docs.bfl.ai is explicit that this model has no control input
 *  and "interprets structure semantically", so there is no evidence a depth map
 *  in a reference slot constrains geometry at all. When there are more images
 *  than slots, the experiment is what gets dropped.
 *
 *  Trimmed rather than trusted: the browser counts the same budget before it
 *  asks, but the eval harness calls this directly. Eight keys is the schema's
 *  limit and a ninth is a 422 charged at full price. */
function references(meta: ProviderMeta, args: GenerateArgs): Record<string, string> {
  const out: Record<string, string> = { input_image: args.imageBase64 };
  const photos = usableRefs(meta, args.refs);
  const maps = (args.controls ?? []).slice(0, Math.max(0, spareSlots(meta) - photos.length));
  [...photos.map(r => r.base64), ...maps.map(c => c.base64)]
    .forEach((base64, i) => { out[`input_image_${i + 2}`] = base64; });
  return out;
}

/** The prompt with a sentence naming what each extra reference is — unless the
 *  brief already names them, which the app's own briefs do. Appended rather than
 *  prepended: BFL's prompting guide says word order matters and the brief has to
 *  come first.
 *
 *  The two legends are numbered off the same allocation `references()` makes, in
 *  the same order, because a sentence that calls image 3 a depth map when slot 3
 *  holds a photograph of a wardrobe is worse than saying nothing at all. */
function promptFor(meta: ProviderMeta, args: GenerateArgs): string {
  const photos = usableRefs(meta, args.refs);
  const maps = (args.controls ?? []).slice(0, Math.max(0, spareSlots(meta) - photos.length));
  const parts = [
    refLegend(photos, 2, args.prompt),
    controlLegend(maps, args.prompt),
  ].filter(Boolean);
  return parts.length ? `${args.prompt} ${parts.join(' ')}` : args.prompt;
}

async function bflSubmit(meta: ProviderMeta, model: string, extra: Record<string, unknown>, args: GenerateArgs): Promise<SubmitResult> {
  assertAffordable(meta, args.width, args.height);
  const key = apiKey();
  let res: Response;
  try {
    /* Hop-checked like the poll, and for the same reason: undici follows a
       redirect itself and strips only `authorization`, `cookie`,
       `proxy-authorization` and `host` across origins, so a 302 out of
       api.bfl.ai would carry `x-key` — a custom header — to whatever host the
       Location names, and the plan and prompt with it. The submit was the one
       call still using bare fetch, which is to say the one call that trusted the
       vendor's Location header with the key. */
    res = await hopSafeFetch(new URL(`${BASE}/v1/${model}`), {
      method: 'POST',
      headers: { 'x-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        prompt: promptFor(meta, args),
        ...references(meta, args),
        width: args.width,
        height: args.height,
        seed: args.seed,
        /* No disable_pup here: the field that turns BFL's prompt rewriter off is
           spelled differently on [max] and on [flex], so each model's `extra`
           carries its own. Putting either one in the shared body sends a field
           the other endpoint has never heard of — and Pydantic ignores unknown
           keys rather than rejecting them, so that mistake reads as success and
           the rewriter stays on. */
        output_format: 'png',
        safety_tolerance: 2,
        ...extra,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw transportFailure(e, 'submit');
  }

  if (!res.ok) throw await httpFailure(res);

  const payload = obj(await jsonBody(res));
  const id = payload ? str(payload.id) : null;
  const pollUrl = payload ? str(payload.polling_url) : null;
  /* No polling_url means the job is running and unreachable — a credit spent on
     something we can never collect. Loud, not silent. */
  if (!id || !pollUrl) {
    throw new ProviderError(502, 'The image provider accepted the job but returned no polling URL, so the result cannot be collected.', false);
  }
  const cost = payload ? num(payload.cost) : null;
  return {
    id,
    pollUrl,
    cost,
    usd: estimateUsd(meta, args.width, args.height),
    quotedUsd: quotedUsdOf(meta, cost),
    metered: {
      inputMp: payload ? num(payload.input_mp) : null,
      outputMp: payload ? num(payload.output_mp) : null,
    },
  };
}

/** Poll a job. `pollUrl` must already have been checked to be an https bfl.ai
 *  URL by the caller — this attaches the API key to it, and re-checks every
 *  redirect for the same reason. */
export async function poll(pollUrl: string): Promise<PollResult> {
  const key = apiKey();
  const target = bflUrl(pollUrl);
  if (!target) {
    throw new ProviderError(400, 'That polling URL is not an https address on bfl.ai.', false);
  }
  let res: Response;
  try {
    res = await hopSafeFetch(target, {
      headers: { 'x-key': key, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw transportFailure(e, 'poll');
  }

  if (res.status === 404) {
    return {
      status: 'failed',
      error: 'The provider has no record of this job — results live 10 minutes, after which the job is gone.',
      retryable: false,
    };
  }
  if (!res.ok) throw await httpFailure(res);

  const payload = obj(await jsonBody(res));
  const status = payload ? str(payload.status) : null;

  switch (status) {
    /* Reasoning is FLUX.2's planning pass and Generating is the diffusion — both
       are the same thing to the caller: keep polling. */
    case 'Pending':
    case 'Reasoning':
    case 'Generating':
      return { status: 'pending', progress: payload ? num(payload.progress) : null };

    case 'Ready': {
      const sample = str(obj(payload?.result)?.sample);
      if (!sample) {
        return {
          status: 'failed',
          error: 'The provider reported the render finished but returned no image URL.',
          retryable: false,
        };
      }
      return { status: 'ready', imageUrl: sample, cost: payload ? num(payload.cost) : null };
    }

    /* Input rejected. Terminal — the same plan and prompt will be rejected again. */
    case 'Request Moderated':
      return {
        status: 'failed',
        error: `The provider's safety filter rejected the plan or the prompt.${detailLine(payload?.details)}`,
        retryable: false,
      };

    /* Output rejected. The input was fine, so a different seed genuinely can
       produce an image that passes. */
    case 'Content Moderated':
      return {
        status: 'failed',
        error: `The generated image was filtered. Re-roll the seed.${detailLine(payload?.details)}`,
        retryable: true,
      };

    case 'Error':
      return {
        status: 'failed',
        error: `The render failed at the provider.${detailLine(payload?.details)} Re-rolling the seed clears this often enough to be worth one try.`,
        retryable: true,
      };

    /* Either the ten minutes ran out, or the polling URL was rebuilt against the
       global host instead of the cluster BFL named. */
    case 'Task not found':
      return {
        status: 'failed',
        error: 'The provider no longer knows this job — it expired, or the polling URL points at the wrong cluster.',
        retryable: false,
      };

    /* Not in the OpenAPI enum but in every official sample. */
    case 'Failed':
      return {
        status: 'failed',
        error: `The render failed at the provider.${detailLine(payload?.details)} The task ended in a failed state and will not produce an image.`,
        retryable: false,
      };

    /* Anything unrecognised is terminal on purpose: treating an unknown status as
       "keep polling" is how a client loops for three minutes over a typo. */
    default:
      return {
        status: 'failed',
        error: status
          ? `The render failed at the provider, which reported an unrecognised status "${status}".`
          : 'The provider answered the poll without a status field.',
        retryable: false,
      };
  }
}

/* ── the two providers ───────────────────────────────────────────── */

/* Turning BFL's prompt rewriter off is one intention with two spellings, and the
   two models do not share a field. Read off api.bfl.ai/openapi.json on 2026-08-18
   and re-read from the raw document rather than the reference pages:

     /v1/flux-2-max   Flux2Inputs      disable_pup, default FALSE.
                                       No prompt_upsampling anywhere in the schema.
     /v1/flux-2-flex  Flux2FlexInputs  prompt_upsampling, default TRUE.
                                       No disable_pup anywhere in the schema.

   Neither schema sets additionalProperties, so FastAPI ignores a field the model
   does not declare instead of answering 422. That is what makes this worth eight
   lines of comment: sending disable_pup to [flex] does not fail, it just does
   nothing, and every flex render comes back with its brief rewritten and rooms
   invented while the body says in writing that the rewriter is off. A silent
   wrong answer, which is the failure mode this whole rebuild is chasing.

   Both defaults also point the same way — upstream, out of the box, the rewriter
   is ON for [flex] and OFF for [max] — so the field cannot be omitted either.

   Guidance defaults lower than BFL's 5, not higher: arXiv:2404.07724 finds
   classifier-free guidance is actively harmful over the early steps and
   unnecessary over the late ones, and what this product wants is fidelity to a
   reference rather than an emphatic reading of a sentence. 3.5 is a starting
   point for the harness to move, not a tuned number. */
const MAX_EXTRA = { disable_pup: true } as const;

const FLEX_EXTRA = {
  prompt_upsampling: false,
  guidance: 3.5,
  steps: 50,
} as const;

function bflProvider(meta: ProviderMeta, model: string, extra: Record<string, unknown>): Provider {
  return {
    ...meta,
    submit: (args) => bflSubmit(meta, model, extra, args),
    poll,
    deliveryUrl: bflUrl,
    /* One guard for both on BFL: the delivery host is delivery.*.bfl.ai and the
       cluster that answers a poll is api.*.bfl.ai, and `bflUrl` accepts any
       bfl.ai subdomain rather than enumerating clusters we do not control. */
    keyedUrl: bflUrl,
    /* No x-key: the delivery URL is already signed and the key has no business
       leaving api.bfl.ai. The hop check stays, because a redirect off bfl.ai
       would still make the status route a willing proxy for reading anything the
       server can reach — link-local metadata included. */
    fetchDelivery: (src, init) => hopSafeFetch(src, init ?? {}),
  };
}

export const flux2Max: Provider = bflProvider(metaOf('flux2-max'), MODEL, MAX_EXTRA);
export const flux2Flex: Provider = bflProvider(metaOf('flux2-flex'), 'flux-2-flex', FLEX_EXTRA);
