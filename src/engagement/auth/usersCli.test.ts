// R2 slice E: the operator users command (dist-worker: `cli.js users <cmd>`).
// SYNTHETIC users; passwords only on stdin, generated at run time; temp files.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadDirectory } from './directory';
import { verifyPassword } from './password';
import { EngagementSessionStore } from './session';
import { usersMain, type UsersDeps } from './usersCli';

const T = '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d';
const E = 'example-focus-sample';
const INSTANCE = { tenantId: T, engagementId: E };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-users-cli-'));
const DIR = path.join(root, 'users');
const USERS = path.join(DIR, 'users.json');
const STATE = path.join(root, 'state', 'sessions.sqlite');
const env = { RATIO_ENGAGEMENT_CONFIG: path.resolve(__dirname, '../../../fixtures/engagement/example/engagement.json'), RATIO_ENGAGEMENT_USERS: USERS, RATIO_ENGAGEMENT_STATE: STATE };
const pw = () => randomBytes(18).toString('base64url');
let out: string[];
let err: string[];
const io = { out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); } };
const run = (argv: string[], deps: UsersDeps = {}) => usersMain(argv, env, io, deps);
const last = (a: string[]) => JSON.parse(a.at(-1)!);
const dirNow = () => { const r = loadDirectory(USERS, INSTANCE); if (!r.ok) throw new Error(r.problems.join('; ')); return r.directory; };
const m = (userId: string, role: string) => ({ userId, tenantId: T, engagementId: E, role, status: 'active' });
beforeEach(() => {
  out = []; err = [];
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(USERS, JSON.stringify({ version: 1, users: ['admin', 'admin2', 'v'].map((id) => ({ id, displayName: `SYNTHETIC ${id}`, status: 'active' })),
    identityConnections: [{ id: 'idp-a', tenantId: T, protocol: 'oidc', issuer: 'https://idp.example.test/a', clientId: 'c', clientSecretRef: 'RATIO_OIDC_CLIENT_SECRET_A', provisioning: 'invite-only', enabled: true }],
    memberships: [m('admin', 'tenant_admin'), m('admin2', 'tenant_admin'), m('v', 'viewer')] }), { mode: 0o640 });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('users command', () => {
  it('add and set-password: hash from the FIRST stdin line (\\n, \\r\\n or a lone \\r) verifies; argv passwords refused; audit without secrets', async () => {
    const [a, b, c] = [pw(), pw(), pw()];
    expect(await run(['add', '--id', 'n1', '--name', 'SYNTHETIC N1', '--role', 'viewer', '--password-stdin', '--by', 'admin'], { readStdin: () => `${a}\nsecond-line-ignored` })).toBe(0);
    expect(last(out)).toEqual({ event: 'users_admin', action: 'add', actor: 'admin', target: 'n1', role: 'viewer', outcome: 'success' });
    expect(await verifyPassword(a, dirNow().credentials.get('n1')!)).toBe(true);
    expect(await run(['set-password', '--id', 'n1', '--password-stdin', '--by', 'admin2'], { readStdin: () => `${b}\rjunk` })).toBe(0);
    expect([await verifyPassword(b, dirNow().credentials.get('n1')!), await verifyPassword(a, dirNow().credentials.get('n1')!)]).toEqual([true, false]);
    expect(await run(['set-password', '--id', 'n1', '--password-stdin', '--by', 'admin'], { readStdin: () => `${c}\r\n` })).toBe(0);
    expect(await verifyPassword(c, dirNow().credentials.get('n1')!)).toBe(true);
    expect(await run(['add', '--id', 'n2', '--name', 'x', '--role', 'viewer', '--password-stdin', '--by', 'admin'], { readStdin: () => 'short' })).toBe(1);
    expect(await run(['add', '--id', 'n2', '--name', 'x', '--role', 'viewer', '--password', a, '--by', 'admin'])).toBe(2);
    expect(last(err).message).toMatch(/never type/);
    expect(out.join() + err.join()).not.toMatch(new RegExp(`${a}|${b}|${c}|scrypt`));
  });

  it('--by is the literal `operator` or an exact active tenant_admin; nobody acts on themselves', async () => {
    for (const by of [' admin', 'admin ', 'v', 'ghost', '']) {
      expect(await run(['set-role', '--id', 'v', '--role', 'analyst', '--by', by]), JSON.stringify(by)).toBe(1);
      expect(last(err).code).toBe('users.actor_invalid');
    }
    for (const argv of [['add', '--id', 'ADMIN', '--name', 'x', '--role', 'tenant_admin', '--by', 'admin'], ['set-role', '--id', 'admin', '--role', 'viewer', '--by', 'ADMIN'],
      ['suspend', '--id', 'admin', '--by', 'admin'], ['set-password', '--id', 'admin', '--password-stdin', '--by', 'admin'], ['bind', '--id', 'admin', '--connection', 'idp-a', '--subject', 's', '--by', 'admin']]) {
      expect(await run(argv, { readStdin: pw }), argv[0]).toBe(1);
      expect(last(err)).toMatchObject({ code: 'users.self_change_refused', actor: 'admin', action: argv[0] });
    }
    expect(await run(['set-role', '--id', 'v', '--role', 'analyst', '--by', 'operator'])).toBe(0);
    expect(last(out)).toMatchObject({ action: 'set-role', actor: 'operator', target: 'v', role: 'analyst' });
  });

  it('the last active tenant_admin cannot be demoted or suspended, except by `operator --force`', async () => {
    expect(await run(['suspend', '--id', 'admin2', '--by', 'admin'])).toBe(0);
    expect(await run(['set-role', '--id', 'admin', '--role', 'viewer', '--by', 'operator'])).toBe(1);
    expect(last(err).code).toBe('users.last_admin');
    expect(await run(['suspend', '--id', 'admin', '--by', 'operator', '--force'])).toBe(0);
  });

  it('suspend and unbind delete the target\'s sessions; unbind records connection, subject and target; approvedBy is the actor', async () => {
    const store = new EngagementSessionStore(STATE);
    const [t1, t2] = [store.create({ userId: 'v', ...INSTANCE }).token, store.create({ userId: 'admin', ...INSTANCE }).token];
    for (const s of ['s1', 's2']) expect(await run(['bind', '--id', 'v', '--connection', 'idp-a', '--subject', s, '--by', 'admin'])).toBe(0);
    expect(fs.readFileSync(USERS, 'utf8')).toContain('"approvedBy": "admin"');
    expect(await run(['unbind', '--connection', 'idp-a', '--subject', 's1', '--by', 'v'])).toBe(1); // v is not an admin
    expect(await run(['unbind', '--connection', 'idp-a', '--subject', 's1', '--by', 'admin2'])).toBe(0);
    expect(last(out)).toEqual({ event: 'users_admin', action: 'unbind', actor: 'admin2', target: 'v', connection: 'idp-a', subject: 's1', sessionsRevoked: 1, outcome: 'success' });
    expect([store.get(t1), store.get(t2) !== null]).toEqual([null, true]);
    expect(dirNow().bindingOf('idp-a', 'https://idp.example.test/a', 's2')).toBe('v'); // the other binding stays
    const t3 = store.create({ userId: 'v', ...INSTANCE }).token;
    expect(await run(['suspend', '--id', 'v', '--by', 'admin'])).toBe(0);
    expect(store.get(t3)).toBeNull();
    store.close();
  });

  it('revocation is prepared before writing: no state ⇒ nothing written; a revocation failing after the write is audited as partial', async () => {
    const before = fs.readFileSync(USERS);
    expect(await usersMain(['suspend', '--id', 'v', '--by', 'admin'], { ...env, RATIO_ENGAGEMENT_STATE: 'relative.sqlite' }, io)).toBe(1);
    expect([last(err).code, fs.readFileSync(USERS).equals(before)]).toEqual(['users.state_missing', true]);
    expect(await run(['suspend', '--id', 'v', '--by', 'admin'], { revoke: () => { throw new Error('disk'); } })).toBe(1);
    expect(last(out)).toMatchObject({ action: 'suspend', target: 'v', outcome: 'partial', code: 'users.revoke_failed' });
    expect(dirNow().users.get('v')?.status).toBe('suspended');
  });

  it('crash-atomic replace: a failing write (ENOSPC) leaves the original intact and no temp file; a good write renames, keeps the mode, leaves only users.json', async () => {
    const before = fs.readFileSync(USERS);
    const enospc = () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); };
    expect(await run(['set-role', '--id', 'v', '--role', 'analyst', '--by', 'admin'], { writeSync: enospc as never })).toBe(1);
    expect([last(err).code, last(err).cause, fs.readFileSync(USERS).equals(before), fs.readdirSync(DIR)]).toEqual(['users.write_failed', 'ENOSPC', true, ['users.json']]);
    const inode = fs.statSync(USERS).ino;
    let partial = 0;
    const short: typeof fs.writeSync = ((fd: number, b: Buffer, off: number, len: number, pos: number) => { partial += 1; return fs.writeSync(fd, b, off, Math.min(len, 7), pos); }) as never;
    expect(await run(['set-role', '--id', 'v', '--role', 'analyst', '--by', 'admin'], { writeSync: short })).toBe(0); // short writes looped to completion
    expect(partial).toBeGreaterThan(10);
    expect([fs.statSync(USERS).ino !== inode, fs.statSync(USERS).mode & 0o777, fs.readdirSync(DIR), dirNow().memberships.get('v')?.role]).toEqual([true, 0o640, ['users.json'], 'analyst']);
  });

  it('one writer: a held lock, a stale lock (with recovery hint) and a lock that cannot be created each refuse without writing', async () => {
    const lockFile = path.join(DIR, '.users.lock');
    fs.writeFileSync(lockFile, '{}');
    expect(await run(['set-role', '--id', 'v', '--role', 'analyst', '--by', 'admin'])).toBe(1);
    expect(last(err).code).toBe('users.locked');
    fs.utimesSync(lockFile, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    expect(await run(['set-role', '--id', 'v', '--role', 'analyst', '--by', 'admin'])).toBe(1);
    expect(last(err)).toMatchObject({ code: 'users.lock_stale', recovery: expect.stringContaining('.users.lock') });
    fs.rmSync(lockFile);
    expect(await usersMain(['set-role', '--id', 'v', '--role', 'analyst', '--by', 'admin'], { ...env, RATIO_ENGAGEMENT_USERS: path.join(root, 'missing', 'users.json') }, io)).toBe(1);
    expect(last(err)).toMatchObject({ code: 'users.lock_failed', cause: 'ENOENT' });
    expect(await run(['set-role', '--id', 'v', '--role', 'analyst', '--by', 'admin'], { beforeWrite: () => fs.appendFileSync(USERS, ' ') })).toBe(1);
    expect(last(err).code).toBe('users.changed_concurrently');
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('never writes an invalid or oversized directory; list never shows a hash and fails with a fixed code', async () => {
    const before = fs.readFileSync(USERS);
    expect(await run(['add', '--id', 'bad id', '--name', 'x', '--role', 'viewer', '--by', 'admin'])).toBe(1);
    expect(await run(['add', '--id', 'big', '--name', 'x'.repeat(80), '--role', 'nope', '--by', 'admin'])).toBe(1);
    expect(fs.readFileSync(USERS).equals(before)).toBe(true);
    expect(await run(['add', '--id', 'n', '--name', 'SYNTHETIC n', '--role', 'viewer', '--password-stdin', '--by', 'admin'], { readStdin: pw })).toBe(0);
    expect(await run(['list'])).toBe(0);
    expect(out.at(-1)).not.toMatch(/scrypt|passwordHash/);
    expect(await usersMain(['list'], { ...env, RATIO_ENGAGEMENT_USERS: path.join(root, 'nope.json') }, io)).toBe(1);
    expect(last(err).code).toBe('users.read_failed');
  });
});

describe('users command: review Lows', () => {
  it('unknown commands print usage without taking the lock; `operator` is a reserved id; --force needs --by operator', async () => {
    fs.writeFileSync(path.join(DIR, '.users.lock'), '{}');
    expect(await run(['frobnicate', '--by', 'admin'])).toBe(2);
    expect(last(err).code).toBe('users.usage');
    fs.rmSync(path.join(DIR, '.users.lock'));
    expect(await run(['add', '--id', 'Operator', '--name', 'x', '--role', 'viewer', '--by', 'admin'])).toBe(1);
    expect(last(err).code).toBe('users.id_reserved');
    expect(await run(['suspend', '--id', 'v', '--by', 'admin', '--force'])).toBe(1);
    expect(last(err).code).toBe('users.force_requires_operator');
  });

  it('refuses a symlinked users.json; refuses output over the size cap; sweeps stale temp files under the lock', async () => {
    const real = path.join(root, 'elsewhere.json');
    fs.copyFileSync(USERS, real);
    fs.rmSync(USERS);
    fs.symlinkSync(real, USERS);
    expect(await run(['set-role', '--id', 'v', '--role', 'analyst', '--by', 'admin'])).toBe(1);
    expect([last(err).code, fs.lstatSync(USERS).isSymbolicLink()]).toEqual(['users.file_symlink', true]);
    fs.rmSync(USERS);
    fs.copyFileSync(real, USERS);
    expect(await run(['set-role', '--id', 'v', '--role', 'analyst', '--by', 'admin'], { maxBytes: 100 })).toBe(1);
    expect(last(err).code).toBe('users.too_large');
    const old = path.join(DIR, '.users.json.123.abcd.tmp');
    const fresh = path.join(DIR, '.users.json.124.abcd.tmp');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'x');
    fs.utimesSync(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    expect(await run(['set-role', '--id', 'v', '--role', 'analyst', '--by', 'admin'])).toBe(0);
    expect(fs.readdirSync(DIR).sort()).toEqual(['.users.json.124.abcd.tmp', 'users.json']);
  });

  it('temp file gets the original mode despite the umask; a directory fsync failure after the rename is partial; a failed revoke-sessions is refused, not partial', async () => {
    fs.chmodSync(USERS, 0o664);
    const umask = process.umask(0o077);
    try { expect(await run(['set-role', '--id', 'v', '--role', 'analyst', '--by', 'admin'])).toBe(0); } finally { process.umask(umask); }
    expect(fs.statSync(USERS).mode & 0o777).toBe(0o664);
    expect(await run(['set-role', '--id', 'v', '--role', 'viewer', '--by', 'admin'], { fsyncDir: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } })).toBe(1);
    expect([last(out).outcome, last(out).code, dirNow().memberships.get('v')?.role]).toEqual(['partial', 'users.dir_sync_failed', 'viewer']);
    out = [];
    expect(await run(['revoke-sessions', '--id', 'v', '--by', 'admin'], { revoke: () => { throw new Error('disk'); } })).toBe(1);
    expect([out, last(err).code]).toEqual([[], 'users.revoke_failed']);
  });
});
