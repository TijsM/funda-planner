import type { NextRequest } from 'next/server';
import { isCloud } from '@data/config';
import { RENDER_BUCKET, renderImagePath, type RenderRow } from '@data/schema';
import { MISSING_KEY, ProviderError, bflUrl, hopSafeFetch, poll } from '@server/providers/bfl';
import { currentUserId, serverClient, type ServerDb } from '@server/supabase';

/** Polls one job and, the moment it is ready, collects the bytes.
 *
 *  Downloading them here is not an optimisation: the finished image sits on
 *  `delivery.*.bfl.ai`, which serves no CORS headers, so the browser cannot
 *  fetch it at all — and the signed URL dies after ten minutes regardless.
 *
 *  Where they go afterwards is the one difference between the two modes. Local
 *  mode hands them back base64 in the same response, to IndexedDB. Cloud mode
 *  puts them in the private Storage bucket under the owner's uuid and answers
 *  with a signed URL, and it takes the polling URL from the render's row rather
 *  than from the query string — which is what stops one account polling
 *  another's job. */

/* A 4 MP PNG is a few MB; anything an order of magnitude past that is not our
   render and should not be turned into a base64 string in memory. */
const MAX_DELIVERY_BYTES = 32 * 1024 * 1024;

/* Long enough to look at a filmstrip and download a few, short enough that a
   URL copied out of devtools is not a permanent handle on the image. */
const SIGNED_URL_TTL_S = 3600;

/* The polling URL arrives from the client, and this route attaches our API key
   to whatever it names — so `bflUrl` is the line between polling a job and
   handing FLUX_API_KEY to any host an attacker picks. It lives in the provider
   next to the fetch that trusts it, because two copies of a check like this one
   is two copies to keep in step. */

function failed(error: string, status: number, retryable = false) {
  return Response.json({ status: 'failed', error, retryable }, { status });
}

/* Same token the proxy answers with — `src/shell/jobs.ts` switches on the 401
   before it reads the body, so this is never shown to anyone. */
const unauthenticated = () => Response.json({ error: 'unauthenticated' }, { status: 401 });

/* ── collecting the finished image ───────────────────────────────── */

type Delivered =
  | { ok: true; bytes: ArrayBuffer; contentType: string }
  | { ok: false; error: string; status: number; retryable: boolean };

const undelivered = (error: string, status: number, retryable = false): Delivered =>
  ({ ok: false, error, status, retryable });

/** Pulls the finished PNG off the delivery host. Every failure is phrased for
 *  the person waiting and says whether polling again can help — the caller
 *  decides what that means for the record it is holding. */
