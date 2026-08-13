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

```
lib/engine/            pure TS — no React, no DOM, no fetch
  model.ts             types, factories, migrate()
  geometry.ts          polyArea, pointInPoly, snapping, hit-testing
  catalog.ts           the 120 objects + their draw functions
  render.ts            paint(ctx, view, opts)   ← browser AND server
  prompt.ts            buildPrompt(), planFacts()
  io/funda.ts          parseFundaSource(), fmlToProject()
  io/serialize.ts      import/export, versioned migrations
app/                   Next.js routes: marketing, auth, dashboard, /plan/[id]
components/            React shell: tray, toolbars, inspector, modals
components/Canvas.tsx  thin wrapper — refs + pointer events → engine
server/                DB access, entitlements, providers
```

**Do not put the document in React state.** A `<canvas>` repainting 183 walls through React
reconciliation is pointless. Keep the document in a plain store (Zustand); the canvas subscribes and
repaints imperatively. React owns chrome only.

---

## Stack

| Concern | Choice | Why this one |
|---|---|---|
| Framework | **Next.js (App Router) + TypeScript**, Vercel | You need a server for API keys, Stripe webhooks and the Funda fetch. One deployable, best ecosystem for exactly these three problems. |
| Auth + teams | **Clerk** | Organisations, invites and roles out of the box. Rebuilding org membership is weeks of work with no product value. |
| Database | **Postgres (Neon) + Drizzle** | Plans are ~64 KB of JSON → one `jsonb` column. Drizzle stays close to SQL and keeps bundles small. Neon branching pairs with preview deploys. |
| Billing | **Stripe**, or a merchant of record — see below | Checkout + Customer Portal. Never build billing UI. |
| Object storage | **Cloudflare R2** (or Supabase Storage) | Reference images, generated renders, uploaded bitmaps. Signed URLs. |
| Server canvas | **@napi-rs/canvas** | Runs `render.ts` unchanged. |
| Jobs | Start with a job row + polling; **Inngest** when it hurts | Renders take 10–60 s — too long for a request. |
| Tests | **Vitest** (engine) + **Playwright** (flows) | The existing suite and fixtures carry over. |

### Schema sketch

```
orgs, users              mirrored from Clerk by webhook
plans                    id, org_id, owner_id, name, source_url, funda_project_id,
                         doc jsonb, updated_at
plan_versions            id, plan_id, doc jsonb, created_at, created_by
renders                  id, plan_id, prompt, provider, model, image_url,
                         status, cost_cents
subscriptions            org_id, stripe_customer_id, price_id, status, seats
usage_events             org_id, kind ('render' | 'import'), qty, created_at
```

One `entitlements(orgId)` function reads `subscriptions` + `usage_events` and answers "can they do
this?". Every route calls it. Never scatter plan checks.

---

## AI rendering

Keys never reach the browser. The flow:

```
POST /api/renders
  → entitlements + quota check
  → buildPrompt(doc, opts)          lib/engine/prompt.ts
  → paint() to a server canvas      lib/engine/render.ts + @napi-rs/canvas
  → provider.generate(prompt, referenceImage)
  → store to R2, insert `renders`
```

Put providers behind one adapter (`server/providers/*.ts`) and start with a single one. For
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
3. **Auth + persistence.** Clerk, Neon, plans in Postgres. Keep localStorage as an offline cache so
   the thing still works on a train.
4. **Billing.** Checkout, portal, webhooks, `entitlements()`, quotas.
5. **Renders.** Server canvas, provider adapter, job row, gallery per plan.

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

- **`middleware` is renamed to `proxy`.** Clerk's auth guard is normally a
  `middleware.ts`; on 16 that file is `proxy.ts` exporting `proxy`, and it runs on
  the Node runtime only — the `edge` runtime is not supported there.
- **Request APIs are async.** `params`, `searchParams`, `cookies()` and `headers()`
  must be awaited. Nothing in the editor touches them yet, but every route added
  for billing, renders and the Funda proxy will.
