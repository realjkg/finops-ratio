// R2 PR A: the one authorization service (principal, ACTIVE membership,
// resource tenant + engagement, permission by role or team) and the
// IdP-agnostic identity resolution (explicit binding of connection + issuer +
// subject; local scrypt credentials as the bootstrap/recovery path).
// SYNTHETIC records; passwords generated at run time.
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { authorize, DENY, PERMISSIONS, ROLE_PERMISSIONS, type Permission } from './authz';
import { validateDirectory, type Directory } from './directory';
import { authenticateLocal, resolveExternalIdentity } from './identity';
import { hashPassword } from './password';

const T = '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d';
const E = 'example-focus-sample';
const OTHER_T = '22222222-2222-4222-8222-222222222222';
const ISS = 'https://idp.example.test/tenant-a';
const RES = { tenantId: T, engagementId: E };
const pw = randomBytes(18).toString('base64url');
let hash = '';
/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate an untyped JSON document */
function dir(fn: (d: any) => void = () => {}): Directory {
  const user = (id: string, status = 'active') => ({ id, displayName: `SYNTHETIC ${id}`, status });
  const member = (userId: string, role: string, status = 'active') => ({ userId, tenantId: T, engagementId: E, role, status });
  const d: any = {
    version: 1,
    users: [user('v'), user('a'), user('c'), user('adm'), user('nomember'), user('off', 'suspended'), user('msusp')],
    localCredentials: [{ userId: 'adm', passwordHash: hash }, { userId: 'off', passwordHash: hash }],
    identityConnections: [
      { id: 'idp-a', tenantId: T, protocol: 'oidc', issuer: ISS, clientId: 'ratio-synthetic', clientSecretRef: 'RATIO_OIDC_A', provisioning: 'invite-only', enabled: true },
      { id: 'idp-off', tenantId: T, protocol: 'oidc', issuer: 'https://idp.example.test/off', clientId: 'ratio-synthetic', clientSecretRef: 'RATIO_OIDC_OFF', provisioning: 'invite-only', enabled: false },
    ],
    bindings: [
      { connectionId: 'idp-a', issuer: ISS, subject: 'sub-v', userId: 'v', approvedBy: 'adm', approvedAt: '2026-10-31T00:00:00Z' },
      { connectionId: 'idp-a', issuer: ISS, subject: 'sub-off', userId: 'off', approvedBy: 'adm', approvedAt: '2026-10-31T00:00:00Z' },
      { connectionId: 'idp-off', issuer: 'https://idp.example.test/off', subject: 'sub-v', userId: 'v', approvedBy: 'adm', approvedAt: '2026-10-31T00:00:00Z' },
    ],
    memberships: [member('v', 'viewer'), member('a', 'analyst'), member('c', 'connector_manager'), member('adm', 'tenant_admin'), member('off', 'viewer'), member('msusp', 'analyst', 'suspended')],
    teams: [{ id: 'finance', tenantId: T, displayName: 'SYNTHETIC Finance', members: ['v'], permissions: ['reports:export'] }],
  };
  fn(d);
  const r = validateDirectory(d, RES);
  if (!r.ok) throw new Error(r.problems.join('; '));
  return r.directory;
}
const p = (userId: string, o: Partial<typeof RES> = {}) => ({ userId, ...RES, ...o });

beforeAll(async () => { hash = await hashPassword(pw, { logN: 14, r: 8, p: 1 }); });

