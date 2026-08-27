import { uid } from '@engine/geometry';
import { ed } from '@state/store';
import {
  POLL_TIMEOUT_MESSAGE, POLL_TIMEOUT_MS, acceptJob, applyPoll, attachedPhotos, busy, failJob,
  inFlight, nextSeed, outputDims, pollDelay, rs, startJob, submittedSettings, timedOut,
  type PollResponse, type RenderJob,
} from '@state/renders';
import { photoSubjects } from '@engine/prompt';
import { ceilingUsd, metaOf, modelLabelOf } from '@data/providers';
import { isCloud } from '@data/config';
import { ensurePlanSynced } from '@data/sync';
import { cloudRowId, noteRowId, resumePending, uploadThumbnail } from '@data/cloudRenders';
import { pngBase64, referenceOpts, renderControlCanvases } from './files';
import { photoBase64 } from './photos';
import { listRenders, pngFromBase64, putRender, renderBlob, type RenderRecord } from './renders';

/** Drives one render from Generate to a row in the filmstrip.
 *
 *  The timer is module-level and not a React effect on purpose: Escape unmounts
 *  RenderModal (`Editor.tsx:206` renders it on `modal === 'render'`), which
 *  would take an effect-based poll and every useState in it down with the
 *  modal. Closing the modal is not cancelling the render — this is the file
 *  that makes that true. The state it drives lives in `@state/renders`; the
 *  bytes it produces go to `./renders`.
 *
 *  Cloud mode changes what a job is addressed by and nothing else about the
 *  shape of this file: a row uuid instead of a provider poll URL, a PNG the
 *  server has already put in a bucket instead of base64 coming back through the
 *  browser. The two paths meet again at `land()`. */

let timer: ReturnType<typeof setTimeout> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

/* ── the elapsed clock ───────────────────────────────────────────── */

function startClock() {
  if (ticker) return;
  rs().patch({ now: Date.now() });
  ticker = setInterval(() => rs().patch({ now: Date.now() }), 1000);
}

/** Only once nothing is running — the cap is one job today, but a clock that
 *  stops while a second one is still counting is a bug waiting for the day it
 *  becomes two. */
function stopClockIfIdle() {
  if (ticker && !inFlight(rs()).length) { clearInterval(ticker); ticker = null; }
}

/* ── talking to our own routes ───────────────────────────────────── */

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

async function payload(res: Response): Promise<Record<string, unknown> | null> {
  try { return obj(await res.json()); } catch { return null; }
}

/** Every route answers a failure as `{ error }` already phrased for the person
 *  waiting, so the only job here is to notice when one didn't. */
function errorOf(body: Record<string, unknown> | null, status: number): string {
  /* Ahead of the body on purpose: a 401 never comes from a route, it comes from
     the proxy in front of them, whose `{ error: 'unauthenticated' }` is a token
     for the client to switch on — not a sentence to show anyone. Reading the
     body first put the bare word "unauthenticated" in a toast. */
  if (status === 401) return 'Your session has expired. Reload the page and sign in again.';
  const said = body && typeof body.error === 'string' ? body.error.trim() : '';
  if (said) return said;
  return `The server answered HTTP ${status} without saying why.`;
}

function asPoll(body: Record<string, unknown> | null): PollResponse | null {
  if (!body) return null;
  if (body.status === 'pending') {
    return { status: 'pending', progress: typeof body.progress === 'number' ? body.progress : null };
  }
  if (body.status === 'ready') {
    /* One of the two, never both: base64 through our own server in local mode
       because BFL's delivery host sends no CORS header, a signed Storage URL in
       cloud mode because the bytes are already in the bucket. Neither means the
       route said "done" without saying where — which falls through to the
       "not a job status" message below rather than landing an empty render. */
    const image = typeof body.image === 'string' ? body.image : '';
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl : '';
    if (image) return { status: 'ready', image };
    if (imageUrl) return { status: 'ready', imageUrl };
    return null;
  }
  if (body.status === 'failed') return { status: 'failed', error: errorOf(body, 200) };
  return null;
}

/* ── the poll loop ───────────────────────────────────────────────── */

