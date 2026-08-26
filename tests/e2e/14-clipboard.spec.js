import { test, expect } from '@playwright/test';
import { fresh, S, floorOf, starter, addFromTray, clickObject, toast } from './helpers.js';

/* Copy, duplicate, paste — for everything on the plan, not only for furniture.
 *
 *  A wall is no less copyable than a sofa, and the one object with no position
 *  of its own — a door, which is a hole in a wall — has to be copyable too. The
 *  clipboard is the system one, so a copy crosses tabs and plans; ⌘C/⌘V ride the
 *  browser's own copy and paste events, which is what this spec drives. */

test.skip(process.env.E2E_TARGET !== 'next', 'v2 shell feature');

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await fresh(page);
});

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('duplicating from the object toolbar', () => {
  test('every object carries the same three buttons', async ({ page }) => {
    await starter(page);
    const ctx = page.locator('#ctx');

    await addFromTray(page, 'sofa3', 700, 400);
    for (const id of ['#ctxCopy', '#ctxDup', '#ctxDel']) await expect(ctx.locator(id)).toBeVisible();

    await addFromTray(page, 'draw:wall', 700, 520);
    for (const id of ['#ctxCopy', '#ctxDup', '#ctxDel']) await expect(ctx.locator(id)).toBeVisible();

    await addFromTray(page, 'draw:note', 760, 300);
    for (const id of ['#ctxCopy', '#ctxDup', '#ctxDel']) await expect(ctx.locator(id)).toBeVisible();

    await addFromTray(page, 'draw:measure', 620, 600);
    for (const id of ['#ctxCopy', '#ctxDup', '#ctxDel']) await expect(ctx.locator(id)).toBeVisible();
  });

  test('a wall duplicates, openings and all', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:wall', 700, 500);
    await page.locator('#ctxDoor').click();
    await page.waitForTimeout(150);

    /* Select the wall again — the door took the selection. Aimed at the far end:
       a new opening lands a tenth of the way along, and a click there picks the
       door back up rather than the wall under it. */
    const w = await page.evaluate(() => window.__S.proj.floors[0].walls.at(-1));
    await clickObject(page, w.a.x + (w.b.x - w.a.x) * 0.8, w.a.y + (w.b.y - w.a.y) * 0.8);
    await expect(page.locator('#ctxDoor')).toBeVisible();            // the wall, not its door

    const before = await floorOf(page);
    await page.locator('#ctxDup').click();
    await page.waitForTimeout(200);
    const after = await floorOf(page);
    expect(after.walls).toBe(before.walls + 1);
    expect(after.openings).toBe(before.openings + 1);

    /* two walls, two doors, and no shared ids between them */
    const ids = await page.evaluate(() => {
      const ws = window.__S.proj.floors[0].walls.slice(-2);
      return [ws[0].id, ws[1].id, ws[0].openings[0].id, ws[1].openings[0].id];
    });
    expect(new Set(ids).size).toBe(4);
  });

  test('a door duplicates into the wall it is already in', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:wall', 700, 500);
    await page.locator('#ctxDoor').click();
    await page.waitForTimeout(150);
    await expect(page.locator('#ctxHinge')).toBeVisible();          // the opening is selected

    await page.locator('#ctxDup').click();
    await page.waitForTimeout(200);

    const ops = await page.evaluate(() => window.__S.proj.floors[0].walls.at(-1).openings);
    expect(ops).toHaveLength(2);
    expect(ops[0].id).not.toBe(ops[1].id);
    expect(Math.abs(ops[0].at - ops[1].at)).toBeGreaterThan(0.05);
    expect(ops[1].at).toBeGreaterThan(0);
    expect(ops[1].at).toBeLessThan(1);
  });

  test('a room duplicates with its name and colour', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:room', 800, 420);
    await page.locator('#ctxName').fill('Werkkamer');
    await page.waitForTimeout(200);
    await page.locator('#ctxDup').click();
    await page.waitForTimeout(200);

    const f = await floorOf(page);
    expect(f.areas).toBe(3);                                        // starter + drawn + copy
    expect(f.names.filter(n => n === 'Werkkamer')).toHaveLength(2);
  });
});

