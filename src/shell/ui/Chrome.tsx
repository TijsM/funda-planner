'use client';

import { ed, useEditor, useEditorShallow } from '@state/store';
import type { Tool } from '@state/store';
import { fmtM2, polyArea } from '@engine/geometry';
import { floorArea } from '@engine/model';
import { exportJson, exportPng } from '../files';
import { saveProject, readIndex, writeMode } from '../storage';
import { addFloor, deleteSelection, removeFloor } from '../commands';
import { Icon } from './Icons';

export function TopBar() {
  const { project, simple, dirty } = useEditorShallow(s => ({ project: s.project, simple: s.simple, dirty: s.dirty }));
  const src = project?.source;

  const setMode = (v: boolean) => { writeMode(v); ed().patch({ simple: v, tool: 'select', trayOpen: false }); };

  return (
    <header className="topbar">
      <div className="brand"><b>PLATTE<em>GROND</em></b><span>STUDIO</span></div>
      <input
        id="projName" spellCheck={false} title="Project name"
        value={project?.name ?? ''}
        onChange={e => { const s = ed(); if (s.project) { s.project.name = e.target.value; s.touch(); } }}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      {src?.url
        ? <a id="addrTag" href={src.url} target="_blank" rel="noreferrer noopener" title={src.address ?? src.url}>↗ funda listing</a>
        : src?.address ? <span id="addrTag">{src.address}</span> : null}
      <div className="spring" />

      {simple && (
        <>
          <button className="bigb" id="btnUndo2" title="Undo  (⌘Z)" onClick={() => ed().undoStep()}><Icon id="i-undo" /></button>
          <button className="bigb" id="btnRedo2" title="Redo  (⇧⌘Z)" onClick={() => ed().redoStep()}><Icon id="i-redo" /></button>
          <div className="sep" />
        </>
      )}

      <button className="btn pri" id="btnImport" onClick={() => ed().patch({ modal: 'import' })}>
        <Icon id="i-link" />Import from Funda
      </button>
      <div className="sep" />
      <button className="btn" id="btnSave" onClick={() => saveProject()}><Icon id="i-save" />Save</button>
      <button className="btn" id="btnLib" onClick={() => ed().patch({ modal: 'library' })}>
        <Icon id="i-folder" />Library <b className="mono" id="libCount" style={{ color: 'var(--tx-3)', fontWeight: 500 }}>
          {readIndex().length ? `· ${readIndex().length}` : ''}
        </b>
      </button>
      <div className="sep" />
      {!simple && (
        <>
          <button className="btn ghost" id="btnExpJson" title="Export project as .json"
            onClick={() => project && exportJson(project)}><Icon id="i-dl" />JSON</button>
          <button className="btn ghost" id="btnImpJson" title="Import a .json project"
            onClick={() => document.querySelector<HTMLInputElement>('#fileJson')?.click()}><Icon id="i-ul" /></button>
        </>
      )}
      <button className="btn ghost" id="btnExpPng" title="Export current floor as PNG" onClick={exportPng}>
        <Icon id="i-img" />PNG
      </button>
      <button className="btn" id="btnAI" title="Export a prompt + reference image for an image generator"
        onClick={() => ed().patch({ modal: 'render' })}><Icon id="i-spark" />Render</button>
      <div className="sep" />
      <div className="modesw">
        <button id="mSimple" className={simple ? 'on' : ''} title="Meeting mode — big canvas, one Add tray, no panels"
          onClick={() => setMode(true)}>Simple</button>
        <button id="mPro" className={!simple ? 'on' : ''} title="Full editor — tool rail, inspector, numeric fields"
          onClick={() => setMode(false)}>Pro</button>
      </div>
      <span hidden data-dirty={dirty ? '1' : '0'} />
    </header>
  );
}

const TOOLS: { t: Tool; icon: string; key: string; title: string }[] = [
  { t: 'select', icon: 'i-sel', key: 'V', title: 'Select / move  (V)' },
  { t: 'pan', icon: 'i-hand', key: 'H', title: 'Pan  (H)  ·  or hold Space' },
  { t: 'wall', icon: 'i-wall', key: 'W', title: 'Draw walls  (W)' },
  { t: 'room', icon: 'i-room', key: 'R', title: 'Draw room area  (R)' },
  { t: 'door', icon: 'i-door', key: 'D', title: 'Place door on a wall  (D)' },
  { t: 'window', icon: 'i-win', key: 'N', title: 'Place window on a wall  (N)' },
  { t: 'text', icon: 'i-text', key: 'T', title: 'Text note  (T)' },
  { t: 'measure', icon: 'i-meas', key: 'M', title: 'Measure  (M)' },
];

export function ToolRail() {
  const tool = useEditor(s => s.tool);
  return (
    <nav className="toolrail" id="toolrail">
      {TOOLS.map((x, i) => (
        <span key={x.t} style={{ display: 'contents' }}>
          {(i === 2 || i === 6) && <div className="rail-sep" />}
          <button
            className={`tool${tool === x.t ? ' on' : ''}`} data-tool={x.t} title={x.title}
            onClick={() => ed().patch({ tool: x.t, place: null, draft: null })}
          >
            <Icon id={x.icon} /><i>{x.key}</i>
          </button>
        </span>
      ))}
      <div className="rail-sep" />
      <button className="tool" id="btnUndo" title="Undo  (⌘Z)" onClick={() => ed().undoStep()}><Icon id="i-undo" /></button>
      <button className="tool" id="btnRedo" title="Redo  (⇧⌘Z)" onClick={() => ed().redoStep()}><Icon id="i-redo" /></button>
      <button className="tool" id="btnDel" title="Delete selection  (⌫)" onClick={deleteSelection}><Icon id="i-trash" /></button>
    </nav>
  );
}

