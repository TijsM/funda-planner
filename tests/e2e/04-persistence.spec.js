import { test, expect } from '@playwright/test';
import fs from 'fs';
import { fresh, S, floorOf, importMocked, starter, addFromTray, appUrl, toast, APP, FUNDA_URL, inkRatio } from './helpers.js';

test.beforeEach(async ({ page }) => { await fresh(page); });

test.describe('the library', () => {
  test('save, wipe, reload — everything comes back', async ({ page }) => {
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(1).click();
    await page.waitForTimeout(250);

    await addFromTray(page, 'sofa3', 700, 420);
    await addFromTray(page, 'draw:room', 900, 500);
    await page.locator('#ctxName').fill('Werkkamer');
    await addFromTray(page, 'draw:note', 800, 320);
    await page.locator('#ctxNote').fill('muur eruit');
    await page.waitForTimeout(200);

    await page.locator('#projName').fill('Overleg 13 aug');
    await page.locator('#btnSave').click();
    await expect(toast(page, 'Overleg 13 aug')).toBeVisible();
    const saved = (await S(page)).floors[1];

    // destroy the in-memory plan
    await page.evaluate(() => {
      const f = window.__S.proj.floors[1];
      f.items.length = 0; f.walls.length = 0; f.areas.length = 0; f.notes.length = 0;
    });

    await page.locator('#btnLib').click();
    await expect(page.locator('#libList .lib-i')).toHaveCount(1);
    await expect(page.locator('#libList .lib-i')).toContainText('Overleg 13 aug');
    await expect(page.locator('#libList .lib-i')).toContainText('Pieter Kleijnstraat');
    await expect(page.locator('#libList .lib-i')).toContainText('5 floor(s)');

    // the thumbnail is a real render, not an empty canvas
    const thumbInk = await page.evaluate(() => {
      const c = document.querySelector('#libList canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { n++; if (Math.abs(d[i] - 243) > 12 || Math.abs(d[i + 2] - 231) > 12) ink++; }
      return ink / n;
    });
    expect(thumbInk).toBeGreaterThan(0.01);

    await page.locator('#libList .lib-i [data-act=open]').click();
    await page.waitForTimeout(600);
    const back = (await S(page)).floors[1];
    expect(back).toMatchObject({
      walls: saved.walls, areas: saved.areas, items: saved.items, notes: saved.notes,
    });
    expect(back.names).toContain('Werkkamer');
    expect((await S(page)).source.projectId).toBe(187897594);
    expect((await S(page)).name).toBe('Overleg 13 aug');
  });

  test('a saved plan can be deleted and the library cleared', async ({ page }) => {
    await starter(page);
    await page.locator('#projName').fill('Weg hiermee');
    await page.locator('#btnSave').click();
    await page.locator('#btnLib').click();
    await expect(page.locator('#libList .lib-i')).toHaveCount(1);

    page.once('dialog', d => d.accept());
    await page.locator('#libList .lib-i [data-act=del]').click();
    await expect(page.locator('#libList .empty')).toBeVisible();

    await page.locator('#ovLib [data-close]').click();      // the modal covers the top bar
    await expect(page.locator('#ovLib')).toBeHidden();
    await page.locator('#btnSave').click();
    await page.locator('#btnLib').click();
    await expect(page.locator('#libList .lib-i')).toHaveCount(1);
    page.once('dialog', d => d.accept());
    await page.locator('#btnWipe').click();
    await expect(page.locator('#libList .empty')).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pgs.index.v2') || '[]'))).toEqual([]);
  });
});

test.describe('autosave', () => {
  test('a reload picks up exactly where you left off', async ({ page }) => {
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(2).click();
    await page.waitForTimeout(200);
    await addFromTray(page, 'bed140', 700, 420);
    await page.locator('#projName').fill('Niet opgeslagen');
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__S && window.dispatchEvent(new Event('beforeunload')));
    await page.waitForTimeout(400);

    // reload WITHOUT clearing storage this time
    await page.goto(appUrl());
    await page.waitForFunction(() => window.__S && window.__S.proj);
    await page.waitForTimeout(400);

    const s = await S(page);
    expect(s.name).toBe('Niet opgeslagen');
    expect(s.floors).toHaveLength(5);
    expect(s.floors[2].items).toBeGreaterThan(0);
    await expect(page.locator('#ovImport')).toBeHidden();
    await expect(toast(page, 'where you left off')).toBeVisible();
  });
});

