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

  test('measurements on the reference image are off, and can be turned on', async ({ page }) => {
    test.skip(process.env.E2E_TARGET !== 'next', 'v2 shell feature');
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(1).click();
    await page.waitForTimeout(250);
    await openAI(page);

    /* Off by default. It shipped on, and the lettering it adds — a caption per
       room, the chains, a labelled scale bar — came back copied into renders as
       invented dimensions, while the prompt promised the image had no text at
       all. The toggle stays; the default changed. */
    await expect(page.locator('#aiImgDims')).not.toBeChecked();
    await expect(page.locator('.ai-right')).not.toContainText('bleed into the render');

    /* Was a count of dark pixels, on the reasoning that chains and captions are
       ink and ink only goes up. That stopped holding once the frame excluded the
       chains: turning measurements on also widens the margin to make room for
       them, so the plan is drawn smaller inside the same long side and the page
       comes out *lighter* overall. The honest assertion is that the toggle
       reaches the reference at all — which the changed size shows. */
    const size = () => page.evaluate(() => {
      const img = document.querySelector('#aiImg');
      return `${img.naturalWidth}x${img.naturalHeight}`;
    });
    const plain = await size();

    await page.locator('.tg:has(#aiImgDims)').click();
    await expect(page.locator('#aiImgDims')).toBeChecked();
    await page.waitForTimeout(700);
    /* the warning belongs with the choice, so it appears only once it is made */
    await expect(page.locator('.ai-right')).toContainText('bleed into the render');
    expect(await size()).not.toBe(plain);
  });

  /** The reference is framed on the building, not on its annotation.
   *
   *  `contentBBox` counts `f.dims`, so an imported plan whose chains sit a metre
   *  or more off the walls was framed around the chains: the frame came out much
   *  wider than the building without coming out taller, the plan sat in a
   *  letterbox, and the generator filled the spare bands with a title block and
   *  dimensions it made up.
   *
   *  A chain is added four metres clear of the plan rather than relying on the
   *  fixture's own, whose reach happens to sit inside the furniture's and would
   *  move the frame by three percent — too little to tell a fix from noise. Out
   *  here the old behaviour is unmistakable and the new one is a no-op. */
  test('a dimension chain far outside the plan does not widen the reference', async ({ page }) => {
    test.skip(process.env.E2E_TARGET !== 'next', 'v2 shell feature');
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(1).click();
    await page.waitForTimeout(250);
    await openAI(page);

    const size = () => page.evaluate(() => {
      const img = document.querySelector('#aiImg');
      return { w: img.naturalWidth, h: img.naturalHeight };
    });
    const before = await size();

    const reach = await page.evaluate(() => {
      const s = window.__ed();
      const f = s.floor();
      const xs = f.walls.flatMap(w => [w.a.x, w.b.x]);
      const ys = f.walls.flatMap(w => [w.a.y, w.b.y]);
      const x = Math.max(...xs) + 400;                    // 4 m clear of the building
      const y0 = Math.min(...ys), y1 = Math.max(...ys);
      f.dims.push({ id: 'e2e-far-chain', a: { x, y: y0 }, b: { x, y: y1 } });
      s.touch();                                          // bumps rev; the preview redraws
      return x - Math.max(...xs);
    });
    expect(reach).toBe(400);
    await page.waitForTimeout(700);

    const after = await size();
    /* Unchanged, not merely similar: the chain is outside everything the picture
       draws, so it must not move a single pixel of the frame. */
    expect(after).toEqual(before);
  });
});
