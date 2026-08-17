/** Which of the two worlds this process is running in.
 *
 *  `cloud`  — Supabase is configured: accounts, OTP sign-in, plans and renders
 *             in Postgres, render PNGs in a private Storage bucket.
 *  `local`  — no Supabase credentials: the app is exactly what it was before
 *             accounts landed, a single-user editor writing to localStorage and
 *             IndexedDB with no gate in front of it.
 *
 *  Both are real, supported modes — `local` is what CI, the Playwright suite and
 *  anyone who just wants the editor on their own machine run, and it is why none
 *  of this is allowed to become a hard dependency.
 *
 *  Every read is a literal `process.env.NEXT_PUBLIC_…` property access rather
 *  than a lookup through a variable: Next inlines those literals into the client
 *  bundle at build time and cannot see through indirection. On the server the
 *  same literals are read fresh on every call, which is what lets CI run
 *  `pnpm build` with no secrets at all.
 */

export type Mode = 'cloud' | 'local' | 'misconfigured';

export interface SupabaseConfig {
  url: string;
  /** the publishable (anon) key — safe in the browser, RLS is what protects data */
  key: string;
}

/* Supabase renamed the browser key from "anon" to "publishable" and their current
   Next.js guide only shows the new name. Both are accepted here because the old
   one is what is printed on every older dashboard, every older tutorial and
   every .env people already have — refusing it would be a config error whose
   cause is invisible. */
function readConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )?.trim();
  return url && key ? { url, key } : null;
}

/** The Supabase credentials, or null in local mode. */
export const supabaseConfig = (): SupabaseConfig | null => readConfig();

/** How long a browser stays signed in without being used: seven idle days.
 *
 *  Rolling rather than fixed — every request pushes it another week out, so
 *  somebody who opens the app weekly is never asked for a code again, and nobody
 *  is signed out in the middle of a meeting. Only a week of silence ends it.
 *
 *  Enforced by the proxy, which is the third thing tried and the only one that
 *  works. Supabase's own `sessions_inactivity_timeout` is the right mechanism and
 *  is refused on this plan — *"User sessions can only be configured on Pro Plans
 *  and up"*. Shortening the auth cookie is the obvious fallback and is not
 *  possible either: `@supabase/ssr` spreads your `cookieOptions` and then
 *  overwrites `maxAge` with its own 400-day default
 *  (`node_modules/@supabase/ssr/dist/main/cookies.js`), so the option is accepted
 *  and ignored. Hence `src/server/lastSeen.ts`. */
export const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

/** True when this process talks to Supabase at all. The single question every
 *  call site asks; nothing outside this file should read the env vars. */
export const isCloud = (): boolean => readConfig() !== null;

/* Running without auth is correct on a laptop and correct in CI. Running without
   auth on a public host is an open door, and the failure is silent — the app
   looks fine, it is just serving everyone's editor to everyone. So production
   with no credentials is refused rather than opened, and the escape hatch for
   deliberately self-hosting the single-user editor is an explicit opt-in rather
   than the absence of something. */
const LOCAL_OPT_IN = 'PLATTEGROND_MODE';

export function mode(): Mode {
  if (readConfig()) return 'cloud';
  if (process.env.NODE_ENV !== 'production') return 'local';
  return process.env[LOCAL_OPT_IN] === 'local' ? 'local' : 'misconfigured';
}

/** What to tell whoever deployed this. Deliberately names the variables rather
 *  than saying "check your configuration". */
export const MISCONFIGURED_MESSAGE =
  'This deployment has no Supabase credentials, so there is nothing to sign in to and nowhere to '
  + 'store plans. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, or set '
  + `${LOCAL_OPT_IN}=local to run the single-user editor with no accounts at all.`;
