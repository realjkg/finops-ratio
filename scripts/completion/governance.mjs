import process from 'node:process';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { digest } from './core.mjs';
import { acquireLock } from './lock.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(root, '.ratio-build');
const suites = ['src/simulation/server/governance.test.ts', 'src/simulation/server/boundaries.test.ts', 'src/simulation/server/database.test.ts', 'src/simulation/server/storage.test.ts', 'src/outcomes/model.test.ts', 'src/agent-workflows/engine.test.ts', 'src/agent-workflows/frank.test.ts', 'src/costsource/cloudConnectorConfig.test.ts', 'src/costsource/liveClientAuth.test.ts'];
function fingerprint() {
  const names = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root }).toString().split('\0').filter(n => n && n !== 'next-env.d.ts');
  return digest([...new Set(names)].sort().map(n => `${n}\0${fs.existsSync(resolve(root, n)) ? digest(fs.readFileSync(resolve(root, n))) : 'deleted'}`).join('\0'));
}
const read = name => { try { return JSON.parse(fs.readFileSync(resolve(out, name), 'utf8')); } catch { return null; } };
const save = (name, data) => { const target = resolve(out, name); fs.writeFileSync(`${target}.tmp`, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(`${target}.tmp`, target); };
const lock = acquireLock(resolve(out, 'lock'));
try {
  const source = fingerprint();
  if (process.argv.includes('--test')) {
    const log = resolve(out, `governance-${Date.now()}.log`);
    const fd = fs.openSync(log, 'wx', 0o600);
    let result;
    try { result = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', ...suites], { cwd: root, stdio: ['ignore', fd, fd], timeout: 120000 }); }
    finally { fs.closeSync(fd); }
    save('governance.json', { source, at: new Date().toISOString(), status: result.status === 0 && fingerprint() === source ? 'passed' : 'failed', exitCode: result.status, error: result.error?.message, suites, log });
  }
  const latest = read('latest.json'); const governance = read('governance.json');
  const gates = latest?.source === source ? { ...latest.gates } : {};
  gates.governance = governance?.source === source ? governance : { status: 'unverified' };
  const checklist = JSON.parse(fs.readFileSync(new URL('./checklist.json', import.meta.url), 'utf8'));
  const areas = checklist.areas.map(area => ({ ...area,
    missingSources: area.sources.filter(path => !fs.existsSync(resolve(root, path))),
    checks: area.gates.map(gate => ({ gate, status: gates[gate]?.status ?? 'unverified' })),
    productionAccepted: false,
  }));
  const report = { source, at: new Date().toISOString(), productionReady: false, areas, externalTasks: JSON.parse(fs.readFileSync(new URL('./plan.json', import.meta.url), 'utf8')).tasks.filter(t => t.kind === 'external') };
  save('readiness.json', report);
  process.stdout.write(areas.map(a => `${a.title}: ${a.missingSources.length ? 'missing source' : 'source present'}; ${a.checks.map(c => `${c.gate}=${c.status}`).join(', ') || 'external acceptance required'}\n  Remaining: ${a.remaining}`).join('\n') + '\n');
  if (process.argv.includes('--test') && gates.governance.status !== 'passed') process.exitCode = 1;
} finally { lock.release(); }
