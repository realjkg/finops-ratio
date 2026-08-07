// Connectors — Wave 4 Slice 4. Real object over the existing CostSourceClient seam.
// Lists all registered cost-source adapters with identity, FOCUS version mapping,
// connection status, and honest affordances. No new backend, no new deps.
// Controlled-egress paths (live PointFive broker) carry the reserved warm accent.

import { ConnectorCard } from '@/connectors/ConnectorCard';
import { COST_SOURCES } from '@/costsource/seed';

// Split at module level: both groups are stable seed data (deterministic in mock mode).
const connected = COST_SOURCES.filter((s) => s.configured);
const available = COST_SOURCES.filter((s) => !s.configured);

export default function Connectors() {
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
          </div>

          {/* Two-ingest-doors model */}
          <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div
              className="rounded-card border p-4"
              style={{
                borderColor: 'rgba(124,141,255,0.25)',
                background: 'rgba(124,141,255,0.04)',
              }}
            >
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--gate)' }}>
                Door 1 · Direct ingest
              </div>
              <div className="font-mono text-sm font-bold text-txt">POST /ingest/focus</div>
              <p className="mt-1.5 text-[12px] text-sub">
                Any FOCUS-formatted billing export (v1.0–v1.4). Any cloud, any tool, any
                normalizer — no custom integration. The version shim upgrades the export to
                the v1.4 canonical model.
              </p>
            </div>
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
            <a
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
            </a>
          </div>

          {/* Active / connected adapters */}
          {connected.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 font-mono text-[11px] uppercase tracking-wider text-sub">
                Active — {connected.length} adapter{connected.length !== 1 ? 's' : ''}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {connected.map((src) => (
                  <ConnectorCard key={src.id} source={src} />
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
                Ships dark by default. Set the feature flag and credentials for each
                connector to activate it. No network calls are made until a connector is
                fully configured.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {available.map((src) => (
                  <ConnectorCard key={src.id} source={src} />
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

