import type { Area, Item, PhotoRef, Project } from '@engine/types';
import { uid } from '@engine/geometry';
import { addPhotoRef, photosOf, referencedPhotoIds, removePhotoRef } from '@engine/model';
import { isCloud } from '@data/config';
import { PHOTO_MIME } from '@data/providers';
import {
  deleteCloudPhoto, deleteCloudPhotosForPlan, downloadPhoto, uploadPhoto,
} from '@data/cloudPhotos';
import { ed } from '@state/store';
import { UNAVAILABLE, done, errName, idb, walk } from './idb';

/** The photographs attached to objects on the plan: the sofa that was actually
 *  bought, so the render draws that one and not a plausible one.
 *
 *  The bytes live here and nowhere near the document — see `PhotoRef` in
 *  `@engine/types` for why that is not a detail. The split is the same one
 *  `./renders.ts` makes, and so is the mode dispatch: IndexedDB locally, a
 *  private Storage bucket in the account, chosen per function on `isCloud()`.
 *
 *  In cloud mode the local database is still used, as a cache. That is free
 *  correctness rather than a risk: a photo id is minted once and its bytes never
 *  change, so a cached copy can be stale about nothing. It is what makes a strip
 *  of thumbnails draw without a round trip per tile, and what lets the render
 *  submit read seven photos without seven downloads. */

export const IDB_NAME = 'pgs.photos.v1';
export const IDB_VERSION = 1;
export const IDB_STORE = 'photos';
export const IDX_PROJECT = 'byProject';

/** The longest side a stored photo keeps.
 *
 *  1024 is not a guess about quality, it is the render request's budget. The
 *  route allows 16 megapixels of upload in total and 8 MB of base64; the plan
 *  itself is ~3 MP of that, and seven photos at this size are ~7 MP and under
 *  2 MB encoded. Storing the phone's original 12 MP would mean downscaling at
 *  submit time instead — the same picture, decoded twice, on the one code path
 *  where a mistake costs a credit. */
export const PHOTO_MAX_PX = 1024;

/** JPEG, always. A photograph is not line art, and PNG triples the bytes for
 *  nothing; the alpha of a retailer's cut-out is dealt with by matting onto
 *  white before the encode, not by keeping a channel the model cannot use.
 *
 *  Re-exported from `@data/providers` rather than declared here: the route and
 *  the fal body builder need the same string and neither may import this file. */
export { PHOTO_MIME };
const PHOTO_QUALITY = 0.86;

/** Per object. There are seven reference slots on the most generous provider we
 *  have, shared with every other object in the render, so a person who attaches
 *  more than a handful of angles to one chair is filing a mood board rather than
 *  specifying furniture — and paying for the storage. */
export const MAX_PER_OBJECT = 6;

/** Refused before the decode. A 60 MP raw file is not a furniture photo, and
 *  `createImageBitmap` on one is a tab that stops responding. */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

export interface StoredPhoto {
  id: string;
  /** the plan the photo belongs to — what a plan deletion sweeps on */
  projectId: string;
  blob: Blob;
  w: number; h: number;
  bytes: number;
  addedAt: number;
}

const store = idb({
  name: IDB_NAME,
  version: IDB_VERSION,
  upgrade: (d, oldVersion) => {
    if (oldVersion < 1) {
      const os = d.createObjectStore(IDB_STORE, { keyPath: 'id' });
      os.createIndex(IDX_PROJECT, 'projectId');
    }
  },
});

const reader = () => store.reader(IDB_STORE);
const write = (run: (s: IDBObjectStore) => void) => store.write(IDB_STORE, run);

/* ── the local half ──────────────────────────────────────────────── */