async function deliver(imageUrl: string): Promise<Delivered> {
  /* The delivery host is a different name under the same domain, so it goes
     through the same check — and it gets no x-key: the URL is already signed and
     the key has no business leaving api.bfl.ai. */
  const src = bflUrl(imageUrl);
  if (!src) return undelivered('The provider returned the finished image on a host outside bfl.ai. Refusing to fetch it.', 502);

  let res: Response;
  try {
    /* Same hop-by-hop check as the poll. This fetch carries no key, but a
       redirect off bfl.ai would still make this route a willing proxy for
       reading anything the server can reach — link-local metadata included. */
    res = await hopSafeFetch(src, { cache: 'no-store', signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    if (e instanceof ProviderError) return undelivered(e.message, e.status, e.retryable);
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return undelivered(
      timedOut
        ? 'The finished render did not download within a minute.'
        : `Could not download the finished render (${e instanceof Error ? e.message : 'unknown network error'}).`,
      504, true,
    );
  }
  if (!res.ok) {
    /* 403/404 here is almost always the ten-minute signature expiring between
       the poll saying Ready and this fetch — polling again will not bring it back. */
    const expired = res.status === 403 || res.status === 404;
    return undelivered(
      expired
        ? 'The finished render expired before it could be downloaded — the provider keeps it for ten minutes.'
        : `The provider served the finished render as HTTP ${res.status}.`,
      502, !expired,
    );
  }

  const contentType = res.headers.get('content-type') ?? '';
  /* An HTML error page would base64 just as happily as a PNG and land in the
     filmstrip as a broken thumbnail with no explanation. */
  if (!contentType.startsWith('image/')) {
    return undelivered(`The provider served the finished render as ${contentType || 'an unlabelled type'}, not an image.`, 502);
  }

  const tooBig = (bytes: number) =>
    undelivered(`The finished render is ${(bytes / 1024 / 1024).toFixed(1)} MB, past the ${MAX_DELIVERY_BYTES / 1024 / 1024} MB this route will hold in memory.`, 502);

  /* Checked before reading the body, not after: arrayBuffer() on a two-gigabyte
     response has already happened by the time a size check downstream of it can
     complain, which is the failure the ceiling exists to prevent. */
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DELIVERY_BYTES) return tooBig(declared);

  const bytes = await res.arrayBuffer();
  /* A missing or lying content-length still gets caught, just later. */
  if (bytes.byteLength > MAX_DELIVERY_BYTES) return tooBig(bytes.byteLength);

  return { ok: true, bytes, contentType };
}

/* ── local mode: bytes back through the response ─────────────────── */

async function local(q: URLSearchParams): Promise<Response> {
  const jobId = q.get('jobId') ?? '';
  const raw = q.get('pollUrl') ?? '';
  if (!raw) return failed('No pollUrl was given, so there is no job to poll.', 400);

  const target = bflUrl(raw);
  if (!target) return failed('The pollUrl is not an https URL on bfl.ai. Refusing to send the API key to it.', 400);

  let result;
  try {
    result = await poll(target.toString());
  } catch (e) {
    if (e instanceof ProviderError) {
      console.warn(`[render] poll refused ${jobId} (${e.status}): ${e.message}`);
      return failed(e.message, e.status, e.retryable);
    }
    throw e;
  }

  if (result.status !== 'ready') {
    if (result.status === 'failed') console.warn(`[render] failed ${jobId}: ${result.error}`);
    return Response.json(result);
  }

  const image = await deliver(result.imageUrl);
  if (!image.ok) return failed(image.error, image.status, image.retryable);

  const buf = Buffer.from(image.bytes);
  console.log(`[render] ready ${jobId} ${buf.byteLength} bytes cost=${result.cost ?? 'not quoted'}`);
  return Response.json({
    status: 'ready',
    image: buf.toString('base64'),
    contentType: image.contentType,
    bytes: buf.byteLength,
    cost: result.cost,
  });
}

/* ── cloud mode: bytes to Storage, a signed URL back ─────────────── */

type Row = Pick<RenderRow,
  'id' | 'status' | 'error' | 'provider_job_id' | 'provider_poll_url' | 'image_path'
  | 'bytes' | 'created_at'>;

const COLUMNS = 'id, status, error, provider_job_id, provider_poll_url, image_path, bytes, created_at';

/** How long the render actually took, measured from the row rather than from
 *  anything the client says — the clock that matters is the one that started
 *  when the credit was spent. */
const elapsed = (createdAt: string): number => {
  const started = Date.parse(createdAt);
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
};

/** The image's real dimensions, read straight out of the PNG's IHDR: 8 bytes of
 *  signature, a 4-byte length and the chunk type, then width and height as
 *  big-endian uint32s. Recorded because the provider is free to round the size
 *  it was asked for, and a row that repeats the request rather than describing
 *  the file is a row that lies about what is in the bucket. Returns null for
 *  anything that is not a PNG, in which case the requested size stands. */
function pngSize(bytes: ArrayBuffer): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  const v = new DataView(bytes);
  if (v.getUint32(0) !== 0x89504e47 || v.getUint32(4) !== 0x0d0a1a0a) return null;
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** Marks a render settled and failed, then says so. Used only where the failure
 *  is terminal: a retryable one leaves the row pending, because the next poll
 *  finds the same job still sitting at the provider, finished and collectable. */
async function settleFailed(
  db: ServerDb, row: Row, error: string, status: number, retryable = false,
): Promise<Response> {
  await db
    .from('renders')
    .update({ status: 'failed', error, settled_at: new Date().toISOString(), duration_ms: elapsed(row.created_at) })
    .eq('id', row.id);
  console.warn(`[render] failed ${row.provider_job_id ?? 'unsubmitted'} render=${row.id}: ${error}`);
  /* `retryable` here means "generating it again could work" — a re-roll, a new
     row. It never means "poll this one again": this row is settled. */
  return failed(error, status, retryable);
}

/** A signed URL for a render whose bytes are already in the bucket. Signed per
 *  request rather than stored: the URL expires, the row does not. */
async function ready(db: ServerDb, row: Row, path: string, bytes: number): Promise<Response> {
  const { data, error } = await db.storage.from(RENDER_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_S);
  if (error || !data?.signedUrl) {
    /* The bytes are there and the row is right — only the link failed, so this
       is not a failed render and must not be recorded as one. */
    return failed('The render finished and is stored, but a link to it could not be created just now. Reopen the renders panel to try again.', 502, true);
  }
  return Response.json({ status: 'ready', renderId: row.id, imageUrl: data.signedUrl, bytes });
}

async function cloud(q: URLSearchParams): Promise<Response> {
  const db = await serverClient();
  const owner = db ? await currentUserId(db) : null;
  if (!db || !owner) return unauthenticated();

  const renderId = (q.get('renderId') ?? '').trim();
  if (!renderId) return failed('No renderId was given, so there is no render to poll.', 400);

  /* RLS scopes this to the caller's own rows, so "not found" and "not yours"
     are the same answer — which is the point. */
  const { data: row } = await db.from('renders').select(COLUMNS).eq('id', renderId).maybeSingle();
  if (!row) return failed('This account has no render with that id — it was deleted, or it finished on another device.', 404);

  /* Settled rows are answered from the row. Re-polling a job the provider has
     already forgotten is how a finished render turns into "Task not found". */
  if (row.status === 'ready') {
    const path = row.image_path;
    if (!path) return failed('This render is marked finished but no image was stored for it, so there is nothing to show.', 502);
    return ready(db, row, path, row.bytes);
  }
  if (row.status === 'failed') {
    return Response.json({ status: 'failed', error: row.error ?? 'This render failed, and the reason was not recorded.' });
  }

  /* Never from the query string. A pending row with no polling URL cannot ever
     settle, so it is closed here rather than polled forever. */
  if (!row.provider_poll_url) {
    return settleFailed(db, row, 'This render was never handed to the provider, so there is nothing to wait for. Generate it again.', 502);
  }

  let result;
  try {
    result = await poll(row.provider_poll_url);
  } catch (e) {
    if (e instanceof ProviderError) {
      console.warn(`[render] poll refused ${row.provider_job_id ?? '?'} render=${row.id} (${e.status}): ${e.message}`);
      /* A capacity or transport refusal says nothing about the job, which is
         still running and still costs the same — only a terminal refusal, a
         rejected key or a job the provider disowns, settles the row. */
      if (e.retryable) return failed(e.message, e.status, true);
      return settleFailed(db, row, e.message, e.status);
    }
    throw e;
  }

  if (result.status === 'pending') return Response.json({ status: 'pending', progress: result.progress });
  if (result.status === 'failed') return settleFailed(db, row, result.error, 200, result.retryable);

  const image = await deliver(result.imageUrl);
  if (!image.ok) {
    if (image.retryable) return failed(image.error, image.status, true);
    return settleFailed(db, row, image.error, image.status);
  }

  const path = renderImagePath(owner, row.id);
  const { error: upload } = await db.storage
    .from(RENDER_BUCKET)
    .upload(path, image.bytes, { contentType: 'image/png', upsert: true });
  if (upload) {
    /* The bytes exist and the credit is spent, but they are not anywhere this
       account can read them — so the row must not claim a size it cannot serve.
       The bucket refuses anything but image/png and anything over 20 MB, and
       both of those arrive here as this one message. */
    console.warn(`[render] upload refused render=${row.id}: ${upload.message}`);
    return settleFailed(
      db, row,
      `The render was generated but could not be stored in your account (${upload.message}), so it is gone. The credit is spent — try again.`,
      502,
    );
  }

  const size = pngSize(image.bytes);
  /* `.select()` on an update is the only way to learn how many rows it touched:
     supabase-js answers a match of nothing with `error: null` like any other
     success, and the row can genuinely be gone by now — deleting the plan while
     the PNG was downloading and uploading cascades this row away underneath us. */
  const { data: recorded, error: written } = await db
    .from('renders')
    .update({
      status: 'ready',
      image_path: path,
      bytes: image.bytes.byteLength,
      ...(size ?? {}),
      settled_at: new Date().toISOString(),
      duration_ms: elapsed(row.created_at),
    })
    .eq('id', row.id)
    .select('id');
  if (written) {
    /* Stored but unrecorded: the filmstrip reads rows, not the bucket, so a row
       still saying "pending" is a render that never appears. */
    console.warn(`[render] could not record ready render=${row.id}: ${written.message}`);
    return failed('The render finished and is stored, but your account could not be updated to say so. Reopen the renders panel in a moment.', 502, true);
  }
  if (!recorded?.length) {
    /* The object just uploaded is now unreachable: nothing points at it, no UI
       can show it and the delete-all figure cannot count it, so it is removed
       here rather than left billed for forever. Answering `ready` for a row that
       no longer exists would also put the render back on the screen of someone
       who deleted it. */
    await db.storage.from(RENDER_BUCKET).remove([path]);
    console.warn(`[render] row gone before the upload landed render=${row.id}; removed ${path}`);
    return failed('This render was deleted while it was finishing, so there is nothing left to show.', 404);
  }

  console.log(`[render] ready ${row.provider_job_id ?? '?'} render=${row.id} ${image.bytes.byteLength} bytes cost=${result.cost ?? 'not quoted'}`);
  return ready(db, row, path, image.bytes.byteLength);
}

/* ── the route ───────────────────────────────────────────────────── */

export async function GET(request: NextRequest) {
  if (!process.env.FLUX_API_KEY) return failed(MISSING_KEY, 500);
  /* The mode decides, not which query parameters turned up — a cloud deployment
     handed `?pollUrl=` is a client bug, and serving it would be an unauthenticated
     poll of whatever job the caller named. */
  const q = request.nextUrl.searchParams;
  return isCloud() ? cloud(q) : local(q);
}
