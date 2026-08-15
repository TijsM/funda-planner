'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ed, useEditor, useSelection } from '@state/store';
import {
  SEED_MAX, applySettings, busy, outputDims, parseSeed, promptKeyOf, randomSeed, rs, settingsOf,
  useRenders,
} from '@state/renders';
import { buildPrompt, planFacts, type ViewKind } from '@engine/prompt';
import { polyArea } from '@engine/geometry';
import { fmtM2 } from '@engine/geometry';
import { slug } from '@engine/io/serialize';
import { download, renderFloorCanvas } from '../files';
import { deleteRender, totalBytes, type RenderRecord } from '../renders';
import { refreshRenders, startRender } from '../jobs';
import { Icon } from './Icons';

const VIEWS: { v: ViewKind; label: string }[] = [
  { v: 'top', label: 'Top-down' },
  { v: 'eye', label: 'Eye level' },
  { v: 'iso', label: 'Isometric' },
  { v: 'sketch', label: 'Sketch' },
];

/** Object URLs for the filmstrip, keyed by record id and kept at module level:
 *  the modal unmounts on every Escape, and minting a fresh URL per open leaks
 *  one per open. Released when a record leaves the list. */
const urls = new Map<string, string>();

function urlFor(rec: RenderRecord): string {
  const held = urls.get(rec.id);
  if (held) return held;
  const blob = rec.thumbnail ?? rec.blob;
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  urls.set(rec.id, url);
  return url;
}

/** The full-size bytes, for the big preview — the thumbnail is 320 px wide and
 *  looks it when it fills the stage. */
function fullUrlFor(rec: RenderRecord): string {
  const key = `${rec.id}:full`;
  const held = urls.get(key);
  if (held) return held;
  if (!rec.blob) return '';
  const url = URL.createObjectURL(rec.blob);
  urls.set(key, url);
  return url;
}

function releaseAllBut(keep: RenderRecord[]) {
  const live = new Set(keep.flatMap(r => [r.id, `${r.id}:full`]));
  for (const [key, url] of urls) {
    if (live.has(key)) continue;
    URL.revokeObjectURL(url);
    urls.delete(key);
  }
}

