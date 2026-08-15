'use client';

import { useEffect, useMemo, useState } from 'react';
import { ed, useEditor } from '@state/store';
import { rs, useRenders } from '@state/renders';
import { slug } from '@engine/io/serialize';
import { download } from '../files';
import { deleteRender, type RenderRecord } from '../renders';
import { refreshRenders } from '../jobs';
import { writeRendersBar } from '../storage';
import { Icon } from './Icons';
import { fullUrlFor, releaseAllBut, urlFor } from './renderUrls';

/** The renders made from this floor, beside the plan rather than behind a modal.
 *
 *  It reads the same store the Render panel does, so a render that lands while
 *  the panel is shut still appears here, and deleting from either is one list.
 *  Everything it needs is already loaded — this is a view, not a second source. */
export function RendersBar() {
  const open = useEditor(s => s.rendersOpen);
  const project = useEditor(s => s.project);
  const floor = useEditor(s => s.floor());
  const renders = useRenders(s => s.renders);
  const selectedId = useRenders(s => s.selectedId);
  const jobs = useRenders(s => s.jobs);
  const now = useRenders(s => s.now);
  const [big, setBig] = useState<RenderRecord | null>(null);

  const job = useMemo(() => Object.values(jobs)[0] ?? null, [jobs]);
  const elapsed = job ? Math.max(0, Math.round((now - job.startedAt) / 1000)) : 0;

  /* The panel owns no data of its own, so it has to ask — a render made on
     another floor, or before this one was opened, is only in IndexedDB. */
  useEffect(() => { if (open) void refreshRenders(); }, [open, project?.id, floor?.id]);
  useEffect(() => { releaseAllBut(renders); }, [renders]);

  /* A record deleted from the Render panel must not stay on screen here. */
  useEffect(() => {
    if (big && !renders.some(r => r.id === big.id)) setBig(null);
  }, [renders, big]);

  if (!open) return null;

  const numberOf = (id: string | null) => {
    const i = id ? renders.findIndex(r => r.id === id) : -1;
    return i < 0 ? null : renders.length - i;
  };

  const save = (rec: RenderRecord) => {
    if (!rec.blob || !project || !floor) return;
    download(rec.blob, `${slug(`${project.name}-${floor.name}`)}-render-${numberOf(rec.id) ?? 1}-seed${rec.seed ?? 0}.png`);
  };

  const remove = async (rec: RenderRecord) => {
    if (!(await deleteRender(rec.id))) return;
    rs().patch({ unstored: rs().unstored.filter(r => r.id !== rec.id) });
    if (rs().selectedId === rec.id) rs().patch({ selectedId: null });
    if (rs().parentId === rec.id) rs().patch({ parentId: null });
    await refreshRenders();
  };

  return (
    <aside className="rbar" id="rbar">
      <div className="rbar-h">
        <span className="lbl">Renders</span>
        <span className="mono" id="rbarCount">{renders.length || ''}</span>
        <div className="spring" />
        <button className="m-x" id="rbarClose" title="Hide the renders"
          onClick={() => { writeRendersBar(false); ed().patch({ rendersOpen: false }); }}>
          <Icon id="i-x" />
        </button>
      </div>

      <div className="rbar-b" id="rbarList">
        {job && (
          <div className="rbar-job" id="rbarJob">
            <span className="spin" /> Rendering… {elapsed}s
          </div>
        )}
        {!renders.length && !job && (
          <div className="hint" id="rbarEmpty">
            Nothing yet. <b>Render</b> in the top bar makes the first one.
          </div>
        )}
        {renders.map(r => {
          const n = numberOf(r.id);
          const from = numberOf(r.parentId);
          return (
            <div key={r.id} className={`rcell${r.id === selectedId ? ' on' : ''}${r.blob ? '' : ' bad'}`} data-id={r.id}>
              <button
                className="rcell-img" title={r.error ?? `Render #${n}, seed ${r.seed ?? 'unknown'} — click to enlarge`}
                onClick={() => { rs().patch({ selectedId: r.id }); if (r.blob) setBig(r); }}
              >
                {r.blob ? <img src={urlFor(r)} alt={`render ${n}`} /> : <Icon id="i-alert" />}
              </button>
              <div className="rcell-f">
                <b>#{n}</b>
                <em>{r.seed ?? '—'}</em>
                {from !== null && <u>from #{from}</u>}
                <div className="spring" />
                {r.blob && (
                  <button className="cb" title="Download this render" onClick={() => save(r)}><Icon id="i-dl" /></button>
                )}
                <button className="cb dgr" title="Delete this render" onClick={() => void remove(r)}><Icon id="i-trash" /></button>
              </div>
              {r.error && <div className="hint err">{r.error}</div>}
            </div>
          );
        })}
      </div>

      {/* Full size, over the whole window — a 290px column cannot show a render
          at anything like the size it was generated at. */}
      {big?.blob && (
        <div className="ov open" id="rbarBig" onMouseDown={() => setBig(null)}>
          <img src={fullUrlFor(big)} alt={`render ${numberOf(big.id)}`} />
        </div>
      )}
    </aside>
  );
}
