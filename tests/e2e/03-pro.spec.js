import { test, expect } from '@playwright/test';
import { fresh, S, floorOf, importMocked, starter, clickPlan, clickFrac, fracPoint, dragPlan, screenOf, clickObject, setToggle, APP } from './helpers.js';

test.beforeEach(async ({ page }) => { await fresh(page); });

const toPro = async page => { await page.locator('#mPro').click(); await page.waitForTimeout(400); };

test.describe('mode switching', () => {
  test('Pro reveals the full editor and Simple hides it again', async ({ page }) => {
    await starter(page);
    await toPro(page);
    await expect(page.locator('.toolrail')).toBeVisible();
    await expect(page.locator('.panel.left')).toBeVisible();
    await expect(page.locator('.panel.right')).toBeVisible();
    await expect(page.locator('.statusbar')).toBeVisible();
    await expect(page.locator('#floorbar')).toBeHidden();

    await page.locator('#mSimple').click();
    await page.waitForTimeout(300);
    await expect(page.locator('.toolrail')).toBeHidden();
    await expect(page.locator('#floorbar')).toBeVisible();
  });

  test('the choice survives a reload', async ({ page }) => {
    await starter(page);
    await toPro(page);
    expect(await page.evaluate(() => localStorage.getItem('pgs.mode.v1'))).toBe('pro');
    await page.reload();
    await page.waitForTimeout(600);
    await expect(page.locator('.toolrail')).toBeVisible();
    expect((await S(page)).simple).toBe(false);
  });

  test('the on-object toolbar belongs to Simple mode only', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await page.locator('.tile[data-kind="sofa3"]').click();
    await clickPlan(page, 650, 400);
    await expect(page.locator('#ctx')).toBeVisible();
    await toPro(page);
    await expect(page.locator('#ctx')).toBeHidden();
    await expect(page.locator('#inspector')).toContainText('Rotation');
  });
});

