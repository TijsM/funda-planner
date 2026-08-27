'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ed, useEditor, useSelection } from '@state/store';
import {
  SEED_MAX, applySettings, attachedControls, attachedPhotos, busy, outputDims, parseSeed,
  photoSlots, promptControls, promptKeyOf, randomSeed, rs, settingsOf, useRenders,
  type AttachedPhoto,
} from '@state/renders';
import {
  STYLE_PRESETS, buildPrompt, expandStyle, photoSubjects, planFacts,
  type PhotoSubject, type ViewKind,
} from '@engine/prompt';
import { polyArea } from '@engine/geometry';
import { fmtM2 } from '@engine/geometry';
import { slug } from '@engine/io/serialize';
import { isCloud } from '@data/config';
import { RESIGN_EVERY_MS } from '@data/cloudRenders';
import {
  CONTROL_KINDS, DEFAULT_PROVIDER, PROVIDER_META, ceilingUsd, estimateUsd, metaOf,
  type ControlKind,
} from '@data/providers';
import { download, referenceOpts, renderFloorCanvas } from '../files';
import { deleteRender, renderBlob, succeeded, totalBytes, type RenderRecord } from '../renders';
import { refreshRenders, startRender } from '../jobs';
import { Icon } from './Icons';
import { usePhotoState } from './photoUrls';
import { fullUrlFor, releaseAllBut, urlFor } from './renderUrls';

const VIEWS: { v: ViewKind; label: string }[] = [
  { v: 'top', label: 'Top-down' },
  { v: 'eye', label: 'Eye level' },
  { v: 'iso', label: 'Isometric' },
  { v: 'sketch', label: 'Sketch' },
];

/** What each map is, in the words of someone deciding whether to send it. The
 *  `title` is where the mechanism goes — the button has room for one word. */
const MAPS: Record<ControlKind, { label: string; title: string }> = {
  line: {
    label: 'Line',
    title: 'A black-on-white drawing of every wall, opening and object edge. The closest thing '
      + 'to what a line ControlNet was trained on.',
  },
  depth: {
    label: 'Depth',
    title: 'Brighter is higher above the floor, cut at 1.2 m like the plan itself. What a '
      + 'dollhouse tilt gets wrong is exactly what this channel fixes, if the model reads it.',
  },
  seg: {
    label: 'Segments',
    title: 'One flat colour per room and per object group. Says where a room ends without '
      + 'saying what it is made of.',
  },
  change: {
    label: 'Changes',
    title: 'White may be re-rendered, black must come through unchanged: walls and openings '
      + 'frozen, loose furniture free, open floor the model\'s to fill.',
  },
};

/** Money, at the precision the figure deserves: a cent is three decimals, and a
 *  provider that charges two thirds of one is not "$0.01". */
const usd = (n: number | null): string =>
  n === null ? 'price not published' : `$${n.toFixed(n < 0.01 ? 4 : 3)}`;

const listOf = (ks: readonly ControlKind[]): string =>
  ks.map(k => MAPS[k].label.toLowerCase()).join(', ');

/** "line, depth or segments" — for the list of kinds a provider *would* take,
 *  which is an either/or and reads as a promise of all three with a comma. */
