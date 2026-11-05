// The collector's refusals and its plan, on small throwaway git repositories (no gate is executed):
// dirty tree, HEAD mismatch, leftover rollback worktree, usage errors, the merge-base, the environment
// each gate gets, and the migration safety rules (including an inherited production RATIO_ENV).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const COLLECTOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'collect-pr-evidence.mjs');
const made = [];
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-test-'));
  made.push(dir);
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'src/ingest/db/migrations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/ingest/db/migrations/0001_a.up.sql'), 'select 1;\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  fs.writeFileSync(path.join(dir, 'src/ingest/db/migrations/0002_b.up.sql'), 'select 2;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'pr: a migration');
  const head = git('rev-parse', 'HEAD');
  return { dir, git, base, head };
}
// A minimal environment: the test must not depend on (or leak) the runner's variables.
const ENV = { PATH: process.env.PATH, HOME: os.tmpdir() };
const collect = (dir, args, env = {}) => spawnSync(process.execPath, [COLLECTOR, ...args], { cwd: dir, encoding: 'utf8', env: { ...ENV, ...env } });
const plan = (r) => { expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout); };

describe('collect-pr-evidence refusals', () => {
  it('usage errors exit 2', () => {
    const { dir } = repo();
    expect(collect(dir, ['--base', 'main', '--head', 'pr']).status).toBe(2);
    expect(collect(dir, ['--base', 'main', '--head', 'pr', '--pr', '0']).stderr).toMatch(/positive integer/);
    expect(collect(dir, ['--base', '--head', 'pr', '--pr', '1']).status).toBe(2);
  });
  it('refuses a dirty working tree (exit 3)', () => {
    const { dir, base, head } = repo();
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'x');
    const r = collect(dir, ['--base', base, '--head', head, '--pr', '1', '--plan-only']);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/working tree is not clean/);
  });
  it('refuses when HEAD is not --head (exit 3)', () => {
    const { dir, base } = repo();
    const r = collect(dir, ['--base', base, '--head', base, '--pr', '1', '--plan-only']);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/HEAD is not --head/);
  });
  it('refuses while a previous evidence rollback worktree is registered, with the fix command', () => {
    const { dir, git, base, head } = repo();
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-evidence-rollback-'));
    made.push(wt);
    git('worktree', 'add', '--quiet', '--detach', wt, head);
    const r = collect(dir, ['--base', base, '--head', head, '--pr', '1', '--plan-only']);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/rollback worktree is still registered/);
    expect(r.stderr).toMatch(/git worktree remove --force/);
  });
});

