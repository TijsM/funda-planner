import 'server-only';

import { PHOTO_MIME, metaOf, missingEnvMessage, type ControlKind, type ProviderMeta } from '@data/providers';
import {
  ProviderError, assertAffordable, controlLegend, detailMsg, estimateUsd,
  hopSafeFetch, jsonBody, obj, refLegend, spareSlots, str, transportFailure, underHost,
  usableControls, usableRefs,
  type GenerateArgs, type PollResult, type Provider, type SubmitResult,
} from './types';

/** fal.ai — three models behind one queue, the whole wire contract in one place.
 *
 *  Verified against https://fal.ai/docs/model-apis/model-endpoints/queue and each
 *  model's own /api page on 2026-08-18. (docs.fal.ai 308s to fal.ai/docs; the
 *  redirect is the only thing that moved.) Nothing here has been run against a
 *  live key, because there is no FAL_KEY yet — every path below therefore has to
 *  fail by *naming the variable*, which is the one failure mode we can be sure of.
 *
 *  SUBMIT
 *    POST https://queue.fal.run/{model_id}
 *    headers  Authorization: Key <FAL_KEY>   — "Key", not "Bearer"
 *             content-type: application/json
 *    → 200 { request_id, status_url, response_url, cancel_url, queue_position }
 *
 *  POLL
 *    GET <status_url>
 *    → 200 { status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED',
 *            queue_position?, logs?, metrics?, error?, error_type? }
 *    There is no FAILED in that enum. A run that dies surfaces as an `error` on
 *    the status payload or as a non-2xx on the response URL, so both are treated
 *    as terminal here rather than polled until the client's own three minutes run
 *    out.
 *
 *  COLLECT
 *    GET <response_url>
 *    → 200 { images: [{ url, width, height, content_type }], seed, timings? }
 *    The URL is on *.fal.media and, like BFL's delivery host, has to be fetched
 *    server-side.
 *
 *  Images go up as `data:` URIs rather than uploaded first: fal accepts them
 *  anywhere an image_url is taken, and the alternative is a second round trip to
 *  fal's storage for a file we will never reuse.
 */

const QUEUE = 'https://queue.fal.run';

/** Named, actionable, and the same sentence everywhere — there is no FAL_KEY in
 *  this deployment yet, so this string is what every fal path actually does. */
/** One sentence for all three fal models — the key is per vendor, not per model,
 *  and it is the same words the routes and the picker use. */
export const MISSING_FAL_KEY = missingEnvMessage(metaOf('z-image-cn'));

/** Read per call, never at module scope — CI runs `pnpm build` with no secrets,
 *  and a module-level assertion turns a missing var into a red build. */
function falKey(): string {
  const key = process.env.FAL_KEY;
  if (!key) throw new ProviderError(500, MISSING_FAL_KEY, false);
  return key;
}

/** Every fal URL we will touch at all: the queue on fal.run and the finished
 *  file on fal.media. Used for the delivery fetch, which carries no key.
 *
 *  `underHost` and not `endsWith('fal.run')`: the latter also matches
 *  `evilfal.run`, which is a domain anybody can buy. */
export function falUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!underHost(u.hostname, 'fal.run') && !underHost(u.hostname, 'fal.media')) return null;
  return u;
}

/** The only hosts FAL_KEY may ever be shown. Narrower than `falUrl` on purpose:
 *  the queue lives on fal.run and the CDN on fal.media, and a polling URL
 *  arrives from the browser off a render row — so accepting fal.media here would
 *  let a caller name a CDN address and have us attach the key to it. Still the
 *  vendor's own host, so this was never third-party exposure; it was a key going
 *  somewhere it has no business being, which is the same class of mistake one
 *  step earlier. */
export function falKeyedUrl(raw: string): URL | null {
  const u = falUrl(raw);
  return u && underHost(u.hostname, 'fal.run') ? u : null;
}

const OFF_HOST = 'fal redirected off fal.run. Refusing to follow it with the API key attached.';

/** fal names both a status URL and a response URL at submit, but a render row
 *  carries exactly one provider URL and the Provider contract polls with one
 *  string — so the response URL is derived from the status URL rather than
 *  stored. Derived and then re-checked, never assumed: BFL's "Task not found"
 *  came from exactly this, a URL rebuilt by hand against the wrong path. */
