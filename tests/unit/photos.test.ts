// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';

/* Same swap as renders.test.ts, for the same reason: jsdom's Blob is not
   structured-cloneable by Node, so bytes written through fake-indexeddb come
   back as an empty `{}` and every size assertion reads undefined. */
(globalThis as unknown as { Blob: unknown }).Blob = NodeBlob;

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PER_OBJECT, PHOTO_MAX_PX, PHOTO_MIME, deletePhoto, deletePhotoDatabase,
  deletePhotosForProject, getPhoto, photoBase64, putPhoto, sweepOrphans,
} from '@shell/photos';
import { addPhotoRef, movePhoto, photosOf, referencedPhotoIds, removePhotoRef } from '@engine/model';
import { blankProject } from '@engine/model';
import type { Item, PhotoRef, Project } from '@engine/types';

/** The photo store and the document side of photos.
 *
 *  `encodePhoto` is NOT covered here and cannot be: it needs
 *  `createImageBitmap` and a real canvas encoder, neither of which jsdom has.
 *  What it does — EXIF rotation, the downscale, the white matte behind a
 *  transparent cut-out — is checked by eye and by `tests/e2e/15-photos.spec.js`,
 *  which runs in a browser that has both. */

const jpeg = (n: number) => new Blob([new Uint8Array(n)], { type: PHOTO_MIME });
const size = { w: 1024, h: 768 };

const ref = (id: string, over: Partial<PhotoRef> = {}): PhotoRef =>
  ({ id, w: 1024, h: 768, bytes: 1000, addedAt: 1, ...over });

let project: Project;
let sofa: Item;

beforeEach(async () => {
  await deletePhotoDatabase();
  project = blankProject('Photo plan', false);
  sofa = {
    id: 'sofa-1', kind: 'sofa3', x: 100, y: 100, w: 225, h: 95, rot: 0, label: 'Sofa',
  };
  project.floors[0].items.push(sofa);
});

afterEach(async () => {
  await deletePhotoDatabase();
});

describe('the photo store', () => {
  it('round-trips the bytes', async () => {
    expect(await putPhoto(project.id, 'p1', jpeg(1234), size)).toBe(true);
    const back = await getPhoto(project.id, 'p1');
    expect(back?.size).toBe(1234);
  });

  it('answers null for a photo it has never seen, rather than throwing', async () => {
    expect(await getPhoto(project.id, 'nope')).toBeNull();
  });

  it('deletes one photo and leaves its neighbours', async () => {
    await putPhoto(project.id, 'p1', jpeg(10), size);
    await putPhoto(project.id, 'p2', jpeg(20), size);
    await deletePhoto(project.id, 'p1');
    expect(await getPhoto(project.id, 'p1')).toBeNull();
    expect((await getPhoto(project.id, 'p2'))?.size).toBe(20);
  });

  /* A plan deleted from the library takes its photographs with it. They are
     keyed by plan, so anything left behind is unreachable from every screen and
     still occupying the quota. */
  it('drops every photo of one plan and none of another', async () => {
    await putPhoto(project.id, 'mine-1', jpeg(10), size);
    await putPhoto(project.id, 'mine-2', jpeg(10), size);
    await putPhoto('other-plan', 'theirs', jpeg(10), size);
    await deletePhotosForProject(project.id);
    expect(await getPhoto(project.id, 'mine-1')).toBeNull();
    expect(await getPhoto(project.id, 'mine-2')).toBeNull();
    expect(await getPhoto('other-plan', 'theirs')).not.toBeNull();
  });

  it('hands the bytes back as raw base64, with no data: container', async () => {
    /* 0xFF 0xD8 0xFF — the first three bytes of every JPEG, so the encoding is
       checked against a known payload rather than against itself. */
    const blob = new Blob([new Uint8Array([0xFF, 0xD8, 0xFF])], { type: PHOTO_MIME });
    await putPhoto(project.id, 'p1', blob, size);
    const b64 = await photoBase64(project.id, 'p1');
    expect(b64).toBe('/9j/');
    expect(b64).not.toMatch(/^data:/);
  });

  it('answers null when asked to encode a photo that is not there', async () => {
    expect(await photoBase64(project.id, 'ghost')).toBeNull();
  });

  it('keeps a photo big enough to be worth sending and small enough to fit', () => {
    /* Seven of these plus a 3 MP plan have to stay inside the route's 16 MP and
       8 MB ceilings — see MAX_INPUT_MEGAPIXELS in app/api/render/route.ts. */
    expect(PHOTO_MAX_PX).toBeLessThanOrEqual(1024);
    expect(7 * (PHOTO_MAX_PX * PHOTO_MAX_PX) + 3_240_000).toBeLessThan(16e6);
  });
});

