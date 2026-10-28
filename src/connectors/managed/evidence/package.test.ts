// M0b: the Connector Evidence Record. Redacted, credential-free, honest about
// fixtures and readiness (T/S/F/O); a sanitized or synthetic fixture is never a
// reconciliation proof and nothing claims "live" without original evidence.
import { describe, expect, it } from 'vitest';
import { buildBridge } from './bridge';
import { observeSchema, versionFacts } from './capture';
import { PRE_ROLLOUT_STATUS, buildEvidenceRecord, type EvidenceRecordInput } from './package';

const bridge = buildBridge({
  key: { scope: 'billing-account:SYNTHETIC-1', period: '2026-09-01', costBasis: 'billed' },
  source: [{ measure: 'billed', currency: 'USD', amount: '8.50' }],
  normalized: [{ measure: 'billed', currency: 'USD', amount: '8.50' }],
  deltas: [],
});

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
    expect(text).toContain(r.upstream.versions.observedSchema.sha256);
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
    expect(buildEvidenceRecord(i).fixture.use).toBe('reconciliation-proof');
  });

  it('a reconciliation proof needs a closed bridge and a complete delivery', () => {
    const i = input();
    i.fixture = { ...i.fixture, fixtureClass: 'original', use: 'reconciliation-proof' };
    i.proof.delivery = { ...i.proof.delivery, completion: 'incomplete' };
    expect(() => buildEvidenceRecord(i)).toThrow(/PROOF_INCOMPLETE/);
    const j = input();
    j.fixture = { ...j.fixture, fixtureClass: 'original', use: 'reconciliation-proof' };
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
    const k = input();
    k.fixture = { ...k.fixture, fixtureClass: 'original' };
    k.release.customerValidation = 'validated';
    k.readiness = { ...k.readiness, T: 'live' };
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
