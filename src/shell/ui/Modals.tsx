'use client';

import { useEffect, useRef, useState } from 'react';
import { ed, useEditor } from '@state/store';
import { blankProject, contentBBox, floorArea } from '@engine/model';
import { dist, fmtM2, R2 } from '@engine/geometry';
import { paint } from '@engine/render';
import { fitTo } from '@engine/view';
import type { Project } from '@engine/types';
import { importFromSource, importFromUrl, type Step } from '../funda';
import { readImageFile, readJsonFile, exportJson } from '../files';
import { clearLibrary, deleteProject, loadProject, readIndex, type LibraryEntry } from '../storage';
import { Icon } from './Icons';

const close = () => ed().patch({ modal: null, calibrating: false, draft: null });

function Overlay({ id, children, wide, pass }: { id: string; children: React.ReactNode; wide?: boolean; pass?: boolean }) {
  return (
    <div className={`ov open${pass ? ' pass' : ''}`} id={id}
      onMouseDown={e => { if (e.target === e.currentTarget && !pass) close(); }}>
      <div className={`modal${wide ? ' wide' : ''}`}>{children}</div>
    </div>
  );
}

/* ══════════════════ import ══════════════════ */

export function ImportModal() {
  const [url, setUrl] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);
  const [srcOpen, setSrcOpen] = useState(false);
  const [src, setSrc] = useState('');
  const [over, setOver] = useState(false);

  const go = () => {
    if (!/^https?:\/\/(www\.)?funda\.nl\//i.test(url.trim())) {
      ed().toast('Paste a full funda.nl listing URL.', 'err');
      return;
    }
    void importFromUrl(url.trim().split('#')[0], setSteps);
  };

  const start = (garden: boolean) => {
    ed().setProject(blankProject(garden ? 'Garden design' : 'Untitled plan', garden), { saved: false });
    ed().patch({ modal: null });
    ed().toast(garden ? 'Garden plot created — 9×14 m.' : 'Blank plan created — 8×10 m shell to build from.', 'ok');
  };

  return (
    <Overlay id="ovImport">
      <div className="m-h">
        <div style={{ flex: 1 }}>
          <h2>Import a floor plan</h2>
          <p>Paste a Funda listing URL — the vector floor plan is pulled straight from the source.</p>
        </div>
        <button className="m-x" data-close onClick={close}><Icon id="i-x" /></button>
      </div>
      <div className="m-b">
        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
          <div className="urlbar" style={{ flex: 1 }}>
            <Icon id="i-link" />
            <input id="inUrl" spellCheck={false} placeholder="https://www.funda.nl/detail/koop/…"
              value={url} onChange={e => setUrl(e.target.value)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') go(); }} />
          </div>
          <button className="btn pri" id="btnGo" style={{ height: 42, padding: '0 16px' }} onClick={go}>
            <Icon id="i-dl" />Fetch plan
          </button>
        </div>

        <div className="steps" id="steps">
          {steps.map((s, i) => (
            <div className={`step ${s.k ?? ''}`} key={i}>
              <span className="ic">
                {s.k === 'run' ? <span className="spin" />
                  : s.k === 'ok' ? <Icon id="i-check" style={{ color: 'var(--moss)' }} />
                  : s.k === 'err' ? <Icon id="i-alert" />
                  : <Icon id="i-alert" style={{ opacity: 0.35 }} />}
              </span>
              <span className="tx">{s.t}{s.d ? <em>{s.d}</em> : null}</span>
            </div>
          ))}
        </div>

        <div className="disc">
          <b>How it works.</b> Funda blocks direct machine requests, so the listing page is read through the
          public <span className="mono">r.jina.ai</span> reader proxy — the listing URL you paste is sent to that
          third-party service. From the page we recover the Floorplanner project id and download the real{' '}
          <span className="mono">.fml</span> vector geometry directly from Floorplanner&apos;s public bucket.
          Nothing else leaves your machine; everything you save stays in this browser.
        </div>

        <div className="or"><span className="lbl">or start another way</span></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" id="btnBlank" onClick={() => start(false)}><Icon id="i-plus" />Blank plan</button>
          <button className="btn" id="btnGarden" onClick={() => start(true)}><Icon id="i-tree" />Blank garden plot</button>
          <button className="btn" id="btnPasteSrc" onClick={() => setSrcOpen(v => !v)}><Icon id="i-copy" />Paste page source</button>
        </div>
        {srcOpen && (
          <div id="srcWrap" style={{ marginTop: 10 }}>
            <p className="hint" style={{ marginBottom: 6 }}>
              Open the listing in your browser, <b>View Source</b>, copy everything, paste here. Works even if the proxy is blocked.
            </p>
            <textarea className="src" id="inSrc" spellCheck={false} placeholder="<!DOCTYPE html> …"
              value={src} onChange={e => setSrc(e.target.value)} onKeyDown={e => e.stopPropagation()} />
            <button className="btn sm" id="btnParseSrc" style={{ marginTop: 7 }}
              onClick={() => {
                if (src.length < 500) { ed().toast('Paste the whole page source.', 'err'); return; }
                void importFromSource(src, setSteps);
              }}><Icon id="i-check" />Parse source</button>
          </div>
        )}

        <div className="or"><span className="lbl">or trace an image</span></div>
        <div
          className={`drop${over ? ' over' : ''}`} id="drop"
          onClick={() => document.querySelector<HTMLInputElement>('#fileImg')?.click()}
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
          onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setOver(false); }}
          onDrop={e => {
            e.preventDefault(); e.stopPropagation(); setOver(false);
            const f = e.dataTransfer.files[0];
            if (f && /^image\//.test(f.type)) {
              if (!ed().project) ed().setProject(blankProject('Traced plan', false));
              readImageFile(f);
            }
          }}
        >
          <Icon id="i-img" />
          <b>Drop a floor plan image</b>
          <span>PNG / JPG / WEBP — then calibrate the scale and trace over it</span>
          <input type="file" id="fileImg" accept="image/*" hidden
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) { if (!ed().project) ed().setProject(blankProject('Traced plan', false)); readImageFile(f); }
              e.target.value = '';
            }} />
        </div>
      </div>
    </Overlay>
  );
}

