// Shared bounded-work policy. These limits apply to the simulated engine, not provider quotas.
export const AGENT_POLICY = Object.freeze({
  maxJobsPerTenant: 100,
  maxAttempts: 3,
  leaseSeconds: 60,
  maxJobsPerDrain: 10,
  requestsPerMinute: 1000,
});
