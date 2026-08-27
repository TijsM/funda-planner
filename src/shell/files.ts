import type { Floor, Layers, Project } from '@engine/types';
import { floorArea, shellBBox } from '@engine/model';
import { fmtM2, R2 } from '@engine/geometry';
import { framedFloor, planFrame } from '@engine/frame';
import { paintPass, type PassKind } from '@engine/passes';
import { planFacts } from '@engine/prompt';
import { paint } from '@engine/render';
import { parseProject, serializeProject, slug } from '@engine/io/serialize';
import type { ControlKind } from '@data/providers';
import { ed } from '@state/store';
import type { RenderSettings } from './renders';

/** Browser file plumbing: downloads, file reads, and rendering the canvas to a
 *  bitmap. The drawing itself is the engine's paint(); only the plumbing is here. */

/** Hands bytes to the browser as a file. Exported because the render workspace
 *  needs the same three lines for every stored PNG, and a third copy of them is
 *  a third place for the revoke to be forgotten. */
export function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function exportJson(p: Project) {
  download(new Blob([serializeProject(p)], { type: 'application/json' }), `${slug(p.name)}.plattegrond.json`);
}

export function readJsonFile(file: File) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const p = parseProject(String(fr.result));
      ed().setProject(p);
      ed().patch({ modal: null });
      ed().toast(`Imported “${p.name || 'plan'}”`, 'ok');
    } catch {
      ed().toast('That file is not a Plattegrond Studio project.', 'err');
    }
  };
  fr.readAsText(file);
}

export function readImageFile(file: File, onDone?: () => void) {
  const fr = new FileReader();
  fr.onload = () => {
    const s = ed();
    const f = s.floor();
    if (!f) return;
    s.pushUndo();
    f.ref = { src: String(fr.result), x: 0, y: 0, w: 0, h: 0 };
    s.patch({ showRef: true, modal: null });
    s.touch();
    s.toast('Reference image added. Use Calibrate scale, then trace with the wall tool.', 'ok');
    onDone?.();
  };
  fr.readAsDataURL(file);
}

export interface FloorCanvasOpts {
  clean?: boolean; furniture?: boolean; roomLabels?: boolean; maxPx?: number;
  layers?: Layers; measures?: boolean; objectLabels?: boolean;
  /** The room the brief is scoped to, so the picture frames what the brief
   *  describes and the control maps beside it are framed the same way. */
  room?: string;
  /** Draw one of the conditioning passes instead of the plan — a line map, a
   *  depth map, a segmentation map or a change mask, framed identically to the
   *  reference beside it because both come out of the same `planFrame()`.
   *
   *  `'ink'` draws the same picture the app's own reference does — both are
   *  glyph-free, and the harness measures what we actually send. */
  pass?: PassKind;
}

/** Renders a floor to an offscreen canvas at print-ish resolution. `clean`
 *  strips everything that would confuse an image generator.
 *
 *  The fit maths lives in `@engine/frame` now, so Node frames a plan exactly the
 *  way the browser does — a control map framed differently from the reference
 *  beside it is a control map for a different picture. The default `maxPx` stays
 *  3600 here and not `planFrame()`'s 1800: this is the print path, and silently
 *  halving every PNG export is not a refactor. */
export function renderFloorCanvas(
  f: Floor,
  opts: FloorCanvasOpts = {},
): HTMLCanvasElement | null {
  const frameOpts = { maxPx: opts.maxPx ?? 3600, clean: opts.clean, measures: opts.measures };
  const frame = planFrame(f, frameOpts);
  if (!frame) return null;
  /* The same floor the frame was measured from, or the picture carries ink the
     margin was never sized for — stranded dimension chains, the .fml's "©
     Zibber" note a couple of metres under the plan. `framedFloor` is where that
     rule lives; passing `f` here is the one mistake that redraws every export. */
  const framed = framedFloor(f, frameOpts);

  const cv = document.createElement('canvas');
  cv.width = frame.width;
  cv.height = frame.height;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;

  if (opts.pass) {
    paintPass(ctx, {
      floor: framed, frame, pass: opts.pass, furniture: opts.furniture !== false,
    });
    return cv;
  }

  const layers: Layers = opts.layers ?? (opts.clean
    ? { rooms: true, areas: false, furn: opts.furniture !== false, dims: false, notes: false }
    : ed().layers);

  paint(ctx, {
    floor: framed,
    view: frame.view,
    width: cv.width, height: cv.height,
    dpr: 1, layers, grid: false, live: false,
    roomLabels: opts.roomLabels !== false,
    vignette: false,
    measures: opts.measures,
    /* A print keeps its captions. A clean reference carries no glyph of any kind,
       and this is the line that guarantees it.
       Two rounds of renders settled the question. Captions came out at 12 px on
       an 1800 px picture — 1.6 px of grey after the model's downsample — so a
       fireplace came back as a cabinet. The numbered discs that replaced them
       were legible, and the model dutifully painted nine black roundels onto the
       floor of the render. There is no size at which our annotation is read as
       annotation: the picture is the thing being copied. Identity now lives in
       the brief's OBJECTS table, in words, where being wrong is free. */
    objectLabels: opts.objectLabels ?? !opts.clean,
    hatchFixtures: !opts.clean,
    /* the renderer's sizes are tuned for a screen canvas; a print is 3-4× that */
    textScale: Math.max(1, Math.min(cv.width, cv.height) / 900),
  });
  return cv;
}

