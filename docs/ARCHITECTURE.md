# v2 — turning the editor into a product

Target: accounts and teams, subscriptions, AI rendering inside the app, plans stored server-side.

The single-file app stays on `main` and keeps working. This branch rebuilds the shell around it
without rewriting the part that is hard to get right.

---

## The one decision that matters

**The editor engine stays framework-free and DOM-free. Only the shell becomes React.**

That is not aspirational — it is already true. Splitting today's `index.html` by brace-matching:

| | count | size |
|---|---|---|
| DOM-free (engine) | 56 functions | ~52 KB |
| DOM-bound (shell) | 53 functions | ~66 KB |

The engine half already includes everything expensive to rebuild: `paint`, `hitTest`, `snapPoint`,
`parseFundaSource`, `fmlToProject`, `buildPrompt`, `planFacts`, the geometry kernel and the
selection/undo model. It is proven portable — the Node harness in this repo already executes the
whole script with stub DOM objects and renders through a mock 2D context.

Two consequences worth planning around:

1. **The same renderer runs on the server.** `paint()` is plain Canvas2D, so under
   `@napi-rs/canvas` it produces the reference image for AI rendering server-side — no headless
   browser, no duplicated drawing code.
2. **The engine is unit-testable without a browser.** Vitest over `lib/engine`, Playwright reserved
   for real flows.

### Layout

Written as `lib/…` when this was planned; it landed under `src/…` with the path aliases
`@engine/*`, `@shell/*`, `@state/*`, `@data/*`, `@server/*`.

```
src/engine/            pure TS — no React, no DOM, no fetch
  model.ts             types, factories, migrate()
  geometry.ts          polyArea, pointInPoly, snapping, hit-testing
  catalog.ts           the 120 objects + their draw functions
  render.ts            paint(ctx, view, opts)   ← browser AND server
  prompt.ts            buildPrompt(), planFacts()
  io/funda.ts          parseFundaSource(), fmlToProject()
  io/serialize.ts      import/export, versioned migrations
src/shell/             React shell: tray, toolbars, inspector, modals, storage
src/shell/Canvas.tsx   thin wrapper — refs + pointer events → engine
src/state/             the Zustand store the canvas subscribes to
src/data/              Supabase in the browser: config, schema, plan sync, renders
src/server/            server-only: per-request client, the gate, providers
app/                   Next routes: the editor, /login, /api/render
supabase/migrations/   tables, RLS policies, the render bucket
```

**Do not put the document in React state.** A `<canvas>` repainting 183 walls through React
reconciliation is pointless. Keep the document in a plain store (Zustand); the canvas subscribes and
repaints imperatively. React owns chrome only.

---

## Stack

| Concern | Choice | Why this one |
|---|---|---|
| Framework | **Next.js (App Router) + TypeScript**, Vercel | You need a server for API keys, Stripe webhooks and the Funda fetch. One deployable, best ecosystem for exactly these three problems. |
| Auth | **Supabase Auth**, email OTP — *shipped* | No password in the system at all: an address, a six-digit code, done. Teams are not built; every RLS policy is `owner_id = auth.uid()` and that predicate is the one thing that changes when they are. |
| Database | **Supabase Postgres + supabase-js** — *shipped* | Plans are ~64 KB of JSON → one `jsonb` column, as planned. No ORM: with RLS doing the authorisation, the query layer is thin enough that a hand-written `Database` type (`src/data/schema.ts`) beats a migration toolchain the browser half cannot use anyway. |
| Billing | **Stripe**, or a merchant of record — see below | Checkout + Customer Portal. Never build billing UI. |
| Object storage | **Supabase Storage**, private `renders` bucket — *shipped* | Generated renders, keyed `<owner-uuid>/<render-uuid>.png` so the bucket policies authorise on the first path segment alone. Signed URLs, one hour. |
| Server canvas | **@napi-rs/canvas** | Runs `render.ts` unchanged. |
| Jobs | Start with a job row + polling; **Inngest** when it hurts | Renders take 10–60 s — too long for a request. |
| Tests | **Vitest** (engine) + **Playwright** (flows) | The existing suite and fixtures carry over. |

### Why it stopped being three vendors

Clerk for auth, Neon for Postgres and R2 for objects is three dashboards, three sets of credentials
and, worse, three seams: Clerk users mirrored into Neon by webhook, and object keys authorised by
code we write rather than by the database. Supabase collapses all three into one platform where the
*same* `auth.uid()` that identifies the request is the predicate in the row policies and in the
Storage policies — so "can this person read this?" is answered in one place, by the database, and a
route handler that forgets to check cannot leak anything. That is worth more here than Clerk's
organisations, which nothing yet needs.

The cost is honest: one vendor, and no org/invite/role model to inherit when teams arrive.

### Schema sketch

Shipped, in `supabase/migrations/20260816120000_init.sql`, mirrored as types in
`src/data/schema.ts`:

```
profiles                 id (= auth.users.id), email — filled by trigger on signup
plans                    id, owner_id, client_id, name, address, source_url,
                         funda_project_id, floor_count, doc jsonb,
                         doc_updated_at, synced_at, deleted_at
renders                  id, owner_id, plan_id, client_id, floor_id, parent_id,
                         prompt, settings jsonb, seed, model, status, error,
                         provider_job_id, provider_poll_url,
                         image_path, thumb_path, bytes, width, height, duration_ms
```

