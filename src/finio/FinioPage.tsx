// Standalone /finio route — demonstrates the FinIO A2A seam with a mock/live
// toggle. Performs the two-phase exchange (handshake → export) and renders the
// returned FOCUS rows, with the x_Ratio* value extensions highlighted.
// Isolated from the main Ratio app; does not touch the store.
//
// The FOCUS version selector is the point of the page as much as the table is:
// picking a version the responder supports shows the negotiated version flowing
// through to the rows, and picking one it does not shows the 409 — identically
// in mock and live mode, which is the seam's whole claim.
import { useState, useCallback } from 'react';
import { createFinioClient, validateFocusRows, SUPPORTED_FOCUS_VERSIONS } from './index';
import type { FinioExport, FocusRow, FocusVersion, HandshakeResult } from './index';

type LoadState =
  | { status: 'idle' }
  | { status: 'handshaking' }
  | { status: 'exporting'; handshake: HandshakeResult }
  | { status: 'success'; handshake: HandshakeResult; data: FinioExport; conformant: boolean }
  | { status: 'error'; message: string };

/** An unsupported version, kept in the picker so the 409 path is demonstrable. */
const UNSUPPORTED_VERSION = '2.0' as FocusVersion;

/** Format a USD number as a compact dollar string, e.g. $13,632. */
function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/** Render a single FOCUS row as a <tr>. */
function FocusRowLine({ row }: { row: FocusRow }) {
  return (
    <tr className="border-b border-edge hover:bg-raised/40 transition-colors">
      <td className="py-2 pr-4 text-xs text-txt whitespace-nowrap">{row.ChargeDescription}</td>
      <td className="py-2 pr-4 text-xs text-sub whitespace-nowrap">{row.ServiceName}</td>
      <td className="py-2 pr-4 text-xs text-sub">{row.ProviderName}</td>
      <td className="py-2 pr-4 text-xs font-mono text-txt text-right">{usd(row.BilledCost)}</td>
      {/* x_Ratio* columns — highlighted in value colour */}
      <td className="py-2 pr-4 text-xs font-mono font-semibold text-value text-right">
        {row.x_RatioValueRatio.toFixed(1)}×
      </td>
      <td className="py-2 pr-4 text-xs font-mono font-semibold text-value text-right">
        {usd(row.x_RatioTotalValue)}
      </td>
      <td className="py-2 pr-4 text-xs text-sub">{row.x_RatioDemandShape}</td>
      <td className="py-2 text-xs font-mono text-value text-right">
        {row.x_RatioGovernanceGates}/4
      </td>
    </tr>
  );
}

/** Column header with optional value-extension styling. */
function Th({ children, isExtension = false }: { children: React.ReactNode; isExtension?: boolean }) {
  return (
    <th
      className={[
        'pb-2 pr-4 text-left text-xs font-semibold whitespace-nowrap',
        isExtension ? 'text-value' : 'text-sub',
      ].join(' ')}
    >
      {children}
    </th>
  );
}

/** One label/value pair in a metadata strip. */
function Meta({ label, value, tone = 'text-dim' }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-sub">{label}</dt>
      <dd className={`font-mono truncate ${tone}`}>{value}</dd>
    </div>
  );
}

