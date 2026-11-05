// SYNTHETIC test fixtures for the policy evaluation library (ADR-0001 slice C1). Invented ids only; no real tenant,
// person, provider, model or credential. The signature is a placeholder (verification is slice C2).
import type { Entitlement, Policy, PolicyBundle, PolicyRule } from '../../contracts';
import type { EvaluationInput } from '../evaluate';
import type { RequestContext } from '../context';

export const HUMAN = `ps1:k1:${'a1'.repeat(32)}`;
export const NOW = '2026-10-02T12:00:00Z';

export const ent = (over: Partial<Entitlement> = {}): Entitlement => ({
  schemaVersion: 'entitlement/1', entitlementId: 'ent-wl', version: 1, tenantId: 'tenant-syn', subjectKind: 'workload', subjectRef: 'wl-bot',
  provider: 'provider-a', models: ['model-x'], effect: 'allow', effectiveFrom: '2026-10-01', ...over,
});

export const rule = (over: Partial<PolicyRule> = {}): PolicyRule => ({
  ruleId: 'r-cards', condition: { kind: 'dlp_category', categories: ['payment_card'], minConfidence: 'high' }, action: 'block', reasonCode: 'DLP_PAYMENT_CARD', ...over,
});

export const pol = (over: Partial<Policy> = {}): Policy => ({
  schemaVersion: 'policy/1', policyId: 'pol-input', version: 1, tenantId: 'tenant-syn', scope: { workloadIds: ['wl-bot'] }, phase: 'pre_request', mode: 'enforce',
  rules: [rule()], defaultAction: 'allow', evaluationTimeoutMs: 50, onTimeout: 'deny', onEngineError: 'deny', effectiveFrom: '2026-10-01', ...over,
});

export const bundle = (over: Partial<PolicyBundle> = {}): PolicyBundle => ({
  schemaVersion: 'policy-bundle/1', bundleId: 'bundle-syn', version: 4, tenantId: 'tenant-syn', issuedAt: '2026-10-01T00:00:00Z', notAfter: '2026-10-08T00:00:00Z',
  policies: [pol()], entitlements: [ent()], contentSha256: 'd4'.repeat(32), lastKnownGoodApproved: false,
  signature: { keyId: 'k-bundle-1', alg: 'ed25519', value: `${'A'.repeat(86)}==` }, ...over,
});

export const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  tenantId: 'tenant-syn', requestRef: 'gw-req-1', phase: 'pre_request', workloadId: 'wl-bot', actorType: 'service', actorRef: 'svc:bot',
  provider: 'provider-a', destination: 'provider-a', modelRequested: 'model-x', inputBytes: 512, findings: [], ...over,
});

export const card = (confidence: 'low' | 'medium' | 'high' = 'high') =>
  ({ category: 'payment_card' as const, detectorId: 'luhn-pan', detectorVersion: 1, confidence, location: 'input' as const, start: 4, end: 20, normalization: [] });

const flags = (enforcement: boolean) => ({ enabled: true, economics: false, adoption: false, policyMonitor: true, enforcement });
export const FLAGS = { enforce: flags(true), monitor: flags(false) } as const; // D7 flags per access mode
export const input = ({ accessMode = 'enforce', ...over }: Partial<EvaluationInput> = {}): EvaluationInput => ({ bundle: bundle(), context: ctx(), clock: { now: NOW }, flags: FLAGS[accessMode], ...over });

/** A deterministic fake clock: each read advances by `step` microseconds. */
export const ticking = (step: number) => { let t = 0; return () => (t += step); };
