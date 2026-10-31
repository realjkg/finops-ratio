// R2 PR A: the identity directory (RATIO_ENGAGEMENT_USERS): internal users,
// local bootstrap credentials, identity connections, explicit bindings,
// memberships and teams. Read-only config validated at startup; problems name
// the KEY, never the value. SYNTHETIC records; passwords generated at run time.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EngagementConfigError } from '../config';
import { checkDirectoryStartup, directoryFromEnv, loadDirectory, validateDirectory } from './directory';
import { hashPassword } from './password';
import { register } from '../../../instrumentation';

const INSTANCE = { tenantId: '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d', engagementId: 'example-focus-sample' }; // fixtures/engagement/example
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const CONFIG = path.resolve(__dirname, '../../../fixtures/engagement/example/engagement.json');
const SECRET = 'LEAKED-VALUE-7d2e';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-dir-'));
let hash = '';
/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate an untyped JSON document */
const doc = (h: string): any => ({
  version: 1,
  users: [{ id: 'a.viewer', displayName: 'SYNTHETIC Viewer', status: 'active' }, { id: 'b.admin', displayName: 'SYNTHETIC Admin', status: 'active' }],
  localCredentials: [{ userId: 'b.admin', passwordHash: h }],
  identityConnections: [{ id: 'idp-a', tenantId: INSTANCE.tenantId, protocol: 'oidc', issuer: 'https://idp.example.test/tenant-a', clientId: 'ratio-synthetic', clientSecretRef: 'RATIO_OIDC_CLIENT_SECRET_IDP_A', provisioning: 'invite-only', enabled: true }],
  bindings: [{ connectionId: 'idp-a', issuer: 'https://idp.example.test/tenant-a', subject: 'sub-0001', userId: 'a.viewer', approvedBy: 'b.admin', approvedAt: '2026-10-31T00:00:00Z' }],
  memberships: [
    { userId: 'a.viewer', tenantId: INSTANCE.tenantId, engagementId: INSTANCE.engagementId, role: 'viewer', status: 'active' },
    { userId: 'b.admin', tenantId: INSTANCE.tenantId, engagementId: INSTANCE.engagementId, role: 'tenant_admin', status: 'active' },
  ],
  teams: [{ id: 'finance', tenantId: INSTANCE.tenantId, displayName: 'SYNTHETIC Finance', members: ['a.viewer'], permissions: ['reports:export'] }],
});
const mutated = (fn: (d: any) => void) => { const d = doc(hash); fn(d); return d; };
const write = (d: unknown, name: string) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d)); return f; };

