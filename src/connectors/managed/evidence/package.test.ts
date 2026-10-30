// M0b: the Connector Evidence Record. Redacted, credential-free, honest about
// fixtures and readiness (T/S/F/O); a sanitized or synthetic fixture is never a
// reconciliation proof and nothing claims "live" without original evidence.
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { buildBridge, type Bridge } from './bridge';
import { observeSchema, versionFacts } from './capture';
import { LIVE_STATUS, PRE_ROLLOUT_STATUS, buildEvidenceRecord, type EvidenceRecordInput } from './package';
import type { CapturedOriginal } from './types';

const bridge = buildBridge({
  key: { scope: 'billing-account:SYNTHETIC-1', period: '2026-09-01', costBasis: 'billed' },
  source: [{ measure: 'billed', currency: 'USD', amount: '8.50' }],
  normalized: [{ measure: 'billed', currency: 'USD', amount: '8.50' }],
  deltas: [],
});

const HEX = 'cd'.repeat(32);
const captured = (): CapturedOriginal => ({ sha256: HEX, byteSize: 1, key: `connector-originals/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/${HEX}`, identity: { kind: 'object', bucket: 'b', key: 'k' }, retrievedAt: '2026-10-28T12:00:00.000Z', stored: 'stored' });

const input = (): EvidenceRecordInput => ({
  identity: { connector: 'aws-data-exports', sourceKey: 'aws-focus', dataset: 'FOCUS 1.2 export' },
  upstream: {
    officialReference: 'vendor data export documentation (NOT VERIFIED)',
    versions: versionFacts({ provider: 'AWS', dataset: 'FOCUS 1.2 export', observedSchema: observeSchema(['BilledCost']), mappingVersion: 'focus-passthrough', canonicalModelVersion: 'ratio-focus-1.0' }),
    retrievalDate: '2026-10-28T12:00:00.000Z',
    operations: ['s3:ListObjectsV2', 's3:GetObject'],
  },
  authorization: { method: 'static-key', secretRef: 'aws/focus-reader', principal: 'unknown', scopes: [], boundary: 'read-only', restrictions: 'export prefix only', approver: 'pending' },
  semantics: { costBasis: 'billed', currencyUnit: 'ISO 4217, major units', usageWindow: { start: '2026-09-01', end: '2026-10-01' }, billingPeriod: '2026-09-01', creditsRefundsAdjustments: 'credits as separate rows', refreshHistory: 'manifest rewrite supersedes', role: 'authoritative' },
  proof: {
    originals: [],
    delivery: { scope: 'billing-account:SYNTHETIC-1', usageWindow: { start: '2026-09-01', end: '2026-10-01' }, billingPeriod: '2026-09-01', extractedAt: '2026-10-28T12:00:00.000Z', filters: {}, grouping: [], completion: 'complete', revision: 'r1', exclusions: [] },
    counts: { source: '1', accepted: '1', quarantined: '0' },
    bridge,
    exclusions: [],
  },
  fixture: { fixtureClass: 'synthetic', use: 'contract-test', sanitization: 'SYNTHETIC values; no customer data', coverage: 'one period, one currency' },
  release: { commit: 'abc1234', tests: 'vitest src/connectors/managed', customerValidation: 'pending', owner: 'engagement owner', rollback: 'disable the source', status: 'implemented' },
  readiness: { T: 'fixture', S: 'fixture', F: 'none', O: 'fixture' },
});

