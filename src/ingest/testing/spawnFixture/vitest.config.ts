// Config for the spawn-cleanup fixture only (run by cli.spawnCleanup.test.ts).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: __dirname,
    include: ['orphan.fixture.ts'],
    environment: 'node',
  },
});
