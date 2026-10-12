// FocusFileAdapter — the second source adapter for the cost-ingest seam (PR F).
//
// Ingests FOCUS-formatted rows exported by any private-cloud or on-prem billing
// tool, across the full v1.0–v1.5 version range (1.5 = working draft),
// normalizing to the v1.4 canonical model via the existing version-negotiation
// shim (reused, not reimplemented). No public-cloud account required; the caller
// supplies the rows and auth is the caller's file I/O — not a network credential.
//
// Proves the seam is genuinely source-agnostic: the engine (value ratio, forecast,
// governance gates) is unchanged. PointFive is source #1; FOCUS file is source #2.
// Private cloud + on-prem join by writing another adapter against the same seam,
// not by forking Ratio.
//
// Static methods make the stateless nature explicit. Unlike PR E (PointFive,
// which holds OAuth session state), a FOCUS-file adapter is a pure normalization
// step — it has no lifecycle to manage.

import type { FocusVersion } from './focusVersions';
import { CANONICAL_FOCUS_VERSION } from './focusVersions';
import type { RawSourceRow } from './focusRows';
import type { CostRowsResult, CostWindow, SourceHealth } from './CostSourceClient';
import { normalizeRows } from './normalize';
import { findSource } from './seed';

export class FocusFileAdapter {
  /**
   * Ingest FOCUS rows from any v1.0–v1.5 export into the canonical v1.4 model.
   *
   * The caller supplies the rows (parsed from a FOCUS-compliant file or billing
   * API response). This adapter performs only the normalization step:
   *   version shim → v1.4 canonical cost → Ratio value attachment
   * (the numerator/denominator composition from the v2 spec, Workstream 2).
   *
   * FOCUS 1.5 is a working draft (ratifies 3 Dec 2026): its AI-cost column
   * families are backfilled onto every row and reported separately via
   * `draftColumnsBackfilled`, while the canonical target stays v1.4.
   *
   * No auth, no network, no public-cloud account required.
   */
  static ingest(
    rows: RawSourceRow[],
    version: FocusVersion,
    sourceId: string,
    window: CostWindow,
  ): CostRowsResult {
    const { rows: canonicalRows, backfilledColumns, draftColumnsBackfilled } = normalizeRows(
      rows,
      sourceId,
      version,
    );
    return {
      sourceId,
      sourceVersion: version,
      canonicalVersion: CANONICAL_FOCUS_VERSION,
      backfilledColumns,
      draftColumnsBackfilled,
      window,
      generatedAt: new Date().toISOString(),
      rows: canonicalRows,
    };
  }

  /**
   * Health probe for a FOCUS-file source.
   *
   * Always reachable — no network dependency, no credentials required. The
   * adapter is "configured" whenever the source is named in the registry
   * (COST_SOURCES); there is nothing external to connect to.
   */
  static healthCheck(sourceId: string): SourceHealth {
    const src = findSource(sourceId);
    return {
      sourceId,
      reachable: true,
      authed: true,
      sourceVersion: src?.focusVersion ?? '1.0',
      canonicalVersion: CANONICAL_FOCUS_VERSION,
      checkedAt: new Date().toISOString(),
      detail: src
        ? 'FOCUS-file adapter: accepts any v1.0–v1.5 export (1.5 = working draft); no credentials required.'
        : `Unknown focus_file source '${sourceId}'.`,
    };
  }
}

