import type { NextRequest } from 'next/server';
import { isCloud } from '@data/config';
import type { RenderSettings } from '@shell/renders';
import {
  CONTROL_KINDS, MAX_USD_PER_IMAGE, missingEnvMessage, overCeiling, type ControlKind,
} from '@data/providers';
import {
  DEFAULT_PROVIDER, PROVIDERS, ProviderError, assertAffordable,
  type ControlImage, type Provider, type SubmitResult,
} from '@server/providers';
import { currentUserId, serverClient, type ServerDb } from '@server/supabase';

/** Hands one render to the provider and returns the handle to poll it with.
 *
 *  Local mode is stateless on purpose — the polling URL travels back through the
 *  client, so nothing there depends on server memory surviving between requests.
 *
 *  Cloud mode is the opposite, and deliberately: the polling URL is written to
 *  the render's row and never leaves the server, so what comes back is a render
 *  id that RLS scopes to the account that owns it. Polling someone else's job is
 *  then not a thing that can be asked for.
 *
 *  Which provider drew it is now part of the request, and everything that used
 *  to be a constant imported from `bfl.ts` — the dimension step, the pixel
 *  ceiling, the name on the record — is read off the resolved provider instead.
 *  Two consequences worth stating: an unknown id is refused rather than quietly
 *  swapped for the default (a render billed to a model nobody chose is worse
 *  than an error), and the spending ceiling is asserted here as well as inside
 *  `submit()`, because this route is where a person's money is committed and a
 *  refusal that arrives with the price in it is the only actionable kind. */

const MAX_PROMPT_CHARS = 8000;

/* With Proxy active Next buffers every request body in memory, caps it at 10 MB,
   and on overflow logs a warning and carries on with a PARTIAL body — the request
   does not fail. A truncated base64 PNG would reach the provider as a corrupt
   image and cost a credit to find that out, so the ceiling here sits well under
   the cap — and now that a request can carry conditioning maps as well as the
   reference, the figure that has to stay under it is the TOTAL. One 6 MB
   reference plus four 6 MB maps is 30 MB, which is not refused anywhere upstream
   of here: it is silently cut in half and submitted. */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;

/* Four, because there are exactly four kinds of control map. A fifth is either
   the same kind twice or a caller looping over something it should not be. */
const MAX_CONTROLS = 4;

/* The ceiling prices OUTPUT megapixels, because that is what BFL's pricing page
   prices. This feature multiplied the input ones: before it a request carried one
   1800 px reference, and now it can carry that plus four maps the same size, so
   what we upload went from about 3 MP to about 16. If input megapixels are ever
   billed — BFL meters them, `input_mp` comes back on every submit, and nothing we
   have proves they are free — then the dime ceiling is wrong by whatever multiple
   we happen to be uploading. Two answers, both here: this bound, so the exposure
   is a number rather than whatever a client felt like sending, and the quoted-cost
   check after submit, which is what would actually discover it. */
const MAX_INPUT_MEGAPIXELS = 16;

/* PNG only, and the header is enough: bytes 0-7 are the signature, 8-15 the IHDR
   length and type, 16-23 width and height, big-endian. Reading it is also the
   first check anywhere that these bytes are a PNG at all — until now a base64
   payload of the right shape and size went through to the vendor to be found out
   there, at the price of a credit. */
