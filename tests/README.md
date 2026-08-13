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

## Determinism

`helpers.mockNetwork` serves the Funda page and the Floorplanner `.fml` from
`fixtures/`, so the import pipeline is exercised precisely and offline. One test
(`live network`) deliberately hits the real services, so a change on their side
is caught rather than hidden by the fixtures; it skips itself if the reader
proxy is rate-limiting.

`localStorage` is cleared once per test, not per navigation — otherwise reload
and autosave behaviour could never be observed.

## Gotchas worth remembering

- The device preset carries its own viewport, so ours must come **after** the
  spread in `playwright.config.js` or the window silently shrinks to 1280×720
  and canvas clicks land on the side panels.
- Canvas geometry differs between Simple and Pro mode; use `clickFrac`, not
  absolute pixels, for anything that runs in both.
- The view toggles are styled checkboxes whose real `<input>` is
  `display:none` — drive them through the label (`setToggle`).
