import { test, expect } from '@playwright/test';
import { appUrl, fresh, starter, toast } from './helpers.js';

/* The render workspace, driven end to end with the provider replaced by a stub.
   NOTHING here may reach api.bfl.ai: every render costs real money, so both
   routes are intercepted by exact pathname and a miss is a hard failure rather
   than a quiet live call. */

test.skip(process.env.E2E_TARGET !== 'next', 'v2 shell feature');

/* a 1×1 transparent PNG — the smallest thing that is genuinely an image */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const POLL_URL = 'https://api.eu1.bfl.ai/v1/get_result?id=e2e-job';

const active = page => page.evaluate(() => document.activeElement?.id ?? '');

/** Stands in for both render routes. `pending` is how many polls answer "still
 *  working" before the job settles, so the elapsed counter and the backoff are
 *  exercised rather than skipped. Returns the submitted bodies, which is where
 *  "we asked for 832×1168, not 1800×1800" is actually checked. */
async function stubProvider(page, opts = {}) {
  const sent = [];
  let polls = 0;

  await page.route(u => u.pathname === '/api/render', async route => {
    sent.push(JSON.parse(route.request().postData() || '{}'));
    if (opts.submitStatus) {
      await route.fulfill({
        status: opts.submitStatus, contentType: 'application/json',
        body: JSON.stringify({ error: opts.submitError, retryable: false }),
      });
      return;
    }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ jobId: 'e2e-job', pollUrl: POLL_URL }),
    });
  });

  await page.route(u => u.pathname === '/api/render/status', async route => {
    polls++;
    const still = polls <= (opts.pending ?? 0);
    const body = still ? { status: 'pending', progress: 0.3 }
      : opts.failure ? { status: 'failed', error: opts.failure, retryable: false }
        : { status: 'ready', image: PNG, contentType: 'image/png', bytes: 68 };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  return { sent, polls: () => polls };
}

const openAI = async page => {
  await page.locator('#btnAI').click();
  await expect(page.locator('#ovAI')).toHaveClass(/open/);
  await expect(page.locator('#aiPrompt')).not.toBeEmpty();
};

test.beforeEach(async ({ page }) => { await fresh(page); });

test.describe('generating a render', () => {
  test('runs, lands in the filmstrip, and survives a reload', async ({ page }) => {
    const stub = await stubProvider(page, { pending: 1 });
    await starter(page);
    await openAI(page);

    const prompt = await page.locator('#aiPrompt').inputValue();
    await page.locator('#aiGen').click();

    /* elapsed seconds, not a percentage, and the honest warning next to them */
    await expect(page.locator('#aiRun')).toBeVisible();
    await expect(page.locator('#aiRun')).toContainText('closing this panel does not cancel it');
    await expect(page.locator('#aiGen')).toBeDisabled();

    await expect(toast(page, 'Render ready')).toBeVisible();
    await expect(page.locator('#aiRender')).toBeVisible();
    await expect(page.locator('.ai-cell')).toHaveCount(1);
    await expect(page.locator('#aiRun')).toHaveCount(0);
    await expect(page.locator('#aiGen')).toBeEnabled();
    await expect(page.locator('#aiSession')).toContainText('1 this session');

    /* what actually went to the provider */
    expect(stub.sent).toHaveLength(1);
    const [body] = stub.sent;
    expect(body.prompt).toBe(prompt);
    expect(body.imageBase64).toMatch(/^data:image\/png;base64,/);
    expect(Number.isInteger(body.seed) && body.seed >= 0).toBe(true);
    /* billed per output megapixel: the 1800 px reference must not be echoed back
       as the output size, and both sides have to be multiples of 16 */
    expect(body.width % 16).toBe(0);
    expect(body.height % 16).toBe(0);
    expect(body.width * body.height).toBeLessThanOrEqual(1_000_000);
    expect(Math.max(body.width, body.height)).toBeLessThan(1800);
    /* the footer states the same numbers the request used */
    await expect(page.locator('#aiSession')).toContainText(`${body.width}×${body.height}`);

    /* Renders are IndexedDB, not the document — so they outlive a reload while
       the session counter, which is a per-tab thing, does not. Reloaded the way
       04-persistence does it: the autosave, then a hash-less URL, so the app
       restores this project rather than minting a fresh one with new ids. */
    const floorId = await page.evaluate(() => window.__S.proj.floors[0].id);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    await page.waitForTimeout(400);
    await page.goto(appUrl());
    await page.waitForFunction(() => window.__S && window.__S.proj);
    await page.waitForTimeout(400);
    /* the records are keyed on these ids, so a test that quietly restored a
       different project would prove nothing */
    expect(await page.evaluate(() => window.__S.proj.floors[0].id)).toBe(floorId);

    await openAI(page);
    await expect(page.locator('.ai-cell')).toHaveCount(1);
    await expect(page.locator('#aiSession')).toContainText('0 this session');
    await expect(page.locator('#aiLocal')).toContainText('this browser only');
  });

  test('a double click buys one render, not two', async ({ page }) => {
    const stub = await stubProvider(page, { pending: 2 });
    await starter(page);
    await openAI(page);

    /* Both clicks in one tick, past the disabled attribute — which is what a
       real double click does, and each one is a credit. */
    await page.evaluate(() => {
      const b = document.querySelector('#aiGen');
      b.click();
      b.click();
    });
    await expect(page.locator('#aiRun')).toBeVisible();
    await expect(toast(page, 'Render ready')).toBeVisible();

    expect(stub.sent).toHaveLength(1);
    await expect(page.locator('.ai-cell')).toHaveCount(1);
  });

  test('closing the panel does not cancel the render', async ({ page }) => {
    await stubProvider(page, { pending: 2 });
    await starter(page);
    await openAI(page);
    await page.locator('#aiGen').click();
    await expect(page.locator('#aiRun')).toBeVisible();

    /* the poller is module-level for exactly this reason — Escape unmounts the
       modal and every useState in it */
    await page.keyboard.press('Escape');
    await expect(page.locator('#ovAI')).toHaveCount(0);

    await expect(toast(page, 'Render ready')).toBeVisible();
    await openAI(page);
    await expect(page.locator('.ai-cell')).toHaveCount(1);
  });

  test('a failure keeps the render as a retry, not just a toast', async ({ page }) => {
    await stubProvider(page, { failure: 'The generated image was filtered. Re-roll the seed.' });
    await starter(page);
    await openAI(page);
    await page.locator('#aiStyle').fill('brutalist concrete');
    await page.waitForTimeout(300);
    await page.locator('#aiGen').click();

    await expect(toast(page, 'Re-roll the seed')).toBeVisible();
    /* Toasts auto-dismiss after 6.2 s and carry no button, so the record is the
       only place the retry can live — and it has to remember what was asked. */
    await expect(page.locator('.ai-cell.bad')).toHaveCount(1);
    await expect(page.locator('#aiRenderErr')).toContainText('Re-roll the seed');
    await expect(page.locator('#aiGen')).toBeEnabled();

    await page.locator('#aiUse').click();
    await expect(page.locator('#aiStyle')).toHaveValue('brutalist concrete');
    await expect(page.locator('#aiCount')).toContainText('building on');
  });

  test('a refused submit says why and costs no credit', async ({ page }) => {
    const stub = await stubProvider(page, {
      submitStatus: 402,
      submitError: 'Out of credits at the image provider. Top up at api.bfl.ai.',
    });
    await starter(page);
    await openAI(page);
    await page.locator('#aiGen').click();

    await expect(toast(page, 'Out of credits')).toBeVisible();
    expect(stub.polls()).toBe(0);
    await expect(page.locator('#aiGen')).toBeEnabled();
    await expect(page.locator('#aiSession')).toContainText('0 this session');
  });
});

test.describe('the seed field', () => {
  test('takes every digit, and a stray letter fires no tool shortcut', async ({ page }) => {
    await stubProvider(page);
    await starter(page);
    await openAI(page);
    const grid = await page.evaluate(() => window.__S.grid);

    const el = page.locator('#aiSeed');
    await el.click();
    await el.fill('');
    /* 'g' toggles the grid, 'w' arms the wall tool and '0' zooms to fit — none
       may fire while a seed is being typed, and the field keeps only digits */
    await el.pressSequentially('1g2w30', { delay: 25 });
    await page.waitForTimeout(150);

    expect(await el.inputValue()).toBe('1230');
    expect(await active(page)).toBe('aiSeed');
    expect(await page.evaluate(() => window.__S.grid)).toBe(grid);
    expect(await page.evaluate(() => window.__S.tool)).toBe('select');
  });

  test('a locked seed is the one that gets sent', async ({ page }) => {
    const stub = await stubProvider(page);
    await starter(page);
    await openAI(page);

    const el = page.locator('#aiSeed');
    await el.click();
    await el.pressSequentially('4242', { delay: 25 });
    expect(await active(page)).toBe('aiSeed');
    await page.locator('.tg:has(#aiSeedLock)').click();
    await expect(page.locator('#aiSeedLock')).toBeChecked();

    await page.locator('#aiGen').click();
    await expect(toast(page, 'Render ready')).toBeVisible();
    expect(stub.sent[0].seed).toBe(4242);
    /* still 4242 in the field, so the next run reuses it */
    await expect(el).toHaveValue('4242');
    await expect(page.locator('#aiMeta')).toContainText('seed 4242');
  });

  test('an unlocked seed is rolled and written back, so it can be locked after the fact', async ({ page }) => {
    const stub = await stubProvider(page);
    await starter(page);
    await openAI(page);
    await expect(page.locator('#aiSeed')).toHaveValue('');

    await page.locator('#aiGen').click();
    await expect(toast(page, 'Render ready')).toBeVisible();
    /* a seed you cannot read afterwards is a seed you cannot lock */
    await expect(page.locator('#aiSeed')).toHaveValue(String(stub.sent[0].seed));
  });
});

test.describe('Generate is off when there is nothing to send', () => {
  test('with an empty prompt', async ({ page }) => {
    await stubProvider(page);
    await starter(page);
    await openAI(page);
    await page.locator('#aiPrompt').fill('');
    await expect(page.locator('#aiGen')).toBeDisabled();

    await page.locator('#aiRegen').click();
    await expect(page.locator('#aiPrompt')).not.toBeEmpty();
    await expect(page.locator('#aiGen')).toBeEnabled();
  });

  test('with an empty floor, which has no reference image to condition on', async ({ page }) => {
    await stubProvider(page);
    await starter(page);
    /* select everything and delete it — a floor with no geometry legitimately
       has no reference image, and the render is conditioned on that image.
       The shortcut is on document, so nothing needs clicking first — and the
       corners of the canvas are covered by the floating tool buttons anyway. */
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);

    await page.locator('#btnAI').click();
    await expect(page.locator('#ovAI')).toHaveClass(/open/);
    await expect(page.locator('#aiImg')).toHaveCount(0);
    await expect(page.locator('.ai-prev .empty')).toBeVisible();
    await expect(page.locator('#aiGen')).toBeDisabled();
  });
});

