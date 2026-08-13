import { test, expect } from '@playwright/test';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { fresh, S, waitFloors, FUNDA_URL, inkRatio, addFromTray, toast } from './helpers.js';

/* The app is meant to be double-clicked. That makes the page origin `null`,
   which is the strictest CORS case there is — so it gets its own suite. */
const here = path.dirname(fileURLToPath(import.meta.url));
const FILE_URL = pathToFileURL(path.join(here, '..', '..', 'index.html')).href;

test.describe('opened straight from disk (file://)', () => {
  test('imports, edits and saves with no server involved', async ({ page }) => {
    const errors = await fresh(page);
    await page.goto(FILE_URL + '?n=1#import=' + FUNDA_URL);
    await waitFloors(page, 5);
    await page.waitForTimeout(400);

    const s = await S(page);
    expect(s.floors).toHaveLength(5);
    expect(s.source.projectId).toBe(187897594);
    expect(await inkRatio(page)).toBeGreaterThan(0.01);

    await addFromTray(page, 'sofa3', 700, 420);
    expect((await S(page)).floors[0].items).toBeGreaterThan(0);

    await page.locator('#projName').fill('Vanaf schijf');
    await page.locator('#btnSave').click();
    await expect(toast(page, 'Vanaf schijf')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('localStorage persists across a file:// reload', async ({ page }) => {
    await fresh(page);
    await page.goto(FILE_URL + '?n=2#garden');
    await page.waitForFunction(() => window.__S && window.__S.proj);
    await page.evaluate(() => { document.querySelector('#projName').value = 'Tuin v1'; window.__S.proj.name = 'Tuin v1'; });
    await page.locator('#btnSave').click();
    await page.waitForTimeout(300);

    await page.goto(FILE_URL + '?n=3');
    await page.waitForFunction(() => window.__S && window.__S.proj);
    await page.waitForTimeout(300);
    await page.locator('#btnLib').click();
    await expect(page.locator('#libList .lib-i')).toContainText('Tuin v1');
  });
});
