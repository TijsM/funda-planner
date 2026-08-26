import type { NextRequest } from 'next/server';
import { isCloud } from '@data/config';
import { missingEnvMessage } from '@data/providers';
import { RENDER_BUCKET, renderImagePath, type RenderRow } from '@data/schema';
import {
  DEFAULT_PROVIDER, PROVIDERS, ProviderError, providerOf, type Provider,
} from '@server/providers';
import { currentUserId, serverClient, type ServerDb } from '@server/supabase';

/** Polls one job and, the moment it is ready, collects the bytes.
 *
 *  Downloading them here is not an optimisation: the finished image sits on a
 *  delivery host that serves no CORS headers — `delivery.*.bfl.ai` for BFL,
 *  `*.fal.media` for fal — so the browser cannot fetch it at all, and the signed
 *  URL dies within minutes regardless.
 *
 *  Where they go afterwards is the one difference between the two modes. Local
 *  mode hands them back base64 in the same response, to IndexedDB. Cloud mode
 *  puts them in the private Storage bucket under the owner's uuid and answers
 *  with a signed URL, and it takes the polling URL from the render's row rather
 *  than from the query string — which is what stops one account polling
 *  another's job.
 *
 *  WHICH provider is polled is now a question with a different answer per mode,
 *  and it decides which hosts the API key may be shown. Cloud mode reads it off
 *  the row, where the submit route wrote it; local mode is told by the client,
 *  which is the same trust as the polling URL it also sends. Either way the URL
 *  is checked against THAT provider's allowlist and never a shared one: a job
 *  queued at fal must not be pollable through a URL only bfl.ts would have
 *  accepted, or the check stops being a check and becomes a union of every
 *  vendor we have ever integrated. */

/* A 4 MP PNG is a few MB; anything an order of magnitude past that is not our
   render and should not be turned into a base64 string in memory. */
const MAX_DELIVERY_BYTES = 32 * 1024 * 1024;

/* Long enough to look at a filmstrip and download a few, short enough that a
   URL copied out of devtools is not a permanent handle on the image. */
const SIGNED_URL_TTL_S = 3600;

/* The polling URL arrives from the client, and this route attaches our API key
   to whatever it names — so the provider's own guard is the line between polling
   a job and handing a key to any host an attacker picks. It lives in the provider
   next to the fetch that trusts it, because two copies of a check like this one
   is two copies to keep in step. */

function failed(error: string, status: number, retryable = false) {
  return Response.json({ status: 'failed', error, retryable }, { status });
}

/* Same token the proxy answers with — `src/shell/jobs.ts` switches on the 401
   before it reads the body, so this is never shown to anyone. */
const unauthenticated = () => Response.json({ error: 'unauthenticated' }, { status: 401 });

/* ── which provider ──────────────────────────────────────────────── */

/** Same rule as the submit route: an id the client names and this server does
 *  not have is a 400, because polling a fal job through BFL's client would fail
 *  later with a sentence about hosts that names nothing anyone can fix. Saying
 *  nothing at all still means the default, which is every client written before
 *  there was more than one provider. */
function pick(id: string | null): Provider | Response {
  if (!id) return PROVIDERS[DEFAULT_PROVIDER];
  const provider = PROVIDERS[id];
  if (!provider) {
    return failed(`There is no image provider called "${id}". The ones this server can use are ${Object.keys(PROVIDERS).join(', ')}.`, 400);
  }
  return provider;
}

/* ── collecting the finished image ───────────────────────────────── */

type Delivered =
  | { ok: true; bytes: ArrayBuffer; contentType: string }
  | { ok: false; error: string; status: number; retryable: boolean };

const undelivered = (error: string, status: number, retryable = false): Delivered =>
  ({ ok: false, error, status, retryable });

/** Pulls the finished PNG off the delivery host. Every failure is phrased for
 *  the person waiting and says whether polling again can help — the caller
 *  decides what that means for the record it is holding. */
