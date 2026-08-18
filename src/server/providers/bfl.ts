import 'server-only';

/** Black Forest Labs, FLUX.2 [max] — the whole wire contract, in one place.
 *
 *  Transcribed from BFL's live OpenAPI document, https://api.bfl.ai/openapi.json
 *  (and the matching pages under https://docs.bfl.ai/api-reference), read
 *  2026-08-14. Documented, not observed: the key in `.env` is rejected with
 *  422 `{"detail":"Invalid API key format"}` before body validation, so nothing
 *  below has been proven against a live call yet.
 *
 *  SUBMIT
 *    POST https://api.bfl.ai/v1/flux-2-max
 *    headers  x-key: <raw key>          — there is no `Authorization: Bearer`
 *                                         form; Bearer answers 403 "Not authenticated"
 *             content-type: application/json
 *             accept: application/json
 *    body     prompt            string   required
 *             input_image       string   RAW base64 — no "data:image/png;base64," prefix
 *             width, height     number   multiple of 16, >= 64, width*height <= 4 MP.
 *                                        FLUX.2 has no aspect_ratio field: the ratio
 *                                        is these two numbers. Billing is per output
 *                                        megapixel, so 1800×1800 costs roughly 3× 1 MP,
 *                                        and [max]'s rate is about double [pro]'s.
 *             seed              number | null — null or omitted is random
 *             disable_pup       true     stops BFL's own LLM rewriting the prompt and
 *                                        inventing rooms. pro/max only.
 *             output_format     'png'    the flux-2-* default is jpeg
 *             safety_tolerance  2        0..5 on FLUX.2 (0..6 on kontext); above the
 *                                        model's own maximum is a 422
 *             (never send webhook_url — it removes polling_url from the response)
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

/* One constant, so swapping models is a one-line change — but not the only
   copy of the string: MODEL_LABEL in `src/state/renders.ts` names the model on
   the record the browser writes, and this file is server-only, so that one has
   to move in the same commit or a render gets filed under a model that never
   drew it.

   [max] and [pro] share one request schema upstream (`Flux2Inputs` in
   api.bfl.ai/openapi.json — same input_image, width/height, seed, disable_pup,
   safety_tolerance), so everything documented above holds for both and the
   fallback really is one line. Fallback: 'flux-2-pro' — roughly half the price
   per output megapixel and half the latency, one tier down on the two things
   this product is actually buying: editing consistency and prompt adherence. */
export const MODEL = 'flux-2-max';

const BASE = 'https://api.bfl.ai';

/* Provider facts the request routes validate against, exported so the ceiling is
   stated once. Multiples of 16 and >= 64 per side; 4 MP is the product ceiling. */
export const DIM_STEP = 16;
export const MIN_DIM = 64;
export const MAX_OUTPUT_PIXELS = 4_000_000;

/** Both routes are stateless — neither can see how long a job has been running —
 *  so the 180 s cap is enforced by the client poller. The wording lives here so
 *  the poller and the adapter cannot drift apart. */
export const POLL_TIMEOUT_MS = 180_000;
export const POLL_TIMEOUT_MESSAGE = 'The render timed out after 3 minutes.';

/** Said in one place because both routes check for the key and both must say the
 *  same thing when it is absent. */
export const MISSING_KEY = 'FLUX_API_KEY is not set on the server, so no render can be submitted.';

export interface SubmitArgs {
  prompt: string;
  /** raw base64 png, already stripped of any data: prefix */
  imageBase64: string;
  width: number;
  height: number;
  seed: number | null;
}

export interface SubmitResult {
  id: string;
  pollUrl: string;
  /** in credits, 1 credit = $0.01. Absent on some clusters. */
  cost: number | null;
}

export type PollResult =
  | { status: 'pending'; progress: number | null }
  | { status: 'ready'; imageUrl: string; cost: number | null }
  | { status: 'failed'; error: string; retryable: boolean };

/** A provider failure already phrased for the person waiting on the render, with
 *  the HTTP status the route should answer and whether trying again can help. */
export class ProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, message: string, retryable: boolean) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
  }
}

/* ── plumbing ────────────────────────────────────────────────────── */

/** Read per call, never at module scope — CI runs `pnpm build` with no secrets,
 *  and a module-level assertion turns a missing var into a red build. */
function apiKey(): string {
  const key = process.env.FLUX_API_KEY;
  if (!key) throw new ProviderError(500, MISSING_KEY, false);
  return key;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

async function body(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return null; }
}

