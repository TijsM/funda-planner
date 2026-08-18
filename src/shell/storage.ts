import type { Project } from '@engine/types';
import { migrate } from '@engine/model';
import { entryOf, type LibraryEntry } from '@data/library';
import { isCloud } from '@data/config';
import { client } from '@data/supabase';
import { noteLocalChange } from '@data/sync';
import { ed } from '@state/store';

/** Browser-only persistence. Deliberately outside the engine so the engine
 *  stays runnable in Node and, later, on a server. In cloud mode this is no
 *  longer the only copy — it is the one the editor reads and writes
 *  synchronously, with `@data/sync` pushing it up on a timer — but it is still
 *  the copy that has to be there when the network is not. */

/* The entry shape moved to @data/library, where the cloud half can share it.
   Re-exported because half the shell imports it from here. */
export type { LibraryEntry };

export const LS_IDX = 'pgs.index.v2';
export const LS_P = 'pgs.proj.v2.';
export const LS_AUTO = 'pgs.auto.v2';
export const LS_RENDERS = 'pgs.rendersbar.v1';
export const LS_COACH = 'pgs.coach.v1';

/* ── whose keys are these ───────────────────────────────────────── */

let owner: string | null = null;
let asking: Promise<string | null> | null = null;

/** Every key holding a document goes through here, and nothing else decides.
 *
 *  In local mode the keys are the bare ones they have always been: an existing
 *  single-user install keeps its library across this change, and the Playwright
 *  suite keeps reading `pgs.index.v2` by name.
 *
 *  In cloud mode they carry the account's uuid. Without that, two people signing
 *  in on one browser read each other's plans straight out of the cache before
 *  any remote list can land — a leak, not a stale thumbnail.
 *
 *  Returns null when there is an account but we do not yet know which one, and
 *  every caller treats that as "storage is empty". Falling back to the bare key
 *  there would mean reading exactly the data this is here to separate. */
const key = (base: string): string | null =>
  !isCloud() ? base : owner ? `${base}~${owner}` : null;

/** Learns which account these keys belong to.
 *
 *  Resolves to null immediately in local mode. In cloud mode it reads the
 *  session out of the cookie the proxy has already refreshed — `getSession` does
 *  not go to the network, which is what makes it cheap enough for boot to wait
 *  on. It is a namespace choice, not an authorisation one; RLS is what decides
 *  who may read what.
 *
 *  A failure here leaves the local cache inert for the tab — reads empty, writes
 *  dropped — which is why it does not cache the failure: the next caller asks
 *  again. Even in that state nothing is lost, because `noteLocalChange` does not
 *  need the uuid and the account still gets the document. */
export function adoptUser(): Promise<string | null> {
  if (!isCloud() || owner) return Promise.resolve(owner);
  if (asking) return asking;
  const db = client();
  if (!db) return Promise.resolve(null);
  const ask = db.auth.getSession()
    .then(r => (owner = r.data.session?.user.id ?? null))
    .catch(() => { asking = null; return null; });
  asking = ask;
  return ask;
}

/** Forgets the account, so the next one to sign in on this browser starts from
 *  nothing rather than inheriting a namespace. Sign-out only. */
export function forgetUser() {
  owner = null;
  asking = null;
}

/* ── the index ──────────────────────────────────────────────────── */

export function readIndex(): LibraryEntry[] {
  const k = key(LS_IDX);
  if (!k) return [];
  try { return (JSON.parse(localStorage.getItem(k) || '[]') as LibraryEntry[]) || []; }
  catch { return []; }
}
export function writeIndex(a: LibraryEntry[]) {
  const k = key(LS_IDX);
  if (!k) return;
  try { localStorage.setItem(k, JSON.stringify(a)); } catch { /* quota */ }
}

/* ── documents ──────────────────────────────────────────────────── */

/* Telling the sync a document changed must never be able to break saving it.
   The local path works with the network, with an account, or with neither, and
   that is the whole promise of this file. */
const note = (p: Project) => {
  try { noteLocalChange(p); } catch { /* the next save notes it again */ }
};

/** Writes a document into the cache and its row into the index — no store
 *  patch, no toast. This is also how a copy pulled from the account warms the
 *  cache, and that is not somebody pressing Save. Lets a full quota throw, which
 *  `saveProject` turns into the sentence people actually read. */
export function putProject(p: Project) {
  const k = key(LS_P + p.id);
  if (!k) return;
  localStorage.setItem(k, JSON.stringify(p));
  const idx = readIndex();
  /* `synced` is not derived from the document, so re-deriving the row would
     drop it and the library would call an account's plan browser-only until the
     next remote list came back. */
  const was = idx.find(x => x.id === p.id);
  writeIndex([{ ...entryOf(p), synced: was?.synced }, ...idx.filter(x => x.id !== p.id)]);
}

