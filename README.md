# Plattegrond Studio

Paste a [Funda](https://www.funda.nl) listing URL and get its **real, editable floor plan** — then
rearrange furniture, knock walls through, annotate and measure, live, in a meeting.

One self-contained HTML file. Double-click it; no build, no server, no install.

```
open index.html
```

---

## How the Funda import actually works

Funda serves a captcha to anything that isn't a browser, so a direct fetch is impossible. But the
listing page embeds a **Floorplanner** project id, and Floorplanner publishes the project's `.fml`
to a public S3 bucket with `Access-Control-Allow-Origin: *`. So:

1. Read the listing HTML through the `r.jina.ai` reader proxy — the one route tested that gets past
   the captcha *and* returns CORS headers (including for `file://`, whose origin is `null`).
2. Pull out the Floorplanner project id plus each floor's design id and name.
3. Download the `.fml` **vector geometry** straight from Floorplanner.

The result is genuine editable geometry — walls with thickness, doors and windows as real openings,
named rooms with areas, fitted objects — not a traced bitmap. On the reference listing that is
5 floors, 183 walls, 53 openings and 31 named rooms.

**Privacy note:** the listing URL you paste is sent to `r.jina.ai`, a third-party service. Nothing
else leaves your machine; everything you save stays in your browser's `localStorage`.

**Fallbacks** when the proxy is rate-limited or the listing has no interactive plan: paste the page
source yourself (View Source → paste), or drop in a floor-plan image and calibrate the scale by
clicking a known distance.

---

## Two modes

**Simple** (the default) is built for talking over a plan with people watching. No tool rail, no
inspector — the plan gets the whole screen, and there is exactly one rule:

> Everything you add comes out of the ⊕ Add tray. Everything already on the plan you just drag.

There are no tool modes. Walls, rooms, text, arrows and measures sit in the tray next to the
furniture and drop like any other object. Click something and a toolbar appears **on it**, showing
only what that thing can do:

| Selected | Buttons |
|---|---|
| Furniture | rotate 90° · mirror · colour · duplicate · delete |
| Wall | **+ Door** · **+ Window** · live length · delete |
| Door / window | width − / + · swap hinge · swing side · remove |
| Room | name field · live m² · colour · delete |
| Note | text field · colour · bigger / smaller · delete |

So "put a door here" is: click the wall → click Door.

**Pro** is one click away, top right: tool rail, inspector with numeric X/Y/W/H, marquee select,
layer toggles, floor management. The choice is remembered.

## The rest

- 86 furniture and garden objects at real dimensions, across Living, Dining, Bedroom, Kitchen,
  Bathroom, Structure and **Garden** (trees, terrace, pool, pergola, hedge, shed…).
- Every floor of the listing, as chips along the bottom.
- Snapping to a 5 cm grid and to existing endpoints, 15° angle snap, undo/redo, arrow-key nudging.
- Save to an in-browser library with thumbnails; export/import `.json`; export the current floor
  as a PNG with a title block.
- Autosaves, and reopens where you left off.
- Deep links: `#import=<funda url>`, `#new`, `#garden`.

## Keyboard

`V H W R D N T M` tools (Pro) · `G` grid · `S` snapping · `B` reference image · `L` ghost floor
below · `A` Add tray (Simple) · `⌘Z` / `⇧⌘Z` undo, redo · `⌘D` duplicate · `⌫` delete · `0` fit ·
`⌘S` save · space-drag to pan · wheel to zoom · arrows to nudge (⇧ = 10×)

## Tests

Playwright, driving the real file in Chrome — 52 tests, ~40 s.

```
cd tests && npm install && npm test
```

Imports run against local fixtures so they are deterministic and offline, with one deliberate live
test against the real services so an upstream change is caught rather than hidden. See
[`tests/README.md`](tests/README.md).

## Layout

```
index.html                the entire application
tests/                    Playwright suite + fixtures
```