describe('sweeping orphans', () => {
  /* Deleting an object deliberately leaves its bytes behind, because undo has to
     bring the object back and a paste of the same clipboard has to still find
     them. The age floor is what makes that safe. */
  it('leaves a photo the document still points at', async () => {
    await putPhoto(project.id, 'p1', jpeg(10), size);
    addPhotoRef(sofa, ref('p1'));
    expect(await sweepOrphans(project)).toBe(0);
    expect(await getPhoto(project.id, 'p1')).not.toBeNull();
  });

  it('leaves an unreferenced photo that is younger than a day', async () => {
    await putPhoto(project.id, 'p1', jpeg(10), size);
    /* nothing references it, but it was stored just now — an undo away */
    expect(await sweepOrphans(project)).toBe(0);
    expect(await getPhoto(project.id, 'p1')).not.toBeNull();
  });

  it('drops an unreferenced photo once it is older than a day', async () => {
    await putPhoto(project.id, 'p1', jpeg(10), size);
    /* backdate the row the way two days of not being undone would */
    const store = indexedDB.open('pgs.photos.v1');
    await new Promise<void>(r => { store.onsuccess = () => r(); });
    const db = store.result;
    await new Promise<void>(r => {
      const t = db.transaction('photos', 'readwrite');
      const os = t.objectStore('photos');
      const get = os.get('p1');
      get.onsuccess = () => {
        os.put({ ...get.result, addedAt: Date.now() - 3 * 24 * 3600 * 1000 });
      };
      t.oncomplete = () => r();
    });
    db.close();

    expect(await sweepOrphans(project)).toBe(1);
    expect(await getPhoto(project.id, 'p1')).toBeNull();
  });
});

describe('photo references on the document', () => {
  it('appends, because order is priority and a new photo is not the primary', () => {
    addPhotoRef(sofa, ref('a'));
    addPhotoRef(sofa, ref('b'));
    expect(photosOf(sofa).map(p => p.id)).toEqual(['a', 'b']);
  });

  it('removes the key entirely when the last photo goes', () => {
    addPhotoRef(sofa, ref('a'));
    removePhotoRef(sofa, 'a');
    expect(sofa.photos).toBeUndefined();
    /* and an absent list is still readable, without allocating */
    expect(photosOf(sofa)).toEqual([]);
    expect(photosOf(sofa)).toBe(photosOf(sofa));
  });

  it('moves a photo to the front, which is how "send this one" is said', () => {
    ['a', 'b', 'c'].forEach(id => addPhotoRef(sofa, ref(id)));
    movePhoto(sofa, 'c', 0);
    expect(photosOf(sofa).map(p => p.id)).toEqual(['c', 'a', 'b']);
    /* out-of-range clamps rather than losing the photo */
    movePhoto(sofa, 'c', 99);
    expect(photosOf(sofa).map(p => p.id)).toEqual(['a', 'b', 'c']);
    /* an id nothing holds changes nothing */
    movePhoto(sofa, 'ghost', 0);
    expect(photosOf(sofa).map(p => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('collects every referenced id across floors and rooms', () => {
    addPhotoRef(sofa, ref('a'));
    addPhotoRef(project.floors[0].areas[0], ref('room-1'));
    expect(referencedPhotoIds(project)).toEqual(new Set(['a', 'room-1']));
  });

  it('caps what one object may carry', () => {
    expect(MAX_PER_OBJECT).toBeGreaterThanOrEqual(2);
    expect(MAX_PER_OBJECT).toBeLessThanOrEqual(8);
  });
});