export function FinioPage() {
  const [clientMode, setClientMode] = useState<'mock' | 'live'>('mock');
  const [requestedVersion, setRequestedVersion] = useState<FocusVersion>('1.4');
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });

  const runExchange = useCallback(async () => {
    setLoadState({ status: 'handshaking' });
    try {
      const client = createFinioClient(clientMode);

      // Phase 1: handshake
      const handshake = await client.handshake({
        agentId: 'ratio-agent-v1',
        capabilities: ['finio.export'],
        focusVersion: requestedVersion,
        nonce: Date.now().toString(36),
      });

      // Phase 2: export
      setLoadState({ status: 'exporting', handshake });
      const data = await client.export(handshake.sessionId);

      // Check the peer's payload rather than trusting it — the same rules the
      // responder applies before sending.
      const conformant = validateFocusRows(data.rows).ok;
      setLoadState({ status: 'success', handshake, data, conformant });
    } catch (err) {
      setLoadState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [clientMode, requestedVersion]);

  const isLoading =
    loadState.status === 'handshaking' || loadState.status === 'exporting';

  const phaseLabel = (() => {
    if (loadState.status === 'handshaking') return 'Handshaking…';
    if (loadState.status === 'exporting') return 'Exporting FOCUS rows…';
    return 'Handshake + Export';
  })();

  const versionOptions: FocusVersion[] = [...SUPPORTED_FOCUS_VERSIONS, UNSUPPORTED_VERSION];

  return (
    <div className="min-h-screen bg-void px-4 py-10 font-body text-txt">
      <div className="mx-auto max-w-5xl">

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-txt">
            FinIO A2A Exchange
          </h1>
          <p className="mt-1 text-sm text-sub">
            Agent-to-agent FinOps interchange over HTTP/REST — FOCUS cost columns +{' '}
            <span className="font-mono text-value">x_Ratio*</span> value extensions.
            Rows are built by the same code path as the cost-ingest doors.
          </p>
        </div>

        {/* Controls card */}
        <div className="mb-6 rounded-card border border-edge bg-slab p-6">
          <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-sub">
            Client mode
          </p>

          {/* Mode toggle */}
          <div className="mb-5 flex gap-2">
            {(['mock', 'live'] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setClientMode(m);
                  setLoadState({ status: 'idle' });
                }}
                className={[
                  'rounded-card border px-4 py-1.5 text-sm font-medium transition-colors',
                  clientMode === m
                    ? m === 'mock'
                      ? 'border-shape bg-shape/10 text-shape'
                      : 'border-value bg-value/10 text-value'
                    : 'border-edge bg-raised text-sub hover:text-txt',
                ].join(' ')}
              >
                {m}
              </button>
            ))}
          </div>

          {/* Requested FOCUS version */}
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-sub">
            Requested FOCUS version
          </p>
          <div className="mb-5 flex flex-wrap gap-2">
            {versionOptions.map((v) => {
              const supported = SUPPORTED_FOCUS_VERSIONS.includes(v);
              return (
                <button
                  key={v}
                  onClick={() => {
                    setRequestedVersion(v);
                    setLoadState({ status: 'idle' });
                  }}
                  title={supported ? undefined : 'Outside the supported range — expect a 409'}
                  className={[
                    'rounded-card border px-3 py-1 font-mono text-xs transition-colors',
                    requestedVersion === v
                      ? supported
                        ? 'border-gate bg-gate/10 text-gate'
                        : 'border-cost bg-cost/10 text-cost'
                      : 'border-edge bg-raised text-sub hover:text-txt',
                  ].join(' ')}
                >
                  {v}
                  {!supported && ' ✕'}
                </button>
              );
            })}
          </div>

          {/* Trigger button */}
          <button
            onClick={runExchange}
            disabled={isLoading}
            className="w-full rounded-card bg-gate px-4 py-2 text-sm font-semibold text-void transition-opacity disabled:opacity-50"
          >
            {phaseLabel}
          </button>
        </div>

        {/* Idle prompt */}
        {loadState.status === 'idle' && (
          <p className="text-center text-sm text-dim">
            Select a mode and run the exchange to see FOCUS rows.
          </p>
        )}

        {/* Loading indicator */}
        {isLoading && (
          <p className="text-center text-sm text-sub">{phaseLabel}</p>
        )}

        {/* Error */}
        {loadState.status === 'error' && (
          <div className="rounded-card border border-cost/40 bg-cost/10 p-4">
            <p className="text-sm font-medium text-cost">Exchange failed</p>
            <p className="mt-1 text-xs text-sub">{loadState.message}</p>
          </div>
        )}

        {/* Success */}
        {loadState.status === 'success' && (
          <div className="space-y-4">
            {/* Handshake meta */}
            <div className="rounded-card border border-edge bg-slab p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-sub">
                Handshake
              </p>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
                <Meta
                  label="mode"
                  value={clientMode}
                  tone={clientMode === 'mock' ? 'text-shape font-semibold' : 'text-value font-semibold'}
                />
                <Meta label="requested" value={requestedVersion} />
                <Meta label="negotiated" value={loadState.handshake.focusVersion} tone="text-txt" />
                <Meta label="accepts" value={loadState.handshake.accepts.join(', ') || '—'} />
                <Meta label="sessionId" value={loadState.handshake.sessionId} />
                <Meta
                  label="expiresAt"
                  value={new Date(loadState.handshake.expiresAt).toLocaleTimeString()}
                />
              </dl>
            </div>

            {/* Export meta */}
            <div className="rounded-card border border-edge bg-slab p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-sub">
                Export — {loadState.data.rows.length} FOCUS rows
              </p>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                <Meta label="generatedAt" value={loadState.data.generatedAt} />
                <Meta
                  label="billingPeriod"
                  value={`${loadState.data.rows[0]?.BillingPeriodStart.slice(0, 10)} → ${loadState.data.rows[0]?.BillingPeriodEnd.slice(0, 10)}`}
                />
                <Meta
                  label="FOCUS conformance"
                  value={loadState.conformant ? 'all rows valid' : 'violations found'}
                  tone={loadState.conformant ? 'text-value' : 'text-cost'}
                />
              </dl>
            </div>

            {/* FOCUS rows table */}
            <div className="rounded-card border border-edge bg-slab p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-sub">
                FOCUS Rows
              </p>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-edge">
                      <Th>ChargeDescription</Th>
                      <Th>ServiceName</Th>
                      <Th>ProviderName</Th>
                      <Th>BilledCost</Th>
                      <Th isExtension>x_RatioValueRatio</Th>
                      <Th isExtension>x_RatioTotalValue</Th>
                      <Th isExtension>x_RatioDemandShape</Th>
                      <Th isExtension>x_RatioGovernanceGates</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadState.data.rows.map((row) => (
                      <FocusRowLine key={row.x_RatioWorkloadId} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Back links */}
        <div className="mt-8 flex justify-center gap-6 text-xs text-dim">
          <a href="/finio" className="hover:text-sub">
            ← what FinIO is
          </a>
          <a href="/" className="hover:text-sub">
            back to Ratio
          </a>
        </div>
      </div>
    </div>
  );
}
