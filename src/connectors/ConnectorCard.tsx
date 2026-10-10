// ConnectorCard — renders a single cost-source adapter.
// Shows source identity, FOCUS version → canonical mapping, connection state,
// the env contract that connects it, and a "Test connection" action. The browser
// carries no API token, so it only probes OFFLINE sandbox sources; live
// connectors are probed through the authenticated API
// (GET /api/v1/connectors?probe=true). Env var NAMES only — never values.
// Controlled-egress paths (live PointFive OAuth 2.1 → MCP SSE broker) carry
// the reserved warm accent (#ffc44d / shape token).

import { useState } from 'react';
import type { CostSourceDescriptor, SourceHealth } from '@/costsource/CostSourceClient';
import { isOfflineSandboxSource } from '@/costsource/sandboxSources';
import type { ConnectorBusyPhase, ConnectorSession, IngestRun } from './ingestLanding';
import { IngestVerification } from './IngestVerification';

// Only the live PointFive adapter is a controlled-egress path: it routes through
// PointFive's broker under OAuth 2.1. The sandbox mock is offline seed data.
const CONTROLLED_EGRESS_IDS = new Set(['pointfive-live']);

const KIND_LABEL: Record<string, string> = {
  pointfive: 'PointFive',
  focus_file: 'FOCUS file',
  servicenow: 'ServiceNow · CMDB/ITBM',
  cloud: 'Cloud FOCUS',
  kubernetes: 'Kubernetes',
  nutanix: 'Nutanix',
  mock: 'Mock',
};

const COVERAGE_LABEL: Record<string, string> = {
  public_cloud: 'Public cloud',
  private_cloud: 'Private cloud',
  on_prem: 'On-prem',
};

const CAPABILITY_LABEL: Record<string, string> = {
  costRows: 'Cost rows',
  findings: 'Findings',
};

/** Honest states: data flowing, ready to connect, half set up, switched off, opt-in egress. */
type ConnState = 'connected' | 'available' | 'incomplete' | 'disabled' | 'dark';

function connState(src: CostSourceDescriptor): ConnState {
  if (src.configured) return 'connected';
  if (src.connection) return src.connection;
  if (CONTROLLED_EGRESS_IDS.has(src.id)) return 'dark';
  return 'available';
}

const STATE_COLOR: Record<ConnState, string> = {
  connected: 'var(--value)',
  available: 'var(--unit)',
  incomplete: 'var(--shape)',
  disabled: 'var(--dim)',
  dark: 'var(--shape)',
};

const STATE_LABEL: Record<ConnState, string> = {
  connected: 'Connected',
  available: 'Available',
  incomplete: 'Incomplete',
  disabled: 'Disabled',
  dark: 'Dark',
};

export interface ConnectorCardProps {
  source: CostSourceDescriptor;
  /** Runs the server-side health probe. Absent → no test action (offline fallback). */
  onTest?: (sourceId: string) => Promise<SourceHealth>;

  // -- Walk mode (connectors E2E demo) -------------------------------------
  // Present when the page drives the connect → ingest → data-lands walk.
  // Absent (all props below undefined) → legacy registry-only rendering.
  session?: ConnectorSession;
  /** The landed run for this source, if an ingest has completed. */
  run?: IngestRun;
  /** Every landed run — enables the per-workload source comparison (≥2 sources). */
  allRuns?: Record<string, IngestRun>;
  /** This connector's in-flight phase, when it owns the shared busy slot. */
  busy?: ConnectorBusyPhase | null;
  /** Runs the seam health probe and opens/errors the session. */
  onConnect?: () => void;
  /** Runs the ingest through the seam (session must be open). */
  onIngest?: () => void;
  /** Closes the session and withdraws landed data. */
  onDisconnect?: () => void;
}

