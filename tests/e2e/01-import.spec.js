import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fresh, S, APP, appUrl, toast, FUNDA_URL, FIXTURES, importMocked, starter, waitFloors, inkRatio, appFailures } from './helpers.js';

test.describe('boot', () => {
  test('opens in Simple mode with the importer up and no console errors', async ({ page }) => {
    const errors = await fresh(page);
    await page.goto(appUrl());
    await expect(page.locator('#ovImport')).toHaveClass(/open/);
    await expect(page.locator('#app')).toHaveClass(/simple/);
    await expect(page.locator('.toolrail')).toBeHidden();
    await expect(page.locator('.panel.right')).toBeHidden();
    await expect(page.locator('#floorbar')).toBeVisible();
    expect(errors).toEqual([]);
    expect(appFailures(page)).toEqual([]);
  });

  test('the three starting routes all work', async ({ page }) => {
    await fresh(page);
    await starter(page, 'new');
    let s = await S(page);
    expect(s.floors).toHaveLength(1);
    expect(s.floors[0].walls).toBe(4);
    expect(s.floors[0].openings).toBe(2);          // one door, one window

    await starter(page, 'garden');
    s = await S(page);
    expect(s.floors[0].name).toBe('Garden');
    expect(s.floors[0].names).toContain('Garden');
    expect(s.floors[0].items).toBe(2);             // terrace + lawn
  });
});

test.describe('Funda import', () => {
  test('rejects anything that is not a funda listing URL', async ({ page }) => {
    await fresh(page);
    await page.goto(appUrl());
    await page.locator('#inUrl').fill('https://example.com/nope');
    await page.locator('#btnGo').click();
    await expect(toast(page, 'funda.nl')).toBeVisible();
    await expect(page.locator('#steps .step')).toHaveCount(0);
  });

  test('recovers every plan, room and opening from the listing', async ({ page }) => {
    const errors = await fresh(page);
    await importMocked(page);
    const s = await S(page);

    expect(s.floors.map(f => f.name)).toEqual([
      'Begane Grond Tuin', 'Begane Grond', 'Eerste Verdieping', 'Tweede Verdieping', 'Berging',
    ]);
    expect(s.floors.map(f => f.level)).toEqual([0, 1, 2, 3, 4]);

    // geometry actually landed, per floor
    expect(s.floors.map(f => f.walls)).toEqual([64, 53, 30, 25, 11]);
    expect(s.floors.map(f => f.openings)).toEqual([14, 12, 15, 10, 2]);
    expect(s.floors.reduce((a, f) => a + f.areas, 0)).toBe(38);
    expect(s.floors.reduce((a, f) => a + f.items, 0)).toBe(69);

    // Dutch room names survive
    expect(s.floors[1].names).toEqual(expect.arrayContaining(['Woonkamer', 'Keuken', 'Hal']));

    // provenance
    expect(s.source.projectId).toBe(187897594);
    expect(s.source.address).toBe('Pieter Kleijnstraat 19 5246 GS Rosmalen');
    expect(s.source.url).toBe(FUNDA_URL);
    await expect(page.locator('#addrTag')).toHaveAttribute('href', FUNDA_URL);

    // coordinates normalised into positive space, floors share one origin
    const bounds = await page.evaluate(() =>
      window.__S.proj.floors.map(f => window.__contentBBox(f)).map(b => [b.x0, b.y0]));
    for (const [x, y] of bounds) { expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0); }

    expect(errors).toEqual([]);
    expect(appFailures(page)).toEqual([]);
  });

  test('reports each import stage and ends ready', async ({ page }) => {
    await fresh(page);
    await page.goto(appUrl());
    await page.locator('#inUrl').fill(FUNDA_URL);
    await page.locator('#btnGo').click();
    await waitFloors(page, 5);
    const steps = await page.locator('#steps .step').allInnerTexts();
    expect(steps.join(' ')).toMatch(/Listing page read/);
    expect(steps.join(' ')).toMatch(/Found project 187897594/);
    expect(steps.join(' ')).toMatch(/Vector geometry downloaded/);
    expect(steps.join(' ')).toMatch(/183 walls|Ready/);
    await expect(page.locator('#ovImport')).not.toHaveClass(/open/);
  });

  test('falls back to pasted page source when the proxy is unusable', async ({ page }) => {
    await fresh(page);
    await page.route('https://r.jina.ai/**', r => r.abort());       // proxy down
    await page.goto(APP);

    await page.locator('#inUrl').fill(FUNDA_URL);
    await page.locator('#btnGo').click();
    await expect(page.locator('#steps .step.err')).toBeVisible();
    await expect(page.locator('#steps')).toContainText(/blocked the request|Paste page source/i);

    await page.locator('#btnPasteSrc').click();
    const src = fs.readFileSync(path.join(FIXTURES, 'funda-listing.html'), 'utf8');
    await page.locator('#inSrc').fill(src);
    await page.locator('#btnParseSrc').click();
    await waitFloors(page, 5);
    expect((await S(page)).floors).toHaveLength(5);
  });

  test('a listing with no Floorplanner project fails with a useful message', async ({ page }) => {
    await fresh(page);
    await page.route('https://r.jina.ai/**', r =>
      r.fulfill({ status: 200, contentType: 'text/html', body: '<html><title>Huis te koop: Nowhere 1 | Funda</title>' + 'x'.repeat(4000) + '</html>' }));
    await page.goto(appUrl());
    await page.locator('#inUrl').fill(FUNDA_URL);
    await page.locator('#btnGo').click();
    await expect(page.locator('#steps .step.err')).toContainText('No Floorplanner project');
    await expect(page.locator('#steps')).toContainText(/floor-plan image instead/);
  });

  test('the plan is actually painted, on every floor', async ({ page }) => {
    await fresh(page);
    await importMocked(page);
    for (let i = 0; i < 5; i++) {
      await page.locator('#fchips .fchip').nth(i).click();
      await page.waitForTimeout(250);
      expect(await inkRatio(page), `floor ${i} draws ink`).toBeGreaterThan(0.01);
    }
  });
});

/* One test that really talks to Funda + Floorplanner, so a change on their
   side is caught rather than hidden behind the fixtures. */
test.describe('live network', () => {
  test('the real pipeline still returns 5 plans', async ({ page }) => {
    await fresh(page, { mock: false });
    test.setTimeout(120_000);
    await page.goto(APP + '#import=' + FUNDA_URL);
    try {
      await waitFloors(page, 5);
    } catch (e) {
      const steps = await page.locator('#steps').innerText().catch(() => '');
      test.skip(/rate-limit|429|blocked|HTTP 5/i.test(steps), 'reader proxy unavailable right now: ' + steps.slice(0, 200));
      throw e;
    }
    const s = await S(page);
    expect(s.floors).toHaveLength(5);
    expect(s.source.projectId).toBe(187897594);
    expect(s.floors.reduce((a, f) => a + f.walls, 0)).toBe(183);
  });
});
