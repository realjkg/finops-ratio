// M0a review: the worker's engagement-config check (worker-safe: R1's module
// imports `@/data/models`, which the worker build cannot resolve). It must agree
// with R1 (src/engagement/config.ts) on every key it checks: the same table of
// accept/reject cases runs through both validators, and its constants are pinned
// to R1's exports and source text. SYNTHETIC values only.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { MANAGED_CONNECTORS as R1_CONNECTORS, SUPPORTED_IN_THIS_BUILD, checkEngagementConfig, validateEngagementConfig } from '../../engagement/config';
import { AWS_BUCKET_RE, AWS_EXPORT_NAME_RE, AWS_FILE_PART_RESERVE_BYTES, AWS_INLINE_CREDENTIAL_RE, AWS_JWT_RE, AWS_KEY_ID_RE, AWS_USERINFO_RE, CREDENTIAL_RE, MANAGED_CONNECTORS, MAX_PARAM_ENTRIES, S3_KEY_MAX_BYTES, SECRET_REF_RE, SOURCE_ID_RE, engagementProblems } from './engagementSpec';
import { managedRegistry } from './registry';
// The worker's entry point: it checks the config against the live registry (the worker's approved list).
import { ManagedError, managedSpecFromEngagementFile } from './runtime';

const FIXTURE = path.resolve(__dirname, '../../../fixtures/engagement/example/engagement.json');
const R1_TEXT = fs.readFileSync(path.resolve(__dirname, '../../engagement/config.ts'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const example = (): any => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const TENANT: string = example().tenantId;
const SID: string = example().sources[0].id;
const PEM = '-----BEGIN PRIVATE KEY-----';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl';
const OPAQUE = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg';
/** Deterministic generated names (SYNTHETIC): random-looking, as real generated names are, without literal secret-shaped text. */
const generated = (n: number, alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', seed = 7) => {
  let x = seed;
  return Array.from({ length: n }, () => alphabet[(x = (x * 1103515245 + 12345) % 2147483648) % alphabet.length]).join('');
};
const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';
// SYNTHETIC; credential-shaped values are assembled at run time.
const REGISTERED = managedRegistry.connectors();
const LEGACY_KEY_ID = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');
const KEY_ID = ['AK', 'IA'].join('') + 'SYNTHETIC0000003'.toUpperCase();
const AWS = (params: Record<string, unknown>) => ({ kind: 'managed', connector: 'aws-data-exports', secretRef: 'aws/focus', params: { region: 'us-east-1', table: 'FOCUS_1_2_AWS', ...params } });

/** Each case edits the R1 example; `ok` is the verdict BOTH validators must reach. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CASES: Array<{ name: string; ok: boolean; edit: (c: any) => void }> = [
  { name: 'the example (file-drop by default)', ok: true, edit: () => undefined },
  { name: 'managed, params and secretRef', ok: true, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', params: { window: '1d', n: 3, on: true, tags: ['a'], nested: { x: 'y' } }, secretRef: 'aws/focus' }) },
  { name: 'managed without secretRef', ok: true, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports' }) },
  { name: 'explicit file-drop', ok: true, edit: (c) => (c.sources[0].retrieval = { kind: 'file-drop' }) },
  { name: 'file-drop with connector', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'file-drop', connector: 'aws-data-exports' }) },
  { name: 'unknown connector', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: '../evil' }) },
  { name: 'unknown retrieval key', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', extra: 1 }) },
  { name: 'unknown kind', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'ftp', connector: 'aws-data-exports' }) },
  { name: 'empty secretRef', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', secretRef: '' }) },
  { name: 'absolute secretRef', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', secretRef: '/etc/passwd' }) },
  { name: 'credential secretRef', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', secretRef: 'A'.repeat(48) }) },
  { name: 'secretRef not a string', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', secretRef: 7 }) },
  { name: 'AWS key id in params', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', params: { accessKey: LEGACY_KEY_ID } }) },
  { name: 'PEM in params', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', params: { k: `${PEM}\nMIIB` } }) },
  { name: 'JWT in nested params', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', params: { auth: { t: JWT } } }) },
  { name: 'long opaque base64 in a params list', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', params: { l: ['ok', OPAQUE] } }) },
  { name: 'params nested 3 levels', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', params: { a: { b: { c: 1 } } } }) },
  { name: 'params not an object', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', params: [1] }) },
  { name: 'too many params', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', params: Object.fromEntries(Array.from({ length: MAX_PARAM_ENTRIES + 1 }, (_, i) => [`p${i}`, i])) }) },
  { name: 'params value a control character', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', params: { a: 'x\ny' } }) },
  { name: 'params value null', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', params: { a: null } }) },
  { name: 'duplicate source id', ok: false, edit: (c) => c.sources.push({ ...c.sources[0] }) },
  { name: 'unknown source key', ok: false, edit: (c) => (c.sources[0].extra = 1) },
  { name: 'bad source id', ok: false, edit: (c) => (c.sources[0].id = 'Bad Id') },
  { name: 'unknown top-level key', ok: false, edit: (c) => (c.extra = 1) },
  { name: 'tenantId not a UUID', ok: false, edit: (c) => (c.tenantId = 'tenant-1') },
  { name: 'no sources', ok: false, edit: (c) => (c.sources = []) },
  { name: 'unsupported managed connector (schema-valid, not on the approved list)', ok: false, edit: (c) => (c.sources[0].retrieval = { kind: 'managed', connector: 'opencost', secretRef: 'k8s/opencost' }) },
  { name: 'AWS: valid long bucket, prefix and exportName', ok: true, edit: (c) => (c.sources[0].retrieval = AWS({ bucket: generated(48, LOWER), prefix: `${generated(43, undefined, 13)}/年度`, exportName: generated(41, undefined, 11) })) },
  { name: 'AWS: malformed bucket', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ bucket: 'xn--export' })) },
  { name: 'AWS: bucket in IP address form', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ bucket: '10.0.0.1' })) },
  { name: 'AWS: malformed exportName', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ exportName: 'focus.daily' })) },
  { name: 'AWS: prefix with a .. segment', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ prefix: 'a/../b' })) },
  { name: 'AWS: prefix not valid UTF-8', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ prefix: 'a\ud800b' })) },
  { name: 'AWS: key id as exportName', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ exportName: KEY_ID })) },
  { name: 'AWS: JWT in the prefix', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ prefix: `x/${JWT}` })) },
  { name: 'AWS: private key in the prefix', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ prefix: `x/${PEM}` })) },
  { name: 'AWS: key id after digits in the prefix', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ prefix: `2024${KEY_ID}` })) },
  { name: 'AWS: key id after capitals in exportName', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ exportName: `EXPORT${KEY_ID}` })) },
  { name: 'AWS: key id followed by a digit in exportName', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ exportName: `${KEY_ID}9` })) },
  { name: 'AWS: JWT after text in a prefix segment', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ prefix: `x/tok-${JWT}` })) },
  { name: 'AWS: URL credentials in a later prefix segment', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ prefix: 'x/admin:pw@host' })) },
  { name: 'AWS: inline apikey with spaces in the prefix', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ prefix: 'x/apikey = v' })) },
  { name: 'AWS: fullwidth key id in the prefix', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ prefix: [...KEY_ID].map((ch) => String.fromCodePoint(ch.codePointAt(0)! + 0xfee0)).join('') })) },
  { name: 'AWS: lowercase akia names and @ without a colon pass', ok: true, edit: (c) => (c.sources[0].retrieval = AWS({ bucket: 'akia-prefix-name', exportName: 'akia_asia-export', prefix: 'akiaexports/a@b/user:name' })) },
  { name: 'AWS: long opaque value outside the three fields', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ other: OPAQUE })) },
  { name: 'AWS: long value at a nested bucket path', ok: false, edit: (c) => (c.sources[0].retrieval = AWS({ nested: { bucket: 'a'.repeat(41) } })) },
];

describe('worker engagement-config check (parity with R1)', () => {
  for (const tc of CASES) {
    it(`${tc.ok ? 'accepts' : 'refuses'}: ${tc.name}`, () => {
      const c = example();
      tc.edit(c);
      // R1's startup verdict (schema, then SUPPORTED_IN_THIS_BUILD) is what instrumentation enforces.
      expect(checkEngagementConfig(c).ok, 'R1 startup verdict').toBe(tc.ok);
      expect(engagementProblems(c, REGISTERED), 'worker verdict').toEqual(tc.ok ? [] : expect.arrayContaining([expect.any(String)]));
      for (const p of engagementProblems(c, REGISTERED)) for (const v of [LEGACY_KEY_ID, KEY_ID, PEM, JWT, OPAQUE, '/etc/passwd']) expect(p).not.toContain(v);
    });
  }

  it('names the same key and reason as R1 for nesting, credentials and duplicates', () => {
    const c = example();
    c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', params: { a: { b: { c: 1 } }, k: LEGACY_KEY_ID, bucket: 'Bad_Bucket', exportName: KEY_ID, prefix: '/x' } };
    c.sources.push({ ...c.sources[0] });
    const r1 = validateEngagementConfig(c);
    const mine = engagementProblems(c, REGISTERED);
    for (const want of [
      'sources[0].retrieval.params.a.b: nesting deeper than 2 levels is not allowed',
      'sources[0].retrieval.params.k: looks like a credential value; reference a secret by name with secretRef',
      'sources[0].retrieval.params.exportName: looks like a credential value; reference a secret by name with secretRef',
      'sources[1].id: duplicate source id',
    ]) {
      expect(r1.ok ? [] : r1.problems).toContain(want);
      expect(mine).toContain(want);
    }
    for (const field of ['bucket', 'prefix']) {
      const key = `sources[0].retrieval.params.${field}:`;
      expect((r1.ok ? [] : r1.problems).filter((p) => p.startsWith(key))).toEqual(mine.filter((p) => p.startsWith(key)));
      expect(mine.filter((p) => p.startsWith(key))).toHaveLength(1);
    }
  });

  it('names the same key and reason as R1 startup for a connector that is not approved', () => {
    const c = example();
    c.sources[0].retrieval = { kind: 'managed', connector: 'nutanix' };
    const r1 = checkEngagementConfig(c);
    expect(r1.ok ? [] : r1.problems).toEqual(['sources[0].retrieval.connector: not implemented in this build']);
    expect(engagementProblems(c, REGISTERED)).toEqual(['sources[0].retrieval.connector: not implemented in this build']);
  });

  it("R1's approved list equals the connectors registered in the worker registry", () => {
    expect([...SUPPORTED_IN_THIS_BUILD.managedConnectors].sort()).toEqual(managedRegistry.connectors());
    expect(SUPPORTED_IN_THIS_BUILD.retrievalKinds).toEqual(['file-drop', 'managed']);
  });

  it('refuses 1 MiB hostile AWS location values in under 100 ms on both sides (lengths before patterns)', () => {
    const n = 1024 * 1024;
    for (const field of ['bucket', 'prefix', 'exportName']) {
      for (const v of [':'.repeat(n), 'a:'.repeat(n / 2), 'eyJ'.repeat(n / 3), 'eyJaaaaaaaa'.repeat(Math.ceil(n / 11))]) {
        const c = example();
        c.sources[0].retrieval = AWS({ [field]: v });
        let t0 = performance.now();
        const worker = engagementProblems(c, REGISTERED);
        expect(performance.now() - t0, `worker ${field}`).toBeLessThan(100);
        t0 = performance.now();
        const startup = checkEngagementConfig(c);
        expect(performance.now() - t0, `startup ${field}`).toBeLessThan(100);
        expect(worker.some((p) => p.startsWith(`sources[0].retrieval.params.${field}:`))).toBe(true);
        expect(startup.ok ? [] : startup.problems.filter((p) => p.includes('.params.'))).toEqual(worker.filter((p) => p.includes('.params.')));
      }
    }
  });

  it('startup and the worker run the same awsLocationProblem source text', () => {
    const W_TEXT = fs.readFileSync(path.resolve(__dirname, 'engagementSpec.ts'), 'utf8');
    const fn = (t: string) => t.slice(t.indexOf('function awsLocationProblem('), t.indexOf('\n}\n', t.indexOf('function awsLocationProblem(')));
    expect(fn(W_TEXT).length).toBeGreaterThan(200);
    expect(fn(R1_TEXT)).toBe(fn(W_TEXT));
  });

  it('without an approved list the worker check refuses every managed connector (fail closed)', () => {
    const c = example();
    c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports' };
    expect(engagementProblems(c)).toEqual(['sources[0].retrieval.connector: not implemented in this build']);
  });


  it("pins the worker's constants to R1's exports and source text", () => {
    expect([...MANAGED_CONNECTORS]).toEqual([...R1_CONNECTORS]);
    for (const re of CREDENTIAL_RE) expect(R1_TEXT).toContain(re.source);
    expect(R1_TEXT).toContain(`const SECRET_REF_RE = /${SECRET_REF_RE.source}/;`);
    expect(R1_TEXT).toContain(`const SOURCE_ID_RE = /${SOURCE_ID_RE.source}/;`);
    expect(R1_TEXT).toContain(`Object.keys(o.params).length > ${MAX_PARAM_ENTRIES}`);
    for (const re of [AWS_BUCKET_RE, AWS_EXPORT_NAME_RE, AWS_KEY_ID_RE, AWS_JWT_RE, AWS_INLINE_CREDENTIAL_RE, AWS_USERINFO_RE]) expect(R1_TEXT).toContain(`/${re.source}/${re.flags}`);
    expect(R1_TEXT).toContain('const AWS_CREDENTIAL_RES = [CREDENTIAL_RE[0], AWS_KEY_ID_RE, AWS_JWT_RE, AWS_INLINE_CREDENTIAL_RE, AWS_USERINFO_RE];');
    expect(R1_TEXT).toContain(`const S3_KEY_MAX_BYTES = ${S3_KEY_MAX_BYTES};`);
    expect(R1_TEXT).toContain(`const AWS_FILE_PART_RESERVE_BYTES = ${AWS_FILE_PART_RESERVE_BYTES};`);
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
    c.sources[0].retrieval = { kind: 'managed', connector: 'aws-data-exports', secretRef: 'aws/focus' };
    return c;
  };

  it('reads the spec only for the tenant the config names', () => {
    const f = write(managed());
    expect(managedSpecFromEngagementFile(f, SID, TENANT)).toEqual({ connector: 'aws-data-exports', params: {}, secretRef: 'aws/focus' });
    expect(managedSpecFromEngagementFile(f, SID, TENANT.toUpperCase())).toEqual({ connector: 'aws-data-exports', params: {}, secretRef: 'aws/focus' });
    expect(codeOf(() => managedSpecFromEngagementFile(f, SID, '33333333-3333-4333-8333-333333333333'))).toBe('ENGAGEMENT_TENANT_MISMATCH');
    const noTenant = managed();
    delete noTenant.tenantId;
    expect(codeOf(() => managedSpecFromEngagementFile(write(noTenant), SID, TENANT))).toBe('ENGAGEMENT_CONFIG_INVALID');
  });

  it('refuses a config R1 would refuse, naming the key and never the value', () => {
    const c = managed();
    c.sources[0].retrieval.params = { accessKey: LEGACY_KEY_ID };
    let msg = '';
    try {
      managedSpecFromEngagementFile(write(c), SID, TENANT);
    } catch (e) {
      msg = (e as Error).message;
      expect((e as ManagedError).code).toBe('ENGAGEMENT_CONFIG_INVALID');
    }
    expect(msg).toContain('sources[0].retrieval.params.accessKey');
    expect(msg).not.toContain(LEGACY_KEY_ID);
    const dup = managed();
    dup.sources.push({ ...dup.sources[0] });
    expect(codeOf(() => managedSpecFromEngagementFile(write(dup), SID, TENANT))).toBe('ENGAGEMENT_CONFIG_INVALID');
    expect(codeOf(() => managedSpecFromEngagementFile(write(example()), SID, TENANT))).toBe('SOURCE_NOT_MANAGED');
    expect(codeOf(() => managedSpecFromEngagementFile(write(managed()), 'missing', TENANT))).toBe('SOURCE_NOT_IN_ENGAGEMENT_CONFIG');
    // A connector that is not approved is refused before any registry lookup, secret or network access.
    const unapproved = managed();
    unapproved.sources[0].retrieval = { kind: 'managed', connector: 'opencost', secretRef: 'k8s/opencost' };
    expect(codeOf(() => managedSpecFromEngagementFile(write(unapproved), SID, TENANT))).toBe('ENGAGEMENT_CONFIG_INVALID');
  });
});
