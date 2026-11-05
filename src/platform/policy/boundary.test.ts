// Module boundary of the policy evaluation library (ADR-0001 §5): pure, importable by a gateway plugin, app or worker.
// It imports only the platform contracts and itself, and has no I/O, clock, randomness, network, environment or
// dynamic code. The clock is an argument (EvaluationInput.clock).
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DIR = __dirname;
const prod = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();

describe('policy library boundary', () => {
  it('has exactly these modules, importing only each other and the contracts', () => {
    expect(prod).toEqual(['bundle.ts', 'context.ts', 'evaluate.ts', 'index.ts']);
    for (const f of prod) {
      for (const i of ts.preProcessFile(fs.readFileSync(path.join(DIR, f), 'utf8'), true, true).importedFiles) {
        expect(`${f} -> ${i.fileName}`).toMatch(/ -> \.\/(bundle|context|evaluate)$| -> \.\.\/contracts$/);
      }
    }
  });
  it('reads no clock, randomness, environment, network or file, and runs no dynamic code', () => {
    const banned = [/\bDate\b/, /performance\./, /process\./, /Math\.random/, /\bcrypto\b/, /\bfetch\(/, /\beval\(/, /new Function/, /require\(/, /\bimport\(/, /setTimeout|setInterval/, /from '(pg|fs|net|http|https|child_process)'/];
    for (const f of prod) {
      const text = fs.readFileSync(path.join(DIR, f), 'utf8');
      for (const re of banned) expect(re.test(text), `${f} matches ${re}`).toBe(false);
    }
  });
  it('the worker typecheck covers the library, and the fixtures are labeled SYNTHETIC', () => {
    expect(JSON.parse(fs.readFileSync(path.resolve(DIR, '../../../tsconfig.worker.json'), 'utf8')).include).toContain('src/platform/policy/*.ts');
    expect(fs.readFileSync(path.join(DIR, 'testing', 'fixtures.ts'), 'utf8').split('\n')[0]).toMatch(/^\/\/ SYNTHETIC test fixtures/);
  });
});
