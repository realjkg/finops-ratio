#!/usr/bin/env node
// Engagement image smoke test (R12). Needs a Docker daemon and the R1 config loader, so it is NOT part of
// `npm test`; run it where the image is built:  node infrastructure/engagement/smoke.mjs
// PREREQUISITES, each of which FAILS the run (exit 1), never skips it:
//   1. src/engagement/config.ts exists (row R1). Without the loader the container cannot validate its config.
//   2. a reachable Docker daemon.
//   3. RATIO_SMOKE_VALID_CONFIG: path of a valid engagement config JSON (a SYNTHETIC one, see the R1 schema).
// Checks: an invalid config makes the container exit non-zero, name the offending key and never echo the value;
// the image runs as non-root with a read-only root filesystem and no simulation variable.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMAGE = 'ratio-engagement:smoke';
const SENTINEL = 'SMOKE-SENTINEL-VALUE-DO-NOT-ECHO';
const failures = [];
const fail = (m) => { failures.push(m); process.stderr.write(`FAIL ${m}\n`); };
const run = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', cwd: root, ...opts });

if (!fs.existsSync(path.join(root, 'src/engagement/config.ts'))) fail('prerequisite R1 missing: src/engagement/config.ts');
if (run(['info']).status !== 0) fail('prerequisite missing: a reachable Docker daemon');
const valid = process.env.RATIO_SMOKE_VALID_CONFIG;
if (!valid || !fs.existsSync(valid)) fail('prerequisite missing: RATIO_SMOKE_VALID_CONFIG must name an existing file');
if (failures.length) process.exit(1);

const build = run(['build', '--target', 'engagement', '-f', 'infrastructure/simulation/Dockerfile', '-t', IMAGE, '.'], { stdio: 'inherit' });
if (build.status !== 0) { process.stderr.write('FAIL docker build\n'); process.exit(1); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-smoke-'));
const bad = path.join(dir, 'engagement.json');
fs.writeFileSync(bad, JSON.stringify({ tenantId: SENTINEL }));
const common = ['run', '--rm', '--read-only', '--cap-drop', 'ALL', '--tmpfs', '/tmp', '--tmpfs', '/app/.next/cache'];
const invalid = run([...common, '-v', `${bad}:/config/engagement.json:ro`, IMAGE]);
const out = `${invalid.stdout}${invalid.stderr}`;
if (invalid.status === 0) fail('invalid config: container exited 0');
if (!/tenantId/.test(out)) fail('invalid config: output does not name the offending key');
if (out.includes(SENTINEL)) fail('invalid config: output echoed a config value');

const env = run(['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', 'id -u; env']);
const [uid, ...rest] = env.stdout.split('\n');
if (uid === '0') fail('image runs as root');
if (/RATIO_SIMULATION/.test(rest.join('\n'))) fail('image sets a simulation variable');
if (!/^RATIO_MODE=engagement$/m.test(rest.join('\n'))) fail('image does not select engagement mode');

fs.rmSync(dir, { recursive: true, force: true });
if (failures.length) process.exit(1);
process.stdout.write('engagement smoke: ok\n');