function schedule(job: RenderJob) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void pollOnce(job.id); }, pollDelay(Date.now() - job.startedAt));
}

function stopPolling() {
  if (timer) { clearTimeout(timer); timer = null; }
}

/** Where the job is asked about. In cloud mode that is a row uuid and nothing
 *  else: the provider's URL is read from the row server-side, so no browser can
 *  point the poll at a job it was merely handed the id of.
 *
 *  Local mode has no row to read, so the provider travels in the query — and it
 *  has to. The route checks the pollUrl against that provider's own hosts and
 *  nothing else, so an unnamed job is tried as FLUX.2 and every fal render dies
 *  at the host check having already been paid for. Resolved through `metaOf`
 *  rather than sent raw: settings from before the picker carry no provider at
 *  all, and the route refuses the literal string "undefined" by name. */
export const statusUrl = (job: RenderJob): string =>
  job.renderId
    ? `/api/render/status?renderId=${encodeURIComponent(job.renderId)}`
    : `/api/render/status?jobId=${encodeURIComponent(job.jobId)}`
      + `&provider=${encodeURIComponent(metaOf(job.settings.provider).id)}`
      + `&pollUrl=${encodeURIComponent(job.pollUrl)}`;

async function pollOnce(id: string) {
  timer = null;
  const job = rs().jobs[id];
  /* settled while this tick was pending — the record is already written */
  if (!job || !(job.renderId || job.pollUrl)) return;

  if (timedOut(job, Date.now())) { await giveUp(job, POLL_TIMEOUT_MESSAGE); return; }

  let res: Response;
  try {
    res = await fetch(statusUrl(job), { cache: 'no-store' });
  } catch {
    /* A dropped connection is not a failed render — the job is still running at
       BFL and costs the same whether we are watching. Keep polling until the cap. */
    schedule(job);
    return;
  }

  const body = await payload(res);
  if (!res.ok) {
    /* The route answers a job that failed *at the provider* with HTTP 200 and
       `status: 'failed'`. A non-200 is our own side or the provider refusing the
       poll itself, so a retryable one is worth another go inside the cap. */
    if (body?.retryable === true) { schedule(job); return; }
    await giveUp(job, errorOf(body, res.status));
    return;
  }

  const parsed = asPoll(body);
  if (!parsed) { await giveUp(job, 'The server answered the poll with something that is not a job status.'); return; }

  rs().patch(applyPoll(rs(), id, parsed));
  if (parsed.status === 'pending') { schedule(job); return; }

  stopClockIfIdle();
  if (parsed.status === 'failed') { await failed(job, parsed.error); return; }

  const rec = parsed.image
    ? recordOf(job, { blob: pngFromBase64(parsed.image) })
    /* Cloud: the PNG is in the bucket already and this is a signed URL to it.
       The record carries no bytes at all — see the note on `RenderRecord`. */
    : recordOf(job, { blob: null, imageUrl: parsed.imageUrl });
  /* Said before the record is written rather than after: the modal is very
     likely closed by now — that is the whole point of the module-level poller —
     and the toast is the only thing that says the wait is over. */
  ed().toast(`Render ready in ${Math.round(rec.durationMs / 1000)}s.`, 'ok');
  await land(rec);
}

/** Gives up on a job for a reason the provider never got to state — our own
 *  three-minute cap, or a poll our server refused. */
async function giveUp(job: RenderJob, error: string) {
  stopPolling();
  rs().patch(failJob(rs(), job.id));
  stopClockIfIdle();
  await failed(job, error, true);
}

/** `abandoned` marks a failure that is ours rather than the provider's — a poll
 *  past the cap, a submit that never came back. It matters in cloud mode only:
 *  the row is still `pending` server-side after one of those, and
 *  `listCloudRenders` deliberately does not return pending rows, so without the
 *  hold below the settings that were refused would vanish from the filmstrip on
 *  the very next read. A provider failure needs none of this — the status route
 *  wrote `failed` to the row and the row comes back. */
async function failed(job: RenderJob, error: string, abandoned = false) {
  ed().toast(error, 'err');
  /* The failed record is kept deliberately: toasts auto-dismiss after 6.2 s and
     carry no button, so the filmstrip is the only place a retry can live — and
     retrying needs the exact prompt and settings that were refused. */
  await land(recordOf(job, { blob: null, error }), abandoned && isCloud());
}

