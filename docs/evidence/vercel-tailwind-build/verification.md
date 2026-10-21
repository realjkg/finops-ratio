# Vercel Tailwind dependency repair

Failing source: `df797f252f8df2d30e456898c6c16a82250c71de` (PR #129).
Vercel deployment: `dpl_3YiZh7vDMruXMAtekGc9iFVwZdaW`.

The security dependency update upgraded Tailwind from v3 to v4 without migrating
PostCSS, the CSS directives, the theme configuration, or the compiler tests.
Vercel and local TypeScript both rejected the existing `tailwind(config)` calls
in `ThemeMenu.test.tsx` and `tokens.test.ts` (TS2769 and TS2554).

Keep the v3 compiler API with Tailwind `^3.4.19`, and override its transitive
`postcss-selector-parser` to exactly `7.1.7`. This addresses the parser advisory
GHSA-rj75-hqrm-r3gf (patched in 7.1.6) without an unrelated CSS framework migration.
No test assertion, TypeScript check, or build gate is disabled.

Local validation (Node 24.19.0, Next 16.3.8):

- Clean `npm ci` completed with the repaired lockfile.
- The theme and layout suites passed: 131 tests across eight files. These include
  actual PostCSS compilation, variable colors, opacity modifiers, and focus rings.
- `RATIO_TEST_NEXT_DIR=.next-vercel-repair npm run build` completed, including
  TypeScript, optimized compilation, page generation and server tracing.
- The unchanged `checkNextBundle` exported validator inspected that same build:
  136 client files, 130 server files, no problems. The CLI defaults to `.next`
  regardless of `RATIO_TEST_NEXT_DIR`; scanning that old directory was rejected
  by its non-vacuity checks before the explicit-directory scan passed.
- The first build using the old default cache failed loading Turbopack persistence;
  the fresh directory build above establishes the repaired source compiles.
- npm audit no longer reports the selector parser advisory. Other pre-existing
  development dependency advisories remain (braces dependency chain and Vite).
  This repair does not certify the entire dependency graph or production readiness.

The Node engines, cache-dir and install-script log entries were warnings, not
this deployment's failure. Hosted Vercel acceptance must be checked on the new
commit; local checks do not establish a successful hosted deployment.
