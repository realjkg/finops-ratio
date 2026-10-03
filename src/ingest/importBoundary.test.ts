// Import boundary: server-only ingestion code (src/ingest) and the Postgres
// driver (pg) must never be reachable from pages/ or from any other src/
// module, otherwise they could end up in the Next.js client/server bundles.
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

function findForbiddenImports(fileAbs: string, source: string): Violation[] {
  const info = ts.preProcessFile(source, true, true);
  const out: Violation[] = [];
  for (const imp of info.importedFiles) {
    const spec = imp.fileName;
    if (isPgSpecifier(spec) || resolvesIntoIngest(fileAbs, spec)) {
      out.push({ file: path.relative(REPO_ROOT, fileAbs), specifier: spec });
    }
  }
  return out;
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
  it('no file under pages/ or src/ (outside src/ingest) imports src/ingest or pg', () => {
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
