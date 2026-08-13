'use client';

import { useEffect } from 'react';
import { Canvas } from './Canvas';
import { useEditor, bootProject } from '@state/store';
import { fitFloor } from '@engine/view';
import { blankProject, floorArea } from '@engine/model';
import { fmtM2 } from '@engine/geometry';

/** The shell during the port: real store, real engine, real canvas. The tray,
 *  inspector and modals still live in the old index.html and land next. */
export function Editor() {
  const project = useEditor(s => s.project);
  const floorIndex = useEditor(s => s.floorIndex);
  const grid = useEditor(s => s.grid);

  useEffect(() => {
    if (useEditor.getState().project) return;
    const hash = decodeURIComponent(location.hash.slice(1));
    const p = hash === 'garden' ? blankProject('Garden design', true) : bootProject();
    useEditor.getState().setProject(p, { fresh: true });
    requestAnimationFrame(() => {
      const cv = document.querySelector<HTMLCanvasElement>('#cv');
      if (cv) useEditor.getState().setView(fitFloor(useEditor.getState().floor(), cv.clientWidth, cv.clientHeight));
    });
  }, []);

  const fit = () => {
    const cv = document.querySelector<HTMLCanvasElement>('#cv');
    if (cv) useEditor.getState().setView(fitFloor(useEditor.getState().floor(), cv.clientWidth, cv.clientHeight));
  };

  return (
    <div className="app simple" id="app">
      <header className="topbar">
        <div className="brand"><b>PLATTE<em>GROND</em></b><span>STUDIO</span></div>
        <input id="projName" defaultValue={project?.name ?? ''} spellCheck={false} readOnly />
        <div className="spring" />
        <span className="lbl" style={{ paddingRight: 12 }}>v2 shell — port in progress</span>
        <button className="btn" onClick={() => useEditor.getState().undoStep()}>Undo</button>
        <button className="btn" onClick={() => useEditor.getState().redoStep()}>Redo</button>
        <button className="btn" onClick={() => useEditor.getState().patch({ grid: !grid })}>
          Grid {grid ? 'on' : 'off'}
        </button>
      </header>

      <nav className="toolrail" />
      <aside className="panel left" />
      <main className="stage sel" id="stage"><Canvas /></main>
      <aside className="panel right" />

      <footer className="floorbar" id="floorbar" style={{ display: 'flex' }}>
        <div className="fchips" id="fchips">
          {project?.floors.map((f, i) => (
            <button
              key={f.id}
              className={`fchip ${i === floorIndex ? 'on' : ''}`}
              onClick={() => { useEditor.getState().setFloorIndex(i); fit(); }}
            >
              {f.name}
              {floorArea(f) ? <small>{fmtM2(floorArea(f))} m²</small> : null}
            </button>
          ))}
        </div>
        <button className="fbtn" id="fFit" onClick={fit}>Fit</button>
      </footer>
    </div>
  );
}
