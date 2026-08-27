import { describe, expect, it } from 'vitest';
import { attachedPhotos, photoSlots, subjectsInShot } from '@state/renders';
import { PROVIDER_META } from '@data/providers';
import type { PhotoSubject } from '@engine/prompt';
import { newCam } from '@engine/camera';
import { makeItem, newProject } from '@engine/model';
import type { Floor } from '@engine/types';

/** Who gets a reference slot, and in what order.
 *
 *  Every number here is a budget somebody pays for: a photograph that does not
 *  fit is furniture the render invents instead, and a photograph attached past
 *  the provider's schema is a 422 with a credit already spent. */

const sub = (objId: string, n: number, label = objId): PhotoSubject => ({
  objId,
  label,
  room: 'Living room',
  photos: Array.from({ length: n }, (_, k) => ({ id: `${objId}-${k}` })),
});

describe('photoSlots', () => {
  it('is the provider s spare inputs, less the maps that ride as references', () => {
    /* FLUX.2 takes eight images and the plan is one of them. */
    expect(photoSlots('flux2-max', [])).toBe(7);
    /* a map with nowhere else to go takes a photograph's slot */
    expect(photoSlots('flux2-max', ['line'])).toBe(6);
    expect(photoSlots('flux2-max', ['line', 'depth'])).toBe(5);
    /* two is all that ever rides along, so a third map costs nothing */
    expect(photoSlots('flux2-max', ['line', 'depth', 'seg'])).toBe(5);
  });

  it('is zero on a provider whose one image input IS the plan', () => {
    expect(photoSlots('z-image-cn', [])).toBe(0);
    expect(photoSlots('flux-general-cn', [])).toBe(0);
    /* and a map going into a real control channel does not change that */
    expect(photoSlots('z-image-cn', ['line'])).toBe(0);
  });

  it('leaves the control channel s own slot alone on a ControlNet provider', () => {
    /* The distinction that matters: `line` on z-image goes into the control
       channel, not into a reference slot — so it is `promptControls`, not
       `attachedControls`, that photographs compete with. */
    const meta = PROVIDER_META.find(p => p.id === 'z-image-cn')!;
    expect(meta.acceptsControls).toContain('line');
    expect(meta.maxReferences).toBe(1);
  });

  it('gives Qwen the two it actually has', () => {
    expect(photoSlots('qwen-edit', [])).toBe(2);
    expect(photoSlots('qwen-edit', ['line'])).toBe(1);
  });

  it('falls back to the default provider for an id it has never heard of', () => {
    expect(photoSlots('some-model-we-dropped', [])).toBe(photoSlots('flux2-max', []));
  });
});

