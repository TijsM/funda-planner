import 'server-only';

import {
  MAX_USD_PER_IMAGE, affordableDims, estimateUsd,
  type ControlKind, type ProviderMeta,
} from '@data/providers';

/** The shape every image provider is squeezed into, plus the plumbing that used
 *  to live alone in `bfl.ts` and now has two callers.
 *
 *  The split is deliberate: `src/data/providers.ts` holds everything the browser
 *  is allowed to see (names, prices, limits) and this file holds everything that
 *  touches a key or a socket. Both halves therefore agree on what a provider
 *  costs by construction rather than by two people remembering to edit two files.
 */

export type { ControlKind, ProviderMeta };
export { MAX_USD_PER_IMAGE, affordableDims, billedMegapixels, estimateUsd, maxAffordablePixels }
  from '@data/providers';

/** One conditioning map, raw base64 with no `data:` prefix — the same convention
 *  as the reference image, so callers never have to remember which is which. */
export interface ControlImage {
  kind: ControlKind;
  base64: string;
}

export interface GenerateArgs {
  prompt: string;
  /** the reference PNG, raw base64 */
  imageBase64: string;
  controls?: ControlImage[];
  width: number;
  height: number;
  seed: number | null;
  /** 0..1, normalised across providers — how hard the control map pulls */
  controlScale?: number;
  /** 0..1, how much of the reference the model may change */
  strength?: number;
}

export interface SubmitResult {
  id: string;
  pollUrl: string;
  /** whatever the vendor quoted at submit, in its own unit — BFL credits, where
   *  1 credit = $0.01. Null when the vendor quotes nothing, which is most of
   *  them; it is a receipt, not an estimate, so nothing is invented into it. */
  cost: number | null;
  /** what `estimateUsd` said this would cost before it was submitted. Separate
   *  from `cost` precisely so the row can tell "we expected" from "we were
   *  charged". */
  usd?: number | null;
  /** The vendor's own quote converted to dollars, when its unit is known
   *  (`quoteUsdPerUnit`). This is the only number in the system that can catch
   *  the ceiling being wrong about what a render costs — `usd` is our arithmetic
   *  checking itself, while this is the vendor disagreeing with us. */
  quotedUsd?: number | null;
  /** What the vendor says it metered, when it says. BFL answers `input_mp` and
   *  `output_mp` at submit, and the open question this feature raised is whether
   *  input megapixels are billed at all: their pricing page prices output
   *  resolution only, but a request now carries a reference plus up to four
   *  control maps, so if that is ever wrong the ceiling is wrong with it. Logged
   *  on every submit so the first real render answers it instead of a guess. */
  metered?: { inputMp: number | null; outputMp: number | null };
}

export type PollResult =
  | { status: 'pending'; progress: number | null }
  | { status: 'ready'; imageUrl: string; cost: number | null }
  | { status: 'failed'; error: string; retryable: boolean };

export interface Provider extends ProviderMeta {
  submit(args: GenerateArgs): Promise<SubmitResult>;
  poll(pollUrl: string): Promise<PollResult>;
  /** The host check for the finished image, which is not the same allowlist as
   *  the polling host: BFL delivers on `delivery.*.bfl.ai` and fal on
   *  `*.fal.media`. Not in the original contract — it is here because the status
   *  route has to fetch the bytes itself (neither vendor sends CORS headers) and
   *  without this it would have to hardcode one vendor's domains, which is the
   *  bug this whole refactor exists to remove. */
  deliveryUrl(raw: string): URL | null;
  /** The hosts this provider's API key may be sent to — a subset of
   *  `deliveryUrl`, because the finished file comes back on a CDN the key has no
   *  business visiting. The status route checks a caller-supplied polling URL
   *  against THIS, not against the delivery guard: fal's CDN is fal.media and
   *  its queue is fal.run, so the wider guard would have let a caller name a
   *  media address and have us attach FAL_KEY to it. */
  keyedUrl(raw: string): URL | null;
  /** Downloads a checked delivery URL with no API key attached, re-checking
   *  every redirect hop against the same allowlist. */
  fetchDelivery(src: URL, init?: RequestInit): Promise<Response>;
}

