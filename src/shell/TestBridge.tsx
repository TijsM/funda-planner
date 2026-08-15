'use client';

import { useEffect } from 'react';
import { ed } from '@state/store';
import { rs } from '@state/renders';
import { contentBBox } from '@engine/model';
import { paint } from '@engine/render';
import { deleteDatabase } from './renders';
import { refreshRenders } from './jobs';

/** Exposes the store under the name the browser suite already drives, so the
 *  68 end-to-end tests validate this port instead of being rewritten alongside
 *  it. Getters read live state; the few setters the specs use write through.
 *  The old single-file build exposed the same handle. */
export function TestBridge() {
  useEffect(() => {
    const bridge = {
      get proj() { return ed().project; },
      get fi() { return ed().floorIndex; },
      set fi(v: number) { ed().setFloorIndex(v); },
      get sel() { return ed().sel; },
      set sel(v: { t: string; id: string }[]) { ed().setSel(v as never); },
      get place() { return ed().place; },
      get tool() { return ed().tool; },
      get trayOpen() { return ed().trayOpen; },
      get draft() { return ed().draft; },
      get rendersOpen() { return ed().rendersOpen; },
      get dirty() { return ed().dirty; },
      get grid() { return ed().grid; },
      get showRef() { return ed().showRef; },
      /* the legacy handle exposed layer flags as 0/1, not booleans */
      get view() {
        const l = ed().layers;
        return { rooms: +l.rooms, areas: +l.areas, furn: +l.furn, dims: +l.dims, notes: +l.notes };
      },
      get layers() { return ed().layers; },
      get zoom() { return ed().view.zoom; },
      set zoom(v: number) { ed().setView({ ...ed().view, zoom: v }); },
      get px() { return ed().view.px; },
      set px(v: number) { ed().setView({ ...ed().view, px: v }); },
      get py() { return ed().view.py; },
      set py(v: number) { ed().setView({ ...ed().view, py: v }); },
    };
    const w = window as unknown as Record<string, unknown>;
    w.__S = bridge;
    w.__paint = paint;
    w.__contentBBox = contentBBox;
    w.__setPlace = (k: string | null) => ed().patch({ place: k });
    w.__setSel = (s: { t: string; id: string }[]) => ed().setSel(s as never);
    w.__ed = ed;
    /* The render workspace is a second store on purpose (Canvas.tsx:72 repaints
       on every editor set(), and a job ticks once a second), which puts it out
       of reach of __ed — so it gets its own handle rather than being invisible
       to the suite. */
    w.__renders = rs;
    /* IndexedDB survives between Playwright tests and between whole runs, so
       fresh() needs a way to wipe it that does not depend on the modal. */
    w.__wipeRenders = async () => {
      await deleteDatabase();
      rs().patch({ renders: [], selectedId: null, parentId: null });
      await refreshRenders();
    };
  }, []);
  return null;
}
