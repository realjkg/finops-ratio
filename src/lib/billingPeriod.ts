// Billing-period helper shared by every FOCUS producer in the repo.
//
// Previously this lived in src/finio/mapWorkloadToFocus.ts and src/costsource
// imported it from there, pointing the cost-ingest seam at the A2A slice for a
// pure date calculation. It belongs here with the other pure helpers so both
// slices depend on src/lib rather than on each other.

/** The current calendar month as a half-open UTC ISO range [start, end). */
export function currentBillingPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}
