import type { NextRequest } from 'next/server';
import { isCloud } from '@data/config';
import type { RenderSettings } from '@shell/renders';
import {
  DIM_STEP, MAX_OUTPUT_PIXELS, MIN_DIM, MISSING_KEY, MODEL, ProviderError, submit,
  type SubmitResult,
} from '@server/providers/bfl';
import { currentUserId, serverClient, type ServerDb } from '@server/supabase';

/** Hands one render to the provider and returns the handle to poll it with.
 *
 *  Local mode is stateless on purpose — the polling URL travels back through the
 *  client, so nothing there depends on server memory surviving between requests.
 *
 *  Cloud mode is the opposite, and deliberately: the polling URL is written to
 *  the render's row and never leaves the server, so what comes back is a render
 *  id that RLS scopes to the account that owns it. Polling someone else's job is
 *  then not a thing that can be asked for. */

const MAX_PROMPT_CHARS = 8000;

/* With Proxy active Next buffers every request body in memory, caps it at 10 MB,
   and on overflow logs a warning and carries on with a PARTIAL body — the request
   does not fail. A truncated base64 PNG would reach BFL as a corrupt image and
   cost a credit to find that out, so the ceiling here sits well under the cap. */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/* canvas.toDataURL() always returns "data:image/png;base64,…" and BFL wants the
   bare payload. Stripping a container is not a decision taken on the client's
   behalf; sending the prefix through would just be a 422. */
const DATA_URL = /^data:image\/[a-z+]+;base64,/i;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function bad(error: string, status = 400) {
  return Response.json({ error }, { status });
}

/* A token for the client to switch on, not a sentence — the same body the proxy
   answers with, so `src/shell/jobs.ts` turns both into "your session has
   expired" rather than putting the bare word in a toast. */
const unauthenticated = () => Response.json({ error: 'unauthenticated' }, { status: 401 });

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
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
 *  whole point. `model` is the model `submit()` actually used rather than the
 *  one the request named: the row is the receipt for a paid job and must not
 *  claim a model that was never asked for. */
async function record(
  ctx: CloudCtx,
  job: SubmitResult,
  args: { prompt: string; seed: number | null; width: number; height: number },
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
      settings: ctx.settings,
      seed: args.seed,
      model: MODEL,
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

  return Response.json({ renderId: data.id, jobId: job.id });
}

/* ── the route ───────────────────────────────────────────────────── */

export async function POST(request: NextRequest) {
  if (!process.env.FLUX_API_KEY) return bad(MISSING_KEY, 500);

  let parsed: unknown;
  try { parsed = await request.json(); } catch { return bad('The request body is not valid JSON.'); }
  const b = obj(parsed);
  if (!b) return bad('The request body must be a JSON object.');

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

  const width = int(b.width), height = int(b.height);
  if (width === null || height === null) {
    return bad('width and height are required — derive them from the reference canvas so the render keeps the plan\'s aspect ratio.');
  }
  for (const [name, v] of [['width', width], ['height', height]] as const) {
    if (v < MIN_DIM) return bad(`${name} is ${v}; the provider's minimum is ${MIN_DIM}.`);
    if (v % DIM_STEP !== 0) return bad(`${name} is ${v}; the provider only accepts multiples of ${DIM_STEP}. Round down, not up.`);
  }
  if (width * height > MAX_OUTPUT_PIXELS) {
    /* Billed per output megapixel, so this ceiling is also the price ceiling —
       1800×1800 is legal on some models and roughly three times the cost of 1 MP. */
    return bad(`${width}×${height} is ${(width * height / 1e6).toFixed(1)} megapixels; the provider's ceiling is ${MAX_OUTPUT_PIXELS / 1e6} MP, and it bills per megapixel.`);
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
    const job = await submit({ prompt, imageBase64, width, height, seed });
    /* Cost is in credits, 1 credit = $0.01. Logged at submit and again when the
       job settles, because those two figures are not always the same. */
    console.log(`[render] submitted ${job.id} ${MODEL} ${width}×${height} seed=${seed ?? 'random'} cost=${job.cost ?? 'not quoted'}`);
    if (!ctx) return Response.json({ jobId: job.id, pollUrl: job.pollUrl });
    return await record(ctx, job, { prompt, seed, width, height });
  } catch (e) {
    if (e instanceof ProviderError) {
      console.warn(`[render] submit refused (${e.status}): ${e.message}`);
      return Response.json({ error: e.message, retryable: e.retryable }, { status: e.status });
    }
    throw e;
  }
}
