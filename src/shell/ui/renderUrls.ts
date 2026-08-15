import type { RenderRecord } from '../renders';

/** Object URLs for stored renders, keyed by record id and kept at module level.
 *  Both the Render panel and the sidebar draw the same records, and the panel
 *  unmounts on every Escape — a cache per component would mint a second URL for
 *  every thumbnail and then revoke one the other was still showing. One map,
 *  one owner, released only when a record leaves every list. */
const urls = new Map<string, string>();

export function urlFor(rec: RenderRecord): string {
  const held = urls.get(rec.id);
  if (held) return held;
  const blob = rec.thumbnail ?? rec.blob;
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  urls.set(rec.id, url);
  return url;
}

/** The full-size bytes, for a big preview — the thumbnail is 320 px wide and
 *  looks it once it fills the stage. */
export function fullUrlFor(rec: RenderRecord): string {
  const key = `${rec.id}:full`;
  const held = urls.get(key);
  if (held) return held;
  if (!rec.blob) return '';
  const url = URL.createObjectURL(rec.blob);
  urls.set(key, url);
  return url;
}

export function releaseAllBut(keep: RenderRecord[]) {
  const live = new Set(keep.flatMap(r => [r.id, `${r.id}:full`]));
  for (const [key, url] of urls) {
    if (live.has(key)) continue;
    URL.revokeObjectURL(url);
    urls.delete(key);
  }
}