function pngDims(base64: string): { width: number; height: number } | null {
  /* 44 base64 chars decode to 33 bytes, which is eight more than IHDR needs. */
  const head = Buffer.from(base64.slice(0, 44), 'base64');
  if (head.length < 24) return null;
  if (head.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') return null;
  if (head.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = head.readUInt32BE(16), height = head.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/* canvas.toDataURL() always returns "data:image/png;base64,…" and the providers
   want the bare payload. Stripping a container is not a decision taken on the
   client's behalf; sending the prefix through would just be a 422. */
const DATA_URL = /^data:image\/[a-z+]+;base64,/i;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function bad(error: string, status = 400) {
  return Response.json({ error }, { status });
}

/* A token for the client to switch on, not a sentence — the same body the proxy
   answers with, so `src/shell/jobs.ts` turns both into "your session has
   expired" rather than putting the bare word in a toast. */
const unauthenticated = () => Response.json({ error: 'unauthenticated' }, { status: 401 });

/* Local on purpose, and not the same functions as the ones `@server/providers`
   exports under these names: those read a vendor's answer, these read a request
   body, and `str` here TRIMS what it returns. A provider id arriving as
   " z-image-cn" must resolve, whereas trimming a vendor's own string would be
   editing evidence. Import the other pair here and every id in this file becomes
   whitespace-sensitive. */
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/* ── which provider ──────────────────────────────────────────────── */

/** The provider named in the request, or the one every existing client gets by
 *  saying nothing at all.
 *
 *  An id that is not in the registry is a 400 that lists the ones that are —
 *  unlike `providerOf`, which falls back on purpose because it reads ids off
 *  stored rows written by older builds. A request is not a stored row: a client
 *  asking for a provider this server does not have is a client whose picker is
 *  out of date, and rendering on something else at another price is not a
 *  reasonable way to tell it so. */
function pick(id: string | null): Provider | Response {
  if (!id) return PROVIDERS[DEFAULT_PROVIDER];
  const provider = PROVIDERS[id];
  if (!provider) {
    return bad(`There is no image provider called "${id}". The ones this server can use are ${Object.keys(PROVIDERS).join(', ')}.`);
  }
  return provider;
}

/* ── the conditioning maps ───────────────────────────────────────── */

/** The control maps, checked for shape and size and for nothing else.
 *
 *  In particular the kinds are NOT filtered against `acceptsControls` here. A
 *  provider with no control channel still has spare reference slots, and sending
 *  a depth map into one is the experiment this rebuild exists to run — dropping
 *  it at the boundary because the metadata says "no controls" would defeat that
 *  silently. Each provider decides what to do with what it is given; this route
 *  only refuses what cannot be a PNG. */
function controlsOf(v: unknown, refBytes: number): ControlImage[] | Response {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return bad('controls must be an array of { kind, base64 } objects.');
  if (v.length > MAX_CONTROLS) {
    return bad(`${v.length} control maps were sent; there are only ${MAX_CONTROLS} kinds, so the ceiling is ${MAX_CONTROLS}.`);
  }

  const out: ControlImage[] = [];
  let bytes = refBytes;
  for (const [i, raw] of v.entries()) {
    const c = obj(raw);
    const kind = c ? str(c.kind) : null;
    if (!c || !kind) return bad(`Control map ${i + 1} does not say what kind of map it is.`);
    if (!CONTROL_KINDS.includes(kind as ControlKind)) {
      return bad(`Control map ${i + 1} calls itself a "${kind}" map; the kinds that exist are ${CONTROL_KINDS.join(', ')}.`);
    }

    const base64 = (typeof c.base64 === 'string' ? c.base64 : '').replace(DATA_URL, '').trim();
    if (!base64) return bad(`The ${kind} control map carries no image data.`);
    if (!BASE64.test(base64)) {
      return bad(`The ${kind} control map is not base64 — send the PNG payload, not a URL or raw bytes.`);
    }
    const size = Buffer.byteLength(base64, 'utf8');
    if (size > MAX_IMAGE_BYTES) {
      return bad(`The ${kind} control map is ${(size / 1024 / 1024).toFixed(1)} MB of base64; the ceiling for one image is ${MAX_IMAGE_BYTES / 1024 / 1024} MB. Paint it at a smaller maxPx.`, 413);
    }
    bytes += size;
    /* Checked as it accumulates rather than at the end, so the refusal names the
       map that took the request over instead of the last one in the array. */
    if (bytes > MAX_TOTAL_IMAGE_BYTES) {
      return bad(`The reference image and ${i + 1} control map${i ? 's' : ''} come to ${(bytes / 1024 / 1024).toFixed(1)} MB of base64; the ceiling for one request is ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024} MB. Send fewer maps, or paint them at a smaller maxPx.`, 413);
    }

    out.push({ kind: kind as ControlKind, base64 });
  }
  return out;
}

/* ── the cloud half ──────────────────────────────────────────────── */

/** Everything the row needs that the provider does not care about, resolved
 *  before a credit is spent. A render nobody can attach to a plan is a render
 *  nobody can collect, and finding that out after the submit means paying for
 *  the discovery. */
interface CloudCtx {
  db: ServerDb;
  owner: string;
  planId: string;
  clientId: string;
  floorId: string;
  parentId: string | null;
  settings: RenderSettings;
}

async function cloudContext(b: Record<string, unknown>): Promise<CloudCtx | Response> {
  const db = await serverClient();
  const owner = db ? await currentUserId(db) : null;
  if (!db || !owner) return unauthenticated();

  const planClientId = str(b.planClientId);
  const clientId = str(b.renderClientId);
  const floorId = str(b.floorId);
  if (!planClientId || !clientId || !floorId) {
    return bad('The render does not say which plan, floor and record it belongs to, so there would be no way to match the result back to the filmstrip.');
  }
  const settings = obj(b.settings);
  /* Kept because re-running a render needs the exact settings that produced it —
     a row without them can be looked at but never repeated. */
  if (!settings) return bad('The render settings are missing, so this render could never be re-run from the filmstrip.');

  const { data: plan } = await db
    .from('plans')
    .select('id')
    .eq('client_id', planClientId)
    .is('deleted_at', null)
    .maybeSingle();
  /* 409, not 404: nothing is wrong with the request, the plan simply has not
     been pushed up yet. The next autosave tick fixes it on its own. */
  if (!plan) {
    return bad('This plan has not finished saving to your account yet, so there is nothing to attach the render to. Wait a few seconds and press Generate again.', 409);
  }

  return {
    db,
    owner,
    planId: plan.id,
    clientId,
    floorId,
    parentId: str(b.parentId),
    settings: settings as unknown as RenderSettings,
  };
}

/** Records the submitted job against the account and answers with its row id.
 *
 *  The row is the only handle the browser gets — no polling URL, which is the
 *  whole point.
 *
 *  `model` carries the PROVIDER ID, not the vendor's model string, and it is the
 *  provider that was actually used rather than the one the request named: the
 *  row is the receipt for a paid job, and it is also the only thing that can
 *  poll that job again, since the status route has to pick the same host
 *  allowlist and the same key. The id is stable by contract and the vendor's own
 *  model string is a property of it, so nothing is lost. Rows written before
 *  this change say `flux-2-max`, which is not a provider id — `providerOf` falls
 *  back to `flux2-max` for it, which is exactly the provider that drew them, so
 *  every old row stays pollable with no migration. */
async function record(
  ctx: CloudCtx,
  provider: Provider,
  job: SubmitResult,
  args: { prompt: string; seed: number | null; width: number; height: number },
  /* Not written to the row — there is no column for a quote, and inventing a
     migration for a number the vendor may not send is not worth it — but it
     travels back with the render id so the panel can say the same thing in cloud
     mode that it says locally. */
  quote: { quotedUsd: number | null; estimatedUsd: number | null; overCeiling: boolean },
): Promise<Response> {
  const { data, error } = await ctx.db
    .from('renders')
    .insert({
      owner_id: ctx.owner,
      plan_id: ctx.planId,
      client_id: ctx.clientId,
      floor_id: ctx.floorId,
      parent_id: ctx.parentId,
      prompt: args.prompt,
      /* The provider forced to the one that was actually billed, not the one the
         settings happened to name. `b.provider` wins over `b.settings.provider`
         when they disagree, and a row that quotes one model in `model` and another
         in its re-run recipe is a receipt for a render nobody can reproduce: "use
         these settings" would draw on the wrong model, at the wrong price, and the
         filmstrip would keep insisting it was the first one. */
      settings: { ...ctx.settings, provider: provider.id },
      seed: args.seed,
      model: provider.id,
      width: args.width,
      height: args.height,
      status: 'pending',
      provider_job_id: job.id,
      provider_poll_url: job.pollUrl,
    })
    .select('id')
    .single();

  if (error || !data) {
    /* The job is running and paid for, and the polling URL deliberately never
       reaches the browser — so without this row it is genuinely uncollectable.
       Loud, and honest about the credit. */
    console.warn(`[render] could not record ${job.id}: ${error?.message ?? 'the insert returned no row'}`);
    return bad('The render was submitted and is being generated, but it could not be saved to your account, so there is no way to collect it. The credit is spent — try again.', 502);
  }

  return Response.json({ renderId: data.id, jobId: job.id, ...quote });
}

/* ── the route ───────────────────────────────────────────────────── */

export async function POST(request: NextRequest) {
  let parsed: unknown;
  try { parsed = await request.json(); } catch { return bad('The request body is not valid JSON.'); }
  const b = obj(parsed);
  if (!b) return bad('The request body must be a JSON object.');

  /* Ahead of every check on the request's own contents: which provider this is
     decides what the limits below even are, and a deployment missing the key is
     a problem no wording about the prompt would help anyone find.

     Two places to look, and not because either is optional. The picker writes
     its choice into the render settings, which is what re-running a render reads
     back, and the client also sends it plainly because local mode has no
     settings at all. Reading only the plain field would let a row whose settings
     say z-image-cn be drawn by flux2-max at ten times the price, and the row
     would then be unreproducible — so the settings are honoured when the plain
     field is absent rather than treated as decoration. */
  const provider = pick(str(b.provider) ?? str(obj(b.settings)?.provider));
  if (provider instanceof Response) return provider;
  if (!process.env[provider.needsEnv]) return bad(missingEnvMessage(provider), 500);

  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  if (!prompt.trim()) return bad('The prompt is empty — there is nothing to render.');
  if (prompt.length > MAX_PROMPT_CHARS) {
    return bad(`The prompt is ${prompt.length} characters; the ceiling is ${MAX_PROMPT_CHARS}.`);
  }

  const imageBase64 = (typeof b.imageBase64 === 'string' ? b.imageBase64 : '').replace(DATA_URL, '').trim();
  if (!imageBase64) return bad('No reference image was sent — the render is conditioned on it, so it is not optional.');
  const bytes = Buffer.byteLength(imageBase64, 'utf8');
  if (bytes > MAX_IMAGE_BYTES) {
    return bad(`The reference image is ${(bytes / 1024 / 1024).toFixed(1)} MB of base64; the ceiling is ${MAX_IMAGE_BYTES / 1024 / 1024} MB. Render it at a smaller maxPx.`, 413);
  }
  if (!BASE64.test(imageBase64)) return bad('The reference image is not base64 — send the PNG payload, not a URL or raw bytes.');

  const controls = controlsOf(b.controls, bytes);
  if (controls instanceof Response) return controls;

  /* Every uploaded pixel counted together, once the payload is known to be
     well-formed. Per-image byte ceilings do not bound this: PNG of a line drawing
     is mostly flat white and compresses to almost nothing, so five maps can sit
     inside 8 MB of base64 and still be 16 megapixels of image. */
  let inputPixels = 0;
  for (const [what, payload] of [['reference image', imageBase64] as const,
    ...controls.map(c => [`${c.kind} control map`, c.base64] as const)]) {
    const d = pngDims(payload);
    if (!d) return bad(`The ${what} is not a PNG — the reference and every control map are painted by us as PNG, so this is a client sending something else.`);
    inputPixels += d.width * d.height;
  }
  if (inputPixels > MAX_INPUT_MEGAPIXELS * 1e6) {
    return bad(`The reference image and ${controls.length} control map${controls.length === 1 ? '' : 's'} come to ${(inputPixels / 1e6).toFixed(1)} megapixels of upload; the ceiling is ${MAX_INPUT_MEGAPIXELS} MP. Paint them at a smaller maxPx.`, 413);
  }

  const width = int(b.width), height = int(b.height);
  if (width === null || height === null) {
    return bad('width and height are required — derive them from the reference canvas so the render keeps the plan\'s aspect ratio.');
  }
  for (const [name, v] of [['width', width], ['height', height]] as const) {
    if (v < provider.minDim) return bad(`${name} is ${v}; ${provider.label}'s minimum is ${provider.minDim}.`);
    if (v % provider.dimStep !== 0) {
      return bad(`${name} is ${v}; ${provider.label} only accepts multiples of ${provider.dimStep}. Round down, not up.`);
    }
  }
  if (width * height > provider.maxOutputPixels) {
    return bad(`${width}×${height} is ${(width * height / 1e6).toFixed(1)} megapixels; ${provider.label} cannot draw more than ${provider.maxOutputPixels / 1e6} MP.`);
  }

  /* The model's own ceiling and the budget's are different numbers and the
     budget is the smaller one, so this is not the same check twice: it is what
     turns "the model allows 4 MP" into "you may spend a dime". Asserted here as
     well as inside `submit()` because the eval harness calls providers directly
     and the ceiling belongs to spending money, not to this route — and because
     the message it throws carries the price and the ceiling, which is the only
     form of "no" a person can do anything with. */
  try {
    assertAffordable(provider, width, height);
  } catch (e) {
    if (e instanceof ProviderError) return bad(e.message, e.status);
    throw e;
  }

  /* Same two places as the provider, for the same reason: the panel's dial is
     stored in the settings and a dial the route drops is a dial that silently
     does nothing. `strength` deliberately has no such field — nothing on the
     panel sets it, and each provider's own low starting value is a considered
     number the harness will move, not a default to be overridden from a request. */
  const rawScale = b.controlScale ?? obj(b.settings)?.controlScale;
  let controlScale: number | undefined;
  if (rawScale !== undefined && rawScale !== null) {
    if (typeof rawScale !== 'number' || !Number.isFinite(rawScale) || rawScale < 0 || rawScale > 1) {
      return bad('controlScale must be a number between 0 and 1 — it is normalised across providers, not a vendor\'s own scale.');
    }
    controlScale = rawScale;
  }

  let seed: number | null = null;
  if (b.seed !== undefined && b.seed !== null) {
    const s = int(b.seed);
    if (s === null || s < 0 || s > 4294967295) {
      return bad('The seed must be a whole number between 0 and 4294967295, or left out for a random one.');
    }
    seed = s;
  }

  /* Which mode this is comes from the environment, never from which fields
     arrived: a cloud deployment handed a local-shaped request is a client bug,
     and answering it with an unauthenticated render is how that bug becomes a
     free renderer for anyone who finds the URL. */
  let ctx: CloudCtx | null = null;
  if (isCloud()) {
    const resolved = await cloudContext(b);
    if (resolved instanceof Response) return resolved;
    ctx = resolved;
  }

  try {
    const job = await provider.submit({ prompt, imageBase64, controls, width, height, seed, controlScale });
    /* Three figures, deliberately not one. `usd` is what we priced this at before
       committing — our own arithmetic; `cost` is the vendor's quote in its own
       unit; `quotedUsd` is that quote in dollars where the unit is known. The
       metered megapixels are logged beside them because they are what would
       explain a disagreement: if `inputMp` ever moves the price, the ceiling has
       been pricing the wrong half of the request. */
    const meter = job.metered
      ? ` inMp=${job.metered.inputMp ?? '?'} outMp=${job.metered.outputMp ?? '?'}`
      : '';
    console.log(`[render] submitted ${job.id} ${provider.id} ${width}×${height} seed=${seed ?? 'random'} maps=${controls.length}/${(inputPixels / 1e6).toFixed(1)}MP cost=${job.cost ?? 'not quoted'} quoted=${job.quotedUsd ?? 'unconvertible'} usd=${job.usd ?? 'unpriced'}${meter}`);

    /* The ceiling can only ever be asserted before the money is gone, so this
       cannot refuse anything — but a vendor quoting more than a dime means
       `estimateUsd` is pricing the wrong thing, and every check it has passed
       since was theatre. Loud here, and passed back so the panel can say it to
       the person who just paid it rather than leaving it in a server log nobody
       reads. */
    const over = overCeiling(job.quotedUsd);
    if (over) {
      console.error(`[render] OVER CEILING: ${provider.id} quoted $${job.quotedUsd?.toFixed(3)} for ${width}×${height} against a $${MAX_USD_PER_IMAGE.toFixed(2)} ceiling — estimateUsd said $${job.usd?.toFixed(3) ?? '?'}. Stop rendering on this provider until the rate is corrected in src/data/providers.ts.`);
    }
    const quote = { quotedUsd: job.quotedUsd ?? null, estimatedUsd: job.usd ?? null, overCeiling: over };
    if (!ctx) return Response.json({ jobId: job.id, pollUrl: job.pollUrl, provider: provider.id, ...quote });
    return await record(ctx, provider, job, { prompt, seed, width, height }, quote);
  } catch (e) {
    if (e instanceof ProviderError) {
      console.warn(`[render] submit refused by ${provider.id} (${e.status}): ${e.message}`);
      return Response.json({ error: e.message, retryable: e.retryable }, { status: e.status });
    }
    throw e;
  }
}