test.describe('files', () => {
  test('JSON export round-trips through import', async ({ page }) => {
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(1).click();
    await addFromTray(page, 'sofa3', 700, 420);
    await page.locator('#projName').fill('Rondje json');
    /* The shipped single-file build still has the Simple/Pro switch and keeps
       its JSON buttons on the Pro side. The v2 shell has one mode and shows
       them always — so reach for the switch only where one exists. */
    if (await page.locator('#mPro').count()) {
      await page.locator('#mPro').click();
      await page.waitForTimeout(300);
    }

    const dl = await Promise.all([page.waitForEvent('download'), page.locator('#btnExpJson').click()]).then(r => r[0]);
    expect(dl.suggestedFilename()).toBe('rondje-json.plattegrond.json');
    const file = await dl.path();
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(json.floors).toHaveLength(5);
    expect(json.source.projectId).toBe(187897594);
    const walls = json.floors.reduce((a, f) => a + f.walls.length, 0);

    // wipe, then import the file back
    await page.evaluate(() => localStorage.clear());
    await page.goto(appUrl('new'));
    await page.waitForFunction(() => window.__S && window.__S.proj);
    expect((await S(page)).floors).toHaveLength(1);
    await page.locator('#fileJson').setInputFiles(file);
    await page.waitForTimeout(600);
    const s = await S(page);
    expect(s.floors).toHaveLength(5);
    expect(s.name).toBe('Rondje json');
    expect(s.floors.reduce((a, f) => a + f.walls, 0)).toBe(walls);
  });

  test('a corrupt json file is rejected without breaking the app', async ({ page }) => {
    await starter(page);
    const bad = test.info().outputPath('bad.json');
    fs.writeFileSync(bad, '{"nope":true}');
    await page.locator('#fileJson').setInputFiles(bad);
    await expect(page.locator('.toast.err', { hasText: 'not a Plattegrond Studio project' }).first()).toBeVisible();
    expect((await S(page)).floors).toHaveLength(1);      // still usable
  });

  test('PNG export produces a real image with a title block', async ({ page }) => {
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(1).click();
    await page.waitForTimeout(300);
    const dl = await Promise.all([page.waitForEvent('download'), page.locator('#btnExpPng').click()]).then(r => r[0]);
    expect(dl.suggestedFilename()).toMatch(/\.png$/);
    const p = await dl.path();
    const buf = fs.readFileSync(p);
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));  // PNG magic
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    expect(w).toBeGreaterThan(800);
    expect(h).toBeGreaterThan(800);
    expect(buf.length).toBeGreaterThan(20_000);
    await expect(toast(page, 'PNG exported')).toBeVisible();
  });
});

test.describe('reference image', () => {
  test('toggles the listing bitmap under the vector plan', async ({ page }) => {
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(1).click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => !!window.__S.proj.floors[1].ref)).toBe(true);
    await page.locator('#tgRef').click();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__S.showRef)).toBe(true);
    await expect(page.locator('#tgRef')).toHaveClass(/on/);
    expect(await inkRatio(page)).toBeGreaterThan(0.01);
    await page.locator('#tgRef').click();
    expect(await page.evaluate(() => window.__S.showRef)).toBe(false);
  });

  test('a floor with no reference says so instead of silently doing nothing', async ({ page }) => {
    await starter(page);
    await page.locator('#tgRef').click();
    await expect(page.locator('.toast.err', { hasText: 'no reference image' }).first()).toBeVisible();
  });
});
