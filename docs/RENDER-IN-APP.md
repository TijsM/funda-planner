# In-app rendering — build spec

Today the Render modal hands the user a prompt and a reference image to carry somewhere else.
This turns that hand-off into the product: press **Generate**, watch it come back, change one
thing, run it again — and every render is kept.

Decisions already made (do not relitigate):

| | |
|---|---|
| Hosting | Drop `output: 'export'`. The key stays server-side in a Next route handler. |
| Provider | BFL direct (`api.bfl.ai`), key in `FLUX_API_KEY`. |
| Iteration | Tweak the prompt/settings and re-run, with lineage. Plus a lockable seed. |
| Storage | IndexedDB, keyed by project + floor. No bucket, no database. |
| Access | One password from `APP_LOGIN`, server-checked. Single user. |

Both env vars are already set in `.env` (gitignored, untracked). Neither may ever be prefixed
`NEXT_PUBLIC_` or reach the client bundle.

---

## Read before writing code

- **`AGENTS.md` is not boilerplate.** This Next.js is ahead of your training data. Read the
  relevant guide under `node_modules/next/dist/docs/` before writing a route handler, a
  middleware/proxy file, or anything touching `next.config.mjs`. Middleware conventions in
  particular have moved recently — check, don't assume `middleware.ts`.
- **Verify the BFL contract against the live docs**, not memory. Two things below are load-bearing
  and must be confirmed in task 0: the request/poll shape, and how long result URLs live.

## Two facts that shape the whole design

1. **BFL is asynchronous.** Submitting returns an id and a polling URL; you poll until it reports
   ready. A render takes roughly 5–60 s. That is far too long to hold a request open, and far too
   long to trap the user in a modal.
2. **The result URL expires (~10 minutes).** Storing that URL is storing a dead link. The bytes
   must be pulled down and kept while the job is still fresh.

---

## Task 0 — Spike the provider and the framework

Nothing else is safe to build on guesses.

- Read the BFL API docs. Confirm: the submit endpoint and body, the poll mechanism and status
  values, how a reference image is passed (base64? which field?), whether `seed` and aspect ratio
  are supported, and the real expiry on result URLs.
- Choose the model. Start with the **image-conditioned** one (`flux-kontext-pro` family at time of
  writing) — the whole point is "reproduce *this* layout", and a text-only model will invent rooms.
  Keep the model id in one constant so swapping it is a one-line change.
- Prove it with one real call: a small reference PNG plus a prompt from `buildPrompt()`, from a
  Node script. Confirm structural fidelity is good enough to build a product on before building
  the product.
- Read the Next docs for route handlers and for whatever the current request-interception file is
  called.

**Done when:** one generated image exists on disk, produced from a real plan's prompt and
reference image, and the exact request/poll shapes are written down at the top of the provider
adapter.

---

## Task 1 — Take the app off static export

- Remove `output: 'export'` from `next.config.mjs` and the comment above it that says to delete it
  the day the first API route lands. That day is today.
- Confirm `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e` all still pass.
- Nothing in CI deploys to Pages, so nothing breaks — but say so in the commit message, because
  the config comment implied a deploy that no longer exists.

---

## Task 2 — The password gate

One user, one password, but do it properly — the render route spends real money.

- `POST /api/login` compares the submitted password against `process.env.APP_LOGIN` using a
  **timing-safe** comparison, and on success sets an `httpOnly`, `sameSite=lax`, `secure`-in-prod
  signed cookie with a long expiry. Never send the password back, never log it.
- Request interception protects everything: the app itself and `/api/*`, excluding the login
  endpoint and static assets. An unauthenticated page request lands on the login screen; an
  unauthenticated API request gets a 401, not a redirect.
- A minimal login screen — one field, one button, one error state. It should look like it belongs
  to the app, not like a scaffold.
- If `APP_LOGIN` is unset, **fail closed** and say so plainly on the login screen. A missing
  password must never mean "no password".

---

## Task 3 — The render API

Two stateless routes, so nothing depends on server memory surviving between requests.

```
POST /api/render          { prompt, referenceImage (base64 png), seed?, model? }
                          → { jobId, pollToken }
GET  /api/render/status   ?jobId=…&pollToken=…
                          → { status: 'pending' | 'ready' | 'failed', image?, error? }
```

- The `pollToken` is BFL's own polling handle passed back through the client. It is not a secret
  and it keeps the server stateless. The API key is attached server-side on every hop and never
  leaves it.
- When BFL reports ready, **the server fetches the image bytes itself** and returns them (base64
  or binary) in that same status response. Do not hand the client a BFL URL — it will be dead
  before the user gets round to saving it.
- Validate input: prompt length ceiling, reference image size ceiling, reject anything absurd
  before spending a credit.
