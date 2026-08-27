import { create } from 'zustand';
import type { PhotoSubject, ViewKind } from '@engine/prompt';
import {
  CONTROL_KINDS, DEFAULT_PROVIDER, maxAffordablePixels, metaOf, type ControlKind,
} from '@data/providers';
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

/* The cap on how long a render is waited for, and the sentence said when it runs
   out. Here and nowhere else: both routes are stateless and cannot see how long a
   job has been running, so the client poller is the only thing that can enforce
   it. `src/server/providers/bfl.ts` used to keep a second copy for documentation,
   which nothing imported and which the two would have drifted apart by hand. */
export const POLL_TIMEOUT_MS = 180_000;
export const POLL_TIMEOUT_MESSAGE = 'The render timed out after 3 minutes.';

/** One at a time. A double-click on Generate costs a credit per click otherwise,
 *  and there is one preview to show the result in. */
export const MAX_INFLIGHT = 1;

/* Provider ceiling for a seed, and the output size to aim for. */
export const SEED_MAX = 4294967295;
export const TARGET_PIXELS = 1_000_000;
const DIM_STEP = 16;
const MIN_DIM = 64;

/** Starting conditioning strength, normalised 0..1 across providers — fal's own
 *  default for `control_scale` and `conditioning_scale` alike. A starting point,
 *  not a finding: the eval harness exists to move it. */
export const DEFAULT_CONTROL_SCALE = 0.75;

/** How many maps ride along on a provider with no control channel of its own.
 *
 *  Two, and the ceiling is words rather than bytes: each attached map costs the
 *  brief one sentence in the opening block BFL documents a 30-80 word window for,
 *  and all four put that block at 160 words — past the point where anything late
 *  in it is read. Dropping the sentence instead is not an option, because an
 *  unannounced depth ramp comes back painted onto the floor as a grey gradient.
 *  It is also what `qwenBody` slices to, and every map is another megabyte of
 *  base64 on a request that already carries the plan. */
const MAX_REFERENCE_MAPS = 2;

/** The maps that will actually be sent, in attach order. Image 1 is always the
 *  plan; these are images 2, 3, … in exactly this sequence.
 *
 *  A provider with a real control channel gets ONE, because that is all either
 *  fal endpoint reads: `zImageBody` takes `usableControls(...)[0]` and
 *  `fluxGeneralBody` sends a single-element `controlnets` array, fal's API
 *  reference saying it "supports one controlnet currently". Sending a second
 *  would have the harness file a line+depth sweep having actually measured line.
 *  Anything the provider does not accept is dropped here rather than quietly
 *  demoted to a reference image — and the modal says which ones went and which
 *  did not, because a dropped choice nobody is told about is a wrong answer. */
