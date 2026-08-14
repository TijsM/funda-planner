'use client';

import { useState } from 'react';
import { ed, useEditor, useEditorShallow, useSelection } from '@state/store';
import { CAT_BY_KIND, ROOM_SWATCHES, SWATCHES } from '@engine/catalog';
import { dist, fmtM2, polyArea, R2, unitNormal, uid } from '@engine/geometry';
import { contentBBox, labelOf, setDesc, setLabel } from '@engine/model';
import type { Area, Dim, Item, Line, Note, Opening, Wall } from '@engine/types';
import { deleteSelection, duplicateSelection, rotateSelection } from '../commands';
import { Icon } from './Icons';

/** Numeric field that writes straight into the document. Applies on every
 *  keystroke; the panel is never rebuilt underneath the caret, which is what
 *  used to swallow an edit when tabbing between fields. */
function Num({
  id, value, onChange, pre, unit, step = 1, width,
}: {
  id: string; value: number; onChange: (v: number) => void;
  pre?: string; unit?: string; step?: number; width?: number;
}) {
  const [local, setLocal] = useState<string | null>(null);
  return (
    <div className="fld" style={width ? { maxWidth: width } : undefined}>
      {pre && <span>{pre}</span>}
      <input
        id={id} type="number" step={step}
        value={local ?? R2(value)}
        onChange={e => {
          setLocal(e.target.value);
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        onBlur={() => setLocal(null)}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      {unit && <u>{unit}</u>}
    </div>
  );
}

function Text({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="fld wide">
      <input
        id={id} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
    </div>
  );
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="row"><span className="lbl">{label}</span><div className="fields">{children}</div></div>
);

/** Free text that feeds the image-generator prompt. Empty by default, and
 *  emptying it removes the field again rather than storing "". */
function Desc({ id, o }: { id: string; o: Item | Area }) {
  const write = (v: string) => { const s = ed(); s.pushUndo(); setDesc(o, v); s.touch(); };
  /* stacked, not in the 58px label column — "Description" does not fit there,
     and free text deserves the full panel width */
  return (
    <div style={{ marginBottom: 11 }}>
      <span className="lbl" style={{ display: 'block', marginBottom: 5 }}>Description</span>
      <textarea
        className="src" id={id}
        style={{ width: '100%', height: 62, fontFamily: 'var(--sans)', fontSize: 12 }}
        placeholder="dark green velvet, mid-century, low back…"
        value={o.desc ?? ''}
        onChange={e => write(e.target.value)}
        onKeyDown={e => e.stopPropagation()}
      />
      <div className="hint" style={{ marginTop: 4 }}>Goes into the render prompt.</div>
    </div>
  );
}

function Swatches({ list, cur, onPick }: { list: string[]; cur?: string; onPick: (c: string) => void }) {
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <span className="lbl" style={{ marginTop: 3 }}>Colour</span>
      <div className="swatches">
        {list.map(c => (
          <button key={c} className={`sw${String(cur).toLowerCase() === c.toLowerCase() ? ' on' : ''}`}
            data-c={c} style={{ background: c }} onClick={() => onPick(c)} />
        ))}
      </div>
    </div>
  );
}

const Actions = ({ dup = true }: { dup?: boolean }) => (
  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
    {dup && <button className="btn sm" id="oDup" onClick={duplicateSelection}><Icon id="i-copy" />Duplicate</button>}
    <button className="btn sm dgr" id="oDel" onClick={deleteSelection}><Icon id="i-trash" />Delete</button>
  </div>
);

export function Inspector() {
  const sel = useSelection();
  const project = useEditor(s => s.project);
  useEditor(s => s.rev);
  const write = <T,>(fn: () => T) => { const s = ed(); s.pushUndo(); fn(); s.touch(); };

  if (!project) {
    return (
      <div className="sec-b" id="inspector">
        <div className="empty"><Icon id="i-house" /><p>Import a Funda listing or start a blank plan.</p></div>
      </div>
    );
  }
  if (!sel.length) return <div className="sec-b" id="inspector"><FloorInspector /></div>;

  if (sel.length > 1) {
    const counts: Record<string, number> = {};
    sel.forEach(s => { counts[s.t] = (counts[s.t] || 0) + 1; });
    return (
      <div className="sec-b" id="inspector">
        <div className="hint" style={{ marginBottom: 12 }}>
          <b>{sel.length} objects</b> — {Object.entries(counts).map(([k, v]) => `${v}× ${k}`).join(', ')}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn sm" id="mDup" onClick={duplicateSelection}><Icon id="i-copy" />Duplicate</button>
          <button className="btn sm" id="mRot" onClick={() => rotateSelection(90)}><Icon id="i-rot" />Rotate 90°</button>
          <button className="btn sm dgr" id="mDel" onClick={deleteSelection}><Icon id="i-trash" />Delete</button>
        </div>
        <div className="hint" style={{ marginTop: 11 }}>Drag to move them together. Arrow keys nudge.</div>
      </div>
    );
  }

  const s0 = sel[0];
  return (
    <div className="sec-b" id="inspector">
      {s0.t === 'item' && <ItemInspector o={s0.o} write={write} />}
      {s0.t === 'wall' && <WallInspector o={s0.o} write={write} />}
      {s0.t === 'opening' && <OpeningInspector o={s0.o} wall={s0.wall} write={write} />}
      {s0.t === 'area' && <AreaInspector o={s0.o} write={write} />}
      {s0.t === 'note' && <NoteInspector o={s0.o} write={write} />}
      {(s0.t === 'dim' || s0.t === 'line') && <SegInspector o={s0.o} kind={s0.t} write={write} />}
    </div>
  );
}

type Write = <T>(fn: () => T) => void;

function ItemInspector({ o, write }: { o: Item; write: Write }) {
  const c = CAT_BY_KIND[o.kind];
  return (
    <>
      <Row label="Label">
        <Text id="inLabel" value={labelOf(o)} placeholder={c?.name ?? 'Fitted fixture'}
          onChange={v => write(() => setLabel(o, v))} />
      </Row>
      {o.fromFunda && (
        <div className="hint" style={{ margin: '-2px 0 9px' }}>
          Fitted object imported from the listing — kitchen unit, sanitary ware, stairs. Rename it, or
          delete and replace with a catalogue item.
        </div>
      )}
      <Desc id="inDesc" o={o} />
      <Row label="Position">
        <Num id="inX" pre="X" unit="cm" value={o.x} onChange={v => write(() => { o.x = v; })} />
        <Num id="inY" pre="Y" unit="cm" value={o.y} onChange={v => write(() => { o.y = v; })} />
      </Row>
      <Row label="Size">
        <Num id="inW" pre="W" unit="cm" value={o.w} onChange={v => write(() => { o.w = Math.max(2, v); })} />
        <Num id="inH" pre="H" unit="cm" value={o.h} onChange={v => write(() => { o.h = Math.max(2, v); })} />
      </Row>
      <Row label="Rotation">
        <Num id="inR" pre="∠" unit="°" step={5} value={o.rot || 0}
          onChange={v => write(() => { o.rot = R2(((v % 360) + 360) % 360); })} />
      </Row>
      <div className="row">
        <span className="lbl">Footprint</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--tx-2)' }}>{fmtM2(o.w * o.h)} m²</span>
      </div>
      <Swatches list={SWATCHES} cur={o.color} onPick={v => write(() => { o.color = v; })} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
        <button className="btn sm" id="oR90" onClick={() => write(() => { o.rot = R2(((o.rot || 0) + 90) % 360); })}><Icon id="i-rot" />90°</button>
        <button className="btn sm" id="oFlip" onClick={() => write(() => { o.flip = o.flip ? 0 : 1; })}><Icon id="i-flip" />Mirror</button>
        {c && <button className="btn sm" id="oReset" onClick={() => write(() => { o.w = c.w; o.h = c.h; })}>Reset size</button>}
      </div>
      <Actions />
    </>
  );
}

