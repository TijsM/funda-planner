import { test, expect } from '@playwright/test';
import { fresh, starter, addFromTray } from './helpers.js';

/* These type character by character on purpose. fill() sets the value in one
   shot, so it cannot see a field that is destroyed and rebuilt between
   keystrokes — which is exactly the bug this file exists for. */

test.skip(process.env.E2E_TARGET !== 'next', 'v2 shell feature');

test.beforeEach(async ({ page }) => { await fresh(page); });

const active = page => page.evaluate(() => document.activeElement?.id ?? '');

/** type into a field the slow way, then report what survived */
async function typeInto(page, id, text) {
  const el = page.locator(id);
  await el.click();
  await el.pressSequentially(text, { delay: 25 });
  await page.waitForTimeout(120);
  return { value: await el.inputValue(), focus: await active(page) };
}

test.describe('the caret stays where you put it', () => {
  test('an item name takes every letter without losing focus', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 380, 300);

    const el = page.locator('#ctxLabel');
    await el.click();
    await el.fill('');
    const r = await typeInto(page, '#ctxLabel', 'Grote hoekbank');

    expect(r.value).toBe('Grote hoekbank');
    expect(r.focus).toBe('ctxLabel');
    /* and it really reached the document, not just the input */
    expect(await page.evaluate(() => window.__S.proj.floors[0].items[0].label))
      .toBe('Grote hoekbank');
  });

  test('a description takes every letter without losing focus', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 380, 300);
    const r = await typeInto(page, '#ctxDesc', 'donkergroen velours');

    expect(r.value).toBe('donkergroen velours');
    expect(r.focus).toBe('ctxDesc');
    expect(await page.evaluate(() => window.__S.proj.floors[0].items[0].desc))
      .toBe('donkergroen velours');
  });

  test('a room name takes every letter without losing focus', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:room', 300, 260);
    const r = await typeInto(page, '#ctxName', 'Woonkamer');

    expect(r.value).toBe('Woonkamer');
    expect(r.focus).toBe('ctxName');
  });

  test('a note takes every letter without losing focus', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:note', 300, 260);
    const el = page.locator('#ctxNote');
    await el.click();
    await el.fill('');
    const r = await typeInto(page, '#ctxNote', 'muur eruit');

    expect(r.value).toBe('muur eruit');
    expect(r.focus).toBe('ctxNote');
  });

  test('the size fields hold focus too', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 380, 300);

    /* These arrived when the Pro inspector left, and they re-render on every
       keystroke like everything else on this bar — so they get the same proof. */
    await page.locator('#ctxW').fill('');
    const w = await typeInto(page, '#ctxW', '240');
    expect(w).toMatchObject({ value: '240', focus: 'ctxW' });

    await page.locator('#ctxH').fill('');
    const h = await typeInto(page, '#ctxH', '110');
    expect(h).toMatchObject({ value: '110', focus: 'ctxH' });
  });
});

test.describe('opening the Add tray', () => {
  test('puts the caret straight in the search box', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await expect(page.locator('#tray')).toHaveClass(/open/);
    await expect.poll(() => active(page)).toBe('traySearch');

    /* so you can just start typing */
    await page.keyboard.type('hoekbank', { delay: 20 });
    await page.waitForTimeout(200);
    expect(await page.locator('#traySearch').inputValue()).toBe('hoekbank');
    await expect(page.locator('.tile[data-kind="sofaL"]')).toHaveCount(1);
  });

  test('escape clears the query, then closes the tray', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await expect.poll(() => active(page)).toBe('traySearch');
    await page.keyboard.type('bed', { delay: 20 });
    await page.waitForTimeout(150);

    await page.keyboard.press('Escape');            // stage one: clear
    await page.waitForTimeout(150);
    expect(await page.locator('#traySearch').inputValue()).toBe('');
    await expect(page.locator('#tray')).toHaveClass(/open/);

    await page.keyboard.press('Escape');            // stage two: close
    await page.waitForTimeout(200);
    await expect(page.locator('#tray')).not.toHaveClass(/open/);
  });

  test('a second opening selects the old query, so typing replaces it', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await expect.poll(() => active(page)).toBe('traySearch');
    await page.keyboard.type('bed', { delay: 20 });
    await page.locator('#trayClose').click();       // close without clearing
    await page.waitForTimeout(200);

    await page.locator('#fAdd').click();
    await expect.poll(() => active(page)).toBe('traySearch');
    await page.keyboard.type('sofa', { delay: 20 });
    await page.waitForTimeout(200);
    expect(await page.locator('#traySearch').inputValue()).toBe('sofa');
  });

  test('escape cancels an armed item before it closes the tray', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await expect.poll(() => active(page)).toBe('traySearch');
    await page.locator('.tile[data-kind="sofa3"]').click();
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__S.place)).toBe('sofa3');

    /* the caret is still in the search box — escape must reach the app anyway */
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__S.place)).toBe(null);
  });

  test('the tray hands focus back, so shortcuts keep working', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await expect.poll(() => active(page)).toBe('traySearch');
    await page.keyboard.press('Escape');            // closes it, nothing armed
    await expect(page.locator('#tray')).not.toHaveClass(/open/);
    await page.waitForTimeout(150);
    expect(await active(page)).not.toBe('traySearch');

    /* G toggles the grid instead of typing a 'g' into a hidden field */
    const before = await page.evaluate(() => window.__S.grid);
    await page.keyboard.press('g');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__S.grid)).toBe(!before);
    expect(await page.locator('#traySearch').inputValue()).toBe('');
  });

  test('typing in the search box does not fire tool shortcuts', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await expect.poll(() => active(page)).toBe('traySearch');
    const grid = await page.evaluate(() => window.__S.grid);

    /* 'g' is the grid shortcut and 'w' the wall tool — neither may fire here */
    await page.keyboard.type('growth', { delay: 20 });
    await page.waitForTimeout(200);
    expect(await page.locator('#traySearch').inputValue()).toBe('growth');
    expect(await page.evaluate(() => window.__S.grid)).toBe(grid);
    expect(await page.evaluate(() => window.__S.tool)).toBe('select');
  });
});
