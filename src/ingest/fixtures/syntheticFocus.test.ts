import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { parse } from 'csv-parse/sync';
import { COMMITTED_VARIANTS, FIXTURE_LOCATION, generateSyntheticExport, type FixtureVariant } from './syntheticFocus';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'focus-1.0-synthetic');

/**
 * Exact decimal sum with BigInt (test-side ground truth, no floats), printed
 * with exactly 10 decimal places — the scale every fixture amount carries, and
 * therefore the scale Postgres' sum(numeric) prints.
 */
function decimalSum(values: string[]): string {
  const SCALE = 10;
  let acc = BigInt(0);
  for (const v of values) {
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(v);
    if (!m) throw new Error(`not a plain decimal: ${v}`);
    if ((m[3] ?? '').length > SCALE) throw new Error(`more than ${SCALE} decimals: ${v}`);
    const frac = (m[3] ?? '').padEnd(SCALE, '0');
    const n = BigInt((m[2] || '0') + frac);
    acc += m[1] === '-' ? -n : n;
  }
  const neg = acc < BigInt(0);
  const s = (neg ? -acc : acc).toString().padStart(SCALE + 1, '0');
  const int = s.slice(0, -SCALE);
  return (neg ? '-' : '') + int + '.' + s.slice(-SCALE);
}

function rowsOf(exp: ReturnType<typeof generateSyntheticExport>, period: string): Array<Record<string, string>> {
  const ym = period.slice(0, 7);
  const manifestKey = Object.keys(exp.manifestsByKey).find((k) => k.includes(`BILLING_PERIOD=${ym}/`))!;
  const manifest = JSON.parse(exp.manifestsByKey[manifestKey]) as { dataFiles: string[] };
  return manifest.dataFiles.flatMap((k) => parse(exp.csvByKey[k], { columns: true }) as Array<Record<string, string>>);
}

const ALL: FixtureVariant[] = ['base', 'restatement', 'variance', 'corrupt', 'nocontrol'];

