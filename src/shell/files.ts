import type { Floor, Layers, Project } from '@engine/types';
import { contentBBox, floorArea, shellBBox } from '@engine/model';
import { fmtM2, R2 } from '@engine/geometry';
import { planFacts } from '@engine/prompt';
import { paint } from '@engine/render';
import { parseProject, serializeProject, slug } from '@engine/io/serialize';
import { ed } from '@state/store';

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

/** Renders a floor to an offscreen canvas at print-ish resolution. `clean`
 *  strips everything that would confuse an image generator. */
export function renderFloorCanvas(
  f: Floor,
  opts: {
    clean?: boolean; furniture?: boolean; roomLabels?: boolean; maxPx?: number;
    layers?: Layers; measures?: boolean;
  } = {},
): HTMLCanvasElement | null {
  /* A measured print frames the building, not its annotation. Floorplanner's own
     dimension chains sit metres off the walls, and letting them set the bounds
     rendered the plan at half the scale it could be — which is why everything
     came out small and the chains looked scattered. So keep only annotation that
     sits against the building, and drop what is stranded out in the margin: the
     chains this renderer draws now say the same thing, closer in. A measure line
     the user placed themselves is next to what it measures, so it survives. */
  let framed = f;
  if (opts.measures) {
    const bb = contentBBox({ ...f, dims: [], lines: [], notes: [], ref: null });
    if (bb) {
      const m = 130;                                    // cm of slack, about a wall's reach
      const near = (p: { x: number; y: number }) =>
        p.x >= bb.x0 - m && p.x <= bb.x1 + m && p.y >= bb.y0 - m && p.y <= bb.y1 + m;
      framed = {
        ...f,
        dims: f.dims.filter(d => near(d.a) && near(d.b)),
        lines: f.lines.filter(l => near(l.a) && near(l.b)),
        /* the same rule catches the "© Zibber" boilerplate the .fml ships,
           which sits a couple of metres under the plan and stretched the page */
        notes: f.notes.filter(n => near(n)),
      };
    }
  }
  const b = contentBBox({ ...framed, notes: opts.clean ? [] : framed.notes, ref: null });
  if (!b) return null;
  const maxPx = opts.maxPx ?? 3600;
  const fit = (pad: number) => {
    const wCm = b.x1 - b.x0 + pad * 2;
    const hCm = b.y1 - b.y0 + pad * 2;
    return { wCm, hCm, zoom: Math.max(0.15, Math.min(maxPx / Math.max(wCm, hCm), 6)) };
  };

  /* The dimension chains are drawn at a fixed pixel offset, so the margin has
     to be a fixed number of pixels too — which means solving for it once the
     scale is known, rather than picking a distance in centimetres. */
  let pad = opts.clean ? 40 : 70;
  if (opts.measures) pad = Math.max(pad, 88 / fit(pad).zoom);
  const { wCm, hCm, zoom } = fit(pad);

  const cv = document.createElement('canvas');
  cv.width = Math.round(wCm * zoom);
  cv.height = Math.round(hCm * zoom);
  const ctx = cv.getContext('2d');
  if (!ctx) return null;

  const layers: Layers = opts.layers ?? (opts.clean
    ? { rooms: true, areas: false, furn: opts.furniture !== false, dims: false, notes: false }
    : ed().layers);

  paint(ctx, {
    floor: framed,
    view: { zoom, px: (-b.x0 + pad) * zoom, py: (-b.y0 + pad) * zoom },
    width: cv.width, height: cv.height,
    dpr: 1, layers, grid: false, live: false,
    roomLabels: opts.roomLabels !== false,
    vignette: false,
    measures: opts.measures,
    /* The generator reference must carry no lettering at all — the prompt tells
       the model there is none, and a label bleeds through into the render. */
    objectLabels: !opts.clean,
    hatchFixtures: !opts.clean,
    /* the renderer's sizes are tuned for a screen canvas; a print is 3-4× that */
    textScale: Math.max(1, Math.min(cv.width, cv.height) / 900),
  });
  return cv;
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
