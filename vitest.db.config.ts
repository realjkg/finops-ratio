import { defineConfig } from 'vitest/config';
import path from 'path';
import { requireTestDatabaseUrl } from './src/ingest/db/testing/requireTestDatabaseUrl';

// DB integration suite: only *.db.test.ts, run by `npm run test:db`.
// Fails at config load (non-zero exit) when RATIO_TEST_DATABASE_URL is unset.
requireTestDatabaseUrl(process.env);

export default defineConfig({
  test: {
    environment: 'node',
    // Issue #62 D1: the DB suites ingest the SYNTHETIC fixture (ProviderName SyntheticCloud)
    // through the library; synthetic provider names need this explicit opt-in (default off),
    // which is accepted only with RATIO_ENV explicitly development or test (challenger L3).
    env: { RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1', RATIO_ENV: 'test' },
    include: ['src/**/*.db.test.ts'],
    // One shared S3 bucket per run (created/deleted here) when RATIO_TEST_S3_ENDPOINT is set.
    globalSetup: ['src/ingest/testing/s3GlobalSetup.ts'],
    // Runtime backstop: fails a file whose process leaves a dangerous ratio_test_* login (serial files excluded).
    setupFiles: ['src/ingest/testing/dangerousLoginBackstopSetup.ts'],
    // *.serial.db.test.ts run afterwards, alone (vitest.db.serial.config.ts).
    exclude: ['**/node_modules/**', '**/.next/**', '**/.claude/**', '**/dist/**', '**/dist-worker/**', '**/*.serial.db.test.ts'],
    // Each test file (and each migration test case) creates, migrates and
    // drops a real database; that setup is part of the measured test time.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