describe('synthetic FOCUS 1.0 fixture generator', () => {
  it('is deterministic', () => {
    for (const v of ALL) {
      const a = generateSyntheticExport({ variant: v });
      const b = generateSyntheticExport({ variant: v });
      expect(a.csvByKey).toEqual(b.csvByKey);
      expect(a.manifestsByKey).toEqual(b.manifestsByKey);
      expect(a.totals).toEqual(b.totals);
    }
  });

  it('uses the AWS Data Exports layout under the given prefix/export name', () => {
    const exp = generateSyntheticExport({ variant: 'base', prefix: 'p/q', exportName: 'my-export' });
    for (const o of exp.objects) {
      expect(o.key).toMatch(/^p\/q\/my-export\/(data\/BILLING_PERIOD=\d{4}-\d{2}\/[^/]+\/my-export-\d{5}\.csv\.gz|metadata\/BILLING_PERIOD=\d{4}-\d{2}\/my-export-Manifest\.json)$/);
    }
    expect(FIXTURE_LOCATION).toEqual({ prefix: 'ratio-synthetic', exportName: 'focus-export' });
  });

  it('control totals are the exact decimal sums of the generated rows', () => {
    for (const v of ['base', 'restatement'] as const) {
      const exp = generateSyntheticExport({ variant: v });
      for (const [period, t] of Object.entries(exp.totals)) {
        const rows = rowsOf(exp, period);
        expect(rows.length, `${v} ${period}`).toBe(t.rowCount);
        expect(decimalSum(rows.map((r) => r.BilledCost)), `${v} ${period}`).toBe(t.billedTotal);
      }
    }
  });

  it('base contains duplicate legitimate rows within a file and across files', () => {
    const exp = generateSyntheticExport({ variant: 'base' });
    const manifestKey = Object.keys(exp.manifestsByKey).find((k) => k.includes('BILLING_PERIOD=2026-07/'))!;
    const files = (JSON.parse(exp.manifestsByKey[manifestKey]) as { dataFiles: string[] }).dataFiles;
    expect(files.length).toBe(2);
    const lines = files.map((k) => exp.csvByKey[k].trim().split('\n').slice(1));
    const dupWithin = lines[0].filter((l, i) => lines[0].indexOf(l) !== i);
    expect(dupWithin.length).toBeGreaterThanOrEqual(1);
    expect(lines[1].some((l) => lines[0].includes(l))).toBe(true);
  });

  it('restatement re-exports 2026-07 under a new run with different totals; 2026-08 unchanged', () => {
    const base = generateSyntheticExport({ variant: 'base' });
    const rest = generateSyntheticExport({ variant: 'restatement' });
    expect(rest.totals['2026-07-01']).not.toEqual(base.totals['2026-07-01']);
    expect(rest.totals['2026-08-01']).toEqual(base.totals['2026-08-01']);
    const runOf = (e: typeof base, ym: string) =>
      Object.keys(e.csvByKey)
        .filter((k) => k.includes(`BILLING_PERIOD=${ym}/`))
        .map((k) => k.split('/').slice(-2, -1)[0]);
    expect(new Set(runOf(rest, '2026-07'))).not.toEqual(new Set(runOf(base, '2026-07')));
    const aug = (e: typeof base) => Object.fromEntries(Object.entries(e.csvByKey).filter(([k]) => k.includes('BILLING_PERIOD=2026-08/')));
    expect(aug(rest)).toEqual(aug(base));
  });

  it('manifests carry control totals (base/restatement), a wrong one (variance), none (nocontrol)', () => {
    for (const v of ['base', 'restatement'] as const) {
      const exp = generateSyntheticExport({ variant: v });
      for (const [k, text] of Object.entries(exp.manifestsByKey)) {
        const m = JSON.parse(text);
        const period = /BILLING_PERIOD=(\d{4}-\d{2})/.exec(k)![1] + '-01';
        expect(m['x-ratio-control']).toEqual({ rowCount: exp.totals[period].rowCount, billedTotal: exp.totals[period].billedTotal });
        expect(m.billingPeriod.start).toBe(`${period}T00:00:00.000Z`);
      }
    }
    const variance = generateSyntheticExport({ variant: 'variance' });
    const base = generateSyntheticExport({ variant: 'base' });
    const vAug = JSON.parse(Object.entries(variance.manifestsByKey).find(([k]) => k.includes('2026-08'))![1]);
    expect(vAug['x-ratio-control']).toEqual({ rowCount: base.totals['2026-08-01'].rowCount, billedTotal: base.totals['2026-08-01'].billedTotal });
    expect(rowsOf(variance, '2026-08-01').length).not.toBe(base.totals['2026-08-01'].rowCount);
    for (const text of Object.values(generateSyntheticExport({ variant: 'nocontrol' }).manifestsByKey)) {
      expect(JSON.parse(text)['x-ratio-control']).toBeUndefined();
    }
    const corrupt = generateSyntheticExport({ variant: 'corrupt' });
    expect(rowsOf(corrupt, '2026-08-01').some((r) => !/^-?\d+(\.\d+)?$/.test(r.BilledCost))).toBe(true);
  });

  it('every row is labelled synthetic (never presented as a real provider)', () => {
    for (const v of ALL) {
      const exp = generateSyntheticExport({ variant: v });
      for (const text of Object.values(exp.csvByKey)) {
        const rows = parse(text, { columns: true }) as Array<Record<string, string>>;
        for (const r of rows) {
          expect(r.ProviderName).toBe('SyntheticCloud');
          expect(r.InvoiceIssuerName).toBe('SyntheticCloud');
        }
      }
    }
  });

  it('the committed fixture equals the generator output and its README/control-totals match', () => {
    expect(COMMITTED_VARIANTS).toEqual(['base', 'restatement']);
    const committedTotals = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'control-totals.json'), 'utf8'));
    const readme = fs.readFileSync(path.join(FIXTURE_DIR, 'README.md'), 'utf8');
    expect(readme).toMatch(/SYNTHETIC/);
    for (const v of COMMITTED_VARIANTS) {
      const exp = generateSyntheticExport({ variant: v });
      const dir = path.join(FIXTURE_DIR, v);
      const onDisk: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else onDisk.push(path.relative(dir, p).split(path.sep).join('/'));
        }
      };
      walk(dir);
      expect(onDisk.sort()).toEqual(exp.objects.map((o) => o.key).sort());
      for (const o of exp.objects) {
        const bytes = fs.readFileSync(path.join(dir, o.key));
        if (o.key.endsWith('.gz')) expect(zlib.gunzipSync(bytes).toString('utf8')).toBe(exp.csvByKey[o.key]);
        else expect(bytes.toString('utf8')).toBe(exp.manifestsByKey[o.key]);
      }
      expect(committedTotals[v]).toEqual(exp.totals);
      for (const [period, t] of Object.entries(exp.totals)) {
        expect(readme, `${v} ${period}`).toContain(t.billedTotal);
        expect(readme, `${v} ${period}`).toContain(`${period.slice(0, 7)}`);
        expect(readme).toContain(String(t.rowCount));
      }
    }
  });
});
