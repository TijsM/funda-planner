# Plattegrond Studio — test suite

Playwright, driving the real single-file app in Chrome.

    cd tests
    npm test                     # everything (~40s)
    npx playwright test 02       # one spec
    npx playwright test --ui     # interactive
    npm run report               # last HTML report

## What is covered

| spec | covers |
|---|---|
| `01-import` | boot, the three start routes, Funda→Floorplanner import (per-floor wall/opening/room counts, Dutch room names, provenance, coordinate normalisation), the step log, the paste-source fallback, listings with no floor plan, and that every floor actually paints |
| `02-simple` | the meeting UI: floor chips, the Add tray (filtering, click-to-arm, drag-to-drop), placing and editing furniture / walls / doors / rooms / notes / arrows / measures entirely from the on-object toolbar, dragging to move, undo/redo, keyboard |
| `03-pro` | mode switching and persistence, the drawing tools, the inspector's numeric fields, marquee + multi-select, zoom/fit/layer toggles, floor add & delete |
| `04-persistence` | save → wipe → reload from the library (incl. thumbnail rendering), delete/clear, autosave restore, JSON export→import round-trip, corrupt-file handling, PNG export (real PNG header + dimensions), reference-image toggle |
| `06-ai-export` | the image-generator export: prompt built from real geometry (rooms, areas, orientation, windows, furniture), the four viewpoints, single-room scoping, the furniture/measurement toggles, a clean reference image with the dimension lines provably gone, and clipboard + download |
| `05-file-url` | the same app opened as `file://`, which is how it is actually used — the strictest CORS case (origin `null`) |
| `07-wheel` | trackpad zoom and pan, and the non-passive wheel listener that keeps a pinch off the page |
| `08-descriptions` | the free-text description on every object, through the toolbar, the inspector, the prompt and a save/reload |
| `09-focus` | typing character by character in every field, so a component that remounts per keystroke cannot hide behind `fill()` |
| `10-gate` | the gate, in both of the app's modes: with no Supabase credentials there is no gate at all and a page request lands on the editor; with credentials and no session a page request is redirected to `/login` carrying where it was headed, an API call gets a JSON 401 rather than a redirect a `fetch` cannot read, and the login screen asks for an email address |
| `11-render` | generating a render against a stubbed provider: the elapsed run, the filmstrip, a reload, the one-credit-per-double-click guard, a failure kept as a retry, the seed field, and the three ways Generate is switched off |

`10-gate` and `11-render` need a real server, so both skip themselves unless
`E2E_TARGET=next`.

Unit tests are Vitest, run from the repo root with `pnpm test`: the geometry
engine, the render store (against `fake-indexeddb`, under jsdom), the render job
state machine, and the three pieces of the Supabase layer that are pure logic —
`mode()` and its env parsing, the library merge's last-write-wins, and the sync's
size guard and push interval (with the Supabase client mocked out).

## Determinism

`helpers.mockNetwork` serves the Funda page and the Floorplanner `.fml` from
`fixtures/`, so the import pipeline is exercised precisely and offline. One test
(`live network`) deliberately hits the real services, so a change on their side
is caught rather than hidden by the fixtures; it skips itself if the reader
proxy is rate-limiting.

`localStorage` is cleared once per test, not per navigation — otherwise reload
and autosave behaviour could never be observed. The render database goes with
it: IndexedDB survives between tests *and* between whole runs, so one leftover
render would make every filmstrip assertion depend on what ran yesterday.

**The suite runs in local mode**, with the Supabase variables blanked on the
`webServer`, so there is no gate and `fresh()` has no cookie to forge. That is
not a convenience: Supabase's auth cookie is a signed JWT from its own server, so
the trick the old suite used — minting a session in Node from `SESSION_SECRET` —
is not available at any price. Blanking the variables is also what stops a
developer whose `.env.local` holds real credentials from getting 68 red specs
that only say "login screen".

The gate therefore gets its own run: `E2E_GATE=1 pnpm exec playwright test`
swaps the whole config for one server on port 3501 carrying dummy credentials.
The dummy URL is deliberately unresolvable (`https://gate-test.invalid`) — a
token-less request never needs the network, so if the gate ever grows a round
trip the fetch fails and the spec goes red instead of quietly passing.

No spec ever reaches the image provider — `11-render` intercepts both render
routes by exact pathname and answers with a 1×1 PNG. Every real render costs
money, so a stub that missed would be a bill, not a red test.

## Gotchas worth remembering

- The device preset carries its own viewport, so ours must come **after** the
  spread in `playwright.config.js` or the window silently shrinks to 1280×720
  and canvas clicks land on the side panels.
- Canvas geometry differs between Simple and Pro mode; use `clickFrac`, not
  absolute pixels, for anything that runs in both.
- The view toggles are styled checkboxes whose real `<input>` is
  `display:none` — drive them through the label (`setToggle`).