async function putLocal(row: StoredPhoto): Promise<boolean> {
  try {
    await write(s => { s.put(row); });
    return true;
  } catch (err) {
    /* Named causes, because the two survivable ones have different answers: a
       private window cannot be fixed by deleting anything, and a full quota
       can. Only reached as the *primary* store in local mode — in cloud mode
       this is a cache and its failure is silent by design. */
    if (isCloud()) return false;
    const s = ed();
    if (err instanceof Error && err.message === UNAVAILABLE) {
      s.toast('This browser will not open storage for photos — a private window blocks it. The photo cannot be kept.', 'err');
    } else if (errName(err) === 'QuotaExceededError') {
      s.toast('Browser storage is full, so that photo could not be kept. Delete a few renders from the filmstrip and try again.', 'err');
    } else {
      s.toast('This browser refused to store that photo.', 'err');
    }
    return false;
  }
}

async function getLocal(id: string): Promise<StoredPhoto | null> {
  try {
    const s = await reader();
    return (await done<StoredPhoto | undefined>(s.get(id))) ?? null;
  } catch { return null; }
}

/* ── the store, either mode ──────────────────────────────────────── */

/** Stores one photo's bytes. In cloud mode the account is the copy that counts
 *  and the local write is a cache — so the account's answer is the answer, and a
 *  cache miss is not a failure. */
export async function putPhoto(projectId: string, id: string, blob: Blob, size: { w: number; h: number }): Promise<boolean> {
  const row: StoredPhoto = {
    id, projectId, blob, w: size.w, h: size.h, bytes: blob.size, addedAt: Date.now(),
  };
  if (!isCloud()) return putLocal(row);

  const up = await uploadPhoto(projectId, id, blob);
  if (!up) {
    ed().toast('That photo could not be uploaded to your account. Check the connection and try again.', 'err');
    return false;
  }
  void putLocal(row);
  return true;
}

/** The bytes, wherever they live. Cache first in cloud mode, and the download
 *  back-fills it — which is what makes a plan opened on a second device draw its
 *  thumbnails once and then behave like the first. */
export async function getPhoto(projectId: string, id: string): Promise<Blob | null> {
  const local = await getLocal(id);
  if (local?.blob) return local.blob;
  if (!isCloud()) return null;

  const blob = await downloadPhoto(projectId, id);
  if (!blob) return null;
  /* Sized from the document rather than decoded again — the ref is the only
     place the dimensions are recorded, and a cache row exists to be read for its
     bytes, not for its metadata. */
  void putLocal({ id, projectId, blob, w: 0, h: 0, bytes: blob.size, addedAt: Date.now() });
  return blob;
}

export async function deletePhoto(projectId: string, id: string): Promise<void> {
  if (isCloud()) await deleteCloudPhoto(projectId, id);
  try { await write(s => { s.delete(id); }); } catch { /* the ref is gone either way */ }
}

/** For a plan being deleted. Mirrors `deleteRendersForProject` — bytes left
 *  behind are unreachable from any screen and still occupy the quota. */
export async function deletePhotosForProject(projectId: string): Promise<void> {
  if (isCloud()) await deleteCloudPhotosForPlan(projectId);
  try {
    await write(s => {
      walk<StoredPhoto>(s.index(IDX_PROJECT).openCursor(IDBKeyRange.only(projectId)), (_r, c) => { c.delete(); })
        .catch(() => { /* the transaction's own onerror is what rejects write() */ });
    });
  } catch { /* see deleteRendersForProject: the plan is already gone */ }
}

/** Photos of this plan that the document no longer points at.
 *
 *  Deleting an object must NOT delete its bytes — undo brings the object back,
 *  and so does a paste of the same clipboard — so the store outlives the
 *  reference on purpose. This is the other half of that bargain: a sweep on
 *  load, an age floor of a day, so nothing this session did can be swept while
 *  it is still undoable.
 *
 *  Local rows only. In cloud mode the account's copy is deliberately left alone:
 *  a plan is edited from more than one browser, and "no floor in the document I
 *  happen to be holding references this id" is not a fact one tab should be
 *  deleting another tab's uploads on. */
