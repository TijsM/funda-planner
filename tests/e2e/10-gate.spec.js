import { test, expect } from '@playwright/test';
import { fresh, appUrl, appFailures } from './helpers.js';

/* The password gate. Everything here deliberately runs signed OUT — fresh()
   hands every other spec a valid cookie, which is the only reason the 68 that
   predate the gate still see the app at all. */

test.skip(process.env.E2E_TARGET !== 'next', 'the gate is a server feature; the legacy build has no server');

const PASSWORD = process.env.APP_LOGIN;

const active = page => page.evaluate(() => document.activeElement?.id ?? '');

/** Type it the slow way and report what survived — a field that is destroyed
 *  and rebuilt between keystrokes looks perfect to fill(). */
async function typeInto(page, id, text) {
  const el = page.locator(id);
  await el.click();
  await el.fill('');
  await el.pressSequentially(text, { delay: 25 });
  await page.waitForTimeout(120);
  return { value: await el.inputValue(), focus: await active(page) };
}

test.beforeEach(async ({ page }) => { await fresh(page, { auth: false }); });

test.describe('signed out', () => {
  test('a page request lands on the login screen, not on the plan', async ({ page }) => {
    await page.goto(appUrl());
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#pw')).toBeVisible();
    await expect(page.locator('#cv')).toHaveCount(0);

    /* the caret is already in the field, so the password can just be typed */
    await expect.poll(() => active(page)).toBe('pw');
    /* a redirect is the gate working, not the app failing */
    expect(appFailures(page)).toEqual([]);
  });

  test('an API call gets JSON, not an HTML redirect a fetch cannot read', async ({ page }) => {
    await page.goto(appUrl());
    await expect(page).toHaveURL(/\/login$/);

    /* page.request shares this context's cookie jar, which has no session in it */
    const r = await page.request.get('/api/render/status?jobId=x&pollUrl=https%3A%2F%2Fapi.bfl.ai%2Fv1%2Fget_result');
    expect(r.status()).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthenticated' });

    const post = await page.request.post('/api/render', { data: { prompt: 'x' } });
    expect(post.status()).toBe(401);
  });

  test('a wrong password is refused, and says only that', async ({ page }) => {
    await page.goto(appUrl());
    await expect(page).toHaveURL(/\/login$/);

    const typed = await typeInto(page, '#pw', 'definitely-not-it');
    expect(typed).toMatchObject({ value: 'definitely-not-it', focus: 'pw' });

    await page.locator('#loginGo').click();
    await expect(page.locator('#loginErr')).toBeVisible();
    await expect(page.locator('#loginErr')).toContainText(/does not match/i);
    /* still outside, and the field is still there to try again in */
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#pw')).toBeVisible();

    /* The refusal is a 401 and therefore lands in the request log. Expected
       here, and nothing else may be in there with it. */
    expect(appFailures(page)).toHaveLength(1);
    expect(appFailures(page)[0]).toMatch(/^401 .*\/api\/login$/);
  });

  test('the right password opens the door and is remembered', async ({ page, context }) => {
    test.skip(!PASSWORD, 'APP_LOGIN is not set in this environment');
    await page.goto(appUrl());
    await expect(page).toHaveURL(/\/login$/);

    const typed = await typeInto(page, '#pw', PASSWORD);
    expect(typed).toMatchObject({ value: PASSWORD, focus: 'pw' });

    await page.locator('#loginGo').click();
    /* a full load, not a client-side push — only a fresh request carries the
       new cookie past the gate */
    await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 20_000 });
    await expect(page.locator('#cv')).toBeVisible();

    const session = (await context.cookies()).find(c => c.name === 'session');
    expect(session).toBeTruthy();
    /* httpOnly is the whole point: script on the page must not be able to read
       or forge it, and lax keeps it off cross-site requests */
    expect(session).toMatchObject({ httpOnly: true, path: '/', sameSite: 'Lax' });

    /* and it survives a reload, which is what "remembered" means */
    await page.reload();
    await expect(page.locator('#cv')).toBeVisible();
    expect(appFailures(page)).toEqual([]);
  });
});