test.describe('the system clipboard', () => {
  test('copies a selection and pastes it back', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 700, 400);
    expect((await floorOf(page)).items).toBe(1);

    await page.locator('#ctxCopy').click();
    await expect(toast(page, 'Copied')).toBeVisible();

    /* it really went to the system clipboard, not to a variable of ours */
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('plattegrond-studio/clip@1');

    await page.keyboard.press(`${MOD}+v`);
    await page.waitForTimeout(300);
    expect((await floorOf(page)).items).toBe(2);
  });

  test('pastes from the rail too, for anyone not reaching for ⌘V', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 700, 400);
    await page.locator('#ctxCopy').click();
    await expect(toast(page, 'Copied')).toBeVisible();

    await page.locator('#btnPaste').click();
    await page.waitForTimeout(300);
    expect((await floorOf(page)).items).toBe(2);
  });

  test('⌘C and ⌘V move an object between floors', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 700, 400);
    await page.keyboard.press(`${MOD}+c`);
    await page.waitForTimeout(200);

    await page.locator('#fAddFloor').click();
    await page.waitForTimeout(200);
    expect((await floorOf(page)).items).toBe(0);

    await page.keyboard.press(`${MOD}+v`);
    await page.waitForTimeout(300);
    expect((await floorOf(page)).items).toBe(1);
    /* the original stayed where it was */
    const s = await S(page);
    expect(s.floors[0].items).toBe(1);
  });

  test('leaves a paste of somebody else’s text alone', async ({ page }) => {
    await starter(page);
    const before = await floorOf(page);
    await page.evaluate(() => navigator.clipboard.writeText('een stukje tekst'));
    await page.keyboard.press(`${MOD}+v`);
    await page.waitForTimeout(300);
    expect(await floorOf(page)).toEqual(before);
  });
});

test.describe('duplicating a floor', () => {
  test('copies the tab and everything on it, directly above the original', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 700, 400);
    const before = await S(page);

    await page.locator('#fDupFloor').click();
    await page.waitForTimeout(300);

    const after = await S(page);
    expect(after.floors).toHaveLength(2);
    expect(after.fi).toBe(1);                                        // standing on the copy
    expect(after.floors[1].name).toBe(`${before.floors[0].name} copy`);
    expect(after.floors[1].items).toBe(before.floors[0].items);
    expect(after.floors[1].walls).toBe(before.floors[0].walls);
    expect(after.floors[1].areas).toBe(before.floors[0].areas);
    expect(after.floors.map(f => f.level)).toEqual([0, 1]);
    await expect(page.locator('#fchips .fchip')).toHaveCount(2);

    /* a copy, not the same floor listed twice — nothing is shared, not even ids */
    const ids = await page.evaluate(() => {
      const [a, b] = window.__S.proj.floors;
      return [a.id, b.id, a.items[0].id, b.items[0].id];
    });
    expect(new Set(ids).size).toBe(4);
  });

  test('a second duplicate is numbered, never “copy copy”', async ({ page }) => {
    await starter(page);
    const base = (await S(page)).floors[0].name;

    await page.locator('#fDupFloor').click();
    await page.waitForTimeout(250);
    /* the second one duplicates the copy, which is where “copy copy” would come
       from — it is a copy of the same floor, so it is numbered instead */
    await page.locator('#fDupFloor').click();
    await page.waitForTimeout(250);

    const s = await S(page);
    expect(s.floors.map(f => f.name)).toEqual([base, `${base} copy`, `${base} copy 2`]);
    expect(s.floors.map(f => f.level)).toEqual([0, 1, 2]);
  });

  test('⌘C on an empty selection copies the floor itself', async ({ page }) => {
    await starter(page);
    await page.keyboard.press('Escape');                             // nothing selected
    await page.keyboard.press(`${MOD}+c`);
    await expect(toast(page, 'Copied floor')).toBeVisible();

    await page.keyboard.press(`${MOD}+v`);
    await page.waitForTimeout(300);
    const s = await S(page);
    expect(s.floors).toHaveLength(2);
    expect(s.floors[1].walls).toBe(s.floors[0].walls);
  });
});
