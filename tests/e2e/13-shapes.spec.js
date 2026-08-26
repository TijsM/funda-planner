import { test, expect } from '@playwright/test';
import { fresh, starter, clickFrac } from './helpers.js';

/* Drawing your own object.
 *
 *  The catalogue is 125 entries and a Dutch listing will always put something on
 *  a plan that is not one of them — a kliko, a meter cupboard, a piano stool. The
 *  tray's empty state is where that is discovered, so it is where the way out
 *  belongs: search, find nothing, draw it, place it.
 *
 *  Driven through the pointer rather than the store on purpose. The drawing
 *  surface is the only part of this app where a person authors geometry by
 *  clicking, and a unit test on `normalisePoly` cannot tell whether the clicks
 *  reach it. */

test.skip(process.env.E2E_TARGET !== 'next', 'v2 shell feature');

test.beforeEach(async ({ page }) => { await fresh(page); });

const openTray = async (page, q) => {
  await page.locator('#fAdd').click();
  await expect(page.locator('#tray')).toHaveClass(/open/);
  await page.locator('#traySearch').fill(q);
  await page.waitForTimeout(200);
};

/** Clicks the corners of an outline, in unit coordinates of the FOOTPRINT.
 *
 *  Against `.shape-field` rather than the whole surface: the surface is deliberately
 *  bigger than the footprint so there is room to work, and clicking at a fraction
 *  of the surface would land somewhere else in unit space — which is exactly the
 *  bug that made the corner handles unreachable. */
async function drawCorners(page, corners) {
  const box = await page.locator('#shapeField').boundingBox();
  for (const [ux, uy] of corners) {
    await page.mouse.click(box.x + ux * box.width, box.y + uy * box.height);
    await page.waitForTimeout(60);
  }
}

const shapes = page => page.evaluate(() => window.__S.proj.shapes ?? []);
const items = page => page.evaluate(() => window.__S.proj.floors[window.__S.fi].items);

