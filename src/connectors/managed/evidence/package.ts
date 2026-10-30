// M0b: the Connector Evidence Record (spec-pack sections: identity, upstream
// contract, authorization, data semantics, integration proof, release) plus
// T/S/F/O readiness. Built redacted: any string that looks like credential
// material is replaced (and counted); only secret NAMES (secretRef) appear.
// Honesty rules, enforced here:
//   - a sanitized or synthetic fixture is never a reconciliation proof;
//   - a reconciliation proof needs captured originals, a complete delivery and a
//     closed bridge with a money line (aggregate controls are never proof);
//   - "live" readiness needs captured originals and a recorded customer validation;
//   - the status says "live verified" only when all four dimensions are live,
//     otherwise it is the pre-rollout wording below.
import type { Bridge } from './bridge';
import { redactDeep } from './redact';
import type { CapturedOriginal, DeliveryInventory, FixtureClass, FixtureUse, ReadinessDimensions, VersionFacts } from './types';

export const PRE_ROLLOUT_STATUS = 'Implemented and pre-release validated; live verification scheduled for MVP rollout';
export const LIVE_STATUS = 'live verified';

export interface EvidenceRecordInput {
  identity: { connector: string; sourceKey: string; dataset: string };
  upstream: { officialReference: string; versions: VersionFacts; retrievalDate: string; operations: string[] };
  authorization: { method: string; secretRef: string | 'none'; principal: string; scopes: string[]; boundary: 'read-only' | 'read-write'; restrictions: string; approver: string };
  semantics: {
    costBasis: string; currencyUnit: string; usageWindow: { start: string; end: string } | 'unknown'; billingPeriod: string;
    creditsRefundsAdjustments: string; refreshHistory: string; role: 'authoritative' | 'allocated' | 'enrichment' | 'recommendation' | 'change-management' | 'unknown';
  };
  proof: { originals: CapturedOriginal[]; delivery: DeliveryInventory; counts: { source: string; accepted: string; quarantined: string }; bridge: Bridge; exclusions: string[] };
  fixture: { fixtureClass: FixtureClass; use: FixtureUse; sanitization: string; coverage: string };
  release: { commit: string; tests: string; customerValidation: 'pending' | 'validated'; owner: string; rollback: string; status: string };
  readiness: ReadinessDimensions;
}

export type EvidenceRecord = EvidenceRecordInput & { recordVersion: 'connector-evidence-record/1'; redactions: number };

export class EvidenceRecordError extends Error {
  constructor(readonly code: 'FIXTURE_NOT_PROOF' | 'PROOF_INCOMPLETE' | 'LIVE_CLAIM_UNSUPPORTED' | 'NOTE_MISSING', message: string) {
    super(`${code}: ${message}`);
    this.name = 'EvidenceRecordError';
  }
}

// At least one original, each with a hex sha256 and its content-addressed key; the bridge is re-checked, not trusted.
const originalsCaptured = (os: readonly CapturedOriginal[]) =>
  os.length > 0 && os.every((o) => /^[0-9a-f]{64}$/.test(o?.sha256) && typeof o.key === 'string' && o.key.startsWith('connector-originals/') && o.key.endsWith(`/${o.sha256}`));
const bridgeProves = (b: Bridge) => b.closed && b.failures.length === 0 && b.lines.length > 0 && b.lines.every((l) => l.closes) && b.lines.some((l) => !!l.currency);

export function buildEvidenceRecord(input: EvidenceRecordInput): EvidenceRecord {
  const { fixture, proof, release, readiness } = input;
  for (const k of ['sanitization', 'coverage'] as const) {
    if (typeof fixture[k] !== 'string' || fixture[k].trim() === '') throw new EvidenceRecordError('NOTE_MISSING', `the fixture ${k} note is required`);
  }
  if (fixture.use === 'reconciliation-proof') {
    if (fixture.fixtureClass !== 'original') throw new EvidenceRecordError('FIXTURE_NOT_PROOF', `a ${fixture.fixtureClass} fixture cannot be a reconciliation proof`);
    if (!bridgeProves(proof.bridge) || proof.delivery.completion !== 'complete' || !originalsCaptured(proof.originals)) {
      throw new EvidenceRecordError('PROOF_INCOMPLETE', 'a reconciliation proof needs captured originals, a complete delivery and a closed bridge with a money line (aggregate controls are never proof)');
    }
  }
  const dims = Object.values(readiness);
  const liveBacked = fixture.fixtureClass === 'original' && release.customerValidation === 'validated' && originalsCaptured(proof.originals);
  if (dims.includes('live') && !liveBacked) throw new EvidenceRecordError('LIVE_CLAIM_UNSUPPORTED', 'live readiness needs captured originals (sha256 and key) and a recorded customer validation');
  const allLive = dims.every((d) => d === 'live');
  if (release.status.trim().toLowerCase() === LIVE_STATUS && !allLive) throw new EvidenceRecordError('LIVE_CLAIM_UNSUPPORTED', 'the status cannot say live verified before all four dimensions are live');
  const count = { n: 0 };
  const body = redactDeep(
    { identity: input.identity, upstream: input.upstream, authorization: input.authorization, semantics: input.semantics, proof, fixture, release: { ...release, status: allLive ? LIVE_STATUS : PRE_ROLLOUT_STATUS }, readiness },
    count,
  );
  return { recordVersion: 'connector-evidence-record/1', ...body, redactions: count.n };
}
