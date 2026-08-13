import { create } from 'zustand';
import type { Draft, Floor, Layers, Marquee, Pt, Project, SelRef, View } from '@engine/types';
import { blankProject, migrate, resolveSel } from '@engine/model';

/** The document lives here, not in React state: repainting 183 walls through
 *  reconciliation would be pointless. Components subscribe to the slices they
 *  render; the canvas subscribes to everything and repaints imperatively. */

export type Tool = 'select' | 'pan' | 'wall' | 'room' | 'door' | 'window' | 'text' | 'measure';

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
  dirty: boolean;
  undo: string[];
  redo: string[];

  floor: () => Floor | null;
  setProject: (p: Project, opts?: { fresh?: boolean }) => void;
  setFloorIndex: (i: number) => void;
  setSel: (s: SelRef[]) => void;
  setView: (v: View) => void;
  patch: (p: Partial<EditorState>) => void;
  /** snapshot before a mutation, so undo has something to go back to */
  pushUndo: () => void;
  undoStep: () => void;
  redoStep: () => void;
  /** call after mutating the document in place, to wake subscribers */
  touch: () => void;
}

const UNDO_CAP = 120;

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
  dirty: false,
  undo: [],
  redo: [],

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
    dirty: !opts?.fresh,
  }),

  setFloorIndex: i => set({ floorIndex: i, sel: [], draft: null }),
  setSel: sel => set({ sel }),
  setView: view => set({ view }),
  patch: p => set(p as EditorState),

  pushUndo: () => {
    const { project, floorIndex, undo } = get();
    if (!project) return;
    const next = undo.concat(JSON.stringify({ p: project, fi: floorIndex }));
    if (next.length > UNDO_CAP) next.shift();
    set({ undo: next, redo: [], dirty: true });
  },

  undoStep: () => {
    const { undo, redo, project, floorIndex } = get();
    if (!undo.length || !project) return;
    const snapshot = JSON.stringify({ p: project, fi: floorIndex });
    const prev = JSON.parse(undo[undo.length - 1]) as { p: Project; fi: number };
    set({
      undo: undo.slice(0, -1),
      redo: redo.concat(snapshot),
      project: prev.p,
      floorIndex: Math.min(prev.fi, prev.p.floors.length - 1),
      sel: [],
      draft: null,
      dirty: true,
    });
  },

  redoStep: () => {
    const { undo, redo, project, floorIndex } = get();
    if (!redo.length || !project) return;
    const snapshot = JSON.stringify({ p: project, fi: floorIndex });
    const next = JSON.parse(redo[redo.length - 1]) as { p: Project; fi: number };
    set({
      redo: redo.slice(0, -1),
      undo: undo.concat(snapshot),
      project: next.p,
      floorIndex: Math.min(next.fi, next.p.floors.length - 1),
      sel: [],
      draft: null,
      dirty: true,
    });
  },

  /** The document is mutated in place for speed, so subscribers need a nudge.
   *  Swapping the array identity is enough for zustand to notify. */
  touch: () => {
    const { project } = get();
    if (!project) return;
    project.updatedAt = Date.now();
    set({ project: { ...project }, dirty: true });
  },
}));

export const selectedObjects = (s: EditorState) => resolveSel(s.floor(), s.sel);

/** used until persistence lands, so a reload during development is not painful */
export const bootProject = () => blankProject('Untitled plan', false);
