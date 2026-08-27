import type { ViewKind } from '@engine/prompt';
import type { ControlKind } from '@data/providers';
import { ed } from '@state/store';
import { isCloud } from '@data/config';
import { UNAVAILABLE, done, errName, idb, walk } from './idb';
import {
  cloudBytes, deleteCloudRender, deleteCloudRendersForPlan, listCloudRenders,
} from '@data/cloudRenders';

/** Browser-only store for generated renders. Deliberately its own database and
 *  not part of the document: `store.ts:127` JSON.stringifies the whole project
 *  into every undo snapshot and `Editor.tsx` autosaves that same object to
 *  localStorage every three seconds, so a single PNG hung off a Floor would
 *  blow the quota on the first stroke of the wall tool. Records reference a
 *  project and a floor by id and are never referenced back.
 *
 *  In local mode renders therefore live on this browser only — they do not
 *  travel with a JSON export, which is why per-render download is the product's
 *  only way out.
 *
 *  In cloud mode the same four reads and writes are answered by
 *  `@data/cloudRenders` instead, off a Postgres row and a private Storage
 *  bucket. The dispatch is per function and nothing above this file branches:
 *  every caller gets `RenderRecord`s either way. What differs is that a cloud
 *  record carries signed URLs and `blob: null` — so `rec.status === 'ready'`,
 *  never `rec.blob`, is what says one succeeded. */

/* `.v1` in the name follows the localStorage keys in storage.ts: it marks a
   format break so drastic that the old data is abandoned wholesale. IDB_VERSION
   is the other kind of change — an in-place migration, with a branch below. */
export const IDB_NAME = 'pgs.renders.v1';
export const IDB_VERSION = 1;
export const IDB_STORE = 'renders';
export const IDX_FLOOR = 'byFloor';
export const IDX_CREATED = 'byCreatedAt';

export interface RenderSettings {
  view: ViewKind;
  /** an area id, or '*' for the whole floor — the same shape buildPrompt() takes */
  room: string;
  style: string;
  furniture: boolean;
  dimensions: boolean;
  roomLabels: boolean;
  imgMeasures: boolean;
  /** Object numbers baked into the reference image. Written by records from the
   *  window in which the picture carried numbered discs; kept as a fact about
   *  how those renders were made, and read by nothing — the reference is
   *  glyph-free now, on every setting. */
  imgLabels?: boolean;
  /** Which provider drew it — an id from `@data/providers`, and the one field
   *  here that is not a preference: it is what makes a render reproducible at
   *  all, since the same prompt and seed on another model is another picture.
   *  Absent on every record written before there was a choice, and every one of
   *  those was FLUX.2 [max]. */
  provider?: string;
  /** The control maps that were asked for, in attach order — the order the
   *  prompt numbered them in. What was actually sent is this list narrowed by the
   *  provider (`attachedControls`), which is a function of `provider` and so is
   *  not stored twice. */
  controls?: ControlKind[];
  /** 0..1. Absent means the render predates the dial, which is the same picture
   *  as a provider that has no channel to turn. */
  controlScale?: number;
  /** The object photographs that actually went, by photo id, in attach order:
   *  `photos[0]` was image 2, `photos[1]` image 3, and so on after the plan.
   *
   *  A receipt, unlike `controls` above, which stores what was ticked. The
   *  difference is that a ticked map is a preference — re-run this on another
   *  provider and it should try to attach it again — while a photograph is a
   *  specific picture: "which one of my sofas is in this render" has exactly one
   *  answer, and it is this list. Absent on every record written before photos
   *  existed, and every one of those was rendered without them. */
  photos?: string[];
}

