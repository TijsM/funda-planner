import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import type { NextRequest } from 'next/server';
import { PROVIDERS } from '@server/providers';
import { POST } from '../../app/api/render/route';
import { GET } from '../../app/api/render/status/route';

/** The two render routes, offline and unpaid for.
 *
 *  `fetch` is replaced wholesale rather than intercepted, exactly as in
 *  `providers.test.ts`: a guard that fails open has to show up here as a request
 *  recorded in `sent`, not as a $0.07 charge on somebody's card. Several tests
 *  therefore assert `sent` is EMPTY — for a refusal, where the money went is the
 *  behaviour under test and the status code is only how it was reported.
 *
 *  Everything runs in local mode. `isCloud()` reads NEXT_PUBLIC_SUPABASE_URL on
 *  every call, so deleting it here is enough to keep the cloud half out; the
 *  cloud half needs a request context for `cookies()` and cannot be reached from
 *  a unit test at all. Every guard these tests cover runs ahead of that branch,
 *  which is also why it has to stay ahead of it.
 */

/** A real PNG, because the route now reads the IHDR to bound how many megapixels
 *  a request may upload — a payload that is merely base64-shaped is refused
 *  before any of the pricing is reached, which is the point of that check. Drawn
 *  rather than hand-assembled so these fixtures are the same kind of file the
 *  browser actually sends. */
function png(width = 64, height = 64): string {
  const cv = createCanvas(width, height);
  const g = cv.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, width, height);
  return cv.toBuffer('image/png').toString('base64');
}

const REF = png();

/** A submit that should go through, so a test can change one thing about it. */
const OK = {
  prompt: 'A photorealistic top-down view of the flat in the reference image.',
  imageBase64: REF,
  width: 960,
  height: 960,
  seed: 7,
};

/* Both routes touch exactly one thing on the request each — `json()` on the
   submit, `nextUrl.searchParams` on the status — so these two shapes are the
   whole contract. Building a real NextRequest would drag Next's request plumbing
   into a unit test and prove nothing extra. */
const post = (body: unknown) => POST(new Request('http://localhost/api/render', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}) as unknown as NextRequest);

const get = (query: string) => GET(
  { nextUrl: new URL(`http://localhost/api/render/status?${query}`) } as unknown as NextRequest,
);

const said = async (res: Response): Promise<string> => {
  const body = await res.json() as { error?: string };
  return body.error ?? '';
};

const BFL_SUBMIT_OK = { id: 'job-1', polling_url: 'https://api.eu1.bfl.ai/v1/get_result?id=job-1' };
const FAL_SUBMIT_OK = {
  request_id: 'req-1',
  status_url: 'https://queue.fal.run/fal-ai/z-image/turbo/controlnet/requests/req-1/status',
};
const BFL_POLL = 'https://api.eu1.bfl.ai/v1/get_result?id=job-1';
const FAL_POLL = 'https://queue.fal.run/fal-ai/z-image/turbo/controlnet/requests/req-1/status';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

let sent: { url: string; init: RequestInit }[] = [];
/** What the stubbed vendor answers. Set per test; the default is a submit that
 *  was accepted, because most tests are about what happens before one. */
let respond: (url: string) => Response = (url) =>
  json(url.includes('fal.run') ? FAL_SUBMIT_OK : BFL_SUBMIT_OK);

const realFetch = globalThis.fetch;
const saved = { ...process.env };

beforeEach(() => {
  sent = [];
  respond = (url) => json(url.includes('fal.run') ? FAL_SUBMIT_OK : BFL_SUBMIT_OK);
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    sent.push({ url: String(input), init });
    return respond(String(input));
  }) as typeof fetch;
  process.env.FLUX_API_KEY = 'test-flux-key';
  process.env.FAL_KEY = 'test-fal-key';
  /* Local mode, for every test in this file. */
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

/* ── which provider draws it ─────────────────────────────────────── */

