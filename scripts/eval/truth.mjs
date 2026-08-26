/** The ground-truth sidecar: what the plan says is true, written in the pixels
 *  of the frame the conditioning image was drawn in.
 *
 *  The whole method (ControlNet++, arXiv:2404.07987) is to run an extractor over
 *  the generated image and compare what comes back with the condition that went
 *  in. Our advantage is that we never have to extract the condition — we hold it
 *  as vectors. Converting it to pixels HERE, once, is what keeps every metric
 *  free of centimetres, of the view transform, and of any chance that two
 *  metrics disagree about where a room is.
 *
 *  Pure: no canvas, no DOM, no network. The envelope is rasterised into a plain
 *  Uint8Array, which is also why this file has no dependency on @napi-rs/canvas.
 */
import { engine } from './plans.mjs';

const [{ planFacts }, { polyArea }, { labelOf }, { wallQuad }, { SEATS, heightOf }] = await Promise.all([
  engine('prompt.ts'), engine('geometry.ts'), engine('model.ts'), engine('shapes.ts'), engine('catalog.ts'),
]);

const r2 = n => Math.round(n * 100) / 100;

/** The sidecar, in the words the metrics read it by. Everything is in frame
 *  pixels except `areaM2`, which is the real room in the real building, and `z`,
 *  which is centimetres above the floor.
 *
 *  @typedef {{ width: number, height: number,
 *              view: { zoom: number, px: number, py: number },
 *              bbox: import('@engine/types').BBox }} Frame
 *  @typedef {{ id: string, name: string, poly: number[][], rank: number | null, areaM2: number }} TruthRoom
 *  @typedef {{ kind: string, name: string, x: number, y: number,
 *              w: number, h: number, rot: number, z: number }} TruthItem
 *  @typedef {{ type: 'door' | 'window', x: number, y: number, width: number }} TruthOpening
 *  @typedef {{ plan: string, floor: string, frame: { width: number, height: number },
 *              envelope: number[][], rooms: TruthRoom[], items: TruthItem[],
 *              openings: TruthOpening[], expectedSeats: number }} Truth
 */

/** The sidecar for one plan in one frame.
 *
 *  `plan` is what plans.mjs yields; `frame` is what planFrame() returned for it
 *  — pass the same frame the conditioning image was painted in, or every
 *  coordinate here is a lie about a picture nobody rendered.
 *
 *  @param {import('./plans.mjs').Plan} plan @param {Frame} frame @returns {Truth} */
export function truthFor(plan, frame) {
  const f = plan.floor;
  const { zoom, px, py } = frame.view;
  const X = wx => wx * zoom + px;
  const Y = wy => wy * zoom + py;
  const pt = p => [r2(X(p.x)), r2(Y(p.y))];

  /* rank is the point of this file. It is read off planFacts rather than
     recomputed, because the hypothesis under test — that rooms described later
     in the brief drift further — is only measurable while these two orderings
     are the same one. buildPrompt lists F.rooms in order; anything planFacts
     leaves out (unnamed, or under 1 m²) is never named in the brief at all and
     gets rank null rather than a rank it does not have. */
  const F = planFacts(f);
  const rank = new Map(F.rooms.map((r, i) => [r.a.id, i]));

  const openings = [];
  for (const w of f.walls) {
    const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y;
    const L = Math.hypot(dx, dy) || 1;
    for (const o of w.openings) {
      /* the centre and width the renderer actually draws — an opening wider than
         its own wall is clipped to it, and the sidecar has to say what is on the
         picture, not what the document asked for */
      const t = Math.min(Math.max(o.at, 0), 1) * L;
      openings.push({
        type: o.type,
        x: r2(X(w.a.x + (dx / L) * t)),
        y: r2(Y(w.a.y + (dy / L) * t)),
        width: r2(Math.min(o.width, L) * zoom),
      });
    }
  }

  return {
    plan: plan.id,
    floor: f.name,
    frame: { width: frame.width, height: frame.height },
    envelope: envelopePx(f, frame, X, Y),
    rooms: f.areas.map(a => ({
      id: a.id,
      name: (a.name || '').trim(),
      poly: a.poly.map(pt),
      rank: rank.has(a.id) ? rank.get(a.id) : null,
      areaM2: r2(polyArea(a.poly) / 10000),
    })),
    items: f.items.map(i => ({
      kind: i.kind,
      name: labelOf(i),
      x: r2(X(i.x)), y: r2(Y(i.y)),
      w: r2(i.w * zoom), h: r2(i.h * zoom),
      rot: i.rot || 0,
      z: heightOf(i.kind),
    })),
    openings,
    /* What is DRAWN, which is what a render is asked to copy. It agrees with the
       number buildPrompt states on all ten fixtures, but the two sums are not the
       same sum: the brief counts only items that "speak" (planFacts drops a
       `fromFunda` item carrying no name and no description), so an imported plan
       whose anonymous fitted blocks include a seated table would promise fewer
       chairs than the drawing shows. The drawing is the right truth for a metric;
       the divergence is recorded here so nobody reads agreement as identity. */
    expectedSeats: f.items.reduce((n, i) => n + (SEATS[i.kind] || 0), 0),
  };
}

