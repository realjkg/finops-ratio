// Connectors — Wave 4 Slice 4. Real object over the existing CostSourceClient seam.
// Lists all registered cost-source adapters with identity, FOCUS version mapping,
// server-resolved connection status, the env that connects each one, and a
// "Test connection" probe for the offline sandbox sources only (live connectors
// are probed via the authenticated GET /api/v1/connectors?probe=true; the
// browser never holds an API token). Controlled-egress paths (live PointFive broker) carry
// the reserved warm accent.
//
// Connection status depends on SERVER env, which the browser cannot see, so the
// page loads it from /api/costsource/sources. That route discloses live
// connector status only to authenticated API callers; the browser carries no
// token, so live connectors show the neutral registry status here. The first render uses the
// env-independent registry (`sourcesForEnv({})`) so it matches the static
// prerender exactly; if the API is unreachable (static hosting, offline) that
// view stays, every connector honestly reads as available, and the probe is
// hidden.

import { SimulationConnectors } from '@/simulation/SimulationConnectors';
import { useStore } from '@/store/useStore';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ConnectorCard } from '@/connectors/ConnectorCard';
import { FocusDoorWalk } from '@/connectors/FocusDoorWalk';
import { sourcesForEnv } from '@/costsource/seed';
import { createCostSourceClient } from '@/costsource';
import type { CostSourceDescriptor, SourceCoverage } from '@/costsource';

const COVERAGE_ORDER: SourceCoverage[] = ['public_cloud', 'private_cloud', 'on_prem'];
const COVERAGE_LABEL: Record<SourceCoverage, string> = {
  public_cloud: 'Public cloud',
  private_cloud: 'Private cloud',
  on_prem: 'On-prem',
};

const OFFLINE_SOURCES = sourcesForEnv({});

