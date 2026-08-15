import type { ViewKind } from '@engine/prompt';
import { ed } from '@state/store';

/** Browser-only store for generated renders. Deliberately its own database and
 *  not part of the document: `store.ts:127` JSON.stringifies the whole project
 *  into every undo snapshot and `Editor.tsx` autosaves that same object to
 *  localStorage every three seconds, so a single PNG hung off a Floor would
 *  blow the quota on the first stroke of the wall tool. Records reference a
 *  project and a floor by id and are never referenced back.
 *
 *  Renders therefore live on this browser only — they do not travel with a JSON
 *  export, which is why per-render download is the product's only way out. */

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
  model: string;
  status: 'pending' | 'ready' | 'failed';
  error?: string;
  /* A failed render is kept so the user can see what they asked for and retry
     it, and a failed render has no bytes — hence nullable rather than optional,
     so the absent case has to be handled at every read. */
  blob: Blob | null;
  thumbnail?: Blob;
  createdAt: number;
  durationMs: number;
}

/* Distinguishing "this browser refuses to open the database" from "the write
   failed" decides which message the user gets, and only the open path knows. */
const UNAVAILABLE = 'idb-unavailable';

let conn: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    /* Safari in a private window threw on the property access itself rather
       than failing the open, so even reaching for indexedDB needs the guard. */
    try {
      if (typeof indexedDB === 'undefined') throw new Error(UNAVAILABLE);
      req = indexedDB.open(IDB_NAME, IDB_VERSION);
    } catch { reject(new Error(UNAVAILABLE)); return; }

    req.onupgradeneeded = ev => {
      const d = req.result;
      /* branch on oldVersion rather than dropping and recreating — a v2 has to
         migrate the renders already sitting here, not throw them away */
      if (ev.oldVersion < 1) {
        const os = d.createObjectStore(IDB_STORE, { keyPath: 'id' });
        /* createdAt is part of the key so the floor query comes back ordered
           out of the index, rather than sorted in memory after the fact */
        os.createIndex(IDX_FLOOR, ['projectId', 'floorId', 'createdAt']);
        os.createIndex(IDX_CREATED, 'createdAt');
      }
    };
    req.onsuccess = () => {
      const d = req.result;
      /* another tab upgrading is blocked for as long as this handle is open */
      d.onversionchange = () => { d.close(); conn = null; };
      resolve(d);
    };
    req.onerror = () => reject(req.error ?? new Error(UNAVAILABLE));
    req.onblocked = () => reject(new Error(UNAVAILABLE));
  });
}

function db(): Promise<IDBDatabase> {
  if (!conn) {
    conn = open().catch(err => {
      /* a rejected connection must not stay cached — one failed open would
         otherwise poison every later call without ever retrying */
      conn = null;
      throw err;
    });
  }
  return conn;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

async function reader(): Promise<IDBObjectStore> {
  const d = await db();
  return d.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE);
}

async function write(run: (s: IDBObjectStore) => void): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(IDB_STORE, 'readwrite');
    /* Resolve on the transaction, never on the put request: a full disk aborts
       the transaction after the request has already reported success, so
       resolving early would announce a save that never landed. */
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
    t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
    run(t.objectStore(IDB_STORE));
  });
}

/** Walks a cursor to exhaustion. Every continue() is issued from the success
 *  handler so nothing awaits mid-transaction, which would let it auto-close. */
function walk(
  req: IDBRequest<IDBCursorWithValue | null>,
  each: (rec: RenderRecord, c: IDBCursorWithValue) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(); return; }
      each(c.value as RenderRecord, c);
      c.continue();
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB cursor failed'));
  });
}

/* An array sorts after every number in IndexedDB's key ordering, so `[]` as the
   last element catches every createdAt without inventing a maximum timestamp —
   and a short array sorts before a longer one that shares its prefix, so the
   two-element lower bound catches the earliest. */
const floorRange = (projectId: string, floorId: string) =>
  IDBKeyRange.bound([projectId, floorId], [projectId, floorId, []]);
const projectRange = (projectId: string) =>
  IDBKeyRange.bound([projectId], [projectId, []]);

function errName(err: unknown): string {
  return typeof err === 'object' && err !== null && 'name' in err
    ? String((err as { name: unknown }).name)
    : '';
}

/* ── reads: never throw, never toast — an empty filmstrip is a survivable
      answer, and a modal that explodes on open is not ─────────────────────── */

/** This floor's renders, newest first. */
export async function listRenders(projectId: string, floorId: string): Promise<RenderRecord[]> {
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
  try {
    const s = await reader();
    let sum = 0;
    await walk(s.openCursor(), r => { sum += bytesOf(r); });
    return sum;
  } catch { return 0; }
}

/* ── writes ───────────────────────────────────────────────────────────────── */

/** Saves a render, upserting on `id`. Returns false when the bytes did not
 *  land, so the caller can keep the image on screen and say so. */
export async function putRender(rec: RenderRecord): Promise<boolean> {
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

/** Wipes the database. For tests and for the e2e `fresh()` helper — IndexedDB
 *  survives between Playwright runs, not just between tests. */
export function deleteDatabase(): Promise<void> {
  const handle = conn;
  conn = null;
  /* the delete blocks forever behind a live handle, so close ours first */
  return Promise.resolve(handle)
    .then(d => d?.close(), () => undefined)
    .then(() => new Promise<void>(resolve => {
      try {
        const req = indexedDB.deleteDatabase(IDB_NAME);
        /* resolve on every outcome including onblocked — a wipe that cannot run
           must not hang a test run waiting for a tab that will never close */
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      } catch { resolve(); }
    }));
}
