// SYNTHETIC test fixtures for the platform contracts. Invented ids only; no real tenant, person, provider account,
// credential or price. Prices are placeholders, not any provider's rates.
import type { AIUsageEvent, Allocation, FinancialRecord, RateCard } from '../economics';
import type { ActivityEvent, AdoptionDefinition, EligiblePopulationSnapshot } from '../adoption';
import type { DlpFinding, Entitlement, GatewayRequestRecord, Policy, PolicyBundle, PolicyDecision } from '../policy';
import type { ConnectorDeclaration } from '../connector';

export const HUMAN = `ps1:k1:${'a1'.repeat(32)}`;
export const DIGEST = `hm1:k1:${'b2'.repeat(32)}`;

export const usageEvent = (): AIUsageEvent => ({
  schemaVersion: 'ai-usage-event/1', eventId: 'evt-1', tenantId: 'tenant-syn', sourceConnectionId: 'conn-provider-a', dedupKey: 'req-123:1',
  occurredAt: '2026-10-01T12:00:00Z', receivedAt: '2026-10-01T12:00:05.250Z', workloadId: 'wl-support-bot', actorRef: HUMAN, actorType: 'human',
  provider: 'provider-a', modelRequested: 'model-x', modelServed: 'model-x-2026-09', providerRequestId: 'req-123', attempt: 1, serviceTier: 'standard',
  usageBasis: 'reported', tokenUsage: { input: '1200', output: '300', cachedInput: '1000', accountingProfile: 'provider-a-chat/1' },
  status: 'succeeded', evidenceRef: 'ev-batch-7',
});

export const financialRecord = (): FinancialRecord => ({
  schemaVersion: 'ai-financial-record/1', recordId: 'fin-1', tenantId: 'tenant-syn', sourceConnectionId: 'conn-provider-a', kind: 'estimated_invocation',
  amount: '0.004200', currency: 'USD', periodStart: '2026-10-01', periodEnd: '2026-10-02', provider: 'provider-a', rateBasis: 'public_list',
  rateCardRef: { rateCardId: 'rc-provider-a', version: 3 }, linkedUsageEventIds: ['evt-1'], evidenceRef: 'ev-batch-7',
});

export const rateCard = (): RateCard => ({
  schemaVersion: 'rate-card/1', rateCardId: 'rc-provider-a', version: 3, tenantId: 'tenant-syn', provider: 'provider-a', currency: 'USD',
  basis: 'public_list', effectiveFrom: '2026-10-01',
  entries: [
    { model: 'model-x', category: 'input', serviceTier: 'standard', unit: 'per_1m_tokens', price: '1.00' },
    { model: 'model-x', category: 'cachedInput', serviceTier: 'standard', unit: 'per_1m_tokens', price: '0.10' },
    { model: 'model-x', category: 'input', serviceTier: 'batch', unit: 'per_1m_tokens', price: '0.50' },
    { model: 'model-x', category: 'image', serviceTier: 'standard', unit: 'per_unit', price: '0.01' },
  ],
  provenance: { kind: 'owner_entry', reference: 'synthetic-placeholder', retrievedOn: '2026-10-01' },
});

export const allocation = (): Allocation => ({
  schemaVersion: 'allocation/1', allocationId: 'alloc-1', tenantId: 'tenant-syn', methodology: { ruleSetId: 'rules-tags', version: 2 },
  periodStart: '2026-10-01', periodEnd: '2026-11-01', currency: 'USD', basis: 'billed', sourceAmount: '100.00',
  shares: [{ targetKind: 'workload', targetRef: 'wl-a', amount: '60.10', ruleId: 'tag-workload' }, { targetKind: 'workload', targetRef: 'wl-b', amount: '30.00', ruleId: 'tag-workload' }],
  unallocated: '9.90', unallocatedReasons: ['UNTAGGED_PROJECT'], evidenceRef: 'ev-alloc-1',
});

export const activityEvent = (): ActivityEvent => ({
  schemaVersion: 'activity-event/1', eventId: 'act-1', tenantId: 'tenant-syn', sourceConnectionId: 'conn-activity', dedupKey: 'act-src-1',
  occurredAt: '2026-10-02T09:00:00Z', receivedAt: '2026-10-02T09:01:00Z', actorRef: HUMAN, actorType: 'human', activityKind: 'chat.message_sent', evidenceRef: 'ev-act',
});

export const snapshot = (): EligiblePopulationSnapshot => ({
  schemaVersion: 'eligibility-snapshot/1', snapshotId: 'snap-1', tenantId: 'tenant-syn', sourceConnectionId: 'conn-directory',
  effectiveDate: '2026-10-01', takenAt: '2026-10-01T00:05:00Z', population: 'human', memberCount: 40, memberSetSha256: 'c3'.repeat(32),
  exclusions: [{ reasonCode: 'ON_LEAVE', count: 2 }], licensedSeats: 50, evidenceRef: 'ev-snap-1',
});