describe('Connector Evidence Record', () => {
  it('builds the spec-pack sections with T/S/F/O and the pre-rollout status wording', () => {
    const r = buildEvidenceRecord(input());
    expect(Object.keys(r)).toEqual(['recordVersion', 'identity', 'upstream', 'authorization', 'semantics', 'proof', 'fixture', 'release', 'readiness', 'redactions']);
    expect(r.release.status).toBe(PRE_ROLLOUT_STATUS);
    expect(PRE_ROLLOUT_STATUS).toBe('Implemented and pre-release validated; live verification scheduled for MVP rollout');
    expect(r.readiness).toEqual({ T: 'fixture', S: 'fixture', F: 'none', O: 'fixture' });
    expect(r.redactions).toBe(0);
  });

  it('no field carries a value matching a secret pattern', () => {
    const i = input();
    i.authorization.restrictions = 'Bearer abcdefghijklmnop';
    i.release.rollback = 'AKIAABCDEFGHIJKLMNOP';
    i.proof.exclusions = ['-----BEGIN PRIVATE KEY-----', 'password=hunter2'];
    i.upstream.officialReference = 'https://example.test/doc?sig=SYNTHETICSIG';
    const r = buildEvidenceRecord(i);
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/abcdefghijklmnop|AKIAABCDEFGHIJKLMNOP|BEGIN PRIVATE|hunter2|SYNTHETICSIG/);
    expect(r.redactions).toBe(5);
    // Hashes and the secretRef NAME stay.
    expect(text).toContain((r.upstream.versions.observedSchema as { sha256: string }).sha256);
    expect(r.authorization.secretRef).toBe('aws/focus-reader');
  });

  it('refuses a sanitized or synthetic fixture used as a reconciliation proof', () => {
    for (const fixtureClass of ['sanitized', 'synthetic'] as const) {
      const i = input();
      i.fixture = { ...i.fixture, fixtureClass, use: 'reconciliation-proof' };
      expect(() => buildEvidenceRecord(i)).toThrow(/FIXTURE_NOT_PROOF/);
    }
    const i = input();
    i.fixture = { ...i.fixture, fixtureClass: 'original', use: 'reconciliation-proof' };
    i.proof.originals = [captured()];
    expect(buildEvidenceRecord(i).fixture.use).toBe('reconciliation-proof');
  });

  it('a reconciliation proof needs a closed bridge and a complete delivery', () => {
    const i = input();
    i.fixture = { ...i.fixture, fixtureClass: 'original', use: 'reconciliation-proof' };
    i.proof.originals = [captured()];
    i.proof.delivery = { ...i.proof.delivery, completion: 'incomplete' };
    expect(() => buildEvidenceRecord(i)).toThrow(/PROOF_INCOMPLETE/);
    const j = input();
    j.fixture = { ...j.fixture, fixtureClass: 'original', use: 'reconciliation-proof' };
    j.proof.originals = [captured()];
    j.proof.bridge = { ...bridge, closed: false };
    expect(() => buildEvidenceRecord(j)).toThrow(/PROOF_INCOMPLETE/);
  });

  it('never claims live readiness or a live status without original evidence and customer validation', () => {
    const i = input();
    i.readiness = { ...i.readiness, T: 'live' };
    expect(() => buildEvidenceRecord(i)).toThrow(/LIVE_CLAIM_UNSUPPORTED/);
    const j = input();
    j.release.status = 'live verified';
    expect(() => buildEvidenceRecord(j)).toThrow(/LIVE_CLAIM_UNSUPPORTED/);
    const o = input();
    o.fixture = { ...o.fixture, fixtureClass: 'original' };
    o.readiness = { ...o.readiness, F: 'live' };
    o.proof.originals = [captured()];
    expect(() => buildEvidenceRecord(o)).toThrow(/LIVE_CLAIM_UNSUPPORTED/); // original, but no customer validation
    const k = input();
    k.fixture = { ...k.fixture, fixtureClass: 'original' };
    k.release.customerValidation = 'validated';
    k.readiness = { ...k.readiness, T: 'live' };
    k.proof.originals = [captured()];
    expect(buildEvidenceRecord(k).readiness.T).toBe('live');
  });

  it('requires sanitization and coverage notes', () => {
    const i = input();
    i.fixture.sanitization = '';
    expect(() => buildEvidenceRecord(i)).toThrow(/sanitization/);
    const j = input();
    j.fixture.coverage = '  ';
    expect(() => buildEvidenceRecord(j)).toThrow(/coverage/);
  });
});

