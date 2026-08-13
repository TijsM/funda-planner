import { test, expect } from '@playwright/test';
import { fresh, S, importMocked, starter, addFromTray } from './helpers.js';

test.beforeEach(async ({ page }) => { await fresh(page); });

const openAI = async page => {
  await page.locator('#btnAI').click();
  await expect(page.locator('#ovAI')).toHaveClass(/open/);
  await expect(page.locator('#aiPrompt')).not.toBeEmpty();
};

test.describe('export for an image generator', () => {
  test('writes a prompt from the real geometry', async ({ page }) => {
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(1).click();   // Begane Grond
    await page.waitForTimeout(250);
    await openAI(page);

    const p = await page.locator('#aiPrompt').inputValue();
    console.log('\n──────── generated prompt ────────\n' + p + '\n──────────────────────────────────\n');

    // the address and floor it actually came from
    expect(p).toContain('Pieter Kleijnstraat 19');
    expect(p).toContain('Begane Grond');
    // real rooms, with their real areas
    expect(p).toContain('Woonkamer');
    expect(p).toContain('Keuken');
    expect(p).toMatch(/26\.\d m²/);
    // orientation and openings derived from the plan
    expect(p).toMatch(/North is at the top/);
    expect(p).toMatch(/Windows on the .*(north|south|east|west)/);
    expect(p).toMatch(/\d+ doorways? connect the rooms/);
    // guardrails against the model inventing architecture
    expect(p).toMatch(/reproduce exactly|do not invent/i);
    expect(p).toMatch(/Do not add, remove or rearrange walls/);
  });

  test('each viewpoint rewrites the prompt', async ({ page }) => {
    await importMocked(page);
    await openAI(page);
    const seen = {};
    for (const v of ['top', 'eye', 'iso', 'sketch']) {
      await page.locator(`#aiView button[data-v="${v}"]`).click();
      await page.waitForTimeout(200);
      seen[v] = await page.locator('#aiPrompt').inputValue();
      await expect(page.locator(`#aiView button[data-v="${v}"]`)).toHaveClass(/on/);
    }
    expect(seen.top).toMatch(/top-down|bird/i);
    expect(seen.eye).toMatch(/eye level|1\.6 m|24 mm/i);
    expect(seen.iso).toMatch(/isometric|dollhouse/i);
    expect(seen.sketch).toMatch(/watercolour|ink/i);
    expect(new Set(Object.values(seen)).size).toBe(4);       // all genuinely different
  });

  test('can be scoped to a single room', async ({ page }) => {
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(1).click();
    await page.waitForTimeout(250);
    await openAI(page);

    const whole = await page.locator('#aiPrompt').inputValue();
    const opts = await page.locator('#aiRoom option').allInnerTexts();
    expect(opts[0]).toMatch(/Whole floor/);
    expect(opts.join(' ')).toContain('Woonkamer');

    await page.locator('#aiRoom').selectOption({ label: opts.find(o => o.includes('Woonkamer')) });
    await page.waitForTimeout(250);
    const one = await page.locator('#aiPrompt').inputValue();
    expect(one).toContain('Woonkamer');
    expect(one).not.toContain('Keuken');
    expect(one.length).toBeLessThan(whole.length);
  });

  test('lists furniture that was actually placed, and can omit it', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 700, 400);
    await addFromTray(page, 'dt6', 850, 520);
    await page.locator('#btnAI').click();
    await page.waitForTimeout(300);

    let p = await page.locator('#aiPrompt').inputValue();
    expect(p.toLowerCase()).toContain('sofa 3-seat');
    expect(p.toLowerCase()).toContain('table 6p');
    expect(p).toMatch(/225×95 cm/);

    await page.locator('.tg:has(#aiFurn)').click();          // list the furniture: off
    await page.waitForTimeout(250);
    p = await page.locator('#aiPrompt').inputValue();
    expect(p.toLowerCase()).not.toContain('sofa 3-seat');

    await page.locator('.tg:has(#aiDims)').click();          // measurements: off
    await page.waitForTimeout(250);
    p = await page.locator('#aiPrompt').inputValue();
    expect(p).not.toMatch(/m²/);
  });

  test('free-text style is folded into the prompt', async ({ page }) => {
    await starter(page);
    await page.locator('#btnAI').click();
    await page.locator('#aiStyle').fill('Scandinavian, warm oak, matte black accents');
    await page.waitForTimeout(300);
    const p = await page.locator('#aiPrompt').inputValue();
    expect(p).toContain('STYLE');
    expect(p).toContain('warm oak');
  });

  test('produces a clean reference image — no grid, no dimension lines', async ({ page }) => {
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(1).click();
    await page.waitForTimeout(250);
    await openAI(page);

    const img = page.locator('#aiImg');
    await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/);
    const size = await img.evaluate(e => ({ w: e.naturalWidth, h: e.naturalHeight }));
    expect(Math.max(size.w, size.h)).toBeGreaterThan(1000);

    // the cyan dimension lines must not survive into the reference
    const cyan = await page.evaluate(async () => {
      const im = document.querySelector('#aiImg');
      const c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 11)
        if (d[i] < 120 && d[i + 1] > 120 && d[i + 2] > 140) n++;   // cyan-ish
      return n;
    });
    expect(cyan).toBe(0);

    // and the live canvas is left exactly as it was
    expect(await page.evaluate(() => ({ grid: window.__S.grid, view: window.__S.view })))
      .toMatchObject({ grid: true, view: { dims: 1, rooms: 1 } });
  });

  test('room names can be baked into the image', async ({ page }) => {
    await importMocked(page);
    await openAI(page);
    const before = await page.locator('#aiImg').getAttribute('src');
    await page.locator('.tg:has(#aiLabels)').click();
    await page.waitForTimeout(400);
    const after = await page.locator('#aiImg').getAttribute('src');
    expect(after).not.toBe(before);
  });

  test('copies the prompt and downloads the image', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await importMocked(page);
    await openAI(page);

    await page.locator('#aiCopy').click();
    await expect(page.locator('.toast', { hasText: 'Prompt copied' }).first()).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('North is at the top');

    const dl = await Promise.all([page.waitForEvent('download'), page.locator('#aiDlImg').click()]).then(r => r[0]);
    expect(dl.suggestedFilename()).toMatch(/-reference\.png$/);
  });
});
