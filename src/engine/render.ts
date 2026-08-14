import type {
  Draft, Floor, Handle, Hit, Layers, Marquee, Pt, SelObj, View,
} from './types';
import { bboxOf, clamp, dist, fmtM2, polyArea, polyCentroid, unitNormal } from './geometry';
import { CAT_BY_KIND, rr, toneFor } from './catalog';
import { labelOf, shellBBox } from './model';
import {
  ACC, CYA, GHOST, PAPER, WALLC, gridStep, hexA, openingRect, pathPoly, wallQuad,
} from './shapes';

type Ctx = CanvasRenderingContext2D;

/** Everything the painter needs, passed in explicitly — it reads no globals,
 *  which is what lets the same code run in a browser and under node-canvas. */
export interface PaintInput {
  floor: Floor;
  view: View;
  width: number;
  height: number;
  dpr?: number;
  layers: Layers;
  grid?: boolean;
  /** draw the interactive overlays: selection, handles, draft, marquee */
  live?: boolean;
  refImage?: CanvasImageSource | null;
  refOpacity?: number;
  ghost?: Floor | null;
  selection?: SelObj[];
  handles?: Handle[];
  hover?: Hit | null;
  draft?: Draft | null;
  place?: { kind: string; x: number; y: number } | null;
  marquee?: Marquee | null;
  snapHint?: Pt | null;
  /** room names — off for the clean image-generator reference */
  roomLabels?: boolean;
  vignette?: boolean;
  /** Automatic overall dimension chains plus a size under each room name. For
   *  the print; never for the generator reference, which must carry no text. */
  measures?: boolean;
  /** Object labels. On by default; off for the generator reference, which the
   *  prompt promises carries no lettering — this used to leak "Sofa 3-seat"
   *  and the like straight into the conditioning image. */
  objectLabels?: boolean;
}

