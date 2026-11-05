// Policy, entitlement and gateway-record contracts (ADR-0001 §4.3, Stream C). Ratio authors versioned bundles; an
// established gateway evaluates them LOCALLY and deterministically. No record here carries prompt, response, tool
// or attachment content: only sizes, keyed digests, categories, offsets, rule ids, reason codes and decisions.
import { arr, byKind, C, checkActor, instantBefore, isCount, isModelId, isPseudonymousRef, isServiceRef, literal, obj, oneOf, opt, req, rule, set, validator, ACTOR_TYPES, type ActorType } from './validate';

export const SUBJECT_KINDS = ['tenant', 'team', 'user', 'workload', 'service'] as const;
/**
 * Who may invoke which provider and models, effective-dated. `models: ['*']` means every model of the provider. A user
 * subject is a pseudonym (`ps1:`), a service subject a registered `svc:` id. The gateway checks the requested model
 * AND the served model (a provider-side fallback is re-entitled).
 */
export interface Entitlement {
  schemaVersion: 'entitlement/1';
  entitlementId: string; version: number; tenantId: string;
  subjectKind: (typeof SUBJECT_KINDS)[number]; subjectRef: string;
  provider: string; models: string[];
  effect: 'allow' | 'deny';
  effectiveFrom: string; effectiveTo?: string;
}
const ENTITLEMENT = obj({
  schemaVersion: req(literal('entitlement/1')), entitlementId: req(C.id), version: req(C.positive), tenantId: req(C.id),
  subjectKind: req(oneOf(SUBJECT_KINDS)), subjectRef: req(C.id), provider: req(C.id), models: req(set(rule('model-or-star@1', 'model id or *', (v) => v === '*' || isModelId(v)), 1, 256)),
  effect: req(oneOf(['allow', 'deny'])), effectiveFrom: req(C.date), effectiveTo: opt(C.date),
} satisfies { [K in keyof Required<Entitlement>]: unknown });
const entitlementRules = (e: Entitlement, p: string[], at = '$') => {
  if (e.models.includes('*') && e.models.length > 1) p.push(`${at}.models: * stands alone`);
  if (e.effectiveTo !== undefined && e.effectiveTo <= e.effectiveFrom) p.push(`${at}.effectiveTo: must be after effectiveFrom`);
  const ok = e.subjectKind === 'user' ? isPseudonymousRef(e.subjectRef) : e.subjectKind === 'service' ? isServiceRef(e.subjectRef) : true;
  if (!ok) p.push(`${at}.subjectRef: does not match subjectKind ${e.subjectKind}`);
};
export const validateEntitlement = validator<Entitlement>(ENTITLEMENT, { 'entitlement-rules@1': (e, p) => entitlementRules(e, p) });

export const POLICY_PHASES = ['pre_request', 'pre_response', 'stream_chunk'] as const;
export const POLICY_ACTIONS = ['allow', 'block', 'redact', 'require_approval', 'log_only'] as const;
export const DLP_CATEGORIES = ['payment_card', 'us_ssn', 'iban', 'cloud_credential', 'api_key', 'private_key', 'email', 'phone', 'custom'] as const;
export const CONFIDENCE = ['low', 'medium', 'high'] as const;
const MATCH = req(oneOf(['in', 'not_in']));

/** Deterministic conditions only. `signal` (e.g. a prompt-injection classifier) is one input, never a guarantee. */
export type PolicyCondition =
  | { kind: 'always' }
  | { kind: 'dlp_category'; categories: (typeof DLP_CATEGORIES)[number][]; minConfidence: (typeof CONFIDENCE)[number] }
  | { kind: 'destination'; providers: string[]; match: 'in' | 'not_in' }
  | { kind: 'model'; models: string[]; match: 'in' | 'not_in' }
  | { kind: 'tool'; tools: string[]; match: 'in' | 'not_in' }
  | { kind: 'input_bytes_over'; limit: number }
  | { kind: 'signal'; signal: string; minConfidence: (typeof CONFIDENCE)[number] };
const CONDITION = byKind({
  always: {},
  dlp_category: { categories: req(set(oneOf(DLP_CATEGORIES), 1)), minConfidence: req(oneOf(CONFIDENCE)) },
  destination: { providers: req(set(C.id, 1)), match: MATCH },
  model: { models: req(set(C.model, 1)), match: MATCH },
  tool: { tools: req(set(C.id, 1)), match: MATCH },
  input_bytes_over: { limit: req(C.positive) },
  signal: { signal: req(C.id), minConfidence: req(oneOf(CONFIDENCE)) },
});

