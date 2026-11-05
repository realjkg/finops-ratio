// mac-evidence.sh: argument parsing, exit codes, the dry-run plan (preflight + plan, nothing cloned, started
// or written), the inherited-RATIO_* scrub and the cleanup guard. The real Mac run (clone, Docker, browser
// download) is not executed here.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mac-evidence.sh');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-evidence-test-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-evidence-tmp-'));
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); });
const sh = (args, env = {}) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, RATIO_EVIDENCE_HOME: path.join(home, 'out'), ...env } });

describe('mac-evidence.sh', () => {
  it('is valid bash with no bash 4 or GNU-only constructs (macOS ships bash 3.2 and BSD tools)', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).not.toMatch(/declare -A|mapfile|readarray|\$\{\w+(,,|\^\^)|readlink -f|date -d|sed -i|&>>|\|&|coproc/);
  });

  it('usage errors exit 2: missing or non-positive --pr, unknown flags, flags without values, short or non-hex --head', () => {
    for (const args of [['--dry-run'], ['--pr', 'abc', '--dry-run'], ['--pr', '0', '--dry-run'], ['--pr', '1', '--bogus'], ['--pr'], ['--pr', '1', '--base'], ['--pr', '1', '--head', '--dry-run'],
      ['--pr', '1', '--head', 'NOT-A-SHA', '--dry-run'], ['--pr', '1', '--head', 'abc123', '--dry-run']]) {
      expect(sh(args).status, args.join(' ')).toBe(2);
    }
    expect(sh(['--pr', '1', '--head', 'abc123', '--dry-run']).stderr).toMatch(/at least 12 hex/);
  });

  it('dry run: preflight and plan only, exit 0, nothing written', () => {
    const r = sh(['--pr', '179', '--dry-run', '--no-db', '--skip-network-check', '--migration-smoke']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Preflight\n {2}ok {4}git /);
    expect(r.stdout).toMatch(/ok {4}node v\d+/);
    expect(r.stdout).toMatch(/database gates: skipped \(--no-db\)/);
    expect(r.stdout).toMatch(/migrations: changed ones only, plus the full-set smoke/);
    expect(r.stdout).toMatch(/dry run: nothing cloned, started or written/);
    expect(fs.existsSync(path.join(home, 'out'))).toBe(false);
    expect(fs.readdirSync(tmp).filter((n) => n !== 'node-compile-cache')).toEqual([]); // Node's own compile cache is not ours
  });

  it('drops inherited RATIO_* variables before anything runs (keeps only its two documented inputs)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const scrub = src.indexOf('unset "$v"');
    expect(scrub).toBeGreaterThan(0);
    expect(scrub).toBeLessThan(src.indexOf('while [ $# -gt 0 ]'));
    expect(src).toMatch(/RATIO_EVIDENCE_HOME\|RATIO_EVIDENCE_CHROMIUM\) ;; \*\) unset "\$v"/);
    // The scratch database for down-migrations is only ever the one this script creates.
    expect(src).not.toMatch(/RATIO_MIGRATE_DATABASE_URL/);
    expect(src).toMatch(/POSTGRES_HOST_AUTH_METHOD=trust/);
    expect(src).not.toMatch(/POSTGRES_PASSWORD/);
    expect(src).toMatch(/-p "127\.0\.0\.1:\$PG_PORT:5432"/);
  });

  it('cleanup removes only a workspace it created (mktemp name directly under TMPDIR), never anything else', () => {
    const ours = fs.mkdtempSync(path.join(tmp, 'ratio-evidence-pr179.'));
    fs.writeFileSync(path.join(ours, 'f'), 'x');
    expect(sh(['--self-test-cleanup', ours]).stdout).toMatch(/removed workspace/);
    expect(fs.existsSync(ours)).toBe(false);

    const other = fs.mkdtempSync(path.join(tmp, 'precious-'));
    const r = sh(['--self-test-cleanup', other]);
    expect(r.stderr).toMatch(/refusing to remove/);
    expect(fs.existsSync(other)).toBe(true);

    const sneaky = path.join(tmp, 'ratio-evidence-pr1.abcdef', '..', path.basename(other));
    fs.mkdirSync(path.join(tmp, 'ratio-evidence-pr1.abcdef'));
    expect(sh(['--self-test-cleanup', sneaky]).stderr).toMatch(/refusing to remove/);
    expect(fs.existsSync(other)).toBe(true);

    const kept = fs.mkdtempSync(path.join(tmp, 'ratio-evidence-pr2.'));
    expect(sh(['--self-test-cleanup', kept, '--keep']).stdout).toMatch(/kept workspace/);
    expect(fs.existsSync(kept)).toBe(true);
    for (const d of [other, kept, path.join(tmp, 'ratio-evidence-pr1.abcdef')]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('prints its usage with --help', () => {
    const r = sh(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/mac-evidence\.sh --pr 179/);
  });
});
