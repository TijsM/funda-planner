# In-app rendering — implementation brief

Single source of truth for the build. Supersedes `docs/RENDER-IN-APP.md` wherever the two disagree; the spec's *decisions table* (lines 9–15) still stands unchanged.

---

## STATUS: the API key in `.env` is rejected by BFL

Verified 2026-08-14, before any code was written. `FLUX_API_KEY` is `bfl_` + 35 chars (39 total,
clean — no quotes, no whitespace, no CR). Every endpoint returns the same thing:

```
GET  https://api.bfl.ai/v1/credits            x-key    → 422 {"detail":"Invalid API key format"}
GET  https://api.eu.bfl.ai/v1/credits         x-key    → 422 {"detail":"Invalid API key format"}
GET  https://api.us.bfl.ai/v1/credits         x-key    → 422 {"detail":"Invalid API key format"}
POST https://api.bfl.ai/v1/flux-kontext-pro   x-key    → 422 {"detail":"Invalid API key format"}
POST https://api.bfl.ai/v1/flux-2-pro         x-key    → 422 {"detail":"Invalid API key format"}
GET  https://api.bfl.ai/v1/credits            Bearer   → 403 {"detail":"Not authenticated"}
```

Two things this establishes. `x-key` **is** the right header — the `Bearer` form is not recognised
at all, while `x-key` is parsed and then the key itself rejected. And the rejection happens before
body validation (the POSTs carried a deliberately invalid body and never reached field
validation), so it is the credential, not the request shape. Nothing was billed.

api.bfl.ai keys are issued at `dashboard.bfl.ai/api/keys`. A replacement key is needed to run
Task 0's proof call and to verify Task 3 end to end.

**This blocks verification, not construction.** The contract below is documented from BFL's live
OpenAPI spec, so everything is built against it and the key swap is the only change needed. What
stays unproven until a working key lands is marked ⚠ UNVERIFIED in place — chiefly whether
`flux-2-pro` accepts raw-base64 `input_image` (open question 1), which is why `MODEL` is a single
constant with `flux-kontext-pro` documented as the fallback.

---

## 1. Decisions

### Provider and model

**Use `flux-2-pro`** (the pinned snapshot, not `flux-2-pro-preview` — preview tracks latest weights, which makes a stored seed meaningless). One constant in `src/server/providers/bfl.ts`:

```ts
export const MODEL = 'flux-2-pro';          // fallback: 'flux-kontext-pro'
const BASE = 'https://api.bfl.ai';
```

Why, not Kontext (which the spec named at line 48): FLUX.2 is a true image-conditioned editor, BFL's own use-case page (`guides/usecases_editing_drawing_rendering`) is literally "transform sketches and stylized art into photorealistic renders", and it exposes `disable_pup` — the switch that stops BFL's LLM rewriting a precise layout prompt and inventing rooms. Kontext has no such switch and is labelled previous-generation. `flux-kontext-pro` stays as the one-line fallback: flat $0.04/image regardless of resolution, documented base64 input, and it inherits the input image's dimensions when `aspect_ratio` is omitted.

### Submit

```
POST https://api.bfl.ai/v1/flux-2-pro
headers: { 'x-key': process.env.FLUX_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' }
body: {
  prompt:          string,        // required
  input_image:     string,        // RAW base64, NO "data:image/png;base64," prefix
  width:           number,        // multiple of 16, >= 64, width*height <= 4MP
  height:          number,
  seed:            number | null, // omit/null = random
  disable_pup:     true,          // pro/max only. MUST be true — layout fidelity
  output_format:   'png',         // flux-2-* default is jpeg
  safety_tolerance: 2             // 0..5 on FLUX.2 (0..6 on kontext); >max = 422
}
→ 200 { id, polling_url, cost?, input_mp?, output_mp? }
```

Auth is `x-key: <raw key>`. There is no `Authorization: Bearer` form. FLUX.2 has **no `aspect_ratio` field** — aspect ratio is expressed by `width`/`height`. Never send `webhook_url`; it removes `polling_url` from the response.

### Poll

```
GET <polling_url>          // VERBATIM. Never rebuild it as /v1/get_result?id=…
headers: { 'x-key': KEY, accept: 'application/json' }
```

`polling_url` is cluster-specific; a hand-built URL against the global host returns `"Task not found"`. Persist it with the job.