export interface RenderRecord {
  id: string;
  projectId: string;
  floorId: string;
  /** the render this one was re-run from — the whole of the lineage feature */
  parentId: string | null;
  /** the exact text sent to the provider, not a recipe for rebuilding it */
  prompt: string;
  settings: RenderSettings;
  seed: number | null;
  /** The provider's label, for a person reading the filmstrip — `modelLabelOf`
   *  writes it. The id a re-run resolves against is `settings.provider`; this
   *  string is display copy and nothing branches on it. */
  model: string;
  status: 'pending' | 'ready' | 'failed';
  error?: string;
  /* A failed render is kept so the user can see what they asked for and retry
     it, and a failed render has no bytes — hence nullable rather than optional,
     so the absent case has to be handled at every read. */
  blob: Blob | null;
  thumbnail?: Blob;
  /* Signed Storage URLs, cloud mode only — in local mode the bytes are right
     there in `blob` and there is nothing to sign. They expire after an hour;
     `refreshRenders()` re-signs the whole list on every open of the panel. */
  imageUrl?: string;
  thumbUrl?: string;
  createdAt: number;
  durationMs: number;
}

/** The one right way to ask "did this render produce an image?".
 *
 *  Never `rec.blob`. In cloud mode a perfectly good render carries no bytes at
 *  all — they sit in Storage behind a signed URL — so every truth-test that used
 *  to read the blob would quietly mark a whole account's renders failed, alert
 *  icon and all. */
export const succeeded = (rec: RenderRecord): boolean => rec.status === 'ready';

/* The connection, the transaction rules and the cursor walk live in `./idb.ts`
   now — photos need the same seven hard-won details and a second copy of them is
   a copy that keeps the fixes only until someone patches one of the two. */
const store = idb({
  name: IDB_NAME,
  version: IDB_VERSION,
  upgrade: (d, oldVersion) => {
    if (oldVersion < 1) {
      const os = d.createObjectStore(IDB_STORE, { keyPath: 'id' });
      /* createdAt is part of the key so the floor query comes back ordered
         out of the index, rather than sorted in memory after the fact */
      os.createIndex(IDX_FLOOR, ['projectId', 'floorId', 'createdAt']);
      os.createIndex(IDX_CREATED, 'createdAt');
    }
  },
});

const reader = () => store.reader(IDB_STORE);
const write = (run: (s: IDBObjectStore) => void) => store.write(IDB_STORE, run);

/* An array sorts after every number in IndexedDB's key ordering, so `[]` as the
   last element catches every createdAt without inventing a maximum timestamp —
   and a short array sorts before a longer one that shares its prefix, so the
   two-element lower bound catches the earliest. */
const floorRange = (projectId: string, floorId: string) =>
  IDBKeyRange.bound([projectId, floorId], [projectId, floorId, []]);
const projectRange = (projectId: string) =>
  IDBKeyRange.bound([projectId], [projectId, []]);

/* ── reads: never throw, never toast — an empty filmstrip is a survivable
      answer, and a modal that explodes on open is not ─────────────────────── */

/** This floor's renders, newest first. */
export async function listRenders(projectId: string, floorId: string): Promise<RenderRecord[]> {
  if (isCloud()) return listCloudRenders(projectId, floorId);
  try {
    const s = await reader();
    const rows = await done<RenderRecord[]>(s.index(IDX_FLOOR).getAll(floorRange(projectId, floorId)));
    return rows.reverse();
  } catch { return []; }
}

export async function getRender(id: string): Promise<RenderRecord | null> {
  try {
    const s = await reader();
    return (await done<RenderRecord | undefined>(s.get(id))) ?? null;
  } catch { return null; }
}

const bytesOf = (r: RenderRecord) => (r.blob?.size ?? 0) + (r.thumbnail?.size ?? 0);

/** Every render on this browser, all projects — the figure the UI shows next to
 *  the delete-all button. Cursored rather than getAll()'d so a hundred PNGs are
 *  never all in hand at once. */
export async function totalBytes(): Promise<number> {
  /* In cloud mode the quota that matters is the account's, not the browser's —
     and the account's copy is the only one there is, since nothing is written to
     IndexedDB at all. */
  if (isCloud()) return cloudBytes();
  try {
    const s = await reader();
    let sum = 0;
    await walk<RenderRecord>(s.openCursor(), r => { sum += bytesOf(r); });
    return sum;
  } catch { return 0; }
}

/* ── writes ───────────────────────────────────────────────────────────────── */

/** Saves a render, upserting on `id`. Returns false when the bytes did not
 *  land, so the caller can keep the image on screen and say so. */
