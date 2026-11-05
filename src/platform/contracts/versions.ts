// Every platform contract carries `schemaVersion: '<name>/<major>'`. A change to a contract's accepted shape or rules
// is a new major (schemaPin.test.ts fails otherwise); readers accept the versions they list, writers emit one.
export const SCHEMA_VERSIONS = [
  'ai-usage-event/1', 'ai-financial-record/1', 'rate-card/1', 'allocation/1',
  'activity-event/1', 'eligibility-snapshot/1', 'adoption-definition/1',
  'entitlement/1', 'policy/1', 'policy-bundle/1', 'policy-decision/1', 'gateway-request/1',
  'connector-declaration/1',
] as const;
export type SchemaVersion = (typeof SCHEMA_VERSIONS)[number];
