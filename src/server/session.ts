import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The session cookie's whole security model. There are no accounts — one shared
 *  password lets you in, and this signs a token saying so. Next has no built-in
 *  cookie signing, so it is HMAC-SHA256 by hand: base64url(json).base64url(mac).
 *  Used by both `app/api/login/route.ts` and `proxy.ts`, which share a runtime. */

/* Matches the cookie's own maxAge. Without it `iat` would be decorative and a
   token copied off a machine would open the app forever. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const mac = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(payload).digest();

/** Mints a session token, or null when `SESSION_SECRET` is unset — a deployment
 *  missing its secret must hand out nothing rather than a token signed with the
 *  empty string, which anyone could forge. */
export function sign(): string | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({ iat: Date.now() })).toString('base64url');
  return `${payload}.${mac(secret, payload).toString('base64url')}`;
}

/** True only for a token this server signed and that has not aged out. Every
 *  other input — undefined, empty, no dot, a mangled signature, a payload that
 *  is not JSON — is false, never a throw: this runs in `proxy.ts` on every
 *  request, so an exception here is a 500 on the whole app. */
export function verify(token: string | null | undefined): boolean {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token) return false;

  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return false;
  const payload = token.slice(0, dot);

  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const want = mac(secret, payload);
  /* timingSafeEqual throws RangeError when the buffers differ in length, and a
     truncated signature is exactly what an attacker would send */
  if (given.length !== want.length) return false;
  if (!timingSafeEqual(given, want)) return false;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iat?: unknown };
    const iat = claims.iat;
    return typeof iat === 'number' && Number.isFinite(iat) && Date.now() - iat < MAX_AGE_MS;
  } catch {
    return false;
  }
}