export function paint(g: Ctx, input: PaintInput): void {
  const {
    floor: f, view, width: W, height: H, layers: L,
    dpr = 1, grid = true, live = false, refImage = null, refOpacity = 0.45,
    ghost = null, selection = [], handles = [], hover = null, draft = null,
    place = null, marquee = null, snapHint = null, roomLabels = true, vignette = live,
    measures = false, objectLabels = true,
  } = input;

  const Z = view.zoom, PX = view.px, PY = view.py;
  const sx = (wx: number) => wx * Z + PX;
  const sy = (wy: number) => wy * Z + PY;
  const u = 1 / Z;
  const LW = (p: number) => p * u;

  const world = () => { g.setTransform(dpr, 0, 0, dpr, 0, 0); g.translate(PX, PY); g.scale(Z, Z); };
  const screen = () => { g.setTransform(dpr, 0, 0, dpr, 0, 0); };

  /* text helpers restore the transform they found, so they are safe mid-path */
  const label = (
    text: string, wx: number, wy: number, size: number, color: string,
    align: CanvasTextAlign = 'center', baseline: CanvasTextBaseline = 'middle',
    halo = true, rotDeg = 0,
  ) => {
    g.save(); screen();
    g.translate(sx(wx), sy(wy));
    if (rotDeg) g.rotate((rotDeg * Math.PI) / 180);
    g.font = `500 ${size}px "IBM Plex Sans", sans-serif`;
    g.textAlign = align; g.textBaseline = baseline;
    if (halo) {
      g.lineWidth = 3; g.strokeStyle = 'rgba(243,240,231,.85)'; g.lineJoin = 'round';
      g.strokeText(text, 0, 0);
    }
    g.fillStyle = color; g.fillText(text, 0, 0);
    g.restore();
  };
  const mono = (text: string, wx: number, wy: number, size: number, color: string) => {
    g.save(); screen();
    g.font = `500 ${size}px "IBM Plex Mono", monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 3.2; g.strokeStyle = 'rgba(243,240,231,.9)'; g.lineJoin = 'round';
    g.strokeText(text, sx(wx), sy(wy));
    g.fillStyle = color; g.fillText(text, sx(wx), sy(wy));
    g.restore();
  };

  /** The bar is the one thing that makes a printed plan measurable off-paper.
   *  Defined here so both the live canvas and the print can call it. */
  const scaleBar = () => {
    screen();
    const barCm = gridStep(Z, 70), barPx = barCm * Z;
    g.save();
    g.strokeStyle = 'rgba(60,54,44,.65)'; g.fillStyle = 'rgba(60,54,44,.65)'; g.lineWidth = 1.4;
    const bx = W - 22 - barPx, by = H - 24;
    g.beginPath();
    g.moveTo(bx, by); g.lineTo(bx + barPx, by);
    g.moveTo(bx, by - 4); g.lineTo(bx, by + 4);
    g.moveTo(bx + barPx, by - 4); g.lineTo(bx + barPx, by + 4);
    g.stroke();
    g.font = '500 10px "IBM Plex Mono", monospace';
    g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.fillText(barCm >= 100 ? `${barCm / 100} m` : `${barCm} cm`, bx + barPx / 2, by - 6);
    g.restore();
  };

  /* ---- paper ---- */
  screen();
  g.fillStyle = PAPER; g.fillRect(0, 0, W, H);
  if (vignette) {
    const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(52,44,30,.11)');
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
  }

  /* ---- grid ---- */
  if (grid) {
    const minor = gridStep(Z, 10);
    const major = minor * (minor * Z > 55 ? 5 : 10);
    const w0 = -PX / Z, w1 = (W - PX) / Z, h0 = -PY / Z, h1 = (H - PY) / Z;
    screen(); g.lineWidth = 1;
    for (const [step, col] of [[minor, 'rgba(120,110,88,.13)'], [major, 'rgba(120,110,88,.30)']] as const) {
      g.strokeStyle = col; g.beginPath();
      for (let x = Math.ceil(w0 / step) * step; x < w1; x += step) {
        const p = Math.round(sx(x)) + 0.5; g.moveTo(p, 0); g.lineTo(p, H);
      }
      for (let y = Math.ceil(h0 / step) * step; y < h1; y += step) {
        const p = Math.round(sy(y)) + 0.5; g.moveTo(0, p); g.lineTo(W, p);
      }
      g.stroke();
    }
  }

  /* ---- reference bitmap ---- */
  if (refImage && f.ref) {
    world(); g.save();
    g.globalAlpha = refOpacity;
    g.imageSmoothingQuality = 'high';
    g.drawImage(refImage, f.ref.x, f.ref.y, f.ref.w, f.ref.h);
    g.restore();
    if (live) {
      world(); g.save();
      g.strokeStyle = hexA(CYA, 0.5); g.lineWidth = LW(1);
      g.setLineDash([LW(7), LW(6)]);
      g.strokeRect(f.ref.x, f.ref.y, f.ref.w, f.ref.h);
      g.restore();
    }
  }

  /* ---- ghost of the floor below ---- */
  if (ghost) {
    world(); g.save();
    g.globalAlpha = 0.5; g.fillStyle = GHOST;
    ghost.walls.forEach(w => { pathPoly(g, wallQuad(w)); g.fill(); });
    g.restore();
  }

  /* ---- rooms ---- */
  world();
  if (L.rooms) {
    f.areas.forEach(a => {
      pathPoly(g, a.poly);
      g.fillStyle = hexA(a.color, 0.62); g.fill();
      g.strokeStyle = hexA('#6B6455', 0.5); g.lineWidth = LW(1); g.stroke();
    });
  }

  /* ---- construction lines & annotation arrows ---- */
  g.lineCap = 'round';
  f.lines.forEach(l => {
    world();
    if (l.arrow) {
      const col = l.color || ACC;
      const n = unitNormal(l.a, l.b);
      g.strokeStyle = col; g.lineWidth = LW(2.6); g.lineJoin = 'round';
      const hs = 15 * u;
      const back = { x: l.b.x - n.ux * hs, y: l.b.y - n.uy * hs };
      g.beginPath(); g.moveTo(l.a.x, l.a.y); g.lineTo(back.x, back.y); g.stroke();
      g.fillStyle = col;
      pathPoly(g, [
        { x: l.b.x, y: l.b.y },
        { x: back.x + n.x * hs * 0.52, y: back.y + n.y * hs * 0.52 },
        { x: back.x - n.x * hs * 0.52, y: back.y - n.y * hs * 0.52 },
      ]);
      g.fill();
    } else {
      g.strokeStyle = hexA('#5C5648', 0.8); g.lineWidth = LW(1.4);
      g.beginPath(); g.moveTo(l.a.x, l.a.y); g.lineTo(l.b.x, l.b.y); g.stroke();
    }
  });

  /* ---- walls, then openings punched through them ---- */
  world();
  g.fillStyle = WALLC;
  f.walls.forEach(w => { pathPoly(g, wallQuad(w)); g.fill(); });

  f.walls.forEach(w => {
    if (!w.openings.length) return;
    const n = unitNormal(w.a, w.b), Ln = n.L, ht = w.t / 2;
    w.openings.forEach(op => {
      const c = clamp(op.at, 0, 1) * Ln, half = Math.min(op.width, Ln) / 2;
      const t0 = clamp(c - half, 0, Ln), t1 = clamp(c + half, 0, Ln);
      if (t1 - t0 < 0.5) return;
      const P = (t: number): Pt => ({ x: w.a.x + n.ux * t, y: w.a.y + n.uy * t });
      const p0 = P(t0), p1 = P(t1), ex = ht * 1.35;

      world();
      pathPoly(g, [
        { x: p0.x + n.x * ex, y: p0.y + n.y * ex }, { x: p1.x + n.x * ex, y: p1.y + n.y * ex },
        { x: p1.x - n.x * ex, y: p1.y - n.y * ex }, { x: p0.x - n.x * ex, y: p0.y - n.y * ex },
      ]);
      g.fillStyle = PAPER; g.fill();

      g.strokeStyle = WALLC; g.lineWidth = LW(1.2);
      [p0, p1].forEach(p => {
        g.beginPath();
        g.moveTo(p.x + n.x * ht, p.y + n.y * ht);
        g.lineTo(p.x - n.x * ht, p.y - n.y * ht);
        g.stroke();
      });

      if (op.type === 'window') {
        g.strokeStyle = '#3A342B'; g.lineWidth = LW(1.3);
        for (const s of [0.42, -0.42]) {
          g.beginPath();
          g.moveTo(p0.x + n.x * ht * s * 2, p0.y + n.y * ht * s * 2);
          g.lineTo(p1.x + n.x * ht * s * 2, p1.y + n.y * ht * s * 2);
          g.stroke();
        }
        g.strokeStyle = hexA('#3A342B', 0.5); g.lineWidth = LW(1);
        g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
      } else {
        /* leaf swung 90° open, plus the arc back to the closed position */
        const wid = t1 - t0;
        const hinge = op.flip ? p1 : p0;
        const along = op.flip ? -1 : 1;
        const side = op.side ? -1 : 1;
        const open = { x: n.x * side, y: n.y * side };
        const shut = { x: n.ux * along, y: n.uy * along };
        const a0 = Math.atan2(open.y, open.x), a1 = Math.atan2(shut.y, shut.x);
        let d = a1 - a0;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        g.strokeStyle = hexA('#3A342B', 0.4); g.lineWidth = LW(1);
        g.beginPath(); g.arc(hinge.x, hinge.y, wid, a0, a1, d < 0); g.stroke();
        g.strokeStyle = '#3A342B'; g.lineWidth = LW(2.2);
        g.beginPath(); g.moveTo(hinge.x, hinge.y);
        g.lineTo(hinge.x + open.x * wid, hinge.y + open.y * wid); g.stroke();
      }
    });
  });

  /* ---- objects ---- */
  if (L.furn) {
    f.items.forEach(i => {
      world(); g.save();
      g.translate(i.x, i.y);
      if (i.rot) g.rotate((i.rot * Math.PI) / 180);
      if (i.flip) g.scale(-1, 1);
      const c = CAT_BY_KIND[i.kind];
      const col = i.color || toneFor(c);
      g.fillStyle = hexA(col, i.kind === 'fixture' ? 0.2 : 0.3);
      g.strokeStyle = hexA(col, 0.95);
      g.lineWidth = LW(1.4); g.lineJoin = 'round'; g.lineCap = 'butt';
      if (c) {
        c.draw(g, i.w, i.h, u);
      } else {
        /* imported fitted object: hatched box — clearly from the listing */
        rr(g, -i.w / 2, -i.h / 2, i.w, i.h, 2); g.fill();
        g.save(); g.setLineDash([LW(6), LW(4)]); g.stroke(); g.restore();
        g.save();
        rr(g, -i.w / 2, -i.h / 2, i.w, i.h, 2); g.clip();
        g.globalAlpha = 0.45; g.lineWidth = LW(1);
        const step = clamp(Math.min(i.w, i.h) / 3.2, 7, 26), span = i.w + i.h;
        g.beginPath();
        for (let d = -span; d <= span; d += step) {
          g.moveTo(-i.w / 2 + d, -i.h / 2);
          g.lineTo(-i.w / 2 + d + i.h, i.h / 2);
        }
        g.stroke(); g.restore();
      }
      g.restore();

      const lab = objectLabels ? labelOf(i) : '';
      if (lab && i.w * Z > 34) {
        const size = clamp(11 * Math.min(1, Z * 3.4), 7, 12);
        const rad = ((i.rot || 0) * Math.PI) / 180;
        const hh = (Math.abs(i.w * Math.sin(rad)) + Math.abs(i.h * Math.cos(rad))) / 2;
        if (hh * 2 * Z >= 46) {
          const r = (((i.rot || 0) % 360) + 360) % 360;
          label(lab, i.x, i.y, size, '#3E3830', 'center', 'middle', true, r > 90 && r < 270 ? r - 180 : r);
        } else {
          label(lab, i.x, i.y + hh + size * 0.95 * u, size, '#4A443A', 'center', 'middle', true, 0);
        }
      }
    });
  }

  /* ---- room names and areas ---- */
  if (L.rooms) {
    f.areas.forEach(a => {
      if (a.label === false) return;
      const c = polyCentroid(a.poly), A = polyArea(a.poly);
      const cx = c.x + (a.nx || 0), cy = c.y + (a.ny || 0);
      const nm = roomLabels ? a.name || '' : '';
      const big = A * Z * Z > 2600;

      /* one centred stack, so a third row cannot collide with the other two */
      const rows: [string, number, string, boolean][] = [];
      if (nm && big) rows.push([nm, clamp(13 * Math.min(1, Z * 3), 8, 13), '#37312A', false]);
      if (L.areas && A * Z * Z > 1500) {
        rows.push([`${fmtM2(A)} m²`, clamp(11 * Math.min(1, Z * 3), 7, 11), '#7A7261', true]);
      }
      /* A third row needs its own, larger allowance: a 0.3 m² cupboard has room
         for a name, not for a name, an area and a size. */
      if (measures && A * Z * Z > 9000) {
        const r = bboxOf(a.poly);
        rows.push([
          `${((r.x1 - r.x0) / 100).toFixed(1)} × ${((r.y1 - r.y0) / 100).toFixed(1)} m`,
          clamp(10 * Math.min(1, Z * 3), 7, 10), '#8C857A', true,
        ]);
      }
      /* pitch off the largest row, or 13px text collides at an 11px step */
      const pitch = Math.max(...rows.map(([, size]) => size), 9) * 1.25;
      rows.forEach(([t, size, col, isMono], i) => {
        const y = cy + (i - (rows.length - 1) / 2) * pitch * u;
        if (isMono) mono(t, cx, y, size, col); else label(t, cx, y, size, col);
      });
    });
  }

  /* ---- dimension lines ---- */
  if (L.dims) {
    f.dims.forEach(d => {
      const n = unitNormal(d.a, d.b);
      world();
      g.strokeStyle = hexA(CYA, 0.85); g.lineWidth = LW(1);
      g.beginPath(); g.moveTo(d.a.x, d.a.y); g.lineTo(d.b.x, d.b.y); g.stroke();
      const tick = 5 * u * 1.6;
      [d.a, d.b].forEach(p => {
        g.beginPath();
        g.moveTo(p.x + n.x * tick, p.y + n.y * tick);
        g.lineTo(p.x - n.x * tick, p.y - n.y * tick);
        g.stroke();
      });
      const m = { x: (d.a.x + d.b.x) / 2, y: (d.a.y + d.b.y) / 2 };
      if (n.L * Z > 34) mono(String(Math.round(n.L)), m.x + n.x * 9 * u, m.y + n.y * 9 * u, 10, CYA);
    });
  }

  /* ---- overall dimensions, drawn outside the footprint ---- */
  if (measures) {
    const sb = shellBBox(f);
    if (sb && sb.x1 > sb.x0 && sb.y1 > sb.y0) {
      const x0 = sx(sb.x0), x1 = sx(sb.x1), y0 = sy(sb.y0), y1 = sy(sb.y1);
      const off = 30, ink = 'rgba(60,54,44,.8)';
      g.save(); screen();
      g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = 1.2;
      g.font = '600 12px "IBM Plex Mono", monospace';
      g.lineJoin = 'round';

      /** architectural end tick: a 45° slash, leaning the same way on both chains */
      const tick = (x: number, y: number) => {
        const d = 4.5;
        g.beginPath();
        g.moveTo(x - d, y + d); g.lineTo(x + d, y - d);
        g.stroke();
      };
      const caption = (text: string, x: number, y: number, rot: number) => {
        g.save();
        g.translate(x, y);
        if (rot) g.rotate((rot * Math.PI) / 180);
        g.textAlign = 'center'; g.textBaseline = 'bottom';
        g.lineWidth = 3.4; g.strokeStyle = 'rgba(243,240,231,.92)';
        g.strokeText(text, 0, 0);
        g.fillStyle = ink; g.fillText(text, 0, 0);
        g.restore();
      };
      const metres = (cm: number) => `${(cm / 100).toFixed(2)} m`;

      /* width, below the plan */
      const hy = y1 + off;
      g.beginPath();
      g.moveTo(x0, hy); g.lineTo(x1, hy);
      g.moveTo(x0, y1 + 7); g.lineTo(x0, hy + 7);          // witness lines
      g.moveTo(x1, y1 + 7); g.lineTo(x1, hy + 7);
      g.stroke();
      tick(x0, hy); tick(x1, hy);
      caption(metres(sb.x1 - sb.x0), (x0 + x1) / 2, hy - 5, 0);

      /* height, left of the plan — text reads bottom-to-top, as on a drawing */
      const vx = x0 - off;
      g.beginPath();
      g.moveTo(vx, y0); g.lineTo(vx, y1);
      g.moveTo(x0 - 7, y0); g.lineTo(vx - 7, y0);
      g.moveTo(x0 - 7, y1); g.lineTo(vx - 7, y1);
      g.stroke();
      tick(vx, y0); tick(vx, y1);
      caption(metres(sb.y1 - sb.y0), vx - 5, (y0 + y1) / 2, -90);
      g.restore();
    }
    scaleBar();
  }

  /* ---- text notes ---- */
  if (L.notes) {
    f.notes.forEach(nt => {
      const sz = clamp((nt.size || 20) * Z * 0.55, 8, 26);
      g.save(); screen();
      g.translate(sx(nt.x), sy(nt.y));
      if (nt.rot) g.rotate((nt.rot * Math.PI) / 180);
      g.font = `400 ${sz}px "IBM Plex Sans", sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      String(nt.text).split('\n').forEach((line, i, all) => {
        const y = (i - (all.length - 1) / 2) * sz * 1.3;
        g.lineWidth = 3; g.strokeStyle = 'rgba(243,240,231,.9)'; g.lineJoin = 'round';
        g.strokeText(line, 0, y);
        g.fillStyle = nt.color || '#4A443A'; g.fillText(line, 0, y);
      });
      g.restore();
    });
  }

  if (!live) { screen(); return; }

  /* ═══════ interactive overlays ═══════ */

  if (hover) {
    world(); g.save();
    g.strokeStyle = hexA(ACC, 0.55); g.lineWidth = LW(2); g.lineJoin = 'round';
    if (hover.t === 'wall') { pathPoly(g, wallQuad(hover.o)); g.stroke(); }
    else if (hover.t === 'area') { pathPoly(g, hover.o.poly); g.stroke(); }
    else if (hover.t === 'item') {
      g.translate(hover.o.x, hover.o.y);
      if (hover.o.rot) g.rotate((hover.o.rot * Math.PI) / 180);
      g.strokeRect(-hover.o.w / 2, -hover.o.h / 2, hover.o.w, hover.o.h);
    } else if (hover.t === 'opening') { pathPoly(g, openingRect(hover.wall, hover.o)); g.stroke(); }
    else if (hover.t === 'note') { g.beginPath(); g.arc(hover.o.x, hover.o.y, 14 * u, 0, 6.2832); g.stroke(); }
    else { g.beginPath(); g.moveTo(hover.o.a.x, hover.o.a.y); g.lineTo(hover.o.b.x, hover.o.b.y); g.stroke(); }
    g.restore();
  }

  selection.forEach(s => {
    world(); g.save();
    g.strokeStyle = ACC; g.lineWidth = LW(2); g.lineJoin = 'round';
    if (s.t === 'wall') {
      pathPoly(g, wallQuad(s.o)); g.stroke();
      const n = unitNormal(s.o.a, s.o.b);
      mono(`${Math.round(n.L)} cm`,
        (s.o.a.x + s.o.b.x) / 2 + n.x * 16 * u, (s.o.a.y + s.o.b.y) / 2 + n.y * 16 * u, 10, ACC);
    } else if (s.t === 'area') {
      pathPoly(g, s.o.poly); g.stroke();
      g.fillStyle = hexA(ACC, 0.09); g.fill();
    } else if (s.t === 'item') {
      g.translate(s.o.x, s.o.y);
      if (s.o.rot) g.rotate((s.o.rot * Math.PI) / 180);
      g.strokeRect(-s.o.w / 2, -s.o.h / 2, s.o.w, s.o.h);
      mono(`${Math.round(s.o.w)}×${Math.round(s.o.h)}`, s.o.x, s.o.y - s.o.h / 2 - 13 * u, 10, ACC);
    } else if (s.t === 'opening') {
      const q = openingRect(s.wall, s.o);
      pathPoly(g, q); g.stroke();
      mono(`${Math.round(s.o.width)} cm`, (q[0].x + q[2].x) / 2, (q[0].y + q[2].y) / 2 - 15 * u, 10, ACC);
    } else if (s.t === 'note') {
      g.beginPath(); g.arc(s.o.x, s.o.y, 15 * u, 0, 6.2832); g.stroke();
    } else {
      g.beginPath(); g.moveTo(s.o.a.x, s.o.a.y); g.lineTo(s.o.b.x, s.o.b.y); g.stroke();
    }
    g.restore();
  });

  if (handles.length) {
    screen();
    handles.forEach(h => {
      g.save(); g.beginPath();
      if (h.k === 'rot') {
        g.arc(h.sx, h.sy, 5.5, 0, 6.2832);
        g.fillStyle = PAPER; g.fill();
        g.strokeStyle = ACC; g.lineWidth = 1.8; g.stroke();
        g.beginPath(); g.arc(h.sx, h.sy, 2, 0, 6.2832); g.fillStyle = ACC; g.fill();
      } else {
        const r = h.k === 'vtx' || h.k === 'end' ? 4.2 : 4;
        g.rect(h.sx - r, h.sy - r, r * 2, r * 2);
        g.fillStyle = PAPER; g.fill();
        g.strokeStyle = ACC; g.lineWidth = 1.8; g.stroke();
      }
      g.restore();
    });
  }

  if (draft) {
    const dot = (p: Pt) => {
      world(); g.beginPath(); g.arc(p.x, p.y, 3.6 * u, 0, 6.2832); g.fillStyle = ACC; g.fill();
    };
    if (draft.kind === 'wall') {
      world(); g.save();
      g.strokeStyle = hexA(ACC, 0.55); g.lineWidth = Math.max(LW(2), draft.t); g.lineCap = 'butt';
      g.beginPath(); g.moveTo(draft.pts[0].x, draft.pts[0].y);
      for (let i = 1; i < draft.pts.length; i++) g.lineTo(draft.pts[i].x, draft.pts[i].y);
      if (draft.cur) g.lineTo(draft.cur.x, draft.cur.y);
      g.stroke(); g.restore();
      draft.pts.forEach(dot);
      if (draft.cur) {
        const last = draft.pts[draft.pts.length - 1];
        const Lm = dist(last, draft.cur);
        const ang = ((Math.atan2(draft.cur.y - last.y, draft.cur.x - last.x) * 180) / Math.PI + 360) % 360;
        if (Lm > 1) {
          mono(`${Math.round(Lm)} cm   ∠${Math.round(ang)}°`,
            (last.x + draft.cur.x) / 2, (last.y + draft.cur.y) / 2 - 16 * u, 10.5, ACC);
        }
      }
    } else if (draft.kind === 'room') {
      const pts = draft.cur ? draft.pts.concat([draft.cur]) : draft.pts;
      if (pts.length > 1) {
        world(); g.save();
        pathPoly(g, pts); g.fillStyle = hexA(ACC, 0.13); g.fill();
        g.strokeStyle = ACC; g.lineWidth = LW(1.6); g.setLineDash([LW(8), LW(5)]); g.stroke();
        g.restore();
        if (pts.length > 2) {
          const c = polyCentroid(pts);
          mono(`${fmtM2(polyArea(pts))} m²`, c.x, c.y, 11.5, ACC);
        }
      }
      pts.forEach(dot);
    } else if (draft.kind === 'measure' && draft.cur) {
      const n = unitNormal(draft.a, draft.cur), tk = 8 * u;
      world(); g.save();
      g.strokeStyle = CYA; g.lineWidth = LW(1.5); g.setLineDash([LW(7), LW(5)]);
      g.beginPath(); g.moveTo(draft.a.x, draft.a.y); g.lineTo(draft.cur.x, draft.cur.y); g.stroke();
      g.setLineDash([]);
      [draft.a, draft.cur].forEach(p => {
        g.beginPath();
        g.moveTo(p.x + n.x * tk, p.y + n.y * tk);
        g.lineTo(p.x - n.x * tk, p.y - n.y * tk);
        g.stroke();
      });
      g.restore();
      const Lm = dist(draft.a, draft.cur);
      if (Lm > 1) {
        mono(Lm >= 100 ? `${(Lm / 100).toFixed(2)} m` : `${Math.round(Lm)} cm`,
          (draft.a.x + draft.cur.x) / 2 + n.x * 17 * u,
          (draft.a.y + draft.cur.y) / 2 + n.y * 17 * u, 11.5, CYA);
      }
    } else if (draft.kind === 'cal') {
      if (draft.a && draft.cur && !draft.b) {
        world(); g.save(); g.strokeStyle = ACC; g.lineWidth = LW(1.5);
        g.beginPath(); g.moveTo(draft.a.x, draft.a.y); g.lineTo(draft.cur.x, draft.cur.y); g.stroke();
        g.restore();
      }
      if (draft.a && draft.b) {
        world(); g.save(); g.strokeStyle = ACC; g.lineWidth = LW(1.8);
        g.beginPath(); g.moveTo(draft.a.x, draft.a.y); g.lineTo(draft.b.x, draft.b.y); g.stroke();
        g.restore();
        mono(`${Math.round(dist(draft.a, draft.b))} units`,
          (draft.a.x + draft.b.x) / 2, (draft.a.y + draft.b.y) / 2 - 16 * u, 11, ACC);
      }
      if (draft.a) dot(draft.a);
      if (draft.b) dot(draft.b);
    }
  }

  if (place) {
    const c = CAT_BY_KIND[place.kind];
    if (c) {
      world(); g.save();
      g.globalAlpha = 0.5;
      g.translate(place.x, place.y);
      const col = toneFor(c);
      g.fillStyle = hexA(col, 0.3); g.strokeStyle = hexA(col, 0.95);
      g.lineWidth = LW(1.4); g.lineJoin = 'round';
      c.draw(g, c.w, c.h, u);
      g.restore();
      mono(`${c.name}  ${c.w}×${c.h}`, place.x, place.y - c.h / 2 - 13 * u, 10, ACC);
    }
  }

  if (marquee) {
    screen();
    const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
    const w = Math.abs(marquee.x1 - marquee.x0), h = Math.abs(marquee.y1 - marquee.y0);
    g.fillStyle = hexA(ACC, 0.08); g.fillRect(x, y, w, h);
    g.strokeStyle = hexA(ACC, 0.8); g.lineWidth = 1;
    g.setLineDash([5, 4]); g.strokeRect(x + 0.5, y + 0.5, w, h); g.setLineDash([]);
  }

  if (snapHint) {
    screen();
    const p = { x: sx(snapHint.x), y: sy(snapHint.y) };
    g.strokeStyle = CYA; g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(p.x - 7, p.y); g.lineTo(p.x + 7, p.y);
    g.moveTo(p.x, p.y - 7); g.lineTo(p.x, p.y + 7);
    g.stroke();
  }

  /* scale bar */
  scaleBar();
  screen();
}

export { wallQuad, openingRect, hexA, gridStep, pathPoly };