const orList = (ks: readonly ControlKind[]): string => {
  const names = ks.map(k => MAPS[k].label.toLowerCase());
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
};

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
  const provider = useRenders(s => s.provider);
  const controls = useRenders(s => s.controls);
  const controlScale = useRenders(s => s.controlScale);
  const photoOff = useRenders(s => s.photoOff);
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
  /* Every project's renders, not this floor's — locally the quota that runs out
     is the browser's and it is the total that decides when the next save fails;
     in the cloud it is what the account is storing. Either way the figure is
     only honest if it counts everything. */
  const [bytes, setBytes] = useState(0);
  /* Read once per render of this component rather than threaded down: it decides
     three sentences of copy and nothing about behaviour. */
  const cloud = isCloud();

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

  /* Cloud only: the filmstrip and the stage both draw signed URLs with an hour
     on them, and every other refresh here is an event. A panel left open past
     that hour showed broken cells and a blank stage with nothing to explain it.
     Local mode holds the bytes and has nothing to re-sign. */
  useEffect(() => {
    if (!cloud) return;
    const t = setInterval(() => { void refreshRenders(); }, RESIGN_EVERY_MS);
    return () => clearInterval(t);
  }, [cloud]);

  useEffect(() => {
    releaseAllBut(renders);
    void totalBytes().then(setBytes);
  }, [renders]);

  /* Every photographed object in scope, in the order the slots are spent, and
     which of their photographs will actually go. Both come from the engine and
     the store rather than from anything this panel decides: `jobs.ts` calls the
     same two functions at submit, so the checkbox list, the image numbers in the
     brief and the request itself cannot disagree. `rev` is in the deps because
     a photo is attached by mutating the document in place. */
  const subjects = useMemo(
    () => (floor ? photoSubjects(floor, room) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [floor, room, rev],
  );
  const off = useMemo(() => new Set(photoOff), [photoOff]);
  const pics = useMemo(
    () => attachedPhotos(provider, controls, subjects, off),
    [provider, controls, subjects, off],
  );
  const slots = photoSlots(provider, controls);

  const settings = useMemo(
    () => ({
      ...settingsOf({
        view, room, style, furniture, dimensions, roomLabels, imgMeasures,
        provider, controls, controlScale,
      }),
      /* The ids that will go, in order — the same field the record keeps as its
         receipt, and part of `promptKey` so the brief is rebuilt when the list
         moves. */
      photos: pics.map(a => a.id),
    }),
    [view, room, style, furniture, dimensions, roomLabels, imgMeasures,
      provider, controls, controlScale, pics],
  );
  const promptKey = project && floor ? promptKeyOf(project.id, floor.id, rev, settings) : '';

  /* The brief names the maps that travel as pictures, and only those — the exact
     array `jobs.ts` attaches, in the same order, because the sentences say "image
     2" and "image 3" and the numbering has to match what actually went. On a
     provider with a real control channel that list is empty: the map goes into
     the channel rather than into the model's stack of references, and on z-image
     it replaces the reference outright. */
  const brief = useMemo(
    () => ({
      ...settings,
      controls: promptControls(provider, controls),
      /* The photographs as the brief refers to them, not as ids. Same array, same
         order — what the sentences number is what the request attaches. */
      photos: pics.map(a => ({ objId: a.objId, label: a.label, room: a.room, note: a.note })),
    }),
    [settings, provider, controls, pics],
  );

  const rebuild = useCallback(() => {
    if (!project || !floor) return;
    rs().patch({ prompt: buildPrompt(floor, brief), promptKey });
  }, [project, floor, brief, promptKey]);

  useEffect(() => {
    /* Only when the settings that produced it have moved. The prompt survives a
       close now, and rebuilding on every open would eat a hand-edited prompt
       every time someone pressed Escape. */
    if (rs().promptKey !== promptKey || !rs().prompt.trim()) rebuild();
  }, [promptKey, rebuild]);

  /* `referenceOpts` and not an options literal: `jobs.ts` frames every control map
     with the same call, and two hand-written option objects drifted the moment
     one of them gained a toggle. A map framed differently from this picture is
     geometry for a plan that was never sent. */
  useEffect(() => {
    if (!floor) return;
    const cv = renderFloorCanvas(floor, referenceOpts({
      furniture, roomLabels, imgMeasures, room,
    }));
    setCanvas(cv);
    setImg(cv ? cv.toDataURL('image/png') : '');
    /* `room` is a dependency: a room-scoped brief describes that room, and the
       picture it is attached to has to be framed on the same thing. */
  }, [floor, furniture, roomLabels, imgMeasures, room, rev]);

  /* Open on the reference image, never on whichever render was selected last
     time. The right pane is what the next Generate is built from — a previous
     render sitting there reads as though *that* were the image being sent, and
     it never is: `startRender()` always hands the provider this canvas. Mount
     only, so a render that lands while the panel is open still takes the stage
     (`jobs.ts` selects it), and the filmstrip is one click from any older one. */
  useEffect(() => { rs().patch({ selectedId: null }); }, []);

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
  /* `succeeded`, not `selected.blob`: a cloud render is ready with no bytes in
     hand at all, and the blob test used to be what put it on the stage. */
  const shown = selected && succeeded(selected) ? selected : null;
  const parent = parentId ? renders.find(r => r.id === parentId) ?? null : null;
  const meta = metaOf(provider);
  /* Per provider, because the spending ceiling is not the same size everywhere:
     the same plan comes back at 1.43 MP of headroom on [max] and exactly 1 MP on
     flux-general, which bills rounded up to whole megapixels. Quoting one
     provider's size against another's price is how a picker lies. */
  const out = canvas ? outputDims(canvas.width, canvas.height, provider) : null;
  const cost = out ? estimateUsd(meta, out.width, out.height) : null;
  /* What will actually be sent, and what will not. The second half matters as
     much as the first: a map that was ticked and silently dropped is a choice
     taken away from whoever ticked it. */
  const attached = attachedControls(provider, controls);
  const dropped = controls.filter(k => !attached.includes(k));
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

  /* Async because in cloud mode the bytes are behind a signed URL rather than in
     the record — see `renderBlob`. Local mode still resolves without a request. */
  const downloadRender = async (rec: RenderRecord) => {
    const blob = await renderBlob(rec);
    if (!blob) {
      ed().toast('That render could not be fetched for download — reopen this panel and try again.', 'err');
      return;
    }
    download(blob, `${slug(`${project.name}-${floor.name}`)}-render-${numberOf(rec.id) ?? 1}-seed${rec.seed ?? 0}.png`);
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

  /* Appended, never rebuilt from CONTROL_KINDS: the array's order IS the attach
     order, image 2 is whichever map was ticked first, and the brief numbers them
     off the same list. Sorting this into a canonical order would renumber the
     sentences under the prompt someone has already read. */
  const toggleMap = (k: ControlKind) => {
    rs().patch({
      controls: controls.includes(k) ? controls.filter(x => x !== k) : [...controls, k],
    });
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
                <input id="aiStyle" list="aiStyles" spellCheck={false} placeholder="e.g. Scandinavian, warm oak, matte black accents"
                  value={style} onChange={e => rs().patch({ style: e.target.value })} onKeyDown={e => e.stopPropagation()} />
                {/* Suggestions, never a closed list: a named one is expanded into
                    concrete materials in the prompt, anything else goes through
                    verbatim exactly as it always did. */}
                <datalist id="aiStyles">
                  {STYLE_PRESETS.map(s => <option key={s.label} value={s.label} />)}
                </datalist>
              </div></div>
            </div>
            {/* The presets, on the surface rather than inside a datalist nobody
                opens. An empty Style box emits no STYLE block at all, and a brief
                with no style in it is a brief whose only material instruction is
                whatever someone typed in a room's Notes — which is how a floor
                described as "dark brown laminaar" came back dark brown
                everywhere, in four different woods. A render always has a style;
                the only question is whether it was chosen. */}
            <div className="row styles-row">
              <span className="lbl" />
              <div className="fields styles">
                {STYLE_PRESETS.map(pre => (
                  <button
                    key={pre.label} type="button"
                    className={`chip${expandStyle(style)?.label === pre.label ? ' on' : ''}`}
                    title={pre.tokens}
                    onClick={() => rs().patch({ style: pre.label })}
                  >{pre.label}</button>
                ))}
                {!style.trim() && (
                  <em>No style set — the render invents one.</em>
                )}
              </div>
            </div>

            <div className="row" style={{ marginTop: 8, marginBottom: 2 }}>
              <span className="lbl">Model</span>
              <div className="fields"><div className="fld wide">
                <select id="aiProvider" value={provider} onChange={e => rs().patch({ provider: e.target.value })}>
                  {PROVIDER_META.map(p => {
                    /* Each provider's price at its OWN largest affordable size, so the
                       figures in the list are comparable and none of them quotes a
                       resolution that provider would be refused for. */
                    const d = canvas ? outputDims(canvas.width, canvas.height, p.id) : null;
                    return (
                      <option key={p.id} value={p.id}>
                        {p.label} — {d ? usd(estimateUsd(p, d.width, d.height)) : usd(p.usdPerMegapixel)}
                        {d ? '' : '/MP'}
                      </option>
                    );
                  })}
                </select>
              </div></div>
            </div>
            <div className="hint" id="aiProviderNote">
              {meta.note}
              {out && (
                <>
                  <br />{usd(cost)} for {out.width}×{out.height}
                  {' '}({(out.width * out.height / 1e6).toFixed(1)} MP), against a
                  {' '}{usd(ceilingUsd(meta))} ceiling per image.
                </>
              )}
              {meta.acceptsControls.length === 0 && (
                <>
                  <br />No control channel: this model reads every image as a reference and has no
                  {' '}strength dial. Maps sent to it are a hypothesis, not a constraint.
                </>
              )}
              {/* Only when it is a different key from the one that already works, and
                  compared against the default provider rather than a literal — the
                  browser cannot see the server's environment, so this is the only
                  warning available before the render fails for want of a variable. */}
              {meta.needsEnv !== metaOf(DEFAULT_PROVIDER).needsEnv && (
                <>
                  <br />Needs <b>{meta.needsEnv}</b> set on the server. Generate says so by name if it
                  {' '}is not.
                </>
              )}
            </div>

            <div className="row" style={{ marginBottom: 2 }}>
              <span className="lbl">Maps</span>
              <div className="seg" id="aiControls">
                {CONTROL_KINDS.map(k => (
                  <button key={k} data-k={k} title={MAPS[k].title}
                    className={controls.includes(k) ? 'on' : ''} onClick={() => toggleMap(k)}>
                    {MAPS[k].label}
                  </button>
                ))}
              </div>
            </div>
            {meta.acceptsControls.length > 0 && attached.length > 0 && (
              <div className="row" style={{ marginBottom: 2 }}>
                <span className="lbl">Strength</span>
                <div className="fields"><div className="fld wide">
                  <input type="range" id="aiCtlScale" min={0} max={1} step={0.05} value={controlScale}
                    onChange={e => rs().patch({ controlScale: Number(e.target.value) })} />
                  <u>{controlScale.toFixed(2)}</u>
                </div></div>
              </div>
            )}
            <div className="hint" id="aiControlNote">
              {!attached.length
                ? <>Nothing attached — the reference image is all the model is given, and its
                  {' '}geometry is read as a suggestion. Drawn from the same vectors as the plan, so
                  {' '}a map costs nothing to send.</>
                : meta.acceptsControls.length
                  ? <>The <b>{listOf(attached)}</b> map goes into this model&rsquo;s control channel at
                    {' '}strength {controlScale.toFixed(2)} — a real constraint on the geometry, with a
                    {' '}dial. Not tuned: 0.75 is the vendor&rsquo;s default and the harness is what
                    {' '}moves it.</>
                  : <><b>{listOf(attached)}</b> {attached.length === 1 ? 'rides' : 'ride'} along as
                    {' '}extra reference {attached.length === 1 ? 'image' : 'images'}, named in the
                    {' '}prompt so the model does not paint the map itself. Whether it uses them as
                    {' '}geometry is unproven — this model has no control input, and the render is
                    {' '}what will tell us.</>}
              {dropped.length > 0 && (
                <>
                  {' '}<b>{listOf(dropped)}</b> {dropped.length === 1 ? 'is' : 'are'} not sent:
                  {meta.acceptsControls.length
                    ? ` this model takes one map at a time, and only ${orList(meta.acceptsControls)}.`
                    : ' two is the limit, because each map costs the brief a sentence in an opening'
                      + ' block that is read for about eighty words.'}
                </>
              )}
            </div>

            {subjects.length > 0 && (
              <div className="ai-photos" id="aiPhotos">
                <div className="row" style={{ marginBottom: 4 }}>
                  <span className="lbl">Photos</span>
                  <span className="ai-photos-count">
                    {slots === 0
                      ? `${meta.label} takes none`
                      : `${pics.length} of ${slots} slot${slots === 1 ? '' : 's'} used`}
                  </span>
                </div>
                {subjects.map(sub => (
                  <PhotoPick
                    key={sub.objId} subject={sub} slots={slots}
                    sent={pics.filter(a => a.objId === sub.objId)}
                    on={!off.has(sub.objId)}
                    onToggle={() => rs().patch({
                      photoOff: off.has(sub.objId)
                        ? photoOff.filter(id => id !== sub.objId)
                        : [...photoOff, sub.objId],
                    })}
                  />
                ))}
                <div className="hint" id="aiPhotoNote">
                  {slots === 0
                    ? <>{meta.label} has one image input and the plan is in it, so no photograph can
                      {' '}be sent. Switch to FLUX.2 to use them.</>
                    : pics.length < subjects.reduce((n, x) => n + x.photos.length, 0)
                      ? <>Every ticked object sends its first photo before any object sends a second.
                        {' '}What did not fit is untouched — render one room at a time to reach it.</>
                      : <>Each photo goes as its own reference image, named in the brief as the object
                        {' '}it shows. The plan still decides where things are; the photo decides what
                        {' '}they look like.</>}
                </div>
              </div>
            )}

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
              {selected ? `Render #${numberOf(selected.id)}${succeeded(selected) ? '' : ' — failed'}` : 'Reference image'}
            </span>
            <div className="ai-prev">
              {img ? <img id="aiImg" src={img} alt="clean floor plan reference" className={shown ? 'off' : ''} /> : null}
              {!img && !shown && <div className="empty"><p>This floor has nothing to draw yet.</p></div>}
              {shown && <img id="aiRender" src={fullUrlFor(shown)} alt={`render, seed ${shown.seed ?? 'unknown'}`} />}
              {job && (
                <div className="ai-run" id="aiRun">
                  <b>{elapsed}s</b>
                  <span>Rendering — this usually takes 20 to 60 seconds.</span>
                  {/* The second half of this sentence stopped being true in the
                      cloud: the job lives in a row now, so a reload picks it
                      back up. Locally it is still the plain truth. */}
                  <em>Keep working; closing this panel does not cancel it.{' '}
                    {cloud
                      ? 'A render in progress is picked back up if you reload.'
                      : 'A render in progress is lost if you reload or close the tab.'}</em>
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
                {succeeded(selected) && (
                  <button className="btn sm" id="aiDlRender" onClick={() => void downloadRender(selected)} title="Download this render"><Icon id="i-dl" /></button>
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
              {' '}Nothing on it is written: every object is named in the prompt instead, with
              {' '}where it sits. Anything we letter onto this picture gets drawn into the render —
              {' '}numbered discs came back as black roundels on the floor.
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
                const ok = succeeded(r);
                return (
                  <button key={r.id} data-id={r.id} className={`ai-cell${r.id === selectedId ? ' on' : ''}${ok ? '' : ' bad'}`}
                    onClick={() => rs().patch({ selectedId: r.id })}
                    title={r.error ?? `Render #${n}, seed ${r.seed ?? 'unknown'}`}>
                    {ok ? <img src={urlFor(r)} alt={`render ${n}`} /> : <Icon id="i-alert" />}
                    <b>#{n}</b>
                    <em>{r.seed ?? '—'}</em>
                    {from !== null && <u>from #{from}</u>}
                  </button>
                );
              })}
            </div>
            <div className="hint" id="aiLocal">
              {cloud
                ? <>Renders are kept in your account — they do not travel with a JSON export, so download
                  the ones worth keeping.</>
                : <>Renders live in this browser only — they do not travel with a JSON export, so download
                  the ones worth keeping.</>}
              {bytes > 0 && ` Every render ${cloud ? 'in your account' : 'on this browser'}: ${(bytes / 1048576).toFixed(1)} MB.`}
            </div>
          </div>
        </div>

        <div className="m-f">
          <button className="btn" id="aiRegen" onClick={rebuild}><Icon id="i-rot" />Rebuild prompt</button>
          <span className="hint mono" id="aiSession">
            {sessionCount} this session
          </span>
          <div className="spring" />
          <button className="btn" id="aiCopyImg" onClick={copyImage}><Icon id="i-copy" />Copy image</button>
          <button className="btn" id="aiDlImg" onClick={downloadImage}><Icon id="i-dl" />Image</button>
          <button className="btn" id="aiCopy" onClick={copyPrompt}><Icon id="i-copy" />Copy prompt</button>
          {/* Beside the button that spends it, not in a panel someone has to go and
              read: the size moved here from the session counter because the price
              is a function of it, and the two belong in one glance. */}
          {out && (
            <span className="hint mono" id="aiCost" title={`${meta.label} at ${out.width}×${out.height}`}>
              {usd(cost)} · {out.width}×{out.height}
              {attached.length ? ` · +${attached.length} map${attached.length === 1 ? '' : 's'}` : ''}
            </span>
          )}
          <button className="btn pri" id="aiGen" disabled={!canGenerate} onClick={() => void startRender(canvas)}>
            <Icon id="i-spark" />{job ? `Rendering ${elapsed}s` : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  );
}

export { planFacts };

/** One row of the object-photo list: a tick, a thumbnail, what it is, and the
 *  image number it will be in the request.
 *
 *  The number is the point of the row. Everything else in this panel can be
 *  understood without it, but the brief says "image 3 is the sofa" — and if the
 *  person cannot see which picture image 3 is, they have no way to tell a wrong
 *  render from a wrongly numbered one. */
function PhotoPick({ subject, slots, sent, on, onToggle }: {
  subject: PhotoSubject; slots: number; sent: AttachedPhoto[]; on: boolean; onToggle: () => void;
}) {
  const project = useEditor(s => s.project);
  const { url, missing } = usePhotoState(project?.id ?? '', subject.photos[0]?.id ?? '');
  /* Ticked but with nothing sent is the case worth showing: the object is in and
     the slots ran out before it. Silence there would read as "not chosen".
     `gone` is the worse case and the one that used to be invisible until
     Generate refused: the reference is in the document but the bytes are not on
     this device, because they were attached elsewhere or never finished
     uploading. */
  const state = missing ? 'gone' : !on ? 'off' : sent.length ? 'on' : 'full';
  return (
    <label className={`ai-photo ${state}`} data-obj={subject.objId}>
      <input type="checkbox" checked={on && !missing} disabled={slots === 0 || missing} onChange={onToggle} />
      <span className="ai-photo-shot">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url ? <img src={url} alt="" /> : <i />}
      </span>
      <span className="ai-photo-what">
        <b>{subject.label}</b>
        {subject.room ? <em>{subject.room}</em> : null}
      </span>
      <span className="ai-photo-n">
        {state === 'gone'
          ? 'not on this device'
          : state === 'on'
            ? sent.map(a => `image ${a.n}`).join(', ')
            : state === 'full'
              ? 'no slot left'
              : `${subject.photos.length} photo${subject.photos.length === 1 ? '' : 's'}`}
      </span>
    </label>
  );
}