function WallInspector({ o, write }: { o: Wall; write: Write }) {
  const L = dist(o.a, o.b);
  const ang = ((Math.atan2(o.b.y - o.a.y, o.b.x - o.a.x) * 180) / Math.PI + 360) % 360;
  return (
    <>
      <Row label="Length">
        <Num id="inWL" unit="cm" value={L} onChange={v => write(() => {
          const u = unitNormal(o.a, o.b);
          o.b.x = R2(o.a.x + u.ux * v); o.b.y = R2(o.a.y + u.uy * v);
        })} />
      </Row>
      <Row label="Angle">
        <Num id="inWA" pre="∠" unit="°" value={ang} onChange={v => write(() => {
          const L2 = dist(o.a, o.b), r = (v * Math.PI) / 180;
          o.b.x = R2(o.a.x + Math.cos(r) * L2); o.b.y = R2(o.a.y + Math.sin(r) * L2);
        })} />
      </Row>
      <Row label="Thickness">
        <Num id="inWT" unit="cm" value={o.t} onChange={v => write(() => { o.t = Math.max(1, Math.min(v, 200)); })} />
      </Row>
      <Row label="Start">
        <Num id="inWAX" pre="X" value={o.a.x} onChange={v => write(() => { o.a.x = v; })} />
        <Num id="inWAY" pre="Y" value={o.a.y} onChange={v => write(() => { o.a.y = v; })} />
      </Row>
      <Row label="End">
        <Num id="inWBX" pre="X" value={o.b.x} onChange={v => write(() => { o.b.x = v; })} />
        <Num id="inWBY" pre="Y" value={o.b.y} onChange={v => write(() => { o.b.y = v; })} />
      </Row>
      <div className="hint" style={{ marginTop: 8 }}>
        {o.openings.length} opening(s) on this wall. Use the door/window tool to add more.
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
        <button className="btn sm" id="wSplit" onClick={() => write(() => {
          const f = ed().floor(); if (!f) return;
          const m = { x: R2((o.a.x + o.b.x) / 2), y: R2((o.a.y + o.b.y) / 2) };
          f.walls.push({ id: uid(), a: m, b: { ...o.b }, t: o.t, openings: [] });
          o.b = { ...m };
        })}>Split in half</button>
      </div>
      <Actions />
    </>
  );
}