describe('Connector Evidence Record: review round (#148)', () => {
  const T = '11111111-1111-4111-8111-111111111111';
  const S = '22222222-2222-4222-8222-222222222222';
  const hex = 'ab'.repeat(32);
  const original = (o: Partial<CapturedOriginal> = {}): CapturedOriginal => ({
    sha256: hex, byteSize: 10, key: `connector-originals/${T}/${S}/${hex}`, retrievedAt: '2026-10-28T12:00:00.000Z', stored: 'stored',
    identity: { kind: 'object', bucket: 'synthetic-bucket', key: 'exports/focus-export/data/BILLING_PERIOD=2026-09/part-00001-of-00004.csv.gz', etag: 'c'.repeat(32) }, ...o,
  });
  const live = (): EvidenceRecordInput => {
    const i = input();
    i.fixture = { ...i.fixture, fixtureClass: 'original', use: 'reconciliation-proof' };
    i.release = { ...i.release, customerValidation: 'validated' };
    i.readiness = { T: 'live', S: 'live', F: 'live', O: 'live' };
    i.proof.originals = [original()];
    return i;
  };

  it('a live claim needs at least one captured original with a sha256 and its content-addressed key', () => {
    expect(buildEvidenceRecord(live()).release.status).toBe(LIVE_STATUS);
    const bad: Array<Partial<CapturedOriginal>[]> = [[], [{ sha256: 'nope' }], [{ key: '' }], [{ key: `connector-originals/${T}/${S}/${'0'.repeat(64)}` }]];
    for (const os of bad) {
      const i = live();
      i.fixture.use = 'contract-test';
      i.proof.originals = os.map((o) => original(o));
      if (os.length === 0) i.proof.originals = [];
      expect(() => buildEvidenceRecord(i)).toThrow(/LIVE_CLAIM_UNSUPPORTED/);
    }
  });

  it('a reconciliation proof needs originals and a money line per currency; an aggregate control is never proof', () => {
    const empty = buildBridge({ key: bridge.key, source: [], normalized: [], deltas: [] });
    const controlOnly = buildBridge({ key: bridge.key, source: [], normalized: [], deltas: [], controls: [{ measure: 'billed', currency: 'USD', amount: '5', origin: 'azure-query' }] });
    for (const b of [empty, controlOnly, { ...empty, closed: true, failures: [] }, { ...controlOnly, closed: true, failures: [] }]) {
      const i = live();
      i.proof.bridge = b;
      expect(() => buildEvidenceRecord(i)).toThrow(/PROOF_INCOMPLETE/);
    }
    const i = live();
    i.readiness = { T: 'fixture', S: 'fixture', F: 'fixture', O: 'fixture' };
    i.proof.originals = [];
    expect(() => buildEvidenceRecord(i)).toThrow(/PROOF_INCOMPLETE/);
  });

  it('redacts credentials by name anywhere in the key (key=value, JSON, headers, URL query and userinfo) and by value pattern', () => {
    const secrets = ['Sh0rtS3cret99', 'abcd1234efgh5678', 'hunter2hunter2', 'FQoGZXIvYXdzEJr', 'pw0rdUser', 'js0nS3cret', 'eyJhbGciOi.x.y', 'authcode123', 'abc.def.ghi', 'azur3K3y==', 'subk3y99', 'deadbeefsig', 'Pa55word', 'rt-value-1', 'ak1ak1', 'ASIAABCDEFGHIJKLMNOP', 'MIIEvQIBADANBg', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlX3g', 'qs-secret-7', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1u'];
    const i = input();
    i.authorization.restrictions = 'client_secret=Sh0rtS3cret99 access_token=abcd1234efgh5678 X-Api-Key: hunter2hunter2 aws_session_token=FQoGZXIvYXdzEJr';
    i.proof.exclusions = [
      'https://svc:pw0rdUser@host.example.test/x', '{"client_secret":"js0nS3cret","limit":"10"}', 'client_assertion=eyJhbGciOi.x.y', 'https://login.example.test/cb?code=authcode123&state=ok',
      'Authorization: Bearer abc.def.ghi', 'DefaultEndpointsProtocol=https;AccountKey=azur3K3y==;EndpointSuffix=core', 'Ocp-Apim-Subscription-Key: subk3y99', 'X-Amz-Signature=deadbeefsig',
      'PASSWORD: Pa55word', "refresh_token: 'rt-value-1'", 'apiKey=ak1ak1', 'ASIAABCDEFGHIJKLMNOP', '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END RSA PRIVATE KEY-----',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlX3g', 'https://api.example.test/v1?x-amz-security-token=qs-secret-7&limit=5', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1u',
    ];
    i.proof.delivery = { ...i.proof.delivery, filters: { client_secret: 'qs-secret-7', sortKey: 'date' } };
    const r = buildEvidenceRecord(i);
    const text = JSON.stringify(r);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(r.proof.delivery.filters).toEqual({ client_secret: '[redacted]', sortKey: 'date' });
    expect(r.proof.exclusions[1]).toBe('{"client_secret":"[redacted]","limit":"10"}');
    expect(r.proof.exclusions[3]).toBe('https://login.example.test/cb?code=[redacted]&state=ok');
    expect(r.authorization.restrictions).toBe('client_secret=[redacted] access_token=[redacted] X-Api-Key: [redacted] aws_session_token=[redacted]');
    expect(r.authorization.secretRef).toBe('aws/focus-reader');
  });

  it('keeps evidence locators intact: original keys, sha256 values, UUIDs, object keys, endpoint paths, pagination identity', () => {
    const i = input();
    const azure = `https://management.azure.com/subscriptions/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/providers/Microsoft.CostManagement/query`;
    const page = original({ identity: { kind: 'page', endpoint: azure, method: 'POST', params: { pageToken: 'opaque-tok', sortKey: 'UsageDate', api_key: 'k-1' }, pageIndex: 0, pageToken: 'opaque-tok' } });
    const longKey = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh'; // an opaque object key is still a locator
    const path = 'exports/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh/part-1';
    i.proof.originals = [original(), page, original({ identity: { kind: 'object', bucket: 'b', key: longKey } })];
    i.proof.exclusions = [`see ${T} and ${hex}`, `skipped prefix ${path}`];
    const r = buildEvidenceRecord(i);
    expect(r.proof.originals[0]).toEqual(original());
    expect(r.proof.originals[1].key).toBe(`connector-originals/${T}/${S}/${hex}`);
    const tok = `sha256:${createHash('sha256').update('opaque-tok').digest('hex')}`;
    expect(r.proof.originals[1].identity).toEqual({ kind: 'page', endpoint: azure, method: 'POST', params: { pageToken: tok, sortKey: 'UsageDate', api_key: '[redacted]' }, pageIndex: 0, pageToken: tok });
    expect((r.proof.originals[2].identity as { key: string }).key).toBe(longKey);
    expect(r.proof.exclusions).toEqual([`see ${T} and ${hex}`, `skipped prefix ${path}`]);
  });
});

