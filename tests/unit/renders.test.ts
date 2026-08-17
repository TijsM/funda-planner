// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';

/* jsdom's Blob is not structured-cloneable by Node, so a Blob written through
   fake-indexeddb comes back as an empty `{}` and every size assertion reads
   undefined. It is a defect of the environment, not of the store — swapping in
   the node:buffer Blob (which Node can clone) makes the bytes round-trip. */
(globalThis as unknown as { Blob: unknown }).Blob = NodeBlob;

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IDB_NAME, deleteDatabase, deleteRender, deleteRendersForProject, getRender, listRenders,
  pngFromBase64, putRender, renderBlob, succeeded, totalBytes,
  type RenderRecord, type RenderSettings,
} from '@shell/renders';

/* No network, no fetch, no timers: the store is IndexedDB and nothing else —
   except in the last block, where fetching a signed URL is the subject. */

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

/* ── the cloud-shaped record ─────────────────────────────────────── */

/** In cloud mode the bytes are in Storage, not in this browser, so a perfectly
 *  good render arrives with `blob: null` and a pair of signed URLs. Everything
 *  below exists because `rec.blob` used to be how the app asked "did this one
 *  work?" — a test that still passes with that question restored is not testing
 *  anything. */
describe('a render whose bytes live in Storage', () => {
  const cloud = (over: Partial<RenderRecord> = {}) => rec({
    blob: null, thumbnail: undefined,
    imageUrl: 'https://x.supabase.co/storage/v1/object/sign/renders/u/r.png?token=abc',
    thumbUrl: 'https://x.supabase.co/storage/v1/object/sign/renders/u/r-thumb.png?token=abc',
    ...over,
  });

  it('round-trips the signed URLs', async () => {
    const one = cloud();
    await putRender(one);
    const back = await getRender(one.id);
    expect(back).toMatchObject({ status: 'ready', imageUrl: one.imageUrl, thumbUrl: one.thumbUrl });
    expect(back?.blob).toBeNull();
  });

  it('counts as succeeded on its status, which is the only thing that survives both modes', () => {
    const ready = cloud();
    expect(succeeded(ready)).toBe(true);
    /* The bug this replaced: the old test was `!!rec.blob`, and it says the
       opposite about the very same record. */
    expect(Boolean(ready.blob)).toBe(false);

    expect(succeeded(rec({ blob: bytes(10) }))).toBe(true);
    expect(succeeded(cloud({ status: 'pending' }))).toBe(false);
    expect(succeeded(rec({ status: 'failed', blob: null, error: 'filtered' }))).toBe(false);
  });

  /* The quota warning is about this browser's disk. Bytes in a bucket are not on
     it, and counting them would nag about a limit that is not being approached. */
  it('adds nothing to the bytes held on this browser', async () => {
    await putRender(cloud({ id: 'cloud-1' }));
    expect(await totalBytes()).toBe(0);
    await putRender(rec({ id: 'local-1', blob: bytes(300) }));
    expect(await totalBytes()).toBe(300);
  });
});

describe('renderBlob', () => {
  const realFetch = globalThis.fetch;
  let asked: string[] = [];

  /** Answers one fetch, and records what was asked for — so "did not go to the
   *  network" is an assertion rather than a hope. */
  const answer = (res: Partial<Response> | Error) => {
    globalThis.fetch = (async (input: unknown) => {
      asked.push(String(input));
      if (res instanceof Error) throw res;
      return res as Response;
    }) as typeof fetch;
  };

  beforeEach(() => { asked = []; answer({ ok: true, blob: async () => bytes(512) }); });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('hands back local bytes without asking the network for them', async () => {
    const blob = await renderBlob(rec({ blob: bytes(64) }));
    expect(blob?.size).toBe(64);
    expect(asked).toEqual([]);
  });

  /* `<a download>` is ignored cross-origin — the browser navigates to the PNG
     instead of saving it — so the bytes have to come back here first. */
  it('downloads from the signed URL when there are no local bytes', async () => {
    const url = 'https://x.supabase.co/storage/v1/object/sign/renders/u/r.png?token=abc';
    const blob = await renderBlob(rec({ blob: null, imageUrl: url }));
    expect(blob?.size).toBe(512);
    expect(asked).toEqual([url]);
  });

  it('gives back nothing when there are neither bytes nor a URL', async () => {
    expect(await renderBlob(rec({ blob: null }))).toBeNull();
    expect(asked).toEqual([]);
  });

  /* An hour-old signed URL is a 400 from Storage, and the caller has to be able
     to say "that link has expired" rather than save an error page as a PNG. */
  it('gives back nothing when the link has expired', async () => {
    answer({ ok: false, status: 400 });
    expect(await renderBlob(rec({ blob: null, imageUrl: 'https://x.supabase.co/expired' }))).toBeNull();
  });

  it('gives back nothing when the network refuses outright', async () => {
    answer(new TypeError('Failed to fetch'));
    expect(await renderBlob(rec({ blob: null, imageUrl: 'https://x.supabase.co/offline' }))).toBeNull();
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
