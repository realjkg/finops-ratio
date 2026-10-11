// Public surface of the native savings recommendation engine (checklist Step 4).
// Pure, deterministic TypeScript: no network, no clock, no randomness, no
// dependencies. See README.md for caps, assumptions and known gaps.

export * from './errors';
export {
  currencyExponent,
  formatMinor,
  isCurrencyCode,
  minorToNumber,
  parseDecimalToMinor,
  percentFloor,
  toJsonSafe,
  toMinorUnits,
  type PercentResult,
} from './money';
export * from './types';
export { validateNativeRecommendation } from './validate';
export * from './commitments';
export * from './purchase';
export { normalizeAwsComputeOptimizer } from './awsComputeOptimizer';
export { normalizeAzureAdvisor } from './azureAdvisor';
export { normalizeGcpRecommender, GCP_RECOMMENDER_CATEGORIES } from './gcpRecommender';
export * from './rank';
export * from './findings';
