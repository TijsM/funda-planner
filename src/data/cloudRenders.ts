import type { RenderRecord } from '@shell/renders';
import { RENDER_BUCKET, renderThumbPath, type RenderRow } from './schema';
import { client, type Db } from './supabase';

/** Renders, in the account — the Supabase half of `src/shell/renders.ts`.
 *
 *  The two are deliberately substitutable: same names, same arguments, same
 *  `RenderRecord` out. `src/shell/renders.ts` picks between them on `isCloud()`
 *  and nothing above that line knows which one answered.
 *
 *  The one shape difference is where the bytes are. IndexedDB hands back a Blob;
 *  this hands back a signed URL and `blob: null`, because the PNG sits in a
 *  private Storage bucket and downloading every one of them to fill a filmstrip
 *  of 96 px cells would be a megabyte a cell. That is why every "did this one
 *  succeed?" test in the UI had to move from `rec.blob` to `rec.status`.
 *
 *  Every read here answers [] or 0 rather than throwing, for the same reason the
 *  IndexedDB reads do: an empty filmstrip is survivable, a modal that explodes
 *  on open is not. */

/** How long a signed URL lives. Every other `refreshRenders()` call site is an
 *  event — the panel opening, a floor change, a delete — so a sidebar left open
 *  and untouched used to reach this expiry with nothing to re-sign it: the
 *  thumbnails 404'd and enlarging one showed an empty overlay. */
const SIGN_TTL_S = 3600;

/** How often an open renders panel re-signs its whole list. `RendersBar` and
 *  `RenderModal` hold a timer on this while they are on screen; the five minutes
 *  of margin are so a URL cannot expire between two ticks. Cheap — one
 *  `createSignedUrls` for the list, not one per thumbnail. */
export const RESIGN_EVERY_MS = (SIGN_TTL_S - 300) * 1000;

/* client_id → the row's uuid. Everything in the editor keys on the client id —
   the filmstrip, `parent_id`, the record's own `id` — while the status route,
   the Storage paths and the thumbnail upload all key on the row's uuid, so one
   of the two has to be looked up. Cached because a row's uuid never changes;
   the map can be stale about a row that no longer exists, and every use of it
   is a query that then matches nothing. */
const uuids = new Map<string, string>();

/** The row uuid for a render the account has already listed, or null. The poller
 *  needs it to resume a job across a reload — `?renderId=` is a uuid and the job
 *  only knows its client id. */
export const cloudRowId = (clientId: string): string | null => uuids.get(clientId) ?? null;

/** Remembers the uuid the submit route just handed back, so the thumbnail upload
 *  and a delete straight afterwards do not each cost a lookup. */
export const noteRowId = (clientId: string, rowId: string): void => { uuids.set(clientId, rowId); };

/* plan client_id → the plan row's uuid. `renders.plan_id` is a real foreign key
   to `plans.id`, so every query here starts with this translation. */
const planUuids = new Map<string, string>();

async function planUuid(db: Db, planClientId: string): Promise<string | null> {
  const known = planUuids.get(planClientId);
  if (known) return known;
  const { data } = await db
    .from('plans')
    .select('id')
    .eq('client_id', planClientId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!data?.id) return null;
  planUuids.set(planClientId, data.id);
  return data.id;
}

/* Everything but `provider_poll_url` and `provider_job_id`. Those two are the
   reason renders moved server-side in the first place — the poll URL is what
   turns "poll my job" into "poll whatever job id I was handed" — so they are
   named here as columns the browser deliberately does not select.
   One unbroken literal, long line and all: supabase-js reads the column list at
   the type level, and a `'a, b' + 'c'` concatenation widens to `string` and
   takes the row type down to `any` with it. */
const COLUMNS = 'id, client_id, floor_id, parent_id, prompt, settings, seed, model, status, error, image_path, thumb_path, bytes, created_at, duration_ms';