describe('collect-pr-evidence plan', () => {
  it('uses the merge-base when --base has moved on (a migration added on main later is not counted as the PR\'s)', () => {
    const { dir, git, base, head } = repo();
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'src/ingest/db/migrations/0003_main.up.sql'), 'select 3;\n');
    git('add', '-A'); git('commit', '-q', '-m', 'main moves on with its own migration');
    const tip = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'pr');
    const p = plan(collect(dir, ['--base', tip, '--head', head, '--pr', '1', '--plan-only']));
    expect(p.base).toBe(tip);
    expect(p.mergeBase).toBe(base);
    expect(p.migrationsChanged).toBe(1);
  });
  it('never hands an inherited database URL, RATIO_ENV or secret to any gate, and runs no migration without the evidence scratch URL', () => {
    const { dir, base, head } = repo();
    const p = plan(collect(dir, ['--base', base, '--head', head, '--pr', '1', '--plan-only', '--migration-smoke'], {
      RATIO_MIGRATE_DATABASE_URL: 'postgres://owner@prod-db/ratio', RATIO_DATABASE_URL: 'postgres://x@db/ratio', RATIO_READER_DATABASE_URL: 'postgres://r@db/ratio',
      RATIO_TEST_DATABASE_URL: 'postgres://t@db/postgres', RATIO_ENV: 'production', AWS_SECRET_ACCESS_KEY: 'k', GITHUB_TOKEN: 'g',
    }));
    for (const g of [...p.gates, ...p.informational]) {
      for (const k of ['RATIO_MIGRATE_DATABASE_URL', 'RATIO_DATABASE_URL', 'RATIO_READER_DATABASE_URL', 'RATIO_TEST_DATABASE_URL', 'RATIO_ENV', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']) expect(g.envKeys ?? [], `${g.name}: ${k}`).not.toContain(k);
    }
    const mig = p.gates.find((g) => g.name.startsWith('migrations'));
    expect(mig.skip).toMatch(/NOT RUN: 1 migration file\(s\) changed; no scratch database/);
    expect(p.informational[0].na).toMatch(/no scratch database/);
  });
  it('the migration step gets only the allowlist plus the vetted scratch URL, never inherited variables', () => {
    const { dir, base, head } = repo();
    const p = plan(collect(dir, ['--base', base, '--head', head, '--pr', '1', '--plan-only', '--migration-smoke'], {
      RATIO_EVIDENCE_SCRATCH_DATABASE_URL: 'postgres://postgres@127.0.0.1:55432/ratio_evidence_migrate',
      RATIO_DATABASE_URL: 'postgres://x@db/ratio', RATIO_READER_DATABASE_URL: 'postgres://r@db/ratio', AWS_SECRET_ACCESS_KEY: 'k', NODE_OPTIONS: '--no-warnings', SOME_RANDOM: 'x',
    }));
    for (const g of [p.gates.find((x) => x.name.startsWith('migrations')), p.informational[0]]) {
      expect(g.envKeys, g.name).toEqual(expect.arrayContaining(['RATIO_MIGRATE_DATABASE_URL', 'RATIO_ENV', 'RATIO_ALLOW_DOWN_MIGRATIONS', 'PATH']));
      for (const k of ['RATIO_DATABASE_URL', 'RATIO_READER_DATABASE_URL', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'SOME_RANDOM', 'RATIO_EVIDENCE_SCRATCH_DATABASE_URL']) expect(g.envKeys, `${g.name}: ${k}`).not.toContain(k);
    }
  });
  it('refuses migrations when the caller is production, even with a valid scratch URL (the RATIO_ENV override case)', () => {
    const { dir, base, head } = repo();
    const p = plan(collect(dir, ['--base', base, '--head', head, '--pr', '1', '--plan-only'], { RATIO_EVIDENCE_SCRATCH_DATABASE_URL: 'postgres://postgres@127.0.0.1:55432/ratio_evidence_migrate', RATIO_ENV: 'production' }));
    expect(p.gates.find((g) => g.name.startsWith('migrations')).skip).toMatch(/refused: RATIO_ENV=production/);
  });
  it('with a vetted scratch database: migration steps only get it, as RATIO_MIGRATE_DATABASE_URL; the full-set smoke is opt-in', () => {
    const { dir, base, head } = repo();
    const env = { RATIO_EVIDENCE_SCRATCH_DATABASE_URL: 'postgres://postgres@127.0.0.1:55432/ratio_evidence_migrate' };
    const p = plan(collect(dir, ['--base', base, '--head', head, '--pr', '1', '--plan-only'], env));
    const mig = p.gates.find((g) => g.name.startsWith('migrations'));
    expect(mig.db).toBe('ratio_evidence_migrate');
    expect(mig.envKeys).toEqual(expect.arrayContaining(['RATIO_MIGRATE_DATABASE_URL', 'RATIO_ENV', 'RATIO_ALLOW_DOWN_MIGRATIONS']));
    for (const g of p.gates.filter((x) => x !== mig && x.envKeys)) expect(g.envKeys, g.name).not.toContain('RATIO_MIGRATE_DATABASE_URL');
    expect(p.informational[0].na).toMatch(/not requested \(--migration-smoke\)/);
    const withSmoke = plan(collect(dir, ['--base', base, '--head', head, '--pr', '1', '--plan-only', '--migration-smoke'], env));
    expect(withSmoke.informational[0].command).toMatch(/migrate --down 2/);
  });
});

// --- run phase, with shimmed gates --------------------------------------------------------------
// Fake npm/npx first on PATH: every gate "passes" with a summary, and `npx tsx <generator>` runs the repo's
// generator script with node, so determinism, fixture recompute, rollback, redaction and the report are real.
function shimDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-shim-'));
  made.push(d);
  fs.writeFileSync(path.join(d, 'npm'), '#!/bin/sh\ncase "$1" in -v) echo 10.0.0;; *) echo "npm $*";; esac\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'npx'), [
    '#!/bin/sh',
    'case "$1" in',
    '  vitest) printf " Test Files  1 passed (1)\\n      Tests  3 passed (3)\\n";;',
    '  playwright) printf "  2 passed (1s)\\n";;',
    '  tsx) exec node --input-type=commonjs -e "$(cat "$2")";;',
    '  *) echo "npx $*";;',
    'esac', 'exit 0', ''].join('\n'), { mode: 0o755 });
  return d;
}
const dataset = (billed) => JSON.stringify({ meta: { controlTotals: { USD: { rows: 2, billed, effective: '1.0', naBilled: 0, naEffective: 1 } } }, columns: ['BillingCurrency', 'BilledCost', 'EffectiveCost'], rows: [['USD', '1.5', '1.0'], ['USD', billed === '2.0' ? '0.5' : '0.75', '']] }) + '\n';
function fixtureRepo(generatorWrites) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-run-'));
  made.push(dir);
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'src/demo/apiDatasets/data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\ndocs/evidence/pr-*/logs/\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'src/demo/apiDatasets/data/d.json'), dataset('2.0'));
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  fs.writeFileSync(path.join(dir, 'src/demo/apiDatasets/data/d.json'), dataset('2.25'));
  fs.writeFileSync(path.join(dir, 'scripts/generate-demo-datasets.ts'), `require('fs').writeFileSync('src/demo/apiDatasets/data/d.json', ${JSON.stringify(generatorWrites)});\n`);
  git('add', '-A'); git('commit', '-q', '-m', 'pr changes the fixture and its generator');
  const head = git('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/.bin/vitest'), '');
  return { dir, git, base, head };
}
const runCollector = (dir, args, env = {}) => spawnSync(process.execPath, [COLLECTOR, ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000,
  env: { PATH: `${shimDir()}:${process.env.PATH}`, HOME: os.tmpdir(), RATIO_EVIDENCE_CHROMIUM: process.execPath, ...env } });

