// The value-model engine is pure and has no float on money: no I/O, clock, network, dynamic code or parseFloat.
// Only digest.ts touches node:crypto. The draft contracts stay out of the stable platform contract list.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSIONS } from '../platform/contracts/versions';

const DIR = __dirname;
const prod = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('value model boundary', () => {
  it('uses no I/O, clock, network, dynamic code or float on money', () => {
    const banned = [/\bparseFloat\b/, /\bNumber\(/, /\.toFixed\(/, /Math\.round/, /\bDate\.now\b/, /new Date\(/, /\bfetch\(/, /\beval\(/, /new Function/, /process\.env/, /require\(/, /\bimport\(/, /from 'pg'/, /from 'fs'/];
    for (const f of prod) {
      const text = fs.readFileSync(path.join(DIR, f), 'utf8');
      for (const re of banned) expect(re.test(text), `${f} matches ${re}`).toBe(false);
      if (f !== 'digest.ts') expect(text, f).not.toMatch(/node:crypto/);
    }
  });

  it('keeps its draft schemas out of the stable platform contracts', () => {
    for (const v of ['kpi-definition/0-draft', 'kpi-result/0-draft', 'value-case/0-draft', 'value-ratio-snapshot/0-draft']) {
      expect((SCHEMA_VERSIONS as readonly string[]).includes(v)).toBe(false);
    }
  });
});