export interface PolicyRule { ruleId: string; condition: PolicyCondition; action: (typeof POLICY_ACTIONS)[number]; reasonCode: string }
/** Versioned policy for one phase. A failure mode is per policy; enforcing policies fail closed (validated below). */
export interface Policy {
  schemaVersion: 'policy/1';
  policyId: string; version: number; tenantId: string;
  scope: { workloadIds?: string[]; providers?: string[] };
  phase: (typeof POLICY_PHASES)[number];
  mode: 'monitor' | 'enforce';
  rules: PolicyRule[];
  defaultAction: 'allow' | 'block';
  evaluationTimeoutMs: number;
  onTimeout: 'deny' | 'continue_with_gap';
  onEngineError: 'deny' | 'continue_with_gap';
  /** Output phases: released content cannot be withdrawn, so enforcing output policies must buffer. */
  release?: 'buffer_full' | 'buffer_window' | 'pass_through';
  effectiveFrom: string; effectiveTo?: string;
}
const POLICY = obj({
  schemaVersion: req(literal('policy/1')), policyId: req(C.id), version: req(C.positive), tenantId: req(C.id),
  scope: req(obj({ workloadIds: opt(set(C.id, 1)), providers: opt(set(C.id, 1)) })), phase: req(oneOf(POLICY_PHASES)),
  mode: req(oneOf(['monitor', 'enforce'])),
  rules: req(arr(obj({ ruleId: req(C.id), condition: req(CONDITION), action: req(oneOf(POLICY_ACTIONS)), reasonCode: req(C.reason) }), 1, 512)),
  defaultAction: req(oneOf(['allow', 'block'])), evaluationTimeoutMs: req(rule('timeout-ms@1', 'integer 1..10000', (v) => isCount(v) && v >= 1 && v <= 10000)),
  onTimeout: req(oneOf(['deny', 'continue_with_gap'])), onEngineError: req(oneOf(['deny', 'continue_with_gap'])),
  release: opt(oneOf(['buffer_full', 'buffer_window', 'pass_through'])), effectiveFrom: req(C.date), effectiveTo: opt(C.date),
} satisfies { [K in keyof Required<Policy>]: unknown });
const policyRules = (x: Policy, p: string[], at = '$') => {
  const ids = x.rules.map((r) => r.ruleId);
  if (new Set(ids).size !== ids.length) p.push(`${at}.rules: duplicate ruleId`);
  const hard = x.mode === 'enforce' && (x.defaultAction === 'block' || x.rules.some((r) => ['block', 'redact', 'require_approval'].includes(r.action)));
  if (hard && (x.onTimeout !== 'deny' || x.onEngineError !== 'deny')) p.push(`${at}: an enforcing policy fails closed (onTimeout and onEngineError must be deny)`);
  if (x.phase !== 'pre_request' && hard && (x.release ?? 'pass_through') === 'pass_through') p.push(`${at}.release: an enforcing output policy must buffer`);
  if (x.phase === 'pre_request' && x.release !== undefined) p.push(`${at}.release: only for output phases`);
  if (x.effectiveTo !== undefined && x.effectiveTo <= x.effectiveFrom) p.push(`${at}.effectiveTo: must be after effectiveFrom`);
};
export const validatePolicy = validator<Policy>(POLICY, { 'policy-rules@1': (x, p) => policyRules(x, p) });

/** What Ratio distributes to a gateway, always signed. Expired bundles deny unless an approved last-known-good is still valid. */
export interface PolicyBundle {
  schemaVersion: 'policy-bundle/1';
  bundleId: string; version: number; tenantId: string;
  issuedAt: string; notAfter: string;
  policies: Policy[]; entitlements: Entitlement[];
  /** sha256 of the canonical bundle content without this field and `signature`. */
  contentSha256: string;
  lastKnownGoodApproved: boolean;
  /** ed25519 over the canonical content: 64 bytes, base64 (88 characters). */
  signature: { keyId: string; alg: 'ed25519'; value: string };
}
export const validatePolicyBundle = validator<PolicyBundle>(obj({
  schemaVersion: req(literal('policy-bundle/1')), bundleId: req(C.id), version: req(C.positive), tenantId: req(C.id),
  issuedAt: req(C.instant), notAfter: req(C.instant), policies: req(arr(POLICY, 0, 256)), entitlements: req(arr(ENTITLEMENT, 0, 4096)),
  contentSha256: req(C.sha256), lastKnownGoodApproved: req(C.bool),
  signature: req(obj({ keyId: req(C.id), alg: req(literal('ed25519')), value: req(rule('ed25519-b64@1', 'ed25519 signature, base64 (88 characters)', (v) => typeof v === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(v))) })),
} satisfies { [K in keyof Required<PolicyBundle>]: unknown }), { 'bundle-rules@1': bundleRules });

