// SYNTHETIC fixtures for the value model tests. Invented tenant, project, people and numbers; no customer data.
import type { KpiDefinition } from '../kpiDefinition';
import type { Actor } from '../lifecycle';
import type { ValueCaseVersion } from '../valueCase';

export const TENANT = 'tenant-synthetic';
export const sponsor: Actor = { id: 'user-sponsor', roles: ['project_sponsor'] };
export const approver: Actor = { id: 'user-approver', roles: ['kpi_approver'] };
export const finance: Actor = { id: 'user-finance', roles: ['finance_approver'] };

/** A user-defined KPI with custom inputs: review minutes per accepted invoice. */
export const invoiceKpi = (): KpiDefinition => ({
  schemaVersion: 'kpi-definition/0-draft',
  definitionId: 'invoice-review-time',
  version: 1,
  tenantId: TENANT,
  projectId: 'project-ap-automation',
  name: 'Review time per accepted invoice',
  purpose: 'How much reviewer effort one correctly processed invoice needs.',
  outcomeUnit: 'invoice',
  direction: 'lower_is_better',
  inputs: [
    { key: 'acceptedInvoices', label: 'Accepted invoices', kind: 'count', unit: 'invoice', minimum: '0', aggregation: 'count_distinct', sourceKinds: ['connector', 'upload'] },
    { key: 'reviewTime', label: 'Reviewer time', kind: 'quantity', unit: 'hour', minimum: '0', aggregation: 'sum', sourceKinds: ['connector', 'manual_observation', 'assumption'] },
  ],
  outcome: {
    requirements: [
      { key: 'approvedByReviewer', description: 'Approved by a reviewer' },
      { key: 'duplicateCheckPassed', description: 'Passed the duplicate check' },
      { key: 'requiredFieldsComplete', description: 'All required fields complete' },
    ],
    qualityWindowDays: 30,
  },
  dimensions: [
    { key: 'documentComplexity', label: 'Document complexity', values: ['standard', 'complex'] },
    { key: 'businessUnit', label: 'Business unit' },
  ],
  calculation: { expression: 'reviewTime / acceptedInvoices', resultUnit: 'minute/invoice', scale: 2, onZeroDenominator: 'unavailable' },
  periodGrain: 'month',
  target: { value: '3', unit: 'minute/invoice', setBy: { kind: 'demo_configuration' } },
});

/** A KPI that reads a finance-register rate, so it needs finance approval too. */
export const costPerInvoiceKpi = (): KpiDefinition => ({
  ...invoiceKpi(),
  definitionId: 'invoice-review-cost',
  name: 'Review cost per accepted invoice',
  purpose: 'Loaded reviewer cost of one correctly processed invoice.',
  inputs: [
    ...invoiceKpi().inputs,
    { key: 'loadedRate', label: 'Loaded reviewer rate', kind: 'rate', unit: 'USD/hour', aggregation: 'latest', sourceKinds: ['finance_register'] },
  ],
  calculation: { expression: 'reviewTime * loadedRate / acceptedInvoices', resultUnit: 'USD/invoice', scale: 4, onZeroDenominator: 'unavailable' },
  target: { value: '2', unit: 'USD/invoice', setBy: { kind: 'role', role: 'finance-owner' } },
});

/** The service-automation worked example: 10,000 × ($8 − $5) × 80% = $24,000 benefit against $12,000 cost. */
export const expectedCase = (): ValueCaseVersion => ({
  schemaVersion: 'value-case/0-draft',
  caseId: 'case-service-automation',
  version: 1,
  tenantId: TENANT,
  projectId: 'project-service-automation',
  phase: 'expected',
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  currency: 'USD',
  terms: [
    { key: 'baselineResolutions', label: 'Qualified resolutions without AI', unit: 'resolution', quantity: '10000', sourceKind: 'connector', basis: 'forecast', sourceRefs: ['baseline-2026q3'] },
    { key: 'costBefore', label: 'Process cost per resolution before', unit: 'USD/resolution', quantity: '8', sourceKind: 'finance_register', basis: 'forecast', sourceRefs: ['rate-card-v3'] },
    { key: 'costAfter', label: 'Remaining process cost per resolution', unit: 'USD/resolution', quantity: '5', sourceKind: 'assumption', basis: 'forecast', sourceRefs: [] },
    { key: 'attribution', label: 'Attributable share', unit: 'percent', quantity: '80', sourceKind: 'assumption', basis: 'forecast', sourceRefs: [] },
    { key: 'aiCost', label: 'Full AI project cost', unit: 'USD', quantity: '12000', sourceKind: 'assumption', basis: 'forecast', sourceRefs: [] },
  ],
  benefit: { expression: 'baselineResolutions * (costBefore - costAfter) * attribution', benefitClass: 'cost_avoidance' },
  cost: { expression: 'aiCost' },
});
