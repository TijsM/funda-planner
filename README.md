# Plattegrond Studio

Paste a [Funda](https://www.funda.nl) listing URL and get its **real, editable floor plan** — then
rearrange furniture, knock walls through, annotate and measure, live, in a meeting.

**▶ Live: [tijsm.github.io/funda-planner](https://tijsm.github.io/funda-planner/)**

One self-contained HTML file. Use it hosted, or double-click it locally — no build, no server, no
install, works fully offline apart from the listing import.

```
open index.html
```

The same editor also runs as a Next app (`app/`, `src/`). That is the build with accounts, and the
one that generates the AI renders itself instead of handing you a prompt to carry elsewhere — see
[Accounts](#accounts-and-where-your-work-lives).

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

**Privacy note:** the listing URL you paste is sent to `r.jina.ai`, a third-party service. Where the
plan itself then goes depends on whether you are signed in — see below.

**Fallbacks** when the proxy is rate-limited or the listing has no interactive plan: paste the page
source yourself (View Source → paste), or drop in a floor-plan image and calibrate the scale by
clicking a known distance.

---

## Accounts, and where your work lives

There are two ways this runs, and which one you get depends entirely on whether the deployment has
Supabase credentials.

**With an account.** Sign in with your email address: you get a six-digit code, you type it in,
that is the whole flow. There is no password anywhere in the system, so there is nothing to leak,
reset or rotate. From then on your plans follow you between machines, and so do your renders — the
documents in Postgres, the PNGs in a private bucket only your account can read. Your browser still
holds a copy of every plan and the editor still writes to it synchronously, so nothing you do waits
on the network; the copy upstairs catches up on a timer. Two devices editing one plan is
last-write-wins, and the loser's edits are gone.

**Without one.** No credentials, no accounts, no sign-in — the editor is exactly what it was before
any of this. Everything you save stays in your browser's `localStorage`, renders in IndexedDB,
nothing leaves the machine but the listing import. That is what the standalone `index.html` above
is, what the test suite runs against, and what you get by cloning this and typing `pnpm dev`.

Setting the first one up is [`docs/SUPABASE.md`](docs/SUPABASE.md), which is written to be followed
against an empty Supabase project. `.env.example` lists every variable.

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

## Feeding it to an image generator

**Render** in the top bar produces the two things a generator needs:

- **A prompt written from the actual geometry** — the camera and the reference image first, as hard
  constraints, then a LOCKED block: the floor and its footprint, every named room with its area and
  where it sits on the plan as a table, every object on its own row as another, which sides the
  windows are on (so the light comes from the right direction), and explicit instructions not to
  invent walls or rooms. Every object row carries where it sits in its own room — not to place it,
  which the drawing does pixel-exactly, but to say which of that room's blocks the row is about. Four viewpoints (top-down,
  eye level, isometric, watercolour sketch) rewrite it; you can scope it to a single room, add your own style line, and
  edit the text before copying. The street address is deliberately not in it: it steers nothing in
  an image and pulls the model towards whatever real building it half-remembers.
- **A clean reference image** to attach — the plan with no grid, no dimension lines, no notes and no
  UI, so the model copies the layout instead of the drawing furniture. Nothing on it is written:
  every object is named in the prompt instead, in the OBJECTS table, with where it sits in its room.

  That is not a stylistic choice, it is the second half of a lesson that cost two renders. Captions
  came first, and they were unreadable: about 12 px on the 1800 px reference, 0.7% of the image, seen
  through an image model's 8× downsample as a pixel and a half of grey. The objects that came back
  wrong were exactly the ones whose identity lived only in that lettering — a fireplace as a cabinet,
  two oak vitrines as a white bookcase. So they were replaced with numbered discs at 2% of the image,
  legible by construction, and the next render came back with nine black roundels painted onto the
  floor. There is no size at which our annotation is read as annotation: the picture is the thing
  being copied, and everything on it is geometry. Words are the only channel with no bleed at all —
  the worst a wrong phrase can do is describe the wrong sofa, and the drawing still says where the
  sofa is. Room names and measurements on the image stay as toggles, both off by default, for the
  same reason.

Copy either to the clipboard, or download the image.

### Descriptions

Every object and every room takes a **description** — free text, empty by default. Select something
and press the ✦ button for a one-line field; the Pro inspector has the same field with more room.
Whatever you write lands in the Notes column of the row for that object or room, and the LOCKED
header tells the model every Notes cell is an instruction rather than flavour text:

```
ROOMS
Room | Size | Where | Notes
Woonkamer | 26.2 m² | west | wide oak floorboards, low winter light

OBJECTS — each one is already drawn on the plan; keep it exactly where it is
Room | Object | Size | Notes
Woonkamer | sofa 3-seat | 225×95 cm | dark green velvet, mid-century, low back
Woonkamer | coffee table | 110×60 cm | —
```

The **Size** column only appears when *Include measurements* is on: a size in the prose is an
invitation to letter the render with it, which is the same failure as our own dimension captions.

A described object is listed even when it is a fitted unit imported from the listing, which is
otherwise skipped as noise. Object descriptions follow the *List the furniture* toggle; room
descriptions are always included.

### Photos of the real thing

Words cannot specify furniture you have already chosen. So every object and every room also takes
**photographs** — select something and the strip under the description takes as many as six: the
shop's picture, your own snap in the showroom, the swatch. They are sent with the render as
additional reference images, and the brief names each one as the object it shows:

```
Images 2-3 are photographs of objects on this plan, not scenes. Reproduce each pictured object
exactly — same design, colour, material — where image 1 draws it. Ignore their backgrounds,
lighting and camera angle.
Image 2: sofa 3-seat, woonkamer.
Image 3: kitchen island, keuken (the oak front).
```

Each sentence quotes the object's number on the plan (`Image 2: #6 sofa 3-seat, living room`), which
is the only part of it the model can locate in the picture — the name and the room corroborate. And
what the sentence *asks for* depends on the camera: a photograph is taken at eye level, so from
above only its colour, material and finish can carry, while an eye-level render can reproduce the
piece itself. Promising the same thing either way is how a photograph of a white shaker kitchen came
back as dark grey marble.

Two things are worth knowing before you photograph the whole house:

- **There are only so many slots.** FLUX.2 takes eight reference images and the plan is one of them,
  so seven photographs go per render — fewer if you also tick a map, because they share the same
  inputs. Qwen takes two; the two ControlNet providers take none at all and the panel says so. The
  render panel lists every photographed object in scope with a tick and the image number it will be,
  so what is going and what is not is on screen before you spend anything. Every ticked object sends
  its first photo before any object sends a second — coverage first, extra angles with what is left —
  and rendering one room at a time is how you reach the rest of the house.
- **Photos are not in the JSON export.** Like renders, they live in the account (a private Storage
  bucket, owner-scoped) and in this browser, keyed per plan. A plan file mailed to someone carries
  the references but not the pictures.

The document never holds image data: a `PhotoRef` is about a hundred bytes and the JPEG lives
outside it, because the plan is stringified into every undo snapshot and autosaved every three
seconds. Whatever you drop in is rotated by its EXIF, matted onto white if it has transparency, and
re-encoded to a 1024 px JPEG — which is the size the render request can actually afford to send.

### The render itself

The Next build renders the plan for you rather than handing you a brief to carry elsewhere. What
comes back drifts — the camera tilts into a dollhouse view, walls wander, chair counts change — and
the reason is documented by the vendor: FLUX.2 reads its reference image *semantically*. There is no
strength dial and no control map in its API, so no amount of prompting fixes it.

So the panel offers two things beyond Generate:

- **Model** — five providers, priced per output megapixel and quoted at the largest size each one can
  draw inside the ceiling, so the figures are comparable before you spend anything. Two of them take
  a real **control map**: an image, not a sentence, that the model is required to follow. FLUX.2 has
  no such channel — a map sent there rides along as another reference picture, and whether it reads
  it as geometry is unproven. The panel says which of the two you are getting.
- **Maps** — a line drawing, a depth map, a segmentation map or a change mask, all drawn from the
  same vector geometry as the plan and framed identically to the reference. A provider with a control
  channel takes one at a time; one without takes two, because each one costs the brief a sentence and
  the documented sweet spot is 30–80 words. Anything you tick that will not be sent is named, with
  the reason.

**No single image may cost more than $0.10.** That is enforced in the code and not merely printed:
the size is aimed under it, the route refuses a request over it, and a provider that publishes no
price at all is refused outright — an unpriced call cannot be shown to be under a ceiling. One
provider bills whole megapixels rounded up, which limits it to exactly 1 MP; the picker says so
rather than letting it arrive as a 400.

One model is held to a different number, and states it: GPT Image 2 bills for the images it is
*handed* as well as the one it draws, so the plan alone is $0.12 before a photograph is attached and
a dime is not a number it can be compared on. It carries its own ceiling of $0.35 — the worst case
the arithmetic in `src/data/providers.ts` spells out, rounded up — and the panel prints the price and
that ceiling side by side above Generate. Every provider that sells output megapixels is still held
to the $0.10, and a test asserts that a private ceiling is not handed out to any of them.

Whether any of this actually holds a layout is measured, not eyeballed — see
[`docs/EVAL.md`](docs/EVAL.md) and `pnpm eval`.

### Style

The **Style** field is free text and always has been — type anything and it goes through verbatim,
last in the brief, where it outranks the default daylight and material wording. Naming one of the
styles the field suggests (Scandinavian, Japandi, Mid-century modern, Industrial, Minimalist, Modern
farmhouse, Coastal, Art deco, Bohemian, Classic Dutch) adds a line spelling out the materials,
colours and light that word is supposed to mean — a bare label is one token competing with a
hundred others. Your own words are stated first and win wherever the two disagree.

## The rest

- 120 objects at real dimensions, across Living, Dining, Bedroom, Kitchen, Bathroom, Structure,
  **Decoration** (round plant pots in four sizes, pot clusters, hanging plants, planter boxes, round
  rugs, artwork, screens, baskets…) and **Garden** (round planters, raised round beds, fire pit,
  bird bath, water feature, hammock, stepping stones, trees, terrace, pool, pergola, shed…).
- Every object you place is labelled with its name; click it and edit the label right on the object,
  or clear it to hide it.
- Every floor of the listing, as chips along the bottom.
- Snapping to a 5 cm grid and to existing endpoints, 15° angle snap, undo/redo, arrow-key nudging.
- Hold **shift** while dragging the end of a ruler, wall or arrow to lock it to the axis (measured
  from the end that stays put), or while dragging an object to constrain it to one direction.
- Save to an in-browser library with thumbnails; export/import `.json`; export the current floor
  as a PNG with a title block, or as a prompt + reference image for an image generator.
- Autosaves, and reopens where you left off.
- Deep links: `#import=<funda url>`, `#new`, `#garden`.

## Keyboard

`V H W R D N T M` tools (Pro) · `G` grid · `S` snapping · `B` reference image · `L` ghost floor
below · `A` Add tray (Simple) · `⌘Z` / `⇧⌘Z` undo, redo · `⌘D` duplicate · `⌘C` / `⌘X` / `⌘V`
copy, cut, paste — the system clipboard, so a copy crosses tabs and plans; with nothing selected
`⌘C` copies the whole floor · `⌫` delete · `0` fit · `⌘S` save · space-drag to pan · wheel to zoom ·
arrows to nudge (⇧ = 10×)

## Tests

Playwright, driving the real file in Chrome — 68 tests, ~50 s.

```
pnpm test                        # Vitest — engine, render store, job state machine
pnpm test:e2e                    # Playwright — the standalone file
E2E_TARGET=next pnpm test:e2e    # the same specs against the Next app
E2E_GATE=1 pnpm test:e2e --project=gate   # sign-in, redirects, the JSON 401
```

The first three run the app with no accounts and no gate, and `playwright.config.ts` forces that by
blanking the Supabase variables for the server it starts — so a `.env.local` with real credentials
in it cannot turn the suite red. The gate run starts its own server with credentials pointed at a
host that deliberately cannot resolve.

Imports run against local fixtures so they are deterministic and offline, with one deliberate live
test against the real services so an upstream change is caught rather than hidden. See
[`tests/README.md`](tests/README.md).

## Layout

```
index.html                the standalone editor, one file, no build
src/engine/               the geometry, catalog, renderer and prompt — no DOM, no React
src/shell/                the React shell around it, and browser storage
src/data/  src/server/    Supabase: config, schema, plan sync, renders, object photos
app/                      Next routes: the editor, /login, /api/render
supabase/migrations/      the database, RLS policies, the render and photo buckets
tests/                    Playwright suite + fixtures, Vitest units
scripts/eval/             the render-fidelity sweep: run, score, diff
docs/                     ARCHITECTURE.md, SUPABASE.md, EVAL.md
```
