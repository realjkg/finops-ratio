import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // tsconfig sets jsx:'preserve' for Next.js, which Vite's esbuild inherits and
  // then chokes on for the report PDF's .tsx. plugin-react owns the JSX transform
  // under the test runner (automatic runtime), independent of tsconfig. Next's
  // own production build is untouched.
  plugins: [react()],
  test: {
    environment: 'node',
    // Never scan Next.js build output (a prior build may have emitted compiled
    // route files that would otherwise be mistaken for test suites).
    // *.db.test.ts need Postgres and run only via `npm run test:db`.
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/dist-worker/**', '**/*.db.test.ts'],
  },
  resolve: {
    alias: {
      // Mirror tsconfig.json paths so test imports of '@/...' resolve correctly.
      '@': path.resolve(__dirname, './src'),
    },
  },
});

