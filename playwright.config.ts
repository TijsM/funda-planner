import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/* Drives the app in a real Chrome. During the v2 refactor this still points at
   the shipped single-file build; it moves to the Vite dev server once the React
   shell lands, without the specs changing. */

/* `next dev` reads .env itself, but this process does not — and the webServer
   blocks below have to be able to *unset* what is in there, which means knowing
   what is in there. No dotenv is installed and this needs no features: an
   already-set variable always wins, both here and inside `next dev`, because
   @next/env only fills in names `process.env` does not already own. */
const envFile = path.join(__dirname, '.env');
for (const line of fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n') : []) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}

const NEXT = process.env.E2E_TARGET === 'next';

/* The gate run is its own invocation rather than an extra project alongside the
   others, and it has to be: two `next dev` processes cannot share one `.next`
   directory, `next dev` has no --dist-dir to give the second one its own, and
   Playwright starts every webServer in the list regardless of which projects
   were selected. So E2E_GATE=1 swaps the whole config over — one server, one
   project, the 68 local-mode specs left out because a gated server would bounce
   every one of them to /login. */
const GATE = process.env.E2E_GATE === '1';

/* The live run is the opposite of both: a real project, real accounts, real
   sign-in. It is the only configuration in this file that talks to Supabase for
   real, it never runs in CI, and it is opt-in precisely because it creates and
   deletes accounts in whatever project the environment points at. */
const LIVE = process.env.E2E_LIVE === '1';

/* Local mode is the mode this suite runs in, and it is a property of the server,
   not of the specs — so it is forced here rather than hoped for. Without this a
   developer whose .env holds real Supabase credentials gets a gated server and
   68 red specs that say nothing about what broke. Empty rather than deleted:
   `readConfig()` trims and requires truthy, and an empty name still shadows the
   .env entry that would otherwise fill it in.

   It only reaches a server this config starts. `reuseExistingServer` means a
   `pnpm dev` already on 3500 is used as-is, credentials and all — so if the
   suite suddenly redirects to /login, that is the server to look at. */
const LOCAL_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: '',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
};

/* A host that cannot resolve, by RFC 2606, and that is the point rather than an
   accident: an unauthenticated request must be answered from the cookie jar
   alone, so if the gate ever grew a round trip to Supabase for a request with no
   token, this fetch would reject, `readSession` would throw it out of the proxy,
   and the spec would see a 500 instead of the redirect it asserts. The dummy
   credentials are therefore load-bearing — do not point them at a live project. */
const GATE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://gate-test.invalid',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_gate_test_not_a_real_key',
};

/* .env.local is where the real credentials live, and it wins over .env — the
   same precedence `next dev` applies — so the live run reads them the way the
   app will. Loaded after .env above, and only for the live run: nothing else in
   this file should be able to reach a real project by accident. */
if (LIVE) {
  const localFile = path.join(__dirname, '.env.local');
  for (const line of fs.existsSync(localFile) ? fs.readFileSync(localFile, 'utf8').split('\n') : []) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

const LOCAL_URL = NEXT ? 'http://localhost:3500' : 'http://127.0.0.1:8791';
const GATE_URL = 'http://localhost:3501';
const LIVE_URL = 'http://localhost:3502';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 4,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }], ['html', { open: 'never' }]],
  use: {
    baseURL: LIVE ? LIVE_URL : GATE ? GATE_URL : LOCAL_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  /* NB: the device preset carries its own viewport, so ours must come AFTER
     the spread or the window silently shrinks to 1280x720. */
  projects: LIVE
    ? [{
      name: 'live',
      /* Only the account spec. The other 108 assume no gate in front of them. */
      testMatch: /12-account\.spec\.js/,
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1600, height: 1000 } },
    }]
    : GATE
      ? [{
        name: 'gate',
        /* Only the gate spec. Everything else assumes it can reach the editor. */
        testMatch: /10-gate\.spec\.js/,
        use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1600, height: 1000 } },
      }]
      : [{
        name: 'chromium',
        /* The live spec needs a real project and creates real accounts; it has
           its own skip guard, but keeping it out of the default listing means
           the ordinary run reports what it actually covered. */
        testIgnore: /12-account\.spec\.js/,
        use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1600, height: 1000 } },
      }],
  /* E2E_TARGET=next runs the same specs against the ported app. */
  webServer: LIVE
    /* No `env` override at all: the server inherits the real credentials this
       config just loaded from .env.local, which is the whole point. Its own port
       and no reuse, for the same reason the gate run has both — a server started
       in local mode would sail through the gate assertions. */
    ? {
      command: 'pnpm exec next dev -p 3502',
      url: `${LIVE_URL}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
    }
    : GATE
    /* Its own port so it never collides with a `pnpm dev` someone has running,
       and reuseExistingServer stays off on purpose: reusing a server started
       without these credentials would quietly test local mode and pass. */
      ? { command: 'pnpm exec next dev -p 3501', url: `${GATE_URL}/login`, reuseExistingServer: false, timeout: 120_000, env: GATE_ENV }
      : NEXT
      ? { command: 'pnpm dev', url: `${LOCAL_URL}/`, reuseExistingServer: true, timeout: 120_000, env: LOCAL_ENV }
      : { command: 'python3 -m http.server 8791', url: `${LOCAL_URL}/index.html`, reuseExistingServer: true, timeout: 30_000 },
});
