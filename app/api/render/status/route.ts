import type { NextRequest } from 'next/server';
import { MISSING_KEY, ProviderError, bflUrl, hopSafeFetch, poll } from '../../../../src/server/providers/bfl';

/** Polls one job and, the moment it is ready, downloads the bytes and returns
 *  them base64 in the same response. That last part is not an optimisation:
 *  the finished image sits on `delivery.*.bfl.ai`, which serves no CORS headers,
 *  so the browser cannot fetch it at all — and the signed URL dies after ten
 *  minutes regardless. */

/* A 4 MP PNG is a few MB; anything an order of magnitude past that is not our
   render and should not be turned into a base64 string in memory. */
const MAX_DELIVERY_BYTES = 32 * 1024 * 1024;

/* The polling URL arrives from the client, and this route attaches our API key
   to whatever it names — so `bflUrl` is the line between polling a job and
   handing FLUX_API_KEY to any host an attacker picks. It lives in the provider
   next to the fetch that trusts it, because two copies of a check like this one
   is two copies to keep in step. */

function failed(error: string, status: number, retryable = false) {
  return Response.json({ status: 'failed', error, retryable }, { status });
}

export async function GET(request: NextRequest) {
  if (!process.env.FLUX_API_KEY) return failed(MISSING_KEY, 500);

  const q = request.nextUrl.searchParams;
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

  /* The delivery host is a different name under the same domain, so it goes
     through the same check — and it gets no x-key: the URL is already signed and
     the key has no business leaving api.bfl.ai. */
  const src = bflUrl(result.imageUrl);
  if (!src) return failed('The provider returned the finished image on a host outside bfl.ai. Refusing to fetch it.', 502);

  let res: Response;
  try {
    /* Same hop-by-hop check as the poll. This fetch carries no key, but a
       redirect off bfl.ai would still make this route a willing proxy for
       reading anything the server can reach — link-local metadata included. */
    res = await hopSafeFetch(src, { cache: 'no-store', signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    if (e instanceof ProviderError) return failed(e.message, e.status, e.retryable);
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return failed(
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
    return failed(
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
    return failed(`The provider served the finished render as ${contentType || 'an unlabelled type'}, not an image.`, 502);
  }

  const tooBig = (bytes: number) =>
    failed(`The finished render is ${(bytes / 1024 / 1024).toFixed(1)} MB, past the ${MAX_DELIVERY_BYTES / 1024 / 1024} MB this route will hold in memory.`, 502);

  /* Checked before reading the body, not after: arrayBuffer() on a two-gigabyte
     response has already happened by the time a size check downstream of it can
     complain, which is the failure the ceiling exists to prevent. */
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DELIVERY_BYTES) return tooBig(declared);

  const buf = Buffer.from(await res.arrayBuffer());
  /* A missing or lying content-length still gets caught, just later. */
  if (buf.byteLength > MAX_DELIVERY_BYTES) return tooBig(buf.byteLength);

  console.log(`[render] ready ${jobId} ${buf.byteLength} bytes cost=${result.cost ?? 'not quoted'}`);
  return Response.json({
    status: 'ready',
    image: buf.toString('base64'),
    contentType,
    bytes: buf.byteLength,
    cost: result.cost,
  });
}
