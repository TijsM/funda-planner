'use client';

import { useCallback, useEffect, useRef } from 'react';
import { ed, selectedObjects, useEditor } from '@state/store';
import { paint } from '@engine/render';
import {
  axisLock, handlesFor, hitHandle, snapAngle, snapPoint, toWorld, zoomAt,
} from '@engine/view';
import { hitTest, nearestWall } from '@engine/hit';
import { closestOnSeg, clamp, dist, R2, rotPt } from '@engine/geometry';
import { setLabel } from '@engine/model';
import type { Area, Handle, Item, Pt, SelObj, Wall } from '@engine/types';
import {
  addOpeningTo, commitDraft, placeCatalogItem, placeSpecial, type SpecialKind,
} from './commands';

type DragState =
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | { kind: 'marquee'; from: Pt; add: boolean; base: { t: string; id: string }[] }
  | { kind: 'move'; from: Pt; moved: boolean; orig: string }
  | { kind: 'handle'; h: Handle; orig: string; }
  | null;

/** The only imperative surface in the app. React owns the chrome; this owns the
 *  pixels and the pointer, and talks to the engine directly so a repaint never
 *  goes through reconciliation. */
export function Canvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<DragState>(null);
  const refImg = useRef<Record<string, HTMLImageElement>>({});

  const draw = useCallback(() => {
    const cv = ref.current;
    if (!cv) return;
    const s = ed();
    const floor = s.floor();
    if (!floor) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const sel = selectedObjects(s);
    const below = s.ghost && s.project
      ? s.project.floors.filter(f => f.level < floor.level).sort((a, b) => b.level - a.level)[0] ?? null
      : null;

    paint(ctx, {
      floor, view: s.view, width: w, height: h, dpr,
      layers: s.layers, grid: s.grid, live: true,
      refImage: s.showRef ? refImg.current[floor.id] ?? null : null,
      refOpacity: s.refOpacity,
      ghost: below,
      selection: sel,
      handles: s.tool === 'select' && !drag.current ? handlesFor(sel, s.view) : [],
      hover: s.hover,
      draft: s.draft,
      marquee: s.marquee,
      snapHint: s.snapHint,
      place: s.place && !s.place.startsWith('draw:') && s.mouseInside
        ? { kind: s.place, x: s.mouseWorld.x, y: s.mouseWorld.y }
        : null,
    });
  }, []);

  /* repaint on any store change */
  useEffect(() => useEditor.subscribe(draw), [draw]);

  /* load the reference bitmap for the active floor */
  const floorRef = useEditor(s => s.floor()?.ref?.src ?? null);
  const floorId = useEditor(s => s.floor()?.id ?? '');
  useEffect(() => {
    if (!floorRef || !floorId || refImg.current[floorId]) { draw(); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const done = () => {
      const f = ed().floor();
      if (f && f.ref && (!f.ref.w || !f.ref.h)) {
        const b = { ...f.ref };
        const ar = img.naturalWidth / img.naturalHeight;
        const w = 1200;
        f.ref = { ...b, w, h: w / ar };
        ed().touch();
      }
      draw();
    };
    img.onload = done;
    img.onerror = () => {
      const i2 = new Image();
      i2.onload = done;
      i2.src = floorRef;
      refImg.current[floorId] = i2;
    };
    img.src = floorRef;
    refImg.current[floorId] = img;
  }, [floorRef, floorId, draw]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [draw]);

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const snapCfg = () => ({ on: ed().snap, grid: ed().gridSize, view: ed().view });

  /* ── press ────────────────────────────────────────────────────── */
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = ed();
    if (!s.project) return;
    try { ref.current?.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const sp = local(e);
    const wp = toWorld(s.view, sp.x, sp.y);

    if (e.button === 1 || s.tool === 'pan' || s.spaceDown) {
      drag.current = { kind: 'pan', sx: sp.x, sy: sp.y, px: s.view.px, py: s.view.py };
      return;
    }
    if (e.button !== 0) return;

    /* scale calibration takes precedence over every tool */
    if (s.calibrating) {
      const p = { x: R2(wp.x), y: R2(wp.y) };
      const d = s.draft?.kind === 'cal' ? s.draft : { kind: 'cal' as const };
      if (!d.a) s.patch({ draft: { ...d, a: p } });
      else s.patch({ draft: { ...d, b: p } });
      return;
    }

    if (s.place) {
      const p = snapPoint(s.floor(), wp, snapCfg());
      if (s.place.startsWith('draw:')) placeSpecial(s.place.slice(5) as SpecialKind, p, e.shiftKey);
      else placeCatalogItem(s.place, p, e.shiftKey);
      return;
    }

    switch (s.tool) {
      case 'select': {
        const sel = selectedObjects(s);
        const h = hitHandle(handlesFor(sel, s.view), sp);
        if (h) {
          s.pushUndo();
          drag.current = { kind: 'handle', h, orig: JSON.stringify(h.o) };
          return;
        }
        const hit = hitTest(s.floor(), wp, s.view, s.layers);
        if (hit) {
          const ref_ = { t: hit.t, id: hit.o.id };
          const already = s.sel.some(x => x.t === ref_.t && x.id === ref_.id);
          if (e.shiftKey) s.setSel(already ? s.sel.filter(x => x.id !== ref_.id) : [...s.sel, ref_]);
          else if (!already) s.setSel([ref_]);
          s.pushUndo();
          drag.current = {
            kind: 'move', from: wp, moved: false,
            orig: JSON.stringify(selectedObjects(ed()).map(o => o.o)),
          };
        } else {
          if (!e.shiftKey) s.setSel([]);
          drag.current = { kind: 'marquee', from: sp, add: e.shiftKey, base: s.sel.slice() };
        }
        return;
      }
      case 'wall': {
        const d = s.draft?.kind === 'wall' ? s.draft : null;
        const p = d?.pts.length
          ? snapAngle(d.pts[d.pts.length - 1], snapPoint(s.floor(), wp, snapCfg()), snapCfg(), e.altKey)
          : snapPoint(s.floor(), wp, snapCfg());
        if (!d) s.patch({ draft: { kind: 'wall', pts: [p], t: 10, cur: p } });
        else {
          s.patch({ draft: { ...d, pts: [...d.pts, p] } });
          if (e.detail > 1) commitDraft();
        }
        return;
      }
      case 'room': {
        const p = snapPoint(s.floor(), wp, snapCfg());
        const d = s.draft?.kind === 'room' ? s.draft : null;
        if (!d) s.patch({ draft: { kind: 'room', pts: [p], cur: p } });
        else if (d.pts.length > 2 && dist(p, d.pts[0]) < 14 / s.view.zoom) commitDraft();
        else s.patch({ draft: { ...d, pts: [...d.pts, p] } });
        return;
      }
      case 'door':
      case 'window': {
        const wl = nearestWall(s.floor(), wp, s.view);
        if (!wl) { s.toast('Click closer to a wall.', 'err'); return; }
        const c = closestOnSeg(wp, wl.a, wl.b);
        s.pushUndo();
        const op = {
          id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          at: R2(c.t), type: s.tool as 'door' | 'window',
          width: s.tool === 'door' ? 90 : 120, flip: 0 as const, side: 0 as const,
        };
        wl.openings.push(op);
        s.setSel([{ t: 'opening', id: op.id }]);
        if (!e.shiftKey) s.patch({ tool: 'select' });
        s.touch();
        return;
      }
      case 'text': {
        placeSpecial('note', snapPoint(s.floor(), wp, snapCfg()), false);
        s.patch({ tool: 'select' });
        return;
      }
      case 'measure': {
        const p = snapPoint(s.floor(), wp, snapCfg());
        const d = s.draft?.kind === 'measure' ? s.draft : null;
        if (!d || d.b) s.patch({ draft: { kind: 'measure', a: p, cur: p } });
        else {
          placeMeasure(d.a, p);
          s.patch({ draft: null, tool: 'select' });
        }
        return;
      }
    }
  };

  const placeMeasure = (a: Pt, b: Pt) => {
    const s = ed();
    const f = s.floor();
    if (!f) return;
    s.pushUndo();
    f.dims.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, a, b });
    s.touch();
  };

  /* ── move ─────────────────────────────────────────────────────── */
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = ed();
    if (!s.project) return;
    const sp = local(e);
    const wp = toWorld(s.view, sp.x, sp.y);
    s.patch({ mouseWorld: wp, mouseInside: true });

    const d = drag.current;
    if (d?.kind === 'pan') {
      s.setView({ ...s.view, px: d.px + (sp.x - d.sx), py: d.py + (sp.y - d.sy) });
      return;
    }
    if (d?.kind === 'marquee') {
      s.patch({ marquee: { x0: d.from.x, y0: d.from.y, x1: sp.x, y1: sp.y } });
      applyMarquee(d);
      return;
    }
    if (d?.kind === 'move') { doMove(d, wp, e); return; }
    if (d?.kind === 'handle') { doHandle(d, wp, e); return; }

    if (s.draft) {
      const cfg = snapCfg();
      if (s.draft.kind === 'wall') {
        const cur = snapAngle(s.draft.pts[s.draft.pts.length - 1], snapPoint(s.floor(), wp, cfg), cfg, e.altKey);
        s.patch({ draft: { ...s.draft, cur }, snapHint: cur });
      } else if (s.draft.kind === 'room' || s.draft.kind === 'measure') {
        const cur = snapPoint(s.floor(), wp, cfg);
        s.patch({ draft: { ...s.draft, cur }, snapHint: cur });
      } else if (s.draft.kind === 'cal' && s.draft.a && !s.draft.b) {
        s.patch({ draft: { ...s.draft, cur: wp } });
      }
      return;
    }
    if (s.place) { draw(); return; }
    if (s.tool !== 'select') return;

    const h = hitHandle(handlesFor(selectedObjects(s), s.view), sp);
    if (ref.current) ref.current.style.cursor = h ? (h.k === 'rot' ? 'grab' : 'nwse-resize') : 'default';
    const hv = h ? null : hitTest(s.floor(), wp, s.view, s.layers);
    const key = hv ? `${hv.t}:${hv.o.id}` : '';
    const prev = s.hover ? `${s.hover.t}:${s.hover.o.id}` : '';
    if (key !== prev) s.patch({ hover: hv });
  };

  const applyMarquee = (d: Extract<DragState, { kind: 'marquee' }>) => {
    const s = ed();
    const f = s.floor();
    const m = s.marquee;
    if (!f || !m) return;
    const a = toWorld(s.view, Math.min(m.x0, m.x1), Math.min(m.y0, m.y1));
    const b = toWorld(s.view, Math.max(m.x0, m.x1), Math.max(m.y0, m.y1));
    const inR = (p: Pt) => p.x >= a.x && p.x <= b.x && p.y >= a.y && p.y <= b.y;
    const out = d.add ? d.base.slice() : [];
    const push = (t: string, id: string) => {
      if (!out.some(x => x.t === t && x.id === id)) out.push({ t, id });
    };
    f.walls.forEach(w => { if (inR(w.a) && inR(w.b)) push('wall', w.id); });
    f.areas.forEach(x => { if (x.poly.every(inR)) push('area', x.id); });
    if (s.layers.furn) f.items.forEach(i => { if (inR(i)) push('item', i.id); });
    if (s.layers.notes) f.notes.forEach(n => { if (inR(n)) push('note', n.id); });
    if (s.layers.dims) f.dims.forEach(x => { if (inR(x.a) && inR(x.b)) push('dim', x.id); });
    f.lines.forEach(x => { if (inR(x.a) && inR(x.b)) push('line', x.id); });
    s.setSel(out as { t: SelObj['t']; id: string }[]);
  };

  const doMove = (d: Extract<DragState, { kind: 'move' }>, wp: Pt, e: React.PointerEvent) => {
    const s = ed();
    const f = s.floor();
    if (!f) return;
    let dx = wp.x - d.from.x, dy = wp.y - d.from.y;
    if (Math.hypot(dx, dy) > 1.5 / s.view.zoom) d.moved = true;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    if (s.snap) { dx = Math.round(dx / s.gridSize) * s.gridSize; dy = Math.round(dy / s.gridSize) * s.gridSize; }

    const orig = JSON.parse(d.orig) as unknown[];
    selectedObjects(s).forEach((o, i) => {
      const g = orig[i] as never;
      if (o.t === 'wall' || o.t === 'dim' || o.t === 'line') {
        const src = g as Wall;
        o.o.a.x = R2(src.a.x + dx); o.o.a.y = R2(src.a.y + dy);
        o.o.b.x = R2(src.b.x + dx); o.o.b.y = R2(src.b.y + dy);
      } else if (o.t === 'area') {
        const src = g as Area;
        o.o.poly.forEach((p, k) => { p.x = R2(src.poly[k].x + dx); p.y = R2(src.poly[k].y + dy); });
      } else if (o.t === 'opening') {
        o.o.at = R2(clamp(closestOnSeg(wp, o.wall.a, o.wall.b).t, 0, 1));
      } else {
        const src = g as Item;
        o.o.x = R2(src.x + dx); o.o.y = R2(src.y + dy);
      }
    });
    s.touch();
  };

  const doHandle = (d: Extract<DragState, { kind: 'handle' }>, wp: Pt, e: React.PointerEvent) => {
    const s = ed();
    const h = d.h;
    const cfg = snapCfg();

    if (h.k === 'end') {
      const o = h.o as Wall;
      let p = e.altKey ? { x: R2(wp.x), y: R2(wp.y) } : snapPoint(s.floor(), wp, cfg, o.id);
      if (e.shiftKey) p = axisLock(p, o[h.key === 'a' ? 'b' : 'a']);
      o[h.key!].x = p.x; o[h.key!].y = p.y;
      s.patch({ snapHint: p });
    } else if (h.k === 'vtx') {
      const o = h.o as Area;
      const p = snapPoint(s.floor(), wp, cfg);
      o.poly[h.i!].x = p.x; o.poly[h.i!].y = p.y;
      s.patch({ snapHint: p });
    } else if (h.k === 'rot') {
      const o = h.o as Item;
      let a = (Math.atan2(wp.y - o.y, wp.x - o.x) * 180) / Math.PI + 90;
      if (!e.altKey) a = Math.round(a / 15) * 15;
      o.rot = R2((a + 720) % 360);
    } else if (h.k === 'res') {
      const o = h.o as Item;
      const g = JSON.parse(d.orig) as Item;
      const co = [[-1, -1], [1, -1], [1, 1], [-1, 1]][h.i!];
      const opp = { x: (-co[0] * g.w) / 2, y: (-co[1] * g.h) / 2 };
      const m = rotPt(wp.x - g.x, wp.y - g.y, -(g.rot || 0));
      let nw = Math.max(4, (m.x - opp.x) * co[0]);
      let nh = Math.max(4, (m.y - opp.y) * co[1]);
      if (e.shiftKey) { const k = Math.max(nw / g.w, nh / g.h); nw = g.w * k; nh = g.h * k; }
      if (s.snap && !e.altKey) {
        nw = Math.max(4, Math.round(nw / s.gridSize) * s.gridSize);
        nh = Math.max(4, Math.round(nh / s.gridSize) * s.gridSize);
      }
      const nc = { x: opp.x + (co[0] * nw) / 2, y: opp.y + (co[1] * nh) / 2 };
      const wc = rotPt(nc.x, nc.y, g.rot || 0);
      o.w = R2(nw); o.h = R2(nh); o.x = R2(g.x + wc.x); o.y = R2(g.y + wc.y);
    }
    s.touch();
  };

  const endDrag = () => {
    const s = ed();
    const d = drag.current;
    if (d?.kind === 'move' && !d.moved) s.dropUndo();
    if (d?.kind === 'marquee') s.patch({ marquee: null });
    drag.current = null;
    s.patch({ snapHint: null });
    draw();
  };

  /* Wheel must be a native, non-passive listener. React registers its synthetic
     wheel handler as passive, so preventDefault() there is ignored — and a
     trackpad pinch (which arrives as wheel + ctrlKey) would zoom the whole page
     instead of the plan. */
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = ed();
      const sp = local(e);
      if (e.ctrlKey || e.metaKey || !e.shiftKey) {
        s.setView(zoomAt(s.view, sp.x, sp.y, Math.pow(0.9987, e.deltaY * (e.deltaMode === 1 ? 18 : 1))));
      } else {
        s.setView({ ...s.view, px: s.view.px - e.deltaX, py: s.view.py - e.deltaY });
      }
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, []);

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const s = ed();
    if (s.draft) { commitDraft(); return; }
    const wp = toWorld(s.view, local(e).x, local(e).y);
    const hit = hitTest(s.floor(), wp, s.view, s.layers);
    if (hit?.t === 'area') {
      /* add a vertex on the nearest edge */
      const a = hit.o;
      let bi = -1, bd = 14 / s.view.zoom;
      for (let i = 0; i < a.poly.length; i++) {
        const p0 = a.poly[i], p1 = a.poly[(i + 1) % a.poly.length];
        const d2 = dist(wp, closestOnSeg(wp, p0, p1));
        if (d2 < bd) { bd = d2; bi = i; }
      }
      if (bi >= 0) {
        s.pushUndo();
        a.poly.splice(bi + 1, 0, { x: R2(wp.x), y: R2(wp.y) });
        s.setSel([{ t: 'area', id: a.id }]);
        s.touch();
      }
    }
  };

  return (
    <canvas
      id="cv"
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => { ed().patch({ hover: null, mouseInside: false }); draw(); }}
      onDoubleClick={onDoubleClick}
      onContextMenu={e => {
        e.preventDefault();
        const s = ed();
        if (s.draft) commitDraft();
        else if (s.place) s.patch({ place: null });
      }}
    />
  );
}

export { setLabel, addOpeningTo };
