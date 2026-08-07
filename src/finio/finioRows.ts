// Builds the FOCUS rows FinIO puts on the wire.
//
// This used to be `mapWorkloadToFocus.ts`, which hand-rolled its own
// Workload -> FOCUS mapping: an 11-column row, a private provider-name table, a
// private ServiceName lookup, and a fourth copy of `governanceGatesPassed`. That
// row was NOT FOCUS-conformant — it dropped v1.0 mandatory columns the rest of
// the repo emits (BillingAccountId, SubAccountId, ChargeCategory, ResourceId,
// PricingQuantity/Unit, UsageQuantity/Unit), so a peer could not resolve a row
// back to a resource.
//
// Now FinIO reuses the cost-ingest seam's row builder and value-attach stage.
// The A2A transport and the ingest doors produce byte-identical rows because
// they run the same code — which is the whole point of "one internal model".

import { attachRatioValue } from '@/costsource/normalize';
import { rawRowsForVersion } from '@/costsource/seed';
import { CANONICAL_FOCUS_VERSION, type FocusVersion } from '@/costsource/focusVersions';
import { FINIO_SOURCE_ID, type FocusRow } from './FinioClient';

/**
 * All workloads as FOCUS rows shaped to `version`.
 *
 * Rows are emitted at the negotiated version rather than always at canonical
 * v1.4: a peer that speaks v1.0 receives v1.0 columns, not v1.4 columns it has
 * no schema for. Cross-version deltas are additive, so a v1.0 consumer reading a
 * v1.4 row would still parse — but emitting what was agreed keeps the handshake
 * meaningful instead of decorative.
 */
export function finioRowsForVersion(
  version: FocusVersion = CANONICAL_FOCUS_VERSION,
): FocusRow[] {
  return rawRowsForVersion(version).map((raw) =>
    attachRatioValue(raw, FINIO_SOURCE_ID, version),
  );
}