export function attachedControls(
  provider: string | null | undefined, kinds: readonly ControlKind[],
): ControlKind[] {
  const meta = metaOf(provider);
  const seen = new Set<ControlKind>();
  const picked = kinds.filter(k => {
    if (!CONTROL_KINDS.includes(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return meta.acceptsControls.length
    ? picked.filter(k => meta.acceptsControls.includes(k)).slice(0, 1)
    : picked.slice(0, MAX_REFERENCE_MAPS);
}

/** The maps the brief should name, which is not the same list.
 *
 *  On a provider with a control channel the map is not a picture the model is
 *  asked to look at — and on z-image it IS `image_url`, replacing the reference
 *  outright, so a brief calling it "image 2" names an image that was never sent.
 *  Only the multi-reference riders get sentences. */
export function promptControls(
  provider: string | null | undefined, kinds: readonly ControlKind[],
): ControlKind[] {
  return metaOf(provider).acceptsControls.length ? [] : attachedControls(provider, kinds);
}

/** How many object photographs this provider has room for, once the plan and any
 *  semantic control maps have taken theirs.
 *
 *  `promptControls` and not `attachedControls`: a map going into a real control
 *  channel does not occupy a reference slot, and on z-image it replaces the
 *  reference outright. The maps that cost a slot are exactly the ones the brief
 *  has to name, which is what that function already computes. */
export function photoSlots(
  provider: string | null | undefined, kinds: readonly ControlKind[],
): number {
  const meta = metaOf(provider);
  const spare = Math.max(0, meta.maxReferences - 1);
  return Math.max(0, spare - promptControls(provider, kinds).length);
}

/** One photograph on its way out, with the image number the brief will call it. */
export interface AttachedPhoto {
  /** the photo id — what `getPhoto` reads the bytes with */
  id: string;
  /** the object it belongs to, so the panel can mark the row it came from */
  objId: string;
  label: string;
  room: string;
  /** what this angle shows, if the person said — straight from the `PhotoRef` */
  note?: string;
  /** its position in the request: image 1 is the plan, so these start at 2 */
  n: number;
}

/** Which photographs actually go, in attach order.
 *
 *  Two passes, and the order between them is the product decision: every ticked
 *  object contributes its FIRST photo before any object contributes a second.
 *  Coverage before detail — six objects each specified once beats one sofa
 *  photographed from six angles and a room full of invented furniture. Only once
 *  every ticked object has a slot do the extra angles fill what is left.
 *
 *  Because the first pass stops at the budget, the second cannot run while any
 *  ticked object is still without a photo. That is not a coincidence to be
 *  preserved by comment — it is the loop.
 *
 *  `off` is the unticked set rather than the ticked one so that a newly
 *  photographed object is included by default: the panel is a list of exclusions,
 *  and a fresh photo nobody has been asked about should be sent. */
export function attachedPhotos(
  provider: string | null | undefined,
  kinds: readonly ControlKind[],
  subjects: readonly PhotoSubject[],
  off: ReadonlySet<string> = new Set(),
): AttachedPhoto[] {
  const budget = photoSlots(provider, kinds);
  if (budget <= 0) return [];
  const on = subjects.filter(s => s.photos.length && !off.has(s.objId));
  const deepest = on.reduce((n, s) => Math.max(n, s.photos.length), 0);

  const out: AttachedPhoto[] = [];
  for (let k = 0; k < deepest && out.length < budget; k++) {
    for (const s of on) {
      if (out.length >= budget) break;
      const p = s.photos[k];
      if (!p) continue;
      out.push({ id: p.id, objId: s.objId, label: s.label, room: s.room, note: p.note, n: out.length + 2 });
    }
  }
  return out;
}

/** The most this provider may be asked to draw: its own ceiling, or the spending
 *  ceiling's, whichever bites first. The $0.10 limit cuts FLUX.2 [max] from 4 MP
 *  to 1.43 MP and flux-general — which bills rounded up to whole megapixels — to
 *  exactly 1 MP, so aiming at a provider's technical maximum is how Generate
 *  earns a 400 from our own route with a message about money. */
export function pixelCeiling(provider: string | null | undefined): number {
  const meta = metaOf(provider);
  const affordable = maxAffordablePixels(meta);
  /* Zero means the vendor publishes no price and `assertAffordable` will refuse
     the call outright. Shrinking the picture cannot make an unpriced render
     affordable, so aim at the technical ceiling and let the refusal say why. */
  return affordable > 0 ? Math.min(meta.maxOutputPixels, affordable) : meta.maxOutputPixels;
}

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
 *  Every provider here bills per output megapixel, so sending the reference's own
 *  1800 px (~3.2 MP) would cost roughly three times a 1 MP render for a picture
 *  nobody asked to be that big. Each side is floored to a multiple of 16 — every
 *  provider rejects anything else, and rounding *up* can push the product past a
 *  ceiling where rounding down never can.
 *
 *  `provider` is what keeps the aim under the spending ceiling as well as the
 *  model's: 1 MP is fine everywhere today, and it is fine on flux-general only
 *  because 1 MP is exactly what a dime buys there. */
export function outputDims(
  w: number, h: number, provider?: string | null, target = TARGET_PIXELS,
): { width: number; height: number } {
  const cw = Math.max(1, Math.round(w));
  const ch = Math.max(1, Math.round(h));
  const cap = pixelCeiling(provider);
  const scale = Math.sqrt(Math.min(target, cap) / (cw * ch));
  const snap = (v: number) => Math.max(MIN_DIM, Math.floor((v * scale) / DIM_STEP) * DIM_STEP);
  let width = snap(cw);
  let height = snap(ch);

  /* The MIN_DIM floor raises a side without touching the other, so a violent
     aspect ratio can leave the pair *above* the ceiling the scaling just put it
     under — 1×4000 comes out 64×63232, which is 4.05 MP and a 400 from our own
     route. Shrink the long side back down rather than let Generate fail with a
     developer's error message. No real floor plan is this thin; the arithmetic
     is still wrong, and wrong arithmetic waits. */
  while (width * height > cap) {
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
  /** which provider draws it — an id from `@data/providers`, never a model name */
  provider: string;
  /** the control maps to send with it, in the order they will be attached */
  controls: ControlKind[];
  /** 0..1, normalised across providers. Does nothing on a provider whose
   *  `acceptsControls` is empty, which is why the modal only shows the dial when
   *  there is a channel for it to turn. */
  controlScale: number;
  /** Objects whose photographs are NOT to be sent, by object id.
   *
   *  Exclusions rather than inclusions, so a photo attached after the panel was
   *  last open is sent rather than silently left behind — the default for a
   *  photograph somebody bothered to take is "use it". Not part of
   *  `RenderSettings`: what a record has to remember is which photos actually
   *  went, and that is `settings.photos`. */
  photoOff: string[];
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
  /* Unchanged behaviour for everyone who already had this panel: the same model,
     the same price, no maps attached. Every other provider is a decision someone
     has to take on purpose, and the picker quotes what it costs. */
  provider: DEFAULT_PROVIDER,
  /* Off by default, and the honest reason is that nothing here has been through a
     real control encoder yet. On FLUX.2 a map is a semantic reference at best —
     the vendor says structure is interpreted semantically and there is no
     strength dial in the body — so attaching one by default would spend the word
     budget and the upload on a hypothesis. The harness is what settles it. */
  controls: [],
  controlScale: DEFAULT_CONTROL_SCALE,
  photoOff: [],
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
  'view' | 'room' | 'style' | 'furniture' | 'dimensions' | 'roomLabels' | 'imgMeasures'
  | 'provider' | 'controls' | 'controlScale'>): RenderSettings {
  return {
    view: s.view, room: s.room, style: s.style, furniture: s.furniture,
    dimensions: s.dimensions, roomLabels: s.roomLabels, imgMeasures: s.imgMeasures,
    provider: s.provider,
    /* The kinds as chosen, not as attached: what the provider could take is a
       function of the provider, and re-running this record on another one has to
       be able to attach the maps that one accepts. `attachedControls` narrows it
       at the point of use. Copied rather than shared — the record outlives the
       store's array, and a settings value that aliases live state is a record
       that changes after it was written. */
    controls: [...s.controls],
    controlScale: s.controlScale,
  };
}

/** The settings a render is actually submitted with: the store's, narrowed to the
 *  maps the provider will be given.
 *
 *  The record is a receipt. Storing the ticked list would have it claim a render
 *  was conditioned on three maps when its provider takes one, and "use these
 *  settings" would then attach maps the original picture never saw — a re-run that
 *  is not a re-run. The ticked-but-unsent kinds are dropped on purpose: they were
 *  never part of this image, and the picker is one click away for the next one. */
export function submittedSettings(s: Parameters<typeof settingsOf>[0]): RenderSettings {
  const v = settingsOf(s);
  return { ...v, controls: attachedControls(v.provider, v.controls ?? []) };
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
  /* None of the three image toggles are in here any more. The brief used to make
     a claim about the reference being annotated, and that sentence had to appear
     and disappear with the flag — but the reference carries no annotation now,
     on any setting, so nothing the picture does changes a word of the text.
     The control maps stay, by the rule that survived: the brief names each
     attached map. As the maps the brief will actually mention, though, not the
     ones ticked — ticking `seg` on a provider that only takes `line` changes
     nothing about the words, and rebuilding for it would throw away a
     hand-edited prompt for no change at all. */
  return JSON.stringify([projectId, floorId, rev, s.view, s.room, s.style, s.furniture,
    s.dimensions, promptControls(s.provider, s.controls ?? []),
    /* The photographs are in here as the ids that will actually be attached, for
       the same reason the maps are: the brief names each one and numbers it, so a
       photo added, unticked or bumped out of the last slot changes the words. It
       is also what makes "use these settings" honest — the recorded list is
       compared against what the plan can attach today, and a difference rebuilds
       the prompt rather than leaving sentences pointing at pictures that are no
       longer there. */
    s.photos ?? []]);
}

/** "Use these settings": the record's own settings and its exact prompt back
 *  into the left column, with the next Generate recorded as its child. The
 *  prompt is restored verbatim rather than rebuilt — a hand-edited prompt is
 *  what produced that render, and rebuilding it would quietly discard the edit. */
export function applySettings(rec: RenderRecord, projectId: string, rev: number): Partial<RenderState> {
  /* `photos` is a receipt and not a setting — see `RenderSettings.photos`. It
     stays out of the store: what goes next time is whatever the plan carries
     now, and `promptKey` below is what notices when that differs from what went
     then, rebuilding the brief so its image numbers stay true. */
  /* `imgLabels` goes the same way, for a different reason: it is a retired flag
     from the window in which the reference carried numbered discs. The record
     keeps it as a fact about how that render was made; the store has no such
     field any more, and spreading a dead key into it is how dead keys come back. */
  const { photos: _sent, imgLabels: _retired, ...settings } = rec.settings;
  return {
    ...settings,
    /* Same precedent, three more absent keys. A record from before there was a
       picker was drawn by FLUX.2 [max] with no maps and no dial, and "use these
       settings" has to reproduce that rather than inherit whichever provider is
       selected now — re-running an old render on z-image would answer a question
       nobody asked and bill it to the wrong hypothesis. */
    provider: rec.settings.provider ?? DEFAULT_PROVIDER,
    controls: [...(rec.settings.controls ?? [])],
    controlScale: rec.settings.controlScale ?? DEFAULT_CONTROL_SCALE,
    prompt: rec.prompt,
    promptKey: promptKeyOf(projectId, rec.floorId, rev, rec.settings),
    seed: rec.seed === null ? '' : String(rec.seed),
    parentId: rec.id,
    selectedId: rec.id,
  };
}