/** The longest side of a conditioning image. The reference is not the print: at
 *  3600 px it is 3.2 MP of base64 per image, and every control map beside it is
 *  another one on the same request. */
export const REFERENCE_MAX_PX = 1800;

/** The one description of the conditioning frame, so the reference PNG and every
 *  control map beside it are framed by the same call.
 *
 *  Two canvases built from hand-written option objects drifted the moment one of
 *  them gained a toggle — and a control map a few pixels off the reference is a
 *  map of a plan that was never sent. `measures` is in here even though no pass
 *  draws a dimension chain: it changes the margin the frame solves for, so
 *  leaving it out would frame the maps tighter than the picture they condition. */
export function referenceOpts(
  s: Pick<RenderSettings, 'furniture' | 'roomLabels' | 'imgMeasures' | 'room'>,
): FloorCanvasOpts {
  return {
    clean: true,
    furniture: s.furniture,
    roomLabels: s.roomLabels,
    measures: s.imgMeasures,
    objectLabels: false,
    room: s.room,
    maxPx: REFERENCE_MAX_PX,
  };
}

export interface ControlCanvas { kind: ControlKind; canvas: HTMLCanvasElement }

/** The control maps that will be sent with a render, in the order they are
 *  attached — which is the order the prompt numbers them in, so this array and
 *  `opts.controls` on `buildPrompt` have to be the same array. Not deduplicated
 *  and not reordered here: a caller that asks for the same kind twice gets two
 *  images and a brief that describes two, rather than a brief whose Image 3 is
 *  the provider's Image 2.
 *
 *  A kind that produces nothing is dropped rather than sent blank, which only
 *  happens on a floor with nothing on it — and that floor has no reference image
 *  either, so there is no render to condition. */
export function renderControlCanvases(
  f: Floor, kinds: readonly ControlKind[], opts: FloorCanvasOpts = {},
): ControlCanvas[] {
  const out: ControlCanvas[] = [];
  for (const kind of kinds) {
    const canvas = renderFloorCanvas(f, { ...opts, pass: kind });
    if (canvas) out.push({ kind, canvas });
  }
  return out;
}

/** A canvas as raw base64, no `data:` prefix — what `ControlImage.base64` and
 *  BFL's `input_image_N` both want. The route strips a container off every image
 *  it is sent as well, and belt and braces is right here: `ControlImage.base64`
 *  says raw base64, the eval harness builds its images without going through the
 *  route at all, and a container that reaches BFL comes back as a 422 with a
 *  credit already spent. */
export function pngBase64(canvas: HTMLCanvasElement): string {
  const url = canvas.toDataURL('image/png');
  const comma = url.indexOf(',');
  return comma < 0 ? '' : url.slice(comma + 1);
}

export function exportPng() {
  const s = ed();
  const f = s.floor();
  if (!f || !s.project) return;
  const cv = renderFloorCanvas(f, { maxPx: 3600, measures: true });
  if (!cv) { s.toast('Nothing to export on this floor.', 'err'); return; }
  const ctx = cv.getContext('2d')!;

  /* title block */
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `600 ${Math.max(14, cv.width / 62)}px "IBM Plex Sans", sans-serif`;
  ctx.fillStyle = '#2A251E';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(`${s.project.name} — ${f.name}`, 22, 18);
  ctx.font = `400 ${Math.max(10, cv.width / 96)}px "IBM Plex Mono", monospace`;
  ctx.fillStyle = '#7A7261';
  const sb = shellBBox(f);
  const foot = sb && sb.x1 > sb.x0
    ? `${((sb.x1 - sb.x0) / 100).toFixed(2)} × ${((sb.y1 - sb.y0) / 100).toFixed(2)} m`
    : null;
  /* Same rule as the prompt: a room total is only meaningful when the drawn
     rooms actually account for the building. 1.9 m² inside a 75 m² shell is
     not a floor area, it is two cupboards. */
  const A = planFacts(f).mapped ? floorArea(f) : 0;
  /* the importer names the project after the address, so printing both is noise */
  const addr = s.project.source?.address;
  const dupe = addr && s.project.name.includes(addr);
  ctx.fillText(
    [dupe ? null : addr, A ? `${fmtM2(A)} m² of rooms` : null, foot ? `footprint ${foot}` : null]
      .filter(Boolean).join('   ·   '),
    22, 18 + Math.max(20, cv.width / 50),
  );

  try {
    cv.toBlob(blob => {
      if (!blob) return;
      download(blob, `${slug(`${s.project!.name}-${f.name}`)}.png`);
      s.toast(`PNG exported (${cv.width}×${cv.height})`, 'ok');
    }, 'image/png');
  } catch {
    s.toast('PNG export failed — the reference image blocked canvas export. Turn it off and retry.', 'err');
  }
}

export const R2x = R2;
