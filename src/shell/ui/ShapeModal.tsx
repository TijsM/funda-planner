'use client';

import { useEffect, useRef, useState } from 'react';
import type { Pt } from '@engine/types';
import { SHAPE_PRESETS, drawablePoly, newShape, normalisePoly } from '@engine/custom';
import { ed, useEditor } from '@state/store';
import { addShape } from '../commands';
import { Icon } from './Icons';

/** Drawing surface: the outline is authored in unit space and shown at the
 *  footprint's own aspect ratio, so what someone draws for a 60×80 bin is not
 *  quietly squashed when it lands on the plan at 60×80. */
const MAX_PX = 300;

/* Margin in pixels between the footprint and the edge of the surface.
 *
 *  The footprint used to run edge to edge, which left nowhere to click that was
 *  not already inside the shape: the corner handles sat half off the canvas, and
 *  the first click of a new outline landed inside the preset that filled it. The
 *  drawn frame is the footprint; this is elbow room around it, and a click out
 *  here clamps to the nearest edge rather than being thrown away — which is what
 *  someone aiming at a corner from outside it meant. */
const PAD = 30;

/* Vertices land on a twentieth of the footprint. Freehand pixel positions look
   deliberate on a 300 px canvas and ragged at print scale, where a plan is drawn
   at four times that: a wall that should be flush ends up 3 cm proud. */
const SNAP = 20;

/* Nothing, deliberately. A prefilled rectangle is the answer to a different
   question — "resize a box" — and this modal is reached by someone whose object
   is not in the catalogue at all. The presets are one click away for anyone who
   did want the box. */
const START: Pt[] = [];

