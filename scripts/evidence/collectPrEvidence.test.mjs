// The collector's refusals and its plan, on small throwaway git repositories (no gate is executed):
// dirty tree, HEAD mismatch, leftover rollback worktree, usage errors, the merge-base, the environment
// each gate gets, and the migration safety rules (including an inherited production RATIO_ENV).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const COLLECTOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'collect-pr-evidence.mjs');
const REPO_MANIFEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs/evidence/platform/manifest.json');
const PLATFORM_CHECK = 'platform capability tests (informational)';
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
  it('picks a free port pair by default, so a busy 3410 (another evidence run) does not refuse; an explicit busy --port still does', async () => {
    const { dir, base, head } = repo();
    const blocker = net.createServer();
    await new Promise((r) => { blocker.once('error', r); blocker.listen(3410, '127.0.0.1', r); }); // already busy is fine too
    try {
      const p = plan(collect(dir, ['--base', base, '--head', head, '--pr', '1', '--plan-only']));
      expect(Number.isInteger(p.port) && p.port !== 3410).toBe(true);
      const r = collect(dir, ['--base', base, '--head', head, '--pr', '1', '--plan-only', '--port', '3410']);
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/port 3410 is in use/);
    } finally { await new Promise((r) => blocker.close(r)); }
  });
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
  it('platform capability evidence (ADR-0001 §14): N/A without a manifest; with one, a separate non-gating vitest JSON run of its implemented tests', () => {
    const { dir, git, base, head } = repo();
    const p = plan(collect(dir, ['--base', base, '--head', head, '--pr', '1', '--plan-only']));
    expect(p.informational[0].name).toMatch(/^migrations smoke/);
    expect(p.informational.find((g) => g.name === PLATFORM_CHECK).na).toBe('N/A: no docs/evidence/platform/manifest.json in this checkout');
    const manifestPath = path.join(dir, 'docs/evidence/platform/manifest.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.copyFileSync(REPO_MANIFEST, manifestPath);
    git('add', '-A'); git('commit', '-q', '-m', 'manifest');
    const p2 = plan(collect(dir, ['--base', base, '--head', git('rev-parse', 'HEAD'), '--pr', '1', '--plan-only'], { AWS_SECRET_ACCESS_KEY: 'k', GITHUB_TOKEN: 'g' }));
    const run = p2.informational.find((g) => g.name === PLATFORM_CHECK);
    const files = [...new Set(JSON.parse(fs.readFileSync(REPO_MANIFEST, 'utf8')).capabilities.flatMap((c) => c.evidence).flatMap((e) => e.tests ?? []).map((t) => t.file))].sort();
    // Test files are passed as absolute paths inside the checkout, so none can read as a vitest option (review M1).
    const root = fs.realpathSync(dir);
    expect(run.command).toBe(`npx vitest run --cache=false --reporter=json --outputFile=${path.join(root, 'docs/evidence/pr-1/logs/platform-vitest.json')} ${files.map((f) => path.join(root, f)).join(' ')}`);
    expect(run.command.split(' ').slice(6).every((a) => a.startsWith(`${root}/`))).toBe(true);
    for (const k of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']) expect(run.envKeys).not.toContain(k);
    expect(p2.gates.map((g) => g.name)).toEqual(p.gates.map((g) => g.name)); // no new gate: it never decides the charter
    fs.writeFileSync(manifestPath, '{"schema":"x"}\n');
    git('add', '-A'); git('commit', '-q', '-m', 'broken manifest');
    const p3 = plan(collect(dir, ['--base', base, '--head', git('rev-parse', 'HEAD'), '--pr', '1', '--plan-only']));
    expect(p3.informational.find((g) => g.name === PLATFORM_CHECK).na).toMatch(/^N\/A: manifest invalid \(\d+ problem\(s\)\)/);
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
    '  vitest) for a in "$@"; do case "$a" in --outputFile=*) [ -f vitest-shim.json ] && cp vitest-shim.json "${a#--outputFile=}";; esac; done',
    '    printf " Test Files  1 passed (1)\\n      Tests  3 passed (3)\\n";;',
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

  it('platform capability evidence is reported per capability from the vitest JSON; a failing test never changes the exit code or the charter', () => {
    const { dir, git, base } = fixtureRepo(dataset('2.25'));
    const m = JSON.parse(fs.readFileSync(REPO_MANIFEST, 'utf8'));
    m.capabilities[0].evidence.push({ id: 'x-pass', covers: null, slice: 'W0', kind: 'test', description: 'passes', status: 'implemented', tests: [{ file: 'src/a.test.ts', suite: 'S', title: 't1' }] });
    m.capabilities[3].evidence.push({ id: 'x-fail', covers: null, slice: 'W0', kind: 'test', description: 'fails', status: 'implemented', tests: [{ file: 'src/a.test.ts', suite: 'S', title: 't2' }] });
    fs.mkdirSync(path.join(dir, 'docs/evidence/platform'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/evidence/platform/manifest.json'), JSON.stringify(m, null, 2) + '\n');
    const results = (status) => m.capabilities.flatMap((c) => c.evidence).flatMap((e) => e.tests ?? []).map((t) => ({ name: path.join(fs.realpathSync(dir), t.file), assertionResults: [{ ancestorTitles: t.suite.split(' > '), title: t.title, status: t.title === 't2' ? 'failed' : status }] }));
    fs.writeFileSync(path.join(dir, 'vitest-shim.json'), JSON.stringify({ testResults: results('passed') }));
    git('add', '-A'); git('commit', '-q', '-m', 'manifest');
    const head = git('rev-parse', 'HEAD');
    const r = runCollector(dir, ['--base', base, '--head', head, '--pr', '9']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const e = JSON.parse(fs.readFileSync(path.join(dir, 'docs/evidence/pr-9/evidence.json'), 'utf8'));
    expect(e.platform.manifest).toBe('docs/evidence/platform/manifest.json');
    expect(e.platform.run.available).toBe(true);
    expect(e.platform.capabilities.map((c) => c.status)).toEqual(['PLANNED', 'NOT STARTED', 'NOT STARTED', 'NOT VALIDATED', 'NOT STARTED', 'NOT STARTED', 'NOT STARTED', 'NOT STARTED']);
    expect(e.platform.capabilities[3].items.find((i) => i.id === 'x-fail').status).toBe('FAILED');
    expect(e.charter.map((c) => c.item)).not.toContain(expect.stringMatching(/platform/i));
    expect(e.gates.map((g) => g.name)).not.toContain(PLATFORM_CHECK);
    expect(e.informational.find((g) => g.name === PLATFORM_CHECK).logSha256).toMatch(/^[0-9a-f]{64}$/);
    const md = fs.readFileSync(path.join(dir, 'docs/evidence/pr-9/evidence.md'), 'utf8');
    expect(md).toMatch(/^\| 4 \| Track token costs \| 1\.1 \| .* \| \*\*NOT VALIDATED\*\* \|/m);
    expect(md).not.toMatch(/Platform capability evidence[\s\S]*\*\*PASS\*\*[\s\S]*## Known gaps/);
  });

  it('a stale platform report left in the logs directory is never read: without a fresh report the capabilities are NOT RUN (review L3, M11)', () => {
    const { dir, git, base } = fixtureRepo(dataset('2.25'));
    fs.mkdirSync(path.join(dir, 'docs/evidence/platform'), { recursive: true });
    fs.copyFileSync(REPO_MANIFEST, path.join(dir, 'docs/evidence/platform/manifest.json'));
    git('add', '-A'); git('commit', '-q', '-m', 'manifest, no shim report');
    const head = git('rev-parse', 'HEAD');
    const tests = JSON.parse(fs.readFileSync(REPO_MANIFEST, 'utf8')).capabilities.flatMap((c) => c.evidence).flatMap((e) => e.tests ?? []);
    const stale = { testResults: tests.map((t) => ({ name: path.join(fs.realpathSync(dir), t.file), assertionResults: [{ ancestorTitles: t.suite.split(' > '), title: t.title, status: 'passed' }] })) };
    fs.mkdirSync(path.join(dir, 'docs/evidence/pr-11/logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/evidence/pr-11/logs/platform-vitest.json'), JSON.stringify(stale)); // gitignored
    const r = runCollector(dir, ['--base', base, '--head', head, '--pr', '11']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const e = JSON.parse(fs.readFileSync(path.join(dir, 'docs/evidence/pr-11/evidence.json'), 'utf8'));
    expect(e.platform.run).toEqual({ available: false, reason: 'NOT RUN: the targeted vitest run wrote no JSON report' });
    expect(e.platform.capabilities.map((c) => c.status)).toEqual(['NOT RUN', 'NOT RUN', 'NOT RUN', 'NOT RUN', 'NOT STARTED', 'NOT RUN', 'NOT STARTED', 'NOT STARTED']);
  });

  it('an invalid manifest is reported in the platform section only: charter item 3 and the known gaps are unchanged (review L5)', () => {
    const run = (manifestText, pr) => {
      const { dir, git, base } = fixtureRepo(dataset('2.25'));
      if (manifestText !== null) {
        fs.mkdirSync(path.join(dir, 'docs/evidence/platform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'docs/evidence/platform/manifest.json'), manifestText);
        git('add', '-A'); git('commit', '-q', '-m', 'manifest');
      }
      const r = runCollector(dir, ['--base', base, '--head', git('rev-parse', 'HEAD'), '--pr', String(pr)]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      return { e: JSON.parse(fs.readFileSync(path.join(dir, `docs/evidence/pr-${pr}/evidence.json`), 'utf8')), md: fs.readFileSync(path.join(dir, `docs/evidence/pr-${pr}/evidence.md`), 'utf8') };
    };
    const none = run(null, 12);
    const bad = run('{"schema":"x"}\n', 13);
    expect(bad.e.knownGaps).toEqual(none.e.knownGaps);
    expect(bad.e.charter.find((c) => c.id === 3)).toEqual(none.e.charter.find((c) => c.id === 3));
    expect(bad.e.platform.problems.length).toBeGreaterThan(0);
    expect(bad.md).toMatch(/Manifest invalid \(not evaluated\): /);
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
