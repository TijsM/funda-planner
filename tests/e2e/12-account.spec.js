import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

/** The account flow, against a real Supabase project.
 *
 *  Everything else in this suite runs in local mode, where there are no accounts
 *  at all — see `10-gate.spec.js`. This file is the other half: it needs live
 *  credentials, so it skips itself entirely without them and never runs in CI.
 *
 *    NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_PRIVATE_KEY=… E2E_LIVE=1 \
 *      pnpm exec playwright test tests/e2e/12-account.spec.js
 *
 *  The six-digit code comes from `auth.admin.generateLink`, which mints exactly
 *  the token the email would have carried without sending anything. The code
 *  typed into the form is therefore a real one, and `verifyOtp` — the call that
 *  actually creates the session — runs for real against the live project.
 *
 *  One leg is stubbed and only one: the POST that asks Supabase to *send* the
 *  mail. Two reasons, both properties of the mailer rather than of this app.
 *  Supabase rejects `@example.com` outright as an invalid address, so the
 *  obvious throwaway domain is unavailable; and the provider only accepts
 *  recipients it has a verified sending domain for, which a `+stamp` address
 *  invented per run is not. Stubbing keeps the assertions about our code and
 *  leaves nothing in anyone's inbox.
 *
 *  So this does NOT prove an email arrives. That is SMTP's job — step 5 of
 *  docs/SUPABASE.md — and no automated test here can stand in for sending one to
 *  yourself and reading it.
 *
 *  The accounts are created and deleted per run, and deleting a user cascades to
 *  their plans, renders and profile row, so this leaves nothing behind. */

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const SECRET = (process.env.SUPABASE_PRIVATE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();

test.skip(
  !process.env.E2E_LIVE || !URL_ || !SECRET,
  'needs a live project: set E2E_LIVE=1, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_PRIVATE_KEY',
);

/* Serial, and deliberately so: these are the steps of one session, in order —
   sign in, save a plan, see it sync, sign out and find it gone. Running them in
   parallel against one account would be testing a different thing. */
test.describe.configure({ mode: 'serial' });

const admin = () => createClient(URL_, SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stamp = Date.now();
/* Not @example.com: Supabase's address validator rejects it outright with
   `email_address_invalid`, which the login form now reports accurately and which
   would fail every test below for a reason that has nothing to do with them. */
const EMAIL = `plattegrond-e2e+${stamp}@rodi-digital.com`;
let userId = null;

/** Intercepts the "send me a code" call and answers the way a successful send
 *  answers — `{}` and a 200. Everything else, `verifyOtp` included, goes to the
 *  real project untouched.
 *
 *  Matching on the `otp` endpoint rather than on the whole auth host is what
 *  keeps that true: a broader route would swallow the token exchange as well and
 *  the test would prove nothing at all. */
async function stubTheMailer(page) {
  await page.route(/\/auth\/v1\/otp(\?|$)/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
}

/** Signs in through the form and lands in the editor.
 *
 *  Every test gets its own browser context, so a session cannot be inherited
 *  from the test before it — and that is worth keeping rather than working
 *  around with a shared storage state: each test below then proves for itself
 *  that a real sign-in reaches the thing it is about. */
async function signIn(page) {
  await stubTheMailer(page);
  await page.goto('/login');
  await page.locator('#email').fill(EMAIL);
  await page.locator('#loginGo').click();
  await expect(page.locator('#code')).toBeVisible();
  await page.locator('#code').fill(await mintCode());
  await page.locator('#loginGo').click();
  await expect(page.locator('#cv')).toBeVisible({ timeout: 15_000 });
}

test.beforeAll(async () => {
  const { data, error } = await admin().auth.admin.createUser({ email: EMAIL, email_confirm: true });
  if (error) throw new Error(`could not create the test account: ${error.message}`);
  userId = data.user.id;
});

test.afterAll(async () => {
  if (userId) await admin().auth.admin.deleteUser(userId).catch(() => { /* best effort */ });
});

/** The code the email would have carried. `generateLink` does not send. */
async function mintCode() {
  const { data, error } = await admin().auth.admin.generateLink({ type: 'magiclink', email: EMAIL });
  if (error) throw new Error(`could not mint an OTP: ${error.message}`);
  const otp = data.properties?.email_otp;
  if (!otp) throw new Error('the admin API returned no email_otp');
  return otp;
}

/* ── the gate ─────────────────────────────────────────────────────── */

test('a signed-out visitor is sent to the login screen', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('#email')).toBeVisible();
  /* the password field the old gate had, and the reason this file exists */
  await expect(page.locator('#pw')).toHaveCount(0);
});

test('a wrong code is refused, and says so in the field it is about', async ({ page }) => {
  await stubTheMailer(page);
  await page.goto('/login');

  await page.locator('#email').fill(EMAIL);
  await page.locator('#loginGo').click();
  await expect(page.locator('#code')).toBeVisible();

  /* Six digits, so it is the code Supabase rejects rather than the shape. This
     is a real verifyOtp against the live project — only the send was stubbed. */
  await page.locator('#code').fill('000000');
  await page.locator('#loginGo').click();

  await expect(page.locator('#loginErr')).toBeVisible();
  await expect(page.locator('#loginErr')).toContainText(/code/i);
  /* Still on the code step with the address intact: a failed code must not throw
     away the address and make someone start again. */
  await expect(page.locator('#code')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('the whole sign-in: an address, a code, and the editor', async ({ page }) => {
  await stubTheMailer(page);
  await page.goto('/login');

  await page.locator('#email').fill(EMAIL);
  await page.locator('#loginGo').click();
  await expect(page.locator('#code')).toBeVisible();
  await expect(page.locator('#loginNote')).toContainText(EMAIL);

  await page.locator('#code').fill(await mintCode());
  await page.locator('#loginGo').click();

  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  await expect(page.locator('#cv')).toBeVisible();

  const cookies = await page.context().cookies();
  expect(cookies.some(c => /^sb-.*auth-token/.test(c.name))).toBe(true);
});

/** Seven idle days ends a session, and any use inside the week pushes it back.
 *
 *  Enforced by the proxy against a `pgs.seen` timestamp, because neither of the
 *  two obvious mechanisms is available: Supabase's `sessions_inactivity_timeout`
 *  needs a Pro plan, and `@supabase/ssr` accepts a `maxAge` on the auth cookie
 *  and then overwrites it with its own 400-day default. Both were tried and both
 *  failed silently, which is exactly why this is pinned.
 *
 *  The clock moves by rewriting the cookie rather than by waiting a week. */
test('a week away ends the session; using it keeps the week rolling', async ({ page, context }) => {
  await signIn(page);

  const seen = (await context.cookies()).find(c => c.name === 'pgs.seen');
  expect(seen, 'the proxy should stamp pgs.seen on a signed-in request').toBeTruthy();

  /* Six days idle: inside the window, so still signed in — and the visit has to
     push the stamp forward, which is the whole difference between a rolling week
     and a hard one. */
  const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
  await context.addCookies([{ ...seen, value: String(sixDaysAgo) }]);
  await page.goto('/');
  await expect(page.locator('#cv')).toBeVisible();

  const rolled = (await context.cookies()).find(c => c.name === 'pgs.seen');
  expect(Number(rolled.value)).toBeGreaterThan(sixDaysAgo);

  /* Eight days idle: past the window. Revoked rather than merely forgotten, so
     the auth cookies go with it. */
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  await context.addCookies([{ ...seen, value: String(eightDaysAgo) }]);
  await page.goto('/');

  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator('#email')).toBeVisible();

  const live = (await context.cookies()).filter(c => /^sb-.*auth-token/.test(c.name) && c.value);
  expect(live).toHaveLength(0);
});

/** The `?next=` round trip, end to end and for real: the proxy writes it on the
 *  way in, this form reads it on the way out. `safeDestination` has its own unit
 *  tests for the hostile inputs; this is the one that proves the benign case
 *  actually works through a live sign-in. */
test('signing in returns you to the page you asked for', async ({ page }) => {
  await stubTheMailer(page);
  await page.goto('/?import=1');
  await expect(page).toHaveURL(/\/login\?next=/);

  await page.locator('#email').fill(EMAIL);
  await page.locator('#loginGo').click();
  await page.locator('#code').fill(await mintCode());
  await page.locator('#loginGo').click();

  await expect(page).toHaveURL(/\/\?import=1$/, { timeout: 15_000 });
});

/* ── the account holds the work ───────────────────────────────────── */

test('a saved plan reaches Postgres, and comes back after a reload', async ({ page }) => {
  await signIn(page);

  /* A blank plan through the app's own deep link, so nothing here depends on the
     importer or on anything beyond Supabase. The query is a cache-buster: a
     hash-only change is a same-document navigation and the boot effect would
     never run again. */
  await page.goto('/?n=1#new');
  await page.waitForFunction(() => window.__S && window.__S.proj);

  const name = `E2E ${stamp}`;
  await page.evaluate(n => {
    /* `__S.proj` is a getter onto the live document, and `__ed()` is the store
       itself — `touch()` is what marks it dirty and stamps updatedAt, which is
       the field the sync decides on. */
    window.__S.proj.name = n;
    window.__ed().touch();
  }, name);

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await expect(page.locator('.toast', { hasText: 'Saved' }).first()).toBeVisible({ timeout: 10_000 });

  /* The push is debounced, so poll the database rather than guessing at a sleep. */
  const db = admin();
  await expect.poll(async () => {
    const { data } = await db.from('plans').select('name').eq('owner_id', userId).eq('name', name);
    return data?.length ?? 0;
  }, { timeout: 30_000, message: 'the plan never reached the plans table' }).toBe(1);

  /* A fresh load with no hash, not a reload: `#new` is still in the URL and boot
     reads it before it ever looks at the autosave, so reloading would hand back
     a brand-new blank plan and the assertion below would be about nothing. */
  await page.goto('/?n=2');
  await page.waitForFunction(() => window.__S && window.__S.proj);
  expect(await page.evaluate(() => window.__S.proj.name)).toBe(name);
});

test('signing out clears this browser and puts the gate back', async ({ page }) => {
  await signIn(page);

  /* A fresh account has no plan to restore, so boot opens the importer over the
     whole screen and the top bar sits behind it. Its own close button, not
     Escape: the importer autofocuses its URL field, and the document-level
     keydown guard in Editor.tsx deliberately ignores every key while the caret
     is in an input — which is exactly what stops tool shortcuts firing mid-type
     and must not be relaxed. */
  await page.locator('#ovImport [data-close]').click();
  await expect(page.locator('#ovImport')).toHaveCount(0);

  page.once('dialog', d => void d.accept());
  await page.locator('#btnSignOut').click();

  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });

  /* The account's plans must not be readable from this browser afterwards — the
     next person to sign in here is a different person. */
  const left = await page.evaluate(() =>
    Object.keys(localStorage).filter(k => k.startsWith('pgs.index') || k.startsWith('pgs.proj')));
  expect(left).toEqual([]);

  /* But it is still in the account. */
  const { data } = await admin().from('plans').select('id').eq('owner_id', userId);
  expect(data?.length).toBeGreaterThan(0);
});