describe('POST /api/render — choosing a provider', () => {
  /* The one case that must not change: every client written before there was a
     picker sends no provider at all, and has to keep getting the model it has
     been paying for. A default that drifted would re-price every existing user's
     renders without a word. */
  it('renders on FLUX.2 [max] when the request names no provider at all', async () => {
    const res = await post(OK);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ jobId: 'job-1', provider: 'flux2-max' });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://api.bfl.ai/v1/flux-2-max');
  });

  /* `providerOf` falls back on purpose, because it reads ids off stored rows. A
     request is not a stored row: silently rendering on something else at another
     price is how a stale picker becomes an invoice nobody can explain. */
  it('refuses a provider it does not have, and names the ones it does', async () => {
    const res = await post({ ...OK, provider: 'flux-3-ultra' });
    expect(res.status).toBe(400);
    const msg = await said(res);
    expect(msg).toContain('flux-3-ultra');
    expect(msg).toContain('flux2-max');
    expect(msg).toContain('z-image-cn');
    expect(sent).toHaveLength(0);
  });

  /* The picker writes its choice into the render settings, which is what
     re-running a render reads back. If the route only read the plain field, a row
     whose settings say z-image-cn could be drawn by flux2-max at ten times the
     price — and nothing on the record would say so, which makes it unreproducible
     as well as expensive. */
  it('takes the provider from the render settings when that is the only place it is stated', async () => {
    const res = await post({ ...OK, settings: { provider: 'z-image-cn' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ provider: 'z-image-cn' });
    expect(sent[0].url).toBe('https://queue.fal.run/fal-ai/z-image/turbo/controlnet');
  });

  /* There is no FAL_KEY in this deployment, so this is the message every fal
     render actually produces today. It has to name the variable: "the provider
     rejected the request" sends the reader looking at the plan. */
  it('says which environment variable is missing rather than trying the call', async () => {
    delete process.env.FAL_KEY;
    const res = await post({ ...OK, provider: 'z-image-cn' });
    expect(res.status).toBe(500);
    expect(await said(res)).toContain('FAL_KEY');
    expect(sent).toHaveLength(0);
  });
});

/* ── the spending ceiling, at the boundary ───────────────────────── */

describe('POST /api/render — the $0.10 ceiling', () => {
  /* fal bills flux-general "by rounding up to the nearest megapixel", so
     1024×1024 is 1.05 MP and costs what 2 MP costs: $0.15. Priced as a fraction
     it would read $0.079 and sail through, which is the whole reason the ceiling
     is asserted at the route as well as inside submit(). The refusal has to carry
     both numbers and a size that does fit, or it is a dead end rather than an
     answer. */
  it('refuses a render that would cost more than a dime, with both figures and a size that fits', async () => {
    const res = await post({ ...OK, provider: 'flux-general-cn', width: 1024, height: 1024 });
    expect(res.status).toBe(400);
    const msg = await said(res);
    expect(msg).toContain('$0.150');
    expect(msg).toContain('$0.100');
    expect(msg).toContain('992×992');
    expect(sent).toHaveLength(0);
  });

  /* Nothing shipping is unpriced, and the route must not depend on that: an
     unpriced call cannot be shown to be under a ceiling, so it is refused before
     submit() is reached at all. Injected here rather than mocked, because what is
     under test is that the ROUTE refuses it — a provider whose own submit() would
     also have refused proves nothing about this file. */
  it('refuses a provider that publishes no price, without calling it', async () => {
    let calls = 0;
    PROVIDERS['test-unpriced'] = {
      ...PROVIDERS['flux2-max'],
      id: 'test-unpriced',
      label: 'Unpriced Test Provider',
      usdPerMegapixel: null,
      flatUsdPerImage: null,
      submit: async () => { calls += 1; throw new Error('the route paid for an unpriced render'); },
    };
    try {
      const res = await post({ ...OK, provider: 'test-unpriced' });
      expect(res.status).toBe(400);
      expect(await said(res)).toContain('publishes no price');
      expect(calls).toBe(0);
      expect(sent).toHaveLength(0);
    } finally {
      delete PROVIDERS['test-unpriced'];
    }
  });

  /* The model's ceiling and the budget's are different numbers. 4 MP is legal on
     every provider here and affordable on none of them, so both refusals have to
     exist — this one names the model's limit rather than a price. */
  it('refuses a size past the model\'s own ceiling before pricing it', async () => {
    const res = await post({ ...OK, width: 2048, height: 2048 });
    expect(res.status).toBe(400);
    expect(await said(res)).toContain('4 MP');
    expect(sent).toHaveLength(0);
  });

  /* Read off the resolved provider, not off a constant imported from bfl.ts —
     the step and the minimum are per-provider metadata now, and a route that
     kept BFL's copy would validate one vendor's rules against another's. */
  it('measures the requested size against the chosen provider\'s own step and minimum', async () => {
    const odd = await post({ ...OK, provider: 'z-image-cn', width: 970 });
    expect(odd.status).toBe(400);
    expect(await said(odd)).toContain('multiples of 16');

    const tiny = await post({ ...OK, provider: 'z-image-cn', width: 32, height: 32 });
    expect(tiny.status).toBe(400);
    expect(await said(tiny)).toContain('minimum is 64');
    expect(sent).toHaveLength(0);
  });
});