export function ConnectorCard({
  source,
  onTest,
  session,
  run,
  allRuns,
  busy = null,
  onConnect,
  onIngest,
  onDisconnect,
}: ConnectorCardProps) {
  const state = connState(source);
  const isEgress = CONTROLLED_EGRESS_IDS.has(source.id);
  const walk = onConnect !== undefined;
  const caps = source.capabilities.map((c) => CAPABILITY_LABEL[c] ?? c).join(' · ');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const borderStyle: React.CSSProperties =
    session?.state === 'open'
      ? { borderColor: 'rgba(0,224,158,0.35)' }
      : state === 'connected'
      ? { borderColor: 'rgba(0,224,158,0.2)' }
      : isEgress
      ? { borderColor: 'rgba(255,196,77,0.2)' }
      : {};

  const isSandbox = isOfflineSandboxSource(source.id);
  const canTest = Boolean(onTest) && state === 'connected' && isSandbox;
  const liveProbeViaApi = state === 'connected' && !isSandbox;

  async function test() {
    if (!onTest) return;
    setTesting(true);
    setResult(null);
    try {
      const health = await onTest(source.id);
      setResult({ ok: health.reachable && health.authed, detail: health.detail });
    } catch (err) {
      setResult({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  const missing = source.setup?.missingEnv ?? [];
  const optional = source.setup?.optionalEnv ?? [];

  return (
    <div
      className="flex flex-col gap-2.5 rounded-card border border-edge bg-slab p-4 motion-safe:transition-colors"
      style={borderStyle}
    >
      {/* Top row: kind badge + optional controlled-egress chip + status */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-sub">
            {KIND_LABEL[source.kind] ?? source.kind}
          </span>
          {isEgress && (
            <span
              className="rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
              style={{
                color: 'var(--shape)',
                borderColor: 'rgba(255,196,77,0.3)',
                background: 'rgba(255,196,77,0.07)',
              }}
            >
              controlled-egress
            </span>
          )}
        </div>

        {/* Status indicator */}
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATE_COLOR[state] }} />
          <span
            className="font-mono text-[10px] uppercase tracking-wider"
            style={{ color: STATE_COLOR[state] }}
          >
            {STATE_LABEL[state]}
          </span>
        </div>
      </div>

      {/* Source name */}
      <h3 className="font-mono text-sm font-bold text-txt leading-snug">{source.name}</h3>

      {/* FOCUS version → canonical mapping */}
      <div className="flex items-center gap-1 font-mono text-[11px]">
        <span className="text-sub">FOCUS</span>
        <span style={{ color: 'var(--gate)' }}>v{source.focusVersion}</span>
        <span className="text-dim">→</span>
        <span className="text-dim">canonical v1.4</span>
      </div>

      {/* Coverage · capabilities */}
      <div className="flex flex-wrap items-center gap-1 text-[11px] text-sub">
        <span>{COVERAGE_LABEL[source.coverage] ?? source.coverage}</span>
        <span className="text-dim">·</span>
        <span>{caps}</span>
      </div>

      {/* Descriptor note */}
      <p className="text-[11px] leading-relaxed text-dim">{source.note}</p>

      {/* Env contract — what to set to connect (names only) */}
      {source.setup && state !== 'connected' && state !== 'disabled' && missing.length > 0 && (
        <div className="rounded border border-edge bg-deep px-2.5 py-2">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-sub">
            Set to connect
          </div>
          <ul className="flex flex-wrap gap-1">
            {missing.map((name) => (
              <li key={name}>
                <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] text-txt">{name}</code>
              </li>
            ))}
          </ul>
          {optional.length > 0 && (
            <div className="mt-1.5 font-mono text-[10px] text-dim">
              Optional: {optional.join(', ')}
            </div>
          )}
        </div>
      )}

      {/* Live probe result — registry mode only (walk mode surfaces the seam
          verdicts through the session states below). */}
      {result && !walk && (
        <p
          role="status"
          className="font-mono text-[11px] leading-relaxed"
          style={{ color: result.ok ? 'var(--value)' : 'var(--cost)' }}
        >
          {result.ok ? '✓ ' : '✕ '}
          {result.detail}
        </p>
      )}

      {/* Live connectors are probed server-side behind the API token only. */}
      {liveProbeViaApi && (
        <p className="font-mono text-[10px] leading-relaxed text-dim">
          Live probe runs via the authenticated API:{' '}
          <code className="text-sub">GET /api/v1/connectors?probe=true</code>
        </p>
      )}

      {/* Walk mode: honest failure — the seam's own reason, verbatim. */}
      {walk && session?.state === 'error' && (
        <p
          role="status"
          className="rounded border border-cost/40 bg-cost/10 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-cost"
        >
          ✕ {session.error ?? 'Connection failed.'}
        </p>
      )}

      {/* Walk mode: the landed-run proof. */}
      {walk && run && <IngestVerification run={run} sandbox={isSandbox} allRuns={allRuns} />}

      {/* Action row — walk mode: Connect / Ingest / Disconnect. */}
      {walk ? (
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          {session?.state === 'open' ? (
            <>
              <button
                type="button"
                onClick={onIngest}
                disabled={busy !== null}
                className="rounded border border-value/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-value hover:bg-value/10 disabled:opacity-60"
              >
                {busy === 'ingesting' ? 'Ingesting…' : run ? 'Re-ingest' : 'Ingest now'}
              </button>
              <button
                type="button"
                onClick={onDisconnect}
                disabled={busy !== null}
                className="rounded border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-dim hover:text-sub disabled:opacity-60"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onConnect}
              disabled={busy !== null}
              className="rounded border border-value/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-value hover:bg-value/10 disabled:opacity-60"
            >
              {busy === 'connecting'
                ? 'Connecting…'
                : session?.state === 'error'
                  ? 'Retry connect'
                  : 'Connect'}
            </button>
          )}
        </div>
      ) : (
        /* Action — legacy registry mode: health probe for connected sandbox sources */
        <div className="mt-auto flex justify-end pt-1">
          <button
            type="button"
            disabled={!canTest || testing}
            onClick={test}
            title={
              canTest
                ? 'Run a reachability probe against this sandbox source'
                : liveProbeViaApi
                ? 'Live connectors are probed via the authenticated API (GET /api/v1/connectors?probe=true)'
                : state === 'disabled'
                ? `Disabled by ${source.setup?.flagEnv ?? 'its kill-switch'}`
                : 'Configure this connector to test it'
            }
            className={
              canTest
                ? 'rounded border border-value/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-value hover:bg-value/10 disabled:opacity-60'
                : 'cursor-not-allowed rounded border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-dim'
            }
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      )}
    </div>
  );
}