export async function putRender(rec: RenderRecord): Promise<boolean> {
  /* Cloud mode writes no record from the browser: `/api/render` inserted the row
     before it answered and `/api/render/status` settled it, both server-side, so
     by the time the poller has a record in hand the durable copy already exists.
     True rather than false on purpose — the caller reads false as "these bytes
     are only on screen, hold them for the life of the tab", and here they are
     not, they are in Postgres and in the bucket. */
  if (isCloud()) return true;
  try {
    await write(s => { s.put(rec); });
    return true;
  } catch (err) {
    /* The one write worth interrupting someone for: a render costs money and a
       minute of waiting, and the only recovery is to download it before the tab
       closes. Name the actual cause — "storage error" tells nobody anything. */
    const s = ed();
    if (err instanceof Error && err.message === UNAVAILABLE) {
      s.toast(
        'This browser will not open storage for renders — a private window blocks it. Download this one now; it is gone when the tab closes.',
        'err',
      );
    } else if (errName(err) === 'QuotaExceededError') {
      s.toast(
        'Browser storage is full — renders are full-size PNGs and a dozen fills it. Delete a few from the filmstrip, or download the ones worth keeping.',
        'err',
      );
    } else {
      s.toast('This browser refused to save the render. Download it now if you want to keep it.', 'err');
    }
    return false;
  }
}

export async function deleteRender(id: string): Promise<boolean> {
  if (isCloud()) {
    if (await deleteCloudRender(id)) return true;
    ed().toast('That render could not be deleted from your account — it will be back after a reload.', 'err');
    return false;
  }
  try {
    await write(s => { s.delete(id); });
    return true;
  } catch {
    /* worth a toast: the thumbnail vanishes from the filmstrip on the optimistic
       redraw and comes back on the next open, which reads as a ghost */
    ed().toast('This browser refused to delete that render — it will be back after a reload.', 'err');
    return false;
  }
}

/** Drops every render of a project — for the library's delete, which otherwise
 *  leaves PNGs behind for a project that no longer exists. */
export async function deleteRendersForProject(projectId: string): Promise<void> {
  if (isCloud()) { await deleteCloudRendersForPlan(projectId); return; }
  try {
    await write(s => {
      walk(s.index(IDX_FLOOR).openCursor(projectRange(projectId)), (_r, c) => { c.delete(); })
        .catch(() => { /* the transaction's own onerror is what rejects write() */ });
    });
  } catch { /* swallowed: the project is already gone and there is no screen left
                to put a message on. The cost is orphaned bytes, which totalBytes()
                still counts and delete-all still reaches. */ }
}

/* ── plumbing the callers need ────────────────────────────────────────────── */

/** The status route returns base64 because BFL's delivery host sends no CORS
 *  header, so the bytes come back through our own server. The conversion lives
 *  here, on the way in: the store holds Blobs only — base64 is a third larger
 *  and IndexedDB has no reason to carry the padding. */
export function pngFromBase64(b64: string): Blob {
  /* tolerate a data: URL — canvas.toDataURL() produces one and it will be
     pasted into this path sooner or later */
  const comma = b64.indexOf(',');
  const raw = atob(b64.startsWith('data:') && comma > -1 ? b64.slice(comma + 1) : b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

/** The full-size bytes of one render, wherever they live — for download, which
 *  is the one place that needs the actual file rather than something to point an
 *  <img> at.
 *
 *  A cross-origin signed URL cannot simply be handed to `<a download>`: the
 *  attribute is ignored on another origin and the browser navigates to the PNG
 *  instead of saving it. So the bytes come back here first. */
export async function renderBlob(rec: RenderRecord): Promise<Blob | null> {
  if (rec.blob) return rec.blob;
  if (!rec.imageUrl) return null;
  try {
    const res = await fetch(rec.imageUrl);
    if (!res.ok) return null;
    return await res.blob();
  } catch { return null; }
}

/** Wipes the database. For tests and for the e2e `fresh()` helper — IndexedDB
 *  survives between Playwright runs, not just between tests. */
export const deleteDatabase = (): Promise<void> => store.destroy();