- Map provider failures to honest client-facing messages: out of credits, content moderation,
  bad request, provider timeout. "Something went wrong" is not one of them.
- Put the provider behind a small adapter (one file, e.g. `src/server/providers/bfl.ts`) with the
  request/poll contract documented at the top. `docs/ARCHITECTURE.md` already anticipates this.

---

## Task 4 — The render store (IndexedDB)

New module, browser-only, alongside `src/shell/storage.ts` — and explicitly **not** in the engine,
which must stay runnable in Node.

Each render record holds enough to reproduce and to trace it:

```
id, projectId, floorId, parentId | null,
prompt (exact text sent), settings (view, room, style, the four toggles),
seed, model,
status ('pending' | 'ready' | 'failed'), error?,
blob (the PNG), thumbnail?,
createdAt, durationMs
```

- Keyed and queryable by `projectId` (+ `floorId`), newest first.
- `localStorage` is not an option — `storage.ts` already warns about quota dying on a *single*
  embedded image. Blobs go in IndexedDB, which has room for them.
- Provide delete-one, delete-all-for-project, and a total-bytes figure the UI can show.
- Renders live on one browser and do **not** travel with a JSON export. That is an accepted
  trade-off of the no-server-storage decision — so per-render **Download** is not optional
  polish, it is the only way a render leaves the machine. Make sure the UI says this once,
  quietly, rather than letting someone discover it after a reinstall.

---

## Task 5 — Jobs in the store, not in the modal

The current modal keeps everything in local `useState`. A 60-second job cannot live there.

- Job state (in-flight jobs, their poll timers, their results) goes in the Zustand store, so
  **closing the modal does not cancel a render**.
- Poll with backoff, and a hard timeout that fails the job honestly rather than polling forever.
- On completion: write to IndexedDB, toast. On failure: toast with the real reason, keep the
  failed record so the user can see what they asked for and retry it.
- Cap concurrent jobs (1 or 2) and disable Generate while a job is in flight. A double-click must
  not cost two credits.
- Careful with keyboard handling here — see the memory note in `RenderModal.tsx` about the
  document keydown guard. Don't relax it.

---

## Task 6 — The render workspace

The modal grows from "here's your prompt" into a place you work. Keep the existing left column
(settings, prompt, character count) as it is.

The right column becomes the stage:

- **Big preview** of the currently selected render, falling back to the reference image when
  there are none yet. A pending job shows progress here — elapsed time, not a fake percentage.
- **Filmstrip** underneath: this floor's renders, newest first, each a thumbnail with its seed and
  a note of which render it came from. Selecting one loads it into the preview.
- **Seed control**: a field, a lock toggle, and a randomise button. Locked reuses the seed so a
  prompt tweak changes only what you tweaked; unlocked gives a fresh variation every run — which
  is re-roll, for free, without a second concept to explain.
- **"Use these settings"** on a selected render: loads its prompt, style and toggles back into the
  left column, and the next Generate is recorded as its child. That is the whole lineage feature —
  a parent pointer and a back-link in the filmstrip. **Do not build a tree UI.** One user, one
  floor at a time; a flat reverse-chronological list with "from #4" is enough and stays legible.
- **Per render**: download, delete.

Footer: **Generate** becomes the primary action. Keep *Copy prompt*, *Copy image* and *Image* —
they are the escape hatch to any other generator, and removing them narrows the product for no
gain.

---

## Task 7 — Guardrails and edges

- Generate disabled while in flight, and while the prompt or the reference image is empty.
- Session render count visible somewhere unobtrusive. No quota system, no usage table — just
  enough that a runaway afternoon is visible.
- Handle IndexedDB being full or unavailable (private windows) with a real message, not a crash.
- Reference image size: the modal renders at `maxPx: 1800`. Check what BFL actually accepts and
  downscale before sending rather than having the request rejected after the user waits.
- If a job is in flight when the app is closed, it is lost. Say so, or persist enough to resume —
  builder's call, but make it a deliberate one.

---

## Task 8 — Tests

- **Vitest**: the render store (records, lineage, deletion, size accounting) and the job reducer
  with a stubbed provider. No network.
- **Playwright**: the password gate (wrong password, right password, protected route while logged
  out) and a full generate flow against a **stubbed** `/api/render` — the e2e suite must never
  spend a credit.
- Follow the existing suite's conventions, including the per-key typing rule in `tests/` for
  anything typed into a field.

---

## Sequence

```
0 spike ─→ 1 un-static ─→ 2 gate ─┐
                        └→ 3 API ─┴→ 4 store ─→ 5 jobs ─→ 6 UI ─→ 7 edges ─→ 8 tests
```

Tasks 2 and 3 are independent once the app is off static export. Everything after 4 is a chain.