export const definition = (): AdoptionDefinition => ({
  schemaVersion: 'adoption-definition/1', definitionId: 'adoption-monthly', version: 1, tenantId: 'tenant-syn', metric: 'adoption_rate',
  periodGrain: 'month', effectiveFrom: '2026-10-01', numerator: { activityKinds: ['chat.message_sent'], minEventsPerActor: 1, actorTypes: ['human'] },
  denominator: 'eligible_snapshot', snapshotRule: 'period_start', exclusions: ['ON_LEAVE'],
});

export const entitlement = (): Entitlement => ({
  schemaVersion: 'entitlement/1', entitlementId: 'ent-1', version: 1, tenantId: 'tenant-syn', subjectKind: 'workload', subjectRef: 'wl-support-bot',
  provider: 'provider-a', models: ['model-x'], effect: 'allow', effectiveFrom: '2026-10-01',
});

export const policy = (): Policy => ({
  schemaVersion: 'policy/1', policyId: 'pol-dlp-input', version: 1, tenantId: 'tenant-syn', scope: { workloadIds: ['wl-support-bot'] }, phase: 'pre_request',
  mode: 'enforce', rules: [{ ruleId: 'r-cards', condition: { kind: 'dlp_category', categories: ['payment_card', 'us_ssn'], minConfidence: 'high' }, action: 'block', reasonCode: 'DLP_PAYMENT_CARD' }],
  defaultAction: 'allow', evaluationTimeoutMs: 50, onTimeout: 'deny', onEngineError: 'deny', effectiveFrom: '2026-10-01',
});

export const bundle = (): PolicyBundle => ({
  schemaVersion: 'policy-bundle/1', bundleId: 'bundle-syn', version: 4, tenantId: 'tenant-syn', issuedAt: '2026-10-01T00:00:00Z', notAfter: '2026-10-08T00:00:00Z',
  policies: [policy()], entitlements: [entitlement()], contentSha256: 'd4'.repeat(32), lastKnownGoodApproved: false,
  signature: { keyId: 'k-bundle-1', alg: 'ed25519', value: `${'A'.repeat(86)}==` },
});

export const finding = (): DlpFinding => ({
  category: 'payment_card', detectorId: 'luhn-pan', detectorVersion: 1, confidence: 'high', location: 'input', start: 10, end: 26, normalization: ['nfkc', 'zero_width_removed'],
});

export const decision = (): PolicyDecision => ({
  schemaVersion: 'policy-decision/1', decisionId: 'dec-1', tenantId: 'tenant-syn', requestRef: 'gw-req-1', bundleId: 'bundle-syn', bundleVersion: 4,
  phase: 'pre_request', mode: 'enforce', controlClass: 'hard', outcome: 'block', enforced: true, ruleIds: ['r-cards'], reasonCodes: ['DLP_PAYMENT_CARD'],
  findings: [finding()], latencyMicros: 850, evaluatedAt: '2026-10-01T12:00:00.001Z',
});

export const gatewayRecord = (): GatewayRequestRecord => ({
  schemaVersion: 'gateway-request/1', requestRef: 'gw-req-1', tenantId: 'tenant-syn', gatewayId: 'gw-mock', workloadId: 'wl-support-bot', actorRef: 'svc:support-bot',
  actorType: 'service', surface: 'openai_chat', provider: 'provider-a', modelRequested: 'model-x', streamed: false, inputBytes: 2048, inputDigest: DIGEST,
  decisionIds: ['dec-1'], dispatch: 'not_dispatched', released: 'none', receivedAt: '2026-10-01T12:00:00Z',
});

export const connector = (): ConnectorDeclaration => ({
  schemaVersion: 'connector-declaration/1', connectorId: 'provider-a-usage-file', category: 'model_provider_usage',
  operations: [{ name: 'import_usage_file', emits: 'ai-usage-event/1' }, { name: 'import_cost_file', emits: 'ai-financial-record/1' }],
  credentials: [{ kind: 'file_drop', permissions: [] }], granularity: 'day', pagination: 'file_manifest', completeness: 'control_total',
  refreshCadence: 'P1D', dedup: { strategy: 'composite_key', keyFields: ['bucket_start', 'project_id', 'model', 'token_category'] }, corrections: 'restated_period',
  rateLimits: { strategy: 'none', maxRetries: 0 }, privacy: 'aggregate', verification: { status: 'not_verified', limitations: ['FIELD_MAPPING_PER_PUBLIC_DOCS'] },
});
