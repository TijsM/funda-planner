'use client';

import { useEffect, useRef, useState } from 'react';
import { ed, useEditor, useEditorShallow, useSelection } from '@state/store';
import { CATALOG, CAT_BY_KIND, ROOM_SWATCHES, SWATCHES, toneFor } from '@engine/catalog';
import { dist, fmtM2, polyArea } from '@engine/geometry';
import { labelOf, setLabel } from '@engine/model';
import { selScreenBBox, snapPoint, toWorld } from '@engine/view';
import type { Area, Item, Note, Opening, SelObj, Wall } from '@engine/types';
import {
  SPECIALS, addOpeningTo, deleteSelection, duplicateSelection, placeCatalogItem,
  placeSpecial, rotateSelection, type SpecialKind,
} from '../commands';
import { coachSeen, markCoachSeen } from '../storage';
import { Icon } from './Icons';

/* ══════════════════ the Add tray ══════════════════ */

export function AddTray() {
  const open = useEditor(s => s.trayOpen);
  const place = useEditor(s => s.place);
  const [q, setQ] = useState('');
  const match = (s: string) => !q || s.toLowerCase().includes(q.trim().toLowerCase());

  const draw = Object.entries(SPECIALS).filter(([k, v]) => match(v.name) || match(k));
  const groups = CATALOG
    .map(g => ({ group: g.group, items: g.items.filter(i => match(i.name) || match(g.group)) }))
    .filter(g => g.items.length);
  const empty = !draw.length && !groups.length;

  /* click arms the object and gets out of the way; drag drops it directly */
  const arm = (kind: string, e: React.PointerEvent) => {
    e.preventDefault();
    const s = ed();
    const next = s.place === kind ? null : kind;
    s.patch({ place: next, tool: 'select' });
    if (!next) return;

    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const mv = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 8) moved = true;
    };
    const up = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', mv);
      document.removeEventListener('pointerup', up);
      const cv = document.querySelector<HTMLCanvasElement>('#cv');
      if (!cv) return;
      const r = cv.getBoundingClientRect();
      const over = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      const cur = ed();
      if (moved && over && cur.place) {
        const wp = toWorld(cur.view, ev.clientX - r.left, ev.clientY - r.top);
        const p = snapPoint(cur.floor(), wp, { on: cur.snap, grid: cur.gridSize, view: cur.view });
        if (cur.place.startsWith('draw:')) placeSpecial(cur.place.slice(5) as SpecialKind, p, ev.shiftKey);
        else placeCatalogItem(cur.place, p, ev.shiftKey);
        if (!ev.shiftKey) ed().patch({ trayOpen: false });
      } else if (!moved) {
        ed().patch({ trayOpen: false });
      }
    };
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', up);
  };

  return (
    <div className={`tray${open ? ' open' : ''}`} id="tray">
      <div className="tray-h">
        <h3>Add to the plan</h3>
        <div className="tray-search">
          <Icon id="i-search" />
          <input
            id="traySearch" placeholder="sofa, bed, tree, wall…" spellCheck={false}
            value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setQ(''); }}
          />
        </div>
        <div className="spring" />
        <span className="hint" style={{ fontSize: 11 }}>Click an item, then click the plan</span>
        <button className="m-x" id="trayClose" onClick={() => ed().patch({ trayOpen: false })}>
          <Icon id="i-x" />
        </button>
      </div>
      <div className="tray-b" id="trayBody">
        {empty && (
          <div className="empty"><Icon id="i-search" /><p>Nothing matches that.</p></div>
        )}
        {!!draw.length && (
          <div className="tgroup draw">
            <span className="lbl">Draw &amp; annotate</span>
            <div className="tgrid">
              {draw.map(([k, v]) => (
                <button
                  key={k} className={`tile${place === `draw:${k}` ? ' on' : ''}`}
                  data-kind={`draw:${k}`} title={v.hint}
                  onPointerDown={e => arm(`draw:${k}`, e)}
                >
                  <Icon id={v.icon} />
                  <b>{v.name}</b>
                  <em>{v.hint.split('—')[0].trim().slice(0, 18)}</em>
                </button>
              ))}
            </div>
          </div>
        )}
        {groups.map(g => (
          <div className="tgroup" key={g.group}>
            <span className="lbl">{g.group}</span>
            <div className="tgrid">
              {g.items.map(c => (
                <button
                  key={c.kind} className={`tile${place === c.kind ? ' on' : ''}`}
                  data-kind={c.kind} title={`${c.name} — ${c.w}×${c.h} cm`}
                  onPointerDown={e => arm(c.kind, e)}
                >
                  <GlyphPreview kind={c.kind} />
                  <b>{c.name}</b>
                  <em>{c.w}×{c.h}</em>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** the catalogue glyph, drawn with the same code that draws it on the plan */
export function GlyphPreview({ kind, w = 124, h = 80 }: { kind: string; w?: number; h?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const c = CAT_BY_KIND[kind];
    if (!cv || !c) return;
    const d = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = w * d; cv.height = h * d;
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(d, 0, 0, d, 0, 0);
    const k = Math.min((w - 16) / c.w, (h - 14) / c.h);
    g.translate(w / 2, h / 2);
    g.scale(k, k);
    const col = toneFor(c);
    g.fillStyle = `${col}4d`;
    g.strokeStyle = col;
    g.lineWidth = 1.5 / k;
    g.lineJoin = 'round';
    try { c.draw(g, c.w, c.h, 1 / k); } catch { /* a glyph must never break the tray */ }
  }, [kind, w, h]);
  return <canvas ref={ref} width={w} height={h} data-tprev={kind} />;
}

/* ══════════════════ the toolbar that appears on the selection ══════════════════ */

export function ObjectToolbar() {
  const sel = useSelection();
  const view = useEditor(s => s.view);
  const simple = useEditor(s => s.simple);
  const dragging = useEditor(s => s.marquee);
  const place = useEditor(s => s.place);
  useEditor(s => s.rev); /* reposition after every mutation */
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);

  const show = simple && sel.length > 0 && !dragging && !place;

  useEffect(() => {
    if (!show) { setPos(null); return; }
    const el = ref.current;
    const stage = document.querySelector<HTMLElement>('#stage');
    const b = selScreenBBox(sel, view);
    if (!el || !stage || !b) { setPos(null); return; }
    const w = el.offsetWidth, h = el.offsetHeight;
    let y = b.y0 - h - 14;
    let below = false;
    if (y < 8) { y = b.y1 + 14; below = true; }
    setPos({
      x: Math.max(8, Math.min((b.x0 + b.x1) / 2 - w / 2, stage.clientWidth - w - 8)),
      y: Math.max(8, Math.min(y, stage.clientHeight - h - 8)),
      below,
    });
  }, [show, sel, view]);

  /* A freshly dropped room or note should be ready to type into. autoFocus
     alone loses the race against the canvas taking pointer capture. */
  useEffect(() => {
    if (!show) return;
    const s0 = sel[0];
    if (!s0 || sel.length !== 1) return;
    const isNew = (s0.t === 'area' && !s0.o.name) || (s0.t === 'note' && s0.o.text === 'Type here');
    if (!isNew) return;
    const t = setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>('#ctxName, #ctxNote');
      if (el) { el.focus(); el.select(); }
    }, 40);
    return () => clearTimeout(t);
  }, [show, sel]);

  if (!show) return <div className="ctx" id="ctx" ref={ref} />;

  return (
    <div
      className={`ctx show${pos?.below ? ' below' : ''}`} id="ctx" ref={ref}
      style={pos ? { left: pos.x, top: pos.y } : { visibility: 'hidden' }}
    >
      <ToolbarBody sel={sel} />
    </div>
  );
}

const CB = (id: string, icon: string, title: string, onClick: () => void, cls = '', label?: string) => (
  <button key={id} className={`cb ${cls}`} id={id} title={title} onClick={e => { e.stopPropagation(); onClick(); }}>
    <Icon id={icon} />{label ? <span>{label}</span> : null}
  </button>
);

function Swatches({ list, cur, onPick }: { list: string[]; cur?: string; onPick: (c: string) => void }) {
  return (
    <span className="swrow">
      {list.map(c => (
        <button
          key={c} className={`sw${String(cur).toLowerCase() === c.toLowerCase() ? ' on' : ''}`}
          data-cc={c} style={{ background: c }}
          onClick={e => { e.stopPropagation(); onPick(c); }}
        />
      ))}
    </span>
  );
}

function ToolbarBody({ sel }: { sel: SelObj[] }) {
  if (sel.length > 1) {
    return (
      <>
        <span className="val" style={{ color: 'var(--tx-2)' }}>{sel.length} selected</span>
        <span className="div" />
        {CB('ctxRot', 'i-rot', 'Rotate 90°', () => rotateSelection(90))}
        {CB('ctxDup', 'i-copy', 'Duplicate', duplicateSelection)}
        {CB('ctxDel', 'i-trash', 'Delete', deleteSelection, 'dgr')}
      </>
    );
  }
  const s0 = sel[0];
  if (!s0) return null;

  if (s0.t === 'item') return <ItemBar o={s0.o} />;
  if (s0.t === 'wall') return <WallBar o={s0.o} />;
  if (s0.t === 'opening') return <OpeningBar o={s0.o} wall={s0.wall} />;
  if (s0.t === 'area') return <AreaBar o={s0.o} />;
  if (s0.t === 'note') return <NoteBar o={s0.o} />;
  if (s0.t === 'line' && s0.o.arrow) {
    return (
      <>
        <Swatches
          list={['#E4632C', '#2F8C9E', '#7E9B5B', '#4A443A', '#B0554E']} cur={s0.o.color}
          onPick={c => { const s = ed(); s.pushUndo(); s0.o.color = c; s.touch(); }}
        />
        <span className="div" />
        {CB('ctxDup', 'i-copy', 'Duplicate', duplicateSelection)}
        {CB('ctxDel', 'i-trash', 'Delete', deleteSelection, 'dgr')}
      </>
    );
  }
  const L = dist(s0.o.a, s0.o.b);
  return (
    <>
      <span className="val">{L >= 100 ? `${(L / 100).toFixed(2)} m` : `${Math.round(L)} cm`}</span>
      <span className="div" />
      {CB('ctxDel', 'i-trash', 'Delete', deleteSelection, 'dgr')}
    </>
  );
}

function ItemBar({ o }: { o: Item }) {
  const c = CAT_BY_KIND[o.kind];
  return (
    <>
      <input
        className="nm" id="ctxLabel" placeholder={c?.name ?? 'label'} defaultValue={labelOf(o)}
        key={`${o.id}:${labelOf(o)}`}
        onPointerDown={e => e.stopPropagation()}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
        onChange={e => { const s = ed(); s.pushUndo(); setLabel(o, e.target.value); s.touch(); }}
      />
      <span className="div" />
      {CB('ctxRot', 'i-rot', 'Rotate 90°', () => { const s = ed(); s.pushUndo(); o.rot = ((o.rot || 0) + 90) % 360; s.touch(); })}
      {CB('ctxFlip', 'i-flip', 'Mirror', () => { const s = ed(); s.pushUndo(); o.flip = o.flip ? 0 : 1; s.touch(); })}
      <span className="div" />
      <Swatches list={SWATCHES.slice(0, 6)} cur={o.color} onPick={c2 => { const s = ed(); s.pushUndo(); o.color = c2; s.touch(); }} />
      <span className="div" />
      {CB('ctxDup', 'i-copy', 'Duplicate', duplicateSelection)}
      {CB('ctxDel', 'i-trash', 'Delete', deleteSelection, 'dgr')}
    </>
  );
}

function WallBar({ o }: { o: Wall }) {
  return (
    <>
      {CB('ctxDoor', 'i-door', 'Put a door in this wall', () => addOpeningTo(o, 'door'), 'pri', 'Door')}
      {CB('ctxWin', 'i-win', 'Put a window in this wall', () => addOpeningTo(o, 'window'), 'pri', 'Window')}
      <span className="div" />
      <span className="val">{Math.round(dist(o.a, o.b))} cm</span>
      <span className="div" />
      {CB('ctxDel', 'i-trash', 'Delete wall', deleteSelection, 'dgr')}
    </>
  );
}

function OpeningBar({ o, wall }: { o: Opening; wall: Wall }) {
  const bump = (d: number) => {
    const s = ed(); s.pushUndo();
    o.width = Math.max(20, Math.min(o.width + d, dist(wall.a, wall.b)));
    s.touch();
  };
  return (
    <>
      {CB('ctxNarrow', 'i-zout', 'Narrower', () => bump(-10))}
      <span className="val">{Math.round(o.width)} cm</span>
      {CB('ctxWiden', 'i-zin', 'Wider', () => bump(10))}
      <span className="div" />
      {CB('ctxHinge', 'i-flip', 'Swap hinge', () => { const s = ed(); s.pushUndo(); o.flip = o.flip ? 0 : 1; s.touch(); })}
      {CB('ctxSide', 'i-rot', 'Swing the other way', () => { const s = ed(); s.pushUndo(); o.side = o.side ? 0 : 1; s.touch(); })}
      <span className="div" />
      {CB('ctxDel', 'i-trash', 'Remove', deleteSelection, 'dgr')}
    </>
  );
}

function AreaBar({ o }: { o: Area }) {
  return (
    <>
      <input
        className="nm" id="ctxName" placeholder="room name" defaultValue={o.name}
        key={o.id}
        autoFocus={!o.name}
        onPointerDown={e => e.stopPropagation()}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
        onChange={e => { const s = ed(); s.pushUndo(); o.name = e.target.value; s.touch(); }}
      />
      <span className="val">{fmtM2(polyArea(o.poly))} m²</span>
      <span className="div" />
      <Swatches list={ROOM_SWATCHES.slice(0, 6)} cur={o.color} onPick={c => { const s = ed(); s.pushUndo(); o.color = c; s.touch(); }} />
      <span className="div" />
      {CB('ctxDel', 'i-trash', 'Delete room', deleteSelection, 'dgr')}
    </>
  );
}

function NoteBar({ o }: { o: Note }) {
  const size = (k: number) => { const s = ed(); s.pushUndo(); o.size = Math.max(6, Math.min((o.size || 20) * k, 260)); s.touch(); };
  return (
    <>
      <input
        className="nm" id="ctxNote" style={{ width: 170 }} defaultValue={String(o.text).replace(/\n/g, ' ')}
        key={o.id} autoFocus
        onPointerDown={e => e.stopPropagation()}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
        onChange={e => { const s = ed(); s.pushUndo(); o.text = e.target.value; s.touch(); }}
      />
      <span className="div" />
      <Swatches
        list={['#E4632C', '#2F8C9E', '#7E9B5B', '#4A443A', '#B0554E']} cur={o.color}
        onPick={c => { const s = ed(); s.pushUndo(); o.color = c; s.touch(); }}
      />
      <span className="div" />
      {CB('ctxBig', 'i-zin', 'Bigger', () => size(1.25))}
      {CB('ctxSmall', 'i-zout', 'Smaller', () => size(1 / 1.25))}
      {CB('ctxDel', 'i-trash', 'Delete', deleteSelection, 'dgr')}
    </>
  );
}

/* ══════════════════ stage furniture ══════════════════ */

export function StageOverlays({ onFit }: { onFit: () => void }) {
  const { grid, snap, showRef, ghost, view, tool, place } = useEditorShallow(s => ({
    grid: s.grid, snap: s.snap, showRef: s.showRef, ghost: s.ghost,
    view: s.view, tool: s.tool, place: s.place,
  }));
  const zoomBy = (f: number) => {
    const cv = document.querySelector<HTMLCanvasElement>('#cv');
    if (!cv) return;
    const s = ed();
    const cx = cv.clientWidth / 2, cy = cv.clientHeight / 2;
    const w = toWorld(s.view, cx, cy);
    const zoom = Math.max(0.02, Math.min(s.view.zoom * f, 12));
    s.setView({ zoom, px: cx - w.x * zoom, py: cy - w.y * zoom });
  };

  const TIPS: Record<string, React.ReactNode> = {
    wall: <>Click to lay wall segments · <kbd>double-click</kbd> or <kbd>↵</kbd> to finish · <kbd>alt</kbd> free angle · <kbd>esc</kbd> cancel</>,
    room: <>Click room corners · click the first point again or <kbd>↵</kbd> to close</>,
    door: <>Click on a wall to drop a door · <kbd>shift</kbd>-click to keep placing</>,
    window: <>Click on a wall to drop a window · <kbd>shift</kbd>-click to keep placing</>,
    text: <>Click to drop a text note</>,
    measure: <>Click two points to add a permanent dimension line</>,
    pan: <>Drag to pan · or hold <kbd>space</kbd> with any tool</>,
  };
  const placed = place && !place.startsWith('draw:') ? CAT_BY_KIND[place] : null;
  const special = place?.startsWith('draw:') ? SPECIALS[place.slice(5) as SpecialKind] : null;

  return (
    <>
      <div className="floating tl">
        <button className={`fb${grid ? ' on' : ''}`} id="tgGrid" title="Grid  (G)" onClick={() => ed().patch({ grid: !grid })}><Icon id="i-grid" /></button>
        <button className={`fb${snap ? ' on' : ''}`} id="tgSnap" title="Snapping  (S)" onClick={() => ed().patch({ snap: !snap })}><Icon id="i-magnet" /></button>
        <button
          className={`fb${showRef ? ' on' : ''}`} id="tgRef" title="Funda reference image  (B)"
          onClick={() => {
            const s = ed();
            if (!s.floor()?.ref) { s.toast('This floor has no reference image. Drop an image file on the canvas.', 'err'); return; }
            s.patch({ showRef: !s.showRef });
          }}
        ><Icon id="i-img" /></button>
        <button className={`fb${ghost ? ' on' : ''}`} id="tgGhost" title="Ghost floor below  (L)" onClick={() => ed().patch({ ghost: !ghost })}><Icon id="i-layer" /></button>
      </div>

      <div className="floating tr">
        <button className="fb" id="zOut" title="Zoom out" onClick={() => zoomBy(0.8)}><Icon id="i-zout" /></button>
        <span className="zoomval" id="zoomVal">{Math.round(view.zoom * 100)}%</span>
        <button className="fb" id="zIn" title="Zoom in" onClick={() => zoomBy(1.25)}><Icon id="i-zin" /></button>
        <button className="fb" id="zFit" title="Fit to view  (0)" onClick={onFit}><Icon id="i-fit" /></button>
      </div>

      <div id="tipHost">
        {placed && (
          <div className="tool-tip">
            Click the plan to place <b>{placed.name}</b> ({placed.w}×{placed.h} cm) · <kbd>shift</kbd> for several · <kbd>esc</kbd> cancel
          </div>
        )}
        {special && (
          <div className="tool-tip">Click the plan to place <b>{special.name}</b> · <kbd>esc</kbd> cancel</div>
        )}
        {!place && TIPS[tool] && <div className="tool-tip">{TIPS[tool]}</div>}
      </div>
      <Coach />
    </>
  );
}

function Coach() {
  const [gone, setGone] = useState(true);
  const simple = useEditor(s => s.simple);
  useEffect(() => { setGone(coachSeen()); }, []);
  if (gone || !simple) return null;
  return (
    <div className="coach" id="coach">
      <b>Drag anything</b> on the plan to move it · click it for <b>rotate, colour, delete</b>
      {' '}· <b>⊕ Add</b> for furniture, walls, notes · <kbd>⌘Z</kbd> undo
      <button id="coachX" title="Got it" onClick={() => { markCoachSeen(); setGone(true); }}>
        <Icon id="i-x" style={{ width: 13, height: 13 }} />
      </button>
    </div>
  );
}
