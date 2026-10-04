// P2 (Slice 2b): the independent control-total calculator, run from `npm test`.
//
// The calculator is Python on purpose (DESIGN §4): another language and another
// code path than the worker (TypeScript + csv-parse), the staging converter
// (JavaScript) and Postgres. This file:
//   1. runs its Python unit tests (P1); exit 0 required;
//   2. runs it on the committed 1k sample file and requires its output to
//      equal the pinned fixtures/focus-1.0-sample/control-totals.json.
// python3 missing ⇒ these tests FAIL (never skip), like every other required
// tool in this repo's suites.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CALC = path.join(ROOT, 'scripts', 'acceptance', 'focus_control_totals.py');
const DATASET = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'focus-1.0-sample', 'dataset.json'), 'utf8'));
const PINNED = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'focus-1.0-sample', 'control-totals.json'), 'utf8'));

function python(args) {
  const r = spawnSync('python3', args, { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  if (r.error) throw new Error(`python3 could not be run (required by the acceptance tooling): ${r.error.message}`);
  return r;
}

describe('P2 independent control totals (Python)', () => {
  it('P1: the calculator’s own unit tests pass', () => {
    const r = python(['-m', 'unittest', 'discover', '-s', 'scripts/acceptance', '-p', 'test_*.py']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/\nOK\b/);
  }, 120_000);

  it('reproduces the pinned control totals of the committed 1k file exactly', () => {
    const pin = DATASET.files['1k'];
    const r = python([CALC, '--expect-sha256', pin.sha256, path.join(ROOT, pin.localPath)]);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.type).toBe('ratio.focus-control-totals');
    expect(doc.input).toEqual(PINNED['1k'].input);
    expect(doc.input).toEqual({ sha256: pin.sha256, bytes: pin.bytes, dataRows: pin.dataRows });
    expect(doc.totals).toEqual(PINNED['1k'].totals);
    // The unquoted SQL-null token, per column, as profiled in DESIGN §1.
    expect(doc.nullTokens.ChargeClass).toBe(1000);
    expect(doc.nullTokens.ContractedCost).toBe(7);
    expect(doc.nullTokens.ConsumedQuantity).toBe(1);
    expect(doc.nullTokens.BilledCost).toBeUndefined();
    expect(doc.nullTokens.EffectiveCost).toBeUndefined();
  }, 120_000);

  it('refuses a file whose SHA-256 is not the pinned one (exit 2, no output)', () => {
    const pin = DATASET.files['1k'];
    const r = python([CALC, '--expect-sha256', '0'.repeat(64), path.join(ROOT, pin.localPath)]);
    // Exit 2 alone is not enough: python3 also exits 2 when the script is missing.
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/SHA-256 mismatch/);
  }, 120_000);
});
