// Messages and the §3.3 failure table. Accept/reject coverage per contract lives in the golden corpus (corpus/*.json).
import { describe, expect, it } from 'vitest';
import { DENY_IN_ENFORCE, FAILURES, validateEntitlement, validateGatewayRequestRecord, validatePolicy, validatePolicyBundle, validatePolicyDecision, type PolicyDecision } from './policy';
import { bundle, decision, entitlement, gatewayRecord, policy } from './testing/fixtures';

const problems = (r: { ok: boolean; problems?: string[] }) => (r.ok ? [] : r.problems);
const SHA = 'e5'.repeat(32);

describe('Entitlement and Policy (cap 5-8)', () => {
  it('a user subject is a pseudonym', () => {
    expect(problems(validateEntitlement({ ...entitlement(), subjectKind: 'user', subjectRef: 'jane.doe' }))).toEqual(['$.subjectRef: does not match subjectKind user']);
  });
  it('an enforcing policy that can block fails closed; an enforcing output policy buffers', () => {
    expect(problems(validatePolicy({ ...policy(), onTimeout: 'continue_with_gap' }))).toEqual(['$: an enforcing policy fails closed (onTimeout and onEngineError must be deny)']);
    expect(problems(validatePolicy({ ...policy(), phase: 'stream_chunk' }))).toEqual(['$.release: an enforcing output policy must buffer']);
  });
  it('a bundle is signed, single-tenant, unique and expires after it is issued', () => {
    expect(validatePolicyBundle(bundle()).ok).toBe(true);
    const b = bundle();
    expect(problems(validatePolicyBundle({ ...b, notAfter: b.issuedAt, entitlements: [entitlement(), entitlement()] }))).toEqual(['$.entitlements: duplicate entitlementId and version', '$.notAfter: must be after issuedAt']);
  });
});

describe('PolicyDecision: the failure table (ADR-0001 §3.3)', () => {
  const failed = (failure: PolicyDecision['failure'], failureHandling: PolicyDecision['failureHandling'], over: Partial<PolicyDecision> = {}): PolicyDecision =>
    ({ ...decision(), failure, failureHandling, outcome: failureHandling === 'continued_with_gap' ? 'allow' : 'block', findings: [], ...over });

  it('in enforce mode, unavailable controls and bad policies never continue', () => {
    for (const f of DENY_IN_ENFORCE) {
      expect(validatePolicyDecision(failed(f, 'denied')).ok).toBe(true);
      expect(problems(validatePolicyDecision(failed(f, 'continued_with_gap', { controlClass: 'log_only' })))).toEqual([`$.failureHandling: ${f} denies in enforce mode`]);
    }
  });
  it('timeouts and engine errors continue only for log-only controls, or in monitor mode', () => {
    for (const f of ['timeout', 'engine_error'] as const) {
      expect(problems(validatePolicyDecision(failed(f, 'continued_with_gap')))).toEqual(['$.failureHandling: a hard control never continues with a gap']);
      expect(validatePolicyDecision(failed(f, 'continued_with_gap', { controlClass: 'log_only' })).ok).toBe(true);
      expect(validatePolicyDecision(failed(f, 'continued_with_gap', { mode: 'monitor', enforced: false })).ok).toBe(true);
    }
  });
  it('only an expired or invalid bundle may fall back to an approved last-known-good, and the decision records it', () => {
    const lkg = (failure: PolicyDecision['failure'], reason: 'policy_expired' | 'policy_invalid' = 'policy_expired') =>
      failed(failure, 'last_known_good', { lastKnownGood: { contentSha256: SHA, reason } });
    expect(validatePolicyDecision(lkg('policy_expired')).ok).toBe(true);
    expect(validatePolicyDecision(lkg('policy_invalid', 'policy_invalid')).ok).toBe(true);
    expect(problems(validatePolicyDecision(lkg('policy_invalid')))).toEqual(['$.lastKnownGood.reason: differs from failure']);
    for (const f of FAILURES.filter((x) => x !== 'policy_expired' && x !== 'policy_invalid')) {
      expect(problems(validatePolicyDecision(lkg(f)))).toContain('$.failureHandling: last_known_good only for policy_expired or policy_invalid');
    }
    expect(problems(validatePolicyDecision(failed('policy_expired', 'last_known_good')))).toEqual(['$.lastKnownGood: present exactly when a last-known-good bundle was used']);
  });
  it('a log-only control only allows, unless a failure denies', () => {
    expect(problems(validatePolicyDecision({ ...decision(), controlClass: 'log_only' }))).toEqual(['$.outcome: a log-only control only allows, unless a failure is denied']);
    expect(validatePolicyDecision(failed('dlp_unavailable', 'denied', { controlClass: 'log_only' })).ok).toBe(true);
  });
  it('enforced is true exactly in enforce mode', () => {
    expect(problems(validatePolicyDecision({ ...decision(), enforced: false }))).toEqual(['$.enforced: true exactly in enforce mode']);
    expect(problems(validatePolicyDecision({ ...decision(), mode: 'monitor' }))).toEqual(['$.enforced: true exactly in enforce mode']);
  });
});

describe('GatewayRequestRecord', () => {
  it('a request that was not dispatched has no output trace; an output digest needs its size', () => {
    expect(problems(validateGatewayRequestRecord({ ...gatewayRecord(), usageEventId: 'evt-1' }))).toEqual(['$.dispatch: a request that was not dispatched has no output, served model, usage event or release']);
    expect(problems(validateGatewayRequestRecord({ ...gatewayRecord(), dispatch: 'dispatched', released: 'full', outputDigest: `hm1:k1:${SHA}` }))).toEqual(['$.outputDigest: requires outputBytes']);
  });
});