beforeAll(async () => { hash = await hashPassword(randomBytes(18).toString('base64url')); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('validateDirectory', () => {
  it('accepts a valid directory and indexes it (ids case-insensitive; binding key = connection + issuer + subject)', () => {
    const r = validateDirectory(doc(hash), INSTANCE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.directory.users.get('A.VIEWER'.toLowerCase())).toMatchObject({ id: 'a.viewer', status: 'active' });
    expect(r.directory.credentials.get('b.admin')).toBe(hash);
    expect(r.directory.bindingOf('idp-a', 'https://idp.example.test/tenant-a', 'sub-0001')).toBe('a.viewer');
    expect(r.directory.bindingOf('idp-a', 'https://idp.example.test/other', 'sub-0001')).toBeUndefined();
    expect(r.directory.memberships.get('a.viewer')).toMatchObject({ role: 'viewer', status: 'active' });
    expect(r.directory.teamsOf('a.viewer').map((t) => t.id)).toEqual(['finance']);
  });

  it('rejects each invalid record by key and never echoes the value', () => {
    const cases: Array<[(d: any) => void, string]> = [
      [(d) => { d.version = 2; }, 'version: must be 1'],
      [(d) => { d[SECRET] = 1; }, 'directory: unknown field'],
      [(d) => { d.users = []; }, 'users: must be a non-empty array'],
      [(d) => { d.users[0].id = `${SECRET} x`; }, 'users[0].id'],
      [(d) => { d.users[1].id = 'A.VIEWER'; }, 'users[1].id: duplicate'],
      [(d) => { d.users[0].status = SECRET; }, 'users[0].status'],
      [(d) => { d.users[0][SECRET] = 1; }, 'users[0]: unknown field'],
      [(d) => { d.localCredentials[0].passwordHash = SECRET; }, 'localCredentials[0].passwordHash: must be a scrypt hash'],
      [(d) => { d.localCredentials[0].userId = 'nobody'; }, 'localCredentials[0].userId: unknown user'],
      [(d) => { d.identityConnections[0].tenantId = OTHER_TENANT; }, 'identityConnections[0].tenantId: must equal the tenantId of this instance'],
      [(d) => { d.identityConnections[0].issuer = `http://idp.example.test/${SECRET}`; }, 'identityConnections[0].issuer: must be an https URL'],
      [(d) => { d.identityConnections[0].protocol = 'saml'; }, 'identityConnections[0].protocol: must be oidc'],
      [(d) => { d.identityConnections[0].clientSecretRef = SECRET; }, 'identityConnections[0].clientSecretRef: must be the NAME of an environment variable'],
      ...['DATABASE_URL', 'RATIO_API_TOKEN', 'RATIO_EVIDENCE_S3_SECRET_ACCESS_KEY', 'RATIO_OIDC_CLIENT_SECRET_', 'ratio_oidc_client_secret_a'].map((ref): [(d: any) => void, string] =>
        [(d) => { d.identityConnections[0].clientSecretRef = ref; }, 'identityConnections[0].clientSecretRef: must be the NAME of an environment variable starting RATIO_OIDC_CLIENT_SECRET_']),
      ...[`https://10.0.0.1/${SECRET}`, 'https://[::1]/x', 'https://localhost/x', 'https://intranet/x', 'https://idp.example.test:8443/x', 'https://idp.example.test\\x', ' https://idp.example.test/x',
        'https://idp.example.test/x ', 'https://user:pw@idp.example.test/x', 'https://idp.example.test/x?y=1', 'https://idp.example.test/x#y', 'https://IDP.example.test/x', 'https://idp.example.test/a/../x',
        'https://idp.123/x'].map((iss): [(d: any) => void, string] => [(d) => { d.identityConnections[0].issuer = iss; d.bindings = []; }, 'identityConnections[0].issuer: must be an https URL']),
      [(d) => { d.identityConnections[0].clientSecret = SECRET; }, 'identityConnections[0]: unknown field'],
      [(d) => { d.identityConnections[0].provisioning = 'auto'; }, 'identityConnections[0].provisioning: must be invite-only'],
      [(d) => { d.bindings[0].connectionId = 'idp-b'; }, 'bindings[0].connectionId: unknown connection'],
      [(d) => { d.bindings[0].issuer = 'https://idp.example.test/other'; }, "bindings[0].issuer: must equal the connection's issuer"],
      [(d) => { d.bindings.push({ ...d.bindings[0], userId: 'b.admin' }); }, 'bindings[1]: duplicate external identity'],
      [(d) => { d.bindings[0].userId = 'nobody'; }, 'bindings[0].userId: unknown user'],
      [(d) => { d.bindings[0].approvedAt = SECRET; }, 'bindings[0].approvedAt'],
      [(d) => { d.bindings[0].email = 'a@example.test'; }, 'bindings[0]: unknown field'],
      [(d) => { d.memberships[0].tenantId = OTHER_TENANT; }, 'memberships[0].tenantId: must equal the tenantId of this instance'],
      [(d) => { d.memberships[0].engagementId = 'other'; }, 'memberships[0].engagementId: must equal the engagementId of this instance'],
      [(d) => { d.memberships[0].role = SECRET; }, 'memberships[0].role: must be one of viewer, analyst, connector_manager, tenant_admin'],
      [(d) => { d.memberships.push({ ...d.memberships[0] }); }, 'memberships[2].userId: duplicate membership'],
      [(d) => { d.teams[0].tenantId = OTHER_TENANT; }, 'teams[0].tenantId: must equal the tenantId of this instance'],
      [(d) => { d.teams[0].members = ['nobody']; }, 'teams[0].members[0]: unknown user'],
      [(d) => { d.teams[0].permissions = [SECRET]; }, 'teams[0].permissions[0]: must be one of reports:read, reports:export, connectors:read'],
      ...['identity:manage', 'members:manage', 'connectors:manage'].map((perm): [(d: any) => void, string] => [(d) => { d.teams[0].permissions = [perm]; }, 'teams[0].permissions[0]: must be one of reports:read, reports:export, connectors:read (admin permissions are role-only)']),
    ];
    for (const [fn, key] of cases) {
      const r = validateDirectory(mutated(fn), INSTANCE);
      expect(r.ok, key).toBe(false);
      if (r.ok) continue;
      expect(r.problems.join('\n'), key).toContain(key);
      expect(JSON.stringify(r.problems), key).not.toContain(SECRET);
      expect(JSON.stringify(r.problems), key).not.toContain(hash.slice(-20));
    }
  });
});

describe('loading, reloading and startup', () => {
  it('names the variable for a missing, relative, unreadable, oversized or non-JSON file', () => {
    expect(loadDirectory('', INSTANCE)).toEqual({ ok: false, problems: ['RATIO_ENGAGEMENT_USERS: is missing'] });
    expect(loadDirectory('users.json', INSTANCE)).toEqual({ ok: false, problems: ['RATIO_ENGAGEMENT_USERS: must be an absolute path'] });
    expect(loadDirectory(path.join(dir, 'nope.json'), INSTANCE)).toEqual({ ok: false, problems: ['RATIO_ENGAGEMENT_USERS: file is missing or unreadable'] });
    expect(loadDirectory(write(`{"x":"${SECRET}`, 'bad.json'), INSTANCE)).toEqual({ ok: false, problems: ['RATIO_ENGAGEMENT_USERS: file is not valid JSON'] });
    expect(loadDirectory(write(' '.repeat(512 * 1024 + 1), 'big.json'), INSTANCE)).toEqual({ ok: false, problems: ['RATIO_ENGAGEMENT_USERS: file is larger than 512 KiB'] });
    const good = loadDirectory(write(doc(hash), 'good.json'), INSTANCE);
    expect(good.ok && good.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts canonical issuers: a DNS name with a path, or a bare origin with or without its single trailing slash (compared exactly as written)', () => {
    for (const iss of ['https://idp.example.test/tenant-a/v2.0', 'https://login.idp.example.test', 'https://login.idp.example.test/']) {
      const r = validateDirectory(mutated((d) => { d.identityConnections[0].issuer = iss; d.bindings[0].issuer = iss; }), INSTANCE);
      expect(r.ok, iss).toBe(true);
    }
  });

  it('accepts one leading UTF-8 byte order mark (as editors write it); the sha256 covers the bytes as read', () => {
    const body = Buffer.from(JSON.stringify(doc(hash)));
    const f = write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]).toString('utf8'), 'bom.json');
    const r = loadDirectory(f, INSTANCE);
    expect(r.ok).toBe(true);
    expect(loadDirectory(write(`\ufeff\ufeff${body}`, 'bom2.json'), INSTANCE)).toEqual({ ok: false, problems: ['RATIO_ENGAGEMENT_USERS: file is not valid JSON'] });
  });

  it('directoryFromEnv picks up an in-place edit on the next call (suspension is immediate) and fails closed on a bad edit', () => {
    const f = write(doc(hash), 'live.json');
    const env = { RATIO_ENGAGEMENT_USERS: f };
    const first = directoryFromEnv(env, INSTANCE);
    expect(first.ok && first.directory.users.get('a.viewer')?.status).toBe('active');
    fs.writeFileSync(f, JSON.stringify(mutated((d) => { d.users[0].status = 'suspended'; d.users[0].displayName = 'SYNTHETIC Viewer (suspended)'; })));
    const second = directoryFromEnv(env, INSTANCE);
    expect(second.ok && second.directory.users.get('a.viewer')?.status).toBe('suspended');
    fs.writeFileSync(f, '{');
    expect(directoryFromEnv(env, INSTANCE).ok).toBe(false);
  });

  it('checkDirectoryStartup throws EngagementConfigError with keys only; register() exits 1 on a bad or missing file and resolves on a good one', async () => {
    const bad = write(mutated((d) => { d.memberships[0].role = SECRET; }), 'bad-role.json');
    expect(() => checkDirectoryStartup({ RATIO_ENGAGEMENT_USERS: bad }, INSTANCE)).toThrow(EngagementConfigError);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('RATIO_MODE', 'engagement');
    vi.stubEnv('RATIO_ENGAGEMENT_CONFIG', CONFIG);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.stubEnv('RATIO_ENGAGEMENT_USERS', bad);
      await register();
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(err.mock.calls[0][0])).toContain('memberships[0].role');
      expect(String(err.mock.calls[0][0])).not.toContain(SECRET);
      exit.mockClear();
      vi.stubEnv('RATIO_ENGAGEMENT_USERS', '');
      await register();
      expect(exit).toHaveBeenCalledWith(1);
      exit.mockClear();
      vi.stubEnv('RATIO_ENGAGEMENT_USERS', write(doc(hash), 'startup.json'));
      await expect(register()).resolves.toBeUndefined();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
});