describe('authorize: deny by default', () => {
  it('role permissions are exactly the documented grants; connector management never implies identity or members', () => {
    expect(PERMISSIONS).toEqual(['reports:read', 'reports:export', 'connectors:read', 'connectors:manage', 'members:manage', 'identity:manage']);
    expect(ROLE_PERMISSIONS).toEqual({
      viewer: ['reports:read'],
      analyst: ['reports:read', 'reports:export', 'connectors:read'],
      connector_manager: ['connectors:read', 'connectors:manage'],
      tenant_admin: ['reports:read', 'reports:export', 'connectors:read', 'members:manage', 'identity:manage'],
    });
    const d = dir();
    for (const [user, role] of [['a', 'analyst'], ['c', 'connector_manager'], ['adm', 'tenant_admin']] as const) {
      for (const perm of PERMISSIONS) {
        const v = authorize(d, p(user), perm, RES);
        expect(v.allow, `${user} ${perm}`).toBe((ROLE_PERMISSIONS[role] as readonly string[]).includes(perm));
        if (!v.allow) expect(v).toEqual({ allow: false, status: 403, reason: DENY.permission });
      }
    }
  });

  it('a team grant adds its permissions to its members only, inside the tenant', () => {
    const d = dir();
    expect(authorize(d, p('v'), 'reports:export', RES)).toEqual({ allow: true, userId: 'v', role: 'viewer', teams: ['finance'] });
    expect(authorize(d, p('v'), 'connectors:manage', RES).allow).toBe(false);
    expect(authorize(dir((x) => { x.teams[0].members = []; }), p('v'), 'reports:export', RES).allow).toBe(false);
  });

  it('no principal, unknown or suspended user ⇒ 401; no or suspended membership, other tenant or engagement, unknown permission ⇒ 403', () => {
    const d = dir();
    expect(authorize(d, null, 'reports:read', RES)).toEqual({ allow: false, status: 401, reason: DENY.authentication });
    expect(authorize(d, p('ghost'), 'reports:read', RES)).toEqual({ allow: false, status: 401, reason: DENY.authentication });
    expect(authorize(d, p('off'), 'reports:read', RES)).toEqual({ allow: false, status: 401, reason: DENY.authentication });
    expect(authorize(d, p('nomember'), 'reports:read', RES)).toEqual({ allow: false, status: 403, reason: DENY.membership });
    expect(authorize(d, p('msusp'), 'reports:read', RES)).toEqual({ allow: false, status: 403, reason: DENY.membership });
    expect(authorize(d, p('v', { tenantId: OTHER_T }), 'reports:read', RES)).toEqual({ allow: false, status: 403, reason: DENY.tenant });
    expect(authorize(d, p('v'), 'reports:read', { tenantId: OTHER_T, engagementId: E })).toEqual({ allow: false, status: 403, reason: DENY.tenant });
    expect(authorize(d, p('v'), 'reports:read', { tenantId: T, engagementId: 'other' })).toEqual({ allow: false, status: 403, reason: DENY.tenant });
    expect(authorize(d, p('v'), 'reports:delete' as Permission, RES)).toEqual({ allow: false, status: 403, reason: DENY.permission });
    expect(authorize(d, p('v'), 'reports:read', RES).allow).toBe(true);
  });

  it('defense in depth: a membership or binding record of another tenant or issuer is refused even if a directory held one', () => {
    const d = dir();
    const foreign = { ...d, memberships: new Map([...d.memberships].map(([k, m]) => [k, { ...m, tenantId: OTHER_T }])) };
    expect(authorize(foreign, p('v'), 'reports:read', RES)).toEqual({ allow: false, status: 403, reason: DENY.membership });
    const loose = { ...d, bindingOf: (c: string, _i: string, s: string) => d.bindingOf(c, ISS, s) };
    expect(resolveExternalIdentity(loose, { connectionId: 'idp-a', issuer: 'https://idp.example.test/tenant-b', subject: 'sub-v' })).toEqual({ kind: 'not_provisioned' });
  });

  it('a role change or suspension in the directory changes the very next decision (no cached grant)', () => {
    expect(authorize(dir((x) => { x.memberships[0].role = 'connector_manager'; }), p('v'), 'reports:read', RES).allow).toBe(false);
    expect(authorize(dir((x) => { x.users[0].status = 'suspended'; }), p('v'), 'reports:read', RES).allow).toBe(false);
    expect(authorize(dir((x) => { x.memberships[0].status = 'suspended'; }), p('v'), 'reports:read', RES).allow).toBe(false);
  });
});

describe('identity resolution', () => {
  it('an external identity maps to a user only through an explicit binding of connection + issuer + subject on an enabled connection', () => {
    const d = dir();
    expect(resolveExternalIdentity(d, { connectionId: 'idp-a', issuer: ISS, subject: 'sub-v' })).toEqual({ kind: 'bound', userId: 'v' });
    for (const ext of [
      { connectionId: 'idp-a', issuer: ISS, subject: 'sub-unbound' }, // authenticated at the IdP, never provisioned
      { connectionId: 'idp-a', issuer: 'https://idp.example.test/tenant-b', subject: 'sub-v' }, // another issuer
      { connectionId: 'idp-b', issuer: ISS, subject: 'sub-v' }, // unknown connection
      { connectionId: 'idp-off', issuer: 'https://idp.example.test/off', subject: 'sub-v' }, // disabled connection
      { connectionId: 'idp-a', issuer: ISS, subject: 'sub-off' }, // suspended user
      { connectionId: 'idp-a', issuer: ISS, subject: 'SUB-V' }, // subjects are exact
    ]) expect(resolveExternalIdentity(d, ext), JSON.stringify(ext)).toEqual({ kind: 'not_provisioned' });
  });

  it('an email or display name never identifies anyone', () => {
    const d = dir();
    expect(resolveExternalIdentity(d, { connectionId: 'idp-a', issuer: ISS, subject: 'nobody', email: 'v@example.test', name: 'SYNTHETIC v' } as never)).toEqual({ kind: 'not_provisioned' });
  });

  it('local credentials (bootstrap/recovery): right password of an active user only; one fixed null otherwise', async () => {
    const d = dir();
    expect(await authenticateLocal(d, 'ADM', pw)).toBe('adm');
    expect(await authenticateLocal(d, 'adm', `${pw}x`)).toBeNull();
    expect(await authenticateLocal(d, 'v', pw)).toBeNull(); // no local credential
    expect(await authenticateLocal(d, 'off', pw)).toBeNull(); // suspended
    expect(await authenticateLocal(d, 'ghost', pw)).toBeNull();
  });
});
