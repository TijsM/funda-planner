import { test, expect } from '@playwright/test';
import { fresh, starter, S } from './helpers.js';

test.beforeEach(async ({ page }) => { await fresh(page); });

/* A trackpad pinch arrives as a wheel event with ctrlKey set. If the listener is
   passive — which is how React registers its synthetic onWheel — preventDefault()
   is ignored and the browser zooms the whole page instead of the plan. */
test.describe('trackpad zoom', () => {
  test('the canvas wheel listener is non-passive, so pinch cannot page-zoom', async ({ page }) => {
    await starter(page);
    const prevented = await page.evaluate(() => {
      const cv = document.querySelector('#cv');
      const ev = new WheelEvent('wheel', {
        deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true, clientX: 400, clientY: 300,
      });
      cv.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented, 'wheel must be cancelled or the page zooms').toBe(true);
  });

  test('a pinch zooms the plan, and about the pointer', async ({ page }) => {
    await starter(page);
    const before = await S(page);

    /* clientX/Y are viewport coords; the handler converts them to canvas-local,
       so the world point must be computed the same way or it "drifts" by the
       canvas offset alone. */
    const worldAt = () => page.evaluate(() => {
      const s = window.__S;
      const r = document.querySelector('#cv').getBoundingClientRect();
      return { x: (400 - r.left - s.px) / s.zoom, y: (300 - r.top - s.py) / s.zoom };
    });
    const world = await worldAt();

    await page.evaluate(() => {
      const cv = document.querySelector('#cv');
      cv.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -240, ctrlKey: true, bubbles: true, cancelable: true, clientX: 400, clientY: 300,
      }));
    });
    await page.waitForTimeout(150);

    const after = await S(page);
    expect(after.zoom).toBeGreaterThan(before.zoom);

    // the point under the cursor must not drift
    const worldAfter = await worldAt();
    expect(Math.abs(worldAfter.x - world.x)).toBeLessThan(1);
    expect(Math.abs(worldAfter.y - world.y)).toBeLessThan(1);
  });

  test('two-finger scroll pans instead of zooming', async ({ page }) => {
    await starter(page);
    const before = await S(page);
    await page.evaluate(() => {
      const cv = document.querySelector('#cv');
      cv.dispatchEvent(new WheelEvent('wheel', {
        deltaX: 60, deltaY: 40, shiftKey: true, bubbles: true, cancelable: true, clientX: 400, clientY: 300,
      }));
    });
    await page.waitForTimeout(150);
    const after = await S(page);
    expect(after.zoom).toBeCloseTo(before.zoom, 5);
    expect(after.px).toBeLessThan(before.px);
  });
});
