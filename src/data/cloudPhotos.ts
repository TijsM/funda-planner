import { PHOTO_BUCKET, photoPath, photoPrefix } from './schema';
import { client, type Db } from './supabase';

/** Object photographs, in the account — the Supabase half of
 *  `src/shell/photos.ts`.
 *
 *  Substitutable with the IndexedDB half the same way `cloudRenders.ts` is with
 *  `renders.ts`: same names, same arguments, and `src/shell/photos.ts` picks
 *  between them on `isCloud()` so nothing above that line knows which answered.
 *
 *  There is no table here, and that is deliberate. A render needs a row because
 *  it has a status, a prompt and a poll URL that must outlive the tab; a photo
 *  has none of that. Its metadata — name, size, note, priority — is a `PhotoRef`
 *  in the plan document, which already syncs, so a row would be a second copy of
 *  facts the doc already carries and a second thing to keep in step with undo.
 *  What is left is bytes, and bytes are what a bucket is for.
 *
 *  Every read answers null or an empty map rather than throwing: a photo that
 *  will not load is a grey tile, and a toolbar that explodes while you are
 *  furnishing a room is not. */

/** An hour, the same as render URLs. Long enough that a panel left open does not
 *  go blank between two glances, short enough that a leaked URL is not a
 *  permanent one. */
const SIGN_TTL_S = 3600;

/** How long a signed photo URL is treated as usable. Five minutes of margin
 *  under the TTL so nothing hands out a URL that expires while it is on screen. */
export const PHOTO_URL_TTL_MS = (SIGN_TTL_S - 300) * 1000;

async function ownerOf(db: Db): Promise<string | null> {
  try {
    const { data } = await db.auth.getUser();
    return data.user?.id ?? null;
  } catch { return null; }
}

/** Uploads one JPEG. `upsert` on purpose: re-attaching after a failed write, or
 *  a retry of the same id, must overwrite rather than 409 — the id is ours and a
 *  collision can only ever be the same picture. */
export async function uploadPhoto(planId: string, id: string, blob: Blob): Promise<boolean> {
  const db = client();
  if (!db) return false;
  try {
    const owner = await ownerOf(db);
    if (!owner) return false;
    const { error } = await db.storage.from(PHOTO_BUCKET)
      .upload(photoPath(owner, planId, id), blob, { contentType: 'image/jpeg', upsert: true });
    return !error;
  } catch { return false; }
}

/** The bytes themselves — for the render submit, which needs base64 rather than
 *  something to point an `<img>` at. Downloaded through supabase-js so the
 *  request carries the session instead of needing a signed URL first. */
export async function downloadPhoto(planId: string, id: string): Promise<Blob | null> {
  const db = client();
  if (!db) return null;
  try {
    const owner = await ownerOf(db);
    if (!owner) return null;
    const { data, error } = await db.storage.from(PHOTO_BUCKET)
      .download(photoPath(owner, planId, id));
    return error ? null : data ?? null;
  } catch { return null; }
}

/** One round trip for a whole strip of thumbnails. Keyed by photo id rather
 *  than by index, because a URL that failed to sign comes back as a hole and
 *  lining holes up by position is how a photo ends up under the wrong object. */
export async function signPhotos(planId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const db = client();
  if (!db || !ids.length) return out;
  try {
    const owner = await ownerOf(db);
    if (!owner) return out;
    const paths = ids.map(id => photoPath(owner, planId, id));
    const { data } = await db.storage.from(PHOTO_BUCKET).createSignedUrls(paths, SIGN_TTL_S);
    for (const row of data ?? []) {
      if (!row.path || !row.signedUrl || row.error) continue;
      /* the id is the basename without the extension — see `photoPath` */
      const id = row.path.split('/').pop()?.replace(/\.jpg$/, '');
      if (id) out.set(id, row.signedUrl);
    }
    return out;
  } catch { return out; }
}

export async function deleteCloudPhoto(planId: string, id: string): Promise<boolean> {
  const db = client();
  if (!db) return false;
  try {
    const owner = await ownerOf(db);
    if (!owner) return false;
    const { error } = await db.storage.from(PHOTO_BUCKET).remove([photoPath(owner, planId, id)]);
    return !error;
  } catch { return false; }
}

/** Every photo of one plan, for a plan being deleted. Storage has no "remove
 *  prefix", so the objects are listed and then removed by name; the listing is
 *  paginated and a plan with more photos than one page is a plan that gets more
 *  than one pass. */
export async function deleteCloudPhotosForPlan(planId: string): Promise<void> {
  const db = client();
  if (!db) return;
  try {
    const owner = await ownerOf(db);
    if (!owner) return;
    const prefix = photoPrefix(owner, planId);
    for (let page = 0; page < 20; page++) {
      const { data, error } = await db.storage.from(PHOTO_BUCKET)
        .list(prefix, { limit: 100, offset: 0 });
      if (error || !data?.length) return;
      const names = data.map(o => `${prefix}/${o.name}`);
      const { error: gone } = await db.storage.from(PHOTO_BUCKET).remove(names);
      /* Offset stays at 0 deliberately: the page just removed is gone, so the
         next hundred have moved up to take its place. Paging forward instead
         would skip a hundred objects for every hundred deleted. */
      if (gone || data.length < 100) return;
    }
  } catch { /* the plan is going away either way; orphaned bytes are the cost */ }
}
