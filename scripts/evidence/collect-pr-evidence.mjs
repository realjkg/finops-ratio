#!/usr/bin/env node
// Re-runnable merge evidence for a PR, in the shape the orchestrator charter asks for. Non-gating tooling:
// it changes no CI workflow or governance file and adds no dependency.
//
//   node scripts/evidence/collect-pr-evidence.mjs --base <sha|ref> --head <sha> --pr <n>
//        [--out dir] [--logs dir] [--port n] [--gate-timeout minutes] [--migration-smoke] [--plan-only]
//
// Runs in the current directory (the checkout under test), so it can be run from another checkout
// (mac-evidence.sh does). Refuses (exit 3) unless the tree is clean, HEAD equals --head, the ports are
// free and no evidence rollback worktree is left over. Every diff, fixture, migration and rollback check
// uses git merge-base(base, head). Gates run as argv steps (no shell) with an ENVIRONMENT ALLOWLIST: the
// PR's code never sees the caller's other variables. Explicit inputs (all optional):
//   RATIO_EVIDENCE_TEST_DATABASE_URL, RATIO_EVIDENCE_S3_ENDPOINT, RATIO_EVIDENCE_PG_DUMP, RATIO_EVIDENCE_PSQL  -> test:db
//   RATIO_EVIDENCE_SCRATCH_DATABASE_URL  -> migration checks ONLY (loopback host, database ratio_evidence_*,
//                                           never when RATIO_ENV/NODE_ENV is production)
//   RATIO_EVIDENCE_CHROMIUM              -> browser outside Playwright's own install
// The full-set migration smoke is opt-in (--migration-smoke). Playwright gates get a SHORT temp dir
// (/tmp/rpe.XXXXXX; Chromium's socket path must fit sun_path) after a Chromium launch preflight. Logs go to
// <out>/logs (--logs to override); the running gate's process group is recorded in <logs>/current-gate.pgid
// so a supervisor can stop it if this process is killed with SIGKILL (gates run detached in their own group).
// Secrets are redacted field by field before serialization, then the JSON and its SHA fields are verified.
// The full-set migration smoke is opt-in (--migration-smoke). Writes evidence.md and evidence.json;
// exit 1 if any required gate or check FAILS, 2 on a usage error, 3 when it refuses to run. It never marks
// the challenger re-review or the merge decision PASS: those are the orchestrator's.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { setTimeout, clearTimeout } from 'node:timers';
import {
  EXIT, STATUS, browserPlan, classifyGate, compareControlTotals, dbTestPlan, determinismStatus, fixtureRows, gateEnv, gatesItemStatus, integrityProblems, migrationEnv, migrationTarget, redactDeep, syntheticExportTotals,
  parseArgs, parsePlaywrightTotals, parseVitestTotals, redact, renderEvidenceMd, rollbackStatus, secretsFromEnv, statedTotals, stripAnsi,
  totalsByCurrency, totalsMatch,
} from './evidenceLib.mjs';