function OpeningInspector({ o, wall, write }: { o: Opening; wall: Wall; write: Write }) {
  const L = dist(wall.a, wall.b);
  return (
    <>
      <div className="row">
        <span className="lbl">Type</span>
        <div className="fields" style={{ gap: 5 }}>
          <button className="btn sm" id="opDoor" style={o.type === 'door' ? { borderColor: 'var(--vermilion)', color: '#fff' } : undefined}
            onClick={() => write(() => { o.type = 'door'; })}>Door</button>
          <button className="btn sm" id="opWin" style={o.type === 'window' ? { borderColor: 'var(--vermilion)', color: '#fff' } : undefined}
            onClick={() => write(() => { o.type = 'window'; })}>Window</button>
        </div>
      </div>
      <Row label="Width">
        <Num id="inOW" unit="cm" value={o.width} onChange={v => write(() => { o.width = Math.max(10, Math.min(v, L)); })} />
      </Row>
      <Row label="Offset">
        <Num id="inOO" unit="cm" value={o.at * L} onChange={v => write(() => { o.at = Math.max(0, Math.min(v / L, 1)); })} />
      </Row>
      <div className="hint">Measured from the wall start · wall is {Math.round(L)} cm.</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        <button className="btn sm" id="opHinge" onClick={() => write(() => { o.flip = o.flip ? 0 : 1; })}><Icon id="i-flip" />Swap hinge</button>
        <button className="btn sm" id="opSide" onClick={() => write(() => { o.side = o.side ? 0 : 1; })}><Icon id="i-rot" />Swing side</button>
      </div>
      <Actions dup={false} />
    </>
  );
}

function AreaInspector({ o, write }: { o: Area; write: Write }) {
  return (
    <>
      <Row label="Room"><Text id="inAreaName" value={o.name} placeholder="unnamed" onChange={v => write(() => { o.name = v; })} /></Row>
      <Desc id="inAreaDesc" o={o} />
      <div className="row">
        <span className="lbl">Area</span>
        <span className="mono" style={{ fontSize: 13, color: 'var(--cyan)' }}>{fmtM2(polyArea(o.poly))} m²</span>
      </div>
      <div className="row">
        <span className="lbl">Corners</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--tx-2)' }}>{o.poly.length}</span>
      </div>
      <Swatches list={ROOM_SWATCHES} cur={o.color} onPick={v => write(() => { o.color = v; })} />
      <Row label="Label off.">
        <Num id="inANX" pre="X" value={o.nx || 0} onChange={v => write(() => { o.nx = v; })} />
        <Num id="inANY" pre="Y" value={o.ny || 0} onChange={v => write(() => { o.ny = v; })} />
      </Row>
      <label className="tg" style={{ marginTop: 4 }}>
        <input type="checkbox" id="inALbl" checked={o.label !== false} onChange={e => write(() => { o.label = e.target.checked; })} />
        <span className="sw2" /><span>Show label</span>
      </label>
      <div className="hint" style={{ marginTop: 8 }}>
        Drag the square handles to reshape. Double-click an edge to add a corner.
      </div>
      <Actions />
    </>
  );
}

