import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { MISCONFIGURED_MESSAGE, mode } from './src/data/config';
import { carryCookies, readSession } from './src/server/supabaseProxy';

/* The gate. Node runtime only in Next 16 — so there is deliberately no `runtime`
   export, which would throw.

   It answers three different deployments:

   - `local`         no Supabase credentials. There are no accounts, so there is
                     nothing to gate: every request passes. This is the editor as
                     it was before any of this, and it is what CI, the Playwright
                     suite and anyone running it on their own machine get.
   - `cloud`         Supabase configured. Refresh the session, then gate.
   - `misconfigured` production, no credentials, and no explicit opt-in to the
                     local mode. Refused rather than opened — a public host with
                     the gate quietly switched off looks exactly like a working
                     one, which is the whole danger. */

/** Machine-shaped paths get JSON, not an HTML redirect.
 *
 *  Next runs the proxy on `/_next/data/*` even though the matcher excludes
 *  `_next` — intentional on its part, so that protecting a page cannot leave its
 *  data route open. That means this function sees paths the matcher never
 *  enumerated, and a 307 to /login in answer to a data fetch breaks client
 *  navigation in a way that is very hard to read. */
const wantsJson = (pathname: string) =>
  pathname.startsWith('/api/') || pathname.startsWith('/_next/');

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  switch (mode()) {
    case 'local':
      return NextResponse.next();

    case 'misconfigured':
      return wantsJson(pathname)
        ? NextResponse.json({ error: MISCONFIGURED_MESSAGE }, { status: 503 })
        : new NextResponse(MISCONFIGURED_MESSAGE, {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });

    default:
      break;
  }

  /* Must happen before any branch below: this is what refreshes an expiring
     token, and a request that returns early has silently skipped the refresh. */
  const { response, userId } = await readSession(request);
  if (userId) return response;

  if (wantsJson(pathname)) {
    /* The literal body the client switches on — `src/shell/jobs.ts` turns this
       status into "your session has expired", not into a toast reading
       "unauthenticated". */
    return carryCookies(response, NextResponse.json({ error: 'unauthenticated' }, { status: 401 }));
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  /* Where they were headed, so signing in does not also mean losing the page
     they asked for. Only for real destinations — `?next=/` is noise. The `#…`
     deep links the editor uses never reach the server at all; browsers carry the
     fragment across the redirect on their own. */
  const from = request.nextUrl.pathname + request.nextUrl.search;
  if (from !== '/' && !from.startsWith('/login')) url.searchParams.set('next', from);

  return carryCookies(response, NextResponse.redirect(url));
}

/* Matcher values have to be static literals — Next reads them at build time and
   silently ignores anything computed. `/login` is the only page excluded: the
   OTP exchange itself happens in the browser against Supabase directly, so there
   is no auth route of ours that needs a hole. Everything else, `/api/render`
   included, is gated. */
export const config = {
  matcher: ['/((?!login$|_next/static|_next/image|favicon\\.ico$).*)'],
};
