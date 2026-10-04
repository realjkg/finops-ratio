// Import boundary: server-only ingestion code (src/ingest) and the Postgres
// driver (pg) must never be reachable from pages/ or from any other src/
// module, otherwise they could end up in the Next.js client/server bundles.
//
// Slice 2 adds ONE reviewed exception, a server-only island:
//   - src/server/costs/** (the published-costs read API) may import `pg` and
//     exactly the Slice 0/1 modules it reuses (READER_ALLOWED_INGEST);
//   - only pages/api/v1/costs/published.ts may import src/server/costs;
//   - the route's transitive import closure reaches no worker-only code.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INGEST_DIR = path.join(REPO_ROOT, 'src', 'ingest');
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

interface Violation {
  file: string;
  specifier: string;
}

function isPgSpecifier(spec: string): boolean {
  return spec === 'pg' || spec.startsWith('pg/') || spec.startsWith('pg-');
}

function resolvesIntoIngest(fileAbs: string, spec: string): boolean {
  const s = spec.replace(/\\/g, '/');
  if (s === '@/ingest' || s.startsWith('@/ingest/')) return true;
  if (s === 'src/ingest' || s.startsWith('src/ingest/')) return true;
  if (s.startsWith('.')) {
    const target = path.resolve(path.dirname(fileAbs), s);
    const rel = path.relative(INGEST_DIR, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
  return false;
}

const COSTS_DIR = path.join(REPO_ROOT, 'src', 'server', 'costs');
const COSTS_ROUTE = path.join(REPO_ROOT, 'pages', 'api', 'v1', 'costs', 'published.ts');

/** The only src/ingest modules the read API may import (reuse, never copies). */
const READER_ALLOWED_INGEST = ['db/tenant', 'worker/db', 'db/privilegeModel'];

function inside(dir: string, fileAbs: string): boolean {
  const rel = path.relative(dir, fileAbs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The src/ingest-relative module a specifier names ('' for src/ingest itself), or null. */
function ingestModule(fileAbs: string, spec: string): string | null {
  const s = spec.replace(/\\/g, '/');
  if (s === '@/ingest' || s.startsWith('@/ingest/')) return s.slice('@/ingest'.length).replace(/^\//, '');
  if (s === 'src/ingest' || s.startsWith('src/ingest/')) return s.slice('src/ingest'.length).replace(/^\//, '');
  if (s.startsWith('.')) {
    const target = path.resolve(path.dirname(fileAbs), s);
    if (inside(INGEST_DIR, target)) return path.relative(INGEST_DIR, target).split(path.sep).join('/');
  }
  return null;
}

function resolvesIntoCosts(fileAbs: string, spec: string): boolean {
  const s = spec.replace(/\\/g, '/');
  if (s === '@/server/costs' || s.startsWith('@/server/costs/')) return true;
  if (s === 'src/server/costs' || s.startsWith('src/server/costs/')) return true;
  if (s.startsWith('.')) return inside(COSTS_DIR, path.resolve(path.dirname(fileAbs), s));
  return false;
}

function findForbiddenImports(fileAbs: string, source: string): Violation[] {
  const info = ts.preProcessFile(source, true, true);
  const out: Violation[] = [];
  const inCosts = inside(COSTS_DIR, fileAbs);
  // The island's own *.test.ts files (never reachable from pages/) seed data
  // through the Slice 0/1 test harness and worker library.
  const costsTest = inCosts && /\.test\.tsx?$/.test(fileAbs);
  for (const imp of info.importedFiles) {
    const spec = imp.fileName;
    const ingest = ingestModule(fileAbs, spec);
    const allowed = costsTest || (inCosts && (spec === 'pg' || (ingest !== null && READER_ALLOWED_INGEST.includes(ingest))));
    if (!allowed && (isPgSpecifier(spec) || resolvesIntoIngest(fileAbs, spec))) {
      out.push({ file: path.relative(REPO_ROOT, fileAbs), specifier: spec });
    }
    // Only the route file (and the island itself) may import src/server/costs.
    if (!inCosts && path.resolve(fileAbs) !== COSTS_ROUTE && resolvesIntoCosts(fileAbs, spec)) {
      out.push({ file: path.relative(REPO_ROOT, fileAbs), specifier: spec });
    }
  }
  return out;
}

/** Resolves a local specifier to a file (alias @/ → src/, relative), or null for a package. */
function resolveLocal(fromAbs: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(REPO_ROOT, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromAbs), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  throw new Error(`unresolvable local import ${spec} in ${path.relative(REPO_ROOT, fromAbs)}`);
}

/** Every local file and every package specifier reachable from `entry` (static, dynamic and require imports). */
function importClosure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop() as string;
    if (files.has(f)) continue;
    files.add(f);
    for (const imp of ts.preProcessFile(fs.readFileSync(f, 'utf8'), true, true).importedFiles) {
      const local = resolveLocal(f, imp.fileName);
      if (local) todo.push(local);
      else packages.add(imp.fileName);
    }
  }
  return { files, packages };
}

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      if (path.resolve(abs) === path.resolve(INGEST_DIR)) continue;
      walk(abs, acc);
    } else if (SOURCE_EXT.test(entry.name)) {
      acc.push(abs);
    }
  }
  return acc;
}

describe('src/ingest import boundary', () => {
  it('no file under pages/ or src/ (outside src/ingest) imports src/ingest or pg (except the reviewed read-API island)', () => {
    const files = [
      ...walk(path.join(REPO_ROOT, 'pages')),
      ...walk(path.join(REPO_ROOT, 'src')),
    ];
    // Sanity: the scan actually covers the app (guards against a vacuous pass).
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.includes(`${path.sep}pages${path.sep}`))).toBe(true);
    expect(files.some((f) => f.startsWith(INGEST_DIR))).toBe(false);

    const violations = files.flatMap((f) => findForbiddenImports(f, fs.readFileSync(f, 'utf8')));
    expect(violations).toEqual([]);
  });

  it('detector flags every import form of src/ingest and pg (self-test)', () => {
    const pageFile = path.join(REPO_ROOT, 'pages', 'api', 'fake.ts');
    const srcFile = path.join(REPO_ROOT, 'src', 'lib', 'fake.ts');
    const cases: Array<[string, string, string]> = [
      [pageFile, `import { Pool } from 'pg';`, 'pg'],
      [pageFile, `import type { PoolClient } from 'pg';`, 'pg'],
      [pageFile, `const pg = require('pg');`, 'pg'],
      [pageFile, `const m = await import('pg');`, 'pg'],
      [pageFile, `import Cursor from 'pg-cursor';`, 'pg-cursor'],
      [pageFile, `import x from 'pg/lib/client';`, 'pg/lib/client'],
      [pageFile, `import { migrateUp } from '@/ingest/db/migrate';`, '@/ingest/db/migrate'],
      [pageFile, `export { migrateUp } from '@/ingest/db/migrate';`, '@/ingest/db/migrate'],
      [pageFile, `import '@/ingest';`, '@/ingest'],
      [pageFile, `import x from 'src/ingest/cli';`, 'src/ingest/cli'],
      [pageFile, `import x from '../../src/ingest/db/tenant';`, '../../src/ingest/db/tenant'],
      [srcFile, `import x from '../ingest/db/migrate';`, '../ingest/db/migrate'],
      [srcFile, `import x from '../ingest';`, '../ingest'],
      [srcFile, `const t = import(\n  '../ingest/cli'\n);`, '../ingest/cli'],
      [srcFile, `import {\n  a,\n  b,\n} from '@/ingest/db/tenant';`, '@/ingest/db/tenant'],
    ];
    for (const [file, code, spec] of cases) {
      expect(findForbiddenImports(file, code).map((v) => v.specifier), code).toEqual([spec]);
    }
  });

  it('the read-API island exceptions are exact (self-test)', () => {
    const costsFile = path.join(COSTS_DIR, 'fake.ts');
    const otherPage = path.join(REPO_ROOT, 'pages', 'api', 'v1', 'other.ts');
    const flagged = (file: string, code: string) => findForbiddenImports(file, code).map((v) => v.specifier);
    // Allowed inside src/server/costs: pg and the three reused modules (alias or relative).
    expect(flagged(costsFile, `import { Pool } from 'pg';`)).toEqual([]);
    expect(flagged(costsFile, `import { withTenantTransaction } from '@/ingest/db/tenant';`)).toEqual([]);
    expect(flagged(costsFile, `import { inspectRole } from '../../ingest/worker/db';`)).toEqual([]);
    expect(flagged(costsFile, `import type { X } from '@/ingest/db/privilegeModel';`)).toEqual([]);
    // Everything else from src/ingest stays forbidden there, and pg subpaths too.
    for (const spec of ['@/ingest/cli', '@/ingest/worker/pipeline', '@/ingest/db/migrate', '../../ingest/sources/s3/S3FocusExportSource', '@/ingest', 'pg/lib/client', 'pg-cursor']) {
      expect(flagged(costsFile, `import x from '${spec}';`), spec).toEqual([spec]);
    }
    // The island's test files may use the test harness; its non-test files may not.
    expect(flagged(path.join(COSTS_DIR, 'x.db.test.ts'), `import { createTestDatabase } from '../../ingest/db/testing/harness';`)).toEqual([]);
    expect(flagged(path.join(COSTS_DIR, 'testing', 'http.ts'), `import x from '../../../ingest/db/testing/harness';`)).toEqual(['../../../ingest/db/testing/harness']);
    // Only the route file may import the island.
    expect(flagged(COSTS_ROUTE, `import { createPublishedCostsRoute } from '@/server/costs/publishedCostsRoute';`)).toEqual([]);
    expect(flagged(otherPage, `import { readerPool } from '@/server/costs/readerPool';`)).toEqual(['@/server/costs/readerPool']);
    expect(flagged(path.join(REPO_ROOT, 'src', 'components', 'X.tsx'), `import x from '../server/costs';`)).toEqual(['../server/costs']);
    // The route file itself may not reach pg or src/ingest directly.
    expect(flagged(COSTS_ROUTE, `import { Pool } from 'pg';`)).toEqual(['pg']);
    expect(flagged(COSTS_ROUTE, `import x from '@/ingest/db/tenant';`)).toEqual(['@/ingest/db/tenant']);
  });

  it("the route's import closure reuses Slice 0/1 and reaches no worker-only code", () => {
    expect(fs.existsSync(COSTS_ROUTE)).toBe(true);
    const { files, packages } = importClosure(COSTS_ROUTE);
    const rel = [...files].map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'));
    // Reuse, not copies: Slice 0's tenant transaction and refused-role list, Slice 1's role check.
    for (const reused of ['src/ingest/db/tenant.ts', 'src/ingest/worker/db.ts', 'src/ingest/db/privilegeModel.ts']) expect(rel).toContain(reused);
    // No worker pipeline, source, evidence, S3, CLI, migration runner or test code.
    const forbidden = /^src\/ingest\/(worker\/(pipeline|capture|load|publish|lease|replay|quarantine|doctor|sourceFactory)|sources\/|evidence\/|s3client|cli|workerCli|db\/migrate\.ts|(.*\/)?testing\/)/;
    expect(rel.filter((f) => forbidden.test(f))).toEqual([]);
    expect(rel.filter((f) => /(^|\/)testing\//.test(f))).toEqual([]);
    expect([...packages].filter((p) => p.startsWith('@aws-sdk/') || p === 'csv-parse' || p.startsWith('csv-parse/'))).toEqual([]);
  });

  it('instrumentation.ts (Next startup hook) reaches only the pure costs config and Slice 0’s isTenantId: no runtime pg', () => {
    const instrumentation = path.join(REPO_ROOT, 'instrumentation.ts');
    expect(fs.existsSync(instrumentation)).toBe(true);
    const { files, packages } = importClosure(instrumentation);
    const rel = [...files].map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/')).sort();
    expect(rel).toEqual(['instrumentation.ts', 'src/ingest/db/tenant.ts', 'src/server/costs/config.ts']);
    expect([...packages].filter((p) => p.startsWith('@aws-sdk/') || p.startsWith('csv-parse'))).toEqual([]);
    // tenant.ts names pg in a TYPE-ONLY import (erased at build); no file in the closure imports pg as a value.
    for (const f of files) {
      const pgImports = fs.readFileSync(f, 'utf8').split('\n').filter((l) => /from\s+'pg'|require\('pg'\)|import\('pg'\)/.test(l));
      for (const l of pgImports) expect(l, path.relative(REPO_ROOT, f)).toMatch(/^import type /);
    }
  });

  it('detector ignores unrelated imports (self-test)', () => {
    const srcFile = path.join(REPO_ROOT, 'src', 'lib', 'fake.ts');
    const code = [
      `import React from 'react';`,
      `import { x } from '@/lib/format';`,
      `import y from './ingestion-notes';`,
      `import z from '../ingestor';`,
      `import pgp from 'pgp-lite';`,
      `// import { Pool } from 'pg';`,
      `const s = "import x from 'pg'";`,
    ].join('\n');
    expect(findForbiddenImports(srcFile, code)).toEqual([]);
  });
});
