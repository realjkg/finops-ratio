#!/usr/bin/env node
// Re-runnable merge evidence for a PR, in the shape the orchestrator charter asks for. Non-gating tooling:
// it changes no CI workflow or governance file and adds no dependency.
//
//   node scripts/evidence/collect-pr-evidence.mjs --base <sha|ref> --head <sha> --pr <n> [--out docs/evidence/pr-<n>] [--logs <dir>]
//
// Refuses to run unless the working tree is clean and HEAD equals --head. Runs every gate with its exact
// command, records timing, exit code, the last 40 lines and the sha256 of the full log (logs go to
// --logs, default <out>/logs, which is gitignored), recomputes fixture totals with BigInt straight from
// the raw files, checks fixture generators are deterministic, verifies a rollback in a temporary
// worktree, and writes evidence.md and evidence.json. Exit 1 if any required gate or check FAILS.
// It never marks the challenger re-review or the merge decision PASS: those are the orchestrator's.
//
// It runs in the current directory (the checkout under test), so it can be run from another checkout:
// `cd <clone at head> && node /path/to/collect-pr-evidence.mjs ...` (mac-evidence.sh does this).
// Environment (all optional): RATIO_TEST_DATABASE_URL + RATIO_TEST_S3_ENDPOINT + RATIO_PG_DUMP + RATIO_PSQL
// for test:db; RATIO_MIGRATE_DATABASE_URL (a scratch database) for the migration checks;
// RATIO_EVIDENCE_CHROMIUM or RATIO_CHROMIUM_PATH for a browser outside Playwright's own install.
// Passwords from *_PASSWORD and *_URL variables are redacted from every log and the report.
import { spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { STATUS, browserPlan, dbTestPlan, redact, secretsFromEnv, classifyGate, fixtureRows, gatesItemStatus, parsePlaywrightTotals, parseVitestTotals, renderEvidenceMd, statedTotals, stripAnsi, totalsByCurrency } from './evidenceLib.mjs';

const ROOT = process.cwd();
const SECRETS = secretsFromEnv(process.env);
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []));
const say = (m) => process.stdout.write(`${m}\n`);
const die = (m) => { process.stderr.write(`collect-pr-evidence: ${m}\n`); process.exit(2); };
if (!args.base || !args.head || !args.pr) die('usage: --base <sha|ref> --head <sha> --pr <n> [--out dir] [--logs dir]');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// --- a. preflight --------------------------------------------------------------------------
if (git('status', '--porcelain')) die('working tree is not clean');
const headSha = git('rev-parse', `${args.head}^{commit}`);
if (git('rev-parse', 'HEAD') !== headSha) die(`HEAD is not --head (${headSha})`);
const baseSha = git('rev-parse', `${args.base}^{commit}`);
const OUT = path.resolve(args.out ?? `docs/evidence/pr-${args.pr}`);
const LOGS = path.resolve(args.logs ?? path.join(OUT, 'logs'));
fs.mkdirSync(LOGS, { recursive: true });
const ev = {
  schema: 'ratio.pr-evidence/1', pr: Number(args.pr), generatedAt: new Date().toISOString(),
  command: `node scripts/evidence/collect-pr-evidence.mjs --base ${args.base} --head ${args.head} --pr ${args.pr}${args.out ? ` --out ${args.out}` : ''}`,
  env: { node: process.version, npm: execFileSync('npm', ['-v'], { encoding: 'utf8' }).trim(), os: `${os.type()} ${os.release()} ${os.arch()}` },
  base: { ref: args.base, sha: baseSha, tree: git('rev-parse', `${baseSha}^{tree}`) },
  head: { sha: headSha, tree: git('rev-parse', `${headSha}^{tree}`) },
  mergeBase: git('merge-base', baseSha, headSha),
  evidenceCommitNote: `This file attests code SHA \`${headSha}\`. A commit that adds it must change only \`${path.relative(ROOT, OUT)}/\`.`,
  gates: [], fixtures: { files: [], determinism: [] }, rollback: {}, knownGaps: [], charter: [],
};

