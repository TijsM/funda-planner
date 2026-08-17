import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseConfig } from '@data/config';
import type { Database } from '@data/schema';

/** The half of the gate that talks to Supabase: refresh the session on every
 *  request, and say who is asking.
 *
 *  Deliberately not `server-only` — `proxy.ts` is not part of the React server
 *  graph and that import throws there. It still only ever runs on the server.
 *
 *  Two rules from Supabase's own guide are load-bearing and easy to break by
 *  tidying:
 *
 *  1. Nothing may run between `createServerClient` and `getClaims()`. Anything
 *     in between can consume the request in a way that loses a token refresh,
 *     and the symptom is users being logged out at random rather than anything
 *     that looks like a bug in the code that was inserted.
 *  2. The response object the client wrote its cookies onto is the one that has
 *     to be returned. If a caller wants a different response — a redirect, say —
 *     it must copy the cookies across, which is what `carryCookies` is for.
 */

export interface Session {
  /** the outgoing response the Supabase client wrote refreshed cookies onto */
  response: NextResponse;
  /** the signed-in user's id, or null */
  userId: string | null;
}

export async function readSession(request: NextRequest): Promise<Session> {
  const cfg = supabaseConfig();
  /* Callers check the mode first; this is the belt to that braces, and it keeps
     the function total rather than throwing inside a proxy. */
  if (!cfg) return { response: NextResponse.next({ request }), userId: null };

  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(cfg.url, cfg.key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        /* Onto the request first, so anything rendering downstream in this same
           pass sees the refreshed token rather than the one that just expired. */
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        /* `Cache-Control: private, no-store…`, supplied by the library. A CDN
           that caches a response carrying someone's Set-Cookie hands their
           session to the next visitor, and these headers are what stop it. */
        for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;

  return { response, userId: typeof sub === 'string' && sub ? sub : null };
}

/** Moves the refreshed auth cookies onto a different response. Without this a
 *  redirect through the gate silently drops the token that was just renewed, and
 *  the browser and the server drift apart until the session dies. */
export function carryCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const c of from.cookies.getAll()) to.cookies.set(c);
  return to;
}