export async function sweepOrphans(p: Project): Promise<number> {
  if (!p) return 0;
  const live = referencedPhotoIds(p);
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let gone = 0;
  try {
    await write(s => {
      walk<StoredPhoto>(s.index(IDX_PROJECT).openCursor(IDBKeyRange.only(p.id)), (row, c) => {
        if (!live.has(row.id) && row.addedAt < cutoff) { c.delete(); gone++; }
      }).catch(() => { /* the transaction rejects write() itself */ });
    });
  } catch { return 0; }
  return gone;
}

/** Wipes the database — for tests, the e2e `fresh()` helper and sign-out. */
export const deletePhotoDatabase = (): Promise<void> => store.destroy();

/* ── taking a file in ────────────────────────────────────────────── */

export interface EncodedPhoto { blob: Blob; w: number; h: number }

/** Decodes, rotates, downscales, mattes and re-encodes one image file.
 *
 *  Four things happen here and each one is a bug if it does not:
 *  - `imageOrientation: 'from-image'` — a phone photo carries its rotation in
 *    EXIF, and a canvas that ignores it stores every portrait shot on its side.
 *  - the downscale to `PHOTO_MAX_PX`, which is the render request's budget.
 *  - the white matte, because a retailer's cut-out is a transparent PNG and a
 *    JPEG encode paints transparency black — a black background is exactly what
 *    the model would then reproduce around the object.
 *  - JPEG at 0.86, which is where a 1024 px furniture photo stops getting
 *    visibly better and keeps getting bigger. */