export function FloorBar({ onFit }: { onFit: () => void }) {
  const { project, floorIndex, dims, trayOpen } = useEditorShallow(s => ({
    project: s.project, floorIndex: s.floorIndex, dims: s.layers.dims, trayOpen: s.trayOpen,
  }));
  useEditor(s => s.rev);
  return (
    <footer className="floorbar" id="floorbar">
      <div className="fchips" id="fchips">
        {project?.floors.map((f, i) => {
          const A = floorArea(f);
          return (
            <button
              key={f.id} className={`fchip${i === floorIndex ? ' on' : ''}`} data-i={i}
              onClick={() => { ed().setFloorIndex(i); onFit(); }}
            >
              {f.name}{A ? <small>{fmtM2(A)} m²</small> : null}
            </button>
          );
        })}
      </div>
      <button
        className={`fbtn${dims ? ' on' : ''}`} id="fDims" title="Show / hide the dimension lines from the listing"
        onClick={() => { const s = ed(); s.patch({ layers: { ...s.layers, dims: !s.layers.dims } }); }}
      ><Icon id="i-meas" />Dims</button>
      <button className="fbtn" id="fFit" title="Fit the plan to the screen  (0)" onClick={onFit}><Icon id="i-fit" />Fit</button>
      <button
        className={`fbtn add${trayOpen ? ' on' : ''}`} id="fAdd"
        onClick={() => ed().patch({ trayOpen: !trayOpen })}
      ><Icon id="i-plus" />Add</button>
    </footer>
  );
}

export function StatusBar() {
  const { sel, gridSize, dirty, savedId, mouseWorld, mouseInside, view } = useEditorShallow(s => ({
    sel: s.sel, gridSize: s.gridSize, dirty: s.dirty, savedId: s.savedId,
    mouseWorld: s.mouseWorld, mouseInside: s.mouseInside, view: s.view,
  }));
  return (
    <footer className="statusbar">
      <div className="st">
        <i id="stDot" style={{ background: dirty ? 'var(--brass)' : 'var(--moss)' }} />
        <b id="stMsg">Ready</b>
      </div>
      <div className="st">X <b id="stX">{mouseInside ? Math.round(mouseWorld.x) : '—'}</b> · Y <b id="stY">{mouseInside ? Math.round(mouseWorld.y) : '—'}</b></div>
      <div className="st">Grid <b id="stGrid">{gridSize} cm</b></div>
      <div className="st" id="stSelWrap" hidden={!sel.length}>Sel <b id="stSel">{sel.length}</b></div>
      <div className="st last">
        Zoom {Math.round(view.zoom * 100)}% · Units cm ·{' '}
        <b id="stSaved">{dirty ? 'unsaved changes' : savedId ? 'saved' : 'not saved'}</b>
      </div>
    </footer>
  );
}

export function FloorList() {
  const { project, floorIndex } = useEditorShallow(s => ({ project: s.project, floorIndex: s.floorIndex }));
  useEditor(s => s.rev);
  return (
    <section className="sec">
      <div className="sec-h">
        <span className="dot" /><span className="lbl">Floors</span>
        <button className="btn sm" id="btnAddFloor" onClick={addFloor}><Icon id="i-plus" />Add</button>
      </div>
      <div className="sec-b" id="floorList" style={{ padding: 6 }}>
        {project?.floors.map((f, i) => {
          const A = f.areas.reduce((s, a) => s + polyArea(a.poly), 0);
          return (
            <div
              key={f.id} className={`floor${i === floorIndex ? ' on' : ''}`} data-i={i}
              onClick={() => ed().setFloorIndex(i)}
            >
              <span className="lv">{f.level}</span>
              <span
                className="nm" title="double-click to rename"
                onDoubleClick={() => {
                  const n = prompt('Floor name', f.name);
                  if (n != null) { const s = ed(); s.pushUndo(); f.name = n.trim() || f.name; s.touch(); }
                }}
              >{f.name}</span>
              <span className="ar">{A ? `${fmtM2(A)} m²` : ''}</span>
              <button
                className="x" data-del={i} title="Delete floor"
                onClick={e => {
                  e.stopPropagation();
                  if (confirm(`Delete floor “${f.name}” and everything on it?`)) removeFloor(i);
                }}
              ><Icon id="i-x" style={{ width: 12, height: 12 }} /></button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Totals() {
  const project = useEditor(s => s.project);
  const floor = useEditor(s => s.floor());
  useEditor(s => s.rev);
  if (!project || !floor) return <div className="sec-b" id="totals" />;

  let total = 0, rooms = 0, furn = 0;
  project.floors.forEach(f => {
    f.areas.forEach(a => { total += polyArea(a.poly); if (a.name) rooms++; });
    furn += f.items.filter(i => !i.fromFunda).length;
  });
  const line = (k: string, v: string | number, c?: string) => (
    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11 }}>
      <span style={{ color: 'var(--tx-3)' }}>{k}</span>
      <span className="mono" style={{ color: c ?? 'var(--tx)', fontWeight: 500 }}>{v}</span>
    </div>
  );
  return (
    <div className="sec-b" id="totals" style={{ paddingTop: 8 }}>
      {line('This floor', `${fmtM2(floorArea(floor))} m²`, 'var(--cyan)')}
      {line('All floors', `${fmtM2(total)} m²`, 'var(--cyan)')}
      {line('Named rooms', rooms)}
      {line('Walls · this floor', floor.walls.length)}
      {line('Openings', floor.walls.reduce((s, w) => s + w.openings.length, 0))}
      {line('Furniture placed', furn, 'var(--brass)')}
    </div>
  );
}