/* ── records ─────────────────────────────────────────────────────── */

function recordOf(
  job: RenderJob, out: { blob: Blob | null; imageUrl?: string; error?: string },
): RenderRecord {
  return {
    id: job.id,
    projectId: job.projectId,
    floorId: job.floorId,
    parentId: job.parentId,
    prompt: job.prompt,
    settings: job.settings,
    seed: job.seed,
    /* The provider that actually drew it, read off the settings the job was
       submitted with rather than a constant — the filmstrip shows this string
       and it is the only place a person can see which model to blame. */
    model: modelLabelOf(job.settings.provider),
    /* Bytes *or* a URL to them — a cloud record is `ready` with `blob` null, and
       reading emptiness as failure would mark every cloud render failed. */
    status: out.blob || out.imageUrl ? 'ready' : 'failed',
    ...(out.error ? { error: out.error } : {}),
    blob: out.blob,
    ...(out.imageUrl ? { imageUrl: out.imageUrl } : {}),
    createdAt: job.startedAt,
    durationMs: Date.now() - job.startedAt,
  };
}

/** A 1 MP PNG per filmstrip cell is a megabyte of decode for a 96 px thumbnail,
 *  and twenty of them is the modal stuttering on open. Best effort — a browser
 *  without createImageBitmap just gets the full image in the cell. */
async function thumbnailOf(blob: Blob): Promise<Blob | undefined> {
  try {
    if (typeof createImageBitmap !== 'function') return undefined;
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 320 / Math.max(1, bmp.width));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bmp.width * scale));
    cv.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = cv.getContext('2d');
    if (!ctx) { bmp.close(); return undefined; }
    ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close();
    return await new Promise<Blob | undefined>(r => cv.toBlob(b => r(b ?? undefined), 'image/png'));
  } catch { return undefined; }
}

/** Writes the record and puts it on screen. `putRender` toasts its own failure
 *  with the specific cause; what matters here is that the image stays visible
 *  and downloadable even when it could not be stored. */
async function land(rec: RenderRecord, hold = false) {
  if (rec.blob) {
    const thumbnail = await thumbnailOf(rec.blob);
    if (thumbnail) rec = { ...rec, thumbnail };
  } else if (rec.imageUrl) {
    /* Cloud. The thumbnail is still made here — the canvas is in the browser and
       the server has no business decoding PNGs — but it goes up to Storage
       instead of into the record, and `refreshRenders()` below re-reads the row
       and signs a URL for it. Best effort throughout: a render whose thumbnail
       never lands simply draws its full image in the cell. */
    const full = await renderBlob(rec);
    const thumbnail = full ? await thumbnailOf(full) : undefined;
    const rowId = cloudRowId(rec.id);
    if (thumbnail && rowId) await uploadThumbnail(rowId, rec.id, thumbnail);
  }
  const saved = await putRender(rec);
  /* Held for the life of the tab when the write failed. Without this the next
     refreshRenders() — which runs on every open of the panel — would read the
     database, not find the record, and drop it from the filmstrip, taking the
     image with it. The toast promises the user it survives until the tab closes;
     this is what makes that true.
     `hold` is the cloud's version of the same problem: nothing was written from
     here, but nothing the next read returns will contain this record either —
     unless it does, in which case refreshRenders() below drops the hold again.
     The row knows what became of the render; this copy only knows that the
     answer never arrived. */
  if (!saved || hold) rs().patch({ unstored: [rec, ...rs().unstored.filter(r => r.id !== rec.id)] });
  await refreshRenders();
  if (onFloor(rec.projectId, rec.floorId)) rs().patch({ selectedId: rec.id });
}

const onFloor = (projectId: string, floorId: string): boolean => {
  const s = ed();
  return s.project?.id === projectId && s.floor()?.id === floorId;
};

/** Re-reads this floor's renders into the store. Cheap, and the only way the
 *  filmstrip learns about a job that finished while the modal was closed. */
