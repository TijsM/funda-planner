import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER, MAX_USD_PER_IMAGE, PROVIDER_META, affordableDims, estimateUsd,
  maxAffordablePixels, metaOf, type ProviderMeta,
} from '@data/providers';
import { flux2Flex, flux2Max, bflUrl } from '@server/providers/bfl';
import { MISSING_FAL_KEY, falUrl, fluxGeneralCn, qwenEdit, zImageCn } from '@server/providers/fal';
import { PROVIDERS, ProviderError, providerOf } from '@server/providers';
import { assertAffordable, type GenerateArgs, type Provider } from '@server/providers/types';

/** The multi-provider render layer, offline and unpaid for.
 *
 *  Nothing here may reach a vendor: `fetch` is replaced wholesale rather than
 *  intercepted, so a mistake is a TypeError and never a request that costs
 *  $0.07. There is no FAL_KEY in this deployment either, which is not an
 *  obstacle to testing fal — it is most of what there is to test.
 */

const ARGS: GenerateArgs = {
  prompt: 'A photorealistic top-down view of the flat in the reference image.',
  imageBase64: 'UkVGRVJFTkNF',
  width: 960,
  height: 960,
  seed: 7,
};

const withControls = (over: Partial<GenerateArgs> = {}): GenerateArgs => ({
  ...ARGS,
  controls: [
    { kind: 'line', base64: 'TElORQ==' },
    { kind: 'depth', base64: 'REVQVEg=' },
  ],
  ...over,
});

const realFetch = globalThis.fetch;
const realFlux = process.env.FLUX_API_KEY;
const realFal = process.env.FAL_KEY;

/** Every provider's submit answered with a plausible acceptance, so the body it
 *  built is readable without anything leaving the machine. */
let sent: { url: string; init: RequestInit }[] = [];

