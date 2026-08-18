import 'server-only';

import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { supabaseConfig } from '@data/config';
import type { Database } from '@data/schema';

/** The server's Supabase client, built per request from the incoming cookies.
 *
 *  Never module-scoped and never cached: it carries one caller's session, and a
 *  client shared between requests is the bug where one user's plans are served
 *  to another. `cookies()` is async in Next 16, so this is too.
 *
 *  Returns null in local mode, like its browser counterpart, so a route can
 *  answer "there are no accounts here" instead of throwing. */

export type ServerDb = SupabaseClient<Database>;

export async function serverClient(): Promise<ServerDb | null> {
  const cfg = supabaseConfig();
  if (!cfg) return null;

  const jar = await cookies();

  return createServerClient<Database>(cfg.url, cfg.key, {
    cookies: {
      getAll() {
        return jar.getAll();
      },
      /* Two arguments. The second carries `Cache-Control: private, no-store …`
         headers that @supabase/ssr wants on any response that sets an auth
         cookie — a cached Set-Cookie is how one user ends up signed in as
         another. A Route Handler can set them; a Server Component cannot set
         anything at all, which is what the catch is for. */
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) jar.set(name, value, options);
        } catch {
          /* Called during a Server Component render, where cookies are
             read-only. Safe to swallow: the proxy refreshes the session on
             every request, so the write this drops has already happened there. */
        }
      },
    },
  });
}

/** The signed-in user's id, or null. Uses `getClaims()`, which verifies the JWT
 *  signature locally against the project's published keys — unlike
 *  `getSession()`, which trusts a cookie the browser could have written. */
export async function currentUserId(db: ServerDb): Promise<string | null> {
  const { data, error } = await db.auth.getClaims();
  if (error || !data) return null;
  const sub = data.claims.sub;
  return typeof sub === 'string' && sub ? sub : null;
}
