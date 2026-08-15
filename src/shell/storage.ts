import type { Project } from '@engine/types';
import { migrate } from '@engine/model';
import { ed } from '@state/store';

/** Browser-only persistence. Deliberately outside the engine so the engine
 *  stays runnable in Node and, later, on a server. Replaced by the API once
 *  accounts land; this stays as the offline cache. */

export const LS_IDX = 'pgs.index.v2';
export const LS_P = 'pgs.proj.v2.';
export const LS_AUTO = 'pgs.auto.v2';
export const LS_MODE = 'pgs.mode.v1';
export const LS_COACH = 'pgs.coach.v1';

export interface LibraryEntry {
  id: string; name: string; address: string; url: string; updatedAt: number; nf: number;
}

export function readIndex(): LibraryEntry[] {
  try { return (JSON.parse(localStorage.getItem(LS_IDX) || '[]') as LibraryEntry[]) || []; }
  catch { return []; }
}
function writeIndex(a: LibraryEntry[]) {
  try { localStorage.setItem(LS_IDX, JSON.stringify(a)); } catch { /* quota */ }
}

export function saveProject(silent?: boolean): boolean {
  const s = ed();
  const p = s.project;
  if (!p) return false;
  p.updatedAt = Date.now();
  try {
    localStorage.setItem(LS_P + p.id, JSON.stringify(p));
    const idx = readIndex().filter(x => x.id !== p.id);
    idx.unshift({
      id: p.id, name: p.name,
      address: p.source?.address ?? '',
      url: p.source?.url ?? '',
      updatedAt: p.updatedAt, nf: p.floors.length,
    });
    writeIndex(idx);
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
  try {
    const raw = localStorage.getItem(LS_P + id);
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
  try { localStorage.removeItem(LS_P + id); } catch { /* ignore */ }
  writeIndex(readIndex().filter(x => x.id !== id));
  forgetRenders(id);
}

export function clearLibrary() {
  readIndex().forEach(x => {
    try { localStorage.removeItem(LS_P + x.id); } catch { /* ignore */ }
    forgetRenders(x.id);
  });
  writeIndex([]);
}

/* ── autosave ───────────────────────────────────────────────────── */

export function autosave() {
  const s = ed();
  if (!s.project) return;
  try {
    localStorage.setItem(LS_AUTO, JSON.stringify({ p: s.project, fi: s.floorIndex, at: Date.now() }));
  } catch { /* quota — the library copy is the one that matters */ }
}

export function readAutosave(): { p: Project; fi: number } | null {
  try {
    const raw = localStorage.getItem(LS_AUTO);
    if (!raw) return null;
    const st = JSON.parse(raw) as { p: Project; fi: number };
    if (!st?.p?.floors?.length) return null;
    st.p = migrate(st.p);
    return st;
  } catch { return null; }
}

export const readMode = () => {
  try { return localStorage.getItem(LS_MODE) || 'simple'; } catch { return 'simple'; }
};
export const writeMode = (simple: boolean) => {
  try { localStorage.setItem(LS_MODE, simple ? 'simple' : 'pro'); } catch { /* ignore */ }
};
export const coachSeen = () => {
  try { return !!localStorage.getItem(LS_COACH); } catch { return true; }
};
export const markCoachSeen = () => {
  try { localStorage.setItem(LS_COACH, '1'); } catch { /* ignore */ }
};