function accept(payload: unknown, status = 200) {
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    sent.push({ url: String(input), init });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const bodyOf = (i = 0): Record<string, unknown> => JSON.parse(String(sent[i].init.body));

/** Awaits a call that must be refused and hands back the refusal. A call that
 *  resolves instead is a render somebody would have paid for, so it fails here
 *  rather than becoming an assertion against `undefined`. */
async function refusal(call: Promise<unknown>): Promise<ProviderError> {
  try { await call; } catch (e) { return e as ProviderError; }
  throw new Error('expected this to be refused, but it went through');
}

const BFL_OK = { id: 'job-1', polling_url: 'https://api.eu1.bfl.ai/v1/get_result?id=job-1' };
const FAL_OK = {
  request_id: 'req-1',
  status_url: 'https://queue.fal.run/fal-ai/z-image/turbo/controlnet/requests/req-1/status',
};

beforeEach(() => {
  sent = [];
  process.env.FLUX_API_KEY = 'test-flux-key';
  process.env.FAL_KEY = 'test-fal-key';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realFlux === undefined) delete process.env.FLUX_API_KEY; else process.env.FLUX_API_KEY = realFlux;
  if (realFal === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = realFal;
});

/* ── the spending ceiling ─────────────────────────────────────────── */

describe('the $0.10 ceiling', () => {
  /* The ceiling used to be a sentence in a brief. A render at 1800×1800 on [max]
     is $0.23 and nothing in the codebase would have stopped it. */
  it('prices a render by the output megapixels the vendor bills for', () => {
    const max = metaOf('flux2-max');
    expect(estimateUsd(max, 1000, 1000)).toBeCloseTo(0.07, 6);
    expect(estimateUsd(max, 832, 1168)).toBeCloseTo(0.068, 4);
    expect(estimateUsd(max, 1800, 1800)).toBeCloseTo(0.2268, 4);
  });

  it('lets the size the app actually asks for through on every provider', async () => {
    /* 1 MP is what outputDims() aims at in src/state/renders.ts. If the ceiling
       refused that, this whole layer would be unusable on the day it landed. */
    for (const p of PROVIDER_META) {
      expect(estimateUsd(p, 960, 960)).toBeLessThanOrEqual(MAX_USD_PER_IMAGE);
    }
  });

  it('refuses a render that would cost more than a dime, naming both numbers', async () => {
    accept(BFL_OK);
    await expect(flux2Max.submit({ ...ARGS, width: 1808, height: 1808 })).rejects.toMatchObject({
      status: 400,
    });
    /* Nothing was sent: the refusal has to happen before the credit, not after. */
    expect(sent).toHaveLength(0);

    const e = await refusal(flux2Max.submit({ ...ARGS, width: 1808, height: 1808 }));
    expect(e.message).toContain('FLUX.2 [max]');
    expect(e.message).toContain('1808×1808');
    expect(e.message).toContain('$0.229');
    expect(e.message).toContain('$0.100');
  });

  it('rounds up to whole megapixels for the provider that bills that way', () => {
    /* fal: "Images are billed by rounding up to the nearest megapixel." 1024×1024
       is 1.05 MP and costs what 2 MP costs — $0.15, over the ceiling. Priced as a
       fraction it would read as $0.079 and sail through. */
    const gen = metaOf('flux-general-cn');
    expect(estimateUsd(gen, 1000, 1000)).toBeCloseTo(0.075, 6);
    expect(estimateUsd(gen, 1024, 1024)).toBeCloseTo(0.15, 6);
    expect(estimateUsd(gen, 640, 640)).toBeCloseTo(0.075, 6);
    expect(maxAffordablePixels(gen)).toBe(1_000_000);
  });

  it('stops the rounding provider one step below the megapixel line', async () => {
    accept(FAL_OK);
    await expect(fluxGeneralCn.submit({ ...ARGS, width: 1024, height: 1024 })).rejects.toMatchObject({ status: 400 });
    expect(sent).toHaveLength(0);

    /* And the refusal names a size that does fit, so it is actionable. */
    const smaller = affordableDims(metaOf('flux-general-cn'), 1024, 1024)!;
    expect(smaller.width * smaller.height).toBeLessThanOrEqual(1_000_000);
    expect(estimateUsd(metaOf('flux-general-cn'), smaller.width, smaller.height))
      .toBeLessThanOrEqual(MAX_USD_PER_IMAGE);
  });

  it('says how big each provider may go, and never over the ceiling there either', () => {
    for (const p of PROVIDER_META) {
      const budget = maxAffordablePixels(p);
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(p.maxOutputPixels);
      /* The boundary itself must be affordable — an off-by-one here is a size the
         picker offers and the route then refuses. */
      const side = Math.floor(Math.sqrt(budget));
      expect(estimateUsd(p, side, side)).toBeLessThanOrEqual(MAX_USD_PER_IMAGE + 1e-9);
    }
  });

  it('refuses a provider that publishes no price at all', async () => {
    /* An unpriced call cannot be shown to be under a ceiling. The tempting bug is
       to treat a null rate as zero, which makes the most expensive provider on
       the list look like the cheapest. */
    const unpriced: ProviderMeta = {
      ...metaOf('flux2-max'), id: 'mystery', label: 'Mystery Model', usdPerMegapixel: null,
    };
    expect(estimateUsd(unpriced, 960, 960)).toBeNull();
    expect(maxAffordablePixels(unpriced)).toBe(0);

    let thrown: unknown;
    try { assertAffordable(unpriced, 960, 960); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).status).toBe(400);
    expect((thrown as ProviderError).message).toContain('publishes no price');
    expect((thrown as ProviderError).message).toContain('Mystery Model');
  });

  it('binds every provider to its own price rather than to the object it is read from', () => {
    /* The guard is only worth anything if it cannot be talked out of. Spreading a
       Provider into a cheaper-looking one must not change what its submit charges
       against — the closure holds the metadata, the object surface does not. */
    const spoofed: Provider = { ...flux2Max, usdPerMegapixel: 0.0001 };
    expect(estimateUsd(spoofed, 1808, 1808)).toBeCloseTo(0.000327, 6);
    accept(BFL_OK);
    return expect(spoofed.submit({ ...ARGS, width: 1808, height: 1808 }))
      .rejects.toMatchObject({ status: 400 });
  });
});