export function ShapeModal() {
  const seed = useEditor(s => s.shapeSeed);
  const [name, setName] = useState(seed);
  const [w, setW] = useState(60);
  const [h, setH] = useState(60);
  const [z, setZ] = useState(75);
  const [poly, setPoly] = useState<Pt[]>(START);
  const [round, setRound] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);

  /* The name is the one field that cannot be guessed from the drawing, so it
     takes the caret — with the seed selected, because a search term is a
     starting point and not necessarily the name of the thing. */
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => { nameRef.current?.focus(); nameRef.current?.select(); }, 30);
    return () => clearTimeout(t);
  }, []);

  /* `field` is the footprint; `px` is the surface it sits in the middle of. */
  const field = (() => {
    const k = Math.min(MAX_PX / Math.max(1, w), MAX_PX / Math.max(1, h));
    return { w: Math.max(90, Math.round(w * k)), h: Math.max(90, Math.round(h * k)) };
  })();
  const px = { w: field.w + PAD * 2, h: field.h + PAD * 2 };

  /* Same drawing code the plan uses would need the item; this is the outline
     itself, with its vertices on top — the editor is the only place the handles
     exist, and the only place the grid does. */
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const d = Math.min(window.devicePixelRatio || 1, 2);
    c.width = px.w * d; c.height = px.h * d;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, px.w, px.h);

    /* Grid inside the footprint only: a grid running out into the margin would
       say the margin is part of the object, which is the confusion this padding
       exists to remove. */
    g.strokeStyle = 'rgba(140,133,122,.26)';
    g.lineWidth = 1;
    for (let i = 1; i < SNAP; i++) {
      const x = PAD + (i / SNAP) * field.w, y = PAD + (i / SNAP) * field.h;
      g.beginPath(); g.moveTo(x, PAD); g.lineTo(x, PAD + field.h); g.stroke();
      g.beginPath(); g.moveTo(PAD, y); g.lineTo(PAD + field.w, y); g.stroke();
    }

    g.fillStyle = 'rgba(228,99,44,.22)';
    g.strokeStyle = '#E4632C';
    g.lineWidth = 2;
    g.lineJoin = 'round';
    const X = (u: number) => PAD + u * field.w;
    const Y = (u: number) => PAD + u * field.h;

    if (round) {
      g.beginPath();
      g.ellipse(X(0.5), Y(0.5), field.w / 2, field.h / 2, 0, 0, Math.PI * 2);
      g.fill(); g.stroke();
      return;
    }
    if (drawablePoly(poly)) {
      g.beginPath();
      poly.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y))));
      g.closePath(); g.fill(); g.stroke();
    }
    poly.forEach((p, i) => {
      g.beginPath();
      g.arc(X(p.x), Y(p.y), 5, 0, Math.PI * 2);
      g.fillStyle = i === 0 ? '#E4632C' : '#F3F0E7';
      g.fill();
      g.strokeStyle = '#E4632C';
      g.lineWidth = 2;
      g.stroke();
    });
  }, [poly, round, px.w, px.h, field.w, field.h]);

  const at = (e: React.PointerEvent): Pt => {
    const r = (box.current as HTMLDivElement).getBoundingClientRect();
    /* The surface can be laid out at a hair off its nominal size, so the margin
       is scaled with it rather than assumed to be exactly PAD on screen. */
    const k = r.width / px.w;
    const snap = (v: number) => Math.min(1, Math.max(0, Math.round(v * SNAP) / SNAP));
    return {
      x: snap((e.clientX - r.left - PAD * k) / (field.w * k)),
      y: snap((e.clientY - r.top - PAD * k) / (field.h * k)),
    };
  };

  const near = (p: Pt) => poly.findIndex(q => Math.hypot(q.x - p.x, q.y - p.y) < 0.06);

  const down = (e: React.PointerEvent) => {
    if (round) return;
    e.preventDefault();
    const p = at(e);
    const hit = near(p);
    /* An existing vertex is a handle; empty canvas is a new corner. No mode
       switch, no closing click: the outline is always closed, which is the only
       thing a footprint can be. */
    if (hit >= 0) { setDrag(hit); return; }
    setPoly([...poly, p]);
  };

  const move = (e: React.PointerEvent) => {
    if (drag === null) return;
    const p = at(e);
    setPoly(poly.map((q, i) => (i === drag ? p : q)));
  };

  const up = () => setDrag(null);

  const preset = (id: string) => {
    const s = SHAPE_PRESETS.find(x => x.id === id);
    if (!s) return;
    setRound(!!s.round);
    if (s.poly) setPoly(s.poly);
  };

  const usable = !!name.trim() && (round || drawablePoly(normalisePoly(poly)));

  const create = () => {
    if (!usable) return;
    addShape(newShape({ name, w, h, z, ...(round ? { round: 1 as const } : { poly }) }));
    ed().patch({ modal: null, shapeSeed: '', trayOpen: false });
    ed().toast(`${name.trim()} is in the tray — click the plan to place it.`, 'ok');
  };

  const num = (v: string, lo: number, hi: number) => {
    const n = Number(v.replace(/[^\d]/g, ''));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
  };

  return (
    <div
      className="ov open" id="ovShape"
      onMouseDown={e => { if (e.target === e.currentTarget) ed().patch({ modal: null }); }}
    >
      <div className="modal shape">
        <div className="m-h">
          <div style={{ flex: 1 }}>
            <h3>Draw an object</h3>
            <p className="hint">
              The catalogue does not have everything. Draw the footprint as seen from above,
              give it a name, and it joins this plan&rsquo;s tray.
            </p>
          </div>
          <button className="m-x" id="shapeClose" onClick={() => ed().patch({ modal: null })}>
            <Icon id="i-x" />
          </button>
        </div>

        <div className="m-b shape-b">
          <div className="shape-draw">
            <div
              className="shape-canvas" ref={box}
              style={{ width: px.w, height: px.h }}
              onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
            >
              <canvas ref={cv} id="shapeCanvas" />
              {/* The footprint's own edge, so the margin around it reads as room to
                  work in rather than as part of the object. */}
              <div className="shape-field" id="shapeField" style={{ inset: PAD }} />
            </div>
            <p className="hint">
              {round ? 'A round footprint takes its size from the width and depth.'
                : poly.length === 0 ? 'Click the corners of the footprint, three or more.'
                  : poly.length < 3 ? `${3 - poly.length} more corner${poly.length === 2 ? '' : 's'} and it is a shape.`
                    : 'Click to add a corner, drag one to move it.'}
            </p>
            <div className="shape-acts">
              <button
                className="btn sm" id="shapeUndo" disabled={round || !poly.length}
                onClick={() => setPoly(poly.slice(0, -1))}
              >Remove corner</button>
              <button
                className="btn sm" id="shapeClear" disabled={round || !poly.length}
                onClick={() => setPoly([])}
              >Start over</button>
            </div>
          </div>

          <div className="shape-side">
            <div className="row">
              <span className="lbl">Name</span>
              <div className="fields"><div className="fld wide">
                <input
                  ref={nameRef} id="shapeName" spellCheck={false} placeholder="wheelie bin, kliko, piano stool…"
                  value={name} onChange={e => setName(e.target.value)}
                  onKeyDown={e => {
                    e.stopPropagation();
                    if (e.key === 'Enter') create();
                    if (e.key === 'Escape') ed().patch({ modal: null });
                  }}
                />
              </div></div>
            </div>

            <span className="lbl">Start from</span>
            <div className="shape-presets">
              {SHAPE_PRESETS.map(s => (
                <button
                  key={s.id} className="btn sm" data-preset={s.id}
                  onClick={() => preset(s.id)}
                >{s.name}</button>
              ))}
            </div>

            <div className="row">
              <span className="lbl">Size</span>
              <div className="fields">
                <div className="fld"><input
                  id="shapeW" inputMode="numeric" value={w}
                  onChange={e => setW(num(e.target.value, 1, 2000))}
                  onKeyDown={e => e.stopPropagation()}
                /><em>cm wide</em></div>
                <div className="fld"><input
                  id="shapeH" inputMode="numeric" value={h}
                  onChange={e => setH(num(e.target.value, 1, 2000))}
                  onKeyDown={e => e.stopPropagation()}
                /><em>cm deep</em></div>
              </div>
            </div>

            <div className="row">
              <span className="lbl">Height</span>
              <div className="fields">
                <div className="fld"><input
                  id="shapeZ" inputMode="numeric" value={z}
                  onChange={e => setZ(num(e.target.value, 0, 400))}
                  onKeyDown={e => e.stopPropagation()}
                /><em>cm tall</em></div>
              </div>
            </div>
            {/* The only field whose absence is invisible until a render comes back:
                a top-down drawing cannot say how tall a thing is, and the depth map
                the image model is conditioned on needs to know. */}
            <p className="hint">
              How tall it stands. The renders use it to tell a low table from a cupboard.
            </p>

            <div className="spring" />
            <div className="shape-go">
              <button className="btn" id="shapeCancel" onClick={() => ed().patch({ modal: null })}>
                Cancel
              </button>
              <button className="btn pri" id="shapeCreate" disabled={!usable} onClick={create}>
                Create &amp; place
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
