import { defineConfig } from '@playwright/test';

/**
 * Testes de fluxo no Electron empacotado (out/). Requer `npm run build` antes.
 * Em ambientes sem display, use `xvfb-run npm run test:e2e`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