export function saveProject(silent?: boolean): boolean {
  const s = ed();
  const p = s.project;
  if (!p) return false;
  p.updatedAt = Date.now();
  /* Before the write, not after: a browser that is out of room is the case where
     getting the document into the account matters most. */
  note(p);
  try {
    putProject(p);
    s.patch({ savedId: p.id, dirty: false });
    if (!silent) s.toast(`Saved “${p.name}” to the library`, 'ok');
    return true;
  } catch {
    s.toast(
      'Browser storage is full — most likely an embedded reference image. Export as JSON instead, or remove the reference image.',
      'err',
    );
    return false;
  }
}

export function loadProject(id: string): Project | null {
  const k = key(LS_P + id);
  if (!k) return null;
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    return migrate(JSON.parse(raw) as Project);
  } catch { return null; }
}

/* Deleting the plan has to take its renders with it. They are keyed by project
   id and the filmstrip only ever asks for the open project's, so a render left
   behind is unreachable from the UI for good — while still occupying the quota
   and still counted in "every render on this browser". Best-effort and not
   awaited: the plan is gone either way, and a failed cleanup must not stop it. */
function forgetRenders(id: string) {
  void import('./renders').then(m => m.deleteRendersForProject(id)).catch(() => { /* ignore */ });
}

export function deleteProject(id: string) {
  const k = key(LS_P + id);
  if (k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  writeIndex(readIndex().filter(x => x.id !== id));
  forgetRenders(id);
}

export function clearLibrary() {
  readIndex().forEach(x => {
    const k = key(LS_P + x.id);
    if (k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
    forgetRenders(x.id);
  });
  writeIndex([]);
}

/** Everything this browser holds for the account that is signing out: the index,
 *  the documents it names, their renders, and the autosave.
 *
 *  The keys are namespaced, so this is belt as well as braces — but a shared
 *  browser is exactly where "their plans are still on disk, just under another
 *  name" is not good enough. The cost is stated at the point of use: a plan too
 *  big to sync only ever existed here, and signing out is where it dies. */
export function dropLocalCache() {
  clearLibrary();
  /* Removed, not emptied. `clearLibrary` leaves the index key in place holding
     `[]`, and in cloud mode that key is named after the account — so an emptied
     index still tells whoever signs in next which uuid was here before them.
     The documents are already gone by this point; this takes the shape of the
     thing with it. */
  for (const base of [LS_IDX, LS_AUTO]) {
    const k = key(base);
    if (k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  }
  /* The whole render database, not the renders reachable from the index: a plan
     that was only ever autosaved, or one deleted while its renders failed to go
     with it, leaves rows nothing can name. IndexedDB is not namespaced by
     account the way the localStorage keys are, so those are precisely the rows
     the next person to sign in on this browser would inherit. */
  void import('./renders').then(m => m.deleteDatabase()).catch(() => { /* ignore */ });
}

/* ── autosave ───────────────────────────────────────────────────── */

export function autosave() {
  const s = ed();
  if (!s.project) return;
  /* Only a plan that is already in the library goes up. The autosave is a crash
     buffer for whatever is on screen — an import nobody has kept, a scratch
     drawing, a plan that was just deleted from the library and is still open —
     and none of that should become a row in the account. It also closes the
     resurrection: without this guard, deleting the open plan and waiting three
     seconds pushed it straight back up. Pressing Save is what says "this one is
     mine", and from then on every edit syncs. */
  if (s.savedId === s.project.id) note(s.project);
  const k = key(LS_AUTO);
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify({ p: s.project, fi: s.floorIndex, at: Date.now() }));
  } catch { /* quota — the library copy is the one that matters */ }
}

export function readAutosave(): { p: Project; fi: number } | null {
  const k = key(LS_AUTO);
  if (!k) return null;
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const st = JSON.parse(raw) as { p: Project; fi: number };
    if (!st?.p?.floors?.length) return null;
    st.p = migrate(st.p);
    return st;
  } catch { return null; }
}

/* Deliberately not namespaced: which way the sidebar was left and whether the
   coach marks have been seen are properties of the browser, not of the person
   signed into it, and resetting them on every sign-in would be a bug of its own. */
export const readRendersBar = () => {
  try { return localStorage.getItem(LS_RENDERS) === '1'; } catch { return false; }
};
export const writeRendersBar = (open: boolean) => {
  try { localStorage.setItem(LS_RENDERS, open ? '1' : '0'); } catch { /* ignore */ }
};
export const coachSeen = () => {
  try { return !!localStorage.getItem(LS_COACH); } catch { return true; }
};
export const markCoachSeen = () => {
  try { localStorage.setItem(LS_COACH, '1'); } catch { /* ignore */ }
};
