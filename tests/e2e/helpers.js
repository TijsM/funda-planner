import { expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';

/* __dirname, not import.meta: the root package is CJS, and Playwright
   transpiles import syntax but leaves import.meta alone. */
const here = __dirname;
export const FIXTURES = path.join(here, '..', 'fixtures');
export const APP = process.env.E2E_TARGET === 'next' ? '/' : '/index.html';
export const FUNDA_URL = 'https://www.funda.nl/detail/koop/rosmalen/huis-pieter-kleijnstraat-19/44432123/';

/* The origin the gate protects. The legacy target is a static file server with
   no gate at all, so the cookie is only minted for the ported app. */
export const ORIGIN = 'http://localhost:3500';

/** Mints the same token `src/server/session.ts` signs — base64url(json) plus an
 *  HMAC-SHA256 over it. Duplicated rather than imported because helpers.js is
 *  transpiled JS and session.ts opens with `import 'server-only'`; if the scheme
 *  ever changes, the 68 specs that predate the gate go red in one go and say so. */
export function sessionToken(secret = process.env.SESSION_SECRET) {
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({ iat: Date.now() })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

/* ── a clean, deterministic app on every test ──────────────────── */
export async function fresh(page, opts = {}) {
  const errors = [];
  /* Generic "Failed to load resource" carries no URL, and the font CDN blips.
     So drop that noise here and assert on the request log instead, which does
     know the URL — a real app-origin 404 still fails the test. */
  const THIRD_PARTY = /fonts\.(googleapis|gstatic)\.com|favicon/i;
  const noise = t => /favicon/i.test(t) || /Failed to load resource/i.test(t);
  page.on('console', m => { if (m.type() === 'error' && !noise(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  /* The app guards unsaved work with a beforeunload prompt — correct
     behaviour, but it blocks page.goto(). Accept only that dialog; leave
     confirm()s to whichever test registered a handler for them. */
  page.on('dialog', async d => { if (d.type() === 'beforeunload') { try { await d.accept(); } catch (e) { } } });

  const bad = [];
  page.on('response', r => { if (r.status() >= 400 && !THIRD_PARTY.test(r.url())) bad.push(r.status() + ' ' + r.url()); });
  page.errors = errors;
  page.badRequests = bad;

  /* Clear storage ONCE per test, not on every navigation — otherwise reload
     and autosave behaviour can never be observed. sessionStorage is per-tab
     and starts empty in a fresh context, so it makes a perfect "first load" flag. */
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('__pw_cleared')) {
        localStorage.clear();
        /* Renders live in IndexedDB, which survives between tests AND between
           whole runs — one leftover render makes every filmstrip assertion
           depend on what ran yesterday. Queued here, before any app code opens
           the database, so the open waits behind the delete. The name is
           `IDB_NAME` in src/shell/renders.ts; this file cannot import it. */
        indexedDB.deleteDatabase('pgs.renders.v1');
        sessionStorage.setItem('__pw_cleared', '1');
      }
      localStorage.setItem('pgs.coach.v1', '1');   // never show the coach mark in tests
    } catch (e) { }
  });

  /* Walk in past the password gate. Without it every spec written before the
     gate existed lands on /login instead of the app. `auth: false` is how the
     gate's own specs ask to stay outside. */
  if (opts.auth !== false && process.env.E2E_TARGET === 'next') {
    const token = sessionToken();
    if (token) await page.context().addCookies([{ name: 'session', value: token, url: ORIGIN }]);
  }

  if (opts.mock !== false) await mockNetwork(page);
  return errors;
}

/* A hash-only change is a same-document navigation: the app would not re-boot.
   Bust it with a unique query so every call is a genuine fresh load. */
let navN = 0;
export const appUrl = hash => `${APP}?n=${++navN}${hash ? '#' + hash : ''}`;

/* toasts stack, so always assert against a filtered, first match */
export const toast = (page, text) => page.locator('.toast', { hasText: text }).first();

/* Serve the Funda page and the Floorplanner .fml from local fixtures so the
   import pipeline is tested exactly, without depending on a third party. */
export async function mockNetwork(page) {
  const html = fs.readFileSync(path.join(FIXTURES, 'funda-listing.html'), 'utf8');
  const fml = fs.readFileSync(path.join(FIXTURES, 'floorplanner-project.fml'), 'utf8');
  await page.route('https://r.jina.ai/**', r =>
    r.fulfill({ status: 200, contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: html }));
  await page.route('https://fmlpub.s3.eu-west-1.amazonaws.com/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: fml }));
  /* a tiny opaque PNG for the reference-image layer */
  await page.route('https://cloud.funda.nl/**', r =>
    r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' },
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') }));
}

export const S = page => page.evaluate(() => JSON.parse(JSON.stringify({
  simple: window.__S.simple, fi: window.__S.fi, sel: window.__S.sel,
  place: window.__S.place, zoom: window.__S.zoom, px: window.__S.px, py: window.__S.py,
  dirty: window.__S.dirty,
  name: window.__S.proj && window.__S.proj.name,
  source: window.__S.proj && window.__S.proj.source,
  floors: (window.__S.proj ? window.__S.proj.floors : []).map(f => ({
    name: f.name, level: f.level,
    walls: f.walls.length, areas: f.areas.length, items: f.items.length,
    notes: f.notes.length, dims: f.dims.length, lines: f.lines.length,
    openings: f.walls.reduce((s, w) => s + w.openings.length, 0),
    names: f.areas.map(a => a.name).filter(Boolean),
  })),
})));

export const floorOf = page => S(page).then(s => s.floors[s.fi]);

/* wait until the import has produced a project with N floors */
export async function waitFloors(page, n) {
  await page.waitForFunction(
    n => window.__S && window.__S.proj && window.__S.proj.floors.length === n,
    n, { timeout: 30_000 });
}

export async function importMocked(page, floors = 5) {
  await page.goto(appUrl('import=' + FUNDA_URL));
  await waitFloors(page, floors);
  await page.waitForTimeout(300);
}

export async function starter(page, which = 'new') {
  await page.goto(appUrl(which));
  await page.waitForFunction(() => window.__S && window.__S.proj);
  await page.waitForTimeout(200);
}

/* anything the app itself asked for and did not get */
export const appFailures = page => page.badRequests || [];

/* The importer opens whenever there is no session to restore, and it covers
   the top bar. Anything driving the top bar after a reload must clear it. */
export async function dismissModal(page) {
  const ov = page.locator('.ov.open:not(.pass)');
  if (await ov.count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
}

/* click an existing object on the canvas by its world position */
export async function clickObject(page, wx, wy) {
  const p = await screenOf(page, wx, wy);
  await clickPlan(page, p.x, p.y);
  await page.waitForTimeout(150);
}

/* the view toggles are styled checkboxes — the real input is display:none,
   so drive them the way a person does, through the label */
export async function setToggle(page, id, on) {
  const cur = await page.locator(id).isChecked();
  if (cur !== on) await page.locator(`.tg:has(${id})`).click();
  await page.waitForTimeout(80);
}

/* ── canvas interaction ────────────────────────────────────────── */
export const cv = page => page.locator('#cv');
export const clickPlan = (page, x, y, opts) => cv(page).click({ position: { x, y }, ...opts });

/* Click at a fraction of the canvas. The canvas is a very different size in
   Simple vs Pro mode, so absolute pixels are not portable between them. */
export async function clickFrac(page, fx, fy, opts) {
  const b = await cv(page).boundingBox();
  await cv(page).click({ position: { x: Math.round(b.width * fx), y: Math.round(b.height * fy) }, ...opts });
  await page.waitForTimeout(80);
}
export const fracPoint = async (page, fx, fy) => {
  const b = await cv(page).boundingBox();
  return { x: Math.round(b.width * fx), y: Math.round(b.height * fy) };
};

export async function dragPlan(page, x1, y1, x2, y2) {
  const b = await cv(page).boundingBox();
  await page.mouse.move(b.x + x1, b.y + y1);
  await page.mouse.down();
  await page.mouse.move(b.x + (x1 + x2) / 2, b.y + (y1 + y2) / 2, { steps: 6 });
  await page.mouse.move(b.x + x2, b.y + y2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
}

/* open the Add tray, click a tile, then drop it on the plan */
export async function addFromTray(page, kind, x, y) {
  const tray = page.locator('#tray');
  if (!(await tray.evaluate(e => e.classList.contains('open')))) await page.locator('#fAdd').click();
  await expect(tray).toHaveClass(/open/);
  await page.locator(`.tile[data-kind="${kind}"]`).click();
  await page.waitForTimeout(120);
  await clickPlan(page, x, y);
  await page.waitForTimeout(200);
}

/* screen position of a world point, for aiming at an existing object */
export const screenOf = (page, wx, wy) =>
  page.evaluate(([x, y]) => ({ x: x * window.__S.zoom + window.__S.px, y: y * window.__S.zoom + window.__S.py }), [wx, wy]);

/* how much of the canvas is actually painted (0 = blank paper) */
export const inkRatio = page => page.evaluate(() => {
  const c = document.querySelector('#cv');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let ink = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 37) {
    n++;
    if (Math.abs(d[i] - 243) > 12 || Math.abs(d[i + 1] - 240) > 12 || Math.abs(d[i + 2] - 231) > 12) ink++;
  }
  return ink / n;
});
