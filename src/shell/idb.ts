/** The IndexedDB plumbing, once.
 *
 *  Extracted from `./renders.ts` when photos needed a second database with the
 *  same seven awkward requirements: a connection that is cached but never caches
 *  a *failure*, a transaction that resolves on the transaction rather than on
 *  the put (a full disk aborts after the request has already reported success),
 *  a cursor walk that never awaits mid-transaction, and a delete that closes our
 *  own handle first because otherwise it blocks forever behind it.
 *
 *  Every one of those is a bug someone already found. Writing them twice is how
 *  one copy keeps them and the other does not. */

/** Distinguishing "this browser refuses to open the database" from "the write
 *  failed" decides which message the user gets, and only the open path knows. */
export const UNAVAILABLE = 'idb-unavailable';

export interface IdbSpec {
  name: string;
  version: number;
  /** Called inside `onupgradeneeded`. Branch on `oldVersion` rather than
   *  dropping and recreating — a v2 has to migrate what is already there. */
  upgrade: (db: IDBDatabase, oldVersion: number) => void;
}

export interface Idb {
  reader: (store: string) => Promise<IDBObjectStore>;
  write: (store: string, run: (s: IDBObjectStore) => void) => Promise<void>;
  /** Wipes the database. For tests and for the e2e `fresh()` helper —
   *  IndexedDB survives between Playwright runs, not just between tests. */
  destroy: () => Promise<void>;
}

export function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** Walks a cursor to exhaustion. Every continue() is issued from the success
 *  handler so nothing awaits mid-transaction, which would let it auto-close. */
export function walk<T>(
  req: IDBRequest<IDBCursorWithValue | null>,
  each: (row: T, c: IDBCursorWithValue) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(); return; }
      each(c.value as T, c);
      c.continue();
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB cursor failed'));
  });
}

export function errName(err: unknown): string {
  return typeof err === 'object' && err !== null && 'name' in err
    ? String((err as { name: unknown }).name)
    : '';
}

export function idb(spec: IdbSpec): Idb {
  let conn: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    /* Safari in a private window threw on the property access itself rather
       than failing the open, so even reaching for indexedDB needs the guard. */
    try {
      if (typeof indexedDB === 'undefined') throw new Error(UNAVAILABLE);
      req = indexedDB.open(spec.name, spec.version);
    } catch { reject(new Error(UNAVAILABLE)); return; }

    req.onupgradeneeded = ev => spec.upgrade(req.result, ev.oldVersion);
    req.onsuccess = () => {
      const d = req.result;
      /* another tab upgrading is blocked for as long as this handle is open */
      d.onversionchange = () => { d.close(); conn = null; };
      resolve(d);
    };
    req.onerror = () => reject(req.error ?? new Error(UNAVAILABLE));
    req.onblocked = () => reject(new Error(UNAVAILABLE));
  });

  const db = (): Promise<IDBDatabase> => {
    if (!conn) {
      conn = open().catch(err => {
        /* a rejected connection must not stay cached — one failed open would
           otherwise poison every later call without ever retrying */
        conn = null;
        throw err;
      });
    }
    return conn;
  };

  return {
    reader: async store => {
      const d = await db();
      return d.transaction(store, 'readonly').objectStore(store);
    },

    write: async (store, run) => {
      const d = await db();
      await new Promise<void>((resolve, reject) => {
        const t = d.transaction(store, 'readwrite');
        /* Resolve on the transaction, never on the put request: a full disk
           aborts the transaction after the request has already reported
           success, so resolving early would announce a save that never
           landed. */
        t.oncomplete = () => resolve();
        t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
        t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
        run(t.objectStore(store));
      });
    },

    destroy: () => {
      const handle = conn;
      conn = null;
      /* the delete blocks forever behind a live handle, so close ours first */
      return Promise.resolve(handle)
        .then(d => d?.close(), () => undefined)
        .then(() => new Promise<void>(resolve => {
          try {
            const req = indexedDB.deleteDatabase(spec.name);
            /* resolve on every outcome including onblocked — a wipe that cannot
               run must not hang a test run waiting for a tab that will never
               close */
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          } catch { resolve(); }
        }));
    },
  };
}