test.describe('the renders sidebar', () => {
  test('shows what was generated, without opening the render panel', async ({ page }) => {
    await stubProvider(page);
    await starter(page);
    await openAI(page);
    await page.locator('#aiGen').click();
    await expect(toast(page, 'Render')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#ovAI')).toHaveCount(0);

    /* the whole point: the render is reachable with the panel shut */
    await expect(page.locator('#rbar')).toHaveCount(0);
    await page.locator('#btnRenders').click();
    await expect(page.locator('#rbar')).toBeVisible();
    await expect(page.locator('#rbarList .rcell')).toHaveCount(1);
    await expect(page.locator('#rbarCount')).toHaveText('1');
  });

  test('remembers whether it was open, and enlarges a render on click', async ({ page }) => {
    await stubProvider(page);
    await starter(page);
    await openAI(page);
    await page.locator('#aiGen').click();
    await expect(toast(page, 'Render')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    await page.locator('#btnRenders').click();
    await expect(page.locator('#rbar')).toBeVisible();

    await page.locator('#rbarList .rcell .rcell-img').first().click();
    await expect(page.locator('#rbarBig img')).toBeVisible();
    await page.locator('#rbarBig').click();
    await expect(page.locator('#rbarBig')).toHaveCount(0);

    /* the sidebar is chrome, not document — it survives a reload on its own */
    await page.reload();
    await page.waitForFunction(() => window.__S && window.__S.proj);
    await expect(page.locator('#rbar')).toBeVisible();
    await page.locator('#rbarClose').click();
    await expect(page.locator('#rbar')).toHaveCount(0);
    await page.reload();
    await page.waitForFunction(() => window.__S && window.__S.proj);
    await expect(page.locator('#rbar')).toHaveCount(0);
  });

  test('deleting from the sidebar takes it out of the filmstrip too', async ({ page }) => {
    await stubProvider(page);
    await starter(page);
    await openAI(page);
    await page.locator('#aiGen').click();
    await expect(toast(page, 'Render')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    await page.locator('#btnRenders').click();
    await expect(page.locator('#rbarList .rcell')).toHaveCount(1);

    await page.locator('#rbarList .rcell .cb.dgr').first().click();
    await expect(page.locator('#rbarList .rcell')).toHaveCount(0);
    await openAI(page);
    await expect(page.locator('#aiStrip .ai-cell')).toHaveCount(0);
  });
});
