import type { RenderRecord } from '../renders';

/** Object URLs for stored renders, keyed by record id and kept at module level.
 *  Both the Render panel and the sidebar draw the same records, and the panel
 *  unmounts on every Escape — a cache per component would mint a second URL for
 *  every thumbnail and then revoke one the other was still showing. One map,
 *  one owner, released only when a record leaves every list.
 *
 *  A cloud record brings its own URLs and never enters that map. Two reasons to
 *  keep the distinction visible rather than tidy it away: a signed URL is not
 *  ours to free — `URL.revokeObjectURL` on an `https:` URL is a silent no-op
 *  that would read to the next person as cleanup that works — and it expires on
 *  its own after an hour, which is handled by `refreshRenders()` re-signing the
 *  whole list every time the panel opens, not by anything here. */
const urls = new Map<string, string>();

/** The small image for a filmstrip cell: the 320 px thumbnail when there is one,
 *  the full render when there is not. */
export function urlFor(rec: RenderRecord): string {
  /* Signed first — a cloud record has no blob to fall back to anyway, and
     asking the map for an id it can never hold is a lookup that always misses. */
  const signed = rec.thumbUrl ?? rec.imageUrl;
  if (signed) return signed;

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
  if (rec.imageUrl) return rec.imageUrl;

  const key = `${rec.id}:full`;
  const held = urls.get(key);
  if (held) return held;
  if (!rec.blob) return '';
  const url = URL.createObjectURL(rec.blob);
  urls.set(key, url);
  return url;
}

/** Frees the object URLs of records that have left the list. Signed URLs are
 *  not in the map and so are not touched: there is nothing to free, and the
 *  server that issued them expires them. */
export function releaseAllBut(keep: RenderRecord[]) {
  const live = new Set(keep.flatMap(r => [r.id, `${r.id}:full`]));
  for (const [key, url] of urls) {
    if (live.has(key)) continue;
    URL.revokeObjectURL(url);
    urls.delete(key);
  }
}