/* ══════════════════ library ══════════════════ */

export function LibraryModal() {
  const [idx, setIdx] = useState<LibraryEntry[]>([]);
  useEffect(() => { setIdx(readIndex()); }, []);

  return (
    <Overlay id="ovLib" wide>
      <div className="m-h">
        <div style={{ flex: 1 }}>
          <h2>Saved plans</h2>
          <p id="libSub">{idx.length ? `${idx.length} plan(s) stored in this browser` : 'Nothing saved yet'}</p>
        </div>
        <button className="m-x" data-close onClick={close}><Icon id="i-x" /></button>
      </div>
      <div className="m-b">
        <div className="lib" id="libList">
          {!idx.length && (
            <div className="empty"><Icon id="i-folder" />
              <p>No saved plans yet.<br />Hit <b>Save</b> in the top bar once you have something worth keeping.</p>
            </div>
          )}
          {idx.map(x => (
            <div className="lib-i" data-id={x.id} key={x.id}>
              <div className="thumb"><Thumb id={x.id} /></div>
              <div className="meta">
                <b>{x.name}</b>
                <span>{x.address ? `${x.address} · ` : ''}{x.nf} floor(s) · {new Date(x.updatedAt).toLocaleString()}</span>
              </div>
              <div className="acts">
                <button className="btn sm" data-act="open" onClick={() => {
                  const p = loadProject(x.id);
                  if (!p) { ed().toast('Could not load that plan.', 'err'); return; }
                  ed().setProject(p, { saved: true });
                  ed().patch({ modal: null });
                  ed().toast(`Loaded “${p.name}”`, 'ok');
                }}>Open</button>
                <button className="btn sm" data-act="dl" title="Download as .json" onClick={() => {
                  const p = loadProject(x.id); if (p) exportJson(p);
                }}><Icon id="i-dl" /></button>
                <button className="btn sm dgr" data-act="del" title="Delete" onClick={() => {
                  if (!confirm('Delete this saved plan?')) return;
                  deleteProject(x.id); setIdx(readIndex());
                }}><Icon id="i-trash" /></button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="m-f">
        <button className="btn" id="btnImpJson2" onClick={() => document.querySelector<HTMLInputElement>('#fileJson')?.click()}>
          <Icon id="i-ul" />Import .json file
        </button>
        <div className="spring" />
        <button className="btn ghost dgr" id="btnWipe" onClick={() => {
          if (!confirm('Delete every saved plan in this browser? Exported .json files are unaffected.')) return;
          clearLibrary(); setIdx([]); ed().toast('Library cleared.', 'ok');
        }}>Clear library</button>
      </div>
    </Overlay>
  );
}

function Thumb({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const d = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = 56 * d; cv.height = 42 * d;
    const g = cv.getContext('2d');
    if (!g) return;
    const p = loadProject(id) as Project | null;
    const f = p?.floors[0];
    if (!f) { g.fillStyle = '#E7E2D5'; g.fillRect(0, 0, cv.width, cv.height); return; }
    const b = contentBBox(f);
    const view = b ? fitTo(b, 56, 42, 4) : { zoom: 0.05, px: 28, py: 21 };
    paint(g, {
      floor: f, view, width: 56, height: 42, dpr: d,
      layers: { rooms: true, areas: false, furn: true, dims: false, notes: false },
      grid: false, live: false, vignette: false,
    });
  }, [id]);
  return <canvas ref={ref} data-th={id} />;
}

/* ══════════════════ calibrate ══════════════════ */

export function CalibrateModal() {
  const draft = useEditor(s => s.draft);
  const [real, setReal] = useState('500');
  const cal = draft?.kind === 'cal' ? draft : null;
  const measured = cal?.a && cal?.b ? dist(cal.a, cal.b) : 0;

  const apply = () => {
    const s = ed();
    const f = s.floor();
    if (!f?.ref || !cal?.a || !cal?.b) return;
    const r = parseFloat(real);
    if (!(measured > 0.5) || !(r > 0)) { s.toast('Pick two points further apart.', 'err'); return; }
    const k = r / measured;
    s.pushUndo();
    /* scale about the first clicked point, so it stays under the cursor */
    f.ref.x = R2(cal.a.x + (f.ref.x - cal.a.x) * k);
    f.ref.y = R2(cal.a.y + (f.ref.y - cal.a.y) * k);
    f.ref.w = R2(f.ref.w * k);
    f.ref.h = R2(f.ref.h * k);
    s.patch({ modal: null, calibrating: false, draft: null });
    s.touch();
    s.toast('Scale set — 1 plan unit is now 1 cm on that reference.', 'ok');
  };

  return (
    <Overlay id="ovCal" pass>
      <div className="m-h">
        <div style={{ flex: 1 }}>
          <h2>Set the scale</h2>
          <p>Two clicks on a known distance, then type the real length.</p>
        </div>
        <button className="m-x" data-close onClick={close}><Icon id="i-x" /></button>
      </div>
      <div className="m-b">
        <p className="hint" id="calStep">
          {!cal?.a ? <>Click the <b>first</b> point on the reference image — ideally the two ends of a printed dimension line.</>
            : !cal?.b ? <>Now click the <b>second</b> point.</>
            : <>Measured <b>{Math.round(measured)}</b> plan-units. Enter the real length →</>}
        </p>
        <div className="row" style={{ marginTop: 14 }}>
          <span className="lbl">Real length</span>
          <div className="fld">
            <input id="calVal" type="number" min={1} value={real}
              onChange={e => setReal(e.target.value)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') apply(); }} />
            <u>cm</u>
          </div>
        </div>
      </div>
      <div className="m-f">
        <div className="spring" />
        <button className="btn" data-close onClick={close}>Cancel</button>
        <button className="btn pri" id="calApply" disabled={!cal?.b} onClick={apply}><Icon id="i-check" />Apply scale</button>
      </div>
    </Overlay>
  );
}

export function ModalHost() {
  const modal = useEditor(s => s.modal);
  return (
    <>
      {modal === 'import' && <ImportModal />}
      {modal === 'library' && <LibraryModal />}
      {modal === 'calibrate' && <CalibrateModal />}
      <input type="file" id="fileJson" accept=".json,application/json" hidden
        onChange={e => { const f = e.target.files?.[0]; if (f) readJsonFile(f); e.target.value = ''; }} />
    </>
  );
}

export { floorArea, fmtM2 };
