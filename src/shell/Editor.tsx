'use client';

import { useCallback, useEffect } from 'react';
import { ed, useEditor } from '@state/store';
import type { Tool } from '@state/store';
import { blankProject } from '@engine/model';
import { fitFloor } from '@engine/view';
import { Canvas } from './Canvas';
import { commitDraft, deleteSelection, duplicateSelection, nudge } from './commands';
import { autosave, readAutosave, readIndex, readRendersBar, saveProject } from './storage';
import { readImageFile, readJsonFile } from './files';
import { importFromUrl } from './funda';
import { IconSprite } from './ui/Icons';
import { TestBridge } from './TestBridge';
import { FloorBar, TopBar, ToolRail } from './ui/Chrome';
import { AddTray, ObjectToolbar, StageOverlays } from './ui/Overlays';
import { ModalHost } from './ui/Modals';
import { RenderModal } from './ui/RenderModal';
import { RendersBar } from './ui/RendersBar';
import { Toasts } from './ui/Toasts';

const TOOLKEYS: Record<string, Tool> = {
  v: 'select', h: 'pan', w: 'wall', r: 'room', d: 'door', n: 'window', t: 'text', m: 'measure',
};

export function Editor() {
  const modal = useEditor(s => s.modal);
  const rendersOpen = useEditor(s => s.rendersOpen);
  const project = useEditor(s => s.project);

  const fit = useCallback(() => {
    const cv = document.querySelector<HTMLCanvasElement>('#cv');
    if (cv) ed().setView(fitFloor(ed().floor(), cv.clientWidth, cv.clientHeight));
  }, []);

  /* ── boot: deep link, autosave, or the importer ─────────────── */
  useEffect(() => {
    /* Read before the early return: the sidebar's state is not the project's,
       and a reload onto an already-loaded editor still has to restore it. */
    ed().patch({ rendersOpen: readRendersBar() });
    if (ed().project) return;

    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash === 'new' || hash === 'garden') {
      ed().setProject(blankProject(hash === 'garden' ? 'Garden design' : 'Untitled plan', hash === 'garden'));
      requestAnimationFrame(fit);
      return;
    }
    if (hash.startsWith('import=')) {
      ed().patch({ modal: 'import' });
      void importFromUrl(hash.slice(7), () => { /* the modal shows its own steps */ });
      return;
    }
    const auto = readAutosave();
    if (auto) {
      ed().setProject(auto.p, { saved: readIndex().some(x => x.id === auto.p.id) });
      ed().patch({ floorIndex: Math.min(auto.fi, auto.p.floors.length - 1) });
      requestAnimationFrame(fit);
      ed().toast(`Picked up where you left off — “${auto.p.name}”`);
      return;
    }
    ed().patch({ modal: 'import' });
  }, [fit]);

  /* fit once the first project lands */
  useEffect(() => { if (project) requestAnimationFrame(fit); }, [project?.id, fit]);

  /* The renders sidebar takes ~290px off the canvas. Without a refit the plan
     stays where it was and slides under it. */
  useEffect(() => { if (ed().project) requestAnimationFrame(fit); }, [rendersOpen, fit]);

  /* ── autosave + leave guard ─────────────────────────────────── */
  useEffect(() => {
    const t = setInterval(() => { if (ed().dirty) autosave(); }, 3000);
    const before = (e: BeforeUnloadEvent) => {
      autosave();
      if (ed().dirty) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', before);
    return () => { clearInterval(t); window.removeEventListener('beforeunload', before); };
  }, []);

  /* ── keyboard ───────────────────────────────────────────────── */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      /* This guard is the ONLY thing keeping tool shortcuts from firing while
         someone types. Next hydrates at the document level, so React's
         delegated listeners live on this same node — an input's
         stopPropagation() cannot stop us. A field that wants a key to act
         globally has to do it itself. Do not relax this. */
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const s = ed();
      const mod = e.metaKey || e.ctrlKey;

      if (e.code === 'Space' && !s.spaceDown) { s.patch({ spaceDown: true }); e.preventDefault(); return; }
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? s.redoStep() : s.undoStep(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const f = s.floor();
        if (!f) return;
        s.setSel([
          ...f.walls.map(x => ({ t: 'wall' as const, id: x.id })),
          ...f.areas.map(x => ({ t: 'area' as const, id: x.id })),
          ...f.items.map(x => ({ t: 'item' as const, id: x.id })),
          ...f.notes.map(x => ({ t: 'note' as const, id: x.id })),
          ...f.dims.map(x => ({ t: 'dim' as const, id: x.id })),
          ...f.lines.map(x => ({ t: 'line' as const, id: x.id })),
        ]);
        return;
      }
      if (mod) return;

      if (e.key === 'Escape') {
        if (s.draft || s.place) s.patch({ draft: null, place: null, snapHint: null });
        else if (s.trayOpen) s.patch({ trayOpen: false });
        else if (s.modal) s.patch({ modal: null, calibrating: false });
        else s.setSel([]);
        return;
      }
      if (e.key === 'Enter') { if (s.draft) commitDraft(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSelection(); return; }
      if (e.key === '0') { fit(); return; }

      const k = e.key.toLowerCase();
      if (k === 'g') { s.patch({ grid: !s.grid }); return; }
      if (k === 's') { s.patch({ snap: !s.snap }); s.toast(`Snapping ${!s.snap ? 'on' : 'off'}`); return; }
      if (k === 'b') {
        if (!s.floor()?.ref) s.toast('This floor has no reference image.', 'err');
        else s.patch({ showRef: !s.showRef });
        return;
      }
      if (k === 'l') { s.patch({ ghost: !s.ghost }); return; }
      if (k === 'a') { e.preventDefault(); s.patch({ trayOpen: !s.trayOpen }); return; }
      if (TOOLKEYS[k]) { s.patch({ tool: TOOLKEYS[k], place: null, draft: null }); return; }

      const N: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
      };
      if (N[e.key]) { e.preventDefault(); const m = e.shiftKey ? 10 : 1; nudge(N[e.key][0] * m, N[e.key][1] * m); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') ed().patch({ spaceDown: false }); };
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    return () => { document.removeEventListener('keydown', down); document.removeEventListener('keyup', up); };
  }, [fit]);

  /* ── files dropped anywhere ─────────────────────────────────── */
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      if (/^image\//.test(f.type)) {
        if (!ed().project) ed().setProject(blankProject('Traced plan', false));
        readImageFile(f, fit);
      } else if (/json$/i.test(f.name)) readJsonFile(f);
    };
    document.addEventListener('dragover', over);
    document.addEventListener('drop', drop);
    return () => { document.removeEventListener('dragover', over); document.removeEventListener('drop', drop); };
  }, [fit]);

  const stageClass = useEditor(s => (s.tool === 'pan' || s.spaceDown ? 'stage pan' : s.tool === 'select' ? 'stage sel' : 'stage'));

  return (
    <>
      <IconSprite />
      <TestBridge />
      <div className={`app${rendersOpen ? ' renders' : ''}`} id="app">
        <TopBar />
        <ToolRail />
        <main className={stageClass} id="stage">
          <Canvas />
          <StageOverlays onFit={fit} />
          <ObjectToolbar />
        </main>
        <RendersBar />
        <FloorBar onFit={fit} />
      </div>
      <AddTray />
      <ModalHost />
      {modal === 'render' && <RenderModal />}
      <Toasts />
    </>
  );
}
