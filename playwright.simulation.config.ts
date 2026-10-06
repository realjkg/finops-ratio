import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const port = Number(process.env.RATIO_TEST_PORT ?? 3110);
const baseURL = `http://127.0.0.1:${port}`;
const run = randomUUID();
const built = process.env.RATIO_TEST_PRODUCTION !== '0';
const existingBuild = process.env.RATIO_TEST_SKIP_BUILD === '1';
export default defineConfig({
  testDir: './tests/simulation', fullyParallel: false, workers: 1, timeout: 180_000,
  expect: { timeout: 20_000 }, reporter: [['list']], outputDir: `.simulation-test-results/browser-${port}`,
  use: { baseURL, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: process.env.RATIO_CHROMIUM_PATH ? { executablePath: process.env.RATIO_CHROMIUM_PATH, args: ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage', '--disable-gpu'] } : {},
  },
  webServer: {
    command: built ? `${existingBuild ? '' : 'npm run build && '}node node_modules/next/dist/bin/next start -p ${port} --hostname 127.0.0.1` : 'node scripts/simulation/start.mjs', url: `${baseURL}/api/v1/simulation/session`, reuseExistingServer: false, timeout: 180_000,
    env: { PORT: String(port), RATIO_SIMULATION_ORIGIN: baseURL, RATIO_ENV: 'test', RATIO_SIMULATION: '1', RATIO_TEST_NEXT_DIR: process.env.RATIO_TEST_NEXT_DIR ?? `.next-simulation-${port}`, RATIO_SIMULATION_DB: `.simulation-test-results/${run}.sqlite`, NEXT_TELEMETRY_DISABLED: '1' },
  },
});
