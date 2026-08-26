import type { Pt } from '@engine/types';
import {
  clipCount, clipOfFloor, clipOfSelection, clipText, cloneFloor, copyName, insertFloor,
  parseClip, pasteObjects, type Clip,
} from '@engine/io/clip';
import { ed } from '@state/store';
import { deleteSelection } from './commands';

/** Copy, cut and paste against the *system* clipboard, so a copy survives a
 *  reload, crosses tabs, and can be pasted into another plan.
 *
 *  Two doors into the same clipboard, because neither alone is enough: the
 *  browser's own copy/paste events (wired in `Editor.tsx`) need no permission
 *  and are what ⌘C/⌘V fire, while the toolbar buttons have no event to hang on
 *  and go through the async Clipboard API. */

/** What we last put on the clipboard, kept because we cannot always read it
 *  back: Firefox gives a page no `readText()` at all, and Safari only inside a
 *  gesture it approves of. Without this, Copy from the toolbar and Paste from
 *  the keyboard would not be the same clipboard. */
let memory: string | null = null;

export const rememberClip = (text: string) => { memory = text; };

/** Test seam and the paste path's fallback — never the source of truth. */
export const lastClip = () => memory;

function describe(c: Clip): string {
  if (c.kind === 'floor') return `floor “${c.floor.name}”`;
  const n = clipCount(c);
  return n === 1 ? '1 object' : `${n} objects`;
}

/** The copy for what is selected — or, with nothing selected, for the floor
 *  itself. ⌘C on an empty canvas meaning "this floor" is what makes a tab
 *  copyable at all, and there is nothing else it could sensibly mean. */
export function clipOfCurrent(): { text: string; label: string } | null {
  const s = ed();
  const f = s.floor();
  if (!f) return null;
  const c = s.sel.length ? clipOfSelection(f, s.sel) : clipOfFloor(f);
  if (!c) return null;
  return { text: clipText(c), label: describe(c) };
}

/** Where a paste lands: under the pointer when it is over the plan, otherwise
 *  nudged off the original the way a duplicate is. */
export const pastePoint = (): Pt | null => {
  const s = ed();
  return s.mouseInside ? { ...s.mouseWorld } : null;
};

export async function copySelection(): Promise<boolean> {
  const cur = clipOfCurrent();
  if (!cur) { ed().toast('Nothing to copy.', 'err'); return false; }
  memory = cur.text;
  try {
    await navigator.clipboard.writeText(cur.text);
  } catch {
    /* Denied or unavailable — `memory` still holds it, so paste inside this tab
       works. Say nothing: a warning about a permission nobody asked for is
       noise when the thing they asked for happened anyway. */
  }
  ed().toast(`Copied ${cur.label}.`);
  return true;
}

export async function cutSelection(): Promise<void> {
  const had = ed().sel.length;
  if (!(await copySelection())) return;
  /* Only objects are cut. ⌘X with nothing selected copies the floor, and
     deleting the floor someone is standing on is not what they asked for. */
  if (had) deleteSelection();
}

/** Pastes clipboard text if it is ours. Returns false for anything else, so the
 *  browser's own paste can go ahead. */
export function pasteClipText(raw: string, at: Pt | null = null): boolean {
  const c = parseClip(raw);
  if (!c) return false;
  const s = ed();
  if (!s.project) return false;

  if (c.kind === 'floor') {
    s.pushUndo();
    const f = cloneFloor(c.floor, copyName(c.floor.name, s.project.floors.map(x => x.name)));
    const i = insertFloor(s.project.floors, f, s.floorIndex);
    s.patch({ floorIndex: i, sel: [], draft: null });
    s.touch();
    s.toast(`Pasted floor “${f.name}”.`);
    return true;
  }

  const fl = s.floor();
  if (!fl) return false;
  s.pushUndo();
  const r = pasteObjects(fl, c, at);
  if (!r.sel.length) {
    s.dropUndo();
    s.toast(r.skipped ? 'Nothing to paste that into — draw a wall first.' : 'Nothing to paste.', 'err');
    return true;
  }
  s.setSel(r.sel);
  s.touch();
  s.toast(
    r.skipped
      ? `Pasted ${r.sel.length} — ${r.skipped} needed a wall to sit in and found none.`
      : `Pasted ${r.sel.length === 1 ? '1 object' : `${r.sel.length} objects`}.`,
    r.skipped ? 'err' : undefined,
  );
  return true;
}

/** The toolbar's paste. The keyboard uses the browser's own paste event, which
 *  needs no permission — this path is for a button, which has no event. */
export async function pasteFromClipboard(): Promise<void> {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = memory ?? '';
  }
  if (!pasteClipText(text || memory || '', pastePoint())) {
    ed().toast('The clipboard holds nothing from this app.', 'err');
  }
}
