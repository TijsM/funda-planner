import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseConfig } from './config';
import type { Database } from './schema';

/** The browser's Supabase client, or null in local mode.
 *
 *  Every caller has to handle the null — that is the point. It is what keeps the
 *  local-only path alive rather than leaving a trail of `!` assertions that turn
 *  a missing credential into a crash inside a click handler.
 *
 *  `createBrowserClient` is already a singleton internally, so the cache here is
 *  not about cost; it is so that `client()` returning the same object twice is a
 *  guarantee callers can lean on when they attach listeners to it. */

export type Db = SupabaseClient<Database>;

let cached: Db | null = null;

export function client(): Db | null {
  if (cached) return cached;
  const cfg = supabaseConfig();
  if (!cfg) return null;
  cached = createBrowserClient<Database>(cfg.url, cfg.key);
  return cached;
}

/** Throws rather than returning null. For the handful of places already inside a
 *  cloud-only branch, where threading a null through would only obscure that the
 *  question was settled two frames up the stack. */
export function requireClient(): Db {
  const c = client();
  if (!c) throw new Error('Supabase is not configured in this browser build.');
  return c;
}