/** A provider failure already phrased for the person waiting on the render, with
 *  the HTTP status the route should answer and whether trying again can help. */
export class ProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, message: string, retryable: boolean) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
  }
}

/* ── the ceiling ─────────────────────────────────────────────────── */

const EPS = 1e-9;

const money = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;

/** Refuses any render that would cost more than `MAX_USD_PER_IMAGE`, and any
 *  render on a provider that publishes no price at all — an unpriced call cannot
 *  be shown to be under a ceiling, and "probably cheap" is not a budget.
 *
 *  Called inside every `submit()` rather than only at the route, because the
 *  ceiling is a property of spending money and the route is not the only thing
 *  that can spend it (the eval harness calls providers directly). */
export function assertAffordable(p: ProviderMeta, width: number, height: number): void {
  const usd = estimateUsd(p, width, height);
  if (usd === null) {
    throw new ProviderError(
      400,
      `${p.label} publishes no price per image, so a render on it cannot be shown to cost less than the ${money(MAX_USD_PER_IMAGE)} ceiling. Pick a provider with a published rate.`,
      false,
    );
  }
  if (usd <= MAX_USD_PER_IMAGE + EPS) return;

  const smaller = affordableDims(p, width, height);
  const room = smaller
    ? ` The largest ${p.label} can draw inside it is about ${smaller.width}×${smaller.height}.`
    : ` There is no size ${p.label} can draw inside it.`;
  const mp = (width * height) / 1e6;
  throw new ProviderError(
    400,
    `${width}×${height} is ${mp.toFixed(2)} megapixels, which on ${p.label} would cost about ${money(usd)} — over the ${money(MAX_USD_PER_IMAGE)} ceiling for a single image.${room}`,
    false,
  );
}

/* ── reading what a vendor answered ──────────────────────────────── */

export function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}
export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export async function jsonBody(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return null; }
}

/** FastAPI answers 422 two different ways: `detail` is a list of
 *  `{loc, msg, type}` for field validation, and a bare string for everything it
 *  rejects earlier — BFL's invalid-key rejection arrives as the string form.
 *  Both are the developer's own bug, so both go through verbatim. Shared because
 *  fal is FastAPI too and answers a bad body in exactly the same shape. */
export function detailMsg(payload: unknown): string | null {
  const d = obj(payload)?.detail;
  if (typeof d === 'string') return d.trim() || null;
  if (Array.isArray(d)) {
    const first = obj(d[0]);
    return first ? str(first.msg) : null;
  }
  return null;
}

/** Free-form vendor detail ends up in a toast, where a pretty-printed object is
 *  unreadable. Flatten it to one clause and cap it. */
export function detailLine(v: unknown): string {
  const d = obj(v);
  if (!d) return '';
  const reasons = d['Moderation Reasons'];
  const text = Array.isArray(reasons)
    ? reasons.map(String).join('; ')
    : Object.entries(d).map(([k, val]) => `${k}: ${typeof val === 'string' ? val : JSON.stringify(val)}`).join('; ');
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return ` The provider said: ${flat.length > 300 ? `${flat.slice(0, 299)}…` : flat}`;
}

/** A refused connection, DNS failure or our own AbortSignal — never a status
 *  code, so it cannot go through a status-code table. */
export function transportFailure(e: unknown, what: string): ProviderError {
  const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
  return new ProviderError(
    504,
    timedOut
      ? `The image provider did not answer the ${what} within the timeout.`
      : `Could not reach the image provider to ${what} (${e instanceof Error ? e.message : 'unknown network error'}).`,
    true,
  );
}

/* ── redirects ───────────────────────────────────────────────────── */

/** Matches `host` itself and anything under it, and nothing else. Written as a
 *  function because `hostname.endsWith('fal.run')` — the obvious spelling, minus
 *  the dot — also matches `evilfal.run`, and that is a bug you only find by
 *  being handed the URL. */