export async function refreshRenders(): Promise<void> {
  const s = ed();
  const project = s.project;
  const floor = s.floor();
  if (!project || !floor) { rs().patch({ renders: [] }); return; }
  /* Deliberately not awaited, and cheap after the first call: this is the
     earliest moment the app knows which plan is open, so it is where a render
     the last tab left running gets picked back up. The filmstrip must not wait
     on it — it is about a render that is not in the list yet by definition. */
  void resumeRenders();
  const rows = await listRenders(project.id, floor.id);
  const ids = new Set(rows.map(r => r.id));
  const held = rs().unstored.filter(r => r.projectId === project.id && r.floorId === floor.id);
  /* Anything the read has never heard of goes back on top, newest first like the
     rest — the database cannot know about those. Anything it *does* return is
     the other case entirely, and only cloud mode has it: the status route stores
     the PNG and marks the row ready before it answers, so a response lost on the
     way back parked a `failed` copy over a render that exists and is paid for.
     Merging held records unconditionally kept that copy on screen for the life
     of the tab. Once the row has an answer at all, the row is the answer. */
  const orphans = held.filter(r => !ids.has(r.id));
  if (orphans.length !== held.length) {
    rs().patch({ unstored: rs().unstored.filter(r => !ids.has(r.id)) });
  }
  const merged = orphans.length
    ? [...orphans, ...rows].sort((a, b) => b.createdAt - a.createdAt)
    : rows;
  /* the read is async and the floor chips are one click away — a list that
     arrives after the user has moved on belongs to nobody */
  if (onFloor(project.id, floor.id)) rs().patch({ renders: merged });
}

/* ── picking a render back up after a reload ─────────────────────── */

/** Plans with nothing left to pick up, so the panel opening forty times is one
 *  query. A plan is only entered once every pending render it has is either
 *  being polled already or too old to be worth polling — entering it on the
 *  first pass regardless is what silently abandoned the second of two. */
const resumed = new Set<string>();

/** Re-attaches the poller to renders that were still running when this tab, or
 *  another one, was last closed. Cloud mode only: in local mode a job's entire
 *  identity was a poll URL in a variable, and a reload took it with it — which
 *  is exactly what moving that URL into a row bought back.
 *
 *  Only rows younger than the poll cap are picked up. A job the provider forgot
 *  hours ago would be resumed only to time out three minutes later and toast
 *  about it, again on every open of the panel; older rows are left `pending`
 *  where the filmstrip does not show them and they cost nothing. */
export async function resumeRenders(): Promise<void> {
  const project = ed().project;
  if (!isCloud() || !project || resumed.has(project.id)) return;

  const now = Date.now();
  let waiting = 0;
  for (const rec of await resumePending(project.id)) {
    const renderId = cloudRowId(rec.id);
    if (!renderId || now - rec.createdAt > POLL_TIMEOUT_MS) continue;
    /* already ours — the poller is on it and it is not waiting for anything */
    if (rs().jobs[rec.id]) continue;
    /* one at a time here too — MAX_INFLIGHT is about credits, not about tabs.
       Counted rather than dropped: `startJob` applies synchronously, so the
       first resume makes every later one busy, and a plan marked resumed on
       that same pass never looked at the rest again. */
    if (busy(rs())) { waiting++; continue; }

    const job: RenderJob = {
      id: rec.id,
      jobId: '',
      pollUrl: '',
      renderId,
      projectId: rec.projectId,
      floorId: rec.floorId,
      parentId: rec.parentId,
      prompt: rec.prompt,
      settings: rec.settings,
      /* Seed and size are only ever read to build the submit body, and that
         happened in a tab that no longer exists — the row holds the real ones
         and the record written at the end comes from the row, not from here. */
      seed: rec.seed ?? 0,
      width: 0,
      height: 0,
      startedAt: rec.createdAt,
      progress: null,
    };
    rs().patch(startJob(rs(), job));
    startClock();
    schedule(job);
  }
  /* Only once the loop got through them all. Every settled render runs `land()`,
     which runs `refreshRenders()`, which runs this again — so the ones over the
     cap come back one at a time as the slot frees, rather than being lost. */
  if (!waiting) resumed.add(project.id);
}

