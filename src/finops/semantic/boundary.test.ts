// The semantic core is pure and importable from app and worker code: no pg, no fs, no server-only,
// no clock, no network, no worker-only managed module, no src/ingest, relative imports only (the
// worker build has no path aliases), and no float on money.
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DIR = __dirname;
const prod = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => path.join(DIR, f));
const specs = (f: string) => ts.preProcessFile(fs.readFileSync(f, 'utf8'), true, true).importedFiles.map((i) => i.fileName);

describe('finops semantic core boundary', () => {
  it('has the three modules plus the decimal helper, and imports only each other and the pure report-facts types', () => {
    expect(prod.map((f) => path.basename(f)).sort()).toEqual(['decimal.ts', 'query.ts', 'reconcile.ts', 'views.ts']);
    const all = prod.flatMap((f) => specs(f).map((s) => `${path.basename(f)} -> ${s}`));
    for (const line of all) expect(line).toMatch(/ -> \.\/(decimal|views|query)$| -> \.\.\/\.\.\/reports\/reportFacts$/);
  });

  it('uses no I/O, clock, network, dynamic code or float on money', () => {
    const banned = [/\bparseFloat\b/, /\bNumber\(/, /\.toFixed\(/, /Math\.round/, /\bDate\.now\b/, /new Date\(/, /\bfetch\(/, /\beval\(/, /new Function/, /process\.env/, /require\(/, /\bimport\(/, /server-only/, /from 'pg'/, /from 'fs'/];
    for (const f of prod) {
      const text = fs.readFileSync(f, 'utf8');
      for (const re of banned) expect(re.test(text), `${path.basename(f)} matches ${re}`).toBe(false);
      expect(text).not.toMatch(/cost_facts_published|ratio\.tenant_id|pg_auth_members/); // check:bundle reader markers
    }
  });

  it('the fixture is labeled SYNTHETIC and names no organization beyond invented BU-A/B/C labels', () => {
    const fx = fs.readFileSync(path.join(DIR, 'fixtures', 'syntheticAllocation.ts'), 'utf8');
    expect(fx.split('\n')[0]).toMatch(/^\/\/ SYNTHETIC test fixture/);
    expect(fx.match(/businessUnit: '([^']+)'/g)?.map((m) => m.slice(15, -1)).every((b) => /^BU-[ABC]$/.test(b))).toBe(true);
    expect(fx).not.toMatch(/Number\(|parseFloat/);
  });
});