export async function encodePhoto(file: File | Blob): Promise<EncodedPhoto | null> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch { return null; }

  try {
    const k = Math.min(1, PHOTO_MAX_PX / Math.max(1, bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise<Blob | null>(r => cv.toBlob(r, PHOTO_MIME, PHOTO_QUALITY));
    return blob ? { blob, w, h } : null;
  } finally {
    bmp.close();
  }
}

/** Attaches files to one object, as one undo step.
 *
 *  The bytes are stored BEFORE the document is touched, and that order is the
 *  whole point: a reference to bytes that never landed is an object that shows a
 *  broken tile for the rest of the plan's life, and the render would name a
 *  photograph it cannot send. */
export async function addPhotos(o: Item | Area, files: ArrayLike<File>): Promise<number> {
  const s = ed();
  const project = s.project;
  if (!project) return 0;

  const list = Array.from(files);
  if (!list.length) return 0;

  const room = (o.photos ?? []).length;
  const space = Math.max(0, MAX_PER_OBJECT - room);
  if (!space) {
    s.toast(`That object already has ${MAX_PER_OBJECT} photos, which is the most one object may carry.`, 'err');
    return 0;
  }

  const taking = list.slice(0, space);
  const added: PhotoRef[] = [];
  const refused: string[] = [];

  for (const file of taking) {
    if (!/^image\//.test(file.type)) { refused.push(file.name || 'that file'); continue; }
    if (file.size > MAX_SOURCE_BYTES) { refused.push(`${file.name || 'that file'} (too large)`); continue; }

    const enc = await encodePhoto(file);
    /* The one failure worth naming precisely: an iPhone still hands out HEIC by
       default and no browser canvas will decode it, so "that is not an image" is
       both wrong and unactionable. */
    if (!enc) { refused.push(`${file.name || 'that file'} (the browser cannot read this format — HEIC needs exporting as JPEG)`); continue; }

    const id = uid();
    /* A store that refused the bytes is named in the summary, not just in
       whatever toast `putPhoto` raised on its way past. Silence here is how four
       photographs became three without anybody noticing: the upload failed, the
       reference was correctly not written, and the only account of it was one
       toast among several that had already scrolled. */
    if (!(await putPhoto(project.id, id, enc.blob, enc))) {
      refused.push(`${file.name || 'that file'} (could not be stored)`);
      continue;
    }
    added.push({
      id,
      name: file.name || undefined,
      w: enc.w, h: enc.h,
      bytes: enc.blob.size,
      addedAt: Date.now(),
    });
  }

  if (added.length) {
    /* One snapshot for the batch, taken now that the bytes are safely stored. */
    s.pushUndo();
    added.forEach(p => addPhotoRef(o, p));
    s.touch();
    s.toast(added.length === 1
      ? 'Photo attached — it will be sent with the render.'
      : `${added.length} photos attached.`, 'ok');
  }
  if (list.length > taking.length) {
    refused.push(`${list.length - taking.length} more (only ${MAX_PER_OBJECT} photos fit on one object)`);
  }
  if (refused.length) s.toast(`Not added: ${refused.join(', ')}.`, 'err');
  return added.length;
}

/** A stored photo as the render request wants it: raw base64, no container.
 *
 *  Same convention as `pngBase64` in ./files.ts and for the same reasons — the
 *  route strips a prefix off everything it is given, and the eval harness talks
 *  to providers without going through the route at all, where a container that
 *  reaches the vendor is a 422 with a credit already spent. */
export async function photoBase64(projectId: string, id: string): Promise<string | null> {
  const blob = await getPhoto(projectId, id);
  if (!blob) return null;
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  /* Chunked: `String.fromCharCode(...bytes)` on a 200 kB photo is 200 000
     arguments in one call, which throws a range error rather than being slow. */
  let raw = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    raw += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(raw);
}

/** Removes one photo from an object, and its bytes with it — unless another
 *  object still points at the same id.
 *
 *  That last clause is not defensive coding, it is the duplicate case: ⌘D and a
 *  paste both deep-clone an item and mint a fresh item id while KEEPING its
 *  photo refs, so two chairs routinely share one photograph. Deleting the bytes
 *  on the first of them would blank the tile on the second, and there is no
 *  getting them back. */
export async function dropPhoto(o: Item | Area, id: string): Promise<void> {
  const s = ed();
  const project = s.project;
  if (!project) return;
  s.pushUndo();
  removePhotoRef(o, id);
  s.touch();
  /* After the document, not before: the tile has to disappear on the click, and
     the delete is a background tidy-up whose failure costs bytes, not a photo. */
  if (!referencedPhotoIds(project).has(id)) await deletePhoto(project.id, id);
}

/** Copies the bytes of photos pasted in from ANOTHER plan into this one, under
 *  fresh ids, and drops the references it cannot honour.
 *
 *  Why it has to exist: a `PhotoRef` names bytes stored per plan — in the
 *  account under `owner/plan/photo.jpg` — so a chair pasted into a second plan
 *  arrives pointing at a key that plan does not have. Without this the tile is
 *  grey forever and the render quietly sends one photo fewer than the panel
 *  promised.
 *
 *  Fresh ids rather than a second reference to the same object: the two plans
 *  are then independent, and deleting the photo in one cannot empty a tile in
 *  the other. The cost is a duplicated 200 kB, which is the right trade.
 *
 *  Best effort by design. Pasting into a browser that never held the source
 *  plan cannot conjure the bytes, and a reference to nothing is worse than no
 *  reference: it is a promise the render panel would repeat. */
export async function adoptPhotos(from: string, objects: (Item | Area)[]): Promise<void> {
  const s = ed();
  const project = s.project;
  if (!project || from === project.id) return;

  let copied = 0, lost = 0;
  for (const o of objects) {
    for (const ref of photosOf(o).slice()) {
      const blob = await getPhoto(from, ref.id);
      const id = uid();
      if (blob && await putPhoto(project.id, id, blob, { w: ref.w, h: ref.h })) {
        ref.id = id;
        copied++;
      } else {
        removePhotoRef(o, ref.id);
        lost++;
      }
    }
  }
  if (copied || lost) s.touch();
  if (lost) {
    s.toast(lost === 1
      ? 'One pasted object came from another plan and its photo is not on this device, so the photo was dropped.'
      : `${lost} pasted photos came from another plan and are not on this device, so they were dropped.`, 'err');
  }
}