/* ── the conditioning maps ───────────────────────────────────────── */

describe('POST /api/render — control maps', () => {
  const map = (kind: string, base64 = png(32, 32)) => ({ kind, base64 });

  /* FLUX.2's acceptsControls is empty and it still takes input_image_2…_8. The
     route must NOT filter on that metadata: dropping the maps here would leave
     the multi-reference experiment quietly untested while the request said it had
     been run, which is a wrong answer rather than a failed one. */
  it('passes every map through to a provider whose metadata accepts none', async () => {
    /* One distinct size per map, so the assertion below is about which map landed
       in which slot rather than about four copies of the same picture. */
    const line = png(32, 32), depth = png(32, 34), seg = png(32, 36), change = png(32, 38);
    const res = await post({
      ...OK,
      controls: [map('line', line), map('depth', depth), map('seg', seg), map('change', change)],
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(String(sent[0].init.body)) as Record<string, string>;
    expect(body.input_image).toBe(REF);
    expect(body.input_image_2).toBe(line);
    expect(body.input_image_5).toBe(change);
    /* And the prompt says what each one is, or the extra pictures are unexplained. */
    expect(body.prompt).toContain('Image 5 is');
  });

  /* The per-image byte ceilings do not bound this and cannot: a PNG of a line
     drawing is mostly flat white, so five maps fit inside 8 MB of base64 and are
     still sixteen megapixels of upload. The ceiling prices output megapixels, and
     the vendor meters input ones separately — this is what keeps the gap between
     those two facts a known number. */
  it('refuses more uploaded megapixels than the input ceiling, counting every map', async () => {
    const big = png(2400, 2400);                    // 5.76 MP each, so three clear the 16 MP ceiling
    const res = await post({
      ...OK,
      imageBase64: big,
      controls: [map('line', big), map('depth', png(2400, 2398))],
    });
    expect(res.status).toBe(413);
    expect(await said(res)).toContain('megapixels of upload');
    expect(sent).toEqual([]);
  });

  it('refuses a payload that is base64 but not a PNG, before it costs anything', async () => {
    const res = await post({ ...OK, controls: [map('line', 'TElORQ==')] });
    expect(res.status).toBe(400);
    expect(await said(res)).toContain('not a PNG');
    expect(sent).toEqual([]);
  });

  /* The ceiling can only be asserted before the money leaves, so a vendor that
     charges more than we priced cannot be refused — it can only be reported. If
     that report is ever lost the ceiling becomes decorative: every render after
     the first would quietly cost more than the panel says, and the only evidence
     would be a line in a server log. */
  it('reports a vendor quote that came back over the ceiling', async () => {
    respond = () => json({ ...BFL_SUBMIT_OK, cost: 15 });   // 15 BFL credits = $0.15
    const res = await post(OK);
    expect(res.status).toBe(200);
    const body = await res.json() as { quotedUsd: number; overCeiling: boolean; estimatedUsd: number };
    expect(body.quotedUsd).toBeCloseTo(0.15, 6);
    expect(body.overCeiling).toBe(true);
    /* And it says what we thought it would cost, because the gap between the two
       is the thing that needs correcting in src/data/providers.ts. */
    expect(body.estimatedUsd).toBeLessThan(0.10);
  });

  it('says nothing about the ceiling when the quote is inside it', async () => {
    respond = () => json({ ...BFL_SUBMIT_OK, cost: 6 });    // $0.06
    const body = await (await post(OK)).json() as { overCeiling: boolean };
    expect(body.overCeiling).toBe(false);
  });

  /* fal quotes nothing at all, and a missing quote is not a quote of zero: with no
     unit to convert it is unconvertible, and pretending otherwise would report
     every fal render as comfortably under the ceiling on no evidence. */
  it('does not invent a quote for a vendor that publishes none', async () => {
    const body = await (await post({ ...OK, provider: 'z-image-cn' })).json() as
      { quotedUsd: number | null; overCeiling: boolean };
    expect(body.quotedUsd).toBeNull();
    expect(body.overCeiling).toBe(false);
  });

  it('refuses more maps than there are kinds of map', async () => {
    const res = await post({ ...OK, controls: [map('line'), map('depth'), map('seg'), map('change'), map('line')] });
    expect(res.status).toBe(400);
    expect(await said(res)).toContain('5 control maps');
    expect(sent).toHaveLength(0);
  });

  it('refuses a map that calls itself a kind that does not exist', async () => {
    const res = await post({ ...OK, controls: [map('normals')] });
    expect(res.status).toBe(400);
    const msg = await said(res);
    expect(msg).toContain('normals');
    expect(msg).toContain('line, depth, seg, change');
    expect(sent).toHaveLength(0);
  });

  it('refuses a map that is not base64 at all', async () => {
    const res = await post({ ...OK, controls: [map('line', 'https://example.com/line.png')] });
    expect(res.status).toBe(400);
    expect(await said(res)).toContain('not base64');
    expect(sent).toHaveLength(0);
  });

  /* Next buffers the body, caps it at 10 MB, and past that carries on with a
     PARTIAL body rather than failing — so an over-sized request is not refused
     upstream, it is silently cut in half and submitted as a corrupt PNG. Three
     3 MB maps are each legal on their own and are the case the per-image ceiling
     cannot see, which is why the total is counted as it accumulates. */
  it('refuses maps whose total would be truncated rather than rejected upstream', async () => {
    const big = 'A'.repeat(3 * 1024 * 1024);
    const res = await post({ ...OK, controls: [map('line', big), map('depth', big), map('seg', big)] });
    expect(res.status).toBe(413);
    const msg = await said(res);
    expect(msg).toContain('3 control maps');
    expect(msg).toContain('8 MB');
    expect(sent).toHaveLength(0);
  });

  it('refuses a single map past the per-image ceiling and names the kind', async () => {
    const res = await post({ ...OK, controls: [map('depth', 'A'.repeat(7 * 1024 * 1024))] });
    expect(res.status).toBe(413);
    expect(await said(res)).toContain('depth control map');
    expect(sent).toHaveLength(0);
  });

  /* The panel's dial is stored in the settings, and a dial the route drops is a
     dial that does nothing while appearing to work — the same class of failure as
     a control map that never gets attached. */
  it('carries the conditioning strength from the settings through to the provider', async () => {
    const res = await post({
      ...OK, provider: 'z-image-cn', controls: [map('line')], settings: { controlScale: 0.4 },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(String(sent[0].init.body)).control_scale).toBe(0.4);
  });
});

/* ── the guards that were already there ──────────────────────────── */

describe('POST /api/render — the guards the provider layer did not replace', () => {
  it('still refuses an empty prompt, a missing reference and a reference that is not base64', async () => {
    expect((await post({ ...OK, prompt: '  ' })).status).toBe(400);
    expect((await post({ ...OK, imageBase64: '' })).status).toBe(400);
    expect((await post({ ...OK, imageBase64: 'not base64!' })).status).toBe(400);
    expect((await post({ ...OK, width: undefined })).status).toBe(400);
    expect((await post({ ...OK, seed: -1 })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('still refuses a prompt past the character ceiling', async () => {
    const res = await post({ ...OK, prompt: 'x'.repeat(8001) });
    expect(res.status).toBe(400);
    expect(await said(res)).toContain('8000');
    expect(sent).toHaveLength(0);
  });
});

/* ── polling through the provider that was paid ──────────────────── */

describe('GET /api/render/status — one allowlist per provider', () => {
  /* The whole point of the interface. A URL is only safe against the vendor it
     was issued by: polling a fal job through BFL's client would put FLUX_API_KEY
     on a request to queue.fal.run, and a single shared allowlist — the obvious
     shortcut once there are two vendors — is exactly that bug written down. */
  it('refuses a fal polling URL for a job recorded as BFL', async () => {
    const res = await get(`provider=flux2-max&pollUrl=${encodeURIComponent(FAL_POLL)}`);
    expect(res.status).toBe(400);
    const msg = await said(res);
    expect(msg).toContain('FLUX.2 [max]');
    expect(sent).toHaveLength(0);
  });

  it('refuses a BFL polling URL for a job recorded as fal', async () => {
    const res = await get(`provider=z-image-cn&pollUrl=${encodeURIComponent(BFL_POLL)}`);
    expect(res.status).toBe(400);
    expect(await said(res)).toContain('Z-Image Turbo ControlNet');
    expect(sent).toHaveLength(0);
  });

  it('polls a fal job at fal, with fal\'s own key and header form', async () => {
    respond = () => json({ status: 'IN_QUEUE', queue_position: 3 });
    const res = await get(`provider=z-image-cn&pollUrl=${encodeURIComponent(FAL_POLL)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'pending' });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(FAL_POLL);
    /* "Key", not "Bearer", and never the BFL key. */
    expect((sent[0].init.headers as Record<string, string>).authorization).toBe('Key test-fal-key');
  });

  /* Every client that exists today polls with no provider parameter, so the
     fallback is not a nicety — it is the running app. */
  it('polls at BFL when the client names no provider, exactly as it did before', async () => {
    respond = () => json({ id: 'job-1', status: 'Pending', progress: 0.2 });
    const res = await get(`jobId=job-1&pollUrl=${encodeURIComponent(BFL_POLL)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'pending', progress: 0.2 });
    expect((sent[0].init.headers as Record<string, string>)['x-key']).toBe('test-flux-key');
  });

  /* The client has to send `provider` alongside `pollUrl` in local mode, and
     until it does every fal render dies at this check. The refusal therefore has
     to name the missing parameter rather than talk about BFL's hosts, which is
     what the person reading it would have no way to act on. */
  it('says the poll never named a provider, when the URL belongs to another one', async () => {
    const res = await get(`pollUrl=${encodeURIComponent(FAL_POLL)}`);
    expect(res.status).toBe(400);
    expect(await said(res)).toContain('Send provider=');
    expect(sent).toHaveLength(0);
  });

  it('refuses a provider it does not have here too', async () => {
    const res = await get(`provider=flux-3-ultra&pollUrl=${encodeURIComponent(BFL_POLL)}`);
    expect(res.status).toBe(400);
    expect(await said(res)).toContain('flux-3-ultra');
    expect(sent).toHaveLength(0);
  });

  it('will not poll a fal job without FAL_KEY, and says which variable', async () => {
    delete process.env.FAL_KEY;
    const res = await get(`provider=z-image-cn&pollUrl=${encodeURIComponent(FAL_POLL)}`);
    expect(res.status).toBe(500);
    expect(await said(res)).toContain('FAL_KEY');
    expect(sent).toHaveLength(0);
  });

  /* The finished image is fetched by this route, so the delivery host is a second
     allowlist and it belongs to the provider too. A `sample` on somebody else's
     domain would otherwise make this route a willing proxy for reading anything
     the server can reach — link-local metadata included. */
  it('refuses to download a finished render from a host outside the provider\'s own', async () => {
    respond = () => json({ id: 'job-1', status: 'Ready', result: { sample: 'https://evil.example/x.png' } });
    const res = await get(`jobId=job-1&pollUrl=${encodeURIComponent(BFL_POLL)}`);
    expect(res.status).toBe(502);
    expect(await said(res)).toContain('FLUX.2 [max]');
    expect(sent.map((s) => s.url)).not.toContain('https://evil.example/x.png');
    expect(sent).toHaveLength(1);
  });
});
