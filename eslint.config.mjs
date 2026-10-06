// ESLint flat config (ESLint v10+, react-hooks v7, typescript-eslint v8).
// Equivalent to the old .eslintrc.cjs rules, using the flat config API.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // Ignore build output and JS config files.
  {
    ignores: [
      'dist/**',
      'dist-worker/**',
      '.next/**',
      '.next-simulation-*/**',
      '.next-verified/**',
      '.simulation-test-results/**',
      'eslint.config.js',
      '.eslintrc.cjs',   // legacy config file, not linted
      'next.config.js',
      'next-env.d.ts',   // Next.js generated, not linted
      'postcss.config.js',
      'tailwind.config.js',
      'vitest.config.ts',
    ],
  },
  // Base: eslint:recommended
  js.configs.recommended,
  // TypeScript: @typescript-eslint/recommended
  ...tseslint.configs.recommended,
  // React hooks: register plugin + the two stable rules only.
  // We skip 'recommended-latest' which pulls in 15+ React-Compiler rules
  // not relevant to this codebase (no React Compiler usage).
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // Project-level overrides.
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // typescript-eslint v8 introduced this rule; disable it to avoid flagging
      // pre-existing error-chaining patterns in the live client seams.
      'preserve-caught-error': 'off',
    },
  },
);

