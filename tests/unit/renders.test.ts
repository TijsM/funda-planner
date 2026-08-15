// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';

/* jsdom's Blob is not structured-cloneable by Node, so a Blob written through
   fake-indexeddb comes back as an empty `{}` and every size assertion reads
   undefined. It is a defect of the environment, not of the store — swapping in
   the node:buffer Blob (which Node can clone) makes the bytes round-trip. */
(globalThis as unknown as { Blob: unknown }).Blob = NodeBlob;

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  IDB_NAME, deleteDatabase, deleteRender, deleteRendersForProject, getRender, listRenders,
  pngFromBase64, putRender, totalBytes, type RenderRecord, type RenderSettings,
} from '@shell/renders';

/* No network, no fetch, no timers: the store is IndexedDB and nothing else. */

const SETTINGS: RenderSettings = {
  view: 'top', room: '*', style: 'warm oak', furniture: true,
  dimensions: true, roomLabels: false, imgMeasures: true,
};

/** A blob of exactly `n` bytes, so totalBytes() can be asserted as an integer
 *  rather than "greater than zero". */
const bytes = (n: number) => new Blob([new Uint8Array(n)], { type: 'image/png' });

let seq = 0;
function rec(over: Partial<RenderRecord> = {}): RenderRecord {
  seq++;
  return {
    id: `r${seq}`,
    projectId: 'p1',
    floorId: 'f1',
    parentId: null,
    prompt: 'Reproduce exactly the layout in the reference image.',
    settings: SETTINGS,
    seed: 1234,
    model: 'flux-2-pro',
    status: 'ready',
    blob: bytes(100),
    createdAt: 1_700_000_000_000 + seq * 1000,
    durationMs: 24_000,
    ...over,
  };
}

const ids = (rows: RenderRecord[]) => rows.map(r => r.id);

beforeEach(async () => { await deleteDatabase(); });

describe('the render store', () => {
  it('names its database the way storage.ts names its keys', () => {
    expect(IDB_NAME).toBe('pgs.renders.v1');
  });

  it('round-trips a record, bytes included', async () => {
    const one = rec({ blob: bytes(2048), thumbnail: bytes(64), seed: 99 });
    expect(await putRender(one)).toBe(true);

    const back = await getRender(one.id);
    expect(back).not.toBeNull();
    /* The whole point of storing a render is being able to reproduce it, so the
       prompt, the settings and the seed matter as much as the pixels do. */
    expect(back).toMatchObject({
      id: one.id, projectId: 'p1', floorId: 'f1', prompt: one.prompt,
      seed: 99, model: 'flux-2-pro', status: 'ready', durationMs: 24_000,
    });
    expect(back?.settings).toEqual(SETTINGS);
    expect(back?.blob?.size).toBe(2048);
    expect(back?.thumbnail?.size).toBe(64);
  });

  it('upserts on id rather than growing a second row', async () => {
    const one = rec({ prompt: 'first' });
    await putRender(one);
    await putRender({ ...one, prompt: 'second' });

    const rows = await listRenders('p1', 'f1');
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt).toBe('second');
  });

  it('lists a floor newest first, and only that floor', async () => {
    const a = rec({ id: 'a', createdAt: 100 });
    const b = rec({ id: 'b', createdAt: 300 });
    const c = rec({ id: 'c', createdAt: 200 });
    const other = rec({ id: 'x', floorId: 'f2', createdAt: 400 });
    const elsewhere = rec({ id: 'y', projectId: 'p2', createdAt: 500 });
    for (const r of [a, b, c, other, elsewhere]) await putRender(r);

    expect(ids(await listRenders('p1', 'f1'))).toEqual(['b', 'c', 'a']);
    expect(ids(await listRenders('p1', 'f2'))).toEqual(['x']);
    expect(ids(await listRenders('p2', 'f1'))).toEqual(['y']);
    expect(await listRenders('p1', 'nope')).toEqual([]);
  });

  it('resolves a lineage back through parentId', async () => {
    const root = rec({ id: 'root' });
    const child = rec({ id: 'child', parentId: 'root' });
    const grand = rec({ id: 'grand', parentId: 'child' });
    for (const r of [root, child, grand]) await putRender(r);

    /* The filmstrip's "from #N" back-link is this pointer and nothing else, so
       walking it has to reach the root without the store knowing about trees. */
    const chain: string[] = [];
    let at: RenderRecord | null = await getRender('grand');
    while (at) {
      chain.push(at.id);
      at = at.parentId ? await getRender(at.parentId) : null;
    }
    expect(chain).toEqual(['grand', 'child', 'root']);
  });

  it('keeps a failed render, with no bytes and its reason', async () => {
    const bad = rec({ id: 'bad', status: 'failed', blob: null, error: 'The generated image was filtered. Re-roll the seed.' });
    await putRender(bad);

    const [row] = await listRenders('p1', 'f1');
    /* This record is the retry path — the toast is gone after 6.2 s and carries
       no button, so the prompt and settings have to survive here. */
    expect(row.blob).toBeNull();
    expect(row.status).toBe('failed');
    expect(row.error).toContain('Re-roll the seed');
    expect(row.prompt).toBe(bad.prompt);
  });

  it('deletes one render and leaves the rest', async () => {
    for (const r of [rec({ id: 'a' }), rec({ id: 'b' }), rec({ id: 'c' })]) await putRender(r);

    expect(await deleteRender('b')).toBe(true);
    expect(ids(await listRenders('p1', 'f1')).sort()).toEqual(['a', 'c']);
    expect(await getRender('b')).toBeNull();
    /* deleting something already gone is not an error worth surfacing */
    expect(await deleteRender('b')).toBe(true);
  });

  it('deletes every render of one project, across its floors', async () => {
    await putRender(rec({ id: 'a', projectId: 'p1', floorId: 'f1' }));
    await putRender(rec({ id: 'b', projectId: 'p1', floorId: 'f2' }));
    await putRender(rec({ id: 'k', projectId: 'p2', floorId: 'f1' }));

    await deleteRendersForProject('p1');
    expect(await listRenders('p1', 'f1')).toEqual([]);
    expect(await listRenders('p1', 'f2')).toEqual([]);
    expect(ids(await listRenders('p2', 'f1'))).toEqual(['k']);
  });

  it('counts every byte on the browser, thumbnails included', async () => {
    expect(await totalBytes()).toBe(0);
    await putRender(rec({ id: 'a', blob: bytes(1000), thumbnail: bytes(200) }));
    await putRender(rec({ id: 'b', projectId: 'p2', blob: bytes(500) }));
    /* a failed render has no bytes and must not be counted as if it did */
    await putRender(rec({ id: 'c', status: 'failed', blob: null }));

    expect(await totalBytes()).toBe(1700);
    await deleteRender('a');
    expect(await totalBytes()).toBe(500);
  });
});

describe('pngFromBase64', () => {
  /* 1×1 transparent PNG — the same bytes the e2e stub serves. */
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('decodes the base64 the status route sends back', async () => {
    const blob = pngFromBase64(PNG);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(Buffer.from(PNG, 'base64').byteLength);
    const head = new Uint8Array(await blob.arrayBuffer()).slice(0, 4);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47]);   // \x89PNG
  });

  it('tolerates a data: URL, because canvas.toDataURL() produces one', () => {
    expect(pngFromBase64(`data:image/png;base64,${PNG}`).size).toBe(pngFromBase64(PNG).size);
  });
});
