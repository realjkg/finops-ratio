/* global process */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
function fixture(change = true) {
  const root = mkdtempSync(join(tmpdir(), 'ratio-build-loop-'));
  mkdirSync(join(root, 'scripts/completion'), { recursive: true }); mkdirSync(join(root, 'bin'));
  for (const name of ['run.mjs', 'core.mjs', 'lock.mjs']) copyFileSync(resolve('scripts/completion', name), join(root, 'scripts/completion', name));
  writeFileSync(join(root, '.gitignore'), '.ratio-build/\n');
  writeFileSync(join(root, 'scripts/completion/plan.json'), JSON.stringify({ tasks: [{ id: 'repair', title: 'Repair real source', kind: 'automated', gates: ['lint'], instruction: 'Write repaired.txt' }, { id: 'release', kind: 'external', requires: 'Explicit release approval' }] }));
  writeFileSync(join(root, 'bin/npm'), `#!${process.execPath}\nconst fs=require('node:fs'); process.exit(fs.existsSync('repaired.txt')?0:1);\n`); chmodSync(join(root, 'bin/npm'), 0o755);
  writeFileSync(join(root, 'agent.cjs'), `let prompt=''; process.stdin.on('data',c=>prompt+=c); process.stdin.on('end',()=>{const fs=require('node:fs');fs.writeFileSync('.ratio-build/received-prompt',prompt);${change ? "fs.writeFileSync('repaired.txt','implemented');" : ''}});`);
  execFileSync('git', ['init', '-q'], { cwd: root }); execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  return root;
}
it('executes an implementation, verifies its changed source, and stops at external approval', () => {
  const root = fixture();
  try {
    const result = spawnSync(process.execPath, ['scripts/completion/run.mjs', '--implement', '--gates=lint'], { cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, RATIO_BUILD_AGENT_ARGV: JSON.stringify([process.execPath, 'agent.cjs']) } });
    expect(result.status).toBe(2);
    const report = JSON.parse(readFileSync(join(root, '.ratio-build/latest.json')));
    expect(report.gates.lint.status).toBe('passed'); expect(report.iteration).toBe(2); expect(report.status).toBe('blocked');
    expect(readFileSync(join(root, 'repaired.txt'), 'utf8')).toBe('implemented');
    expect(readFileSync(join(root, '.ratio-build/received-prompt'), 'utf8')).toContain('Do not publish');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('stops a prose-only or no-change implementation rather than looping indefinitely', () => {
  const root = fixture(false);
  try {
    spawnSync(process.execPath, ['scripts/completion/run.mjs', '--implement', '--gates=lint'], { cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, RATIO_BUILD_AGENT_ARGV: JSON.stringify([process.execPath, 'agent.cjs']) } });
    const report = JSON.parse(readFileSync(join(root, '.ratio-build/latest.json')));
    expect(report.iteration).toBe(1); expect(report.implementation.reason).toMatch(/no source change/); expect(report.gates.lint.status).toBe('failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('verifies the final repair before stopping at the iteration budget and retains each log', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'bin/npm'), `#!${process.execPath}\nprocess.exit(1);\n`);
    writeFileSync(join(root, 'agent.cjs'), "const fs=require('node:fs'); const n=fs.existsSync('repairs.txt')?Number(fs.readFileSync('repairs.txt')):0; fs.writeFileSync('repairs.txt',String(n+1));");
    spawnSync(process.execPath, ['scripts/completion/run.mjs', '--implement', '--gates=lint'], { cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, RATIO_BUILD_AGENT_ARGV: JSON.stringify([process.execPath, 'agent.cjs']) } });
    const report = JSON.parse(readFileSync(join(root, '.ratio-build/latest.json')));
    expect(report.iteration).toBe(3);
    expect(readFileSync(join(root, 'repairs.txt'), 'utf8')).toBe('2');
    expect(report.gates.lint.status).toBe('failed');
    expect(report.implementation.reason).toMatch(/budget reached/);
    expect(readdirSync(join(root, '.ratio-build/logs'))).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
