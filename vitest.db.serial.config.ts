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
    include: ['src/**/*.serial.db.test.ts'],
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
