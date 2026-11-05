// Migration number ledger guard (ADR-0001 §12). The runner refuses a pending migration older than the newest applied
// one (OUT_OF_ORDER, migrate.ts), so a migration may land only when every lower number is merged, released or retired.
// This test fails a change that adds a migration out of ledger order, or a migration the ledger does not reserve.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR } from './migrationFiles';

type Status = 'merged' | 'reserved' | 'released' | 'retired';
interface Entry { number?: string; from?: string; to?: string; name?: string; line: string; status: Status; owner?: string }
interface Slot { number: string; name?: string; line: string; status: Status }
const LINE_ORDER = ['1.0', '1.1', '1.2', '1.3', '2.0', 'platform'];

function expand(entries: Entry[]): Slot[] {
  return entries.flatMap((e) => {
    if (e.number) return [{ number: e.number, name: e.name, line: e.line, status: e.status }];
    const out: Slot[] = [];
    for (let n = parseInt(e.from!, 10); n <= parseInt(e.to!, 10); n++) out.push({ number: String(n).padStart(4, '0'), line: e.line, status: e.status });
    return out;
  });
}

/** Every problem with the ledger against the migration files present (`number_name`). */
function ledgerProblems(entries: Entry[], files: string[]): string[] {
  const p: string[] = [];
  const slots = expand(entries);
  const byNumber = new Map(slots.map((s) => [s.number, s]));
  if (byNumber.size !== slots.length) p.push('a number appears twice in the ledger');
  slots.forEach((s, i) => {
    if (!/^\d{4}$/.test(s.number) || !['merged', 'reserved', 'released', 'retired'].includes(s.status)) p.push(`${s.number}: malformed entry`);
    if (i > 0 && s.number <= slots[i - 1].number) p.push(`${s.number}: ledger not in ascending order`);
    if (i > 0 && LINE_ORDER.indexOf(s.line) < LINE_ORDER.indexOf(slots[i - 1].line)) p.push(`${s.number}: line ${s.line} after a later line`);
  });
  const present = new Map(files.map((f) => [f.slice(0, 4), f.slice(5)]));
  for (const [n, name] of present) {
    const s = byNumber.get(n);
    if (!s) p.push(`${n}_${name}: not in the ledger`);
    else if (s.status !== 'merged' || s.name !== name) p.push(`${n}_${name}: ledger says ${s.status}${s.name ? ` ${s.name}` : ''}`);
    for (const lower of slots) if (lower.number < n && lower.status === 'reserved') p.push(`${n}_${name}: lower number ${lower.number} is still reserved`);
  }
  for (const s of slots) if (s.status === 'merged' && !present.has(s.number)) p.push(`${s.number}: merged in the ledger but no file`);
  return [...new Set(p)];
}

const LEDGER = path.resolve(__dirname, '..', '..', '..', 'docs', 'migrations', 'ledger.json');
const entries = (): Entry[] => JSON.parse(fs.readFileSync(LEDGER, 'utf8')).entries;
const files = () => [...new Set(fs.readdirSync(DEFAULT_MIGRATIONS_DIR).map((f) => /^(\d{4}_[a-z0-9_]+)\.up\.sql$/.exec(f)?.[1]).filter((x): x is string => !!x))].sort();

describe('migration ledger', () => {
  it('the repository ledger matches the migrations directory', () => {
    expect(files()).toEqual(['0001_ratio_schema', '0002_cost_attribution', '0004_outcome_ledger']);
    expect(ledgerProblems(entries(), files())).toEqual([]);
  });
  it('a platform migration cannot land while a 1.0 number below it is still reserved', () => {
    expect(ledgerProblems(entries(), [...files(), '0020_platform_connections'])).toEqual([
      '0020_platform_connections: ledger says reserved',
      ...['0005', '0006', ...Array.from({ length: 13 }, (_, i) => String(7 + i).padStart(4, '0'))].map((n) => `0020_platform_connections: lower number ${n} is still reserved`),
    ]);
  });
  it('it can land once the lower numbers are merged or released and its own entry is merged', () => {
    const e = entries().map((x) => (x.number && x.number >= '0005' && x.number <= '0006') || x.from === '0007' ? { ...x, status: 'released' as const } : x)
      .map((x) => (x.number === '0020' ? { ...x, status: 'merged' as const, name: 'platform_connections' } : x));
    expect(ledgerProblems(e, [...files(), '0020_platform_connections'])).toEqual([]);
  });
  it('an unreserved number, a merged entry without a file, a duplicate or a reordered line is refused', () => {
    expect(ledgerProblems(entries(), [...files(), '0040_extra'])).toContain('0040_extra: not in the ledger');
    expect(ledgerProblems([...entries().slice(0, 4), { number: '0004', name: 'outcome_ledger', line: '1.0', status: 'merged' }], files())).toContain('a number appears twice in the ledger');
    expect(ledgerProblems([{ number: '0001', name: 'ratio_schema', line: '1.1', status: 'merged' }, { number: '0002', name: 'cost_attribution', line: '1.0', status: 'merged' }], ['0001_ratio_schema', '0002_cost_attribution'])).toEqual(['0002: line 1.0 after a later line']);
    expect(ledgerProblems([{ number: '0001', line: '1.0', status: 'merged', name: 'x' }], [])).toEqual(['0001: merged in the ledger but no file']);
  });
});
