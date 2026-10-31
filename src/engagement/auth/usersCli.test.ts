// R2 slice E: the operator users command (dist-worker: `cli.js users <cmd>`).
// SYNTHETIC users; passwords only on stdin, generated at run time; temp files.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadDirectory } from './directory';
import { EngagementSessionStore } from './session';
import { usersMain } from './usersCli';

const T = '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d';
const E = 'example-focus-sample';
const INSTANCE = { tenantId: T, engagementId: E };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-users-cli-'));
const USERS = path.join(dir, 'users.json');
const STATE = path.join(dir, 'state', 'sessions.sqlite');
const env = { RATIO_ENGAGEMENT_CONFIG: path.resolve(__dirname, '../../../fixtures/engagement/example/engagement.json'), RATIO_ENGAGEMENT_USERS: USERS, RATIO_ENGAGEMENT_STATE: STATE };
const pw = randomBytes(18).toString('base64url');
let out: string[];
let err: string[];
const io = { out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); } };
const run = (argv: string[], stdin = '') => usersMain(argv, env, io, () => stdin);
const dirNow = () => { const r = loadDirectory(USERS, INSTANCE); if (!r.ok) throw new Error(r.problems.join('; ')); return r.directory; };
const seed = () => fs.writeFileSync(USERS, JSON.stringify({ version: 1, users: [{ id: 'admin', displayName: 'SYNTHETIC Admin', status: 'active' }],
  identityConnections: [{ id: 'idp-a', tenantId: T, protocol: 'oidc', issuer: 'https://idp.example.test/a', clientId: 'c', clientSecretRef: 'RATIO_OIDC_CLIENT_SECRET_A', provisioning: 'invite-only', enabled: true }],
  memberships: [{ userId: 'admin', tenantId: T, engagementId: E, role: 'tenant_admin', status: 'active' }] }, null, 2));
