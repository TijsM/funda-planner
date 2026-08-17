import { client } from '@data/supabase';
import { resetCloudRenders } from '@data/cloudRenders';
import { flushSync, resetSync } from '@data/sync';
import { resetResume } from './jobs';
import { dropLocalCache, forgetUser } from './storage';

/** Who is signed in, and how to stop being them. Both answer for local mode
 *  too — there is nobody signed in, so `currentEmail` is null and the top bar
 *  shows nothing at all. */

/** The signed-in address, or null when there is no account.
 *
 *  `getSession` rather than `getUser`: this is a label in the top bar, not a
 *  permission check, and reading the cookie the proxy just refreshed is worth
 *  more than a network round trip on every mount. */
export async function currentEmail(): Promise<string | null> {
  const db = client();
  if (!db) return null;
  try {
    const { data } = await db.auth.getSession();
    return data.session?.user.email ?? null;
  } catch { return null; }
}

/** Signs out, and leaves nothing of this account behind on the browser.
 *
 *  The order is load-bearing: the cache keys are namespaced by the account, so
 *  it can only be cleared while we still know which account that is. And the
 *  navigation is a full document load rather than a router push — the gate is in
 *  the proxy, and only a fresh request to the server sees that the session
 *  cookies are gone. A client-side route change would land on /login with the
 *  whole editor still in memory. */
export async function signOut(): Promise<void> {
  const db = client();

  /* Before anything is torn down, and before the session it needs is revoked:
     the push is debounced by up to eight seconds, so an edit made in the last
     moments before pressing Sign out is sitting in memory only. `dropLocalCache`
     below then deletes the browser's copy — signing out is the one action that
     turns "not synced yet" into "gone". */
  try { await flushSync(); } catch { /* the cache is cleared either way */ }

  /* If this throws the cookies may survive, but everything below still has to
     happen: leaving one person's plans in localStorage for whoever signs in
     next is the failure worth being thorough about. */
  try { await db?.auth.signOut(); } catch { /* the reload is the real exit */ }
  dropLocalCache();
  /* Three module-level caches, all of them keyed by ids that mean nothing to the
     next account: pending pushes and plan uuids, render row uuids and signed
     URLs, and the set of plans already resumed. The reload clears them anyway —
     these calls are what makes sign-out correct if it ever stops reloading. */
  resetSync();
  resetCloudRenders();
  resetResume();
  forgetUser();
  window.location.href = '/login';
}
