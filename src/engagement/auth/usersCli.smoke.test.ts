// R2 slice E smoke: the COMPILED worker CLI (tsconfig.worker.json, as the image builds it) run the way the compose
// `users` job runs it: a read-only parent (the image's read-only root filesystem), a writable users DIRECTORY and a
// writable /state. It must write nothing outside those two (the lock and the temp file live in the users directory).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-users-smoke-'));
// Compiled inside the repo so `pg` and the other runtime packages resolve from node_modules, as in the image.
const out = path.join(REPO, 'node_modules', '.cache', `r2-users-smoke-${process.pid}`);
afterAll(() => { fs.chmodSync(root, 0o755); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); });

it('the compiled `cli.js users` writes users.json atomically in its directory and revokes sessions under a read-only parent', () => {
  const tsc = spawnSync(process.execPath, [path.join(REPO, 'node_modules/typescript/bin/tsc'), '-p', path.join(REPO, 'tsconfig.worker.json'), '--outDir', out], { encoding: 'utf8' });
  expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0);
  const [users, state] = [path.join(root, 'config', 'users'), path.join(root, 'state')];
  fs.mkdirSync(users, { recursive: true });
  fs.mkdirSync(state);
  const T = '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d';
  fs.writeFileSync(path.join(users, 'users.json'), JSON.stringify({ version: 1, users: [{ id: 'admin', displayName: 'SYNTHETIC Admin', status: 'active' }],
    memberships: [{ userId: 'admin', tenantId: T, engagementId: 'example-focus-sample', role: 'tenant_admin', status: 'active' }] }));
  fs.chmodSync(path.join(root, 'config'), 0o555);
  const before = fs.readdirSync(root).sort();
  const env = { PATH: process.env.PATH, RATIO_ENGAGEMENT_CONFIG: path.join(REPO, 'fixtures/engagement/example/engagement.json'), RATIO_ENGAGEMENT_USERS: path.join(users, 'users.json'),
    RATIO_ENGAGEMENT_STATE: path.join(state, 'sessions.sqlite') } as unknown as NodeJS.ProcessEnv;
  const cli = (args: string[], input = '') => spawnSync(process.execPath, [path.join(out, 'ingest/cli.js'), 'users', ...args], { env, input, cwd: root, encoding: 'utf8' });
  const add = cli(['add', '--id', 'v', '--name', 'SYNTHETIC Viewer', '--role', 'viewer', '--password-stdin', '--by', 'admin'], 'synthetic-password-0123456789\n');
  expect([add.status, JSON.parse(add.stdout.trim()).outcome], add.stderr).toEqual([0, 'success']);
  const sus = cli(['suspend', '--id', 'v', '--by', 'admin']);
  expect([sus.status, JSON.parse(sus.stdout.trim()).sessionsRevoked], sus.stderr).toEqual([0, 0]);
  expect([fs.readdirSync(users), fs.readdirSync(root).sort(), fs.readdirSync(path.join(root, 'config'))]).toEqual([['users.json'], before, ['users']]);
  expect(JSON.parse(cli(['list']).stdout).users.map((u: { id: string; status: string }) => `${u.id}:${u.status}`)).toEqual(['admin:active', 'v:suspended']);
  fs.chmodSync(path.join(root, 'config'), 0o755);
}, 180_000);