async function deliver(provider: Provider, imageUrl: string): Promise<Delivered> {
  /* The delivery host is a different name under the same vendor, so it goes
     through the vendor's own check — and the fetch gets no API key: the URL is
     already signed and the key has no business leaving the API host. */
  const src = provider.deliveryUrl(imageUrl);
  if (!src) return undelivered(`${provider.label} returned the finished image on a host outside its own. Refusing to fetch it.`, 502);

  let res: Response;
  try {
    /* Same hop-by-hop check as the poll. This fetch carries no key, but a
       redirect off the vendor's hosts would still make this route a willing
       proxy for reading anything the server can reach — link-local metadata
       included. That discipline is `fetchDelivery`, per provider, rather than one
       function here that would have to know every vendor's domains. */
    res = await provider.fetchDelivery(src, { cache: 'no-store', signal: AbortSignal.timeout(60_000) });
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
    /* 403/404 here is almost always the signature expiring between the poll
       saying Ready and this fetch — ten minutes at BFL — and polling again will
       not bring it back. */
    const expired = res.status === 403 || res.status === 404;
    return undelivered(
      expired
        ? 'The finished render expired before it could be downloaded — a delivery link only lives a few minutes.'
        : `${provider.label} served the finished render as HTTP ${res.status}.`,
      502, !expired,
    );
  }

  const contentType = res.headers.get('content-type') ?? '';
  /* An HTML error page would base64 just as happily as a PNG and land in the
     filmstrip as a broken thumbnail with no explanation. */
  if (!contentType.startsWith('image/')) {
    return undelivered(`${provider.label} served the finished render as ${contentType || 'an unlabelled type'}, not an image.`, 502);
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

  const named = q.get('provider');
  const provider = pick(named);
  if (provider instanceof Response) return provider;
  if (!process.env[provider.needsEnv]) return failed(missingEnvMessage(provider), 500);

  /* `keyedUrl`, not `deliveryUrl`: this URL arrives from the browser and we are
     about to attach an API key to it, so it is checked against the hosts that may
     see the key rather than against every host the vendor owns. fal's CDN is one
     of the latter, and the wider guard would have accepted a fal.media address
     here. What matters as much is that it is THIS provider's guard: a fal status
     URL polled as a BFL job dies here, with the key still on the server. */
  const target = provider.keyedUrl(raw);
  if (!target) {
    /* Two sentences for one refusal, because the likely causes are different
       people's problems. A named provider whose URL is somebody else's is a
       request to refuse; no provider named at all is a client that has not been
       taught to send one yet, and every fal job it submits would die here with a
       message about BFL's hosts that names nothing anyone could act on. */
    return failed(named
      ? `That pollUrl is not an https address on ${provider.label}'s own hosts. Refusing to send the API key to it.`
      : `The poll did not say which provider this job belongs to, so it was tried as ${provider.label}, and the pollUrl is not on ${provider.label}'s hosts. Send provider= alongside pollUrl.`,
    400);
  }

  let result;
  try {
    result = await provider.poll(target.toString());
  } catch (e) {
    if (e instanceof ProviderError) {
      console.warn(`[render] poll refused ${jobId} ${provider.id} (${e.status}): ${e.message}`);
      return failed(e.message, e.status, e.retryable);
    }
    throw e;
  }

  if (result.status !== 'ready') {
    if (result.status === 'failed') console.warn(`[render] failed ${jobId}: ${result.error}`);
    return Response.json(result);
  }

  const image = await deliver(provider, result.imageUrl);
  if (!image.ok) return failed(image.error, image.status, image.retryable);

  const buf = Buffer.from(image.bytes);
  console.log(`[render] ready ${jobId} ${provider.id} ${buf.byteLength} bytes cost=${result.cost ?? 'not quoted'}`);
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
  'id' | 'status' | 'error' | 'model' | 'provider_job_id' | 'provider_poll_url' | 'image_path'
  | 'bytes' | 'created_at'>;

const COLUMNS = 'id, status, error, model, provider_job_id, provider_poll_url, image_path, bytes, created_at';

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

  /* Never from the query string, in either sense: not the URL and not the
     provider. `providerOf` falls back rather than refusing, which is what keeps
     rows written before there was a provider id — they say `flux-2-max`, which
     is not an id — polling through the provider that actually drew them. */
  const provider = providerOf(row.model);
  if (!row.provider_poll_url) {
    return settleFailed(db, row, 'This render was never handed to the provider, so there is nothing to wait for. Generate it again.', 502);
  }
  /* A key that is not configured says nothing about this render, so the row is
     left pending: setting the variable and reloading collects the same job. */
  if (!process.env[provider.needsEnv]) return failed(missingEnvMessage(provider), 500, true);
  /* The stored URL against the stored provider's own allowlist. Disagreement
     here is not an attack, it is a row that cannot ever be polled — a provider
     renamed under a job in flight, or a URL written by a build that recorded a
     different provider — and there is nothing to wait for, so it settles rather
     than failing every poll for three minutes. */
  if (!provider.keyedUrl(row.provider_poll_url)) {
    return settleFailed(
      db, row,
      `This render is recorded as a ${provider.label} job, but the polling URL stored with it is not on ${provider.label}'s hosts, so it cannot be collected. Generate it again.`,
      502,
    );
  }

  let result;
  try {
    result = await provider.poll(row.provider_poll_url);
  } catch (e) {
    if (e instanceof ProviderError) {
      console.warn(`[render] poll refused ${row.provider_job_id ?? '?'} ${provider.id} render=${row.id} (${e.status}): ${e.message}`);
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

  const image = await deliver(provider, result.imageUrl);
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

  console.log(`[render] ready ${row.provider_job_id ?? '?'} ${provider.id} render=${row.id} ${image.bytes.byteLength} bytes cost=${result.cost ?? 'not quoted'}`);
  return ready(db, row, path, image.bytes.byteLength);
}

/* ── the route ───────────────────────────────────────────────────── */

export async function GET(request: NextRequest) {
  /* No key check up here any more: which variable has to be set depends on which
     provider this job belongs to, and in cloud mode that is only known once the
     row has been read. Each mode checks its own once it knows. */
  const q = request.nextUrl.searchParams;
  /* The mode decides, not which query parameters turned up — a cloud deployment
     handed `?pollUrl=` is a client bug, and serving it would be an unauthenticated
     poll of whatever job the caller named. */
  return isCloud() ? cloud(q) : local(q);
}
