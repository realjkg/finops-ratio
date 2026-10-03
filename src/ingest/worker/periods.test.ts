// Period ranges (Copilot H2, third review). nextPeriod('9999-12-01') used to
// be '10000-01-01', which compares (as a string) BEFORE '9999-12-01': the
// string-compare loop never ended, synchronously. These run in a child process
// under a hard kill, so a regression fails the test instead of hanging it.
import path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MODULE = path.join(__dirname, 'periods.ts');

/** Evaluates `expr` (with `m` = the periods module) in a child; null when it had to be killed. */
function inChild(expr: string): { value?: unknown; error?: { code?: string; message: string } } | null {
  // tsx loads the module as CommonJS here: its exports arrive on `default`.
  const code = `const mod = await import(${JSON.stringify(MODULE)}); const m = mod.periodsBetween ? mod : mod.default;
try { process.stdout.write(JSON.stringify({ value: (${expr}) })); }
catch (e) { process.stdout.write(JSON.stringify({ error: { code: e.code, message: e.message } })); }`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });
  if (r.signal === 'SIGKILL') return null;
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('periodsBetween terminates and is bounded', () => {
  it('9999-12 alone, a range ending at 9999-12, a range across a year end', () => {
    expect(inChild(`m.periodsBetween('9999-12-01', '9999-12-01')`)).toEqual({ value: ['9999-12-01'] });
    expect(inChild(`m.periodsBetween('9999-10-01', '9999-12-01')`)).toEqual({ value: ['9999-10-01', '9999-11-01', '9999-12-01'] });
    expect(inChild(`m.periodsBetween('2026-11-01', '2027-02-01')`)).toEqual({ value: ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01'] });
  });

  it('inverted, out-of-bounds (before 2000-01, five-digit year) or malformed ranges are INVALID_RANGE', () => {
    for (const [from, to] of [
      ['2026-08-01', '2026-07-01'],
      ['1999-12-01', '2000-01-01'],
      ['9999-12-01', '10000-01-01'],
      ['2026-07-15', '2026-08-01'],
      ['2026-13-01', '2026-13-01'],
    ]) {
      const r = inChild(`m.periodsBetween(${JSON.stringify(from)}, ${JSON.stringify(to)})`);
      expect(r, `${from}..${to}`).toMatchObject({ error: { code: 'INVALID_RANGE' } });
    }
  });
});