function ConnectorRegistry() {
  const [sources, setSources] = useState<CostSourceDescriptor[]>(OFFLINE_SOURCES);
  const [live, setLive] = useState(false);
  const client = useMemo(() => createCostSourceClient('live'), []);
  // Offline fallback client for the walk: when the API never answers (static
  // hosting), ingest runs through the in-process mock — the same bundled seed,
  // still through the CostSourceClient seam.
  const offlineClient = useMemo(() => createCostSourceClient('mock'), []);
  const sessions = useStore((s) => s.connectorSessions);
  const runs = useStore((s) => s.ingestRuns);
  const busy = useStore((s) => s.connectorBusy);
  const connectConnector = useStore((s) => s.connectConnector);
  const runConnectorIngest = useStore((s) => s.runConnectorIngest);
  const disconnectConnector = useStore((s) => s.disconnectConnector);
  const ingestClient = live ? client : offlineClient;

  useEffect(() => {
    let cancelled = false;
    client
      .listSources()
      .then((list) => {
        if (!cancelled) {
          setSources(list);
          setLive(true);
        }
      })
      .catch(() => {
        // Offline / static hosting: keep the bundled registry, no probe.
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const connected = sources.filter((s) => s.configured);
  const available = sources.filter((s) => !s.configured);
  const onTest = live ? (id: string) => client.healthCheck(id) : undefined;

  return (
    <div className="flex h-full flex-col bg-void font-body text-txt">
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-5xl">
          {/* Page header */}
          <div className="mb-6">
            <h1 className="font-mono text-lg font-bold text-txt">Connectors</h1>
            <p className="mt-1 text-sm text-sub">
              Cost data enters through two ingest doors into one internal FOCUS v1.4 model.
            </p>
            {/* Reach: what each deployment target can connect, and what is live. */}
            <div className="mt-3 flex flex-wrap gap-2">
              {COVERAGE_ORDER.map((cov) => {
                const all = sources.filter((s) => s.coverage === cov);
                const on = all.filter((s) => s.configured).length;
                return (
                  <span
                    key={cov}
                    className="rounded border border-edge bg-slab px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-sub"
                  >
                    {COVERAGE_LABEL[cov]} · <span className="text-value">{on}</span>/{all.length} live
                  </span>
                );
              })}
              {!live && (
                <span className="rounded border border-edge px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-dim">
                  Offline view — status from bundled registry
                </span>
              )}
              {live && (
                // The browser holds no API token, so the server returns the
                // neutral (env-independent) status for live connectors.
                <span className="rounded border border-edge px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-dim">
                  Live connector status requires authenticated API access
                </span>
              )}
            </div>
          </div>

          {/* Two-ingest-doors model */}
          <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FocusDoorWalk />
            <div
              className="rounded-card border p-4"
              style={{
                borderColor: 'rgba(124,141,255,0.25)',
                background: 'rgba(124,141,255,0.04)',
              }}
            >
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--gate)' }}>
                Door 2 · Source adapters
              </div>
              <div className="font-mono text-sm font-bold text-txt">Adapter registry</div>
              <p className="mt-1.5 text-[12px] text-sub">
                Auth + fetch + identity resolution per source. Only the adapter is
                source-specific; the engine, forecasts, value ratios, and governance gates
                stay provider-agnostic.
              </p>
            </div>
          </div>

          {/* Peer interchange. Deliberately NOT presented as a third ingest
              door — the two-doors tenet stands. FinIO is an exchange path over
              the same internal model: the rows it puts on the wire are built by
              the same code as the rows the doors bring in. */}
          <div className="mb-8">
            <Link
              href="/finio/demo"
              className="flex items-center justify-between rounded-card border border-edge bg-slab p-4 transition-colors hover:border-value/40 hover:bg-raised/40"
            >
              <div>
                <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-sub">
                  Peer interchange · agent-to-agent
                </div>
                <div className="font-mono text-sm font-bold text-txt">FinIO — /finio/demo</div>
                <p className="mt-1.5 text-[12px] text-sub">
                  Exchange FOCUS-shaped cost and value with another company&apos;s agent over
                  HTTP/REST. Standard FOCUS columns carry cost;{' '}
                  <span className="font-mono text-value">x_Ratio*</span> extensions carry the
                  value denominator. Not an ingest door — the same internal model, exchanged
                  rather than imported.
                </p>
              </div>
              <span className="ml-4 shrink-0 font-mono text-xs text-dim">→</span>
            </Link>
          </div>

          {/* Active / connected adapters */}
          {connected.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 font-mono text-[11px] uppercase tracking-wider text-sub">
                Active — {connected.length} adapter{connected.length !== 1 ? 's' : ''}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {connected.map((src) => (
                  <ConnectorCard
                    key={src.id}
                    source={src}
                    onTest={onTest}
                    session={sessions[src.id]}
                    run={runs[src.id]}
                    busy={busy?.sourceId === src.id ? busy.phase : null}
                    onConnect={() => void connectConnector(src.id, ingestClient)}
                    onIngest={() => void runConnectorIngest(src.id, src.name, ingestClient)}
                    onDisconnect={() => disconnectConnector(src.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Available / dark adapters */}
          {available.length > 0 && (
            <section>
              <h2 className="mb-3 font-mono text-[11px] uppercase tracking-wider text-sub">
                Available — {available.length} adapter{available.length !== 1 ? 's' : ''}
              </h2>
              <p className="mb-3 text-[12px] text-dim">
                Each connector goes live automatically once its environment variables are
                set on the server — no feature flag, no code change. Nothing calls out until
                a connector is fully configured; set its <span className="font-mono">COSTSOURCE_*_LIVE=false</span>{' '}
                kill-switch to keep one off.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {available.map((src) => (
                  <ConnectorCard
                    key={src.id}
                    source={src}
                    onTest={onTest}
                    session={sessions[src.id]}
                    run={runs[src.id]}
                    busy={busy?.sourceId === src.id ? busy.phase : null}
                    onConnect={() => void connectConnector(src.id, ingestClient)}
                    onIngest={() => void runConnectorIngest(src.id, src.name, ingestClient)}
                    onDisconnect={() => disconnectConnector(src.id)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}


export default function Connectors() {
 const sim = useStore(s => s.simulation);
 return sim ? <SimulationConnectors /> : <ConnectorRegistry />;
}