const ROOT = process.cwd();
const SELF = fileURLToPath(import.meta.url);
const say = (m) => process.stdout.write(`${m}\n`);
const stop = (code, m) => { process.stderr.write(`collect-pr-evidence: ${m}\n`); process.exit(code); };
const parsed = parseArgs(process.argv.slice(2));
if (parsed.error) stop(EXIT.USAGE, `${parsed.error}\nusage: --base <sha|ref> --head <sha> --pr <n> [--out dir] [--logs dir] [--port n] [--gate-timeout min] [--migration-smoke] [--plan-only]`);
const args = parsed.args;
const PLAN_ONLY = Boolean(args['plan-only']);
const SECRETS = secretsFromEnv(process.env);
const GIT_SAFE = ['-c', 'color.ui=never', '-c', 'core.autocrlf=false', '-c', 'diff.noprefix=false', '-c', 'core.quotepath=false'];
const git = (...a) => execFileSync('git', [...GIT_SAFE, ...a], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const TIMEOUT_MIN = Number(args['gate-timeout'] ?? 60);

function collectorProvenance() {
  const dir = path.dirname(SELF);
  let commit = null;
  try { commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a checkout */ }
  const file = (n) => sha256(fs.readFileSync(path.join(dir, n)));
  return { commit, script: file('collect-pr-evidence.mjs'), lib: file('evidenceLib.mjs') };
}
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

// --- a. preflight (refusals exit 3) --------------------------------------------------------
let headSha, baseSha;
try {
  headSha = git('rev-parse', '--verify', '--end-of-options', `${args.head}^{commit}`);
  baseSha = git('rev-parse', '--verify', '--end-of-options', `${args.base}^{commit}`);
} catch { stop(EXIT.REFUSED, 'cannot resolve --base or --head in this checkout'); }
if (git('status', '--porcelain')) stop(EXIT.REFUSED, 'working tree is not clean (commit or stash first)');
if (git('rev-parse', 'HEAD') !== headSha) stop(EXIT.REFUSED, `HEAD is not --head (${headSha}); check out that commit first`);
const leftover = git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ') && /ratio-evidence-rollback-/.test(l)).map((l) => l.slice(9));
if (leftover.length) stop(EXIT.REFUSED, `a previous evidence rollback worktree is still registered: ${leftover.join(', ')}\nfix: ${leftover.map((p) => `git worktree remove --force ${JSON.stringify(p)}`).join('; ')}; git worktree prune`);
const port = Number(args.port ?? 3410);
for (const p of [port, port + 1]) if (!(await portFree(p))) stop(EXIT.REFUSED, `port ${p} is in use (the Playwright suites need --port and --port+1); pass --port <free port>`);
const mergeBase = git('merge-base', baseSha, headSha);
const OUT = path.resolve(args.out ?? `docs/evidence/pr-${args.pr}`);

const ev = {
  schema: 'ratio.pr-evidence/2', pr: Number(args.pr), generatedAt: new Date().toISOString(),
  command: `node ${path.relative(ROOT, SELF) || SELF} ${process.argv.slice(2).join(' ')}`,
  collector: collectorProvenance(),
  env: { node: process.version, npm: execFileSync('npm', ['-v'], { encoding: 'utf8' }).trim(), os: `${os.type()} ${os.release()} ${os.arch()}`, gateEnvKeys: Object.keys(gateEnv(process.env)).sort() },
  base: { ref: args.base, sha: baseSha, tree: git('rev-parse', `${baseSha}^{tree}`) },
  mergeBase: { sha: mergeBase, tree: git('rev-parse', `${mergeBase}^{tree}`) },
  head: { sha: headSha, tree: git('rev-parse', `${headSha}^{tree}`) },
  evidenceCommitNote: `This file attests code SHA \`${headSha}\`. A commit that adds it must change only \`${path.relative(ROOT, OUT)}/\`.`,
  gates: [], informational: [], fixtures: { files: [], determinism: [] }, rollback: {}, knownGaps: [], charter: [],
};
if (baseSha !== mergeBase) ev.knownGaps.push(`--base ${baseSha} is not the merge-base; all checks used the merge-base ${mergeBase}.`);

// --- b. the gate plan ----------------------------------------------------------------------
const MIG_DIR = 'src/ingest/db/migrations';
const migrations = git('diff', '--name-only', mergeBase, headSha, '--', MIG_DIR).split('\n').filter(Boolean);
const allMigrations = fs.existsSync(path.join(ROOT, MIG_DIR)) ? fs.readdirSync(path.join(ROOT, MIG_DIR)).filter((f) => f.endsWith('.up.sql')).length : 0;
const migrateSteps = (n) => [['npm', 'run', '-s', 'worker:build'], ['npm', 'run', '-s', 'worker', '--', 'migrate'], ['npm', 'run', '-s', 'worker', '--', 'migrate', '--down', String(n)], ['npm', 'run', '-s', 'worker', '--', 'migrate'], ['npm', 'run', '-s', 'worker', '--', 'migrate', '--status', '--json']];
const target = migrationTarget(process.env);
const db = dbTestPlan(process.env);
let managed = null;
try { managed = execFileSync('node', ['-e', "process.stdout.write(require('playwright-core').chromium.executablePath())"], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* no playwright-core yet */ }
const browser = browserPlan(process.env, managed, (p) => fs.existsSync(p));
const base = gateEnv(process.env);
const vitest = (o) => ({ parse: parseVitestTotals, ...o });
const plan = [
  { name: 'npm ci', steps: [['npm', 'ci']], env: base },
  { name: 'lint', steps: [['npm', 'run', 'lint']], env: base },
  { name: 'typecheck (app)', steps: [['npx', 'tsc', '--noEmit']], env: base },
  { name: 'typecheck (worker)', steps: [['npx', 'tsc', '-p', 'tsconfig.worker.json', '--noEmit']], env: base },
  vitest({ name: 'unit tests (vitest)', steps: [['npx', 'vitest', 'run', '--cache=false']], env: base }),
  db.run ? vitest({ name: 'integration tests (Postgres)', steps: [['npm', 'run', 'test:db']], env: base }) : { name: 'integration tests (Postgres)', command: 'npm run test:db', skip: db.reason },
  !migrations.length ? { name: 'migrations up/down/up (changed)', command: '(none)', na: 'N/A: no migrations changed' }
    : target.ok ? { name: 'migrations up/down/up (changed)', steps: migrateSteps(new Set(migrations.map((f) => path.basename(f).split('_')[0])).size), env: migrationEnv(process.env), db: target.db }
      : { name: 'migrations up/down/up (changed)', command: 'worker migrate; migrate --down N; migrate', skip: `NOT RUN: ${migrations.length} migration file(s) changed; ${target.reason}` },
  { name: 'build', steps: [['npm', 'run', 'build']], env: base },
  { name: 'bundle check', steps: [['npm', 'run', 'check:bundle']], env: base },
  ...(browser.env ? [
    { name: 'Playwright simulation suite', browser: true, steps: [['npx', 'playwright', 'test', '--config', 'playwright.simulation.config.ts']], env: { ...base, ...browser.env, RATIO_TEST_PORT: String(port) }, parse: parsePlaywrightTotals },
    { name: 'Playwright engagement report spec', browser: true, steps: [['npx', 'playwright', 'test', '--config', 'playwright.engagement.config.ts']], env: { ...base, ...browser.env, RATIO_TEST_NEXT_DIR: `.next-simulation-${port}`, RATIO_ENGAGEMENT_TEST_PORT: String(port + 1) }, parse: parsePlaywrightTotals },
  ] : [
    { name: 'Playwright simulation suite', command: 'npx playwright test --config playwright.simulation.config.ts', skip: browser.reason },
    { name: 'Playwright engagement report spec', command: 'npx playwright test --config playwright.engagement.config.ts', skip: browser.reason },
  ]),
];
const informational = !args['migration-smoke'] ? [{ name: 'migrations smoke, full set (informational)', command: '(opt-in: --migration-smoke)', na: 'N/A: not requested (--migration-smoke)' }]
  : target.ok ? [{ name: 'migrations smoke, full set (informational)', steps: migrateSteps(allMigrations), env: migrationEnv(process.env), db: target.db }]
    : [{ name: 'migrations smoke, full set (informational)', command: 'worker migrate; migrate --down ALL; migrate', na: `N/A (informational): ${target.reason}` }];
if (browser.env) ev.env.browser = browser.source;
if (PLAN_ONLY) {
  const show = (g) => ({ name: g.name, command: g.command ?? g.steps.map((a) => a.join(' ')).join(' && '), envKeys: g.env ? Object.keys(g.env).sort() : null, skip: g.skip ?? null, na: g.na ?? null, db: g.db ?? null });
  say(JSON.stringify({ head: headSha, base: baseSha, mergeBase, migrationsChanged: migrations.length, gates: plan.map(show), informational: informational.map(show) }, null, 2));
  process.exit(EXIT.OK);
}

// --- running gates (async, so INT/TERM are handled promptly) --------------------------------
// Logs live under the output directory (gitignored as docs/evidence/pr-*/logs/ in this repo), not in OS tmp.
const LOGS = path.resolve(args.logs ?? path.join(OUT, 'logs'));
fs.mkdirSync(LOGS, { recursive: true });
// The running gate's process group, also written to a file so a supervisor (mac-evidence.sh) can kill it
// if this process itself is killed with SIGKILL (a detached group would otherwise be orphaned).
const PGID_FILE = path.join(LOGS, 'current-gate.pgid');
let child = null;
let WT = null;
let SHORT_TMP = null;
let interrupted = null;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
function removeWorktree() {
  if (!WT) return;
  try { git('worktree', 'remove', '--force', WT); } catch { /* not registered */ }
  try { fs.rmSync(WT, { recursive: true, force: true }); } catch { /* reported below by the leftover check of the next run */ }
  try { git('worktree', 'prune'); } catch { /* ignore */ }
  WT = null;
}
function removeShortTmp() {
  if (!SHORT_TMP) return;
  try { fs.rmSync(SHORT_TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(LOGS, 'short-tmp.path'), { force: true }); } catch { /* ignore */ }
  SHORT_TMP = null;
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    interrupted = sig;
    if (child) {
      const pid = child.pid;
      try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
      // Wait (bounded) for the group to exit before deleting files it may still be using.
      for (let i = 0; i < 50 && alive(pid); i++) sleepSync(100);
      if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    removeWorktree();
    removeShortTmp();
    try { fs.rmSync(PGID_FILE, { force: true }); } catch { /* ignore */ }
    process.stderr.write(`collect-pr-evidence: interrupted (${sig}); gate stopped, worktree removed, no evidence written\n`);
    process.exit(130);
  });
}
function step(argv, cwd, env, fd, timeoutMs) {
  return new Promise((resolve) => {
    let timedOut = false;
    let c;
    try { c = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', fd, fd], detached: true }); } catch (e) { resolve({ code: null, spawnError: e.code ?? e.message }); return; }
    child = c;
    try { fs.writeFileSync(PGID_FILE, String(c.pid)); } catch { /* best effort */ }
    const t = setTimeout(() => { timedOut = true; try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    const done = () => { clearTimeout(t); child = null; try { fs.rmSync(PGID_FILE, { force: true }); } catch { /* ignore */ } };
    c.once('error', (e) => { done(); resolve({ code: null, spawnError: e.code ?? e.message }); });
    c.once('exit', (code, signal) => { done(); resolve({ code, signal: timedOut ? null : signal, timedOut }); });
  });
}
async function run(g, cwd = ROOT, logName = g.name) {
  const log = path.join(LOGS, `${logName.replace(/[^\w.-]+/g, '_')}.log`);
  const fd = fs.openSync(log, 'w');
  const start = new Date();
  let r = { code: 0 };
  for (const argv of g.steps) {
    fs.writeSync(fd, `$ ${argv.join(' ')}\n`);
    r = await step(argv, cwd, g.env, fd, TIMEOUT_MIN * 60_000);
    if (r.code !== 0) break;
  }
  fs.closeSync(fd);
  const end = new Date();
  fs.writeFileSync(log, redact(fs.readFileSync(log, 'utf8'), SECRETS)); // no secret stays in a log, a tail or the report
  const text = fs.readFileSync(log);
  const plain = stripAnsi(text.toString('utf8'));
  const totals = g.parse ? g.parse(plain) : null;
  const out = { name: g.name, command: g.steps.map((a) => a.join(' ')).join(' && '), cwd: path.relative(ROOT, cwd) || '.', ran: true, exitCode: r.code, signal: r.signal ?? null, timedOut: Boolean(r.timedOut), timeoutMin: TIMEOUT_MIN, spawnError: r.spawnError ?? null,
    start: start.toISOString(), end: end.toISOString(), durationSec: Math.round((end - start) / 100) / 10, log: path.relative(ROOT, log), logSha256: sha256(text),
    tail: plain.split('\n').slice(-41).join('\n').trimEnd(), totals, expectTotals: Boolean(g.parse), db: g.db ?? null };
  Object.assign(out, classifyGate(out));
  out.summary = totals?.kind === 'vitest' ? `${totals.files.passed}/${totals.files.total} files, ${totals.tests.passed} passed, ${totals.tests.failed} failed, ${totals.tests.skipped} skipped`
    : totals ? `${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped, ${totals.flaky} flaky` : r.spawnError ? 'spawn error' : `exit ${r.code}`;
  say(`${out.status.padEnd(8)} ${g.name} (${out.durationSec}s)${out.note ? ` — ${out.note}` : ''}`);
  return out;
}
function notRun(g, gaps = true) {
  const reason = g.na ?? g.skip;
  const out = { name: g.name, command: g.command, ran: false, na: Boolean(g.na), exitCode: null, durationSec: null, summary: reason };
  Object.assign(out, classifyGate(out));
  if (!g.na && gaps) ev.knownGaps.push(`${g.name}: ${reason}`);
  say(`${out.status.padEnd(8)} ${g.name}: ${reason}`);
  return out;
}
// Chromium's singleton socket lives under TMPDIR and must fit sun_path (104 bytes on macOS), so the browser
// gates get a SHORT temp dir of their own (/tmp/rpe.XXXXXX, removed by exact path); other gates keep TMPDIR.
const LAUNCH_CHECK = "const { chromium } = require('playwright-core'); const p = process.env.RATIO_CHROMIUM_PATH;"
  + " chromium.launch({ headless: true, ...(p ? { executablePath: p, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) })"
  + ".then((b) => b.close()).then(() => process.exit(0), (e) => { console.error('launch failed: ' + String(e.message).split('\\n')[0]); process.exit(1); });";
let browserCheck = null;
for (const g of plan) {
  if (g.browser && g.steps) {
    if (!browserCheck) {
      const tmpRoot = (() => { try { fs.accessSync('/tmp', fs.constants.W_OK); return '/tmp'; } catch { return os.tmpdir(); } })();
      SHORT_TMP = fs.mkdtempSync(path.join(tmpRoot, 'rpe.'));
      try { fs.writeFileSync(path.join(LOGS, 'short-tmp.path'), SHORT_TMP); } catch { /* best effort, for a supervisor's cleanup */ }
      const check = await run({ name: 'Chromium launch preflight', steps: [['node', '-e', LAUNCH_CHECK]], env: { ...g.env, TMPDIR: SHORT_TMP } }, ROOT, 'chromium-launch');
      ev.informational.push(check);
      browserCheck = check.status === STATUS.PASS ? { ok: true } : { ok: false, reason: `NOT RUN: Chromium did not launch (${(check.tail.split('\n').find((l) => /launch failed|Error/.test(l)) ?? check.summary).slice(0, 200)})` };
    }
    if (!browserCheck.ok) { ev.gates.push(notRun({ name: g.name, command: g.steps.map((a) => a.join(' ')).join(' && '), skip: browserCheck.reason })); continue; }
    ev.gates.push(await run({ ...g, env: { ...g.env, TMPDIR: SHORT_TMP } }));
    continue;
  }
  ev.gates.push(g.steps ? await run(g) : notRun(g));
}
removeShortTmp();
for (const g of informational) ev.informational.push(g.steps ? await run(g) : notRun(g, false));
if (git('status', '--porcelain', '--', 'next-env.d.ts')) { git('checkout', '--', 'next-env.d.ts'); ev.knownGaps.push('next-env.d.ts was rewritten by the Playwright build (its distDir) and restored from HEAD after the run.'); }

// --- c. fixture provenance -----------------------------------------------------------------
const FIXTURE_DIRS = ['fixtures', 'src/demo/apiDatasets/data'];
const GENERATORS = [
  { dir: 'src/demo/apiDatasets/data/', argv: ['npx', 'tsx', 'scripts/generate-demo-datasets.ts'] },
  { dir: 'fixtures/focus-1.0-synthetic/', argv: ['npx', 'tsx', 'scripts/generate-focus-fixture.ts'] },
];
const inflate = (p, buf) => (p.endsWith('.gz') ? zlib.gunzipSync(buf) : buf);
const blob = (rev, p) => { try { return execFileSync('git', ['show', `${rev}:${p}`], { cwd: ROOT, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const changedFixtures = git('diff', '--name-only', mergeBase, headSha, '--', ...FIXTURE_DIRS).split('\n').filter(Boolean);
let provenanceOk = true;
for (const p of changedFixtures) {
  const f = { path: p };
  const baseBuf = blob(mergeBase, p);
  const headBuf = fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p)) : null;
  f.baseSha256 = baseBuf ? sha256(baseBuf) : null;
  f.headSha256 = headBuf ? sha256(headBuf) : null;
  try {
    const side = (buf) => {
      if (!buf) return null;
      const text = inflate(p, buf).toString('utf8');
      const rows = fixtureRows(p, text);
      return rows ? { rows: rows.length, totals: totalsByCurrency(rows), stated: statedTotals(p, text) } : null;
    };
    const b = side(baseBuf), h = side(headBuf);
    f.tabular = Boolean(h);
    if (h) {
      f.baseRows = b?.rows ?? null; f.headRows = h.rows; f.baseTotals = b?.totals ?? null; f.headTotals = h.totals;
      if (h.stated) { f.matchesStated = totalsMatch(h.stated, h.totals) ? 'yes' : 'NO'; if (f.matchesStated === 'NO') { provenanceOk = false; f.error = 'recomputed totals differ from the stated control totals'; } }
      if (b) f.totalsUnchanged = JSON.stringify(b.totals) === JSON.stringify(h.totals) && b.rows === h.rows ? 'yes' : 'no (changed)';
    }
  } catch (e) { f.error = String(e.message ?? e); provenanceOk = false; }
  ev.fixtures.files.push(f);
}
// The synthetic export: recompute every period from ALL its .csv.gz files at head and compare with control-totals.json.
const SYN = 'fixtures/focus-1.0-synthetic/';
if (changedFixtures.some((p) => p.startsWith(SYN)) && fs.existsSync(path.join(ROOT, SYN, 'control-totals.json'))) {
  try {
    const files = git('ls-files', '--', `${SYN}*.csv.gz`).split('\n').filter(Boolean).map((p) => ({ path: p, text: inflate(p, fs.readFileSync(path.join(ROOT, p))).toString('utf8') }));
    const computed = syntheticExportTotals(files);
    const problems = compareControlTotals(computed, JSON.parse(fs.readFileSync(path.join(ROOT, SYN, 'control-totals.json'), 'utf8')));
    ev.fixtures.controlTotals = { file: `${SYN}control-totals.json`, status: problems.length ? STATUS.FAIL : STATUS.PASS, problems, computed,
      summary: Object.entries(computed).map(([v, ps]) => `${v}: ${Object.entries(ps).map(([k, t]) => `${k} ${t.rowCount} rows ${t.billedTotal}`).join(', ')}`).join('; ') };
    if (problems.length) provenanceOk = false;
  } catch (e) { ev.fixtures.controlTotals = { file: `${SYN}control-totals.json`, status: STATUS.FAIL, problems: [String(e.message ?? e)], summary: '' }; provenanceOk = false; }
}
for (const g of GENERATORS.filter((x) => changedFixtures.some((p) => p.startsWith(x.dir)))) {
  const r = await run({ name: `determinism: ${g.argv.join(' ')}`, steps: [g.argv], env: base }, ROOT, `determinism-${g.dir}`);
  // .gz bytes depend on the local zlib build: a gz file whose decompressed content is identical is not a change.
  const changed = git('diff', '--name-only', '--', g.dir).split('\n').filter(Boolean)
    .filter((p) => !(p.endsWith('.gz') && blob('HEAD', p) && fs.existsSync(path.join(ROOT, p)) && inflate(p, blob('HEAD', p)).equals(inflate(p, fs.readFileSync(path.join(ROOT, p))))));
  const untracked = git('status', '--porcelain', '--untracked-files=all', '--', g.dir).split('\n').filter((l) => l.startsWith('??'));
  const status = determinismStatus({ gate: r.status, trackedDiff: changed.length > 0, untracked: untracked.length > 0 });
  ev.fixtures.determinism.push({ command: `${r.command}; git diff (decompressed for .gz) and untracked check on ${g.dir}`, status, detail: status === STATUS.PASS ? null : [r.note, changed.length && `changed: ${changed.join(', ')}`, untracked.length && `untracked: ${untracked.length}`].filter(Boolean).join('; '), logSha256: r.logSha256 });
  if (status !== STATUS.PASS) provenanceOk = false;
  git('checkout', '--', g.dir); git('clean', '-fdq', '--', g.dir);
}

// --- d. rollback in test (worktree outside the checkout) ------------------------------------
const patch = path.join(LOGS, 'pr.diff');
const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--binary', '--src-prefix=a/', '--dst-prefix=b/', mergeBase, headSha];
fs.writeFileSync(patch, execFileSync('git', [...GIT_SAFE, ...DIFF], { cwd: ROOT, maxBuffer: 1 << 30 }));
ev.rollback.procedure = `Test: a temporary worktree at ${headSha} under the OS temp directory (outside the checkout); \`git ${DIFF.join(' ')} > pr.diff\`; in the worktree \`git apply -R --binary pr.diff && git add -A && git write-tree\` (git -c color.ui=never -c core.autocrlf=false); compare with the merge-base tree; then lint, typecheck (app and worker) and the full vitest suite there; the worktree is removed by exact path (also on INT/TERM).`;
ev.rollback.production = `after merge, \`git revert -m 1 <merge sha>\` (merge commit) or \`git revert <squash sha>\` (squash), or reverse-apply \`git diff ${mergeBase} ${headSha}\` with \`git apply -R\`; no data, schema or config migration needs undoing${migrations.length ? ' EXCEPT the changed migrations, which need their down migration' : ''}.`;
try {
  WT = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-evidence-rollback-'));
  git('worktree', 'add', '--quiet', '--detach', WT, headSha);
  execFileSync('git', [...GIT_SAFE, 'apply', '-R', '--binary', '--whitespace=nowarn', patch], { cwd: WT });
  execFileSync('git', ['add', '-A'], { cwd: WT });
  const tree = execFileSync('git', ['write-tree'], { cwd: WT, encoding: 'utf8' }).trim();
  const sameLock = git('rev-parse', `${mergeBase}:package-lock.json`) === git('rev-parse', `${headSha}:package-lock.json`);
  if (sameLock) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(WT, 'node_modules'), 'dir');
  const gates = [];
  gates.push(await run({ name: 'rollback: dependencies', steps: [sameLock ? ['ls', 'node_modules/.bin/vitest'] : ['npm', 'ci']], env: base }, WT, 'rollback-deps'));
  gates.push(await run({ name: 'rollback: lint', steps: [['npm', 'run', 'lint']], env: base }, WT, 'rollback-lint'));
  gates.push(await run({ name: 'rollback: typecheck', steps: [['npx', 'tsc', '--noEmit'], ['npx', 'tsc', '-p', 'tsconfig.worker.json', '--noEmit']], env: base }, WT, 'rollback-typecheck'));
  gates.push(await run(vitest({ name: 'rollback: unit tests', steps: [['npx', 'vitest', 'run', '--cache=false']], env: base }), WT, 'rollback-vitest'));
  ev.rollback.treeAfterReverse = tree;
  ev.rollback.gates = gates.map(({ name, command, status, note, exitCode, summary, logSha256 }) => ({ name, command, status, note, exitCode, summary, logSha256 }));
  ev.rollback.status = rollbackStatus({ tree, baseTree: ev.mergeBase.tree, gates: gates.map((g) => g.status) });
  ev.rollback.detail = `Reverse-applied tree ${tree} ${tree === ev.mergeBase.tree ? 'equals' : 'DIFFERS from'} the merge-base tree ${ev.mergeBase.tree}. On the rolled-back tree: ${gates.map((g) => `${g.name.replace('rollback: ', '')} ${g.status} (${g.summary})`).join('; ')}.`;
} catch (e) {
  ev.rollback.status = STATUS.FAIL;
  ev.rollback.detail = `Rollback test failed to run: ${redact(String(e.message ?? e).split('\n')[0], SECRETS)}`;
} finally { removeWorktree(); }
if (interrupted) process.exit(130);

// --- e. charter, report --------------------------------------------------------------------
const failed = ev.gates.filter((g) => g.status === STATUS.FAIL).map((g) => g.name);
ev.charter = [
  { id: 1, item: 'All gates green on the head SHA (lint, typecheck, unit + integration tests, migrations up/down where defined, build)', status: gatesItemStatus(ev.gates.map((g) => g.status)),
    evidence: failed.length ? `FAILED: ${failed.join(', ')}` : `${ev.gates.filter((g) => g.status === STATUS.PASS).length} PASS, ${ev.gates.filter((g) => g.status === STATUS.NA).length} N/A, ${ev.gates.filter((g) => g.status === STATUS.NOT_RUN).length} NOT RUN (see Known gaps)` },
  { id: 2, item: 'Challenger re-review passed with zero open High findings', status: STATUS.PENDING, evidence: 'Review link: <to be added by the orchestrator>' },
  { id: 3, item: 'Operational evidence complete (exact commands, results, fixture provenance, known gaps)', status: provenanceOk ? STATUS.PASS : STATUS.FAIL,
    evidence: `Commands, exit codes, durations and log hashes below; ${ev.fixtures.files.length} changed fixture file(s) recomputed with BigInt${ev.fixtures.files.some((f) => f.error) ? ' (errors listed per file)' : ''}, determinism ${ev.fixtures.determinism.map((d) => d.status).join('/') || 'N/A'}; ${ev.knownGaps.length} known gap(s) listed` },
  { id: 4, item: 'Rollback verified in test (procedure + result)', status: ev.rollback.status, evidence: 'See "Rollback in test"' },
  { id: 5, item: 'Merge decision logged with reasoning in the PR body', status: STATUS.PENDING, evidence: 'Decision: <to be written by the orchestrator in the PR body>' },
];
fs.mkdirSync(OUT, { recursive: true });
// Redact field by field BEFORE serializing (numbers, booleans and SHAs cannot be touched), then verify.
const safe = redactDeep(ev, SECRETS);
const json = JSON.stringify(safe, null, 2) + '\n';
const problems = integrityProblems(ev, safe, json);
if (problems.length) stop(EXIT.GATE_FAILED, `refusing to write evidence: ${problems.join('; ')}`);
fs.writeFileSync(path.join(OUT, 'evidence.json'), json);
fs.writeFileSync(path.join(OUT, 'evidence.md'), renderEvidenceMd(safe));
say(`wrote ${path.relative(ROOT, OUT) || OUT}/evidence.md and evidence.json (logs: ${LOGS})`);
process.exit(failed.length || !provenanceOk || ev.rollback.status === STATUS.FAIL ? EXIT.GATE_FAILED : EXIT.OK);