function NoteInspector({ o, write }: { o: Note; write: Write }) {
  return (
    <>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <span className="lbl" style={{ marginTop: 4 }}>Text</span>
        <textarea
          className="src" id="inNoteText" style={{ height: 76, fontFamily: 'var(--sans)', fontSize: 12 }}
          value={o.text}
          onChange={e => write(() => { o.text = e.target.value; })}
          onKeyDown={e => e.stopPropagation()}
        />
      </div>
      <Row label="Position">
        <Num id="inNX" pre="X" value={o.x} onChange={v => write(() => { o.x = v; })} />
        <Num id="inNY" pre="Y" value={o.y} onChange={v => write(() => { o.y = v; })} />
      </Row>
      <Row label="Size">
        <Num id="inNS" unit="cm" value={o.size || 20} onChange={v => write(() => { o.size = Math.max(4, Math.min(v, 200)); })} />
      </Row>
      <Row label="Rotation">
        <Num id="inNR" pre="∠" unit="°" step={15} value={o.rot || 0} onChange={v => write(() => { o.rot = R2(v % 360); })} />
      </Row>
      <Swatches list={['#4A443A', '#E4632C', '#2F8C9E', '#7E9B5B', '#B0554E', '#8C857A']} cur={o.color}
        onPick={v => write(() => { o.color = v; })} />
      <Actions />
    </>
  );
}

function SegInspector({ o, kind, write }: { o: Dim | Line; kind: 'dim' | 'line'; write: Write }) {
  const L = dist(o.a, o.b);
  return (
    <>
      <div className="row">
        <span className="lbl">{kind === 'dim' ? 'Dimension' : 'Line'}</span>
        <span className="mono" style={{ fontSize: 13, color: 'var(--cyan)' }}>
          {L >= 100 ? `${(L / 100).toFixed(2)} m` : `${Math.round(L)} cm`}
        </span>
      </div>
      <Row label="Start">
        <Num id="inDAX" pre="X" value={o.a.x} onChange={v => write(() => { o.a.x = v; })} />
        <Num id="inDAY" pre="Y" value={o.a.y} onChange={v => write(() => { o.a.y = v; })} />
      </Row>
      <Row label="End">
        <Num id="inDBX" pre="X" value={o.b.x} onChange={v => write(() => { o.b.x = v; })} />
        <Num id="inDBY" pre="Y" value={o.b.y} onChange={v => write(() => { o.b.y = v; })} />
      </Row>
      <Actions />
    </>
  );
}

