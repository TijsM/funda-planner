import type { Project } from '@engine/types';
import { migrate } from '@engine/model';
import { entryOf, type LibraryEntry } from './library';
import { client, type Db } from './supabase';
import { RENDER_BUCKET, type PlanRow } from './schema';

/** Plans, in the account.
 *
 *  The rule this file exists to keep: **the editor never waits on the network.**
 *  Every edit lands in localStorage synchronously, exactly as it did before
 *  there were accounts, and this pushes a copy up afterwards on a timer. A dead
 *  connection makes the app no slower and loses nothing that was not already
 *  going to be lost by closing the tab.
 *
 *  The cost of that choice is stated in `mergeEntries`: two devices on one plan
 *  is last-write-wins, and the loser's edits are gone. */

/* Long enough that a burst of edits is one write rather than forty; short enough
   that closing the laptop lid a few seconds after the last change still gets it
   up. The 3-second autosave tick in Editor.tsx is what drives this, so a change
   is pushed on the first tick after the window elapses. */
const PUSH_INTERVAL_MS = 8_000;

/** The size at which we stop trying. A document is normally well under 200 KB;
 *  what makes one huge is a reference bitmap, which `src/shell/files.ts` inlines
 *  into the document as a base64 data URL with no downscaling and no cap — a
 *  4-floor plan with a phone photo traced on each floor is tens of megabytes.
 *  Pushing that every eight seconds is not a sync, it is an upload loop, and
 *  Postgres is the wrong place for it either way.
 *
 *  This is a deliberate v1 limit, not a solved problem: the fix is to split
 *  `ref.src` data URLs out into Storage and keep a path in the document. Until
 *  then the plan stays local and the user is told so, once. */
const MAX_DOC_BYTES = 4 * 1024 * 1024;

type Reporter = (message: string, kind?: 'ok' | 'err') => void;

let report: Reporter = () => { /* set by startSync */ };

/* The document waiting to go up, if any. Deliberately the live project object
   rather than a serialised copy: serialising on every keystroke is the cost this
   whole file is built to avoid, and the push serialises once, at the end. */
let pending: Project | null = null;
let lastPushedAt = 0;
let inFlight: Promise<void> | null = null;

/** Ids we have already complained about, so a plan that is too big says so once
 *  rather than every eight seconds for as long as it is open. */
const tooBig = new Set<string>();

/** clientId → the row's uuid, so the render path can reference a plan without a
 *  round trip per render. Only ever grows; a stale entry is impossible because
 *  a plan's uuid never changes and a deleted plan cannot be rendered to. */
const uuids = new Map<string, string>();

/* ── reads ────────────────────────────────────────────────────────────────── */

const entryOfRow = (r: Pick<PlanRow,
  'client_id' | 'name' | 'address' | 'source_url' | 'doc_updated_at' | 'floor_count'>): LibraryEntry => ({
  id: r.client_id,
  name: r.name,
  address: r.address,
  url: r.source_url,
  updatedAt: Date.parse(r.doc_updated_at),
  nf: r.floor_count,
  synced: true,
});

/** The account's plans, newest first. Summary columns only — the documents stay
 *  where they are until something asks to open one. Returns [] rather than
 *  throwing: a library that is briefly missing its cloud half is survivable, a
 *  modal that explodes on open is not. */
export async function listCloudPlans(): Promise<LibraryEntry[]> {
  const db = client();
  if (!db) return [];
  const { data, error } = await db
    .from('plans')
    .select('client_id, name, address, source_url, doc_updated_at, floor_count, id')
    .is('deleted_at', null)
    .order('doc_updated_at', { ascending: false });
  if (error || !data) return [];
  for (const r of data) uuids.set(r.client_id, r.id);
  return data.map(entryOfRow);
}

/** One document, or null if the account has never seen it. */
export async function fetchCloudPlan(clientId: string): Promise<Project | null> {
  const db = client();
  if (!db) return null;
  const { data, error } = await db
    .from('plans')
    .select('id, doc')
    .eq('client_id', clientId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error || !data?.doc) return null;
  uuids.set(clientId, data.id);
  /* migrate on the way in as well as on the way out: this row may have been
     written by an older build of the app on another machine. */
  return migrate(data.doc);
}