test.describe('drawing tools', () => {
  test('the wall tool chains segments and finishes on Enter', async ({ page }) => {
    await starter(page);
    await toPro(page);
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

  test('the room tool closes a polygon and reports its area', async ({ page }) => {
    await starter(page);
    await toPro(page);
    await page.locator('.tool[data-tool=room]').click();
    await clickFrac(page, 0.30, 0.25);
    await clickFrac(page, 0.62, 0.25);
    await clickFrac(page, 0.62, 0.55);
    await clickFrac(page, 0.30, 0.55);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    expect((await floorOf(page)).areas).toBe(2);
    await expect(page.locator('#inspector')).toContainText('m²');
    await page.locator('#inAreaName').fill('Studeerkamer');
    await page.waitForTimeout(200);
    expect((await floorOf(page)).names).toContain('Studeerkamer');
  });

  test('door and window tools attach to the nearest wall', async ({ page }) => {
    await starter(page);
    await toPro(page);
    const before = await page.evaluate(() => window.__S.proj.floors[0].walls.reduce((s, w) => s + w.openings.length, 0));
    await page.locator('.tool[data-tool=door]').click();
    const w = await page.evaluate(() => window.__S.proj.floors[0].walls[1]);
    const p = await screenOf(page, (w.a.x + w.b.x) / 2, (w.a.y + w.b.y) / 2);
    await clickPlan(page, p.x, p.y);
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => window.__S.proj.floors[0].walls.reduce((s, w) => s + w.openings.length, 0));
    expect(after).toBe(before + 1);
    await expect(page.locator('#inspector')).toContainText('Offset');
  });

  test('the measure tool leaves a dimension line', async ({ page }) => {
    await starter(page);
    await toPro(page);
    await page.locator('.tool[data-tool=measure]').click();
    await clickFrac(page, 0.25, 0.75);
    await clickFrac(page, 0.70, 0.75);
    await page.waitForTimeout(200);
    expect((await floorOf(page)).dims).toBe(1);
  });

  test('Escape abandons a half-drawn wall', async ({ page }) => {
    await starter(page);
    await toPro(page);
    await page.locator('.tool[data-tool=wall]').click();
    await clickFrac(page, 0.30, 0.30);
    await clickFrac(page, 0.55, 0.30);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    expect((await floorOf(page)).walls).toBe(4);
    expect(await page.evaluate(() => window.__S.draft)).toBe(null);
  });
});

test.describe('the inspector', () => {
  test('edits an item numerically', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await page.locator('.tile[data-kind="sofa3"]').click();
    await clickFrac(page, 0.45, 0.45);
    await toPro(page);

    await page.locator('#inX').fill('500');
    await page.locator('#inY').fill('600');
    await page.locator('#inW').fill('240');
    await page.locator('#inR').fill('45');
    await page.locator('#inLabel').fill('Bank van oma');
    await page.waitForTimeout(250);
    const it = await page.evaluate(() => window.__S.proj.floors[0].items[0]);
    expect(it).toMatchObject({ x: 500, y: 600, w: 240, rot: 45, label: 'Bank van oma' });
  });

  test('edits a wall by length, angle and thickness, and can split it', async ({ page }) => {
    await starter(page);
    await toPro(page);
    const w0 = await page.evaluate(() => window.__S.proj.floors[0].walls[2]);   // bottom wall
    await clickObject(page, (w0.a.x + w0.b.x) / 2, (w0.a.y + w0.b.y) / 2);
    await expect(page.locator('#inWL')).toBeVisible();

    await page.locator('#inWL').fill('640');
    await page.locator('#inWT').fill('30');
    await page.waitForTimeout(250);
    let w = await page.evaluate(() => window.__S.proj.floors[0].walls[2]);
    expect(Math.round(Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y))).toBe(640);
    expect(w.t).toBe(30);

    await page.locator('#wSplit').click();
    await page.waitForTimeout(200);
    expect((await floorOf(page)).walls).toBe(5);
  });

  test('shows floor properties and totals when nothing is selected', async ({ page }) => {
    await importMocked(page);
    await toPro(page);
    await expect(page.locator('#inspector')).toContainText('Nothing selected');
    await expect(page.locator('#inspector')).toContainText('Reference image');
    await expect(page.locator('#totals')).toContainText('m²');
    await page.locator('#inFlName').fill('Parterre');
    await page.waitForTimeout(200);
    expect((await floorOf(page)).name).toBe('Parterre');
    await expect(page.locator('#floorList .floor.on')).toContainText('Parterre');
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
    await toPro(page);

    // The view refits on mode change, so derive the rectangle from the real
    // positions — and start it in the canvas corner, which is bare paper: a
    // drag beginning inside a room would move that room instead of marqueeing.
    const end = await page.evaluate(() => {
      const its = window.__S.proj.floors[0].items, S = window.__S;
      const x = Math.max(...its.map(i => i.x + i.w)), y = Math.max(...its.map(i => i.y + i.h));
      return { x: x * S.zoom + S.px + 40, y: y * S.zoom + S.py + 40 };
    });
    await dragPlan(page, 6, 6, end.x, end.y);
    const sel = (await S(page)).sel;
    expect(sel.filter(s => s.t === 'item').length).toBe(3);
    await expect(page.locator('#inspector')).toContainText('3 objects');

    const before = await page.evaluate(() => window.__S.proj.floors[0].items.map(i => i.rot));
    await page.locator('#mRot').click();
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => window.__S.proj.floors[0].items.map(i => i.rot));
    expect(after).toEqual(before.map(r => (r + 90) % 360));
  });

  test('cmd+A selects everything, Escape clears it', async ({ page }) => {
    await importMocked(page);
    await toPro(page);
    await page.keyboard.press('ControlOrMeta+a');
    await page.waitForTimeout(150);
    const s = await S(page);
    expect(s.sel.length).toBeGreaterThan(50);
    await page.keyboard.press('Escape');
    expect((await S(page)).sel).toHaveLength(0);
  });
});

test.describe('view controls', () => {
  test('zoom buttons, fit and the layer toggles', async ({ page }) => {
    await importMocked(page);
    await toPro(page);
    const z0 = (await S(page)).zoom;
    await page.locator('#zIn').click();
    expect((await S(page)).zoom).toBeGreaterThan(z0);
    await page.locator('#zOut').click();
    await page.locator('#zOut').click();
    expect((await S(page)).zoom).toBeLessThan(z0);
    await page.locator('#zFit').click();
    await page.waitForTimeout(200);
    await expect(page.locator('#zoomVal')).toContainText('%');

    for (const id of ['#vRooms', '#vFurn', '#vDims', '#vNotes']) await setToggle(page, id, false);
    expect(await page.evaluate(() => window.__S.view)).toMatchObject({ rooms: 0, furn: 0, dims: 0, notes: 0 });
  });

  test('adding and removing floors', async ({ page }) => {
    await starter(page);
    await toPro(page);
    await page.locator('#btnAddFloor').click();
    await page.waitForTimeout(200);
    expect((await S(page)).floors).toHaveLength(2);
    await expect(page.locator('#floorList .floor')).toHaveCount(2);

    page.once('dialog', d => d.accept());
    await page.locator('#floorList .floor').nth(1).hover();
    await page.locator('#floorList .floor').nth(1).locator('[data-del]').click();
    await page.waitForTimeout(250);
    expect((await S(page)).floors).toHaveLength(1);
  });
});
