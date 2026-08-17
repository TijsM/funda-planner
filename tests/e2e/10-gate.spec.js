import { test, expect } from '@playwright/test';
import { fresh, appUrl } from './helpers.js';

/* The gate, from both sides.
 *
 *  There are two supported deployments and this file is the only place both are
 *  exercised, because they are the same code answering opposite questions:
 *
 *  - local mode (project `chromium`, the default run) — no Supabase credentials,
 *    therefore no accounts and nothing to gate. Every one of the other specs
 *    depends on this being true, and until the password gate was removed they
 *    depended on a forged cookie instead. So the assertions here are the exact
 *    opposite of the ones this file used to make: no redirect, the editor loads,
 *    the API answers.
 *
 *  - cloud mode (project `gate`, `E2E_GATE=1`) — a server started with dummy
 *    Supabase credentials. Nothing here signs in: a Supabase JWT is signed by
 *    Supabase and cannot be minted in a test, and it does not need to be. What
 *    matters is what happens to a request carrying no token at all, and that is
 *    answered from the cookie jar without a round trip — see the note on
 *    GATE_ENV in playwright.config.ts for why the unresolvable host makes that
 *    an assertion rather than a belief. */

const GATE = process.env.E2E_GATE === '1';

/* ── local mode: there is no gate ──────────────────────────────── */

test.describe('with no Supabase credentials', () => {
  test.skip(GATE, 'this run started the server with credentials');
  test.skip(process.env.E2E_TARGET !== 'next', 'the gate is a server feature; the legacy build has no server');

  test.beforeEach(async ({ page }) => { await fresh(page); });

  test('a page request lands on the editor, not on a login screen', async ({ page }) => {
    await page.goto(appUrl());
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('#cv')).toBeVisible();
    /* The bridge only exists once the shell has booted, so this is the app
       running rather than a shell of it that happened to render a canvas. */
    await page.waitForFunction(() => !!window.__S);
  });

  test('/login redirects back out, because there is nothing to sign in to', async ({ page }) => {
    await page.goto('/login');
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('#cv')).toBeVisible();
  });

  test('the render API answers on its own terms, never with a 401 from the gate', async ({ page }) => {
    await page.goto(appUrl());

    /* A deliberately invalid body: every one of these is refused by the route's
       own validation, before a single byte reaches the provider. A spec that
       spends a credit to prove the gate is off would be a bad trade. */
    const post = await page.request.post('/api/render', { data: { prompt: '' } });
    expect(post.status()).not.toBe(401);
    expect((await post.json()).error).not.toBe('unauthenticated');

    const status = await page.request.get('/api/render/status?jobId=x');
    expect(status.status()).not.toBe(401);
    expect(await status.json()).not.toMatchObject({ error: 'unauthenticated' });
  });
});

/* ── cloud mode: the gate is armed ─────────────────────────────── */

test.describe('with Supabase credentials and no session', () => {
  test.skip(!GATE, 'runs only in the E2E_GATE invocation, which starts a server with credentials');

  test.beforeEach(async ({ page }) => { await fresh(page); });

  test('a page request is redirected to the login screen', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#cv')).toHaveCount(0);
  });

  test('where you were headed survives the redirect', async ({ page }) => {
    await page.goto('/?import=1');
    await expect(page).toHaveURL(/\/login\?next=%2F%3Fimport%3D1$/);
  });

  test('an API call gets JSON, not an HTML redirect a fetch cannot read', async ({ page }) => {
    /* page.request shares this context's cookie jar, which has no session in it */
    const status = await page.request.get('/api/render/status?renderId=00000000-0000-0000-0000-000000000000');
    expect(status.status()).toBe(401);
    expect(await status.json()).toEqual({ error: 'unauthenticated' });

    const post = await page.request.post('/api/render', { data: { prompt: 'x' } });
    expect(post.status()).toBe(401);
    expect(await post.json()).toEqual({ error: 'unauthenticated' });
  });

  test('the login screen asks for an email address and nothing else', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#email')).toHaveAttribute('type', 'email');
    /* There is no password anywhere in the system any more — a field for one
       would mean someone had put the old gate back. */
    await expect(page.locator('#pw')).toHaveCount(0);
    /* autoFocus, so the address can just be typed */
    await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? '')).toBe('email');

    /* Nothing to send yet, and the code step is not reachable without one. */
    await expect(page.locator('#loginGo')).toBeDisabled();
    await expect(page.locator('#code')).toHaveCount(0);
    await page.locator('#email').pressSequentially('someone@example.com', { delay: 20 });
    await expect(page.locator('#loginGo')).toBeEnabled();
  });
});