type Row = Pick<RenderRow,
  'id' | 'client_id' | 'floor_id' | 'parent_id' | 'prompt' | 'settings' | 'seed' | 'model'
  | 'status' | 'error' | 'image_path' | 'thumb_path' | 'bytes' | 'created_at' | 'duration_ms'>;

/* ── signing ──────────────────────────────────────────────────────────────── */

/** One round trip for the whole page of renders. `createSignedUrl` per record
 *  would be forty requests to draw a filmstrip, and Storage rate-limits long
 *  before forty feels slow. Returns a map rather than an array because a URL
 *  that failed to sign comes back as a hole, and lining holes up by index is how
 *  a thumbnail ends up on the wrong render. */
async function sign(db: Db, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!paths.length) return out;
  const { data } = await db.storage.from(RENDER_BUCKET).createSignedUrls(paths, SIGN_TTL_S);
  for (const row of data ?? []) {
    if (row.path && row.signedUrl && !row.error) out.set(row.path, row.signedUrl);
  }
  return out;
}

const recordOf = (r: Row, projectId: string, urls: Map<string, string>): RenderRecord => {
  const image = r.image_path ? urls.get(r.image_path) : undefined;
  const thumb = r.thumb_path ? urls.get(r.thumb_path) : undefined;
  return {
    /* the client id, not the uuid: this is the id the filmstrip keys on, the id
       `parentId` points at, and the id the record had before it ever synced */
    id: r.client_id,
    projectId,
    floorId: r.floor_id,
    parentId: r.parent_id,
    prompt: r.prompt,
    settings: r.settings,
    seed: r.seed,
    model: r.model,
    status: r.status,
    ...(r.error ? { error: r.error } : {}),
    /* Never the bytes. `status === 'ready'` is what says this one succeeded. */
    blob: null,
    ...(image ? { imageUrl: image } : {}),
    ...(thumb ? { thumbUrl: thumb } : {}),
    createdAt: Date.parse(r.created_at),
    durationMs: r.duration_ms,
  };
};

async function toRecords(db: Db, rows: Row[], projectId: string): Promise<RenderRecord[]> {
  for (const r of rows) uuids.set(r.client_id, r.id);
  const paths = rows.flatMap(r => [r.image_path, r.thumb_path].filter((p): p is string => !!p));
  const urls = await sign(db, paths);
  return rows.map(r => recordOf(r, projectId, urls));
}

/* ── reads ────────────────────────────────────────────────────────────────── */

/** This floor's settled renders, newest first.
 *
 *  Pending rows are left out on purpose, so this matches the local path exactly:
 *  IndexedDB only ever holds a render that has settled, and an in-flight one is
 *  shown by the job spinner rather than by an empty cell in the strip. */
export async function listCloudRenders(planClientId: string, floorId: string): Promise<RenderRecord[]> {
  const db = client();
  if (!db) return [];
  try {
    const plan = await planUuid(db, planClientId);
    if (!plan) return [];
    const { data, error } = await db
      .from('renders')
      .select(COLUMNS)
      .eq('plan_id', plan)
      .eq('floor_id', floorId)
      .neq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error || !data) return [];
    return await toRecords(db, data as Row[], planClientId);
  } catch { return []; }
}

/** Rows still running, so a reload picks a render back up instead of losing it.
 *
 *  This is the gain that paid for moving the poll URL server-side: the job's
 *  whole identity now lives in a row, and closing the tab mid-render no longer
 *  abandons an image that has already been paid for. The poller decides which of
 *  these are still worth polling — a row from yesterday is a job the provider
 *  forgot long ago. */
export async function resumePending(planClientId: string): Promise<RenderRecord[]> {
  const db = client();
  if (!db) return [];
  try {
    const plan = await planUuid(db, planClientId);
    if (!plan) return [];
    const { data, error } = await db
      .from('renders')
      .select(COLUMNS)
      .eq('plan_id', plan)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error || !data) return [];
    return await toRecords(db, data as Row[], planClientId);
  } catch { return []; }
}