beforeEach(() => { out = []; err = []; seed(); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('users command', () => {
  it('add: user + active membership; a local credential only from stdin; same inode; audit line without secrets', async () => {
    const inode = fs.statSync(USERS).ino;
    expect(await run(['add', '--id', 'v', '--name', 'SYNTHETIC Viewer', '--role', 'viewer', '--password-stdin', '--by', 'admin'], `${pw}\n`)).toBe(0);
    const d = dirNow();
    expect([d.users.get('v')?.status, d.memberships.get('v')?.role, d.credentials.has('v')]).toEqual(['active', 'viewer', true]);
    expect(fs.statSync(USERS).ino).toBe(inode); // written in place: a single-file bind mount sees it
    expect(out.map((l) => JSON.parse(l))).toEqual([{ event: 'users_admin', action: 'add', target: 'v', actor: 'admin', outcome: 'success' }]);
    expect(out.join() + err.join()).not.toMatch(new RegExp(`${pw}|scrypt`));
    expect(await run(['add', '--id', 'w', '--name', 'SYNTHETIC W', '--role', 'viewer', '--password-stdin', '--by', 'admin'], 'short\n')).toBe(1); // too short
    expect(await run(['add', '--id', 'w', '--name', 'SYNTHETIC W', '--role', 'viewer', '--password', pw, '--by', 'admin'])).toBe(2); // never on argv
    expect(err.join()).not.toContain(pw);
  });

  it('refuses self-changes: role, suspension, binding of oneself', async () => {
    await run(['add', '--id', 'v', '--name', 'SYNTHETIC Viewer', '--role', 'viewer', '--by', 'admin']);
    for (const argv of [['set-role', '--id', 'admin', '--role', 'viewer', '--by', 'ADMIN'], ['suspend', '--id', 'admin', '--by', 'admin'],
      ['bind', '--id', 'admin', '--connection', 'idp-a', '--subject', 'sub-x', '--by', 'admin']]) {
      expect(await run(argv), argv[0]).toBe(1);
      expect(err.at(-1)).toContain('users.self_change_refused');
    }
    expect(dirNow().memberships.get('admin')?.role).toBe('tenant_admin');
    expect(await run(['set-role', '--id', 'v', '--role', 'analyst', '--by', 'admin'])).toBe(0);
    expect(dirNow().memberships.get('v')?.role).toBe('analyst');
  });

  it('suspend deletes the user\'s sessions; unsuspend restores the status only; revoke-sessions deletes sessions', async () => {
    await run(['add', '--id', 'v', '--name', 'SYNTHETIC Viewer', '--role', 'viewer', '--by', 'admin']);
    const store = new EngagementSessionStore(STATE);
    const [a, b] = [store.create({ userId: 'v', ...INSTANCE }).token, store.create({ userId: 'admin', ...INSTANCE }).token];
    expect(await run(['suspend', '--id', 'v', '--by', 'admin'])).toBe(0);
    expect([dirNow().users.get('v')?.status, store.get(a), store.get(b) !== null]).toEqual(['suspended', null, true]);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ action: 'suspend', target: 'v', sessionsRevoked: 1 });
    expect(await run(['unsuspend', '--id', 'v', '--by', 'admin'])).toBe(0);
    expect(dirNow().users.get('v')?.status).toBe('active');
    const c = store.create({ userId: 'v', ...INSTANCE }).token;
    expect(await run(['revoke-sessions', '--id', 'v', '--by', 'admin'])).toBe(0);
    expect(store.get(c)).toBeNull();
    store.close();
  });

  it('bind and unbind an explicit external identity (issuer taken from the connection); list shows no secrets', async () => {
    await run(['add', '--id', 'v', '--name', 'SYNTHETIC Viewer', '--role', 'viewer', '--password-stdin', '--by', 'admin'], pw);
    expect(await run(['bind', '--id', 'v', '--connection', 'idp-a', '--subject', 'sub-1', '--by', 'admin'])).toBe(0);
    expect(dirNow().bindingOf('idp-a', 'https://idp.example.test/a', 'sub-1')).toBe('v');
    expect(await run(['bind', '--id', 'v', '--connection', 'idp-x', '--subject', 'sub-2', '--by', 'admin'])).toBe(1); // unknown connection: invalid result, no write
    expect(await run(['unbind', '--connection', 'idp-a', '--subject', 'sub-1', '--by', 'admin'])).toBe(0);
    expect(dirNow().bindingOf('idp-a', 'https://idp.example.test/a', 'sub-1')).toBeUndefined();
    out = [];
    expect(await run(['list'])).toBe(0);
    expect(out.join()).not.toMatch(/scrypt|passwordHash/);
    expect(JSON.parse(out[0])).toMatchObject({ users: [{ id: 'admin', role: 'tenant_admin', status: 'active', localCredential: false }, { id: 'v', role: 'viewer', localCredential: true }] });
  });

  it('never writes an invalid directory, a file changed meanwhile, or while another command holds the lock', async () => {
    const before = fs.readFileSync(USERS, 'utf8');
    expect(await run(['add', '--id', 'bad id', '--name', 'x', '--role', 'viewer', '--by', 'admin'])).toBe(1);
    expect(await run(['set-role', '--id', 'admin2', '--role', 'nope', '--by', 'admin'])).toBe(1);
    expect(fs.readFileSync(USERS, 'utf8')).toBe(before);
    fs.writeFileSync(`${USERS}.lock`, '');
    expect(await run(['add', '--id', 'v', '--name', 'SYNTHETIC Viewer', '--role', 'viewer', '--by', 'admin'])).toBe(1);
    expect(err.at(-1)).toContain('users.locked');
    fs.rmSync(`${USERS}.lock`);
    const racing = usersMain(['add', '--id', 'v', '--name', 'SYNTHETIC Viewer', '--role', 'viewer', '--by', 'admin'], env, io, () => '', () => fs.appendFileSync(USERS, ' '));
    expect(await racing).toBe(1);
    expect(err.at(-1)).toContain('users.changed_concurrently');
  });

  it('a reader running alongside (the app) only ever sees the old or the new directory, or a fail-closed parse error', async () => {
    const seen = new Set<string>();
    const reads: Promise<void>[] = [];
    let stop = false;
    const reader = async () => { while (!stop) { const r = loadDirectory(USERS, INSTANCE); seen.add(r.ok ? `ok:${r.directory.users.size}` : 'closed'); await new Promise((x) => setImmediate(x)); } };
    reads.push(reader());
    for (let i = 0; i < 20; i += 1) expect(await run(['add', '--id', `u${i}`, '--name', `SYNTHETIC ${i}`, '--role', 'viewer', '--by', 'admin'])).toBe(0);
    stop = true;
    await Promise.all(reads);
    for (const s of seen) expect(s === 'closed' || /^ok:\d+$/.test(s), s).toBe(true);
    expect(dirNow().users.size).toBe(21);
  });

  it('every strict prefix of a rewritten file is invalid JSON, so a reader racing the in-place rewrite fails closed, never reads a mix', async () => {
    await run(['add', '--id', 'v', '--name', 'SYNTHETIC Viewer', '--role', 'viewer', '--by', 'admin']);
    const full = fs.readFileSync(USERS);
    const probe = path.join(dir, 'prefix.json');
    for (let cut = 1; cut < full.length; cut += Math.ceil(full.length / 60)) {
      fs.writeFileSync(probe, full.subarray(0, cut));
      expect(loadDirectory(probe, INSTANCE).ok, String(cut)).toBe(false);
    }
  });

});