describe('Connector Evidence Record: review round 2 (#148)', () => {
  const proofInput = (b: Bridge, o: CapturedOriginal[] = [captured()]) => {
    const i = input();
    i.fixture = { ...i.fixture, fixtureClass: 'original', use: 'reconciliation-proof' };
    i.proof.originals = o;
    i.proof.bridge = b;
    return i;
  };

  it('re-verifies the bridge arithmetic, not only its flags', () => {
    const line = { measure: 'billed', currency: 'USD', source: '100', deltas: [], normalized: '1', closes: true };
    const forged: Bridge = { ...bridge, lines: [line], failures: [], closed: true };
    expect(() => buildEvidenceRecord(proofInput(forged))).toThrow(/PROOF_INCOMPLETE/);
    expect(buildEvidenceRecord(proofInput({ ...forged, lines: [{ ...line, deltas: [{ amount: '-99', reason: 'split' }] }] })).fixture.use).toBe('reconciliation-proof');
  });

  it('a count measure tagged with a currency is not a money line', () => {
    const rows = buildBridge({ key: bridge.key, source: [{ measure: 'rows', currency: 'USD', amount: '3' }], normalized: [{ measure: 'rows', currency: 'USD', amount: '3' }], deltas: [] });
    expect(rows.failures.map((f) => f.code)).toEqual(['BRIDGE_NO_MONEY_LINE', 'BRIDGE_CURRENCY_UNCOVERED']);
    expect(() => buildEvidenceRecord(proofInput({ ...rows, failures: [], closed: true }))).toThrow(/PROOF_INCOMPLETE/);
  });

  it('an original key must be connector-originals/<uuid>/<uuid>/<sha256>', () => {
    for (const key of [`connector-originals//${HEX}`, `connector-originals/x/y/${HEX}`, `connector-originals/11111111-1111-4111-8111-111111111111/${HEX}`]) {
      expect(() => buildEvidenceRecord(proofInput(bridge, [{ ...captured(), key }]))).toThrow(/PROOF_INCOMPLETE/);
    }
  });
});
