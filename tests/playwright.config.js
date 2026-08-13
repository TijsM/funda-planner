import { defineConfig, devices } from '@playwright/test';

/* The app is a single static HTML file. We serve the folder so the
   reader-proxy fetch runs from a real http origin, and separately cover
   the file:// case (how it is actually double-clicked) in 05-file-url. */
export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  workers: 4,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'results.json' }], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8791',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1600, height: 950 },
  },
  /* NB: the device preset carries its own viewport, so ours must come AFTER
     the spread or the window silently shrinks to 1280x720. */
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1600, height: 1000 } },
  }],
  webServer: {
    command: 'python3 -m http.server 8791 --directory ..',
    url: 'http://127.0.0.1:8791/plattegrond-studio.html',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