function bundleRules(b: PolicyBundle, p: string[]) {
  b.policies.forEach((x, i) => { policyRules(x, p, `$.policies[${i}]`); if (x.tenantId !== b.tenantId) p.push(`$.policies[${i}].tenantId: not the bundle tenant`); });
  b.entitlements.forEach((e, i) => { entitlementRules(e, p, `$.entitlements[${i}]`); if (e.tenantId !== b.tenantId) p.push(`$.entitlements[${i}].tenantId: not the bundle tenant`); });
  const keys = b.policies.map((x) => `${x.policyId}@${x.version}`);
  if (new Set(keys).size !== keys.length) p.push('$.policies: duplicate policyId and version');
  const ents = b.entitlements.map((e) => `${e.entitlementId}@${e.version}`);
  if (new Set(ents).size !== ents.length) p.push('$.entitlements: duplicate entitlementId and version');
  if (!instantBefore(b.issuedAt, b.notAfter)) p.push('$.notAfter: must be after issuedAt');
}

export const CONTENT_LOCATIONS = ['input', 'output', 'tool_arguments', 'tool_result', 'system', 'a2a_message'] as const;
export const NORMALIZATIONS = ['nfkc', 'zero_width_removed', 'base64', 'hex', 'url'] as const;
/** A DLP hit: category, detector and offsets into the normalized text. Never the matched text. */
export interface DlpFinding {
  category: (typeof DLP_CATEGORIES)[number];
  detectorId: string; detectorVersion: number;
  confidence: (typeof CONFIDENCE)[number];
  location: (typeof CONTENT_LOCATIONS)[number];
  start: number; end: number;
  normalization: (typeof NORMALIZATIONS)[number][];
}
const FINDING = obj({
  category: req(oneOf(DLP_CATEGORIES)), detectorId: req(C.id), detectorVersion: req(C.positive), confidence: req(oneOf(CONFIDENCE)),
  location: req(oneOf(CONTENT_LOCATIONS)), start: req(C.count), end: req(C.count), normalization: req(set(oneOf(NORMALIZATIONS), 0, 8)),
} satisfies { [K in keyof Required<DlpFinding>]: unknown });
const findingRules = (f: DlpFinding, p: string[], at: string) => { if (f.end <= f.start) p.push(`${at}.end: must be after start`); };
export const validateDlpFinding = validator<DlpFinding>(FINDING, { 'finding-span@1': (f, p) => findingRules(f, p, '$') });

export const FAILURES = ['timeout', 'engine_error', 'policy_invalid', 'policy_expired', 'entitlement_unavailable', 'dlp_unavailable', 'budget_unavailable'] as const;
/** ADR-0001 §3.3: in enforce mode these always deny; the two policy failures may instead use an approved last-known-good. */
export const DENY_IN_ENFORCE = ['entitlement_unavailable', 'dlp_unavailable', 'budget_unavailable', 'policy_expired', 'policy_invalid'] as const;
/**
 * One evaluation. `enforced` is true exactly in enforce mode; in monitor mode `outcome` is what enforcement would have
 * done. `controlClass` says whether the evaluated policy can block, redact or require approval (`hard`) or only logs.
 */
export interface PolicyDecision {
  schemaVersion: 'policy-decision/1';
  decisionId: string; tenantId: string; requestRef: string;
  bundleId: string; bundleVersion: number;
  phase: (typeof POLICY_PHASES)[number]; mode: 'monitor' | 'enforce';
  controlClass: 'hard' | 'log_only';
  outcome: 'allow' | 'block' | 'redact' | 'require_approval';
  enforced: boolean;
  ruleIds: string[]; reasonCodes: string[];
  failure?: (typeof FAILURES)[number];
  failureHandling?: 'denied' | 'continued_with_gap' | 'last_known_good';
  /** Set exactly when an approved last-known-good bundle was evaluated instead of an expired or invalid one. */
  lastKnownGood?: { contentSha256: string; reason: 'policy_expired' | 'policy_invalid' };
  findings: DlpFinding[];
  latencyMicros: number;
  evaluatedAt: string;
}
export const validatePolicyDecision = validator<PolicyDecision>(obj({
  schemaVersion: req(literal('policy-decision/1')), decisionId: req(C.id), tenantId: req(C.id), requestRef: req(C.id), bundleId: req(C.id),
  bundleVersion: req(C.positive), phase: req(oneOf(POLICY_PHASES)), mode: req(oneOf(['monitor', 'enforce'])), controlClass: req(oneOf(['hard', 'log_only'])),
  outcome: req(oneOf(['allow', 'block', 'redact', 'require_approval'])), enforced: req(C.bool), ruleIds: req(arr(C.id)), reasonCodes: req(arr(C.reason)),
  failure: opt(oneOf(FAILURES)), failureHandling: opt(oneOf(['denied', 'continued_with_gap', 'last_known_good'])),
  lastKnownGood: opt(obj({ contentSha256: req(C.sha256), reason: req(oneOf(['policy_expired', 'policy_invalid'])) })), findings: req(arr(FINDING, 0, 1000)),
  latencyMicros: req(C.count), evaluatedAt: req(C.instant),
} satisfies { [K in keyof Required<PolicyDecision>]: unknown }), { 'decision-rules@1': decisionRules, 'failure-table@1': failureTable, 'log-only-allows@1': logOnlyAllows });

