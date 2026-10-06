/* global process, console, URL, setTimeout, clearTimeout */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, nextTask, overallStatus, implementationPrompt } from './core.mjs';
import { acquireLock } from './lock.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(root, '.ratio-build');
mkdirSync(out, { recursive: true, mode: 0o700 });
const plan = JSON.parse(readFileSync(new URL('./plan.json', import.meta.url), 'utf8'));
const definitions = {
  lint: ['npm', 'run', 'lint'], types: ['npm', 'run', 'typecheck'], unit: ['npm', 'test'],
  build: ['npm', 'run', 'build'], bundle: ['npm', 'run', 'check:bundle'],
  browser: ['npm', 'run', 'simulation:test'],
  containers: ['docker', 'compose', '-f', 'infrastructure/simulation/compose.yaml', 'config', '--quiet'],
  database: ['npm', 'run', 'test:db'],
};
const args = process.argv.slice(2);
const selected = args.find(a => a.startsWith('--gates='))?.slice(8).split(',') ?? ['lint', 'types', 'unit', 'build', 'bundle', 'browser'];
if (selected.some(id => !Object.hasOwn(definitions, id))) throw new Error('Unknown verification gate.');
const implement = args.includes('--implement');
const agent = process.env.RATIO_BUILD_AGENT_ARGV ? JSON.parse(process.env.RATIO_BUILD_AGENT_ARGV) : null;
if (agent && (!Array.isArray(agent) || !agent.length || agent.some(x => typeof x !== 'string' || !x))) throw new Error('RATIO_BUILD_AGENT_ARGV must be a nonempty JSON argv array.');
function fingerprint() {
  const names = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root }).toString().split('\0').filter(name => name && name !== 'next-env.d.ts');
  return digest([...new Set(names)].sort().map(name => `${name}\0${existsSync(resolve(root, name)) ? digest(readFileSync(resolve(root, name))) : 'deleted'}`).join('\0'));
}
function save(name, value) {
  const file = resolve(out, name), temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, file);
}
let interrupted = false;
function run(argv, logfile, input, timeout = 600000, env = {}) {
  return new Promise(resolveResult => {
    const fd = openSync(logfile, 'w', 0o600);
    const child = spawn(argv[0], argv.slice(1), { cwd: root, shell: false, detached: process.platform !== 'win32', env: { ...process.env, ...env }, stdio: ['pipe', fd, fd] });
    let expired = false;
    const kill = () => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ } };
    const timer = setTimeout(() => { expired = true; kill(); }, timeout);
    const interrupt = () => { interrupted = true; expired = true; kill(); };
    process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    let settled = false;
    const finish = (code, error) => { if (settled) return; settled = true; clearTimeout(timer); closeSync(fd); process.off('SIGTERM', interrupt); process.off('SIGINT', interrupt); resolveResult({ status: expired ? 'failed' : error?.code === 'ENOENT' ? 'blocked' : code === 0 ? 'passed' : 'failed', exitCode: code, reason: expired ? 'Timed out or interrupted.' : error ? 'Required executable unavailable.' : undefined }); };
    child.on('error', error => finish(null, error)); child.on('close', code => finish(code));
  });
}
let lock;
try { lock = acquireLock(resolve(out, 'lock')); }
catch (error) { console.error(error.message); process.exit(2); }
try {
  for (let iteration = 1; iteration <= (implement ? 3 : 1); iteration++) {
    const before = fingerprint();
    const previous = existsSync(resolve(out, 'latest.json')) ? JSON.parse(readFileSync(resolve(out, 'latest.json'), 'utf8')) : null;
    const report = { version: 1, source: before, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(), at: new Date().toISOString(), iteration, gates: previous?.source === before ? previous.gates : {} };
    const logs = resolve(out, `logs/${Date.now()}-${before.slice(0, 12)}-${iteration}`);
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    for (const id of selected) {
      if (interrupted) { report.gates[id] = { status: 'blocked', reason: 'Verification interrupted.' }; continue; }
      const log = resolve(logs, `${id}.log`);
      if (['bundle', 'browser'].includes(id) && report.gates.build?.status !== 'passed') { report.gates[id] = { status: 'blocked', reason: 'A passing build for this source is required.' }; continue; }
      if (id === 'database' && !process.env.RATIO_TEST_DATABASE_URL) { report.gates[id] = { status: 'blocked', reason: 'Disposable PostgreSQL/S3 dev environment is not configured.' }; continue; }
      const result = await run(definitions[id], log, undefined, 600000, id === 'browser' ? { RATIO_TEST_SKIP_BUILD: '1', RATIO_TEST_NEXT_DIR: '.next' } : {});
      // Parsing a compose file is a prerequisite, never proof of runtime recovery.
      report.gates[id] = id === 'containers' && result.status === 'passed' ? { status: 'blocked', reason: 'Compose parses; container restart/persistence/worker smoke acceptance is still required.', log } : { ...result, log };
      console.log(`${id}: ${report.gates[id].status}`);
      save('latest.json', report);
    }
    // Evidence cannot certify source that changed while the checks were running.
    const after = fingerprint();
    if (after !== before) {
      report.gates = Object.fromEntries(selected.map(id => [id, { status: 'blocked', reason: 'Source changed during verification; rerun for the new source.' }]));
      report.source = after;
    }
    report.status = overallStatus(plan, report.gates);
    const task = nextTask(plan, report.gates);
    save('latest.json', report); save('next-task.json', { task, source: report.source, status: report.status });
    if (interrupted || !implement || !task || task.kind === 'external') { process.exitCode = report.status === 'complete' ? 0 : 2; break; }
    if (iteration === 3) { report.implementation = { status: 'blocked', reason: 'Iteration budget reached; all implemented changes have been verified. Resume the next task in a later run.' }; save('latest.json', report); process.exitCode = 2; break; }
    if (!agent) { report.implementation = { status: 'blocked', reason: 'No implementation agent configured. A scheduled Codex turn can implement next-task.json using its native code tools.' }; save('latest.json', report); process.exitCode = 2; break; }
    const result = await run(agent, resolve(logs, 'implementation.log'), implementationPrompt(task, report), 1200000);
    if (result.status !== 'passed' || fingerprint() === report.source) { report.implementation = { status: 'blocked', reason: result.status !== 'passed' ? 'Implementation agent failed; inspect its log.' : 'Implementation made no source change. Stop instead of repeating the same failure.' }; save('latest.json', report); process.exitCode = 2; break; }
    process.exitCode = 2;
  }
} finally { lock.release(); }
