'use client';

import { useEffect, useState } from 'react';
import { getPhoto } from '../photos';

/** Object URLs for stored photos, keyed by photo id and kept at module level.
 *
 *  Same reasoning as `./renderUrls.ts`: the selection toolbar, the manage modal
 *  and the render panel all draw the same photos, and the toolbar remounts on
 *  every click — a cache per component would mint a second URL per tile and
 *  then revoke one another component was still showing.
 *
 *  Unlike renders, these are object URLs in BOTH modes. A cloud photo could be
 *  drawn from a signed URL instead, but `getPhoto` already caches the bytes
 *  locally and immutably, so making the URL from the blob costs one read and
 *  buys freedom from the expiry problem that `refreshRenders` exists to solve. */
const urls = new Map<string, string>();

/* Which plan the map belongs to. Photo ids are unique across plans, so nothing
   would break without this — but a plan closed after a browse through the
   library has no reason to keep its thumbnails resident, and "revoke on project
   change" is the only moment that is unambiguously safe. */
let owner: string | null = null;

/** What is already in hand, for a synchronous first paint. */
export const heldPhotoUrl = (id: string): string => urls.get(id) ?? '';

/** Reads the bytes if they are not already held, and returns something to point
 *  an `<img>` at. Empty string when the photo cannot be found at all — a tile
 *  that draws as a grey square, which is the honest picture of a photo whose
 *  bytes are on another device and unreachable right now. */
export async function ensurePhotoUrl(projectId: string, id: string): Promise<string> {
  if (owner !== projectId) {
    releasePhotoUrls();
    owner = projectId;
  }
  const held = urls.get(id);
  if (held) return held;

  const blob = await getPhoto(projectId, id);
  if (!blob) return '';
  /* Another caller may have won the race while this one was reading. */
  const now = urls.get(id);
  if (now) return now;
  const url = URL.createObjectURL(blob);
  urls.set(id, url);
  return url;
}

export function releasePhotoUrls(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  owner = null;
}

/** One tile's URL, and whether the bytes turned out not to be there at all.
 *
 *  The second half matters: a photograph attached on a phone and never uploaded,
 *  or a plan imported from a JSON file that carries references but no pictures,
 *  leaves a tile with nothing behind it. Empty and "still reading" look the same
 *  on screen, and a grey square that never resolves reads as a bug rather than
 *  as the true statement "this picture is on another device".
 *
 *  Starts from whatever is already cached, so a remount of the toolbar does not
 *  blink every thumbnail back to empty. */
export function usePhotoState(projectId: string, id: string): { url: string; missing: boolean } {
  const [url, setUrl] = useState(() => heldPhotoUrl(id));
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (url || !id) return;
    let live = true;
    setMissing(false);
    void ensurePhotoUrl(projectId, id).then(u => {
      if (!live) return;
      if (u) setUrl(u); else setMissing(true);
    });
    return () => { live = false; };
  }, [projectId, id, url]);
  return { url, missing };
}

/** Just the URL, for the callers that have nothing useful to do with the
 *  difference between reading and gone. */
export const usePhotoUrl = (projectId: string, id: string): string =>
  usePhotoState(projectId, id).url;