// --- b. gates ------------------------------------------------------------------------------
/**
 * Runs one gate: argv steps run in order with no shell (nothing is interpolated into a command line),
 * stopping at the first non-zero exit; all output goes to one log.
 */
function run(name, steps, { cwd = ROOT, env = {}, logName = name, parse = null } = {}) {
  const argvs = Array.isArray(steps[0]) ? steps : [steps];
  const command = argvs.map((a) => a.join(' ')).join(' && ');
  const log = path.join(LOGS, `${logName.replace(/[^\w.-]+/g, '_')}.log`);
  const fd = fs.openSync(log, 'w');
  const start = new Date();
  let r = { status: 0 };
  for (const [bin, ...rest] of argvs) {
    r = spawnSync(bin, rest, { cwd, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...env }, stdio: ['ignore', fd, fd], shell: false });
    if (r.status !== 0) break;
  }
  fs.closeSync(fd);
  const end = new Date();
  // Throwaway DB passwords never stay in a log, a tail or the report.
  fs.writeFileSync(log, redact(fs.readFileSync(log, 'utf8'), SECRETS));
  const text = fs.readFileSync(log);
  const plain = stripAnsi(text.toString('utf8'));
  const totals = parse ? parse(plain) : undefined;
  const g = { name, command, cwd: path.relative(ROOT, cwd) || '.', ran: true, exitCode: r.status ?? 1, start: start.toISOString(), end: end.toISOString(),
    durationSec: Math.round((end - start) / 100) / 10, log: path.relative(ROOT, log), logSha256: sha256(text), tail: plain.split('\n').slice(-41).join('\n').trimEnd(), totals: totals ?? null, expectTotals: Boolean(parse) };
  g.status = classifyGate(g);
  g.summary = totals?.tests ? `${totals.files.passed}/${totals.files.total} files, ${totals.tests.passed} passed, ${totals.tests.failed} failed, ${totals.tests.skipped} skipped`
    : totals ? `${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped, ${totals.flaky} flaky` : g.exitCode === 0 ? 'exit 0' : `exit ${g.exitCode}`;
  say(`${g.status.padEnd(8)} ${name} (${g.durationSec}s)`);
  return g;
}
const notRun = (name, command, reason, { na = false } = {}) => {
  const g = { name, command, ran: false, na, exitCode: null, durationSec: null, summary: reason };
  g.status = classifyGate(g);
  if (!na) ev.knownGaps.push(`${name}: ${reason}`);
  say(`${g.status.padEnd(8)} ${name}: ${reason}`);
  return g;
};

const dbPlan = dbTestPlan(process.env);
const migrateUrl = process.env.RATIO_MIGRATE_DATABASE_URL;
const port = args.port ?? '3410';
ev.gates.push(run('npm ci', ['npm', 'ci']));
ev.gates.push(run('lint', ['npm', 'run', 'lint']));
ev.gates.push(run('typecheck (app)', ['npx', 'tsc', '--noEmit']));
ev.gates.push(run('typecheck (worker)', ['npx', 'tsc', '-p', 'tsconfig.worker.json', '--noEmit']));
ev.gates.push(run('unit tests (vitest)', ['npx', 'vitest', 'run', '--cache=false'], { parse: parseVitestTotals }));
ev.gates.push(dbPlan.run ? run('integration tests (Postgres)', ['npm', 'run', 'test:db'], { parse: parseVitestTotals })
  : notRun('integration tests (Postgres)', 'npm run test:db', dbPlan.reason));
