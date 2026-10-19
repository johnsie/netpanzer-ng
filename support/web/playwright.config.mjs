import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'browser.spec.mjs',
  timeout: 120000,
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8080',
    viewport: { width: 1120, height: 1000 },
    screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_HOST_RESOLVER_RULES
      ? { args: [`--host-resolver-rules=${process.env.PLAYWRIGHT_HOST_RESOLVER_RULES}`] }
      : undefined,
  },
  projects: [
    { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
});