/** Forgets which plans have been resumed. For sign-out: the next account's
 *  plans have their own pending renders and none of this browser's memory of
 *  whose they were. */
export function resetResume(): void { resumed.clear(); }

/* ── the entry point ─────────────────────────────────────────────── */

/** Submits one render and starts polling it. Everything but the reference
 *  canvas comes from the two stores, so the modal cannot hand this a prompt
 *  that differs from the one on screen. */
export async function startRender(canvas: HTMLCanvasElement | null): Promise<void> {
  const s = ed();
  const project = s.project;
  const floor = s.floor();
  if (!project || !floor) return;

  const r = rs();
  /* The button is disabled for all three of these; a keyboard or a test can
     still reach the handler, and each one costs a credit to find out. */
  if (busy(r)) return;
  const prompt = r.prompt.trim();
  if (!prompt) { s.toast('The prompt is empty — there is nothing to render.', 'err'); return; }
  if (!canvas) {
    s.toast('This floor has nothing to draw, so there is no reference image to render from.', 'err');
    return;
  }

  /* The maps this provider will actually be given, resolved before the record is
     built: `submittedSettings` is what makes the row a receipt for the render that
     went rather than for the boxes that were ticked. */
  const base = submittedSettings(r);
  const kinds = base.controls ?? [];

  /* Which photographs go, worked out here rather than read off the panel. The
     panel computes the same list from the same two pure functions — to draw its
     checkboxes and to number the sentences in the brief — but the panel is a
     view, and what gets paid for must not depend on one having been open.
     Synchronous, so it can be part of the record before the slot is claimed;
     reading the bytes is the slow half and happens below. */
  const picked = attachedPhotos(base.provider, kinds, photoSubjects(floor, base.room), new Set(r.photoOff));
  /* The ids that go, in the order they go: the row's answer to "which of my
     sofas is in this picture". */
  const settings: typeof base = { ...base, photos: picked.map(p => p.id) };
  const seed = nextSeed(r.seed, r.seedLocked);
  const { width, height } = outputDims(canvas.width, canvas.height, settings.provider);
  const job: RenderJob = {
    id: uid(),
    jobId: '',
    pollUrl: '',
    projectId: project.id,
    floorId: floor.id,
    parentId: r.parentId,
    prompt,
    settings,
    seed,
    width,
    height,
    startedAt: Date.now(),
    progress: null,
  };

  /* Claim the slot and show the seed that was rolled before anything is
     awaited: the second half of a double-click arrives in this same tick. */
  rs().patch({ ...startJob(rs(), job), seed: String(seed) });
  startClock();

  /* The photographs' bytes, read after the slot is claimed for the same reason
     the maps are drawn after it. `giveUp` rather than a toast: the slot is ours
     now, and an early return would leave it held for the life of the tab. */
  const refs: { id: string; base64: string; label: string }[] = [];
  for (const p of picked) {
    const base64 = await photoBase64(project.id, p.id);
    /* No partial send. The brief names image 3 and counts up from there, so
       dropping one photograph renumbers every photograph after it — the sentence
       about the sofa would be pointing at the wardrobe. */
    if (!base64) {
      await giveUp(
        job,
        `The photo of the ${p.label} could not be read on this device, so nothing was sent — the`
        + ' brief names that picture. Untick it in the render panel, or reload to fetch it again.',
      );
      return;
    }
    refs.push({ id: p.id, base64, label: p.room ? `${p.label} (${p.room})` : p.label });
  }

  /* The maps, drawn after the slot is claimed and not before: two passes plus
     their PNG encoding is a few hundred milliseconds of synchronous work, and the
     second half of a double-click arrives inside it. */
  const drawn = kinds.length
    ? renderControlCanvases(floor, kinds, referenceOpts(settings))
    : [];
  /* Same frame or nothing. Both this and the reference canvas are framed by
     `referenceOpts`, so they agree by construction — but a control map even a few
     pixels off the picture it conditions is geometry for a plan that was never
     sent, and the provider would resize it rather than complain. Cheap to check,
     and the only honest answer if it ever fails is not to spend the money. */
  const framed = drawn.filter(m => m.canvas.width === canvas.width && m.canvas.height === canvas.height);
  if (framed.length !== kinds.length) {
    await giveUp(
      job,
      'The control maps came out framed differently from the reference image, so the render would be'
      + ' conditioned on geometry it was not sent. Turn the maps off and try again.',
    );
    return;
  }
  const controls = framed.map(m => ({ kind: m.kind, base64: pngBase64(m.canvas) }));

  const cloud = isCloud();
  const req: Record<string, unknown> = {
    prompt, imageBase64: canvas.toDataURL('image/png'), width, height, seed,
    /* Always sent, even for the default: the route resolving a missing id to its
       own default is how a deployment upgrade silently re-points every render. */
    provider: settings.provider,
    /* The dial travels with the maps or not at all — on a provider with no
       control channel it turns nothing, and a field that cannot matter reads in
       the log as though it did. */
    ...(controls.length ? { controls, controlScale: settings.controlScale } : {}),
    ...(refs.length ? { refs } : {}),
  };

  if (cloud) {
    /* Before the submit, not after. `renders.plan_id` is a real foreign key, so
       a render cannot be recorded against a plan the account has never seen —
       and discovering that after BFL has been billed is a credit spent on a row
       that will not insert. The slot above is claimed first even so: the
       double-click guard has to hold across this await too. */
    if (!(await ensurePlanSynced(project))) {
      await giveUp(
        job,
        'This plan has not reached your account yet, so there is nothing to record the render against. '
        + 'Check your connection and try again in a moment.',
      );
      return;
    }
    Object.assign(req, {
      planClientId: project.id,
      floorId: floor.id,
      renderClientId: job.id,
      parentId: job.parentId,
      settings: job.settings,
      /* No `model`: the route writes `renders.model` itself, and it writes the
         provider ID rather than the label, because that column is the only thing
         that can poll the job again. Sending the label here was a second answer
         to the same question, ignored server-side and wrong if it ever won.
         `src/data/cloudRenders.ts` turns the id back into a label on the way
         out — the local path's `modelLabelOf` and that one are the same call. */
    });
  }

  let res: Response;
  try {
    res = await fetch('/api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch {
    await giveUp(job, 'Could not reach the server to submit the render. Check the connection and try again.');
    return;
  }

  const body = await payload(res);
  if (!res.ok) { await giveUp(job, errorOf(body, res.status)); return; }

  const jobId = typeof body?.jobId === 'string' ? body.jobId : '';
  const pollUrl = typeof body?.pollUrl === 'string' ? body.pollUrl : '';
  const renderId = typeof body?.renderId === 'string' ? body.renderId : '';
  /* Cloud mode answers with a row uuid and deliberately no poll URL; local mode
     answers with the poll URL and there is no row. Either way, no address back
     to the job means the image cannot be collected and the credit is already
     spent — say so rather than polling nothing until the cap. */
  if (cloud ? !renderId : !pollUrl) {
    await giveUp(job, 'The server accepted the render but returned no way to poll it, so the result cannot be collected.');
    return;
  }
  if (renderId) noteRowId(job.id, renderId);

  /* The ceiling is asserted before the money leaves, so by the time the vendor's
     own quote disagrees with it the render is already paid for and the only thing
     left is to say so. It goes to the person who pressed Generate rather than only
     to a server log, because they are the one who will be charged again on the next
     press: our per-megapixel rate is wrong and every render until it is corrected
     costs more than the panel claims. */
  if (body?.overCeiling === true) {
    const quoted = typeof body.quotedUsd === 'number' ? `$${body.quotedUsd.toFixed(3)}` : 'more than the ceiling';
    const cap = ceilingUsd(metaOf(job.settings.provider));
    ed().toast(`The provider quoted ${quoted} for that render — over the $${cap.toFixed(2)} ceiling. The rate in the picker is wrong; stop rendering on this provider until it is fixed.`, 'err');
  }

  const accepted = acceptJob(rs(), job.id, jobId, pollUrl, renderId || undefined);
  rs().patch(accepted);
  const live = accepted.jobs[job.id];
  if (live) schedule(live);
}

/** True while a render is running — for the tab-close guard and for tests. */
export const rendering = (): boolean => inFlight(rs()).length > 0;