// Migrations, the way CI's "Worker build + migration smoke" step runs them, on a scratch database
// (RATIO_MIGRATE_DATABASE_URL). Down is allowed only with RATIO_ENV=ci and RATIO_ALLOW_DOWN_MIGRATIONS=1.
const MIG_DIR = 'src/ingest/db/migrations';
const migrations = git('diff', '--name-only', baseSha, headSha, '--', MIG_DIR).split('\n').filter(Boolean);
const allMigrations = fs.readdirSync(path.join(ROOT, MIG_DIR)).filter((f) => f.endsWith('.up.sql')).length;
const downEnv = { RATIO_ENV: 'ci', RATIO_ALLOW_DOWN_MIGRATIONS: '1' };
const migrateSteps = (n) => [['npm', 'run', '-s', 'worker:build'], ['npm', 'run', '-s', 'worker', '--', 'migrate'], ['npm', 'run', '-s', 'worker', '--', 'migrate', '--down', String(n)], ['npm', 'run', '-s', 'worker', '--', 'migrate'], ['npm', 'run', '-s', 'worker', '--', 'migrate', '--status', '--json']];
if (!migrations.length) ev.gates.push(notRun('migrations up/down/up (changed)', '(none)', 'N/A: no migrations changed', { na: true }));
else if (migrateUrl) {
  const n = new Set(migrations.map((f) => path.basename(f).split('_')[0])).size;
  ev.gates.push(run('migrations up/down/up (changed)', migrateSteps(n), { env: downEnv }));
} else ev.gates.push(notRun('migrations up/down/up (changed)', 'worker migrate; migrate --down N; migrate', `NOT RUN: ${migrations.length} migration file(s) changed and no scratch database (RATIO_MIGRATE_DATABASE_URL unset)`));
ev.gates.push(run('build', ['npm', 'run', 'build']));
ev.gates.push(run('bundle check', ['npm', 'run', 'check:bundle']));
// Browser: an explicit path (containers) or the Chromium `npx playwright install chromium` put in place (a Mac).
let managed = null;
try { managed = execFileSync('node', ['-e', "process.stdout.write(require('playwright-core').chromium.executablePath())"], { cwd: ROOT, encoding: 'utf8' }); } catch { /* no playwright-core */ }
const browser = browserPlan(process.env, managed, (p) => fs.existsSync(p));
if (browser.env) {
  ev.env.browser = browser.source;
  ev.gates.push(run('Playwright simulation suite', ['npx', 'playwright', 'test', '--config', 'playwright.simulation.config.ts'], { env: { ...browser.env, RATIO_TEST_PORT: port }, parse: parsePlaywrightTotals }));
  ev.gates.push(run('Playwright engagement report spec', ['npx', 'playwright', 'test', '--config', 'playwright.engagement.config.ts'],
    { env: { ...browser.env, RATIO_TEST_NEXT_DIR: `.next-simulation-${port}`, RATIO_ENGAGEMENT_TEST_PORT: String(Number(port) + 1) }, parse: parsePlaywrightTotals }));
} else {
  ev.gates.push(notRun('Playwright simulation suite', 'npx playwright test --config playwright.simulation.config.ts', browser.reason));
  ev.gates.push(notRun('Playwright engagement report spec', 'npx playwright test --config playwright.engagement.config.ts', browser.reason));
}
// Informational (not a charter gate): the full migration set up, all the way down, and up again.
if (migrateUrl) ev.informational = [run('migrations smoke, full set (informational)', migrateSteps(allMigrations), { env: downEnv, logName: 'migrations-smoke-full' })];
else ev.informational = [notRun('migrations smoke, full set (informational)', 'worker migrate; migrate --down ALL; migrate', 'N/A (informational): no scratch database (RATIO_MIGRATE_DATABASE_URL unset)', { na: true })];
// A Playwright build rewrites next-env.d.ts to its own distDir; put the tracked file back and say so.
if (git('status', '--porcelain', '--', 'next-env.d.ts')) { git('checkout', '--', 'next-env.d.ts'); ev.knownGaps.push('next-env.d.ts was rewritten by the Playwright build (its distDir) and restored from HEAD after the run.'); }

