import { create } from 'zustand';
import type { ViewKind } from '@engine/prompt';
import type { RenderRecord, RenderSettings } from '@shell/renders';

/** The render workspace's own store, deliberately not part of `useEditor`.
 *
 *  `Canvas.tsx:72` subscribes to the editor store with no selector, so every
 *  set() there repaints all 183 walls. An elapsed-time counter ticking once a
 *  second — plus a poll response every second or two — would repaint the plan
 *  continuously for the whole minute a render takes. The cost of the split is
 *  that `window.__ed` cannot see any of this, so `TestBridge.tsx` exposes the
 *  handle by hand.
 *
 *  The lifecycle below is plain functions over a plain object rather than
 *  methods on the store: the job state machine is the part worth testing and
 *  this way Vitest can drive it with no renderer at all. The store holds the
 *  state; `src/shell/jobs.ts` owns the timer and the network. */

/* Restated rather than imported. The same two values are exported from
   `src/server/providers/bfl.ts`, but that file opens with `import 'server-only'`
   and pulling it into a client bundle is a build error — so the poller and the
   adapter have to be kept in step by hand. Same for the model name: it reaches
   the browser nowhere in the API's responses, and a render record that does not
   say which model drew it is a record you cannot reproduce from. */
export const POLL_TIMEOUT_MS = 180_000;
export const POLL_TIMEOUT_MESSAGE = 'The render timed out after 3 minutes.';
export const MODEL_LABEL = 'flux-2-pro';

/** One at a time. A double-click on Generate costs a credit per click otherwise,
 *  and there is one preview to show the result in. */
export const MAX_INFLIGHT = 1;

/* Provider ceiling for a seed, and the output size to aim for. */
export const SEED_MAX = 4294967295;
export const TARGET_PIXELS = 1_000_000;
const DIM_STEP = 16;
const MIN_DIM = 64;
/* The provider's own ceiling, restated. `src/server/providers/bfl.ts` is
   server-only and cannot be imported here, so this is a deliberate second copy —
   if the provider's ever moves, this moves with it or Generate starts failing
   validation at the route with a message no user can act on. */
const MAX_OUTPUT_PIXELS = 4_000_000;

export interface RenderJob {
  /** also the id of the record this job becomes, so the filmstrip and the job
   *  are the same thing to everything downstream */
  id: string;
  /** the provider's own id — useful in logs, nowhere else */
  jobId: string;
  /** BFL's polling URL, kept verbatim: it is cluster-specific and a rebuilt one
   *  answers "Task not found". Local mode only — in cloud mode this URL never
   *  reaches the browser at all, which is the whole point of `renderId`. */
  pollUrl: string;
  /** The `renders` row's uuid, cloud mode only. It is what the status route
   *  polls on: the row holds the provider's URL, RLS scopes the row to its
   *  owner, and so one account cannot poll another's job by guessing a job id.
   *  Optional because in local mode there is no row and `pollUrl` is the whole
   *  address of the job. */
  renderId?: string;
  projectId: string;
  floorId: string;
  parentId: string | null;
  prompt: string;
  settings: RenderSettings;
  seed: number;
  width: number;
  height: number;
  startedAt: number;
  /** the provider's own progress float, shown nowhere — elapsed seconds are the
   *  honest number and this one arrives at 0.0 for the first twenty of them */
  progress: number | null;
}

/** What `/api/render/status` answers, narrowed to what the poller acts on.
 *
 *  A ready response carries exactly one of `image` and `imageUrl`, decided by
 *  the mode and not by the caller: local mode gets base64 straight through our
 *  own server because BFL's delivery host sends no CORS header, cloud mode gets
 *  a signed URL because the PNG is already in the bucket by the time the route
 *  answers. Both optional here rather than two variants — the poller asks which
 *  one arrived, and a route that sent neither is caught in one place. */
export type PollResponse =
  | { status: 'pending'; progress?: number | null }
  | { status: 'ready'; image?: string; imageUrl?: string; bytes?: number; cost?: number | null }
  | { status: 'failed'; error: string; retryable?: boolean };

/** The slice the lifecycle functions operate on — everything else in the store
 *  is settings, and settings have no state machine. */
export interface JobState {
  jobs: Record<string, RenderJob>;
  sessionCount: number;
}

/* ── the lifecycle ────────────────────────────────────────────────── */

export const inFlight = (s: JobState): RenderJob[] => Object.values(s.jobs);
export const busy = (s: JobState): boolean => inFlight(s).length >= MAX_INFLIGHT;

/** Claims the single in-flight slot, before the submit request is even sent:
 *  two clicks land in the same tick and the second one has to find the store
 *  already busy, or it buys a second credit. `jobId`/`pollUrl` are filled in by
 *  `acceptJob` once the provider answers. */
