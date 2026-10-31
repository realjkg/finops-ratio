// Playwright webServer prelude for the engagement report page suite (test-only).
// Writes a SYNTHETIC users directory and two sessions (viewer, analyst) into a
// fresh state store under the results directory; the spec reads the tokens.
// No password exists: the sessions are created directly in the store.
import fs from 'node:fs';
import path from 'node:path';
import { EngagementSessionStore } from '../../src/engagement/auth/session';

const out = path.resolve(process.argv[2] ?? '.engagement-test-results');
const T = '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d'; // fixtures/engagement/example/engagement.json
const E = 'example-focus-sample';
fs.rmSync(path.join(out, 'state'), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'users.json'), JSON.stringify({
  version: 1,
  users: [{ id: 'viewer', displayName: 'SYNTHETIC Viewer', status: 'active' }, { id: 'analyst', displayName: 'SYNTHETIC Analyst', status: 'active' }],
  identityConnections: [{ id: 'synthetic-idp', tenantId: T, protocol: 'oidc', issuer: 'https://idp.example.test/synthetic', clientId: 'ratio-synthetic',
    clientSecretRef: 'RATIO_OIDC_CLIENT_SECRET_SYNTHETIC', provisioning: 'invite-only', enabled: true }],
  memberships: [{ userId: 'viewer', tenantId: T, engagementId: E, role: 'viewer', status: 'active' }, { userId: 'analyst', tenantId: T, engagementId: E, role: 'analyst', status: 'active' }],
}));
const store = new EngagementSessionStore(path.join(out, 'state', 'sessions.sqlite'));
const tokens = Object.fromEntries(['viewer', 'analyst'].map((u) => [u, store.create({ userId: u, tenantId: T, engagementId: E }).token]));
store.close();
fs.writeFileSync(path.join(out, 'tokens.json'), JSON.stringify(tokens), { mode: 0o600 });