// --- c. fixture provenance -----------------------------------------------------------------
const FIXTURE_DIRS = ['fixtures', 'src/demo/apiDatasets/data'];
const GENERATORS = [
  { dir: 'src/demo/apiDatasets/data/', argv: ['npx', 'tsx', 'scripts/generate-demo-datasets.ts'] },
  { dir: 'fixtures/focus-1.0-synthetic/', argv: ['npx', 'tsx', 'scripts/generate-focus-fixture.ts'] },
];
const changedFixtures = git('diff', '--name-only', baseSha, headSha, '--', ...FIXTURE_DIRS).split('\n').filter(Boolean);
let provenanceOk = true;
for (const p of changedFixtures) {
  const f = { path: p };
  let baseText = null;
  try { baseText = execFileSync('git', ['show', `${baseSha}:${p}`], { cwd: ROOT, maxBuffer: 1 << 28 }); } catch { /* added in this PR */ }
  const headText = fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p)) : null;
  f.baseSha256 = baseText ? sha256(baseText) : null;
  f.headSha256 = headText ? sha256(headText) : null;
  try {
    const side = (buf) => { const rows = buf ? fixtureRows(p, buf.toString('utf8')) : null; return rows ? { rows: rows.length, totals: totalsByCurrency(rows), stated: statedTotals(p, buf.toString('utf8')) } : null; };
    const b = side(baseText), h = side(headText);
    if (h) {
      f.baseRows = b?.rows ?? null; f.headRows = h.rows; f.baseTotals = b?.totals ?? null; f.headTotals = h.totals;
      if (h.stated) {
        f.matchesStated = Object.entries(h.stated).every(([c, s]) => h.totals[c] && s.rows === h.totals[c].rows && s.billed === h.totals[c].billed && s.effective === h.totals[c].effective) ? 'yes' : 'NO';
        if (f.matchesStated === 'NO') provenanceOk = false;
      }
      if (b) f.totalsUnchanged = JSON.stringify(b.totals) === JSON.stringify(h.totals) && b.rows === h.rows ? 'yes' : 'no (changed)';
    }
  } catch (e) { f.error = String(e.message ?? e); provenanceOk = false; }
  ev.fixtures.files.push(f);
}
for (const g of GENERATORS.filter((x) => changedFixtures.some((p) => p.startsWith(x.dir)))) {
  const r = run(`determinism: ${g.argv.join(' ')}`, [g.argv, ['git', 'diff', '--exit-code', '--', g.dir]], { logName: `determinism-${g.dir}` });
  const untracked = git('status', '--porcelain', '--', g.dir);
  const status = r.status === STATUS.PASS && !untracked ? STATUS.PASS : STATUS.FAIL;
  ev.fixtures.determinism.push({ command: `${r.command} && test -z "$(git status --porcelain -- ${g.dir})"`, status, logSha256: r.logSha256 });
  if (status !== STATUS.PASS) { provenanceOk = false; git('checkout', '--', g.dir); git('clean', '-fdq', '--', g.dir); }
}

