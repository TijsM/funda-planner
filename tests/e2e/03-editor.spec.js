import { test, expect } from '@playwright/test';
import { fresh, S, floorOf, importMocked, starter, clickPlan, clickFrac, dragPlan, screenOf, clickObject, setToggle } from './helpers.js';

/* There is one mode now. This file used to be 03-pro.spec.js and half of it
   tested the Simple/Pro switch; what survives is everything that switch used to
   gate — the drawing tools, the numbers, the floors — proved to still be
   reachable without it. */

/* The shipped single-file build still has the Simple/Pro switch this file is
   about removing, so none of it applies there — same posture as 09/10/11. */
test.skip(process.env.E2E_TARGET !== 'next', 'v2 shell feature');

test.beforeEach(async ({ page }) => { await fresh(page); });

const dropItem = async (page, kind, fx = 0.45, fy = 0.45) => {
  await page.locator('#fAdd').click();
  await page.locator(`.tile[data-kind="${kind}"]`).click();
  await clickFrac(page, fx, fy);
  await page.waitForTimeout(150);
};

test.describe('one mode', () => {
  test('the tool rail and the selection toolbar are both simply there', async ({ page }) => {
    await starter(page);
    await expect(page.locator('.toolrail')).toBeVisible();
    await expect(page.locator('#floorbar')).toBeVisible();
    /* the two panels and the switch that revealed them are gone for good */
    await expect(page.locator('.panel')).toHaveCount(0);
    await expect(page.locator('#mPro')).toHaveCount(0);
    await expect(page.locator('#mSimple')).toHaveCount(0);
    await expect(page.locator('.statusbar')).toHaveCount(0);

    await dropItem(page, 'sofa3', 0.5, 0.4);
    await expect(page.locator('#ctx')).toBeVisible();
  });
});

test.describe('drawing tools', () => {
  test('the wall tool chains segments and finishes on Enter', async ({ page }) => {
    await starter(page);
    await page.locator('.tool[data-tool=wall]').click();
    await expect(page.locator('.tool-tip')).toContainText('wall segments');
    await clickFrac(page, 0.30, 0.30);
    await clickFrac(page, 0.30, 0.60);
    await clickFrac(page, 0.60, 0.60);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    expect((await floorOf(page)).walls).toBe(6);            // 4 starter + 2 drawn
    expect((await S(page)).sel).toHaveLength(2);
  });

  test('the room tool closes a polygon and names it from the selection toolbar', async ({ page }) => {
    await starter(page);
    await page.locator('.tool[data-tool=room]').click();
    await clickFrac(page, 0.30, 0.25);
    await clickFrac(page, 0.62, 0.25);
    await clickFrac(page, 0.62, 0.55);
    await clickFrac(page, 0.30, 0.55);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    expect((await floorOf(page)).areas).toBe(2);
    /* the name field was in the inspector; it is on the object now */
    await expect(page.locator('#ctx')).toBeVisible();
    await page.locator('#ctxName').fill('Studeerkamer');
    await page.waitForTimeout(200);
    expect((await floorOf(page)).names).toContain('Studeerkamer');
  });

  test('door and window tools attach to the nearest wall', async ({ page }) => {
    await starter(page);
    const before = await page.evaluate(() => window.__S.proj.floors[0].walls.reduce((s, w) => s + w.openings.length, 0));
    await page.locator('.tool[data-tool=door]').click();
    const w = await page.evaluate(() => window.__S.proj.floors[0].walls[1]);
    const p = await screenOf(page, (w.a.x + w.b.x) / 2, (w.a.y + w.b.y) / 2);
    await clickPlan(page, p.x, p.y);
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => window.__S.proj.floors[0].walls.reduce((s, w) => s + w.openings.length, 0));
    expect(after).toBe(before + 1);
  });

  test('the measure tool leaves a dimension line', async ({ page }) => {
    await starter(page);
    await page.locator('.tool[data-tool=measure]').click();
    await clickFrac(page, 0.25, 0.75);
    await clickFrac(page, 0.70, 0.75);
    await page.waitForTimeout(200);
    expect((await floorOf(page)).dims).toBe(1);
  });

  test('Escape abandons a half-drawn wall', async ({ page }) => {
    await starter(page);
    await page.locator('.tool[data-tool=wall]').click();
    await clickFrac(page, 0.30, 0.30);
    await clickFrac(page, 0.55, 0.30);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    expect((await floorOf(page)).walls).toBe(4);
    expect(await page.evaluate(() => window.__S.draft)).toBe(null);
  });
});