function responseUrlOf(statusUrl: URL): URL {
  const path = statusUrl.pathname;
  if (!path.endsWith('/status')) {
    throw new ProviderError(
      502,
      'That fal polling URL does not end in /status, so the address of the finished image cannot be worked out from it.',
      false,
    );
  }
  const u = new URL(statusUrl.toString());
  u.pathname = `${path.slice(0, -'/status'.length)}/response`;
  u.search = '';
  return u;
}

/** Upstream HTTP status → what the person waiting is told, and whether a retry
 *  is even worth offering. fal is FastAPI, so a rejected body arrives in the same
 *  `detail` shape BFL uses and goes through the same reader. */
async function httpFailure(res: Response, read?: unknown): Promise<ProviderError> {
  /* `read` exists because a Response body can only be consumed once: the collect
     path has already parsed it to decide whether the failure belongs to the run
     or to the connection, and re-reading it here would silently lose the detail
     that made the message worth showing. */
  const payload = read !== undefined ? read : await jsonBody(res);
  const said = detailMsg(payload);
  switch (res.status) {
    case 401:
      return new ProviderError(502, 'fal rejected the API key. FAL_KEY on the server is wrong or expired — replace it with a key from fal.ai/dashboard/keys.', false);
    case 403:
      /* fal answers both "your key cannot use this model" and an exhausted
         balance with 403, and only the body tells them apart. */
      return new ProviderError(
        said && /balance|credit|fund/i.test(said) ? 402 : 502,
        said
          ? `fal refused the request: ${said}`
          : 'fal refused the request. The key is either wrong or has no access to this model.',
        false,
      );
    case 402:
      return new ProviderError(402, 'Out of credit at fal. Top up at fal.ai/dashboard/billing.', false);
    case 422:
      return new ProviderError(400, said
        ?? 'fal rejected the request as malformed but named no field.', false);
    case 429:
      return new ProviderError(429, 'fal is rate-limiting this key. Try again in a moment.', true);
    case 500:
    case 502:
    case 503:
    case 504:
      return new ProviderError(503, `fal is failing on its side (HTTP ${res.status}). Try again in a moment.`, true);
    default:
      return new ProviderError(502, `fal answered an unexpected HTTP ${res.status}.`, false);
  }
}

/** fal takes an image anywhere it takes a URL, so the reference never has to be
 *  uploaded anywhere first. Everything upstream of here keeps base64 raw — this
 *  is the single place the container goes back on.
 *
 *  The mime is a parameter now because not every image we send is one we painted:
 *  the plan and the control maps are PNG, and an object photograph is a JPEG (see
 *  `PHOTO_MIME`). Declaring a JPEG as `image/png` is not a harmless label — the
 *  decoder on the other side reads the container, and the plan was to find that
 *  out from a 422 rather than from here. */
export function dataUri(base64: string, mime = 'image/png'): string {
  return `data:${mime};base64,${base64}`;
}

/* ── the request bodies ──────────────────────────────────────────── */

export type FalBody = Record<string, unknown>;
export type BodyFor = (meta: ProviderMeta, args: GenerateArgs) => FalBody;

/* Every fal model here prices per output megapixel *per image*, and every one of
   them takes a `num_images` that fal defaults to 1 — z-image will draw four from
   a single control input. `assertAffordable` checks one image's worth of pixels
   against the ceiling, so the count is pinned in the body rather than left to a
   default: a default that moved under us would multiply what a render actually
   costs by four against a guard that had only ever priced one. Spread into all
   three bodies because it is one decision, not three. */
const BILLED_ONCE = { num_images: 1 } as const;

/** Z-Image Turbo ControlNet, fal-ai/z-image/turbo/controlnet.
 *
 *  The cheap test rig, and the shape is not what the other models use: there is
 *  no separate reference channel at all on this endpoint. `image_url` IS the
 *  control map, and `preprocess: 'none'` is what stops fal running a Canny or
 *  MiDaS detector over it first — with a detector in the path we would be
 *  conditioning on its reading of our drawing instead of on our drawing, which
 *  is the entire thing this rebuild exists to stop doing.
 *
 *  With no control map supplied it falls back to the reference PNG, and that
 *  degrades honestly rather than silently: the reference is already a clean
 *  black-on-white vector line drawing, which is what a line control map is. */
