import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { sign } from '../../../src/server/session';

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/* timingSafeEqual throws RangeError the moment the two buffers differ in
   length, so comparing the raw strings would turn every wrong-length guess into
   a 500 — and the 500-vs-401 split would leak the password's length. sha256
   pins both sides to 32 bytes first. */
const matches = (given: string, expected: string) =>
  timingSafeEqual(
    createHash('sha256').update(given, 'utf8').digest(),
    createHash('sha256').update(expected, 'utf8').digest(),
  );

/* One shared password is the only credential in the system, and /api/login is
   necessarily the one route the proxy cannot guard — so without this it can be
   guessed at whatever rate the server will answer, measured at ~48/s from a
   single serial client. Five free attempts, then doubling backoff to five
   minutes, counted per address and reset by a success.

   In memory, so it is per-process: it survives nothing, and a deploy across
   several instances would divide the limit by the instance count. This app runs
   as one `next start`, and the alternative is a datastore for a single-user
   gate. Revisit that the day it stops being one process. */
const FREE_ATTEMPTS = 5;
const MAX_LOCKOUT_MS = 5 * 60_000;
const FORGET_MS = 60 * 60_000;

const attempts = new Map<string, { fails: number; until: number; seen: number }>();

function clientKey(request: NextRequest): string {
  const fwd = request.headers.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0]!.trim() : '') || request.headers.get('x-real-ip') || 'local';
}

/** Milliseconds still to wait, or 0 to let the attempt through. */
function lockedFor(key: string, now: number): number {
  /* pruning here rather than on a timer: the map only grows when someone is
     failing, and this is the only place that looks at it */
  for (const [k, v] of attempts) if (now - v.seen > FORGET_MS) attempts.delete(k);
  const rec = attempts.get(key);
  return rec && rec.until > now ? rec.until - now : 0;
}

function noteFailure(key: string, now: number) {
  const rec = attempts.get(key) ?? { fails: 0, until: 0, seen: now };
  rec.fails += 1;
  rec.seen = now;
  if (rec.fails > FREE_ATTEMPTS) {
    const wait = Math.min(MAX_LOCKOUT_MS, 1000 * 2 ** (rec.fails - FREE_ATTEMPTS - 1));
    rec.until = now + wait;
  }
  attempts.set(key, rec);
}

export async function POST(request: NextRequest) {
  const now = Date.now();
  const key = clientKey(request);
  const wait = lockedFor(key, now);
  if (wait > 0) {
    const secs = Math.ceil(wait / 1000);
    console.warn(`[login] locked out ${key} for a further ${secs}s`);
    return Response.json(
      { error: 'locked', message: `Too many wrong attempts. Try again in ${secs} second${secs === 1 ? '' : 's'}.` },
      { status: 429, headers: { 'retry-after': String(secs) } },
    );
  }

  /* env is read here, not at module scope — CI runs `pnpm build` with no
     secrets at all, and a module-level assertion turns that into a red build */
  const expected = process.env.APP_LOGIN;
  if (!expected) {
    return Response.json(
      { error: 'unconfigured', message: 'No password is set on this server — APP_LOGIN is missing.' },
      { status: 500 },
    );
  }

  let password = '';
  try {
    const body = (await request.json()) as { password?: unknown };
    if (typeof body.password === 'string') password = body.password;
  } catch {
    /* a body that is not JSON is just a failed attempt, not a server fault */
  }

  if (!password || !matches(password, expected)) {
    noteFailure(key, now);
    /* Logged so a burst is visible to whoever reads the output — never the
       password itself, and never the attempt count back to the caller. */
    console.warn(`[login] failed attempt from ${key}`);
    return Response.json({ error: 'wrong', message: 'That password does not match.' }, { status: 401 });
  }
  attempts.delete(key);

  const token = sign();
  if (!token) {
    return Response.json(
      { error: 'unconfigured', message: 'No session secret is set on this server — SESSION_SECRET is missing.' },
      { status: 500 },
    );
  }

  const jar = await cookies();
  jar.set('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE,
  });
  return Response.json({ ok: true }, { status: 200 });
}