/** Every render in the account, in bytes — the figure beside the delete-all
 *  button. Summed here rather than in Postgres because supabase-js has no
 *  aggregate call and a view for one number is a migration nobody can revert
 *  from the client; the column is a bigint and the rows are numbers only. */
export async function cloudBytes(): Promise<number> {
  const db = client();
  if (!db) return 0;
  try {
    const { data, error } = await db.from('renders').select('bytes');
    if (error || !data) return 0;
    return data.reduce((sum, r) => sum + (Number(r.bytes) || 0), 0);
  } catch { return 0; }
}

/* ── writes ───────────────────────────────────────────────────────────────── */

/** Puts the 320 px thumbnail beside the full render and points the row at it.
 *
 *  Best effort by design: the PNG itself is already in the bucket and the row is
 *  already `ready` by the time this runs, so a thumbnail that does not land
 *  costs a filmstrip cell that draws the full image — not a lost render. */
export async function uploadThumbnail(renderId: string, clientId: string, blob: Blob): Promise<void> {
  const db = client();
  if (!db) return;
  try {
    const { data: auth } = await db.auth.getUser();
    const owner = auth.user?.id;
    if (!owner) return;

    const path = renderThumbPath(owner, renderId);
    /* upsert: a re-run of the same render id has to overwrite rather than 409 */
    const { error } = await db.storage.from(RENDER_BUCKET)
      .upload(path, blob, { contentType: 'image/png', upsert: true });
    if (error) return;

    uuids.set(clientId, renderId);
    await db.from('renders').update({ thumb_path: path }).eq('id', renderId);
  } catch { /* see the block comment: a missing thumbnail is a cosmetic loss */ }
}

/** Deletes one render — the objects first, then the row.
 *
 *  That order on purpose: a row without its objects is a broken cell the user
 *  can delete again, while objects without their row are bytes nothing in the
 *  app can ever reach, still billed for and invisible to the delete-all figure. */
export async function deleteCloudRender(clientId: string): Promise<boolean> {
  const db = client();
  if (!db) return false;
  try {
    const { data } = await db
      .from('renders')
      .select('id, image_path, thumb_path')
      .eq('client_id', clientId)
      .maybeSingle();
    /* already gone — the same answer the IndexedDB path gives for a missing key */
    if (!data) { uuids.delete(clientId); return true; }

    const paths = [data.image_path, data.thumb_path].filter((p): p is string => !!p);
    if (paths.length) await db.storage.from(RENDER_BUCKET).remove(paths);

    const { error } = await db.from('renders').delete().eq('id', data.id);
    if (error) return false;
    uuids.delete(clientId);
    return true;
  } catch { return false; }
}

/** Every render of one plan, objects and rows both. For the library's delete.
 *
 *  `sync.ts:removeCloudPlan` deletes the rows as part of tombstoning the plan
 *  but cannot touch Storage, so this has to run first or the PNGs are orphaned
 *  in the bucket with nothing left pointing at them. */
export async function deleteCloudRendersForPlan(planClientId: string): Promise<void> {
  const db = client();
  if (!db) return;
  try {
    const plan = await planUuid(db, planClientId);
    if (!plan) return;
    const { data } = await db
      .from('renders')
      .select('client_id, image_path, thumb_path')
      .eq('plan_id', plan);

    const paths = (data ?? []).flatMap(r =>
      [r.image_path, r.thumb_path].filter((p): p is string => !!p));
    if (paths.length) await db.storage.from(RENDER_BUCKET).remove(paths);
    for (const r of data ?? []) uuids.delete(r.client_id);

    await db.from('renders').delete().eq('plan_id', plan);
    planUuids.delete(planClientId);
  } catch { /* the plan is going away either way; the cost is orphaned bytes */ }
}

/** Drops the id caches. For sign-out — the next account on this browser must not
 *  inherit a map of someone else's row uuids, which would send its first delete
 *  at a row RLS then refuses to touch. */
export function resetCloudRenders(): void {
  uuids.clear();
  planUuids.clear();
}
