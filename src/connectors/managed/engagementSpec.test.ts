// M0a review: the worker's engagement-config check (worker-safe: R1's module
// imports `@/data/models`, which the worker build cannot resolve). It must agree
// with R1 (src/engagement/config.ts) on every key it checks: the same table of
// accept/reject cases runs through both validators, and its constants are pinned
// to R1's exports and source text. SYNTHETIC values only.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { MANAGED_CONNECTORS as R1_CONNECTORS, validateEngagementConfig } from '../../engagement/config';
import { CREDENTIAL_RE, MANAGED_CONNECTORS, MAX_PARAM_ENTRIES, SECRET_REF_RE, SOURCE_ID_RE, engagementProblems, managedSpecFromEngagementFile } from './engagementSpec';
import { ManagedError } from './runtime';

const FIXTURE = path.resolve(__dirname, '../../../fixtures/engagement/example/engagement.json');
const R1_TEXT = fs.readFileSync(path.resolve(__dirname, '../../engagement/config.ts'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const example = (): any => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const TENANT: string = example().tenantId;
const SID: string = example().sources[0].id;
const PEM = '-----BEGIN PRIVATE KEY-----';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl';
const OPAQUE = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg';

/** Each case edits the R1 example; `ok` is the verdict BOTH validators must reach. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CASES: Array<{ name: string; ok: boolean; edit: (c: any) => void }> = [
  { name: 'the example (file-drop by default)', ok: true, edit: () => undefined },
  { name: 'managed, params and secretRef', ok: true, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', params: { window: '1d', n: 3, on: true, tags: ['a'], nested: { x: 'y' } }, secretRef: 'k8s/opencost' }) },
  { name: 'managed without secretRef', ok: true, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports' }) },
  { name: 'explicit file-drop', ok: true, edit: (c) => (c.sources[0].retrieval = { kind: 'file-drop' }) },
  { name: 'file-drop with connector', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'file-drop', connector: 'opencost' }) },
  { name: 'unknown connector', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: '../evil' }) },
  { name: 'unknown retrieval key', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', extra: 1 }) },
  { name: 'unknown kind', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'ftp', connector: 'opencost' }) },
  { name: 'empty secretRef', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', secretRef: '' }) },
  { name: 'absolute secretRef', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', secretRef: '/etc/passwd' }) },
  { name: 'credential secretRef', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', secretRef: 'A'.repeat(48) }) },
  { name: 'secretRef not a string', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', secretRef: 7 }) },
  { name: 'AWS key id in params', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', params: { accessKey: 'AKIAABCDEFGHIJKLMNOP' } }) },
  { name: 'PEM in params', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', params: { k: `${PEM}\nMIIB` } }) },
  { name: 'JWT in nested params', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', params: { auth: { t: JWT } } }) },
  { name: 'long opaque base64 in a params list', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', params: { l: ['ok', OPAQUE] } }) },
  { name: 'params nested 3 levels', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', params: { a: { b: { c: 1 } } } }) },
  { name: 'params not an object', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', params: [1] }) },
  { name: 'too many params', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', params: Object.fromEntries(Array.from({ length: MAX_PARAM_ENTRIES + 1 }, (_, i) => [`p${i}`, i])) }) },
  { name: 'params value a control character', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', params: { a: 'x\ny' } }) },
  { name: 'params value null', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', params: { a: null } }) },
  { name: 'duplicate source id', ok: false, edit: (c) => c.sources.push({ ...c.sources[0] }) },
  { name: 'unknown source key', ok: false, edit: (c) => (c.sources[0].extra = 1) },
  { name: 'bad source id', ok: false, edit: (c) => (c.sources[0].id = 'Bad Id') },
  { name: 'unknown top-level key', ok: false, edit: (c) => (c.extra = 1) },
  { name: 'tenantId not a UUID', ok: false, edit: (c) => (c.tenantId = 'tenant-1') },
  { name: 'no sources', ok: false, edit: (c) => (c.sources = []) },
];

describe('worker engagement-config check (parity with R1)', () => {
  for (const tc of CASES) {
    it(`${tc.ok ? 'accepts' : 'refuses'}: ${tc.name}`, () => {
      const c = example();
      tc.edit(c);
      expect(validateEngagementConfig(c).ok, 'R1 verdict').toBe(tc.ok);
      expect(engagementProblems(c), 'worker verdict').toEqual(tc.ok ? [] : expect.arrayContaining([expect.any(String)]));
      for (const p of engagementProblems(c)) for (const v of ['AKIAABCDEFGHIJKLMNOP', PEM, JWT, OPAQUE, '/etc/passwd']) expect(p).not.toContain(v);
    });
  }

  it('names the same key and reason as R1 for nesting, credentials and duplicates', () => {
    const c = example();
    c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', params: { a: { b: { c: 1 } }, k: 'AKIAABCDEFGHIJKLMNOP' } };
    c.sources.push({ ...c.sources[0] });
    const r1 = validateEngagementConfig(c);
    const mine = engagementProblems(c);
    for (const want of ['sources[0].retrieval.params.a.b: nesting deeper than 2 levels is not allowed', 'sources[0].retrieval.params.k: looks like a credential value; reference a secret by name with secretRef', 'sources[1].id: duplicate source id']) {
      expect(r1.ok ? [] : r1.problems).toContain(want);
      expect(mine).toContain(want);
    }
  });

  it("pins the worker's constants to R1's exports and source text", () => {
    expect([...MANAGED_CONNECTORS]).toEqual([...R1_CONNECTORS]);
    for (const re of CREDENTIAL_RE) expect(R1_TEXT).toContain(re.source);
    expect(R1_TEXT).toContain(`const SECRET_REF_RE = /${SECRET_REF_RE.source}/;`);
    expect(R1_TEXT).toContain(`const SOURCE_ID_RE = /${SOURCE_ID_RE.source}/;`);
    expect(R1_TEXT).toContain(`Object.keys(o.params).length > ${MAX_PARAM_ENTRIES}`);
  });
});

describe('managedSpecFromEngagementFile binds the config to the tenant', () => {
  const write = (v: unknown) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-eng-'));
    const f = path.join(d, 'engagement.json');
    fs.writeFileSync(f, JSON.stringify(v));
    return f;
  };
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(ManagedError);
      return (e as ManagedError).code;
    }
    return 'NO_ERROR';
  };
  const managed = () => {
    const c = example();
    c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', secretRef: 'k8s/opencost' };
    return c;
  };

  it('reads the spec only for the tenant the config names', () => {
    const f = write(managed());
    expect(managedSpecFromEngagementFile(f, SID, TENANT)).toEqual({ connector: 'opencost', params: {}, secretRef: 'k8s/opencost' });
    expect(managedSpecFromEngagementFile(f, SID, TENANT.toUpperCase())).toEqual({ connector: 'opencost', params: {}, secretRef: 'k8s/opencost' });
    expect(codeOf(() => managedSpecFromEngagementFile(f, SID, '33333333-3333-4333-8333-333333333333'))).toBe('ENGAGEMENT_TENANT_MISMATCH');
    const noTenant = managed();
    delete noTenant.tenantId;
    expect(codeOf(() => managedSpecFromEngagementFile(write(noTenant), SID, TENANT))).toBe('ENGAGEMENT_CONFIG_INVALID');
  });

  it('refuses a config R1 would refuse, naming the key and never the value', () => {
    const c = managed();
    c.sources[0].retrieval.params = { accessKey: 'AKIAABCDEFGHIJKLMNOP' };
    let msg = '';
    try {
      managedSpecFromEngagementFile(write(c), SID, TENANT);
    } catch (e) {
      msg = (e as Error).message;
      expect((e as ManagedError).code).toBe('ENGAGEMENT_CONFIG_INVALID');
    }
    expect(msg).toContain('sources[0].retrieval.params.accessKey');
    expect(msg).not.toContain('AKIAABCDEFGHIJKLMNOP');
    const dup = managed();
    dup.sources.push({ ...dup.sources[0] });
    expect(codeOf(() => managedSpecFromEngagementFile(write(dup), SID, TENANT))).toBe('ENGAGEMENT_CONFIG_INVALID');
    expect(codeOf(() => managedSpecFromEngagementFile(write(example()), SID, TENANT))).toBe('SOURCE_NOT_MANAGED');
    expect(codeOf(() => managedSpecFromEngagementFile(write(managed()), 'missing', TENANT))).toBe('SOURCE_NOT_IN_ENGAGEMENT_CONFIG');
  });
});