/* ── the registry ─────────────────────────────────────────────────── */

describe('the provider registry', () => {
  /* The browser cannot import src/server/**, so the picker reads
     src/data/providers.ts. Two lists that drift is a picker offering a provider
     the server has never heard of. */
  it('has exactly one Provider for every entry the browser can see', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(PROVIDER_META.map((p) => p.id).sort());
    for (const meta of PROVIDER_META) {
      expect(PROVIDERS[meta.id].usdPerMegapixel).toBe(meta.usdPerMegapixel);
      expect(PROVIDERS[meta.id].needsEnv).toBe(meta.needsEnv);
    }
  });

  it('falls back to the model existing renders were drawn with', () => {
    /* Every render row written before today has no provider id on it, and every
       one of those was a flux-2-max render. */
    expect(DEFAULT_PROVIDER).toBe('flux2-max');
    expect(providerOf(null).id).toBe('flux2-max');
    expect(providerOf(undefined).id).toBe('flux2-max');
    expect(providerOf('no-such-provider').id).toBe('flux2-max');
    expect(providerOf('z-image-cn').id).toBe('z-image-cn');
  });
});

/* ── what each provider actually sends ────────────────────────────── */

describe('the request bodies', () => {
  it('keeps BFL [max] sending exactly what it sent before', async () => {
    /* This layer is a refactor of a working call. Anything that changes here
       changes what today's users get for their credit. */
    accept(BFL_OK);
    const job = await flux2Max.submit(ARGS);
    expect(job).toMatchObject({ id: 'job-1', pollUrl: BFL_OK.polling_url });
    expect(sent[0].url).toBe('https://api.bfl.ai/v1/flux-2-max');
    expect((sent[0].init.headers as Record<string, string>)['x-key']).toBe('test-flux-key');

    const b = bodyOf();
    expect(b).toMatchObject({
      prompt: ARGS.prompt,
      input_image: 'UkVGRVJFTkNF',
      width: 960, height: 960, seed: 7,
      disable_pup: true, output_format: 'png', safety_tolerance: 2,
    });
    expect(b.input_image_2).toBeUndefined();
    /* [max] has no prompt_upsampling in its schema; sending one would be ignored
       upstream and would read here as though it did something. */
    expect('prompt_upsampling' in b).toBe(false);
  });

  it('turns the rewriter off with the field each model actually has', async () => {
    /* api.bfl.ai/openapi.json: Flux2Inputs has disable_pup (default false) and no
       prompt_upsampling; Flux2FlexInputs has prompt_upsampling (default TRUE) and
       no disable_pup. Neither sets additionalProperties, so FastAPI IGNORES the
       wrong one instead of rejecting it — send disable_pup to [flex] and the call
       succeeds, the rewriter stays on, and every flex render comes back with
       invented rooms while the body claims otherwise. Both directions are pinned
       here because only the absence catches that bug. */
    accept(BFL_OK);
    await flux2Flex.submit(ARGS);
    expect(sent[0].url).toBe('https://api.bfl.ai/v1/flux-2-flex');
    const b = bodyOf();
    expect(b.prompt_upsampling).toBe(false);
    expect('disable_pup' in b).toBe(false);
    /* Lower than BFL's own default of 5 — guidance is harmful early and
       unnecessary late (arXiv:2404.07724), and this product wants fidelity. */
    expect(b.guidance).toBeLessThan(5);
    expect(b.steps).toBe(50);
  });

  it('puts extra maps in FLUX.2 spare reference slots and says what they are', async () => {
    /* FLUX.2 has no control input, so a map can only ride along as another
       picture — and a picture nobody names is a picture the model may just
       reproduce as a second room. */
    accept(BFL_OK);
    await flux2Max.submit(withControls());
    const b = bodyOf();
    expect(b.input_image).toBe('UkVGRVJFTkNF');
    expect(b.input_image_2).toBe('TElORQ==');
    expect(b.input_image_3).toBe('REVQVEg=');
    expect(String(b.prompt)).toContain(ARGS.prompt);
    expect(String(b.prompt)).toContain('Image 2 is a line drawing');
    expect(String(b.prompt)).toContain('Image 3 is a depth map');
  });

  it('does not name the maps a second time when the brief already named them', async () => {
    /* `buildPrompt` emits its own map sentences, front-loaded, because BFL's guide
       says word order matters. Appending the legend on top of that sent every
       clause twice and a second copy of the spatial-arrangement line, and spent
       the documented 30-80 word window saying it. The app's copy wins; the legend
       stays for a prompt that names nothing, which is the harness's. */
    accept(BFL_OK);
    const brief = 'CAMERA AND OUTPUT\nKeep the exact spatial arrangement from image 1 — same'
      + ' composition, same positioning of elements.\nImage 2 is a line drawing of the same plan.'
      + ' Do not render it.';
    await flux2Max.submit(withControls({ prompt: brief }));
    const said = String(bodyOf().prompt);
    expect(said).toBe(brief);
    expect(said.match(/Image 2 is/g)).toHaveLength(1);
    expect(said.match(/Keep the exact spatial arrangement/g)).toHaveLength(1);
  });

  it('never lets a detector between our control map and z-image', async () => {
    /* preprocess defaults to a detector on some fal endpoints; with one in the
       path the model conditions on its Canny reading of our drawing rather than
       on our drawing, which is precisely the indirection this rebuild removes. */
    accept(FAL_OK);
    await zImageCn.submit(withControls());
    expect(sent[0].url).toBe('https://queue.fal.run/fal-ai/z-image/turbo/controlnet');
    expect((sent[0].init.headers as Record<string, string>).authorization).toBe('Key test-fal-key');

    const b = bodyOf();
    expect(b.preprocess).toBe('none');
    /* image_url IS the control channel on this endpoint — the line map, not the
       reference PNG. */
    expect(b.image_url).toBe('data:image/png;base64,TElORQ==');
    expect(b.control_scale).toBe(0.75);
    expect(b.num_inference_steps).toBe(8);
    expect(b.enable_prompt_expansion).toBe(false);
    expect(b.image_size).toEqual({ width: 960, height: 960 });
  });

  it('falls back to the reference drawing when z-image is given no map', async () => {
    /* The reference is already black lines on white, so it is a usable line map.
       Sending no image at all would be a 422 for a render the caller asked for. */
    accept(FAL_OK);
    await zImageCn.submit(ARGS);
    expect(bodyOf().image_url).toBe('data:image/png;base64,UkVGRVJFTkNF');
  });

  it('sends an explicit low strength to the img2img provider', async () => {
    /* fal's default strength is 0.85, a creative-transformation setting: at that
       value walls move, which is the drift this whole build is chasing. Omitting
       the field is therefore not neutral. */
    accept(FAL_OK);
    await fluxGeneralCn.submit(withControls());
    const b = bodyOf();
    expect(typeof b.strength).toBe('number');
    expect(b.strength as number).toBeLessThan(0.85);
    expect(b.strength as number).toBeLessThanOrEqual(0.7);
    expect(b.strength as number).toBeGreaterThan(0);
    expect(b.negative_prompt).toContain('dollhouse');
  });

  it('names real ControlNet weights and drops the kinds that have none', async () => {
    /* A guessed HuggingFace repo id fails at fal with a message about weights
       rather than about us, so seg and change are filtered out rather than sent. */
    accept(FAL_OK);
    await fluxGeneralCn.submit(withControls({
      controls: [{ kind: 'seg', base64: 'U0VH' }, { kind: 'depth', base64: 'REVQVEg=' }],
    }));
    const nets = bodyOf().controlnets as Record<string, unknown>[];
    expect(nets).toHaveLength(1);
    expect(nets[0].path).toBe('Shakker-Labs/FLUX.1-dev-ControlNet-Depth');
    expect(nets[0].control_image_url).toBe('data:image/png;base64,REVQVEg=');
    expect(nets[0].conditioning_scale).toBe(0.75);
  });

  it('sends flux-general exactly one control map even when handed several', async () => {
    /* fal's API reference annotates `controlnets` "supports one controlnet
       currently". Sending two matters more than it looks: if fal took the array
       and used only the first, the harness would file the result as a line+depth
       sweep having actually measured line — a wrong answer, not a failed one, and
       wrong answers are what this rebuild exists to stop producing. The caller's
       first usable kind is the one that goes, so ordering the list is how a sweep
       chooses. */
    accept(FAL_OK);
    await fluxGeneralCn.submit(withControls());
    const nets = bodyOf().controlnets as Record<string, unknown>[];
    expect(nets).toHaveLength(1);
    expect(nets[0].path).toBe('InstantX/FLUX.1-dev-Controlnet-Canny');
  });

  it('pins num_images so the ceiling is checked against what fal will bill', async () => {
    /* fal prices per megapixel per image and defaults num_images to 1, and
       z-image will draw four from one control input. assertAffordable only ever
       weighs one image, so if that default moved we would pay four times a price
       the guard had already approved. */
    accept(FAL_OK);
    for (const p of [zImageCn, fluxGeneralCn, qwenEdit]) {
      sent = [];
      await p.submit(ARGS);
      expect(bodyOf().num_images).toBe(1);
    }
  });

  it('hands qwen the reference first and at most three images in all', async () => {
    /* The cap is ours: fal documents no maximum for image_urls, so nothing stops
       an unbounded args.controls from turning one render into a multi-megabyte
       upload. The reference has to come first regardless — the legend in the
       prompt counts from "image 2". */
    accept(FAL_OK);
    await qwenEdit.submit(withControls({
      controls: [
        { kind: 'line', base64: 'TElORQ==' },
        { kind: 'depth', base64: 'REVQVEg=' },
        { kind: 'seg', base64: 'U0VH' },
      ],
    }));
    const b = bodyOf();
    expect(b.image_urls).toEqual([
      'data:image/png;base64,UkVGRVJFTkNF',
      'data:image/png;base64,TElORQ==',
      'data:image/png;base64,REVQVEg=',
    ]);
    expect(String(b.prompt)).toContain('Image 2 is a line drawing');
  });
});