describe('collect-pr-evidence run phase (shimmed gates)', () => {
  it('records gates, fixture recompute, determinism PASS, rollback PASS against the merge-base tree, and stays valid JSON with numeric-looking secret-named env vars', () => {
    const { dir, git, base, head } = fixtureRepo(dataset('2.25'));
    const r = runCollector(dir, ['--base', base, '--head', head, '--pr', '180', '--gate-timeout', '1'], { MAX_THINKING_TOKENS: '12345', TOKEN_REFRESH_ENABLED: '1', FEATURE_SECRET: 'true', GITHUB_TOKEN: 'ghp_realLookingToken123' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const raw = fs.readFileSync(path.join(dir, 'docs/evidence/pr-180/evidence.json'), 'utf8');
    const e = JSON.parse(raw);
    expect(e.pr).toBe(180);
    expect(e.head.sha).toBe(head);
    expect(e.mergeBase.sha).toBe(base);
    expect(raw).not.toMatch(/\[redacted\]/); // nothing worth redacting reached the output
    expect(raw).not.toContain('ghp_realLookingToken123');
    expect(e.gates.find((g) => g.name === 'unit tests (vitest)').status).toBe('PASS');
    // The browser preflight runs in a short temp dir and fails here (no playwright-core): gates NOT RUN, never PASS.
    expect(e.informational.find((g) => g.name === 'Chromium launch preflight').status).toBe('FAIL');
    expect(e.gates.find((g) => g.name === 'Playwright simulation suite')).toMatchObject({ status: 'NOT RUN', summary: expect.stringMatching(/Chromium did not launch/) });
    expect(fs.existsSync(path.join(dir, 'docs/evidence/pr-180/logs/short-tmp.path'))).toBe(false);
    const f = e.fixtures.files[0];
    expect(f).toMatchObject({ path: 'src/demo/apiDatasets/data/d.json', baseRows: 2, headRows: 2, matchesStated: 'yes', totalsUnchanged: 'no (changed)' });
    expect(f.headTotals.USD).toEqual({ rows: 2, naBilled: 0, naEffective: 1, billed: '2.25', effective: '1.0' });
    expect(e.fixtures.determinism[0].status).toBe('PASS');
    expect(e.rollback.status).toBe('PASS');
    expect(e.rollback.treeAfterReverse).toBe(e.mergeBase.tree);
    expect(e.rollback.treeAfterReverse).toBe(git('rev-parse', `${base}^{tree}`));
    expect(git('status', '--porcelain', '--', '.', ':!docs/evidence')).toBe(''); // only the evidence output is new
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
    const md = fs.readFileSync(path.join(dir, 'docs/evidence/pr-180/evidence.md'), 'utf8');
    expect(md).toMatch(/Attests code SHA `[0-9a-f]{40}`/);
  });

  it('rollback is FAIL when the reverse-applied tree differs from the merge-base tree, even with every gate green', () => {
    // A gitlink (submodule pointer) removed by the PR: git apply -R cannot restore it in a plain worktree, so the
    // reverse-applied tree really differs from the merge-base tree. The rollback must say so, never PASS.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-run-'));
    made.push(dir);
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\ndocs/evidence/pr-*/logs/\n');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git('add', '-A');
    git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/sub`);
    git('commit', '-q', '-m', 'base with a submodule pointer');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'pr');
    git('rm', '-q', '--cached', 'vendor/sub');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'b\n');
    git('add', '-A'); git('commit', '-q', '-m', 'pr drops the submodule');
    const head = git('rev-parse', 'HEAD');
    fs.mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/.bin/vitest'), '');
    const r = runCollector(dir, ['--base', base, '--head', head, '--pr', '3']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const e = JSON.parse(fs.readFileSync(path.join(dir, 'docs/evidence/pr-3/evidence.json'), 'utf8'));
    expect(e.rollback.gates.every((g) => g.status === 'PASS')).toBe(true);
    expect(e.rollback.treeAfterReverse).not.toBe(e.mergeBase.tree);
    expect(e.rollback.status).toBe('FAIL');
    expect(e.rollback.detail).toMatch(/DIFFERS from the merge-base tree/);
    expect(e.charter.find((c) => c.id === 4).status).toBe('FAIL');
  });

  it('a generator that does not reproduce the committed fixture makes determinism FAIL and the run exit 1', () => {
    const { dir, git, base, head } = fixtureRepo(dataset('9.99'));
    const r = runCollector(dir, ['--base', base, '--head', head, '--pr', '7']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const e = JSON.parse(fs.readFileSync(path.join(dir, 'docs/evidence/pr-7/evidence.json'), 'utf8'));
    expect(e.fixtures.determinism[0]).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/changed: src\/demo\/apiDatasets\/data\/d\.json/) });
    expect(e.charter.find((c) => c.id === 3).status).toBe('FAIL');
    expect(git('status', '--porcelain', '--', '.', ':!docs/evidence')).toBe(''); // the regenerated file was restored
  });
});
