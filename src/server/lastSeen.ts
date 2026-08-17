import type { NextRequest, NextResponse } from 'next/server';
import { SESSION_MAX_AGE_S } from '@data/config';

/** The seven-idle-day rule, kept in a cookie of our own.
 *
 *  Supabase will not do this on the current plan and its auth cookie ignores any
 *  `maxAge` we ask for — see `SESSION_MAX_AGE_S` for both. So the proxy tracks
 *  when the browser was last here, and refuses a session that has gone quiet for
 *  longer than a week.
 *
 *  It holds a timestamp rather than relying on its own expiry, and that is the
 *  whole trick: an absent cookie then means "first time we have seen this
 *  browser" — a sign-in that just happened client-side, or a session predating
 *  this code — which must be waved through, while a *stale* one is a real lapse.
 *  A cookie that simply expired would make those two cases identical, and the
 *  rule would forgive every lapse it was written to catch.
 *
 *  Not signed, deliberately. Editing it only extends your own session, and
 *  anyone who can edit it already holds the auth cookie sitting next to it — so
 *  a signature would protect nothing and imply a guarantee this does not make.
 *  The real guarantee is on the other side: a lapse revokes the refresh token at
 *  Supabase, so it is not merely this browser being turned away. */

const COOKIE = 'pgs.seen';

/* Long enough that the cookie always outlives the window it is measuring. If it
   expired on the same schedule it would erase the evidence of the very lapse it
   exists to detect. */
const REMEMBER_S = 400 * 24 * 60 * 60;

/** True when this browser has been away longer than the window. */
export function lapsed(request: NextRequest, now: number): boolean {
  const raw = request.cookies.get(COOKIE)?.value;
  if (!raw) return false;
  const seen = Number(raw);
  /* A value that is not a number is a mangled cookie, not a lapse — treating it
     as one would sign people out for a corrupted jar they cannot see. */
  if (!Number.isFinite(seen)) return false;
  return now - seen > SESSION_MAX_AGE_S * 1000;
}

/** Records that the browser was here. Called on every request that carries a
 *  session, which is what keeps the week rolling forward. */
export function touch(response: NextResponse, now: number): void {
  response.cookies.set(COOKIE, String(now), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: REMEMBER_S,
  });
}

/** Forgets the browser, so the next sign-in starts a fresh week rather than
 *  inheriting a timestamp old enough to be thrown out immediately. */
export function forget(response: NextResponse): void {
  response.cookies.delete(COOKIE);
}