/** FastAPI answers 422 two different ways: `detail` is a list of
 *  `{loc, msg, type}` for field validation, and a bare string for everything it
 *  rejects earlier — the invalid-key rejection arrives as the string form. Both
 *  are the developer's own bug, so both go through verbatim. */
function detailMsg(payload: unknown): string | null {
  const d = obj(payload)?.detail;
  if (typeof d === 'string') return d.trim() || null;
  if (Array.isArray(d)) {
    const first = obj(d[0]);
    return first ? str(first.msg) : null;
  }
  return null;
}

/** `details` is free-form JSON and ends up in a toast, where a pretty-printed
 *  object is unreadable. Flatten it to one clause and cap it. */
function detailLine(v: unknown): string {
  const d = obj(v);
  if (!d) return '';
  const reasons = d['Moderation Reasons'];
  const text = Array.isArray(reasons)
    ? reasons.map(String).join('; ')
    : Object.entries(d).map(([k, val]) => `${k}: ${typeof val === 'string' ? val : JSON.stringify(val)}`).join('; ');
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return ` The provider said: ${flat.length > 300 ? `${flat.slice(0, 299)}…` : flat}`;
}

/** Upstream HTTP status → what the person waiting is told, and whether a retry
 *  is even worth offering. Every branch names the real cause. */
async function httpFailure(res: Response): Promise<ProviderError> {
  const payload = await body(res);
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

/** A refused connection, DNS failure or our own AbortSignal — never a status
 *  code, so it cannot go through httpFailure. */
function transportFailure(e: unknown, what: string): ProviderError {
  const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
  return new ProviderError(
    504,
    timedOut
      ? `The image provider did not answer the ${what} within the timeout.`
      : `Could not reach the image provider to ${what} (${e instanceof Error ? e.message : 'unknown network error'}).`,
    true,
  );
}

/** The only hosts the API key may ever be shown. The polling URL arrives from
 *  the browser, so this is the line between "poll a job" and "hand our key to
 *  whatever host the caller named". */
export function bflUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.hostname !== 'api.bfl.ai' && !u.hostname.endsWith('.bfl.ai')) return null;
  return u;
}

/** fetch() follows redirects itself, and undici strips only `authorization`,
 *  `cookie`, `proxy-authorization` and `host` when a redirect crosses an origin
 *  — a custom header rides along. So `x-key` on a checked bfl.ai URL that
 *  answers 302 lands on whatever host the Location names, in cleartext if it
 *  downgrades to http. Checking the URL once was never enough: every hop gets
 *  the same check, by hand. */
export async function hopSafeFetch(url: URL, init: RequestInit, hops = 3): Promise<Response> {
  let target = url;
  for (let i = 0; i <= hops; i++) {
    const res = await fetch(target, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status > 399) return res;
    const loc = res.headers.get('location');
    if (!loc) return res;
    /* relative Locations are common and harmless — resolve before checking, so
       a same-host redirect still works */
    const next = bflUrl(new URL(loc, target).toString());
    if (!next) {
      throw new ProviderError(
        502,
        'The image provider redirected off bfl.ai. Refusing to follow it with the API key attached.',
        false,
      );
    }
    target = next;
  }
  throw new ProviderError(502, 'The image provider redirected too many times.', false);
}

/* ── the two calls ───────────────────────────────────────────────── */

/** Hand a plan and a prompt to BFL. Returns the job id and the polling URL to
 *  keep verbatim; throws ProviderError for anything the caller should surface. */
export async function submit(args: SubmitArgs): Promise<SubmitResult> {
  const key = apiKey();
  let res: Response;
  try {
    res = await fetch(`${BASE}/v1/${MODEL}`, {
      method: 'POST',
      headers: { 'x-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        prompt: args.prompt,
        input_image: args.imageBase64,
        width: args.width,
        height: args.height,
        seed: args.seed,
        /* the whole point of the product is "reproduce *this* layout" — leaving
           BFL's prompt upsampler on lets it rewrite the brief and invent rooms */
        disable_pup: true,
        output_format: 'png',
        safety_tolerance: 2,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw transportFailure(e, 'submit');
  }

  if (!res.ok) throw await httpFailure(res);

  const payload = obj(await body(res));
  const id = payload ? str(payload.id) : null;
  const pollUrl = payload ? str(payload.polling_url) : null;
  /* No polling_url means the job is running and unreachable — a credit spent on
     something we can never collect. Loud, not silent. */
  if (!id || !pollUrl) {
    throw new ProviderError(502, 'The image provider accepted the job but returned no polling URL, so the result cannot be collected.', false);
  }
  return { id, pollUrl, cost: payload ? num(payload.cost) : null };
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

  const payload = obj(await body(res));
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