export function startJob(s: JobState, job: RenderJob): JobState {
  /* Replaced wholesale, never mutated. zustand's set() is a shallow top-level
     merge, so `s.jobs[id] = job` writes into the very object the last render
     compared equal to and notifies nobody. */
  return { jobs: { ...s.jobs, [job.id]: job }, sessionCount: s.sessionCount };
}

/** The provider accepted the job and named a polling URL. This is also the
 *  moment a credit is spent, which is why the session counter sits here: a
 *  request that never reached BFL cost nothing, and a job that fails at the
 *  provider has still been paid for. */
export function acceptJob(
  s: JobState, id: string, jobId: string, pollUrl: string, renderId?: string,
): JobState {
  const job = s.jobs[id];
  if (!job) return s;
  return {
    /* `renderId` is spread conditionally rather than assigned: an `undefined`
       key is not the same thing as no key to a deep-equal assertion or to
       JSON, and local mode's job object should stay exactly what it was. */
    jobs: { ...s.jobs, [id]: { ...job, jobId, pollUrl, ...(renderId ? { renderId } : {}) } },
    sessionCount: s.sessionCount + 1,
  };
}

/** Folds one poll response into the state. A settled job leaves the map: the
 *  bytes go to IndexedDB and the filmstrip, not here. */
export function applyPoll(s: JobState, id: string, res: PollResponse): JobState {
  const job = s.jobs[id];
  /* A response that arrives after the job was given up on must not resurrect
     it — the timeout path has already told the user it failed. */
  if (!job) return s;
  if (res.status === 'pending') {
    return { jobs: { ...s.jobs, [id]: { ...job, progress: res.progress ?? null } }, sessionCount: s.sessionCount };
  }
  return { jobs: without(s.jobs, id), sessionCount: s.sessionCount };
}

/** Gives up on a job for a reason the provider never got to state — our own
 *  three-minute cap, or a submit that never produced a pollable job. */
export function failJob(s: JobState, id: string): JobState {
  return s.jobs[id] ? { jobs: without(s.jobs, id), sessionCount: s.sessionCount } : s;
}

function without(jobs: Record<string, RenderJob>, id: string): Record<string, RenderJob> {
  const next = { ...jobs };
  delete next[id];
  return next;
}

/** 1 s while the provider is still in its fast phase, then back off. A 60 s
 *  render costs ~25 polls this way instead of 60, and the cap still lands at
 *  three minutes rather than drifting past it. */
export function pollDelay(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 1000;
  if (elapsedMs < 60_000) return 2500;
  return 4000;
}

export const timedOut = (job: RenderJob, now: number): boolean =>
  now - job.startedAt > POLL_TIMEOUT_MS;

/* ── the numbers the request is built from ───────────────────────── */

/** Output size for one render, from the reference canvas's own aspect ratio.
 *
 *  flux-2-pro bills per output megapixel, so sending the reference's own
 *  1800 px (~3.2 MP) would cost roughly three times a 1 MP render for a picture
 *  nobody asked to be that big. Each side is floored to a multiple of 16 — the
 *  provider rejects anything else, and rounding *up* can push the product past
 *  its 4 MP ceiling where rounding down never can. */
export function outputDims(w: number, h: number, target = TARGET_PIXELS): { width: number; height: number } {
  const cw = Math.max(1, Math.round(w));
  const ch = Math.max(1, Math.round(h));
  const scale = Math.sqrt(target / (cw * ch));
  const snap = (v: number) => Math.max(MIN_DIM, Math.floor((v * scale) / DIM_STEP) * DIM_STEP);
  let width = snap(cw);
  let height = snap(ch);

  /* The MIN_DIM floor raises a side without touching the other, so a violent
     aspect ratio can leave the pair *above* the ceiling the scaling just put it
     under — 1×4000 comes out 64×63232, which is 4.05 MP and a 400 from our own
     route. Shrink the long side back down rather than let Generate fail with a
     developer's error message. No real floor plan is this thin; the arithmetic
     is still wrong, and wrong arithmetic waits. */
  while (width * height > MAX_OUTPUT_PIXELS) {
    if (width >= height && width > MIN_DIM) width -= DIM_STEP;
    else if (height > MIN_DIM) height -= DIM_STEP;
    else break;
  }
  return { width, height };
}

/** The seed field holds text, not a number: a half-typed "12" is not a seed and
 *  rewriting the field under the cursor is how a field fights back. */
export function parseSeed(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n <= SEED_MAX ? n : null;
}

export const randomSeed = (): number => Math.floor(Math.random() * (SEED_MAX + 1));

/** The seed actually sent: the locked one when it parses, a fresh roll
 *  otherwise. Unlocked is the re-roll feature — a new variation every run — and
 *  a rolled seed is written back into the field, because a seed you cannot read
 *  afterwards is a seed you cannot lock. */