function FloorInspector() {
  const floor = useEditor(s => s.floor());
  const showRef = useEditor(s => s.showRef);
  useEditor(s => s.rev);
  const write = (fn: () => void) => { const s = ed(); s.pushUndo(); fn(); s.touch(); };
  if (!floor) return null;

  return (
    <>
      <div className="hint" style={{ marginBottom: 11 }}>
        <b>Nothing selected.</b> Click an object, or drag a box to select several.
      </div>
      <div className="sec-h" style={{ margin: '0 -11px 10px', position: 'static' }}>
        <span className="lbl">Floor · {floor.name}</span>
      </div>
      <Row label="Level"><Num id="inFlLevel" value={floor.level} onChange={v => write(() => { floor.level = Math.round(v); })} /></Row>
      <Row label="Name"><Text id="inFlName" value={floor.name} onChange={v => write(() => { floor.name = v; })} /></Row>

      <div className="sec-h" style={{ margin: '14px -11px 10px', position: 'static' }}>
        <span className="lbl">Reference image</span>
      </div>
      {floor.ref ? (
        <>
          <Row label="Position">
            <Num id="inRefX" pre="X" unit="cm" value={floor.ref.x} onChange={v => write(() => { floor.ref!.x = v; })} />
            <Num id="inRefY" pre="Y" unit="cm" value={floor.ref.y} onChange={v => write(() => { floor.ref!.y = v; })} />
          </Row>
          <Row label="Size">
            <Num id="inRefW" pre="W" unit="cm" value={floor.ref.w} onChange={v => write(() => {
              const ar = floor.ref!.h / floor.ref!.w; floor.ref!.w = Math.max(10, v); floor.ref!.h = floor.ref!.w * ar;
            })} />
            <Num id="inRefH" pre="H" unit="cm" value={floor.ref.h} onChange={v => write(() => {
              const ar = floor.ref!.w / floor.ref!.h; floor.ref!.h = Math.max(10, v); floor.ref!.w = floor.ref!.h * ar;
            })} />
          </Row>
          <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
            <button className="btn sm" id="btnCal" onClick={() => ed().patch({ modal: 'calibrate', calibrating: true, showRef: true, draft: { kind: 'cal' } })}>
              <Icon id="i-meas" />Calibrate scale
            </button>
            <button className="btn sm" id="btnRefFit" onClick={() => write(() => {
              const b = contentBBox({ ...floor, ref: null });
              if (!b || !floor.ref) return;
              const ar = floor.ref.h / floor.ref.w || 1;
              const w = (b.x1 - b.x0) * 1.02;
              floor.ref.x = b.x0 - (w - (b.x1 - b.x0)) / 2;
              floor.ref.w = w; floor.ref.h = w * ar;
              floor.ref.y = (b.y0 + b.y1) / 2 - floor.ref.h / 2;
            })}>Fit to plan</button>
            <button className="btn sm dgr" id="btnRefDel" onClick={() => write(() => { floor.ref = null; })}>Remove</button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Toggle it with the <b>image</b> button top-left of the canvas{showRef ? ' (on)' : ''}.
          </div>
        </>
      ) : (
        <div className="hint">No reference bitmap on this floor. Drop an image file onto the canvas to add one.</div>
      )}

      <div className="sec-h" style={{ margin: '14px -11px 10px', position: 'static' }}><span className="lbl">Shortcuts</span></div>
      <div className="hint" style={{ lineHeight: 1.75 }}>
        <b>V/H/W/R/D/N/T/M</b> tools · <b>G</b> grid · <b>S</b> snap · <b>B</b> reference · <b>L</b> ghost<br />
        <b>⌘D</b> duplicate · <b>⌫</b> delete · <b>⌘Z</b> undo · <b>0</b> fit · <b>⌘S</b> save<br />
        <b>space</b>+drag pan · <b>wheel</b> zoom · <b>arrows</b> nudge (⇧ = 10×)
      </div>
    </>
  );
}

export function ViewPanel() {
  const { layers, refOpacity } = useEditorShallow(s => ({ layers: s.layers, refOpacity: s.refOpacity }));
  const set = (k: keyof typeof layers, v: boolean) => ed().patch({ layers: { ...layers, [k]: v } });
  const rows: [keyof typeof layers, string, string][] = [
    ['rooms', 'vRooms', 'Room fills & names'],
    ['areas', 'vAreas', 'Area in m²'],
    ['furn', 'vFurn', 'Furniture'],
    ['dims', 'vDims', 'Dimension lines'],
    ['notes', 'vNotes', 'Text notes'],
  ];
  return (
    <div className="sec-b">
      {rows.map(([k, id, label]) => (
        <label className="tg" key={id}>
          <input type="checkbox" id={id} checked={layers[k]} onChange={e => set(k, e.target.checked)} />
          <span className="sw2" /><span>{label}</span>
        </label>
      ))}
      <div className="row" style={{ margin: '11px 0 3px' }}>
        <span className="lbl">Ref. fade</span>
        <input type="range" id="refOp" min={0} max={100} value={Math.round(refOpacity * 100)}
          onChange={e => ed().patch({ refOpacity: +e.target.value / 100 })} />
        <span className="mono" id="refOpV" style={{ fontSize: 10, color: 'var(--tx-3)', width: 30, textAlign: 'right' }}>
          {Math.round(refOpacity * 100)}%
        </span>
      </div>
    </div>
  );
}