export const zImageBody: BodyFor = (meta, args) => {
  const control = usableControls(meta, args.controls)[0];
  return {
    prompt: args.prompt,
    image_url: dataUri(control ? control.base64 : args.imageBase64),
    image_size: { width: args.width, height: args.height },
    preprocess: 'none',
    control_scale: args.controlScale ?? 0.75,
    /* Hold the geometry from the first step; let go before the end so the last
       fifth of the diffusion is free to put materials and light on it. Both are
       fal's own defaults, restated rather than omitted because the harness will
       sweep them and a default that moves under us is a silent variable. */
    control_start: 0,
    control_end: 0.8,
    /* The turbo schedule tops out here — asking for more is a 422, not a slower
       and better image. */
    num_inference_steps: 8,
    /* Same reason as disable_pup on BFL: a rewriter that invents rooms. fal's
       parameter list also has this one adding 0.0025 credits a request while the
       model page says nothing beyond the per-megapixel rate; false settles the
       disagreement without us having to know which read is right. */
    enable_prompt_expansion: false,
    seed: args.seed,
    output_format: 'png',
    ...BILLED_ONCE,
  };
};

/** Which weights each control kind actually loads on FLUX.1 [dev]. `path` is a
 *  Hugging Face repo id (`variant` is the repo's file variant, not a control
 *  mode — a genuinely easy thing to misread from fal's field list).
 *
 *  There is no entry for 'seg' or 'change' because no segmentation ControlNet is
 *  published for this base model, and a guessed repo id fails at fal with a
 *  message about missing weights rather than about us. `acceptsControls` for
 *  this provider is therefore ['line','depth'] and the filter drops the rest. */
const FLUX_CONTROLNET: Partial<Record<ControlKind, string>> = {
  line: 'InstantX/FLUX.1-dev-Controlnet-Canny',
  depth: 'Shakker-Labs/FLUX.1-dev-ControlNet-Depth',
};

/* fal's own default for `strength` is 0.85, which is a creative-transformation
   setting: at that value the model is re-drawing from noise with the reference
   as a hint, and walls move. Sending nothing is therefore not neutral, it is the
   failure this rebuild is about — so an explicit low value goes in every body.
   0.55 is a starting point and not a tuned number: below about 0.4 the output
   keeps the plan's flat white paper, above about 0.7 the geometry starts to
   wander again. The harness is what will pick the real figure. */
const IMG2IMG_STRENGTH = 0.55;

/** FLUX.1 [dev] + ControlNet, fal-ai/flux-general/image-to-image. The only model
 *  on this list with both a real control map and a negative prompt — FLUX.2 has
 *  neither, and BFL's guide says so outright. */
export const fluxGeneralBody: BodyFor = (meta, args) => {
  /* ONE control map, though `controlnets` is an array and the brief assumed a
     list. fal's own API reference annotates the field "Supports one controlnet
     currently", while the playground form under the same field offers an
     Add-item button — the two reads of the docs disagree, and only one of them is
     about the schema. The array is honoured with a single element because of what
     the other case costs us: a second map that fal accepted and quietly ignored
     would have the harness record a line+depth sweep and actually measure line,
     which is a wrong answer rather than a failed one, and a wrong answer is the
     one failure this whole rebuild cannot afford. A 422 we would at least see.
     The caller's first usable kind wins, so a sweep chooses by ordering its
     list; when fal settles the question, this is the line that changes. */
  const first = usableControls(meta, args.controls).find((c) => FLUX_CONTROLNET[c.kind]);
  const path = first ? FLUX_CONTROLNET[first.kind] : undefined;
  return {
    prompt: args.prompt,
    image_url: dataUri(args.imageBase64),
    strength: args.strength ?? IMG2IMG_STRENGTH,
    image_size: { width: args.width, height: args.height },
    controlnets: first && path ? [{
      path,
      control_image_url: dataUri(first.base64),
      /* fal defaults this to 1, i.e. the map at full weight for the whole run.
         0.75 with an early release is the same bargain z-image gets: geometry
         from the first step, the last fifth left free for materials and light. */
      conditioning_scale: args.controlScale ?? 0.75,
      start_percentage: 0,
      end_percentage: 0.8,
    }] : [],
    /* Low for the same reason [flex]'s guidance is low — arXiv:2404.07724, and a
       reference to be faithful to rather than a sentence to be emphatic about.
       3.5 is also fal's own default here, so this is a restatement, not a change. */
    guidance_scale: 3.5,
    num_inference_steps: 28,
    /* The one place in this whole file where a negative prompt exists, so it names
       the four drifts the research sweep actually measured. */
    negative_prompt: 'dollhouse view, tilted camera, three-quarter perspective, added furniture, text, labels, watermark',
    seed: args.seed,
    output_format: 'png',
    ...BILLED_ONCE,
  };
};