export function RenderModal() {
  const project = useEditor(s => s.project);
  const floor = useEditor(s => s.floor());
  /* The plan is editable behind an open modal, and `rev` is the only thing that
     moves when a wall does — without it here the reference image kept showing
     the plan as it was when the modal opened. */
  const rev = useEditor(s => s.rev);
  const sel = useSelection();

  const view = useRenders(s => s.view);
  const room = useRenders(s => s.room);
  const style = useRenders(s => s.style);
  const furniture = useRenders(s => s.furniture);
  const dimensions = useRenders(s => s.dimensions);
  const roomLabels = useRenders(s => s.roomLabels);
  const imgMeasures = useRenders(s => s.imgMeasures);
  const prompt = useRenders(s => s.prompt);
  const seed = useRenders(s => s.seed);
  const seedLocked = useRenders(s => s.seedLocked);
  const renders = useRenders(s => s.renders);
  const selectedId = useRenders(s => s.selectedId);
  const parentId = useRenders(s => s.parentId);
  const jobs = useRenders(s => s.jobs);
  const sessionCount = useRenders(s => s.sessionCount);
  const now = useRenders(s => s.now);

  const [img, setImg] = useState('');
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  /* Every project's renders, not this floor's — the quota that runs out is the
     browser's, and it is the total that decides when the next save fails. */
  const [bytes, setBytes] = useState(0);

  const job = useMemo(() => Object.values(jobs)[0] ?? null, [jobs]);
  const elapsed = job ? Math.max(0, Math.round((now - job.startedAt) / 1000)) : 0;

  const namedRooms = useMemo(
    () => (floor ? floor.areas.filter(a => a.name.trim() && polyArea(a.poly) > 10000) : []),
    [floor],
  );

  /* start from the room selected on the canvas, if there is one */
  useEffect(() => {
    const a = sel.find(s => s.t === 'area');
    if (a && namedRooms.some(r => r.id === a.o.id)) rs().patch({ room: a.o.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* The settings outlive the modal now, so a room chosen on one floor can still
     be selected on a floor that has never heard of it — which renders as a blank
     <select> and a prompt for the whole floor. */
  useEffect(() => {
    if (room !== '*' && !namedRooms.some(r => r.id === room)) rs().patch({ room: '*' });
  }, [room, namedRooms]);

  useEffect(() => { void refreshRenders(); }, [project?.id, floor?.id]);

  useEffect(() => {
    releaseAllBut(renders);
    void totalBytes().then(setBytes);
  }, [renders]);

  const settings = useMemo(
    () => settingsOf({ view, room, style, furniture, dimensions, roomLabels, imgMeasures }),
    [view, room, style, furniture, dimensions, roomLabels, imgMeasures],
  );
  const promptKey = project && floor ? promptKeyOf(project.id, floor.id, rev, settings) : '';

  const rebuild = useCallback(() => {
    if (!project || !floor) return;
    rs().patch({ prompt: buildPrompt(project, floor, settings), promptKey });
  }, [project, floor, settings, promptKey]);

  useEffect(() => {
    /* Only when the settings that produced it have moved. The prompt survives a
       close now, and rebuilding on every open would eat a hand-edited prompt
       every time someone pressed Escape. */
    if (rs().promptKey !== promptKey || !rs().prompt.trim()) rebuild();
  }, [promptKey, rebuild]);

  useEffect(() => {
    if (!floor) return;
    const cv = renderFloorCanvas(floor, {
      clean: true, furniture, roomLabels, measures: imgMeasures, maxPx: 1800,
    });
    setCanvas(cv);
    setImg(cv ? cv.toDataURL('image/png') : '');
  }, [floor, furniture, roomLabels, imgMeasures, rev]);

  if (!project || !floor) return null;

  /* Numbered oldest-first — the list is newest-first, so #1 is the last row.
     A deletion renumbers what is left, which is the price of not storing an
     ordinal; the alternative is a filmstrip with holes in its numbering, and
     every "from #N" back-link is read off this same list anyway. */
  const numberOf = (id: string | null) => {
    const i = id ? renders.findIndex(r => r.id === id) : -1;
    return i < 0 ? null : renders.length - i;
  };
  const selected = renders.find(r => r.id === selectedId) ?? null;
  const shown = selected?.blob ? selected : null;
  const parent = parentId ? renders.find(r => r.id === parentId) ?? null : null;
  const out = canvas ? outputDims(canvas.width, canvas.height) : null;
  const seedNum = parseSeed(seed);
  const canGenerate = !busy({ jobs, sessionCount }) && !!prompt.trim() && !!canvas;

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      ed().toast('Prompt copied — paste it into your image generator.', 'ok');
    } catch {
      ed().toast('Could not reach the clipboard — select the text and press ⌘C.', 'err');
    }
  };

  const copyImage = async () => {
    if (!canvas) return;
    try {
      const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
      if (!blob) throw new Error('no blob');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      ed().toast('Reference image copied — paste it alongside the prompt.', 'ok');
    } catch {
      ed().toast('Clipboard refused the image. Use the Image button to download it instead.', 'err');
    }
  };

  const downloadImage = () => {
    if (!canvas) return;
    canvas.toBlob(blob => {
      if (!blob) return;
      /* suffix after slugging — slug() truncates, and it would eat it */
      download(blob, `${slug(`${project.name}-${floor.name}`)}-reference.png`);
      ed().toast('Reference image saved.', 'ok');
    }, 'image/png');
  };

  const downloadRender = (rec: RenderRecord) => {
    if (!rec.blob) return;
    download(rec.blob, `${slug(`${project.name}-${floor.name}`)}-render-${numberOf(rec.id) ?? 1}-seed${rec.seed ?? 0}.png`);
  };

  const removeRender = async (rec: RenderRecord) => {
    if (!(await deleteRender(rec.id))) return;
    /* A record that never reached the database is held in memory instead, and
       deleting it has to say so here — refreshRenders merges that list back in,
       so anything left there returns the moment the panel is reopened. */
    rs().patch({ unstored: rs().unstored.filter(r => r.id !== rec.id) });
    if (rs().selectedId === rec.id) rs().patch({ selectedId: null });
    if (rs().parentId === rec.id) rs().patch({ parentId: null });
    await refreshRenders();
  };

  const useSettingsOf = (rec: RenderRecord) => {
    rs().patch(applySettings(rec, project.id, rev));
    ed().toast(`Settings from #${numberOf(rec.id) ?? 1} loaded — the next render is recorded as its child.`, 'ok');
  };

  return (
    <div className="ov open" id="ovAI" onMouseDown={e => { if (e.target === e.currentTarget) ed().patch({ modal: null }); }}>
      <div className="modal ai">
        <div className="m-h">
          <div style={{ flex: 1 }}>
            <h2>Render this plan</h2>
            <p>A prompt written from the actual geometry, plus a clean reference image to attach.</p>
          </div>
          <button className="m-x" data-close onClick={() => ed().patch({ modal: null })}><Icon id="i-x" /></button>
        </div>

        <div className="m-b ai-b">
          <div className="ai-left">
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="lbl">View</span>
              <div className="seg" id="aiView">
                {VIEWS.map(x => (
                  <button key={x.v} data-v={x.v} className={view === x.v ? 'on' : ''} onClick={() => rs().patch({ view: x.v })}>
                    {x.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="lbl">Room</span>
              <div className="fields"><div className="fld wide">
                <select id="aiRoom" value={room} onChange={e => rs().patch({ room: e.target.value })}>
                  <option value="*">Whole floor — {floor.name}</option>
                  {namedRooms.map(a => (
                    <option key={a.id} value={a.id}>{a.name} — {fmtM2(polyArea(a.poly))} m²</option>
                  ))}
                </select>
              </div></div>
            </div>
            <div className="row" style={{ marginBottom: 2 }}>
              <span className="lbl">Style</span>
              <div className="fields"><div className="fld wide">
                <input id="aiStyle" spellCheck={false} placeholder="e.g. Scandinavian, warm oak, matte black accents"
                  value={style} onChange={e => rs().patch({ style: e.target.value })} onKeyDown={e => e.stopPropagation()} />
              </div></div>
            </div>

            <label className="tg">
              <input type="checkbox" id="aiFurn" checked={furniture} onChange={e => rs().patch({ furniture: e.target.checked })} />
              <span className="sw2" /><span>List the furniture</span>
            </label>
            <label className="tg">
              <input type="checkbox" id="aiDims" checked={dimensions} onChange={e => rs().patch({ dimensions: e.target.checked })} />
              <span className="sw2" /><span>Measurements in the prompt</span>
            </label>
            <label className="tg">
              <input type="checkbox" id="aiImgDims" checked={imgMeasures} onChange={e => rs().patch({ imgMeasures: e.target.checked })} />
              <span className="sw2" /><span>Measurements on the image</span>
            </label>
            <label className="tg">
              <input type="checkbox" id="aiLabels" checked={roomLabels} onChange={e => rs().patch({ roomLabels: e.target.checked })} />
              <span className="sw2" /><span>Room names on the image</span>
            </label>

            <textarea className="src" id="aiPrompt" spellCheck={false} style={{ marginTop: 10 }}
              value={prompt} onChange={e => rs().patch({ prompt: e.target.value })} onKeyDown={e => e.stopPropagation()} />
            <div className="hint" id="aiCount" style={{ marginTop: 6 }}>
              {prompt.length} characters · {prompt.split('\n').length} lines
              {parent && (
                <> · building on <b>#{numberOf(parent.id)}</b>{' '}
                  <button className="ai-unlink" id="aiUnlink" onClick={() => rs().patch({ parentId: null })}>drop the link</button>
                </>
              )}
            </div>
          </div>

          <div className="ai-right">
            <span className="lbl">
              {selected ? `Render #${numberOf(selected.id)}${selected.blob ? '' : ' — failed'}` : 'Reference image'}
            </span>
            <div className="ai-prev">
              {img ? <img id="aiImg" src={img} alt="clean floor plan reference" className={shown ? 'off' : ''} /> : null}
              {!img && !shown && <div className="empty"><p>This floor has nothing to draw yet.</p></div>}
              {shown && <img id="aiRender" src={fullUrlFor(shown)} alt={`render, seed ${shown.seed ?? 'unknown'}`} />}
              {job && (
                <div className="ai-run" id="aiRun">
                  <b>{elapsed}s</b>
                  <span>Rendering — this usually takes 20 to 60 seconds.</span>
                  <em>Keep working; closing this panel does not cancel it. A render in progress is lost if you reload or close the tab.</em>
                </div>
              )}
            </div>

            {/* Driven by the selection, not by the preview: a failed render has
                no bytes and this row is the only place its retry lives. */}
            {selected && (
              <div className="ai-meta" id="aiMeta">
                <span className="mono">seed {selected.seed ?? '—'}</span>
                <span className="mono">{Math.round(selected.durationMs / 1000)}s</span>
                <span className="mono">{selected.model}</span>
                <div className="spring" />
                <button className="btn sm" id="aiUse" onClick={() => useSettingsOf(selected)}>Use these settings</button>
                {selected.blob && (
                  <button className="btn sm" id="aiDlRender" onClick={() => downloadRender(selected)} title="Download this render"><Icon id="i-dl" /></button>
                )}
                <button className="btn sm dgr" id="aiDelRender" onClick={() => void removeRender(selected)} title="Delete this render"><Icon id="i-trash" /></button>
              </div>
            )}
            {selected?.error && <div className="hint err" id="aiRenderErr">{selected.error}</div>}

            <div className="hint">
              {/* This used to read "attach this to the generator", which is the one thing
                  Generate now does for you — but the copy buttons are still the way out to
                  any other generator, so the sentence explains the picture instead. */}
              The layout every render is held to. <b>Copy image</b> takes it elsewhere.
              {imgMeasures && (
                <>
                  <br />Lettering on the reference can bleed into the render — turn
                  {' '}<b>Measurements on the image</b> off for the cleanest result.
                </>
              )}
            </div>

            <div className="row" style={{ marginBottom: 2 }}>
              <span className="lbl">Seed</span>
              <div className="fields">
                <div className="fld wide">
                  {/* A real <input>: Editor.tsx's document keydown guard returns early for
                      INPUT/TEXTAREA/SELECT, and that guard is the only thing stopping the
                      digits and letters typed here from firing tool shortcuts. */}
                  <input id="aiSeed" inputMode="numeric" spellCheck={false} placeholder="random each run"
                    value={seed} onChange={e => rs().patch({ seed: e.target.value.replace(/\D+/g, '') })}
                    onKeyDown={e => e.stopPropagation()} />
                </div>
                <button className="btn sm" id="aiSeedRnd" title="Roll a new seed"
                  onClick={() => rs().patch({ seed: String(randomSeed()) })}><Icon id="i-rot" /></button>
              </div>
            </div>
            <label className="tg">
              <input type="checkbox" id="aiSeedLock" checked={seedLocked} onChange={e => rs().patch({ seedLocked: e.target.checked })} />
              <span className="sw2" /><span>Lock the seed — reuse it so a prompt tweak changes only what you tweaked</span>
            </label>
            {seed && seedNum === null && (
              <div className="hint" id="aiSeedBad">
                Seeds run from 0 to {SEED_MAX}. This one is past that, so the next render rolls a fresh seed instead.
              </div>
            )}
            {seed && seedNum !== null && !seedLocked && (
              <div className="hint">Unlocked, so this one is replaced by a fresh roll on the next render.</div>
            )}

            <span className="lbl" style={{ marginTop: 6 }}>This floor&rsquo;s renders</span>
            <div className="ai-strip" id="aiStrip">
              {!renders.length && <div className="hint">Nothing yet. Generate writes the first one here.</div>}
              {renders.map(r => {
                const n = numberOf(r.id);
                const from = numberOf(r.parentId);
                return (
                  <button key={r.id} data-id={r.id} className={`ai-cell${r.id === selectedId ? ' on' : ''}${r.blob ? '' : ' bad'}`}
                    onClick={() => rs().patch({ selectedId: r.id })}
                    title={r.error ?? `Render #${n}, seed ${r.seed ?? 'unknown'}`}>
                    {r.blob ? <img src={urlFor(r)} alt={`render ${n}`} /> : <Icon id="i-alert" />}
                    <b>#{n}</b>
                    <em>{r.seed ?? '—'}</em>
                    {from !== null && <u>from #{from}</u>}
                  </button>
                );
              })}
            </div>
            <div className="hint" id="aiLocal">
              Renders live in this browser only — they do not travel with a JSON export, so download
              the ones worth keeping.{bytes > 0 && ` Every render on this browser: ${(bytes / 1048576).toFixed(1)} MB.`}
            </div>
          </div>
        </div>

        <div className="m-f">
          <button className="btn" id="aiRegen" onClick={rebuild}><Icon id="i-rot" />Rebuild prompt</button>
          <span className="hint mono" id="aiSession">
            {sessionCount} this session{out ? ` · ${out.width}×${out.height}` : ''}
          </span>
          <div className="spring" />
          <button className="btn" id="aiCopyImg" onClick={copyImage}><Icon id="i-copy" />Copy image</button>
          <button className="btn" id="aiDlImg" onClick={downloadImage}><Icon id="i-dl" />Image</button>
          <button className="btn" id="aiCopy" onClick={copyPrompt}><Icon id="i-copy" />Copy prompt</button>
          <button className="btn pri" id="aiGen" disabled={!canGenerate} onClick={() => void startRender(canvas)}>
            <Icon id="i-spark" />{job ? `Rendering ${elapsed}s` : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  );
}

export { planFacts };