describe('attachedPhotos', () => {
  it('numbers from image 2, because image 1 is always the plan', () => {
    const out = attachedPhotos('flux2-max', [], [sub('sofa', 1), sub('bed', 1)]);
    expect(out.map(a => [a.id, a.n])).toEqual([['sofa-0', 2], ['bed-0', 3]]);
  });

  /* The product decision, and the only one in this file: coverage before
     detail. Six objects specified once beats one sofa from six angles and a room
     full of invented furniture. */
  it('gives every object its first photo before any object gets a second', () => {
    const out = attachedPhotos('flux2-max', [], [sub('sofa', 3), sub('bed', 3), sub('desk', 3)]);
    expect(out.slice(0, 3).map(a => a.id)).toEqual(['sofa-0', 'bed-0', 'desk-0']);
    /* then the extras, in the same order round again */
    expect(out.slice(3, 6).map(a => a.id)).toEqual(['sofa-1', 'bed-1', 'desk-1']);
    expect(out).toHaveLength(7);
    /* and the numbering is contiguous, whatever the source */
    expect(out.map(a => a.n)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('never spends a slot on a second angle while an object has none', () => {
    /* Eight objects, seven slots: the eighth loses, and nothing gets two. */
    const subs = Array.from({ length: 8 }, (_, k) => sub(`o${k}`, 4));
    const out = attachedPhotos('flux2-max', [], subs);
    expect(out).toHaveLength(7);
    expect(out.every(a => a.id.endsWith('-0'))).toBe(true);
    expect(out.map(a => a.objId)).not.toContain('o7');
  });

  it('drops what the panel unticked, and nothing else', () => {
    const subs = [sub('sofa', 1), sub('bed', 1), sub('desk', 1)];
    const out = attachedPhotos('flux2-max', [], subs, new Set(['bed']));
    expect(out.map(a => a.objId)).toEqual(['sofa', 'desk']);
    /* the numbering closes up rather than leaving a hole where the bed was */
    expect(out.map(a => a.n)).toEqual([2, 3]);
  });

  it('sends nothing at all on a provider with no room for it', () => {
    expect(attachedPhotos('z-image-cn', [], [sub('sofa', 2)])).toEqual([]);
    expect(attachedPhotos('flux-general-cn', ['line'], [sub('sofa', 2)])).toEqual([]);
  });

  it('shrinks as maps are ticked, because they share the same slots', () => {
    const subs = Array.from({ length: 7 }, (_, k) => sub(`o${k}`, 1));
    expect(attachedPhotos('flux2-max', [], subs)).toHaveLength(7);
    expect(attachedPhotos('flux2-max', ['line'], subs)).toHaveLength(6);
    expect(attachedPhotos('flux2-max', ['line', 'depth'], subs)).toHaveLength(5);
    /* on Qwen there are two slots whatever is ticked */
    expect(attachedPhotos('qwen-edit', [], subs)).toHaveLength(2);
  });

  it('ignores an object that has no photograph', () => {
    const out = attachedPhotos('flux2-max', [], [sub('sofa', 0), sub('bed', 1)]);
    expect(out.map(a => a.objId)).toEqual(['bed']);
  });

  it('carries the label, the room and the note through to the brief', () => {
    const out = attachedPhotos('flux2-max', [], [{
      objId: 'sofa', label: 'sofa', room: 'Living room',
      photos: [{ id: 'p1', note: 'from the front' }],
    }]);
    expect(out[0]).toMatchObject({
      id: 'p1', objId: 'sofa', label: 'sofa', room: 'Living room', note: 'from the front', n: 2,
    });
  });
});

/* Every provider needs the number, because `photoSlots` reads it on all of them
   and an absent one would read as "no room" — silently sending nothing on a
   model that takes eight. */
describe('provider metadata', () => {
  it('states how many reference images every provider takes', () => {
    for (const p of PROVIDER_META) {
      expect(Number.isInteger(p.maxReferences), p.id).toBe(true);
      expect(p.maxReferences, p.id).toBeGreaterThanOrEqual(1);
    }
  });
});

/** Which photographs a render can honestly carry — and it is a question about
 *  the picture, not about the provider's budget above.
 *
 *  The rule this pins is WHEN the narrowing applies. `RenderModal` lists what
 *  will be sent and `jobs.ts` sends it; both go through this one function, and
 *  a panel that disagrees with the request about which image is the sofa is
 *  worse than either alone. */
describe('subjectsInShot', () => {
  const room = (): Floor => {
    const f = newProject('t').floors[0];
    const W = (ax: number, ay: number, bx: number, by: number) =>
      ({ id: `w${ax}${ay}${bx}${by}`, a: { x: ax, y: ay }, b: { x: bx, y: by }, t: 20, openings: [] });
    f.walls = [W(0, 0, 600, 0), W(600, 0, 600, 700), W(600, 700, 0, 700), W(0, 700, 0, 0)];
    f.items = [
      { ...makeItem('sofa3', { x: 300, y: 500 }), id: 'ahead' },
      { ...makeItem('sofa3', { x: 300, y: 40 }), id: 'behind' },
    ];
    return f;
  };
  const subs = [sub('ahead', 1), sub('behind', 1)];
  const cam = newCam({ x: 300, y: 100, z: 155, yaw: 90 });

  it('drops what the camera cannot see', () => {
    const out = subjectsInShot(room(), { view: 'eye', camera: cam }, subs);
    expect(out.map(x => x.objId)).toEqual(['ahead']);
  });

  /** Every object in scope is in a top-down or isometric picture, so there is
   *  nothing to narrow — and a stored camera must not quietly start deciding
   *  which photographs a plan drawing carries. */
  it('keeps everything on a view that has no camera in it', () => {
    for (const view of ['top', 'iso', 'sketch'] as const) {
      expect(subjectsInShot(room(), { view, camera: cam }, subs).map(x => x.objId), view)
        .toEqual(['ahead', 'behind']);
    }
  });

  it('keeps everything when no camera has been placed', () => {
    expect(subjectsInShot(room(), { view: 'eye', camera: null }, subs).map(x => x.objId))
      .toEqual(['ahead', 'behind']);
  });

  it('preserves the order the slots are meant to be spent in', () => {
    const f = room();
    f.items.push({ ...makeItem('coffee', { x: 300, y: 400 }), id: 'table' });
    const many = [sub('table', 1), sub('ahead', 1), sub('behind', 1)];
    expect(subjectsInShot(f, { view: 'eye', camera: cam }, many).map(x => x.objId))
      .toEqual(['table', 'ahead']);
  });

  /** The consequence that costs money: what is out of shot must not take a slot
   *  from what is in it. Two slots and three candidates, one of them behind the
   *  lens — the two in front should get them. */
  it('frees the slot an out-of-shot object would have taken', () => {
    const f = room();
    f.items.push({ ...makeItem('coffee', { x: 300, y: 400 }), id: 'table' });
    const all = [sub('behind', 1), sub('ahead', 1), sub('table', 1)];
    const seen = subjectsInShot(f, { view: 'eye', camera: cam }, all);
    /* 'behind' led the list and would have had the first slot of any budget */
    expect(attachedPhotos('flux2-max', [], seen).map(a => a.objId)).toEqual(['ahead', 'table']);
  });
});
