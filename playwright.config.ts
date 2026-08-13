import { defineConfig, devices } from '@playwright/test';

/* Drives the app in a real Chrome. During the v2 refactor this still points at
   the shipped single-file build; it moves to the Vite dev server once the React
   shell lands, without the specs changing. */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 4,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_TARGET === 'next' ? 'http://localhost:3500' : 'http://127.0.0.1:8791',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  /* NB: the device preset carries its own viewport, so ours must come AFTER
     the spread or the window silently shrinks to 1280x720. */
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1600, height: 1000 } },
  }],
  /* E2E_TARGET=next runs the same specs against the ported app. */
  webServer: process.env.E2E_TARGET === 'next'
    ? { command: 'pnpm dev', url: 'http://localhost:3500/', reuseExistingServer: true, timeout: 120_000 }
    : { command: 'python3 -m http.server 8791', url: 'http://127.0.0.1:8791/index.html', reuseExistingServer: true, timeout: 30_000 },
});