/* ── writes ───────────────────────────────────────────────────────────────── */

function rowOf(p: Project) {
  const e = entryOf(p);
  return {
    client_id: p.id,
    name: p.name,
    address: e.address,
    source_url: e.url,
    funda_project_id: p.source?.projectId ?? null,
    floor_count: p.floors.length,
    doc: p,
    doc_updated_at: new Date(p.updatedAt).toISOString(),
    synced_at: new Date().toISOString(),
  };
}

/* `deleted_at` is deliberately absent above. PostgREST turns an upsert into
   ON CONFLICT DO UPDATE over exactly the columns in the payload, so sending
   `deleted_at: null` would clear the tombstone on every push — and the tombstone
   exists precisely to survive a push from a device that has not heard about the
   delete. With the column omitted, a stale tab writing its copy up updates the
   document and leaves the row buried, which is the whole point.

   That also means a tombstoned plan can be written to and will still never be
   listed. Undelete is not a feature; if it becomes one, it is an explicit
   `deleted_at: null` from a function that means it, not a side effect of saving. */

/** Writes one document up and returns its row uuid, or null if it did not land.
 *  `onConflict` on (owner_id, client_id) is what makes this an upsert without a
 *  read first — `owner_id` is filled by the default policy from the session, so
 *  it is never sent and never spoofable. */
async function push(p: Project): Promise<string | null> {
  const db = client();
  if (!db) return null;

  const { data: auth } = await db.auth.getUser();
  const owner = auth.user?.id;
  if (!owner) return null;

  const size = JSON.stringify(p).length;
  if (size > MAX_DOC_BYTES) {
    if (!tooBig.has(p.id)) {
      tooBig.add(p.id);
      report(
        `“${p.name}” is ${Math.round(size / 1024 / 1024)} MB — too big to sync, almost certainly an `
        + 'embedded reference image. It stays saved in this browser; remove the reference image or '
        + 'export it as JSON to move it.',
        'err',
      );
    }
    return null;
  }
  tooBig.delete(p.id);

  const { data, error } = await db
    .from('plans')
    .upsert({ ...rowOf(p), owner_id: owner }, { onConflict: 'owner_id,client_id' })
    .select('id')
    .single();

  if (error || !data) return null;
  uuids.set(p.id, data.id);
  return data.id;
}

/** Plans this session has refused to push because the document is too big.
 *
 *  The library needs it: such a plan is very likely in the account already —
 *  it synced fine before somebody dropped a photo on it — so the row still says
 *  "in your account" while nothing since has landed. Left alone, the badge is a
 *  lie in the one direction that costs work, because signing out clears the
 *  local copy that holds the only up-to-date version. */
export const unsyncable = (): ReadonlySet<string> => tooBig;

/** Called on every local save. Records the document and lets the timer decide —
 *  it never awaits, and it is safe to call as often as the editor likes. */
export function noteLocalChange(p: Project | null): void {
  if (!p || !client()) return;
  pending = p;
}

/** Pushes whatever is pending, now, and waits for it. Used where the next thing
 *  that happens depends on the plan existing server-side — starting a render —
 *  and on the way out of the tab. */
export async function flushSync(): Promise<void> {
  if (inFlight) { await inFlight; return; }
  const p = pending;
  if (!p) return;
  pending = null;
  lastPushedAt = Date.now();
  inFlight = push(p).then(() => { inFlight = null; }, () => { inFlight = null; });
  await inFlight;
}

/** The timer's half of the contract: push, but no more often than the interval.
 *  Called from the same 3-second tick that drives the local autosave, so there
 *  is exactly one clock in the app rather than two that drift. */
export function maybePush(): void {
  if (!pending || inFlight) return;
  if (Date.now() - lastPushedAt < PUSH_INTERVAL_MS) return;
  void flushSync();
}