Status values (OpenAPI enum, plus one that isn't):

| status | meaning |
|---|---|
| `Pending`, `Reasoning`, `Generating` | keep polling; `progress` (float) and `preview` are on the response |
| `Ready` | `result.sample` = signed https URL on `delivery.*.bfl.ai` |
| `Request Moderated` | input rejected. Terminal, do not retry. `details['Moderation Reasons']: string[]` |
| `Content Moderated` | output rejected. Retry with a new seed is legitimate |
| `Error` | read `details`. Retry once with a new seed |
| `Task not found` | expired, or wrong cluster |
| **`Failed`** | not in the spec enum but in every official sample — treat any unknown status as terminal error, never loop |

Interval: 1 s for the first ~10 s, then 2–3 s, hard timeout 180 s.

`result` is typed `anyOf[{}, null]` — **`sample` is the only key ever promised**. Do not read `result.seed`; record the seed you sent.

### Delivery URL

Valid **10 minutes**, and BFL **does not enable CORS on `delivery.*.bfl.ai`**. The browser cannot fetch it at all, not even within the window. The status route downloads the bytes server-side and returns them base64 in the same response. This makes the spec's line 104–106 mandatory rather than merely prudent.

### Interception file

**`/Users/tijs-martens/Documents/rodi-digital/funda-planner/proxy.ts`** — repo root (app/ is at the root; `src/` has no `app/` in it). Named export `proxy` (or default; docs recommend naming it `proxy` regardless). `middleware.ts` is deprecated in Next 16 and having both files is a hard build error. **No `runtime` export** — Proxy is Node-runtime only in 16 and setting `runtime` throws. Upside: `node:crypto` works directly in `proxy.ts`.

### Cookie

Next has **no built-in cookie signing**. Roll HMAC-SHA256 in `src/server/session.ts`, used by both `app/api/login/route.ts` and `proxy.ts` (same Node runtime, one module).

- Payload `{iat}` → `base64url(json) + '.' + base64url(hmac)`, key `process.env.SESSION_SECRET`.
- **`SESSION_SECRET` already exists in `.env`** alongside `FLUX_API_KEY` and `APP_LOGIN` — the spec's line 17 says "both env vars"; there are three. Use the existing name.
- Cookie: `name 'session'`, `httpOnly: true`, `sameSite: 'lax'`, `path: '/'`, `secure: process.env.NODE_ENV === 'production'`, `maxAge: 60*60*24*30`.
- `cookies()` is **async** in v16 and the sync shim is fully removed: `const c = await cookies()`. In `proxy.ts` use the sync `request.cookies.get('session')?.value`.
- Password compare: hash both sides to 32 bytes first — `timingSafeEqual` throws `RangeError` on a length mismatch, which would leak length as a 500 and crash on every wrong-length guess.
- Read env **inside handlers**, never at module scope: CI runs `pnpm build` with no secrets and a module-level assertion turns a missing var into a red build.

---

## 2. Contradictions and risks

1. **Spec line 48–50 names `flux-kontext-pro`.** Superseded — `flux-2-pro`, see above. The spec's own instruction "keep the model id in one constant" is what makes this cheap.

2. **Spec lines 95–99 sketch `→ { jobId, pollToken }` and `?jobId=…&pollToken=…`.** The "pollToken" is not a token, it is BFL's full `polling_url` (an absolute URL with a query string). Name it `pollUrl`, URL-encode it in the query string, and **validate on the server that its hostname ends in `.bfl.ai`** before fetching it — otherwise `/api/render/status` is an SSRF hole that attaches your API key to an attacker-chosen host. `jobId` is only useful for logging; keep it for that.

3. **Spec line 98's three statuses hide eight.** `'pending' | 'ready' | 'failed'` must collapse `Pending/Reasoning/Generating` → pending; `Ready` → ready; `Request Moderated`/`Content Moderated`/`Error`/`Task not found`/`Failed`/anything-unknown → failed with a distinct `error` string each.

4. **Spec line 36 says the URL expires "~10 minutes" — right, but incomplete.** The blocking fact is no CORS on delivery hosts, not the expiry.

5. **Spec line 192: "the modal renders at `maxPx: 1800`. Check what BFL actually accepts."** Checked: 1800 px longest side ⇒ at most ~3.24 MP, under Kontext's documented 20 MP/20 MB and under the 4 MP ceiling every other FLUX endpoint that documents one uses. **No input downscale is needed.** The real work is on the *output* side: `width`/`height` must be multiples of 16 and their product ≤ 4 MP, and flux-2-pro bills **per output megapixel** — sending 1800×1800 costs roughly 3× a 1 MP render. Derive output dims from the reference canvas's aspect ratio, scaled to ~1 MP, each rounded **down** to a multiple of 16.

   Correcting a figure that circulated in research: the `Math.max(0.15, …)` zoom floor at `files.ts:94` only binds when the plan's longest side exceeds `maxPx / 0.15` **cm** = 120 m at `maxPx: 1800`. For any real home, `maxPx` is a hard cap. Still measure `cv.width`/`cv.height` — but do not build a downscaler for a case that cannot occur.

6. **Spec line 26–27 hedges on the middleware filename.** Resolved: `proxy.ts`. Writing `middleware.ts` still *works* (deprecation warning only), so it will pass review while being wrong; and if both files ever exist the build throws.

7. **Spec Task 5 line 147: "Job state … goes in the Zustand store."** Taken literally this is a performance bug. `src/shell/Canvas.tsx:72` is `useEffect(() => useEditor.subscribe(draw), [draw])` — a **selector-less** subscribe, so every `set()` anywhere in `useEditor` repaints all 183 walls. A 1 Hz elapsed-time tick plus poll responses would repaint the plan continuously. **Deviate: put jobs in a second store, `src/state/renders.ts`,** with its own `create<RenderState>()` and an `rs = () => useRenders.getState()` handle mirroring `ed()`. The spec's actual requirement — "closing the modal does not cancel a render" — is satisfied identically. Cost: it is invisible to `window.__ed`, so `TestBridge.tsx` must expose it explicitly.

8. **Spec Task 1 is already done in the working tree.** `git status` shows `M next.config.mjs` with `output: 'export'` and its comment already removed and replaced. Do not redo it — commit it with the rest.

9. **CI will go red on the password gate.** `.github/workflows/ci.yml` e2e job runs the suite twice, the second with `E2E_TARGET: next`, and has **no `env:` block**. Once `proxy.ts` lands, all 68 specs boot into the login screen. `.github/workflows/ci.yml` needs `APP_LOGIN` and `SESSION_SECRET` (dummy values are fine) on both the e2e job and — because `pnpm build` must not need them — nowhere else.

10. **Proxy silently truncates large POST bodies.** With proxy active Next buffers request bodies in memory, default cap **10 MB**, and on overflow it *logs a warning and continues with a partial body* — the request does not fail. A base64 1800 px line-drawing PNG is well under this, but reject anything over ~6 MB in `/api/render` explicitly so a truncated body can never reach BFL.

11. **Proxy runs on `/_next/data/*` even when the matcher excludes it** — "intentional, to prevent protecting a page but forgetting its data route". The unauthenticated branch must be safe for requests you did not enumerate: JSON 401 for anything under `/api/` or `/_next/`, redirect only for real page requests.

12. **`vitest.config.ts` cannot run any of Task 8's unit tests as configured.** `resolve.alias` has **only `@engine`**, and `environment: 'node'` has no `indexedDB` and no `Blob` structured-clone. Three edits are prerequisites, not polish (see Task 8 addendum).

13. **IndexedDB survives between Playwright tests.** `fresh()` in `tests/e2e/helpers.js` clears `localStorage` only. Render specs will be flaky until `fresh()` also deletes the render database in its `addInitScript`.

---

## 3. Open questions for the human

1. **Does `flux-2-pro` accept a raw-base64 `input_image`?** BFL's own skill says "both URL and base64 work"; not one docs.bfl.ai sample proves it — every FLUX.2 example passes an https URL, and our PNG is generated client-side with no public URL. One ~$0.03 call in Task 0 settles it. If it 422s, the choice is `flux-kontext-pro` (documented base64, flat $0.04) or uploading the PNG somewhere public first — **please pick the fallback before the spike runs** so Task 0 doesn't stall.

2. **Output resolution, i.e. cost per render.** flux-2-pro bills per output MP at "from $0.045/MP" for edits. ~1 MP ≈ $0.05/render; matching the 1800 px reference at ~3.2 MP ≈ $0.15/render. Default to ~1 MP unless you want the higher-resolution deliverable.

3. **`disable_pup: true` (exact prompt, faithful layout) vs `false` (BFL's LLM embellishes, prettier, invents geometry).** Brief assumes `true`. If the Task 0 spike comes back sterile, this is the first knob to reconsider — say so rather than letting the builder decide silently.

---

## 4. Per-task addenda

### Task 0 — Spike

- Node script, not a route. Read `.env` yourself (`node --env-file=.env`).
- Reference PNG: run the app, open the render modal, click `#aiDlImg`, use that file — it is byte-identical to what `renderFloorCanvas(floor, { clean: true, … maxPx: 1800 })` produces. Prompt: copy from `#aiPrompt`.
- Assert on: 200 + `polling_url` with base64 input (question 1); the `cost` field on the submit response (question 2); and structural fidelity by eye.
- Write the confirmed submit/poll shapes as the header comment of `src/server/providers/bfl.ts`.

### Task 1 — Off static export

Already applied, uncommitted (`next.config.mjs`). `images: { unoptimized: true }` and `allowedDevOrigins: ['localhost','127.0.0.1']` both stay — the latter is load-bearing for the e2e run. Build output moves `out/` → `.next/`; dev builds go to `.next/dev`. `tsconfig.json` still excludes `out` and `.gitignore` still ignores it: dead entries, harmless. `pnpm start` (`next start -p 3500`) becomes meaningful for the first time; the app now needs a Node host.

### Task 2 — Password gate

Files:
- `/proxy.ts` (repo root) — `export async function proxy(request: NextRequest)`, `export const config = { matcher: [...] }`. Matcher values must be static literals. Exclude `api/login`, `login`, `_next/static`, `_next/image`, `favicon.ico`.
- `app/api/login/route.ts` — `export async function POST(request: NextRequest)`, body via `await request.json()`, respond with `Response.json(data, { status })`.
- `app/login/page.tsx` — one field, one button, one error state. `app/layout.tsx` renders `{children}` bare, so the login page carries its own centred layout; reuse `app/globals.css` tokens so it looks like the app.
- `src/server/session.ts` — `sign()` / `verify()` over `SESSION_SECRET`. Optional `import 'server-only'` as line 1 (**`server-only` is not installed**; `pnpm add server-only` if you want the build-error guarantee).

`APP_LOGIN` unset ⇒ fail closed: `/api/login` returns 500 with a plain message, login page renders it. Never echo the password, never log it.

Note `src/server/*` is not covered by the `@engine`/`@shell`/`@state` aliases in `tsconfig.json:25-35` — use relative imports (`./src/server/session` from `proxy.ts`).

### Task 3 — Render API

- `app/api/render/route.ts` → POST. `app/api/render/status/route.ts` → GET. Neither is dynamic, so `context.params` (a Promise in v16) never comes up. Route handlers are **not cached by default** since v15 — do not add `export const dynamic = 'force-static'` to the polling route out of habit.
- `src/server/providers/bfl.ts` — the adapter, contract documented at the top per spec line 111–112.
- Validation ceilings: prompt ≤ 8000 chars (FLUX.2 allows 32 K tokens; the app's prompts are ~2 KB — this is an abuse guard); base64 image ≤ 6 MB; reject a `pollUrl` whose hostname does not end `.bfl.ai`.
- Error mapping, all from the submit POST unless noted:

| upstream | client message |
|---|---|
| 402 | "Out of credits at the image provider. Top up at api.bfl.ai." — **never retry** |
| 403 (also 401 per BFL's skills repo) | "The image provider rejected the API key." |
| 422 | surface `detail[0].msg` verbatim — it is a developer bug |
| 429 | "The provider is at capacity (24 concurrent jobs). Try again in a moment." |
| 500/503 | retryable, back off |
| poll `Request Moderated` | "The provider's safety filter rejected the plan or the prompt." |
| poll `Content Moderated` | "The generated image was filtered. Re-roll the seed." |
| poll `Error`/`Failed`/unknown | "The render failed at the provider." + `details` |
| our 180 s cap | "The render timed out after 3 minutes." |

- Free pre-check worth wiring: `GET https://api.bfl.ai/v1/credits` → `{credits}` (1 credit = $0.01). Log submit `cost` and settled `cost` from the ready poll.

### Task 4 — IndexedDB store

New file `src/shell/renders.ts`, browser-only, mirroring `src/shell/storage.ts` — **not** in `src/engine` (which must stay Node-runnable).

- Copy the key conventions of `storage.ts:9-13`: exported consts, `pgs.` prefix, explicit `.vN`. e.g. `export const IDB_NAME = 'pgs.renders.v1'`, object store `renders`, index on `[projectId, floorId]` plus one on `createdAt`.
- Copy the three-tier error posture of `storage.ts`: reads return safe empties; writes that matter toast the *specific* cause (`storage.ts:45-50` is the model — "Browser storage is full — most likely an embedded reference image…", not "something went wrong"); writes that don't matter swallow with a comment saying why.
- API is Promise-based (`await putRender(...)`); never leak `IDBRequest` past the module boundary. Import `ed` from `@state/store` for toasts *inside functions*, never at module scope — one-way dependency, exactly as `storage.ts:3`.
- Required exports: `putRender`, `listRenders(projectId, floorId)` newest-first, `deleteRender(id)`, `deleteRendersForProject(projectId)`, `totalBytes()`.
- Record keys: `projectId` = `project.id`; `floorId` = `floor.id`. (`project.source.projectId` and `floor.fmlDesignId` are the only re-import-stable ids, but re-import creates a new project anyway — use the plain ids.)
- Render records are **chrome, not document**. They must never touch `Project`/`Floor`: `store.ts:127` `JSON.stringify`s the whole project into every undo snapshot, and `Editor.tsx`'s 3 s autosave writes it to localStorage. One PNG in there blows quota immediately.
- Export the private `download(blob, filename)` helper at `src/shell/files.ts:12-18` rather than writing a third copy (`RenderModal.tsx:89-101` is already the second).

### Task 5 — Jobs

New file `src/state/renders.ts`: `useRenders` + `rs = () => useRenders.getState()`. Keep the reducer as **plain exported functions over a state object** (`applyPoll(state, response) → state`) so Vitest can drive it without a renderer — no `@testing-library/*` is installed and no `.tsx` test exists.

- `patch`-style merges must **replace** a jobs map wholesale (`store.ts:122` is `set(p)`, a shallow top-level merge; mutating a nested object notifies nobody).
- Max 1 in-flight job. Generate disabled while one runs — a double-click must not cost two credits.
- Poll from a module-level timer, not a React effect: `Editor.tsx`'s Escape cascade (`else if (s.modal) s.patch({ modal: null, calibrating: false })`) unmounts `RenderModal` (`Editor.tsx:206`, `{modal === 'render' && <RenderModal />}`) and every `useState` in `RenderModal.tsx:24-36` dies with it.
- On ready: `putRender(...)`, then `ed().toast('…', 'ok')`. On failure: keep the failed record with its prompt/settings so it can be retried from the filmstrip — toasts auto-dismiss (6200 ms err / 3300 ms ok, `store.ts:171-175`), have no action button and no sticky variant, so the retry cannot live in the toast.
- Add to `TestBridge.tsx` (alongside `w.__ed = ed`): `w.__renders = rs` and a `w.__wipeRenders = () => deleteDatabase(...)`.

### Task 6 — The workspace

All edits in `src/shell/ui/RenderModal.tsx`.

- Left column (`.ai-left`, lines 115–167) unchanged. Lift the settings values (`view, room, style, furniture, dimensions, roomLabels, imgMeasures, prompt`) out of `useState` into `useRenders` so "Use these settings" survives a close, and so the exact prompt text is available to the job.
- Right column: replace `.ai-right` (lines 169–181) with big preview + filmstrip + seed control. Keep `<span className="lbl">Reference image</span>`'s slot and **keep the "bleed into the render" hint** — `tests/e2e/06-ai-export.spec.js` asserts `.ai-right` contains that text.
- Footer (lines 184–190): Generate becomes the `pri` button. **Keep ids `#aiRegen`, `#aiCopyImg`, `#aiDlImg`, `#aiCopy`** — all four are asserted in `06-ai-export.spec.js`. `#aiCopy` must remain "Copy prompt" (the spec asserts the toast text "Prompt copied" and clipboard content).
- Also keep `#aiImg` on the reference `<img>` and `#aiPrompt`, `#aiLabels`, `#aiImgDims`, `#aiFurn`, `#aiDims`, `#aiStyle`, `#aiRoom`, `#aiView` — the `openAI` helper waits on `#aiPrompt` being non-empty and one test compares `#aiImg`'s `src` before/after toggling `#aiLabels`.
- **The seed field must be a real `<input>`.** `Editor.tsx`'s document keydown guard (`if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;`) is the only thing stopping `g`/`s`/`b`/`0` from firing tool shortcuts while typing. React `stopPropagation()` is inert here — Next hydrates at document level. Do not relax the guard; do not use a contenteditable or a custom key widget.
- Elapsed time, not a percentage — though note the poll response does carry a `progress` float and a `preview` object if you want them.
- One quiet line stating renders live on this browser and do not travel with a JSON export (spec lines 136–139).
- Known pre-existing wart worth fixing while you're here: the reference-image effect (lines 57–64) depends on `[floor, furniture, roomLabels, imgMeasures]` but **not `rev`** — editing the plan while the modal is open does not refresh the reference.

### Task 7 — Edges

- Generate disabled when: a job is in flight, `prompt.trim()` is empty, or `renderFloorCanvas` returned `null` (`files.ts:89` — an empty floor legitimately has no reference image).
- Session counter: a plain integer in `useRenders`, reset on reload. No quota system.
- IndexedDB unavailable (private window) or full: the specific message, per `storage.ts:45-50`.
- Reference size: measure `cv.width`/`cv.height` from `renderFloorCanvas` and derive the BFL `width`/`height` from that ratio at ~1 MP, floored to multiples of 16. Do not send 1800×1800 — it is legal but ~3× the price.
- In-flight job across a reload: **declare it lost.** The record is written only on completion; nothing resumable is stored. Say so in the UI next to the elapsed timer ("a render in progress is lost if you close the tab"). Persisting `pollUrl` to IndexedDB and resuming on boot is the alternative — cheap, but it turns a 60 s job into an unbounded one; take it only if the human asks.

### Task 8 — Tests

**Vitest** — three prerequisite edits to `vitest.config.ts`:
1. add `'@shell': dir('./src/shell')` and `'@state': dir('./src/state')` to `resolve.alias`;
2. `environment: 'node'` stays for `engine.test.ts`/`render.test.ts` — put `// @vitest-environment jsdom` at the top of the new files, or use `environmentMatchGlobs`;
3. `pnpm add -D fake-indexeddb jsdom` — neither is installed today (nor is `happy-dom` or any `@testing-library/*`).

Cover: record round-trip, `listRenders` ordering, lineage (`parentId` resolves), delete-one/delete-all, `totalBytes()`; and the job reducer against stubbed poll payloads for each of the eight statuses plus an unknown one. No network.

**Playwright** —
- Every new spec needs `test.skip(process.env.E2E_TARGET !== 'next', 'v2 shell feature')` or it runs against the legacy `index.html` build and fails (pattern: `tests/e2e/09-focus.spec.js:8`).
- `fresh()` in `tests/e2e/helpers.js` needs two additions: an `addInitScript` that deletes the render database (IndexedDB survives between tests *and between runs*), and a signed session cookie. `helpers.js` runs in Node and already uses `fs`/`path`, so it can `require('node:crypto')` and sign with `process.env.SESSION_SECRET`; load `.env` in `playwright.config.ts` (no `dotenv` installed — a six-line manual parse is enough) so the Playwright process sees it. `next dev` loads `.env` itself, so the server side needs nothing.
- Stub `/api/render` and `/api/render/status` with `page.route(...)`, same shape as `mockNetwork` (`helpers.js:58-69`). Return a 1×1 PNG base64. **The suite must never spend a credit.**
- A stubbed 401 lands in `page.badRequests` and specs assert on `appFailures(page)` — make the gate specs expect it deliberately.
- Anything typed goes through `pressSequentially` with a per-key delay and asserts value **and** `document.activeElement.id` — see `09-focus.spec.js:15-21`. `fill()` is only for clearing a field first. The seed field additionally needs the "single-letter shortcut must not fire while typing" assertion (`09-focus.spec.js:166-178`).