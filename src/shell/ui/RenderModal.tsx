'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ed, useEditor, useSelection } from '@state/store';
import { buildPrompt, planFacts, type ViewKind } from '@engine/prompt';
import { polyArea } from '@engine/geometry';
import { fmtM2 } from '@engine/geometry';
import { slug } from '@engine/io/serialize';
import { renderFloorCanvas } from '../files';
import { Icon } from './Icons';

const VIEWS: { v: ViewKind; label: string }[] = [
  { v: 'top', label: 'Top-down' },
  { v: 'eye', label: 'Eye level' },
  { v: 'iso', label: 'Isometric' },
  { v: 'sketch', label: 'Sketch' },
];

export function RenderModal() {
  const project = useEditor(s => s.project);
  const floor = useEditor(s => s.floor());
  const sel = useSelection();

  const [view, setView] = useState<ViewKind>('top');
  const [room, setRoom] = useState('*');
  const [style, setStyle] = useState('');
  const [furniture, setFurniture] = useState(true);
  const [dimensions, setDimensions] = useState(true);
  const [roomLabels, setRoomLabels] = useState(false);
  /* On by default. Lettering on the conditioning image can bleed into a render,
     so the hint under the preview says so — but that is a trade-off to make at
     the point of use, not one to make silently on someone's behalf. */
  const [imgMeasures, setImgMeasures] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [img, setImg] = useState('');
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);

  const namedRooms = useMemo(
    () => (floor ? floor.areas.filter(a => a.name.trim() && polyArea(a.poly) > 10000) : []),
    [floor],
  );

  /* start from the room selected on the canvas, if there is one */
  useEffect(() => {
    const a = sel.find(s => s.t === 'area');
    if (a && namedRooms.some(r => r.id === a.o.id)) setRoom(a.o.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rebuild = useCallback(() => {
    if (!project || !floor) return;
    setPrompt(buildPrompt(project, floor, { view, room, style, furniture, dimensions }));
  }, [project, floor, view, room, style, furniture, dimensions]);

  useEffect(() => { rebuild(); }, [rebuild]);

  useEffect(() => {
    if (!floor) return;
    const cv = renderFloorCanvas(floor, {
      clean: true, furniture, roomLabels, measures: imgMeasures, maxPx: 1800,
    });
    setCanvas(cv);
    setImg(cv ? cv.toDataURL('image/png') : '');
  }, [floor, furniture, roomLabels, imgMeasures]);

  if (!project || !floor) return null;

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
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      /* suffix after slugging — slug() truncates, and it would eat it */
      a.download = `${slug(`${project.name}-${floor.name}`)}-reference.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      ed().toast('Reference image saved.', 'ok');
    }, 'image/png');
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
                  <button key={x.v} data-v={x.v} className={view === x.v ? 'on' : ''} onClick={() => setView(x.v)}>
                    {x.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="lbl">Room</span>
              <div className="fields"><div className="fld wide">
                <select id="aiRoom" value={room} onChange={e => setRoom(e.target.value)}>
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
                  value={style} onChange={e => setStyle(e.target.value)} onKeyDown={e => e.stopPropagation()} />
              </div></div>
            </div>

            <label className="tg">
              <input type="checkbox" id="aiFurn" checked={furniture} onChange={e => setFurniture(e.target.checked)} />
              <span className="sw2" /><span>List the furniture</span>
            </label>
            <label className="tg">
              <input type="checkbox" id="aiDims" checked={dimensions} onChange={e => setDimensions(e.target.checked)} />
              <span className="sw2" /><span>Measurements in the prompt</span>
            </label>
            <label className="tg">
              <input type="checkbox" id="aiImgDims" checked={imgMeasures} onChange={e => setImgMeasures(e.target.checked)} />
              <span className="sw2" /><span>Measurements on the image</span>
            </label>
            <label className="tg">
              <input type="checkbox" id="aiLabels" checked={roomLabels} onChange={e => setRoomLabels(e.target.checked)} />
              <span className="sw2" /><span>Room names on the image</span>
            </label>

            <textarea className="src" id="aiPrompt" spellCheck={false} style={{ height: 250, marginTop: 10 }}
              value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => e.stopPropagation()} />
            <div className="hint" id="aiCount" style={{ marginTop: 6 }}>
              {prompt.length} characters · {prompt.split('\n').length} lines
            </div>
          </div>

          <div className="ai-right">
            <span className="lbl">Reference image</span>
            <div className="ai-prev">{img ? <img id="aiImg" src={img} alt="clean floor plan reference" /> : null}</div>
            <div className="hint">
              Attach this to the generator alongside the prompt so it copies the exact layout.
              {imgMeasures && (
                <>
                  <br />Lettering on the reference can bleed into the render — turn
                  {' '}<b>Measurements on the image</b> off for the cleanest result.
                </>
              )}
            </div>
          </div>
        </div>

        <div className="m-f">
          <button className="btn" id="aiRegen" onClick={rebuild}><Icon id="i-rot" />Rebuild prompt</button>
          <div className="spring" />
          <button className="btn" id="aiCopyImg" onClick={copyImage}><Icon id="i-copy" />Copy image</button>
          <button className="btn" id="aiDlImg" onClick={downloadImage}><Icon id="i-dl" />Image</button>
          <button className="btn pri" id="aiCopy" onClick={copyPrompt}><Icon id="i-copy" />Copy prompt</button>
        </div>
      </div>
    </div>
  );
}

export { planFacts };