test.describe('drawing an object the catalogue does not have', () => {
  test('the empty search is a door, not a dead end', async ({ page }) => {
    await starter(page);
    await openTray(page, 'kliko');

    /* Named back at them: someone who typed the word has already said what they
       are drawing, and the button that says so is the one they will press. */
    await expect(page.locator('#trayMake')).toContainText('kliko');
    await page.locator('#trayMake').click();
    await expect(page.locator('#ovShape')).toHaveClass(/open/);
    await expect(page.locator('#shapeName')).toHaveValue('kliko');
  });

  test('clicks become corners, and a corner can be dragged afterwards', async ({ page }) => {
    await starter(page);
    await openTray(page, 'kliko');
    await page.locator('#trayMake').click();

    /* The surface opens empty — a prefilled box is the answer to "resize this",
       and this modal is reached by someone whose object is not in the catalogue
       at all. So Create is unreachable until there is a shape. */
    await expect(page.locator('#shapeCreate')).toBeDisabled();
    await drawCorners(page, [[0.1, 0.05], [0.9, 0.05], [0.95, 0.6], [0.5, 0.95], [0.05, 0.6]]);
    await expect(page.locator('#shapeCreate')).toBeEnabled();

    /* Drag the third corner in. Nothing observable changes in the DOM, so this
       asserts on the shape that comes out the other end. */
    const box = await page.locator('#shapeField').boundingBox();
    await page.mouse.move(box.x + 0.95 * box.width, box.y + 0.6 * box.height);
    await page.mouse.down();
    await page.mouse.move(box.x + 0.7 * box.width, box.y + 0.35 * box.height, { steps: 6 });
    await page.mouse.up();

    await page.locator('#shapeW').fill('60');
    await page.locator('#shapeH').fill('80');
    await page.locator('#shapeZ').fill('110');
    await page.locator('#shapeCreate').click();
    await page.waitForTimeout(200);

    const [s] = await shapes(page);
    expect(s.name).toBe('kliko');
    expect([s.w, s.h, s.z]).toEqual([60, 80, 110]);
    expect(s.poly).toHaveLength(5);
    /* unused canvas is cropped: the unit square is the drawing, not the viewBox */
    const xs = s.poly.map(p => p.x), ys = s.poly.map(p => p.y);
    expect(Math.min(...xs)).toBeCloseTo(0, 1);
    expect(Math.max(...xs)).toBeCloseTo(1, 1);
    expect(Math.min(...ys)).toBeCloseTo(0, 1);
    expect(Math.max(...ys)).toBeCloseTo(1, 1);
    /* the third corner was dragged up from 0.6 — after the crop it is still
       the one that sits in the upper half, not on the bottom edge */
    expect(s.poly[2].y).toBeLessThan(0.5);
    for (const p of s.poly) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
    }
  });

  test('creating arms it, so the next click on the plan places it', async ({ page }) => {
    await starter(page);
    await openTray(page, 'kliko');
    await page.locator('#trayMake').click();
    await page.locator('[data-preset="rect"]').click();
    await page.locator('#shapeCreate').click();
    await page.waitForTimeout(200);

    /* Drawing one and then having to find it in the tray would be a step nobody
       wants: the reason to draw it was to put it somewhere. */
    const id = (await shapes(page))[0].id;
    expect(await page.evaluate(() => window.__S.place)).toBe(id);

    await clickFrac(page, 0.45, 0.45);
    await page.waitForTimeout(250);
    const placed = (await items(page)).filter(i => i.kind === id);
    expect(placed).toHaveLength(1);
    /* the drawing rides along on the object, which is what makes a plan
       self-contained — see Item.shape */
    expect(placed[0].shape.name).toBe('kliko');
    expect(placed[0].label).toBe('kliko');
  });

  test('it joins the tray under Yours, and answers to its own name', async ({ page }) => {
    await starter(page);
    await openTray(page, 'meterkast');
    await page.locator('#trayMake').click();
    await page.locator('[data-preset="rect"]').click();
    await page.locator('#shapeCreate').click();
    await page.waitForTimeout(200);

    await openTray(page, 'meterkast');
    await expect(page.locator('.tile[data-kind^="x:"]')).toHaveCount(1);
    await expect(page.locator('.tgroup', { hasText: 'Yours' })).toBeVisible();
    /* and it is a search result like any other, not a permanent fixture */
    await page.locator('#traySearch').fill('sofa');
    await page.waitForTimeout(200);
    await expect(page.locator('.tile[data-kind^="x:"]')).toHaveCount(0);
  });

  /* The whole reason the drawing is copied onto the item rather than looked up:
     tidying the tray must not blank an object that is already on a floor. */
  test('removing it from the tray leaves what is already placed alone', async ({ page }) => {
    await starter(page);
    await openTray(page, 'kliko');
    await page.locator('#trayMake').click();
    await page.locator('[data-preset="round"]').click();
    await page.locator('#shapeCreate').click();
    await page.waitForTimeout(150);
    await clickFrac(page, 0.45, 0.45);
    await page.waitForTimeout(250);

    await openTray(page, 'kliko');
    await page.locator('.tile[data-kind^="x:"] .tile-x').click();
    await page.waitForTimeout(250);

    expect(await shapes(page)).toHaveLength(0);
    const still = (await items(page)).filter(i => i.kind.startsWith('x:'));
    expect(still).toHaveLength(1);
    expect(still[0].shape.name).toBe('kliko');
  });

  test('a drawing without a name cannot be created', async ({ page }) => {
    await starter(page);
    await openTray(page, '');
    await page.locator('#trayMakeAlso').click();
    await expect(page.locator('#ovShape')).toHaveClass(/open/);
    /* nothing typed, so nothing to call it — and an unnamed object is one the
       render brief cannot mention at all */
    await page.locator('[data-preset="rect"]').click();
    await expect(page.locator('#shapeCreate')).toBeDisabled();
    await page.locator('#shapeName').fill('piano stool');
    await expect(page.locator('#shapeCreate')).toBeEnabled();
  });
});