/** Qwen Image Edit Plus, fal-ai/qwen-image-edit-plus. Multi-image editing rather
 *  than control: there is no conditioning strength anywhere in the schema, so
 *  extra maps ride along as more reference pictures exactly the way they do on
 *  FLUX.2 — with the same caveat that nothing says the model reads them as
 *  geometry.
 *
 *  The three-image cap is OURS, not fal's: the docs state no maximum for
 *  `image_urls` and only the worked example happens to pass three. Capped anyway,
 *  because each reference is a megabyte of base64 on a request that already
 *  carries the plan, and an unbounded loop over `args.controls` would size the
 *  upload by whatever the harness felt like emitting that day. */
export const qwenBody: BodyFor = (meta, args) => {
  /* Photographs before conditioning maps, the same order and for the same
     reason as `references()` in bfl.ts: a photo of the actual sofa is what the
     render is for, and a map handed to a model with no control channel is an
     experiment. Two spare slots here, not seven, so the order does real work. */
  const photos = usableRefs(meta, args.refs);
  const extra = (args.controls ?? []).slice(0, Math.max(0, spareSlots(meta) - photos.length));
  const legend = [refLegend(photos, 2, args.prompt), controlLegend(extra, args.prompt)]
    .filter(Boolean).join(' ');
  return {
    prompt: legend ? `${args.prompt} ${legend}` : args.prompt,
    image_urls: [
      dataUri(args.imageBase64),
      ...photos.map((r) => dataUri(r.base64, PHOTO_MIME)),
      ...extra.map((c) => dataUri(c.base64)),
    ],
    image_size: { width: args.width, height: args.height },
    num_inference_steps: 50,
    guidance_scale: 4,
    negative_prompt: 'dollhouse view, tilted camera, three-quarter perspective, added furniture, text, labels, watermark',
    seed: args.seed,
    output_format: 'png',
    ...BILLED_ONCE,
  };
};

/* ── submit and poll ─────────────────────────────────────────────── */

