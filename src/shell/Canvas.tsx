'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useEditor, selectedObjects } from '@state/store';
import { paint } from '@engine/render';
import { fitFloor, handlesFor, hitHandle, snapPoint, toWorld, zoomAt } from '@engine/view';
import { hitTest } from '@engine/hit';
import type { Hit, Pt, View } from '@engine/types';

/** The only imperative surface in the app. React owns the chrome; this owns the
 *  pixels, and talks to the engine directly so a repaint never goes through
 *  reconciliation. */
export function Canvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const hover = useRef<Hit | null>(null);
  const drag = useRef<
    | { kind: 'pan'; sx: number; sy: number; view: View }
    | { kind: 'marquee'; from: Pt }
    | null
  >(null);

  /** Repaint from whatever the store currently holds. Deliberately reads state
   *  imperatively rather than via hooks, so it can be called from any handler. */
  const draw = useCallback(() => {
    const cv = ref.current;
    if (!cv) return;
    const s = useEditor.getState();
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
      floor,
      view: s.view,
      width: w,
      height: h,
      dpr,
      layers: s.layers,
      grid: s.grid,
      live: true,
      ghost: below,
      selection: sel,
      handles: s.tool === 'select' && !drag.current ? handlesFor(sel, s.view) : [],
      hover: hover.current,
      draft: s.draft,
      marquee: s.marquee,
      snapHint: s.snapHint,
      refOpacity: s.refOpacity,
    });
  }, []);

  /* repaint whenever anything the painter reads changes */
  useEffect(() => useEditor.subscribe(draw), [draw]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ro = new ResizeObserver(() => {
      const s = useEditor.getState();
      if (!s.view.px && !s.view.py) {
        s.setView(fitFloor(s.floor(), cv.clientWidth, cv.clientHeight));
      }
      draw();
    });
    ro.observe(cv);
    return () => ro.disconnect();
  }, [draw]);

  const local = (e: React.PointerEvent | React.WheelEvent): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = useEditor.getState();
    const sp = local(e);
    const wp = toWorld(s.view, sp.x, sp.y);
    (e.target as HTMLCanvasElement).setPointerCapture?.(e.pointerId);

    if (e.button === 1 || s.tool === 'pan' || e.altKey) {
      drag.current = { kind: 'pan', sx: sp.x, sy: sp.y, view: s.view };
      return;
    }
    if (e.button !== 0) return;

    const sel = selectedObjects(s);
    if (s.tool === 'select' && hitHandle(handlesFor(sel, s.view), sp)) return; // handles land in the next slice

    const hit = hitTest(s.floor(), wp, s.view, s.layers);
    if (hit) {
      const ref_ = { t: hit.t, id: hit.o.id };
      s.setSel(e.shiftKey ? [...s.sel.filter(x => x.id !== ref_.id), ref_] : [ref_]);
    } else {
      if (!e.shiftKey) s.setSel([]);
      drag.current = { kind: 'marquee', from: sp };
    }
    draw();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = useEditor.getState();
    const sp = local(e);
    const d = drag.current;

    if (d?.kind === 'pan') {
      s.setView({ ...d.view, px: d.view.px + (sp.x - d.sx), py: d.view.py + (sp.y - d.sy) });
      return;
    }
    if (d?.kind === 'marquee') {
      s.patch({ marquee: { x0: d.from.x, y0: d.from.y, x1: sp.x, y1: sp.y } });
      return;
    }
    if (s.tool !== 'select') return;

    const wp = toWorld(s.view, sp.x, sp.y);
    const h = hitTest(s.floor(), wp, s.view, s.layers);
    const key = h ? `${h.t}:${h.o.id}` : '';
    const prev = hover.current ? `${hover.current.t}:${hover.current.o.id}` : '';
    if (key !== prev) { hover.current = h; draw(); }
  };

  const endDrag = () => {
    if (drag.current?.kind === 'marquee') useEditor.getState().patch({ marquee: null });
    drag.current = null;
    draw();
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const s = useEditor.getState();
    const sp = local(e);
    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      s.setView(zoomAt(s.view, sp.x, sp.y, Math.pow(0.9987, e.deltaY * (e.deltaMode === 1 ? 18 : 1))));
    } else {
      s.setView({ ...s.view, px: s.view.px - e.deltaX, py: s.view.py - e.deltaY });
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
      onPointerLeave={() => { hover.current = null; draw(); }}
      onWheel={onWheel}
    />
  );
}

export { snapPoint };
