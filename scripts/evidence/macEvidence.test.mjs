// mac-evidence.sh: argument parsing, exit codes and the dry-run plan (preflight + plan, nothing cloned,
// started or written). The real Mac run (clone, Docker, Playwright download) is not executed here.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mac-evidence.sh');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-evidence-test-'));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
const sh = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, RATIO_EVIDENCE_HOME: path.join(home, 'out') } });

describe('mac-evidence.sh', () => {
  it('is valid bash with no bash 4 or GNU-only constructs (macOS ships bash 3.2 and BSD tools)', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).not.toMatch(/declare -A|mapfile|readarray|\$\{\w+(,,|\^\^)|readlink -f|date -d|sed -i|&>>|\|&|coproc/);
  });

  it('requires --pr and rejects unknown arguments with exit 2', () => {
    expect(sh('--dry-run').status).toBe(2);
    expect(sh('--dry-run').stderr).toMatch(/--pr <number> is required/);
    expect(sh('--pr', 'abc', '--dry-run').status).toBe(2);
    const r = sh('--pr', '1', '--bogus');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown argument: --bogus/);
    expect(sh('--pr', '1', '--head', 'NOT-A-SHA', '--dry-run').status).toBe(2);
  });

  it('dry run: preflight and plan only, exit 0, nothing written', () => {
    const r = sh('--pr', '179', '--dry-run', '--no-db', '--skip-network-check');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Preflight\n {2}ok {4}git /);
    expect(r.stdout).toMatch(/ok {4}node v\d+/);
    expect(r.stdout).toMatch(/database gates: skipped \(--no-db\)/);
    expect(r.stdout).toMatch(/PR: {9}#179 \(https:\/\/github\.com\/realjkg\/finops-ratio\)/);
    expect(r.stdout).toMatch(/dry run: nothing cloned, started or written/);
    expect(fs.existsSync(path.join(home, 'out'))).toBe(false);
  });

  it('prints its usage with --help', () => {
    const r = sh('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/mac-evidence\.sh --pr 179/);
  });
});
