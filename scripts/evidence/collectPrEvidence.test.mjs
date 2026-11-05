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
  it('uses the merge-base when --base has moved on', () => {
    const { dir, git, base, head } = repo();
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'later.txt'), 'x');
    git('add', '-A'); git('commit', '-q', '-m', 'main moves on');
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