/** The plan's row uuid, pushing it up first if the account has never seen it.
 *  Renders carry a real foreign key to `plans`, so this has to have succeeded
 *  before one can be recorded — which is also why it returns null rather than
 *  inventing an id the database would reject. */
export async function ensurePlanSynced(p: Project): Promise<string | null> {
  if (!client()) return null;
  const known = uuids.get(p.id);
  /* Still push: the render is about to be generated from *this* version of the
     document, and a row holding last week's copy makes the lineage a lie. */
  const id = await push(p);
  return id ?? known ?? null;
}

/** Tombstones a plan. Not a delete: without a row saying "this is gone", a stale
 *  tab on another device pushes its local copy straight back up and the plan
 *  returns from the dead. The renders are deleted for real at the same moment —
 *  they are the part that costs money — which the `on delete cascade` from
 *  `renders.plan_id` does not do, because the plan row itself survives. */
export async function removeCloudPlan(clientId: string): Promise<void> {
  const db = client();
  if (!db) return;
  if (pending?.id === clientId) pending = null;

  const { data } = await db
    .from('plans')
    .update({ deleted_at: new Date().toISOString() })
    .eq('client_id', clientId)
    .select('id')
    .maybeSingle();

  uuids.delete(clientId);
  if (data?.id) await dropRenders(db, [data.id]);
}

/** Every plan in the account, tombstoned. Behind the same confirm as the local
 *  wipe, and it has to be: this is the one action in the app that cannot be
 *  undone from another device. */
export async function removeAllCloudPlans(): Promise<void> {
  const db = client();
  if (!db) return;
  pending = null;
  const { data } = await db
    .from('plans')
    .update({ deleted_at: new Date().toISOString() })
    .is('deleted_at', null)
    .select('id');
  uuids.clear();
  const ids = (data ?? []).map(r => r.id);
  if (ids.length) await dropRenders(db, ids);
}

/** The renders of these plans, rows and bytes both.
 *
 *  The bytes have to go first and they have to go explicitly: `renders.plan_id`
 *  cascades from the plan row, but the plan row survives as a tombstone, and
 *  nothing in Postgres knows that a `renders` row names an object in a bucket.
 *  Deleting only the rows leaves PNGs that are billed monthly and unreachable
 *  from any screen — the worst of both. */
async function dropRenders(db: Db, planIds: string[]): Promise<void> {
  const { data } = await db
    .from('renders')
    .select('image_path, thumb_path')
    .in('plan_id', planIds);

  const paths = (data ?? [])
    .flatMap(r => [r.image_path, r.thumb_path])
    .filter((p): p is string => !!p);

  /* Best-effort on the objects, unconditional on the rows: a bucket that refuses
     the delete costs storage, while a row left behind would keep a dead render
     in the filmstrip pointing at nothing. */
  if (paths.length) {
    try { await db.storage.from(RENDER_BUCKET).remove(paths); } catch { /* orphaned bytes */ }
  }
  await db.from('renders').delete().in('plan_id', planIds);
}

/* ── lifecycle ────────────────────────────────────────────────────────────── */

/** Wires the sync to the page. Returns its own teardown.
 *
 *  `visibilitychange` rather than `beforeunload`: the unload handler cannot wait
 *  for a network round trip, and every browser has spent a decade making that
 *  less true rather than more. Hiding the tab is the last moment a push can
 *  reliably start, so that is when the pending document goes up. */
export function startSync(reporter: Reporter): () => void {
  report = reporter;
  const onHide = () => { if (document.visibilityState === 'hidden') void flushSync(); };
  document.addEventListener('visibilitychange', onHide);
  return () => {
    document.removeEventListener('visibilitychange', onHide);
    report = () => { /* detached */ };
  };
}

/** Drops everything this module is holding. For sign-out: the next account on
 *  this browser must not inherit a pending push, a size complaint, or a map of
 *  someone else's plan ids. */
export function resetSync(): void {
  pending = null;
  inFlight = null;
  lastPushedAt = 0;
  tooBig.clear();
  uuids.clear();
}
