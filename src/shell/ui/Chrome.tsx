'use client';

import { useEffect, useState } from 'react';
import { ed, useEditor, useEditorShallow } from '@state/store';
import type { Tool } from '@state/store';
import { fmtM2, polyArea } from '@engine/geometry';
import { floorArea } from '@engine/model';
import { exportJson, exportPng } from '../files';
import { saveProject, readIndex, writeRendersBar } from '../storage';
import { addFloor, deleteSelection, removeFloor } from '../commands';
import { Icon } from './Icons';

export function TopBar() {
  const { project, dirty, rendersOpen, savedId, modal } = useEditorShallow(s => ({
    project: s.project, dirty: s.dirty, rendersOpen: s.rendersOpen,
    savedId: s.savedId, modal: s.modal,
  }));
  const src = project?.source;

  /* After mount, never during render. readIndex() reaches into localStorage,
     which the server does not have — so the server sent "" and the client drew
     "· 2", and React threw a hydration mismatch onto the console for any
     browser whose library was not empty. Re-read when a save lands or the
     library modal closes, which is all that can change the count. */
  const [saved, setSaved] = useState(0);
  useEffect(() => { setSaved(readIndex().length); }, [savedId, modal, dirty]);

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

      <button className="bigb" id="btnUndo2" title="Undo  (⌘Z)" onClick={() => ed().undoStep()}><Icon id="i-undo" /></button>
      <button className="bigb" id="btnRedo2" title="Redo  (⇧⌘Z)" onClick={() => ed().redoStep()}><Icon id="i-redo" /></button>
      <div className="sep" />

      <button className="btn pri" id="btnImport" onClick={() => ed().patch({ modal: 'import' })}>
        <Icon id="i-link" />Import from Funda
      </button>
      <div className="sep" />
      <button className="btn" id="btnSave" onClick={() => saveProject()}><Icon id="i-save" />Save</button>
      <button className="btn" id="btnLib" onClick={() => ed().patch({ modal: 'library' })}>
        <Icon id="i-folder" />Library <b className="mono" id="libCount" style={{ color: 'var(--tx-3)', fontWeight: 500 }}>
          {saved ? `· ${saved}` : ''}
        </b>
      </button>
      <div className="sep" />
      <button className="btn ghost" id="btnExpJson" title="Export project as .json"
        onClick={() => project && exportJson(project)}><Icon id="i-dl" />JSON</button>
      <button className="btn ghost" id="btnImpJson" title="Import a .json project"
        onClick={() => document.querySelector<HTMLInputElement>('#fileJson')?.click()}><Icon id="i-ul" /></button>
      <button className="btn ghost" id="btnExpPng" title="Export current floor as PNG" onClick={exportPng}>
        <Icon id="i-img" />PNG
      </button>
      <button className="btn" id="btnAI" title="Export a prompt + reference image for an image generator"
        onClick={() => ed().patch({ modal: 'render' })}><Icon id="i-spark" />Render</button>
      <button
        className={`btn${rendersOpen ? ' on' : ''}`} id="btnRenders"
        title="Show the renders made from this plan"
        onClick={() => { writeRendersBar(!rendersOpen); ed().patch({ rendersOpen: !rendersOpen }); }}
      ><Icon id="i-img" />Renders</button>
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
              title="Double-click to rename"
              onClick={() => { ed().setFloorIndex(i); onFit(); }}
              /* renaming lived in the pro floor list; the chip is the only
                 place a floor is named now, so it carries it */
              onDoubleClick={() => {
                const n = prompt('Floor name', f.name);
                if (n == null) return;
                const s = ed(); s.pushUndo(); f.name = n.trim() || f.name; s.touch();
              }}
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
        className="fbtn" id="fAddFloor" title="Add a floor above this one"
        onClick={addFloor}
      ><Icon id="i-plus" />Floor</button>
      <button
        className="fbtn dgr" id="fDelFloor" title="Delete the floor you are on"
        onClick={() => {
          const s = ed();
          const f = s.floor();
          if (!f || !s.project) return;
          if (s.project.floors.length < 2) { s.toast('A plan needs at least one floor.', 'err'); return; }
          if (confirm(`Delete floor “${f.name}” and everything on it?`)) removeFloor(s.floorIndex);
        }}
      ><Icon id="i-trash" /></button>
      <button
        className={`fbtn add${trayOpen ? ' on' : ''}`} id="fAdd"
        onClick={() => ed().patch({ trayOpen: !trayOpen })}
      ><Icon id="i-plus" />Add</button>
    </footer>
  );
}