test.describe('the numbers on the selection toolbar', () => {
  test('an item is resized by typing centimetres', async ({ page }) => {
    await starter(page);
    await dropItem(page, 'sofa3');

    /* Per key, and asserting focus after each: the toolbar re-renders on every
       document change, and a field rebuilt under the caret loses it. */
    await page.locator('#ctxW').fill('');
    await page.locator('#ctxW').pressSequentially('240', { delay: 40 });
    expect(await page.evaluate(() => document.activeElement.id)).toBe('ctxW');
    await page.locator('#ctxH').fill('');
    await page.locator('#ctxH').pressSequentially('110', { delay: 40 });
    expect(await page.evaluate(() => document.activeElement.id)).toBe('ctxH');
    await page.waitForTimeout(200);

    const it = await page.evaluate(() => window.__S.proj.floors[0].items[0]);
    expect(it).toMatchObject({ w: 240, h: 110 });
  });

  test('a stray letter in a size field fires no tool shortcut', async ({ page }) => {
    await starter(page);
    await dropItem(page, 'sofa3');
    const tool = (await S(page)).tool;
    await page.locator('#ctxW').fill('');
    /* w arms the wall tool when the canvas has focus; in a field it must not */
    await page.locator('#ctxW').pressSequentially('1w80', { delay: 45 });
    await page.waitForTimeout(150);
    expect((await S(page)).tool).toBe(tool);
    expect(await page.evaluate(() => document.activeElement.id)).toBe('ctxW');
    expect((await page.evaluate(() => window.__S.proj.floors[0].items[0])).w).toBe(180);
  });

  test('the size resets to the catalogue default', async ({ page }) => {
    await starter(page);
    await dropItem(page, 'sofa3');
    await page.locator('#ctxW').fill('300');
    await page.waitForTimeout(150);
    await page.locator('#ctxSizeReset').click();
    await page.waitForTimeout(150);
    const it = await page.evaluate(() => window.__S.proj.floors[0].items[0]);
    expect(it).toMatchObject({ w: 225, h: 95 });
  });

  test('a wall carries its thickness', async ({ page }) => {
    await starter(page);
    const w0 = await page.evaluate(() => window.__S.proj.floors[0].walls[2]);
    await clickObject(page, (w0.a.x + w0.b.x) / 2, (w0.a.y + w0.b.y) / 2);
    await expect(page.locator('#ctxWallT')).toBeVisible();
    await page.locator('#ctxWallT').fill('30');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__S.proj.floors[0].walls[2].t)).toBe(30);
  });
});

test.describe('selection', () => {
  test('marquee selects several objects and rotates them together', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await page.locator('.tile[data-kind="chair"]').click();
    for (const [fx, fy] of [[0.40, 0.35], [0.50, 0.35], [0.60, 0.35]])
      await clickFrac(page, fx, fy, { modifiers: ['Shift'] });
    await page.keyboard.press('Escape');

    const end = await page.evaluate(() => {
      const its = window.__S.proj.floors[0].items, S = window.__S;
      const x = Math.max(...its.map(i => i.x + i.w)), y = Math.max(...its.map(i => i.y + i.h));
      return { x: x * S.zoom + S.px + 40, y: y * S.zoom + S.py + 40 };
    });
    await dragPlan(page, 6, 6, end.x, end.y);
    const sel = (await S(page)).sel;
    expect(sel.filter(s => s.t === 'item').length).toBe(3);
    await expect(page.locator('#ctx')).toContainText('3 selected');

    const before = await page.evaluate(() => window.__S.proj.floors[0].items.map(i => i.rot));
    await page.locator('#ctxRot').click();
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => window.__S.proj.floors[0].items.map(i => i.rot));
    expect(after).toEqual(before.map(r => (r + 90) % 360));
  });

  test('cmd+A selects everything, Escape clears it', async ({ page }) => {
    await importMocked(page);
    await page.keyboard.press('ControlOrMeta+a');
    await page.waitForTimeout(150);
    expect((await S(page)).sel.length).toBeGreaterThan(50);
    await page.keyboard.press('Escape');
    expect((await S(page)).sel).toHaveLength(0);
  });
});

test.describe('view controls', () => {
  test('zoom buttons, fit and the layer toggles', async ({ page }) => {
    await importMocked(page);
    const z0 = (await S(page)).zoom;
    await page.locator('#zIn').click();
    expect((await S(page)).zoom).toBeGreaterThan(z0);
    await page.locator('#zOut').click();
    await page.locator('#zOut').click();
    expect((await S(page)).zoom).toBeLessThan(z0);
    await page.locator('#zFit').click();
    await page.waitForTimeout(200);
    await expect(page.locator('#zoomVal')).toContainText('%');

    /* the layer switches moved out of the deleted view panel into a popover */
    await page.locator('#tgLayers').click();
    await expect(page.locator('#layerMenu')).toBeVisible();
    for (const id of ['#vRooms', '#vFurn', '#vDims', '#vNotes']) await setToggle(page, id, false);
    expect(await page.evaluate(() => window.__S.view)).toMatchObject({ rooms: 0, furn: 0, dims: 0, notes: 0 });
    /* and it closes when you look away from it */
    await clickPlan(page, 400, 300);
    await expect(page.locator('#layerMenu')).toHaveCount(0);
  });

  test('adding and removing floors from the floor bar', async ({ page }) => {
    await starter(page);
    await page.locator('#fAddFloor').click();
    await page.waitForTimeout(200);
    expect((await S(page)).floors).toHaveLength(2);
    await expect(page.locator('#fchips .fchip')).toHaveCount(2);

    page.once('dialog', d => d.accept());
    await page.locator('#fDelFloor').click();
    await page.waitForTimeout(250);
    expect((await S(page)).floors).toHaveLength(1);
  });

  test('the last floor cannot be deleted', async ({ page }) => {
    await starter(page);
    await page.locator('#fDelFloor').click();
    await page.waitForTimeout(200);
    expect((await S(page)).floors).toHaveLength(1);
  });
});
