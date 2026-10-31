// R2 report page, server side: the /engagement page exists only in engagement
// mode; its state comes from the same session check as the report routes.
// SYNTHETIC users; no DB (the page itself reads nothing: the browser fetches
// the report through the slice-C routes).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from './auth/http';
import { EngagementSessionStore } from './auth/session';
import type { ReportAuditEvent } from './auth/reportAccess';
import { reportPageProps } from './reportPage';

const T = '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d';
const E = 'example-focus-sample';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-page-'));
const USERS = path.join(dir, 'users.json');
const NOW = Date.UTC(2026, 10, 15, 12);
const env = { RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: path.resolve(__dirname, '../../fixtures/engagement/example/engagement.json'), RATIO_ENGAGEMENT_USERS: USERS,
  RATIO_ENGAGEMENT_ORIGIN: 'https://ratio.example.test', RATIO_ENGAGEMENT_STATE: path.join(dir, 's.sqlite') };
let store: EngagementSessionStore;
let audits: ReportAuditEvent[];
const deps = () => ({ store: () => store, now: () => NOW, audit: (a: ReportAuditEvent) => { audits.push(a); } });
const req = (token?: string) => ({ headers: {}, cookies: token ? { [SESSION_COOKIE]: token } : {} });
const conn = (id: string, enabled: boolean) => ({ id, tenantId: T, protocol: 'oidc', issuer: `https://idp.example.test/${id}`, clientId: 'c', clientSecretRef: 'RATIO_OIDC_CLIENT_SECRET_X', provisioning: 'invite-only', enabled });
fs.writeFileSync(USERS, JSON.stringify({
  version: 1,
  users: ['v', 'a', 'ms'].map((id) => ({ id, displayName: `SYNTHETIC ${id}`, status: 'active' })),
  identityConnections: [conn('idp-a', true), conn('idp-off', false)],
  memberships: [{ userId: 'v', tenantId: T, engagementId: E, role: 'viewer', status: 'active' }, { userId: 'a', tenantId: T, engagementId: E, role: 'analyst', status: 'active' },
    { userId: 'ms', tenantId: T, engagementId: E, role: 'analyst', status: 'suspended' }],
}));
beforeEach(() => {
  store = new EngagementSessionStore(':memory:');
  audits = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const token = (userId: string) => store.create({ userId, tenantId: T, engagementId: E }, NOW).token;

describe('reportPageProps', () => {
  it('outside engagement mode the page does not exist (null ⇒ 404)', () => {
    expect(reportPageProps(req(), { ...env, RATIO_MODE: undefined }, deps())).toBeNull();
    expect(reportPageProps(req(), { ...env, RATIO_MODE: 'typo' }, deps())).toBeNull();
  });

  it('anonymous ⇒ 401 with only the ENABLED sign-in connections; the page audit is a denial without a name', () => {
    expect(reportPageProps(req(), env, deps())).toEqual({ status: 401, props: { state: 'signin', connections: ['idp-a'] } });
    expect(audits).toEqual([expect.objectContaining({ principalKind: 'none', format: 'page', permission: 'reports:read', outcome: 'deny', status: 401 })]);
  });

  it('a suspended membership ⇒ 403 denied; a store failure ⇒ 503 unavailable', () => {
    expect(reportPageProps(req(token('ms')), env, deps())).toEqual({ status: 403, props: { state: 'denied' } });
    const t = token('a');
    store.close();
    expect(reportPageProps(req(t), env, deps())).toEqual({ status: 503, props: { state: 'unavailable' } });
  });

  it('signed in: display name, export only with reports:export, default period = the previous month', () => {
    expect(reportPageProps(req(token('v')), env, deps())).toEqual({ status: 200, props: { state: 'ready', displayName: 'SYNTHETIC v', canExport: false, defaultPeriod: '2026-10' } });
    expect(reportPageProps(req(token('a')), env, deps())?.props).toMatchObject({ state: 'ready', canExport: true });
    expect(reportPageProps(req(token('a')), env, { ...deps(), now: () => Date.UTC(2026, 0, 3) })?.props).toMatchObject({ defaultPeriod: '2025-12' });
  });
});
