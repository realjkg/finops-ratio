import { defineConfig } from 'vitest/config';
import path from 'path';
import { requireTestDatabaseUrl } from './src/ingest/db/testing/requireTestDatabaseUrl';

// SERIAL phase of the DB suite (`npm run test:db` runs it after the parallel
// phase): *.serial.db.test.ts files that must COMMIT cluster-global state
// (e.g. a real LOGIN role with a dangerous attribute) which would make any
// concurrent migration in the cluster fail. One file at a time, nothing else
// of the suite running. Fails at config load when RATIO_TEST_DATABASE_URL is unset.
requireTestDatabaseUrl(process.env);

export default defineConfig({
  test: {
    environment: 'node',
    // Issue #62 D1: the DB suites ingest the SYNTHETIC fixture (ProviderName SyntheticCloud)
    // through the library; synthetic provider names need this explicit opt-in (default off),
    // which is accepted only with RATIO_ENV explicitly development or test (challenger L3).
    env: { RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1', RATIO_ENV: 'test' },
    // Slice 2: the local bootstrap's serial test lives next to scripts/local/bootstrap.mjs
    // (outside src/, whose import boundary forbids pg in non-island files).
    include: ['src/**/*.serial.db.test.ts', 'scripts/local/*.serial.db.test.ts'],
    // Serial files may need S3 too: same per-run prefix setup as the parallel phase.
    globalSetup: ['src/ingest/testing/s3GlobalSetup.ts'],
    // Backstop after each serial file: nothing dangerous may be left behind.
    setupFiles: ['src/ingest/testing/dangerousLoginBackstopSerialSetup.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/.claude/**', '**/dist/**', '**/dist-worker/**'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
