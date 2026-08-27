'use client';

import { useEffect, useState } from 'react';
import type { Item, PhotoRef } from '@engine/types';
import { labelOf, movePhoto, photosOf, resolveSel } from '@engine/model';
import { ed, useEditor, useSelection } from '@state/store';
import { MAX_PER_OBJECT, PHOTO_MAX_PX, addPhotos, dropPhoto } from '../photos';
import { Icon } from './Icons';
import { usePhotoState } from './photoUrls';

/** Managing the photographs on one object: which one leads, what each angle
 *  shows, and getting rid of the one from the wrong shop.
 *
 *  The object is looked up from `photoTarget` on every render rather than held
 *  in state. The document is mutated in place, so an object captured once would
 *  outlive its own deletion and the modal would go on editing something nothing
 *  draws — see the note on `photoTarget` in `src/state/store.ts`. */
export function PhotoModal() {
  const ref = useEditor(s => s.photoTarget);
  const floor = useEditor(s => s.floor());
  const project = useEditor(s => s.project);
  /* photos are pushed in place; this is what redraws the grid after every edit */
  useEditor(s => s.rev);
  /* Keeps the modal in step with the canvas: selecting another object with the
     panel open moves the panel to it rather than leaving it on the old one. */
  useSelection();
  const [busy, setBusy] = useState(false);

  const close = () => ed().patch({ modal: null, photoTarget: null });

  const found = ref && floor ? resolveSel(floor, [ref])[0] : undefined;
  const o = found && (found.t === 'item' || found.t === 'area') ? found.o : null;

  /* The object was deleted, or the floor changed under us: there is nothing left
     to manage. Closing happens in an effect rather than inline, because a store
     patch during render is a patch React has not finished the last one for —
     zustand would re-enter this component mid-render. */
  const gone = !!ref && !o;
  useEffect(() => { if (gone) close(); }, [gone]);

  if (!o || !project) return null;

  const photos = photosOf(o);
  const name = 'poly' in o ? (o.name || 'this room') : labelOf(o as Item) || 'this object';

  const take = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try { await addPhotos(o, files); } finally { setBusy(false); }
  };

  const move = (id: string, to: number) => {
    const s = ed();
    s.pushUndo();
    movePhoto(o, id, to);
    s.touch();
  };

  const setNote = (p: PhotoRef, v: string) => {
    const s = ed();
    /* No undo snapshot per keystroke — the description field on the toolbar
       takes one per change and it is the wrong bargain for a field people type
       a sentence into. One for the first keystroke of a run would need a timer;
       this is a note on a photo, and losing it to an undo is survivable. */
    if (v.trim()) p.note = v; else delete p.note;
    s.touch();
  };

  return (
    <div
      className="ov open" id="ovPhotos"
      onMouseDown={e => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="modal photos">
        <div className="m-h">
          <div style={{ flex: 1 }}>
            <h3>Photos of {name}</h3>
            <p className="hint">
              The render is given these pictures and told to reproduce the object in them.
              The first one is the one that goes when there are more photos than the
              image model has slots — use <em>Make first</em> to choose it.
            </p>
          </div>
          <button className="m-x" id="photosClose" onClick={close}><Icon id="i-x" /></button>
        </div>

        <div className="m-b photos-b">
          {!photos.length && (
            <p className="hint" id="photosEmpty">
              Nothing attached yet. A straight-on shot of the piece against a plain wall
              works better than a room photo with it in the corner.
            </p>
          )}

          <div className="photos-grid">
            {photos.map((p, i) => (
              <PhotoCard
                key={p.id} projectId={project.id} photo={p} index={i} count={photos.length}
                onFirst={() => move(p.id, 0)}
                onLeft={() => move(p.id, i - 1)}
                onRight={() => move(p.id, i + 1)}
                onNote={v => setNote(p, v)}
                onDelete={() => { void dropPhoto(o, p.id); }}
              />
            ))}
          </div>

          <div className="photos-foot">
            <label className="btn" id="photosAdd">
              <Icon id="i-plus" />
              <span>{busy ? 'Reading…' : 'Add photos'}</span>
              <input
                type="file" accept="image/*" multiple hidden disabled={busy || photos.length >= MAX_PER_OBJECT}
                onChange={e => { void take(e.target.files); e.target.value = ''; }}
              />
            </label>
            <p className="hint">
              {photos.length >= MAX_PER_OBJECT
                ? `${MAX_PER_OBJECT} is the most one object may carry.`
                : `Stored at ${PHOTO_MAX_PX} px on the long side — the size the render can actually send.`}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function PhotoCard({ projectId, photo, index, count, onFirst, onLeft, onRight, onNote, onDelete }: {
  projectId: string; photo: PhotoRef; index: number; count: number;
  onFirst: () => void; onLeft: () => void; onRight: () => void;
  onNote: (v: string) => void; onDelete: () => void;
}) {
  const { url, missing } = usePhotoState(projectId, photo.id);
  const kb = Math.max(1, Math.round(photo.bytes / 1024));
  return (
    <div className={`photo-card${index === 0 ? ' pri' : ''}`} data-photo={photo.id}>
      <div className="photo-shot">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url
          ? <img src={url} alt={photo.name ?? 'attached photo'} />
          : <i>{missing ? 'not on this device' : ''}</i>}
        {index === 0 && <b className="photo-badge">first</b>}
      </div>
      <input
        className="photo-note" data-note={photo.id}
        placeholder="what this angle shows — optional"
        defaultValue={photo.note ?? ''}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
        onChange={e => onNote(e.target.value)}
      />
      <div className="photo-acts">
        <button className="cb" title="Move earlier" disabled={index === 0} onClick={onLeft}>◀</button>
        <button className="cb" title="Move later" disabled={index === count - 1} onClick={onRight}>▶</button>
        <button className="cb" data-first={photo.id} title="Send this one first" disabled={index === 0} onClick={onFirst}>
          Make first
        </button>
        <span className="spring" />
        <em title={`${photo.w}×${photo.h} px`}>{kb} kB</em>
        <button className="cb warn" data-del={photo.id} title="Remove this photo" onClick={onDelete}>
          <Icon id="i-trash" />
        </button>
      </div>
    </div>
  );
}
