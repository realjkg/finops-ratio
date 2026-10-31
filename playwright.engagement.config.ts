import { defineConfig } from '@playwright/test';
import path from 'node:path';
// The engagement report page in engagement mode (R2). Runs against an existing production build
// (RATIO_TEST_NEXT_DIR, e.g. the simulation suite's); SYNTHETIC users and sessions from tests/engagement/setup.ts.
const port = Number(process.env.RATIO_ENGAGEMENT_TEST_PORT ?? 3120);
const baseURL = `http://localhost:${port}`;
const out = path.resolve('.engagement-test-results');
export default defineConfig({
  testDir: './tests/engagement', fullyParallel: false, workers: 1, timeout: 120_000, expect: { timeout: 20_000 }, reporter: [['list']], outputDir: `${out}/browser`,
  use: { baseURL, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: process.env.RATIO_CHROMIUM_PATH ? { executablePath: process.env.RATIO_CHROMIUM_PATH, args: ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage', '--disable-gpu'] } : {} },
  webServer: {
    command: `node --import tsx tests/engagement/setup.ts ${out} && node node_modules/next/dist/bin/next start -p ${port} --hostname localhost`,
    url: `${baseURL}/api/auth/session`, reuseExistingServer: false, timeout: 120_000,
    env: { RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: path.resolve('fixtures/engagement/example/engagement.json'), RATIO_ENGAGEMENT_USERS: `${out}/users.json`,
      RATIO_ENGAGEMENT_ORIGIN: 'https://ratio.example.test', RATIO_ENGAGEMENT_STATE: `${out}/state/sessions.sqlite`, RATIO_TRUSTED_PROXY_HOPS: '0',
      RATIO_READER_DATABASE_URL: 'postgres://reader@127.0.0.1:1/ratio', RATIO_ENV: 'test', NEXT_TELEMETRY_DISABLED: '1', RATIO_TEST_NEXT_DIR: process.env.RATIO_TEST_NEXT_DIR ?? '.next' },
  },
});
