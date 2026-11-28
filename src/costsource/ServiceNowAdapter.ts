// ServiceNowAdapter — the synthetic CMDB/ITBM source adapter for the
// cost-ingest seam (connector-walk PR).
//
// This is NOT a live ServiceNow integration: the source is a synthetic demo
// seed (honesty chip on the card says so) whose rows are derived from the same
// WORKLOADS the rest of the app uses. The adapter owns the ITBM allocation
// shape (CI-keyed service lines, documented critical-service overhead) and
// normalizes through the same v1.0–v1.4 version shim every other adapter uses,
// so the engine (value ratio, forecast, governance gates) is unchanged.
//
// Modeled on FocusFileAdapter — static methods, no lifecycle, no network. The
// live ServiceNow integration is a different animal (OAuth + Table API); when
// it exists it joins the seam as another adapter, not a fork.

import type { FocusVersion } from './focusVersions';
import { CANONICAL_FOCUS_VERSION } from './focusVersions';
import type { RawSourceRow } from './focusRows';
import type { CostRowsResult, CostWindow, SourceHealth } from './CostSourceClient';
import { normalizeRows } from './normalize';
import { findSource, rawRowsForServiceNow } from './seed';

/** Registry id of the synthetic ServiceNow sandbox source. */
export const SERVICENOW_SANDBOX_SOURCE_ID = 'servicenow-sandbox';

export class ServiceNowAdapter {
  /**
   * The synthetic source's native CMDB/ITBM allocation rows (v1.2 shape).
   * Derived from WORKLOADS — the ITBM allocation method is the only delta.
   */
  static seedRows(): RawSourceRow[] {
    return rawRowsForServiceNow();
  }

  /**
   * Ingest ITBM allocation rows into the canonical v1.4 model through the
   * shared version shim — the same path every other source adapter runs.
   */
  static ingest(
    rows: RawSourceRow[],
    version: FocusVersion,
    sourceId: string,
    window: CostWindow,
  ): CostRowsResult {
    const {
      rows: canonicalRows,
      backfilledColumns,
      draftColumnsBackfilled,
    } = normalizeRows(rows, sourceId, version);
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
   * Health probe for the synthetic ServiceNow source. Always reachable in the
   * sandbox — there is no network dependency and nothing to authenticate; the
   * source is "configured" because the demo seed ships it. A live integration
   * would report honestly against real credentials instead.
   */
  static healthCheck(sourceId: string): SourceHealth {
    const src = findSource(sourceId);
    return {
      sourceId,
      reachable: true,
      authed: true,
      sourceVersion: src?.focusVersion ?? '1.2',
      canonicalVersion: CANONICAL_FOCUS_VERSION,
      checkedAt: new Date().toISOString(),
      detail: src
        ? 'ServiceNow CMDB/ITBM (synthetic demo data): CI-keyed allocation lines; no live integration.'
        : `Unknown servicenow source '${sourceId}'.`,
    };
  }
}
