// The worker-only dependencies added in Slice 1 (@aws-sdk/*, csv-parse) must
// never be imported by pages/ or by src/ modules outside src/ingest, so they
// cannot leak into the Next.js bundles. Complements importBoundary.test.ts.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INGEST_DIR = path.join(REPO_ROOT, 'src', 'ingest');
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const FORBIDDEN = (spec: string) => spec.startsWith('@aws-sdk/') || spec === 'csv-parse' || spec.startsWith('csv-parse/');

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || path.resolve(abs) === path.resolve(INGEST_DIR)) continue;
      walk(abs, acc);
    } else if (SOURCE_EXT.test(entry.name)) acc.push(abs);
  }
  return acc;
}

describe('worker dependency boundary', () => {
  it('no file under pages/ or src/ (outside src/ingest) imports @aws-sdk/* or csv-parse', () => {
    const files = [...walk(path.join(REPO_ROOT, 'pages')), ...walk(path.join(REPO_ROOT, 'src'))];
    expect(files.length).toBeGreaterThan(50);
    const violations = files.flatMap((f) =>
      ts
        .preProcessFile(fs.readFileSync(f, 'utf8'), true, true)
        .importedFiles.filter((i) => FORBIDDEN(i.fileName))
        .map((i) => `${path.relative(REPO_ROOT, f)} -> ${i.fileName}`),
    );
    expect(violations).toEqual([]);
  });

  it('detector flags the forbidden specifiers (self-test)', () => {
    const code = `import { S3Client } from '@aws-sdk/client-s3';\nconst p = require('csv-parse');\nimport x from 'csv-parse/sync';\nimport ok from 'react';`;
    const hits = ts.preProcessFile(code, true, true).importedFiles.filter((i) => FORBIDDEN(i.fileName)).map((i) => i.fileName);
    expect(hits).toEqual(['@aws-sdk/client-s3', 'csv-parse', 'csv-parse/sync']);
  });
});
