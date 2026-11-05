import { describe, expect, it } from 'vitest';
import { validateDlpFinding, validateEntitlement, validateGatewayRequestRecord, validatePolicy, validatePolicyBundle, validatePolicyDecision } from './policy';
import { bundle, decision, entitlement, finding, gatewayRecord, policy } from './testing/fixtures';

const problems = (r: { ok: boolean; problems?: string[] }) => (r.ok ? [] : r.problems);

describe('Entitlement (cap 8)', () => {
  it('accepts a workload allowed one model of one provider', () => {
    expect(validateEntitlement(entitlement()).ok).toBe(true);
  });
  it('* stands alone and dates are ordered', () => {
    expect(validateEntitlement({ ...entitlement(), models: ['*'] }).ok).toBe(true);
    expect(problems(validateEntitlement({ ...entitlement(), models: ['*', 'model-x'], effectiveTo: '2026-01-01' }))).toEqual(['$.models: * stands alone', '$.effectiveTo: must be after effectiveFrom']);
  });
});

describe('Policy (cap 5, 6, 7)', () => {
  it('accepts an enforcing, fail-closed input DLP policy', () => {
    expect(validatePolicy(policy()).ok).toBe(true);
  });
  it('an enforcing policy that can block fails closed on timeout and engine error', () => {
    expect(problems(validatePolicy({ ...policy(), onTimeout: 'continue_with_gap' }))).toEqual(['$: an enforcing policy fails closed (onTimeout and onEngineError must be deny)']);
    expect(problems(validatePolicy({ ...policy(), mode: 'enforce', rules: [{ ...policy().rules[0], action: 'log_only' }], defaultAction: 'block', onEngineError: 'continue_with_gap' }))).toHaveLength(1);
  });
  it('monitor-only or log-only policies may continue with a visible gap', () => {
    expect(validatePolicy({ ...policy(), mode: 'monitor', onTimeout: 'continue_with_gap', onEngineError: 'continue_with_gap' }).ok).toBe(true);
    expect(validatePolicy({ ...policy(), rules: [{ ...policy().rules[0], action: 'log_only' }], onTimeout: 'continue_with_gap' }).ok).toBe(true);
  });
  it('an enforcing output policy must buffer: released stream content cannot be withdrawn', () => {
    const out = { ...policy(), phase: 'stream_chunk' as const };
    expect(problems(validatePolicy(out))).toEqual(['$.release: an enforcing output policy must buffer']);
    expect(problems(validatePolicy({ ...out, release: 'pass_through' }))).toEqual(['$.release: an enforcing output policy must buffer']);
    expect(validatePolicy({ ...out, release: 'buffer_window' }).ok).toBe(true);
    expect(problems(validatePolicy({ ...policy(), release: 'buffer_full' }))).toEqual(['$.release: only for output phases']);
  });
  it('conditions are a closed, deterministic set; rule ids are unique; the timeout is bounded', () => {
    expect(problems(validatePolicy({ ...policy(), rules: [{ ...policy().rules[0], condition: { kind: 'llm_judge', prompt: 'is this bad?' } }] }))).toEqual(['$.rules[0].condition.kind: one of always|dlp_category|destination|model|tool|input_bytes_over|signal']);
    expect(problems(validatePolicy({ ...policy(), rules: [policy().rules[0], policy().rules[0]] }))).toEqual(['$.rules: duplicate ruleId']);
    expect(problems(validatePolicy({ ...policy(), evaluationTimeoutMs: 0 }))).toEqual(['$.evaluationTimeoutMs: integer 1..10000']);
  });
});

describe('PolicyBundle (cap 5-8)', () => {
  it('accepts the synthetic bundle', () => {
    expect(validatePolicyBundle(bundle()).ok).toBe(true);
  });
  it('every policy and entitlement belongs to the bundle tenant (tenant isolation)', () => {
    const b = bundle();
    expect(problems(validatePolicyBundle({ ...b, policies: [{ ...policy(), tenantId: 'other' }], entitlements: [{ ...entitlement(), tenantId: 'other' }] }))).toEqual([
      '$.policies[0].tenantId: not the bundle tenant', '$.entitlements[0].tenantId: not the bundle tenant',
    ]);
  });
  it('nested policies are held to the same fail-closed rules, and versions are unique', () => {
    expect(problems(validatePolicyBundle({ ...bundle(), policies: [{ ...policy(), onTimeout: 'continue_with_gap' }] }))).toEqual(['$.policies[0]: an enforcing policy fails closed (onTimeout and onEngineError must be deny)']);
    expect(problems(validatePolicyBundle({ ...bundle(), policies: [policy(), policy()] }))).toEqual(['$.policies: duplicate policyId and version']);
  });
});

describe('PolicyDecision and DlpFinding (no raw content)', () => {
  it('accepts a blocking decision with an offsets-only finding', () => {
    expect(validatePolicyDecision(decision()).ok).toBe(true);
    expect(validateDlpFinding(finding()).ok).toBe(true);
  });
  it('a finding carries offsets, never the matched text', () => {
    expect(problems(validateDlpFinding({ ...finding(), match: '4111111111111111' }))).toEqual(['$.match: unknown key']);
    expect(problems(validateDlpFinding({ ...finding(), end: 10 }))).toEqual(['$.end: must be after start']);
  });
  it('a monitor-only decision is never enforced; it records what enforcement would have done', () => {
    expect(validatePolicyDecision({ ...decision(), mode: 'monitor', enforced: false }).ok).toBe(true);
    expect(problems(validatePolicyDecision({ ...decision(), mode: 'monitor' }))).toEqual(['$.enforced: a monitor-only decision is never enforced']);
  });
  it('a failure states its handling: denied is a block, continued is an allow with a gap', () => {
    expect(validatePolicyDecision({ ...decision(), failure: 'timeout', failureHandling: 'denied' }).ok).toBe(true);
    expect(problems(validatePolicyDecision({ ...decision(), failure: 'timeout' }))).toEqual(['$.failureHandling: present exactly when failure is']);
    expect(problems(validatePolicyDecision({ ...decision(), outcome: 'allow', failure: 'dlp_unavailable', failureHandling: 'denied' }))).toEqual(['$.outcome: a denied failure is a block']);
    expect(problems(validatePolicyDecision({ ...decision(), failure: 'engine_error', failureHandling: 'continued_with_gap' }))).toEqual(['$.outcome: a continued failure is an allow with a gap']);
  });
});

describe('GatewayRequestRecord', () => {
  it('accepts a blocked, never-dispatched request with sizes and a keyed digest', () => {
    expect(validateGatewayRequestRecord(gatewayRecord()).ok).toBe(true);
  });
  it('refuses a plain hash or body; a request not dispatched has no output', () => {
    expect(problems(validateGatewayRequestRecord({ ...gatewayRecord(), inputDigest: 'e5'.repeat(32), body: '{}' }))).toEqual(['$.body: unknown key', '$.inputDigest: keyed content digest hm1:<keyId>:<hex>']);
    expect(problems(validateGatewayRequestRecord({ ...gatewayRecord(), released: 'partial' }))).toEqual(['$.dispatch: a request that was not dispatched has no output, served model or release']);
    expect(validateGatewayRequestRecord({ ...gatewayRecord(), dispatch: 'dispatched', released: 'partial', streamed: true, outputBytes: 512 }).ok).toBe(true);
  });
});