// --- d. rollback in test -------------------------------------------------------------------
const WT = path.join(LOGS, 'rollback-worktree');
const patch = path.join(LOGS, 'pr.diff');
fs.writeFileSync(patch, execFileSync('git', ['diff', '--binary', baseSha, headSha], { cwd: ROOT, maxBuffer: 1 << 30 }));
ev.rollback.procedure = [
  `Test: \`git worktree add --detach ${path.relative(ROOT, WT)} ${headSha}\`; \`git diff --binary ${baseSha} ${headSha} > pr.diff\`; in the worktree \`git apply -R --binary pr.diff && git add -A && git write-tree\`;`,
  'compare with the base tree hash; then run lint, typecheck (app and worker) and the full vitest suite there; remove the worktree by its exact path.',
].join(' ');
ev.rollback.production = `after merge, \`git revert -m 1 <merge sha>\` (merge commit) or \`git revert <squash sha>\` (squash), or reverse-apply \`git diff ${baseSha} ${headSha}\` with \`git apply -R\`; no data, schema or config migration needs undoing${migrations.length ? ' EXCEPT the changed migrations, which need their down migration' : ''}.`;
try {
  if (fs.existsSync(WT)) git('worktree', 'remove', '--force', WT);
  git('worktree', 'add', '--quiet', '--detach', WT, headSha);
  execFileSync('git', ['apply', '-R', '--binary', patch], { cwd: WT });
  execFileSync('git', ['add', '-A'], { cwd: WT });
  const tree = execFileSync('git', ['write-tree'], { cwd: WT, encoding: 'utf8' }).trim();
  const sameLock = git('rev-parse', `${baseSha}:package-lock.json`) === git('rev-parse', `${headSha}:package-lock.json`);
  // Same lockfile at base and head: reuse the installed node_modules through a symlink; otherwise install.
  if (sameLock) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(WT, 'node_modules'), 'dir');
  const gates = [
    run('rollback: dependencies', sameLock ? ['ls', 'node_modules/.bin/vitest'] : ['npm', 'ci'], { cwd: WT, logName: 'rollback-deps' }),
    run('rollback: lint', ['npm', 'run', 'lint'], { cwd: WT, logName: 'rollback-lint' }),
    run('rollback: typecheck', [['npx', 'tsc', '--noEmit'], ['npx', 'tsc', '-p', 'tsconfig.worker.json', '--noEmit']], { cwd: WT, logName: 'rollback-typecheck' }),
    run('rollback: unit tests', ['npx', 'vitest', 'run', '--cache=false'], { cwd: WT, logName: 'rollback-vitest', parse: parseVitestTotals }),
  ];
  const treeOk = tree === ev.base.tree;
  ev.rollback.treeAfterReverse = tree;
  ev.rollback.gates = gates.map(({ name, command, status, exitCode, summary, logSha256 }) => ({ name, command, status, exitCode, summary, logSha256 }));
  ev.rollback.status = treeOk && gates.every((g) => g.status === STATUS.PASS) ? STATUS.PASS : STATUS.FAIL;
  ev.rollback.detail = `Reverse-applied tree ${tree} ${treeOk ? 'equals' : 'DIFFERS from'} the base tree ${ev.base.tree}. On the rolled-back tree: ${gates.map((g) => `${g.name.replace('rollback: ', '')} ${g.status} (${g.summary})`).join('; ')}.`;
} catch (e) {
  ev.rollback.status = STATUS.FAIL;
  ev.rollback.detail = `Rollback test failed to run: ${String(e.message ?? e).split('\n')[0]}`;
} finally {
  if (fs.existsSync(WT)) git('worktree', 'remove', '--force', WT);
  git('worktree', 'prune');
}

// --- e. charter, report --------------------------------------------------------------------
const gateStatuses = ev.gates.map((g) => g.status);
const failed = ev.gates.filter((g) => g.status === STATUS.FAIL).map((g) => g.name);
ev.charter = [
  { id: 1, item: 'All gates green on the head SHA (lint, typecheck, unit + integration tests, migrations up/down where defined, build)', status: gatesItemStatus(gateStatuses),
    evidence: failed.length ? `FAILED: ${failed.join(', ')}` : `${ev.gates.filter((g) => g.status === STATUS.PASS).length} PASS, ${ev.gates.filter((g) => g.status === STATUS.NA).length} N/A, ${ev.gates.filter((g) => g.status === STATUS.NOT_RUN).length} NOT RUN (see Known gaps)` },
  { id: 2, item: 'Challenger re-review passed with zero open High findings', status: STATUS.PENDING, evidence: 'Review link: <to be added by the orchestrator>' },
  { id: 3, item: 'Operational evidence complete (exact commands, results, fixture provenance, known gaps)', status: provenanceOk ? STATUS.PASS : STATUS.FAIL,
    evidence: `Commands, exit codes, durations and log hashes below; ${ev.fixtures.files.length} changed fixture file(s) recomputed with BigInt, determinism ${ev.fixtures.determinism.map((d) => d.status).join('/') || 'N/A'}; ${ev.knownGaps.length} known gap(s) listed` },
  { id: 4, item: 'Rollback verified in test (procedure + result)', status: ev.rollback.status, evidence: 'See "Rollback in test"' },
  { id: 5, item: 'Merge decision logged with reasoning in the PR body', status: STATUS.PENDING, evidence: 'Decision: <to be written by the orchestrator in the PR body>' },
];
fs.mkdirSync(OUT, { recursive: true });
const json = { ...ev, gates: ev.gates.map(({ tail, ...g }) => ({ ...g, tail })) };
fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(json, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'evidence.md'), renderEvidenceMd(ev));
say(`wrote ${path.relative(ROOT, OUT)}/evidence.md and evidence.json`);
process.exit(failed.length || !provenanceOk || ev.rollback.status === STATUS.FAIL ? 1 : 0);
