import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { Draft, Floor, Hit, Layers, Marquee, Pt, Project, SelRef, View } from '@engine/types';
import { useMemo } from 'react';
import { blankProject, migrate, resolveSel } from '@engine/model';

/** The document lives here, not in React state: repainting 183 walls through
 *  reconciliation would be pointless. Components subscribe to the slices they
 *  render; the canvas subscribes to everything and repaints imperatively. */

export type Tool = 'select' | 'pan' | 'wall' | 'room' | 'door' | 'window' | 'text' | 'measure';
export type ModalId = 'import' | 'library' | 'calibrate' | 'render' | null;

export interface Toast { id: string; text: string; kind?: 'ok' | 'err' }

export interface EditorState {
  project: Project | null;
  floorIndex: number;
  sel: SelRef[];
  tool: Tool;
  /** a catalogue kind, or 'draw:wall' etc., armed and waiting for a click */
  place: string | null;
  view: View;
  layers: Layers;
  grid: boolean;
  snap: boolean;
  gridSize: number;
  showRef: boolean;
  refOpacity: number;
  ghost: boolean;
  simple: boolean;
  draft: Draft | null;
  marquee: Marquee | null;
  snapHint: Pt | null;
  hover: Hit | null;
  /** last pointer position, so the place-ghost can follow it */
  mouseWorld: Pt;
  mouseInside: boolean;
  spaceDown: boolean;
  dirty: boolean;
  savedId: string | null;
  modal: ModalId;
  trayOpen: boolean;
  /** true while the scale-calibration click sequence is running */
  calibrating: boolean;
  toasts: Toast[];
  undo: string[];
  redo: string[];
  /** bumped on every in-place mutation so subscribers repaint */
  rev: number;

  floor: () => Floor | null;
  setProject: (p: Project, opts?: { saved?: boolean }) => void;
  setFloorIndex: (i: number) => void;
  setSel: (s: SelRef[]) => void;
  setView: (v: View) => void;
  patch: (p: Partial<EditorState>) => void;
  pushUndo: () => void;
  dropUndo: () => void;
  undoStep: () => void;
  redoStep: () => void;
  touch: () => void;
  toast: (text: string, kind?: 'ok' | 'err') => void;
  dismissToast: (id: string) => void;
}

const UNDO_CAP = 120;
let toastSeq = 0;

export const useEditor = create<EditorState>((set, get) => ({
  project: null,
  floorIndex: 0,
  sel: [],
  tool: 'select',
  place: null,
  view: { zoom: 0.28, px: 0, py: 0 },
  layers: { rooms: true, areas: true, furn: true, dims: true, notes: true },
  grid: true,
  snap: true,
  gridSize: 5,
  showRef: false,
  refOpacity: 0.45,
  ghost: false,
  simple: true,
  draft: null,
  marquee: null,
  snapHint: null,
  hover: null,
  mouseWorld: { x: 0, y: 0 },
  mouseInside: false,
  spaceDown: false,
  dirty: false,
  savedId: null,
  modal: null,
  trayOpen: false,
  calibrating: false,
  toasts: [],
  undo: [],
  redo: [],
  rev: 0,

  floor: () => {
    const { project, floorIndex } = get();
    return project ? project.floors[floorIndex] ?? null : null;
  },

  setProject: (p, opts) => set({
    project: migrate(p),
    floorIndex: 0,
    sel: [],
    draft: null,
    undo: [],
    redo: [],
    savedId: opts?.saved ? p.id : null,
    dirty: !opts?.saved,
    rev: get().rev + 1,
  }),

  setFloorIndex: i => set({ floorIndex: i, sel: [], draft: null, rev: get().rev + 1 }),
  setSel: sel => set({ sel }),
  setView: view => set({ view }),
  patch: p => set(p as Partial<EditorState>),

  pushUndo: () => {
    const { project, floorIndex, undo } = get();
    if (!project) return;
    const next = undo.concat(JSON.stringify({ p: project, fi: floorIndex }));
    if (next.length > UNDO_CAP) next.shift();
    set({ undo: next, redo: [], dirty: true });
  },

  /** discard the last snapshot — for gestures that turned out to change nothing */
  dropUndo: () => set({ undo: get().undo.slice(0, -1) }),

  undoStep: () => {
    const { undo, redo, project, floorIndex, rev } = get();
    if (!undo.length || !project) return;
    const snapshot = JSON.stringify({ p: project, fi: floorIndex });
    const prev = JSON.parse(undo[undo.length - 1]) as { p: Project; fi: number };
    set({
      undo: undo.slice(0, -1),
      redo: redo.concat(snapshot),
      project: prev.p,
      floorIndex: Math.min(prev.fi, prev.p.floors.length - 1),
      sel: [], draft: null, dirty: true, rev: rev + 1,
    });
  },

  redoStep: () => {
    const { undo, redo, project, floorIndex, rev } = get();
    if (!redo.length || !project) return;
    const snapshot = JSON.stringify({ p: project, fi: floorIndex });
    const next = JSON.parse(redo[redo.length - 1]) as { p: Project; fi: number };
    set({
      redo: redo.slice(0, -1),
      undo: undo.concat(snapshot),
      project: next.p,
      floorIndex: Math.min(next.fi, next.p.floors.length - 1),
      sel: [], draft: null, dirty: true, rev: rev + 1,
    });
  },

  /** The document is mutated in place for speed, so subscribers need a nudge. */
  touch: () => {
    const { project, rev } = get();
    if (!project) return;
    project.updatedAt = Date.now();
    set({ rev: rev + 1, dirty: true });
  },

  toast: (text, kind) => {
    const id = `t${++toastSeq}`;
    set({ toasts: get().toasts.concat({ id, text, kind }) });
    setTimeout(() => get().dismissToast(id), kind === 'err' ? 6200 : 3300);
  },
  dismissToast: id => set({ toasts: get().toasts.filter(t => t.id !== id) }),
}));

/** zustand v5 has no automatic shallow equality: a selector returning a fresh
 *  object literal never compares equal and re-renders forever. Use this for any
 *  selector that builds an object. */
export function useEditorShallow<T>(sel: (s: EditorState) => T): T {
  return useEditor(useShallow(sel));
}

/** Resolving a selection allocates, so it must not live inside a selector.
 *  Subscribe to the stable inputs and derive from them instead. */
export function useSelection() {
  const selRefs = useEditor(s => s.sel);
  const floor = useEditor(s => s.floor());
  const rev = useEditor(s => s.rev);
  return useMemo(() => resolveSel(floor, selRefs), [floor, selRefs, rev]);
}

export const selectedObjects = (s: EditorState) => resolveSel(s.floor(), s.sel);
export const isSelected = (s: EditorState, t: string, id: string) =>
  s.sel.some(x => x.t === t && x.id === id);

export const bootProject = () => blankProject('Untitled plan', false);

/** shorthand for handlers that live outside React */
export const ed = () => useEditor.getState();
