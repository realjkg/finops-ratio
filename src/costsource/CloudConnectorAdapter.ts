// CloudConnectorAdapter — the shared FOCUS-export adapter. One adapter serves
// the public-cloud trio (Azure / AWS / GCP), Kubernetes (OpenCost / Kubecost),
// and Nutanix, because all of them do the same
// thing: fetch a FOCUS-formatted export from a configured location and hand the
// rows to the EXISTING version-negotiation shim (`normalizeRows`, reused not
// reimplemented) up to the v1.4 canonical model. Only auth/fetch is source-
// specific — captured behind the `FocusExportTransport` seam, whose live
// implementations live in ./transports/ and are named by each `ConnectorSpec`.
//
// CREDENTIAL-DRIVEN. With no env set a connector is `available` and makes ZERO
// network calls:
//   - healthCheck() returns an honest "ready to connect" state
//   - fetchCostRows() throws a typed "not configured" error
// Once its env is present it goes live through the spec's transport. A live
// failure is surfaced as an honest health state / thrown error — the adapter
// never substitutes seed data for a real source. Tests inject a fake transport.

import type {
  CostRowsResult,
  CostSourceDescriptor,
  CostWindow,
  SourceHealth,
} from './CostSourceClient';
import { CANONICAL_FOCUS_VERSION } from './focusVersions';
import type { RawSourceRow } from './focusRows';
import { normalizeRows } from './normalize';
// Second line of defence: transports already keep upstream bodies out of their
// errors, but anything surfacing in health detail or a rethrown error is
// redacted (Bearer tokens, URL query strings / SAS, AWS key ids) anyway.
import { redactErrorText as safeErrorText } from './transports/redact';
import { assertValidWindow } from './transports/focusExport';
import {
  connectorDescriptor,
  connectorStatusNote,
  resolveConnectorStatus,
  type ConnectorSpec,
  type ConnectorStatus,
} from './connectorConfig';

/**
 * The source-specific seam: fetch FOCUS-export rows + probe reachability. Live
 * implementations are in ./transports/; tests inject a fake.
 */
export interface FocusExportTransport {
  /** Lightweight reachability / auth probe; resolves true or throws why not. */
  ping(): Promise<boolean>;
  /** FOCUS-shaped export rows for a window (the source's native version). */
  fetchExportRows(window: CostWindow): Promise<RawSourceRow[]>;
}

/** Factory the adapter uses to build a transport once it is configured. */
export type FocusExportTransportFactory = (
  credentials: Record<string, string>,
) => FocusExportTransport;

/** Injectable dependencies — tests override env + transport; no network in CI. Defaults: process.env + the spec's live transport. */
export interface CloudConnectorAdapterDeps {
  env?: Record<string, string | undefined>;
  transportFactory?: FocusExportTransportFactory;
}

export class CloudConnectorAdapter {
  private readonly status: ConnectorStatus;
  private readonly transportFactory: FocusExportTransportFactory;

  constructor(
    private readonly spec: ConnectorSpec,
    deps: CloudConnectorAdapterDeps = {},
  ) {
    this.status = resolveConnectorStatus(spec, deps.env ?? process.env);
    this.transportFactory = deps.transportFactory ?? spec.transport;
  }

  /** Descriptor for `listSources()` — `configured` reflects the live status. */
  describe(): CostSourceDescriptor {
    return connectorDescriptor(this.spec, this.status);
  }

  /** True only when the kill-switch is not off and all required env is present. */
  get isConfigured(): boolean {
    return this.status.state === 'configured';
  }

  async healthCheck(): Promise<SourceHealth> {
    const base = {
      sourceId: this.spec.id,
      sourceVersion: this.spec.focusVersion,
      canonicalVersion: CANONICAL_FOCUS_VERSION,
      checkedAt: new Date().toISOString(),
    };

    // Not configured (available / incomplete / disabled): honest state, no network call.
    if (this.status.state !== 'configured') {
      return {
        ...base,
        reachable: false,
        authed: false,
        detail: connectorStatusNote(this.spec, this.status),
      };
    }

    try {
      const reachable = await this.transportFactory(this.status.credentials).ping();
      return {
        ...base,
        reachable,
        authed: reachable,
        detail: reachable
          ? `${this.spec.name} reachable; FOCUS export authenticated.`
          : `${this.spec.name} did not respond to the health probe.`,
      };
    } catch (err) {
      // Never hang, never crash: a live failure becomes an honest health state.
      return {
        ...base,
        reachable: false,
        authed: false,
        detail: `${this.spec.name} health check failed: ${safeErrorText(err)}`,
      };
    }
  }

  async fetchCostRows(window: CostWindow): Promise<CostRowsResult> {
    const credentials = this.requireConfigured('fetch cost rows');
    assertValidWindow(window);
    let exportRows: RawSourceRow[];
    try {
      exportRows = await this.transportFactory(credentials).fetchExportRows(window);
    } catch (err) {
      throw new Error(safeErrorText(err));
    }
    // Reuse the existing version-negotiation shim: the cloud's FOCUS export is
    // upgraded to the v1.4 canonical model and given Ratio's value context.
    const { rows, backfilledColumns, draftColumnsBackfilled } = normalizeRows(exportRows, this.spec.id, this.spec.focusVersion);
    return {
      sourceId: this.spec.id,
      sourceVersion: this.spec.focusVersion,
      canonicalVersion: CANONICAL_FOCUS_VERSION,
      backfilledColumns,
      draftColumnsBackfilled,
      window,
      generatedAt: new Date().toISOString(),
      rows,
    };
  }

  // --- internals ---------------------------------------------------------

  private requireConfigured(action: string): Record<string, string> {
    if (this.status.state !== 'configured') {
      throw new Error(
        `${this.spec.name} not configured (${this.status.state}) — cannot ${action}; ` +
          connectorStatusNote(this.spec, this.status),
      );
    }
    return this.status.credentials;
  }
}

