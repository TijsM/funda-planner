import type { NextRequest } from 'next/server';
import {
  DIM_STEP, MAX_OUTPUT_PIXELS, MIN_DIM, MISSING_KEY, MODEL, ProviderError, submit,
} from '../../../src/server/providers/bfl';

/** Hands one render to the provider and returns the handle to poll it with.
 *  Stateless on purpose — the polling URL travels back through the client, so
 *  nothing here depends on server memory surviving between requests. */

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

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

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

  try {
    const job = await submit({ prompt, imageBase64, width, height, seed });
    /* Cost is in credits, 1 credit = $0.01. Logged at submit and again when the
       job settles, because those two figures are not always the same. */
    console.log(`[render] submitted ${job.id} ${MODEL} ${width}×${height} seed=${seed ?? 'random'} cost=${job.cost ?? 'not quoted'}`);
    return Response.json({ jobId: job.id, pollUrl: job.pollUrl });
  } catch (e) {
    if (e instanceof ProviderError) {
      console.warn(`[render] submit refused (${e.status}): ${e.message}`);
      return Response.json({ error: e.message, retryable: e.retryable }, { status: e.status });
    }
    throw e;
  }
}