/* ── keys and hosts ───────────────────────────────────────────────── */

describe('submitting', () => {
  /** A vendor that answers the submit with a redirect instead of a job. */
  function redirect(location: string) {
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      sent.push({ url: String(input), init });
      return new Response(null, { status: 302, headers: { location } });
    }) as typeof fetch;
  }

  /* The poll was hop-checked from the first day and the submit was not, which is
     the wrong way round: the submit is the request that carries the plan, the
     prompt AND the key. undici follows a redirect itself and strips only
     `authorization`, `cookie`, `proxy-authorization` and `host` across origins, so
     BFL's `x-key` — a custom header — rode along to whatever host the Location
     named, in cleartext if it downgraded to http. Asserting `redirect: 'manual'`
     is the only way to see that from here: a stubbed fetch never follows anything,
     so the bug is invisible to a test that only reads the response. */
  it('never asks the runtime to follow a redirect with the key attached', async () => {
    accept(BFL_OK);
    await flux2Max.submit(ARGS);
    expect(sent[0].init.redirect).toBe('manual');

    sent = [];
    accept(FAL_OK);
    await zImageCn.submit(ARGS);
    expect(sent[0].init.redirect).toBe('manual');
  });

  it('refuses a submit redirected off the vendor, and sends nothing to the new host', async () => {
    redirect('https://evil.example.com/collect');
    const bfl = await refusal(flux2Max.submit(ARGS));
    expect(bfl.message).toContain('Refusing to follow it');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('api.bfl.ai');

    sent = [];
    redirect('https://evil.example.com/collect');
    const fal = await refusal(zImageCn.submit(ARGS));
    expect(fal.message).toContain('Refusing to follow it');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('queue.fal.run');
  });

  /* And a legitimate hop still works — a submit that refused every redirect would
     break the day a vendor moved an endpoint, and "safe" that costs the feature is
     not the trade being made here. */
  it('follows a redirect that stays on the vendor', async () => {
    let hop = 0;
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      sent.push({ url: String(input), init });
      return hop++ === 0
        ? new Response(null, { status: 307, headers: { location: '/v2/flux-2-max' } })
        : new Response(JSON.stringify(BFL_OK), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    await expect(flux2Max.submit(ARGS)).resolves.toMatchObject({ id: 'job-1' });
    expect(sent).toHaveLength(2);
    expect(sent[1].url).toBe('https://api.bfl.ai/v2/flux-2-max');
    /* The body has to survive the hop, or the retry submits an empty prompt. */
    expect(JSON.parse(String(sent[1].init.body)).prompt).toBe(ARGS.prompt);
  });
});

