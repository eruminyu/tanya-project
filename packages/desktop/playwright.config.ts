import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/electron',
  timeout: 30000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: '.test-output/playwright',
  use: { trace: 'retain-on-failure' },
});