/* ── the envelope ───────────────────────────────────────────────────────── */

/** Cells across the frame's long side. 512 puts a cell at roughly 2 cm of a
 *  typical Dutch floor, which is finer than any wall is thin, and keeps the
 *  trace under a millisecond. */
const GRID = 512;
/** A ring of empty cells, so the flood that finds "outside" always has a border
 *  to start from even when the building runs to the edge of the frame. */
const PAD = 2;

/** The outer footprint of the building, as a polygon in frame pixels.
 *
 *  Walls and rooms together, exactly as shellBBox() defines the building — a
 *  garden bed drawn beyond the walls is part of the plan, a chair dropped
 *  outside is not. There is no polygon-union code here on purpose: the union of
 *  sixty wall quads is a boundary problem, and rasterising it, filling the
 *  interior and tracing the result is both shorter and impossible to get subtly
 *  wrong at a T-junction. The trace is exact on the raster; the raster is the
 *  only approximation, and it is one cell wide.
 */
function envelopePx(f, frame, X, Y) {
  const polys = [
    ...f.walls.map(w => wallQuad(w)),
    ...f.areas.filter(a => a.poly.length >= 3).map(a => a.poly),
  ].map(p => p.map(q => ({ x: X(q.x), y: Y(q.y) })));
  if (!polys.length) return [];

  const S = GRID / Math.max(frame.width, frame.height, 1);
  const gw = Math.ceil(frame.width * S) + PAD * 2;
  const gh = Math.ceil(frame.height * S) + PAD * 2;
  const mask = new Uint8Array(gw * gh);
  for (const p of polys) fillPoly(mask, gw, gh, p.map(q => ({ x: q.x * S + PAD, y: q.y * S + PAD })));

  const solid = enclose(largestComponent(mask, gw, gh), gw, gh);
  const ring = trace(solid, gw, gh);
  if (ring.length < 4) return [];
  return simplify(ring, 0.9).map(([gx, gy]) => [r2((gx - PAD) / S), r2((gy - PAD) / S)]);
}

/** even-odd scanline fill, sampling cell centres */
function fillPoly(mask, gw, gh, p) {
  let y0 = Infinity, y1 = -Infinity;
  for (const q of p) { if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
  const gy0 = Math.max(0, Math.floor(y0 - 0.5)), gy1 = Math.min(gh - 1, Math.ceil(y1));
  for (let gy = gy0; gy <= gy1; gy++) {
    const y = gy + 0.5;
    const xs = [];
    for (let i = 0, n = p.length; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n];
      if ((a.y > y) === (b.y > y)) continue;
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(gw - 1, Math.floor(xs[k + 1] - 0.5));
      for (let gx = from; gx <= to; gx++) mask[gy * gw + gx] = 1;
    }
  }
}