describe('the missing key', () => {
  it('names the variable each provider needs, and spends nothing finding out', async () => {
    /* There is no FAL_KEY in this deployment at all, so this is the message every
       fal path really produces. A generic "not configured" would send whoever
       hits it looking through three files. */
    delete process.env.FLUX_API_KEY;
    delete process.env.FAL_KEY;
    accept(BFL_OK);

    for (const p of Object.values(PROVIDERS)) {
      const e = await refusal(p.submit(ARGS));
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.status).toBe(500);
      expect(e.message).toContain(p.needsEnv);
      expect(e.retryable).toBe(false);
    }
    expect(sent).toHaveLength(0);
    expect(MISSING_FAL_KEY).toContain('FAL_KEY');
  });

  it('refuses to poll fal without a key rather than polling anonymously', async () => {
    delete process.env.FAL_KEY;
    accept({ status: 'IN_QUEUE' });
    await expect(zImageCn.poll(FAL_OK.status_url)).rejects.toMatchObject({ status: 500 });
    expect(sent).toHaveLength(0);
  });
});

describe('the fal host allowlist', () => {
  it('accepts fal\'s own hosts and nothing that merely ends in them', () => {
    /* hostname.endsWith('fal.run') — the obvious spelling, minus the dot — also
       matches evilfal.run, a domain anybody can buy, and it would be handed
       FAL_KEY. */
    expect(falUrl('https://queue.fal.run/fal-ai/x/requests/1/status')).not.toBeNull();
    expect(falUrl('https://v3.fal.media/files/rabbit/abc.png')).not.toBeNull();
    expect(falUrl('https://fal.run/x')).not.toBeNull();

    expect(falUrl('https://evilfal.run/x')).toBeNull();
    expect(falUrl('https://fal.run.evil.com/x')).toBeNull();
    expect(falUrl('http://queue.fal.run/x')).toBeNull();
    expect(falUrl('https://api.bfl.ai/x')).toBeNull();
    expect(falUrl('not a url')).toBeNull();
    /* And the two allowlists stay separate — one provider's host check must never
       be reused for the other's key. */
    expect(bflUrl('https://queue.fal.run/x')).toBeNull();
    expect(falUrl('https://api.bfl.ai/v1/get_result')).toBeNull();
  });

  it('will not follow a redirect off fal with the key attached', async () => {
    /* undici strips authorization across origins but not custom headers, and it
       follows redirects itself — so checking the URL once was never enough. The
       only reason this is safe is that every hop is re-checked by hand. */
    globalThis.fetch = (async (input: unknown) => {
      sent.push({ url: String(input), init: {} });
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/collect' } });
    }) as typeof fetch;

    const e = await refusal(zImageCn.poll(FAL_OK.status_url));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toContain('Refusing to follow it');
    /* One request made, and none to evil.example.com. */
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('queue.fal.run');
  });

  it('follows a redirect that stays on fal', async () => {
    let hop = 0;
    globalThis.fetch = (async (input: unknown) => {
      sent.push({ url: String(input), init: {} });
      if (hop++ === 0) {
        return new Response(null, { status: 302, headers: { location: '/fal-ai/x/requests/1/status' } });
      }
      return new Response(JSON.stringify({ status: 'IN_PROGRESS', queue_position: 3 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    /* Queue position is not progress and is deliberately not reported as it —
       the UI counts elapsed seconds, which is the honest number. */
    await expect(zImageCn.poll(FAL_OK.status_url)).resolves.toEqual({ status: 'pending', progress: null });
    expect(sent).toHaveLength(2);
  });
});

/* ── polling fal ──────────────────────────────────────────────────── */

describe('polling fal', () => {
  /** Answers the status URL with one payload and the derived response URL with
   *  another, which is also the only way to check the response URL is derived at
   *  all rather than guessed. */
  function queue(status: unknown, response: unknown, responseStatus = 200) {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      sent.push({ url, init: {} });
      const body = url.endsWith('/response') ? response : status;
      return new Response(JSON.stringify(body), {
        status: url.endsWith('/response') ? responseStatus : 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  }

  it('collects the image from /response, derived from the polling URL', async () => {
    /* A render row carries one provider URL, so the response URL has to be worked
       out from the status URL. BFL's "Task not found" is what a hand-built URL
       against the wrong path looks like, which is why it is derived and rechecked
       rather than assumed. */
    queue({ status: 'COMPLETED' }, {
      images: [{ url: 'https://v3.fal.media/files/rabbit/out.png', width: 960, height: 960 }],
      seed: 7,
    });
    await expect(zImageCn.poll(FAL_OK.status_url)).resolves.toEqual({
      status: 'ready', imageUrl: 'https://v3.fal.media/files/rabbit/out.png', cost: null,
    });
    expect(sent[1].url).toBe('https://queue.fal.run/fal-ai/z-image/turbo/controlnet/requests/req-1/response');
  });

  it('treats a dead run as finished and failed, not as still queued', async () => {
    /* fal's status enum has no FAILED in it. Reading only the enum leaves a run
       that threw looking like IN_QUEUE forever — three minutes of polling for an
       image that will never exist. */
    queue({ status: 'IN_PROGRESS', error: 'CUDA out of memory' }, {});
    await expect(zImageCn.poll(FAL_OK.status_url)).resolves.toMatchObject({
      status: 'failed', retryable: false,
    });
    const r = await zImageCn.poll(FAL_OK.status_url);
    expect(r.status === 'failed' && r.error).toContain('CUDA out of memory');
  });

  it('reports a run that only fails at the response endpoint', async () => {
    queue({ status: 'COMPLETED' }, { detail: 'Inference failed: invalid control image' }, 500);
    const r = await zImageCn.poll(FAL_OK.status_url);
    expect(r.status).toBe('failed');
    expect(r.status === 'failed' && r.error).toContain('invalid control image');
  });

  it('does not blame the render for a rejected key at the collect step', async () => {
    /* The result is finished and sitting at fal; a 401 here is our configuration,
       not the image. Recording it as a failed render settles a row that could
       still have been collected, and spends the money twice. */
    queue({ status: 'COMPLETED' }, { detail: 'Invalid API key' }, 401);
    const e = await refusal(zImageCn.poll(FAL_OK.status_url));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toContain('FAL_KEY');
  });

  it('refuses an image fal hands back on somebody else\'s host', async () => {
    /* The status route downloads this URL server-side, so an attacker-controlled
       one turns it into a reader for anything the server can reach. */
    queue({ status: 'COMPLETED' }, { images: [{ url: 'https://evil.example.com/out.png' }] });
    const r = await zImageCn.poll(FAL_OK.status_url);
    expect(r.status).toBe('failed');
    expect(r.status === 'failed' && r.error).toContain('outside fal.media');
  });

  it('does not chase an unrecognised status round the poll loop', async () => {
    queue({ status: 'ASCENDED' }, {});
    const r = await zImageCn.poll(FAL_OK.status_url);
    expect(r.status).toBe('failed');
    expect(r.status === 'failed' && r.retryable).toBe(false);
  });
});