`client_id` on both is the editor's own id, kept because every document, every exported `.json` and
every render already references plans by it; `id` is a real uuid because a key generated by
`Math.random()` with no collision check is not one. `doc_updated_at` is the client's clock, not
`now()` — it is the last-write-wins key, and the editor has to be able to decide which of two
versions is newer while offline.

Still sketches, for the steps below:

```
orgs, memberships        when teams land — the one place owner_id becomes a join
plan_versions            id, plan_id, doc jsonb, created_at, created_by
subscriptions            org_id, stripe_customer_id, price_id, status, seats
usage_events             org_id, kind ('render' | 'import'), qty, created_at
```

One `entitlements(orgId)` function reads `subscriptions` + `usage_events` and answers "can they do
this?". Every route calls it. Never scatter plan checks.

---

## AI rendering

Keys never reach the browser. What shipped:

```
POST /api/render                      app/api/render/route.ts
  → session (Supabase) → 401 if none
  → the plan's row, by client_id      409 if it has not synced yet
  → submit to BFL                     src/server/providers/bfl.ts
  → insert `renders`, status pending, provider_poll_url on the row
  → { renderId, jobId }               no poll URL — that is the point

GET /api/render/status?renderId=
  → poll the provider with the URL FROM THE ROW
  → ready: download the PNG, put it in the private bucket, settle the row,
           answer with a signed URL
```

The server canvas is the one piece of the plan that did not happen: `paint()` runs in the browser
and the reference image arrives as base64, capped at 6 MB. `@napi-rs/canvas` becomes worth adding
the day a render is started by something other than an open tab.

Put providers behind one adapter (`src/server/providers/*.ts`) and start with a single one. For
"make this exact plan photoreal", image-conditioned models matter more than raw quality — Gemini's
image models and Flux (via fal or Replicate) both take an image plus text. If structural fidelity
disappoints, add ControlNet-style conditioning rather than fighting the prompt.

**"with API keys" reads two ways — support both, in this order:**

1. **Your keys, metered.** Simplest UX, you carry the cost, so renders must be a billed unit.
2. **Bring your own key.** Encrypt at rest (KMS or libsodium sealed box), decrypt only inside the
   render route, never log it, never return it to the client. Removes your COGS and is what power
   users ask for.

---

## Two things that will bite if left late

**EU VAT.** Selling subscriptions from Belgium to consumers elsewhere in the EU means charging VAT
at the buyer's rate and filing OSS. Stripe does not do this for you — Stripe Tax calculates, you
still remit. **Polar** or **Lemon Squeezy** act as merchant of record and take the liability, for a
few percent. If you sell business-to-business only, reverse-charge applies and Stripe + Stripe Tax
is fine. Decide before the first paid customer, because migrating billing later is miserable.

**Funda on the server.** Moving the import server-side removes the CORS proxy and the per-user rate
limit, and lets you cache by listing id. It also changes the posture: today each user's browser
fetches a page they are already viewing; a server that fetches and *stores* listing content is doing
something a rights-holder sees differently. Cache the derived geometry keyed by Floorplanner project
id — which is published openly — rather than mirroring listing pages, and keep the paste-source
fallback.

---

## Migration order

Each step ships and leaves the app working.

1. **Scaffold + port the engine.** Next + TS, `lib/engine` from the current file, Vitest over it.
   The static app on `main` keeps serving users.
2. **Editor shell in React.** Canvas wrapper, tray, toolbars, inspector. Repoint the Playwright
   suite; keep the fixtures.
3. **Auth + persistence — done.** Supabase rather than Clerk + Neon, for the reason above. Email
   OTP, plans in Postgres under RLS, renders in a private bucket, and localStorage still written
   synchronously on every save so the thing works on a train. Setting one up:
   [`SUPABASE.md`](SUPABASE.md).
4. **Billing.** Checkout, portal, webhooks, `entitlements()`, quotas.
5. **Renders — done**, apart from the server canvas. Provider adapter, a row per render, lineage
   and re-runs, a filmstrip per floor. Steps 3 and 5 landed in the other order than written here:
   renders shipped first against IndexedDB and one shared password, and step 3 moved them into the
   account.

## Deliberately not doing

- Rewriting the canvas in React, Konva or Fabric — the renderer is the asset.
- A monorepo before a second consumer exists. Folders and path aliases are enough.
- GraphQL, microservices, a heavy state library, or a design system.
- Real-time multiplayer. If it becomes a requirement, the document is already a plain JSON tree, so
  Yjs can be layered on the store without touching the renderer.

---

## Next 16 notes

The scaffold is Next 16 / React 19, which differs from a lot of published advice.
`next dev` writes an `AGENTS.md` pointing at `node_modules/next/dist/docs/` — read
those before writing framework code rather than trusting memory. Checked against
them so far:

- `output: 'export'` plus `images: { unoptimized: true }` is still the documented
  static-export path, so the Pages deploy is fine.
- `export const metadata` / `export const viewport` are current.
- Turbopack is the default bundler.

Two that will bite during the steps above:

- **`middleware` is renamed to `proxy`.** Every guide writes the auth guard as a
  `middleware.ts`; on 16 that file is `proxy.ts` exporting `proxy`, and it runs on
  the Node runtime only — the `edge` runtime is not supported there. That is where
  the gate now lives, and where the Supabase session gets refreshed on every
  request, so an early return there silently skips the refresh.
- **Request APIs are async.** `params`, `searchParams`, `cookies()` and `headers()`
  must be awaited. Nothing in the editor touches them yet, but every route added
  for billing, renders and the Funda proxy will.