/** The building, not the shed at the bottom of the garden. */
function largestComponent(mask, gw, gh) {
  const seen = new Uint8Array(gw * gh);
  let best = null, bestN = 0;
  const stack = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    const cells = [];
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      const x = c % gw, y = (c - x) / gw;
      if (x > 0) push(c - 1); if (x < gw - 1) push(c + 1);
      if (y > 0) push(c - gw); if (y < gh - 1) push(c + gw);
    }
    if (cells.length > bestN) { bestN = cells.length; best = cells; }
  }
  function push(j) { if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); } }
  const out = new Uint8Array(gw * gh);
  (best ?? []).forEach(c => { out[c] = 1; });
  return out;
}

/** Fill the rooms in: the envelope is the outline of the building, and every
 *  cell the outside cannot reach is inside it. */
function enclose(mask, gw, gh) {
  const outside = new Uint8Array(gw * gh);
  const stack = [];
  const push = j => { if (!mask[j] && !outside[j]) { outside[j] = 1; stack.push(j); } };
  for (let x = 0; x < gw; x++) { push(x); push((gh - 1) * gw + x); }
  for (let y = 0; y < gh; y++) { push(y * gw); push(y * gw + gw - 1); }
  while (stack.length) {
    const c = stack.pop();
    const x = c % gw, y = (c - x) / gw;
    if (x > 0) push(c - 1); if (x < gw - 1) push(c + 1);
    if (y > 0) push(c - gw); if (y < gh - 1) push(c + gw);
  }
  const out = new Uint8Array(gw * gh);
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

/** Marching squares on the cell corners: walk the boundary keeping filled cells
 *  on the right. At a saddle — two filled cells meeting corner to corner — both
 *  a left and a right turn are legal; turning clockwise every time is arbitrary
 *  but it is consistent, which is what stops the walk oscillating. */
function trace(mask, gw, gh) {
  const at = (x, y) => (x < 0 || y < 0 || x >= gw || y >= gh ? 0 : mask[y * gw + x]);
  let start = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return [];

  let cx = start % gw, cy = (start - (start % gw)) / gw;
  const x0 = cx, y0 = cy;
  let dx = 1, dy = 0;
  const path = [];
  for (let step = 0; step < gw * gh * 4; step++) {
    path.push([cx, cy]);
    const a = at(cx - 1, cy - 1), b = at(cx, cy - 1), c = at(cx - 1, cy), d = at(cx, cy);
    const opts = [];
    if (d && !b) opts.push([1, 0]);
    if (c && !d) opts.push([0, 1]);
    if (a && !c) opts.push([-1, 0]);
    if (b && !a) opts.push([0, -1]);
    if (!opts.length) break;
    const cw = [-dy, dx];
    const pick = opts.length === 1 ? opts[0] : (opts.find(o => o[0] === cw[0] && o[1] === cw[1]) ?? opts[0]);
    [dx, dy] = pick;
    cx += dx; cy += dy;
    if (cx === x0 && cy === y0) break;
  }
  return path;
}

/** Douglas-Peucker, after collapsing the lattice path's collinear runs. `eps` is
 *  in grid cells: below one cell there is nothing left to keep. */
function simplify(pts, eps) {
  const run = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = run[run.length - 1], q = pts[i];
    if (run.length > 1) {
      const o = run[run.length - 2];
      if ((p[0] - o[0]) * (q[1] - p[1]) === (p[1] - o[1]) * (q[0] - p[0])) { run[run.length - 1] = q; continue; }
    }
    run.push(q);
  }
  const keep = new Uint8Array(run.length);
  keep[0] = keep[run.length - 1] = 1;
  const walk = (i, j) => {
    if (j <= i + 1) return;
    const [ax, ay] = run[i], [bx, by] = run[j];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    let worst = -1, at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((bx - ax) * (ay - run[k][1]) - (ax - run[k][0]) * (by - ay)) / L;
      if (d > worst) { worst = d; at = k; }
    }
    if (worst <= eps) return;
    keep[at] = 1;
    walk(i, at); walk(at, j);
  };
  walk(0, run.length - 1);
  return run.filter((_, i) => keep[i]);
}
