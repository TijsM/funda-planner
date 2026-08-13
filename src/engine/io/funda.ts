import type { Floor, Project } from '../types';
import { bboxOf, clamp, R2, uid } from '../geometry';
import { contentBBox, newFloor, newProject } from '../model';

/** Pure transforms only. Fetching lives in the shell (browser) or a server
 *  route later — the engine must stay usable under Node with no network. */

export const FUNDA_IMG = 'https://cloud.funda.nl/listing-management/';
export const FML_BASE = 'https://fmlpub.s3.eu-west-1.amazonaws.com/';

export interface FundaPlan { img: string | null; name: string; designId: number; projectId: number }
export interface FundaMeta {
  projectId: number | null;
  plans: FundaPlan[];
  address: string | null;
  title: string | null;
  url?: string;
}

/** Recovers the Floorplanner ids from a listing page. Funda escapes slashes as
 *  / inside its embedded JSON, so unescape before matching. */
export function parseFundaSource(html: string): FundaMeta {
  const h = html
    .replace(/<!--[\s\S]*?-->/g, ' ') /* a commented-out tag is not a tag */
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');

  const out: FundaMeta = { projectId: null, plans: [], address: null, title: null };

  const rx = /"(?:[^"]*?)listing-management\/([0-9a-f-]{36})"\s*,\s*"([^"]{1,80})"\s*,\s*"https:\/\/fmlpub[^"]*?designId=(\d+)&projectId=(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(h))) {
    out.plans.push({ img: m[1], name: m[2], designId: +m[3], projectId: +m[4] });
  }
  if (out.plans.length) out.projectId = out.plans[0].projectId;

  if (!out.projectId) { const p = h.match(/projectId=(\d+)/); if (p) out.projectId = +p[1]; }
  if (!out.projectId) { const p = h.match(/fmlpub[^"' ]*?\/(\d{6,})\.fml/); if (p) out.projectId = +p[1]; }
  if (!out.plans.length) {
    const rx2 = /designId=(\d+)&projectId=(\d+)/g;
    while ((m = rx2.exec(h))) {
      if (!out.plans.some(p => p.designId === +m![1])) {
        out.plans.push({ img: null, name: '', designId: +m[1], projectId: +m[2] });
      }
    }
  }

  /* [^<] so a stray opening tag can never make the title swallow the page */
  const t = h.match(/<title[^>]*>([^<]{1,300})<\/title>/i)
    || h.match(/"(?:og:)?title"\s*[,:]\s*"([^"]{10,160})"/i);
  if (t) {
    out.title = t[1].replace(/\s+/g, ' ').trim();
    out.address = out.title.replace(/\s*\|\s*Funda.*$/i, '').replace(/^[^:]{0,40}:\s*/, '').trim();
  }
  return out;
}

/* minimal shape of the bits of .fml we consume */
interface FmlPt { x: number; y: number }
interface FmlOpening { type?: string; t?: number; width?: number; mirrored?: number[] }
interface FmlWall { a?: FmlPt; b?: FmlPt; thickness?: number; openings?: FmlOpening[] }
interface FmlArea { poly?: FmlPt[]; name?: string; color?: string; name_x?: number; name_y?: number; showAreaLabel?: boolean }
interface FmlItem { x: number; y: number; width?: number; height?: number; rotation?: number }
interface FmlLabel { x: number; y: number; text?: string; fontSize?: number; rotation?: number }
interface FmlDesign {
  id: number; name?: string;
  walls?: FmlWall[]; areas?: FmlArea[]; items?: FmlItem[];
  lines?: { a?: FmlPt; b?: FmlPt; thickness?: number }[];
  dimensions?: { a?: FmlPt; b?: FmlPt }[];
  labels?: FmlLabel[];
}
export interface Fml {
  id: number;
  settings?: { wallThickness?: number };
  floors?: { name?: string; level?: number; designs?: FmlDesign[] }[];
}

/** Floorplanner already works in centimetres with y growing downward, so the
 *  geometry needs no transform — only a shared origin across floors. */
export function fmlToProject(fml: Fml, meta?: Partial<FundaMeta>): Project {
  const plans = meta?.plans ?? [];
  const nameFor = (d: number) => {
    const p = plans.find(x => x.designId === d);
    return p?.name ? p.name.replace(/([a-z])([A-Z])/g, '$1 $2') : null;
  };
  const imgFor = (d: number) => {
    const p = plans.find(x => x.designId === d);
    return p?.img ? `${FUNDA_IMG}${p.img}?options=width=2000` : null;
  };
  const defT = fml.settings?.wallThickness ?? 10;

  const floors: Floor[] = [];
  (fml.floors ?? []).forEach((fl, i) => {
    const dz = fl.designs?.[0];
    if (!dz) return;
    const f = newFloor(nameFor(dz.id) || fl.name || `Level ${i}`, fl.level ?? i);
    f.fmlDesignId = dz.id;

    (dz.walls ?? []).forEach(w => {
      if (!w.a || !w.b) return;
      f.walls.push({
        id: uid(),
        a: { x: R2(w.a.x), y: R2(w.a.y) },
        b: { x: R2(w.b.x), y: R2(w.b.y) },
        t: R2(w.thickness || defT),
        openings: (w.openings ?? [])
          .filter(o => o.type === 'door' || o.type === 'window')
          .map(o => ({
            id: uid(),
            at: clamp(o.t ?? 0.5, 0, 1),
            type: o.type as 'door' | 'window',
            width: R2(o.width || 80),
            flip: (o.mirrored?.[1] ? 1 : 0) as 0 | 1,
            side: 0 as const,
          })),
      });
    });

    (dz.areas ?? []).forEach(a => {
      if (!a.poly || a.poly.length < 3) return;
      f.areas.push({
        id: uid(),
        poly: a.poly.map(p => ({ x: R2(p.x), y: R2(p.y) })),
        name: (a.name || '').trim(),
        color: /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color! : '#DCDCDC',
        nx: a.name_x || 0, ny: a.name_y || 0,
        label: a.showAreaLabel !== false,
      });
    });

    (dz.items ?? []).forEach(it => {
      f.items.push({
        id: uid(), kind: 'fixture',
        x: R2(it.x), y: R2(it.y),
        w: Math.max(4, R2(it.width || 40)), h: Math.max(4, R2(it.height || 40)),
        rot: R2(it.rotation || 0), color: '#8C857A', label: '', fromFunda: 1,
      });
    });

    (dz.lines ?? []).forEach(l => {
      if (l.a && l.b) {
        f.lines.push({ id: uid(), a: { x: R2(l.a.x), y: R2(l.a.y) }, b: { x: R2(l.b.x), y: R2(l.b.y) }, t: l.thickness || 2 });
      }
    });
    (dz.dimensions ?? []).forEach(d => {
      if (d.a && d.b) {
        f.dims.push({ id: uid(), a: { x: R2(d.a.x), y: R2(d.a.y) }, b: { x: R2(d.b.x), y: R2(d.b.y) } });
      }
    });
    (dz.labels ?? []).forEach(l => {
      const tx = (l.text || '').trim();
      if (!tx) return;
      f.notes.push({
        id: uid(), x: R2(l.x), y: R2(l.y), text: tx,
        size: clamp(l.fontSize || 20, 8, 90), rot: l.rotation || 0, color: '#4A443A',
      });
    });

    f.refUrl = imgFor(dz.id);
    floors.push(f);
  });

  if (!floors.length) throw new Error('The Floorplanner project has no usable designs.');

  /* one shared origin, so the floors stay stacked over each other */
  const all: { x: number; y: number }[] = [];
  floors.forEach(f => {
    const b = contentBBox(f);
    if (b) all.push({ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y1 });
  });
  const b = bboxOf(all);
  const ox = b.x0 - 80, oy = b.y0 - 80;
  floors.forEach(f => {
    f.walls.forEach(w => { w.a.x -= ox; w.a.y -= oy; w.b.x -= ox; w.b.y -= oy; });
    f.areas.forEach(a => a.poly.forEach(p => { p.x -= ox; p.y -= oy; }));
    f.items.forEach(i => { i.x -= ox; i.y -= oy; });
    f.notes.forEach(n => { n.x -= ox; n.y -= oy; });
    f.lines.forEach(l => { l.a.x -= ox; l.a.y -= oy; l.b.x -= ox; l.b.y -= oy; });
    f.dims.forEach(d => { d.a.x -= ox; d.a.y -= oy; d.b.x -= ox; d.b.y -= oy; });
  });
  floors.sort((a, b2) => a.level - b2.level);

  const p = newProject(meta?.address || 'Funda plan');
  p.floors = floors;
  p.source = {
    url: meta?.url ?? null,
    address: meta?.address ?? null,
    title: meta?.title ?? null,
    projectId: fml.id,
    fetchedAt: Date.now(),
  };
  return p;
}