async function falSubmit(meta: ProviderMeta, model: string, build: BodyFor, args: GenerateArgs): Promise<SubmitResult> {
  assertAffordable(meta, args.width, args.height);
  const key = falKey();
  let res: Response;
  try {
    /* Hop-checked like the poll. undici does strip `authorization` across
       origins, so this one is not a key leak — but the body is the plan and the
       prompt, and a redirect off fal.run would POST both to whatever host the
       Location names, with no key to make it fail. The guard is the same either
       way, and a submit that quietly followed a redirect is how the vendor's
       Location header gets to choose where our images go. */
    res = await hopSafeFetch(new URL(`${QUEUE}/${model}`), {
      method: 'POST',
      headers: { authorization: `Key ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(build(meta, args)),
      cache: 'no-store',
      /* Longer than BFL's 30 s: the body carries the reference and every control
         map as base64, so this upload is megabytes, not kilobytes. */
      signal: AbortSignal.timeout(60_000),
    }, falKeyedUrl, OFF_HOST);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw transportFailure(e, 'submit');
  }

  if (!res.ok) throw await httpFailure(res);

  const payload = obj(await jsonBody(res));
  const id = payload ? str(payload.request_id) : null;
  const statusUrl = payload ? str(payload.status_url) : null;
  /* A queued job with no status URL is a job we are paying for and can never
     collect. Loud, not silent. */
  if (!id || !statusUrl) {
    throw new ProviderError(502, 'fal accepted the job but returned no status URL, so the result cannot be collected.', false);
  }
  if (!falKeyedUrl(statusUrl)) {
    throw new ProviderError(502, 'fal returned a status URL that is not an https address on fal.run. Refusing to poll it with the API key attached.', false);
  }
  return {
    id,
    pollUrl: statusUrl,
    /* fal quotes no price at submit and none on the result either; what this
       costs is what `estimateUsd` said before the call, and putting that in
       `cost` would file an estimate as a receipt. */
    cost: null,
    usd: estimateUsd(meta, args.width, args.height),
  };
}

const gone = (error: string, retryable = false): PollResult => ({ status: 'failed', error, retryable });

/** Pulls the finished image URL off the response endpoint. Only ever called once
 *  fal has said COMPLETED, so anything that goes wrong here is terminal for this
 *  job — the run is over either way and re-polling it will not change. */
async function collect(key: string, statusUrl: URL): Promise<PollResult> {
  const target = responseUrlOf(statusUrl);
  let res: Response;
  try {
    res = await hopSafeFetch(target, {
      headers: { authorization: `Key ${key}`, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    }, falKeyedUrl, OFF_HOST);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw transportFailure(e, 'collect the finished render');
  }

  const payload = obj(await jsonBody(res));
  if (!res.ok) {
    /* A run that threw comes back here as a 4xx or 5xx carrying the traceback's
       message in `detail`, never as a FAILED status — see the note at the top.
       A refusal that says nothing about the run, though, says nothing about the
       run: a rejected key or a rate limit leaves the result sitting at fal,
       collectable by the next poll, so it is raised rather than recorded as a
       render that failed. */
    const said = detailMsg(payload) ?? str(payload?.error);
    if (!said || res.status === 401 || res.status === 403 || res.status === 429) {
      throw await httpFailure(res, payload);
    }
    return gone(`The render failed at fal: ${said}`);
  }

  const images = payload?.images;
  const first = Array.isArray(images) ? obj(images[0]) : null;
  const url = first ? str(first.url) : null;
  if (!url) return gone('fal reported the render finished but returned no image URL.');
  /* Checked here rather than at download time so the failure names fal instead
     of arriving as a mystery in the status route. */
  if (!falUrl(url)) return gone('fal returned the finished image on a host outside fal.media. Refusing to fetch it.');
  return { status: 'ready', imageUrl: url, cost: null };
}

async function falPoll(pollUrl: string): Promise<PollResult> {
  const key = falKey();
  const target = falKeyedUrl(pollUrl);
  if (!target) {
    throw new ProviderError(400, 'That polling URL is not an https address on fal.run.', false);
  }

  let res: Response;
  try {
    res = await hopSafeFetch(target, {
      headers: { authorization: `Key ${key}`, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    }, falKeyedUrl, OFF_HOST);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw transportFailure(e, 'poll');
  }

  if (res.status === 404) {
    return gone('fal has no record of this job — a queued request is forgotten once its result has been collected or has expired.');
  }
  if (!res.ok) throw await httpFailure(res);

  const payload = obj(await jsonBody(res));
  const error = str(payload?.error);
  /* fal puts a dead run's message on the status payload as well, and it can be
     there under any status — read it before the enum so a COMPLETED-with-error
     is not chased to the response endpoint for an image that does not exist. */
  if (error) return gone(`The render failed at fal: ${error}`);

  switch (str(payload?.status)) {
    case 'IN_QUEUE':
    case 'IN_PROGRESS':
      /* fal reports a queue position, not a fraction of the work done, and the
         UI shows elapsed seconds rather than either. Nothing here to report. */
      return { status: 'pending', progress: null };
    case 'COMPLETED':
      return collect(key, target);
    default: {
      const said = str(payload?.status);
      /* Terminal on purpose: treating an unknown status as "keep polling" is how
         a client loops for three minutes over a typo. */
      return gone(said
        ? `The render failed at fal, which reported an unrecognised status "${said}".`
        : 'fal answered the poll without a status field.');
    }
  }
}

function falProvider(meta: ProviderMeta, model: string, build: BodyFor): Provider {
  return {
    ...meta,
    submit: (args) => falSubmit(meta, model, build, args),
    poll: falPoll,
    deliveryUrl: falUrl,
    keyedUrl: falKeyedUrl,
    /* No Authorization header: fal.media serves the finished file to anyone with
       the link, and the key has no business leaving fal.run. The hop check stays
       anyway — a redirect off fal.media would make the status route a willing
       proxy for reading anything the server can reach. */
    fetchDelivery: (src, init) => hopSafeFetch(src, init ?? {}, falUrl, OFF_HOST),
  };
}

export const zImageCn: Provider = falProvider(metaOf('z-image-cn'), 'fal-ai/z-image/turbo/controlnet', zImageBody);
export const fluxGeneralCn: Provider = falProvider(metaOf('flux-general-cn'), 'fal-ai/flux-general/image-to-image', fluxGeneralBody);
export const qwenEdit: Provider = falProvider(metaOf('qwen-edit'), 'fal-ai/qwen-image-edit-plus', qwenBody);