export function nextSeed(text: string, locked: boolean): number {
  const parsed = parseSeed(text);
  return locked && parsed !== null ? parsed : randomSeed();
}

/* ── the store ───────────────────────────────────────────────────── */

export interface RenderState extends JobState {
  view: ViewKind;
  /** an area id, or '*' for the whole floor */
  room: string;
  style: string;
  furniture: boolean;
  dimensions: boolean;
  roomLabels: boolean;
  imgMeasures: boolean;
  prompt: string;
  /** the settings the current prompt was built from. The prompt outlives the
   *  modal now, so rebuilding it on every open would eat a hand-edited prompt
   *  every time someone pressed Escape; this says whether it is still current. */
  promptKey: string;
  seed: string;
  seedLocked: boolean;
  /** this floor's records, newest first — read from IndexedDB, never authored here */
  renders: RenderRecord[];
  /** Renders that came back from the provider but could not be stored — a full
   *  or unavailable IndexedDB. They are held here for the life of the tab so the
   *  next re-read of the database cannot quietly drop them: they are paid for,
   *  they are on screen, and the toast tells the user to download them. A list
   *  read from the database would not contain them, so the merge is deliberate
   *  rather than incidental. */
  unstored: RenderRecord[];
  selectedId: string | null;
  /** the render the next Generate descends from. The whole lineage feature is
   *  this pointer plus a back-link in the filmstrip. */
  parentId: string | null;
  /** wall clock, ticked once a second while a job runs, so one subscriber
   *  re-renders the elapsed counter instead of every component reading Date.now() */
  now: number;
  patch: (p: Partial<RenderState>) => void;
}

export const useRenders = create<RenderState>(set => ({
  view: 'top',
  room: '*',
  style: '',
  furniture: true,
  dimensions: true,
  roomLabels: false,
  /* Off by default, having shipped on and been wrong about it.

     With it on, the conditioning image carries three separate kinds of lettering
     — a "X × Y m" caption at every room's centroid, the overall chains captioned
     to two decimals, and a labelled scale bar — while the prompt ends by
     promising "no text or labels anywhere in the image". The picture wins that
     argument. Renders came back with a title block and edge dimensions reading
     15.60 m and 0.65 m: the model copying our own caption format and filling in
     numbers it could not read.

     It stays a toggle, because measurements on the reference are a reasonable
     thing to want and the hint under the preview still explains the cost. What
     changed is which way round the default should be. */
  imgMeasures: false,
  prompt: '',
  promptKey: '',
  seed: '',
  seedLocked: false,
  renders: [],
  unstored: [],
  selectedId: null,
  parentId: null,
  jobs: {},
  sessionCount: 0,
  now: 0,
  patch: p => set(p as Partial<RenderState>),
}));

/** shorthand for handlers that live outside React — mirrors `ed()` */
export const rs = () => useRenders.getState();

/* ── settings, as a value ────────────────────────────────────────── */

export function settingsOf(s: Pick<RenderState,
  'view' | 'room' | 'style' | 'furniture' | 'dimensions' | 'roomLabels' | 'imgMeasures'>): RenderSettings {
  return {
    view: s.view, room: s.room, style: s.style, furniture: s.furniture,
    dimensions: s.dimensions, roomLabels: s.roomLabels, imgMeasures: s.imgMeasures,
  };
}

/** Identifies the prompt currently on screen by what it was built from. The
 *  floor is in it because switching floors must rebuild even when every toggle
 *  is untouched.
 *
 *  `rev` is in it because the geometry is not: the document is mutated in place
 *  and only `rev` moves, so without it a plan edited between two openings of the
 *  panel kept its old prompt while the reference image beside it redrew. The
 *  picture and the prompt disagreed, and the prompt is the half that gets paid
 *  for. Rebuilding does discard a hand-edited prompt — but only once the plan it
 *  described has actually changed underneath it. */
export function promptKeyOf(projectId: string, floorId: string, rev: number, s: RenderSettings): string {
  return JSON.stringify([projectId, floorId, rev, s.view, s.room, s.style, s.furniture, s.dimensions]);
}

/** "Use these settings": the record's own settings and its exact prompt back
 *  into the left column, with the next Generate recorded as its child. The
 *  prompt is restored verbatim rather than rebuilt — a hand-edited prompt is
 *  what produced that render, and rebuilding it would quietly discard the edit. */
export function applySettings(rec: RenderRecord, projectId: string, rev: number): Partial<RenderState> {
  return {
    ...rec.settings,
    prompt: rec.prompt,
    promptKey: promptKeyOf(projectId, rec.floorId, rev, rec.settings),
    seed: rec.seed === null ? '' : String(rec.seed),
    parentId: rec.id,
    selectedId: rec.id,
  };
}
