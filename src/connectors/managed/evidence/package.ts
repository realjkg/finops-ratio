// M0b: the Connector Evidence Record (spec-pack sections: identity, upstream
// contract, authorization, data semantics, integration proof, release) plus
// T/S/F/O readiness. Built redacted: any string that looks like credential
// material is replaced (and counted); only secret NAMES (secretRef) appear.
// Honesty rules, enforced here:
//   - a sanitized or synthetic fixture is never a reconciliation proof;
//   - a reconciliation proof needs a closed bridge and a complete delivery;
//   - "live" readiness needs original evidence and a recorded customer validation;
//   - the status says "live verified" only when all four dimensions are live,
//     otherwise it is the pre-rollout wording below.
import type { Bridge } from './bridge';
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

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*-----[\s\S]*?(-----END [A-Z ]*-----|$)/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.?[\w-]*/g,
  /\b(password|passwd|pwd|secret|token|api_key|apikey|sig|signature|sas)\s*[=:]\s*[^\s&;,]+/gi,
];
// Long opaque runs, but not hex digests (sha256, ETags), which the record must keep.
const OPAQUE = /\b(?![0-9a-f]+\b)[A-Za-z0-9+/_=-]{40,}/g;

function redactString(s: string, count: { n: number }): string {
  let out = s;
  for (const re of [...SECRET_PATTERNS, OPAQUE]) {
    out = out.replace(re, () => {
      count.n += 1;
      return '[redacted]';
    });
  }
  return out;
}

function redactDeep<T>(v: T, count: { n: number }): T {
  if (typeof v === 'string') return redactString(v, count) as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, count)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, count)])) as T;
  return v;
}

export function buildEvidenceRecord(input: EvidenceRecordInput): EvidenceRecord {
  const { fixture, proof, release, readiness } = input;
  for (const k of ['sanitization', 'coverage'] as const) {
    if (typeof fixture[k] !== 'string' || fixture[k].trim() === '') throw new EvidenceRecordError('NOTE_MISSING', `the fixture ${k} note is required`);
  }
  if (fixture.use === 'reconciliation-proof') {
    if (fixture.fixtureClass !== 'original') throw new EvidenceRecordError('FIXTURE_NOT_PROOF', `a ${fixture.fixtureClass} fixture cannot be a reconciliation proof`);
    if (!proof.bridge.closed || proof.delivery.completion !== 'complete') throw new EvidenceRecordError('PROOF_INCOMPLETE', 'a reconciliation proof needs a closed bridge and a complete delivery');
  }
  const dims = Object.values(readiness);
  const liveBacked = fixture.fixtureClass === 'original' && release.customerValidation === 'validated';
  if (dims.includes('live') && !liveBacked) throw new EvidenceRecordError('LIVE_CLAIM_UNSUPPORTED', 'live readiness needs original evidence and a recorded customer validation');
  const allLive = dims.every((d) => d === 'live');
  if (release.status.trim().toLowerCase() === LIVE_STATUS && !allLive) throw new EvidenceRecordError('LIVE_CLAIM_UNSUPPORTED', 'the status cannot say live verified before all four dimensions are live');
  const count = { n: 0 };
  const body = redactDeep(
    { identity: input.identity, upstream: input.upstream, authorization: input.authorization, semantics: input.semantics, proof, fixture, release: { ...release, status: allLive ? LIVE_STATUS : PRE_ROLLOUT_STATUS }, readiness },
    count,
  );
  return { recordVersion: 'connector-evidence-record/1', ...body, redactions: count.n };
}