function logOnlyAllows(d: PolicyDecision, p: string[]) {
  if (d.controlClass === 'log_only' && d.outcome !== 'allow' && d.failureHandling !== 'denied') p.push('$.outcome: a log-only control only allows, unless a failure is denied');
}

function decisionRules(d: PolicyDecision, p: string[]) {
  d.findings.forEach((f, i) => findingRules(f, p, `$.findings[${i}]`));
  if (d.enforced !== (d.mode === 'enforce')) p.push('$.enforced: true exactly in enforce mode');
  if ((d.failure === undefined) !== (d.failureHandling === undefined)) p.push('$.failureHandling: present exactly when failure is');
  if (d.failureHandling === 'denied' && d.outcome !== 'block') p.push('$.outcome: a denied failure is a block');
  if (d.failureHandling === 'continued_with_gap' && d.outcome !== 'allow') p.push('$.outcome: a continued failure is an allow with a gap');
}
function failureTable(d: PolicyDecision, p: string[]) {
  const lkg = d.failureHandling === 'last_known_good';
  if (lkg !== (d.lastKnownGood !== undefined)) p.push('$.lastKnownGood: present exactly when a last-known-good bundle was used');
  if (lkg && d.failure !== 'policy_expired' && d.failure !== 'policy_invalid') p.push('$.failureHandling: last_known_good only for policy_expired or policy_invalid');
  if (d.lastKnownGood && (d.failure === 'policy_expired' || d.failure === 'policy_invalid') && d.failure !== d.lastKnownGood.reason) p.push('$.lastKnownGood.reason: differs from failure');
  if (d.mode !== 'enforce' || d.failure === undefined) return;
  if ((DENY_IN_ENFORCE as readonly string[]).includes(d.failure) && d.failureHandling === 'continued_with_gap') p.push(`$.failureHandling: ${d.failure} denies in enforce mode`);
  if (d.controlClass === 'hard' && d.failureHandling === 'continued_with_gap') p.push('$.failureHandling: a hard control never continues with a gap');
}

/** One request seen by a gateway: metadata, sizes and keyed digests only. */
export interface GatewayRequestRecord {
  schemaVersion: 'gateway-request/1';
  requestRef: string; tenantId: string; gatewayId: string;
  workloadId?: string; actorRef?: string; actorType: ActorType;
  surface: 'openai_chat' | 'openai_responses' | 'anthropic_messages' | 'a2a' | 'other';
  provider: string; modelRequested?: string; modelServed?: string;
  streamed: boolean;
  inputBytes: number; inputDigest: string;
  outputBytes?: number; outputDigest?: string;
  decisionIds: string[];
  dispatch: 'dispatched' | 'not_dispatched' | 'unknown';
  released: 'full' | 'partial' | 'none' | 'unknown';
  usageEventId?: string;
  receivedAt: string;
}
export const validateGatewayRequestRecord = validator<GatewayRequestRecord>(obj({
  schemaVersion: req(literal('gateway-request/1')), requestRef: req(C.id), tenantId: req(C.id), gatewayId: req(C.id), workloadId: opt(C.id),
  actorRef: opt(C.id), actorType: req(oneOf(ACTOR_TYPES)), surface: req(oneOf(['openai_chat', 'openai_responses', 'anthropic_messages', 'a2a', 'other'])),
  provider: req(C.id), modelRequested: opt(C.model), modelServed: opt(C.model), streamed: req(C.bool), inputBytes: req(C.count), inputDigest: req(C.digest),
  outputBytes: opt(C.count), outputDigest: opt(C.digest), decisionIds: req(arr(C.id)), dispatch: req(oneOf(['dispatched', 'not_dispatched', 'unknown'])),
  released: req(oneOf(['full', 'partial', 'none', 'unknown'])), usageEventId: opt(C.id), receivedAt: req(C.instant),
} satisfies { [K in keyof Required<GatewayRequestRecord>]: unknown }), { 'actor-ref@1': (r, p) => checkActor(r.actorType, r.actorRef, p), 'dispatch-output@1': dispatchOutput });

function dispatchOutput(r: GatewayRequestRecord, p: string[]) {
  const output = r.outputBytes !== undefined || r.outputDigest !== undefined || r.modelServed !== undefined || r.usageEventId !== undefined;
  if (r.dispatch === 'not_dispatched' && (r.released !== 'none' || output)) {
    p.push('$.dispatch: a request that was not dispatched has no output, served model, usage event or release');
  }
  if (r.outputDigest !== undefined && r.outputBytes === undefined) p.push('$.outputDigest: requires outputBytes');
}
