import { uid } from '@engine/geometry';
import { ed } from '@state/store';
import {
  MODEL_LABEL, POLL_TIMEOUT_MESSAGE, acceptJob, applyPoll, busy, failJob, inFlight, nextSeed,
  outputDims, pollDelay, rs, settingsOf, startJob, timedOut, type PollResponse, type RenderJob,
} from '@state/renders';
import { listRenders, pngFromBase64, putRender, type RenderRecord } from './renders';

/** Drives one render from Generate to a row in the filmstrip.
 *
 *  The timer is module-level and not a React effect on purpose: Escape unmounts
 *  RenderModal (`Editor.tsx:206` renders it on `modal === 'render'`), which
 *  would take an effect-based poll and every useState in it down with the
 *  modal. Closing the modal is not cancelling the render — this is the file
 *  that makes that true. The state it drives lives in `@state/renders`; the
 *  bytes it produces go to `./renders`. */

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
  if (body.status === 'ready' && typeof body.image === 'string' && body.image) {
    return { status: 'ready', image: body.image };
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

async function pollOnce(id: string) {
  timer = null;
  const job = rs().jobs[id];
  /* settled while this tick was pending — the record is already written */
  if (!job || !job.pollUrl) return;

  if (timedOut(job, Date.now())) { await giveUp(job, POLL_TIMEOUT_MESSAGE); return; }

  let res: Response;
  try {
    res = await fetch(
      `/api/render/status?jobId=${encodeURIComponent(job.jobId)}&pollUrl=${encodeURIComponent(job.pollUrl)}`,
      { cache: 'no-store' },
    );
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

  const rec = recordOf(job, { blob: pngFromBase64(parsed.image) });
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
  await failed(job, error);
}

async function failed(job: RenderJob, error: string) {
  ed().toast(error, 'err');
  /* The failed record is kept deliberately: toasts auto-dismiss after 6.2 s and
     carry no button, so the filmstrip is the only place a retry can live — and
     retrying needs the exact prompt and settings that were refused. */
  await land(recordOf(job, { blob: null, error }));
}

/* ── records ─────────────────────────────────────────────────────── */

function recordOf(job: RenderJob, out: { blob: Blob | null; error?: string }): RenderRecord {
  return {
    id: job.id,
    projectId: job.projectId,
    floorId: job.floorId,
    parentId: job.parentId,
    prompt: job.prompt,
    settings: job.settings,
    seed: job.seed,
    model: MODEL_LABEL,
    status: out.blob ? 'ready' : 'failed',
    ...(out.error ? { error: out.error } : {}),
    blob: out.blob,
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
async function land(rec: RenderRecord) {
  if (rec.blob) {
    const thumbnail = await thumbnailOf(rec.blob);
    if (thumbnail) rec = { ...rec, thumbnail };
  }
  const saved = await putRender(rec);
  /* Held for the life of the tab when the write failed. Without this the next
     refreshRenders() — which runs on every open of the panel — would read the
     database, not find the record, and drop it from the filmstrip, taking the
     image with it. The toast promises the user it survives until the tab closes;
     this is what makes that true. */
  if (!saved) rs().patch({ unstored: [rec, ...rs().unstored.filter(r => r.id !== rec.id)] });
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
  const rows = await listRenders(project.id, floor.id);
  /* Anything that never made it into the database goes back on top, newest
     first like the rest — the database read cannot know about them. */
  const held = rs().unstored.filter(r => r.projectId === project.id && r.floorId === floor.id);
  const merged = held.length
    ? [...held, ...rows.filter(r => !held.some(h => h.id === r.id))]
      .sort((a, b) => b.createdAt - a.createdAt)
    : rows;
  /* the read is async and the floor chips are one click away — a list that
     arrives after the user has moved on belongs to nobody */
  if (onFloor(project.id, floor.id)) rs().patch({ renders: merged });
}

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

  const seed = nextSeed(r.seed, r.seedLocked);
  const { width, height } = outputDims(canvas.width, canvas.height);
  const job: RenderJob = {
    id: uid(),
    jobId: '',
    pollUrl: '',
    projectId: project.id,
    floorId: floor.id,
    parentId: r.parentId,
    prompt,
    settings: settingsOf(r),
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

  let res: Response;
  try {
    res = await fetch('/api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, imageBase64: canvas.toDataURL('image/png'), width, height, seed }),
    });
  } catch {
    await giveUp(job, 'Could not reach the server to submit the render. Check the connection and try again.');
    return;
  }

  const body = await payload(res);
  if (!res.ok) { await giveUp(job, errorOf(body, res.status)); return; }

  const jobId = typeof body?.jobId === 'string' ? body.jobId : '';
  const pollUrl = typeof body?.pollUrl === 'string' ? body.pollUrl : '';
  if (!pollUrl) {
    await giveUp(job, 'The server accepted the render but returned no way to poll it, so the result cannot be collected.');
    return;
  }

  const accepted = acceptJob(rs(), job.id, jobId, pollUrl);
  rs().patch(accepted);
  const live = accepted.jobs[job.id];
  if (live) schedule(live);
}

/** True while a render is running — for the tab-close guard and for tests. */
export const rendering = (): boolean => inFlight(rs()).length > 0;