export function underHost(hostname: string, host: string): boolean {
  return hostname === host || hostname.endsWith(`.${host}`);
}

export type UrlGuard = (raw: string) => URL | null;

/** fetch() follows redirects itself, and undici strips only `authorization`,
 *  `cookie`, `proxy-authorization` and `host` when a redirect crosses an origin
 *  — a custom header rides along. So `x-key` on a checked vendor URL that
 *  answers 302 lands on whatever host the Location names, in cleartext if it
 *  downgrades to http. Checking the URL once was never enough: every hop gets
 *  the same check, by hand.
 *
 *  `offHost` is the vendor's own sentence because this refusal is shown to the
 *  person waiting, and "redirected off the allowlist" tells them nothing. */
export async function hopSafeFetch(
  url: URL, init: RequestInit, guard: UrlGuard, offHost: string, hops = 3,
): Promise<Response> {
  let target = url;
  for (let i = 0; i <= hops; i++) {
    const res = await fetch(target, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status > 399) return res;
    const loc = res.headers.get('location');
    if (!loc) return res;
    /* relative Locations are common and harmless — resolve before checking, so
       a same-host redirect still works */
    const next = guard(new URL(loc, target).toString());
    if (!next) throw new ProviderError(502, offHost, false);
    target = next;
  }
  throw new ProviderError(502, 'The image provider redirected too many times.', false);
}

/* ── multi-reference ─────────────────────────────────────────────── */

/** What each extra image is, in words, for the models that have no control
 *  channel and can only be told in prose. BFL publishes the phrasing for this
 *  exact case — "Keep the exact spatial arrangement from image 1 — same
 *  composition, same positioning of elements." */
const CONTROL_SAYS: Record<ControlKind, string> = {
  line: 'a line drawing of the same plan',
  depth: 'a depth map of the same plan, where brighter is closer to the camera',
  seg: 'a flat-colour segmentation map of the same plan, one colour per room',
  change: 'a mask of the same plan, white only where the image may differ from image 1',
};

/** A sentence naming image 2, 3, … for a prompt. There is NO evidence FLUX.2
 *  reads a depth map handed to it this way — it has no control input and the
 *  docs say structure is interpreted semantically. It costs nothing to try,
 *  because billing is on output resolution only, and the harness is what will
 *  say whether it did anything. Do not read this as a claim that it works.
 *
 *  Nothing at all when the prompt already names image 2. `buildPrompt` learnt to
 *  emit these sentences itself, front-loaded, because BFL's guide says word order
 *  matters — so appending them here sent every multi-reference render each clause
 *  twice, plus a second copy of the spatial-arrangement line, and spent the
 *  documented 30-80 word window restating what the brief had already said. The
 *  app's copy is the one to keep; this one is for a caller with a prompt of its
 *  own, which today means the eval harness. It trusts the brief's numbering: a
 *  prompt that names more maps than its provider will attach is the caller's
 *  error, and one the shell's per-provider cap exists to prevent. */
export function controlLegend(controls: readonly ControlImage[], prompt = ''): string {
  if (!controls.length || /\bImage 2 is\b/.test(prompt)) return '';
  const parts = controls.map((c, i) => `Image ${i + 2} is ${CONTROL_SAYS[c.kind]}`);
  return `Keep the exact spatial arrangement from image 1 — same composition, same positioning of elements. ${parts.join('. ')}.`;
}

/** The controls this provider will actually be given, in the caller's order.
 *  Anything it does not accept is dropped rather than sent as a surprise
 *  reference image; the multi-reference providers opt in by listing the kinds
 *  they want in `acceptsControls` or by reading `args.controls` themselves. */
export function usableControls(p: ProviderMeta, controls: readonly ControlImage[] | undefined): ControlImage[] {
  if (!controls?.length) return [];
  return controls.filter((c) => p.acceptsControls.includes(c.kind));
}
