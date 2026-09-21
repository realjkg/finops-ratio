// Standalone /costsource route — demonstrates the source-agnostic cost-ingest
// seam with a mock/live toggle. Picks a source, runs healthCheck +
// fetchCostRows + fetchFindings, then shows cost rows flowing from the source
// through the FOCUS v1.0-v1.4 version shim into the v1.4 canonical model, and on
// into a Ratio workload that displays value ratio, forecast, and gates — the
// numerator/denominator composition. Isolated from the main app; no store.
import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { createCostSourceClient, composeRatioView } from './index';
import type {
  CostSourceDescriptor,
  CostRowsResult,
  CostFinding,
  SourceHealth,
  CanonicalFocusRow,
  FocusVersion,
} from './index';
import { FOCUS_VERSIONS } from './index';
import { rawRowsForVersion } from './seed';
import { formatUSD, formatRatio, formatPct } from '@/lib/format';
import { ratioColor } from '@/lib/scales';
import { withBasePath } from '@/lib/basePath';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading'; phase: string }
  | { status: 'error'; message: string }
  | {
      status: 'success';
      health: SourceHealth;
      rows: CostRowsResult;
      findings: CostFinding[];
    };

/** Current-month window as ISO strings (UTC). */
function currentWindow(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function Dot({ on }: { on: boolean }) {
  return (
    <span
      className="inline-block h-2 w-2 rounded-full"
      style={{ background: on ? 'var(--value)' : 'var(--cost)' }}
    />
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md border border-edge bg-raised px-2 py-0.5 font-mono text-[11px] text-sub">
      {children}
    </span>
  );
}

const SEVERITY_COLOR: Record<CostFinding['severity'], string> = {
  info: 'var(--unit)',
  warning: 'var(--shape)',
  critical: 'var(--cost)',
};

export function CostSourcePage() {
  const [clientMode, setClientMode] = useState<'mock' | 'live'>('mock');
  const [sources, setSources] = useState<CostSourceDescriptor[]>([]);
  const [sourceId, setSourceId] = useState<string>('pointfive-sandbox');
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });

  // Load the source list whenever the client mode changes.
  useEffect(() => {
    let cancelled = false;
    createCostSourceClient(clientMode)
      .listSources()
      .then((list) => {
        if (cancelled) return;
        setSources(list);
        if (!list.some((s) => s.id === sourceId) && list[0]) setSourceId(list[0].id);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // sourceId intentionally excluded: we only refetch the catalog on mode change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientMode]);

  const runIngest = useCallback(async () => {
    const client = createCostSourceClient(clientMode);
    const window = currentWindow();
    try {
      setLoadState({ status: 'loading', phase: 'Checking adapter health…' });
      const health = await client.healthCheck(sourceId);

      setLoadState({ status: 'loading', phase: 'Fetching + normalizing cost rows…' });
      const rows = await client.fetchCostRows(sourceId, window);

      setLoadState({ status: 'loading', phase: 'Loading findings…' });
      const findings = await client.fetchFindings(sourceId);

      setLoadState({ status: 'success', health, rows, findings });
    } catch (err) {
      setLoadState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [clientMode, sourceId]);

  const selected = sources.find((s) => s.id === sourceId);
  const isLoading = loadState.status === 'loading';

  return (
    <div className="min-h-screen bg-void px-4 py-10 font-body text-txt">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-txt">
            Cost Source Ingest
          </h1>
          <p className="mt-1 text-sm text-sub">
            Source-agnostic cost ingest — any source’s FOCUS export (v1.0–v1.4) is
            upgraded to the{' '}
            <span className="font-mono text-value">v1.4 canonical</span> model, then
            given Ratio’s value denominator, forecast, and gates. PointFive is
            source #1, not the architecture.
          </p>
        </div>

        {/* Controls */}
        <div className="mb-6 rounded-card border border-edge bg-slab p-6">
          {/* Mode toggle */}
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-sub">
            Client mode
          </p>
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

          {/* Source picker */}
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-sub">
            Cost source
          </p>
          <div className="mb-5 grid gap-2 sm:grid-cols-3">
            {sources.map((s) => {
              // Unconfigured sources (e.g. the live PointFive adapter when its
              // feature flag is OFF) render dark: dimmed, with a DARK badge. They
              // stay selectable so the demo can show the honest ships-dark health
              // — selecting one makes no network call.
              const isDark = !s.configured;
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    setSourceId(s.id);
                    setLoadState({ status: 'idle' });
                  }}
                  className={[
                    'rounded-card border p-3 text-left transition-colors',
                    sourceId === s.id
                      ? 'border-gate bg-gate/10'
                      : 'border-edge bg-raised hover:border-gate/50',
                    isDark ? 'opacity-60' : '',
                  ].join(' ')}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-txt">{s.name}</span>
                    <Dot on={s.configured} />
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Chip>FOCUS v{s.focusVersion}</Chip>
                    <Chip>{s.coverage.replace('_', ' ')}</Chip>
                    {isDark && (
                      <span className="rounded-md border border-cost/40 bg-cost/10 px-2 py-0.5 font-mono text-[11px] text-cost">
                        DARK
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {selected && (
            <p className="mb-4 text-xs text-dim">{selected.note}</p>
          )}

          <button
            onClick={runIngest}
            disabled={isLoading || !selected}
            className="w-full rounded-card bg-gate px-4 py-2 text-sm font-semibold text-void transition-opacity disabled:opacity-50"
          >
            {isLoading ? (loadState as { phase: string }).phase : 'Ingest + Normalize'}
          </button>
        </div>

        {/* Idle */}
        {loadState.status === 'idle' && (
          <p className="text-center text-sm text-dim">
            Pick a source and run the ingest to see cost rows normalized into Ratio.
          </p>
        )}

        {/* Loading */}
        {isLoading && (
          <p className="text-center text-sm text-sub">{loadState.phase}</p>
        )}

        {/* Error */}
        {loadState.status === 'error' && (
          <div className="rounded-card border border-cost/40 bg-cost/10 p-4">
            <p className="text-sm font-medium text-cost">Ingest failed</p>
            <p className="mt-1 text-xs text-sub">{loadState.message}</p>
          </div>
        )}

        {/* Success */}
        {loadState.status === 'success' && (
          <div className="space-y-4">
            <HealthCard health={loadState.health} />
            <UpgradeAuditCard rows={loadState.rows} />
            <CompositionCard rows={loadState.rows.rows} />
            <FocusRowsCard rows={loadState.rows.rows} />
            <FindingsCard findings={loadState.findings} />
          </div>
        )}

        {/* FOCUS-file ingest panel — only visible for focus_file kind sources.
             Demonstrates the POST /api/costsource/ingest path: arbitrary FOCUS
             rows at a user-chosen version flow through the FocusFileAdapter and
             emerge as canonical v1.4 with Ratio value context attached. */}
        {selected?.kind === 'focus_file' && (
          <IngestFromFilePanel sourceId={sourceId} />
        )}

        <Link href="/" className="mt-8 block text-center text-xs text-dim hover:text-sub">
          ← back to Ratio
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IngestFromFilePanel — exercises the POST /api/costsource/ingest path
// ---------------------------------------------------------------------------

type IngestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; result: CostRowsResult };

/**
 * Lets the user pick a FOCUS version (v1.0–v1.4) and POST sample rows
 * directly to the FocusFileAdapter ingest endpoint. Shows the backfill
 * audit and canonical output — demonstrating the adapter works with
 * arbitrary FOCUS exports, not just the mock seed.
 */
function IngestFromFilePanel({ sourceId }: { sourceId: string }) {
  const [version, setVersion] = useState<FocusVersion>('1.0');
  const [state, setState] = useState<IngestState>({ status: 'idle' });

  const postSamplePayload = useCallback(async () => {
    setState({ status: 'loading' });
    const rows = rawRowsForVersion(version);
    try {
      const res = await fetch(withBasePath('/api/costsource/ingest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId, version, rows }),
      });
      if (!res.ok) {
        const { error } = (await res.json()) as { error: string };
        setState({ status: 'error', message: error });
        return;
      }
      const result = (await res.json()) as CostRowsResult;
      setState({ status: 'success', result });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [sourceId, version]);

  return (
    <div className="mt-6 rounded-card border border-gate/40 bg-gate/5 p-4">
      {/* Header */}
      <div className="mb-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-gate">
          FOCUS-file direct ingest (POST)
        </p>
        <p className="mt-1 text-xs text-sub">
          POST sample rows at any FOCUS version to{' '}
          <span className="font-mono text-txt">/api/costsource/ingest</span>. The
          FocusFileAdapter upgrades them to v1.4 canonical and attaches Ratio value
          context — the engine is unchanged. This is the second adapter proving
          source-agnosticism.
        </p>
      </div>

      {/* Version picker + trigger */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-sub">FOCUS version:</span>
        {FOCUS_VERSIONS.map((v) => (
          <button
            key={v}
            onClick={() => {
              setVersion(v);
              setState({ status: 'idle' });
            }}
            className={[
              'rounded border px-2 py-0.5 font-mono text-xs transition-colors',
              version === v
                ? 'border-gate bg-gate/20 text-gate'
                : 'border-edge bg-raised text-sub hover:text-txt',
            ].join(' ')}
          >
            v{v}
          </button>
        ))}
        <button
          onClick={postSamplePayload}
          disabled={state.status === 'loading'}
          className="ml-auto rounded-card bg-gate px-3 py-1 text-xs font-semibold text-void transition-opacity disabled:opacity-50"
        >
          {state.status === 'loading' ? 'Ingesting…' : `POST sample rows at v${version}`}
        </button>
      </div>

      {/* Result */}
      {state.status === 'error' && (
        <p className="rounded-md border border-cost/40 bg-cost/10 px-3 py-2 text-xs text-cost">
          {state.message}
        </p>
      )}
      {state.status === 'success' && (
        <div className="space-y-3">
          <UpgradeAuditCard rows={state.result} />
          <CompositionCard rows={state.result.rows} />
          <FocusRowsCard rows={state.result.rows} />
        </div>
      )}
      {state.status === 'idle' && (
        <p className="text-xs text-dim">
          Pick a version and POST to see the version shim backfill the additive columns.
        </p>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-edge bg-slab p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-sub">
        {title}
      </p>
      {children}
    </div>
  );
}

function HealthCard({ health }: { health: SourceHealth }) {
  return (
    <Card title="Adapter health">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
        <div className="flex items-center gap-2">
          <Dot on={health.reachable} />
          <span className="text-sub">reachable</span>
        </div>
        <div className="flex items-center gap-2">
          <Dot on={health.authed} />
          <span className="text-sub">authed</span>
        </div>
        <div>
          <dt className="text-sub">source version</dt>
          <dd className="font-mono text-txt">v{health.sourceVersion}</dd>
        </div>
        <div>
          <dt className="text-sub">canonical</dt>
          <dd className="font-mono text-value">v{health.canonicalVersion}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-dim">{health.detail}</p>
    </Card>
  );
}

function UpgradeAuditCard({ rows }: { rows: CostRowsResult }) {
  const passthrough = rows.backfilledColumns.length === 0;
  return (
    <Card title="Version normalization">
      <p className="text-sm text-txt">
        Normalized{' '}
        <span className="font-mono text-shape">v{rows.sourceVersion}</span>
        {' → '}
        <span className="font-mono text-value">v{rows.canonicalVersion} canonical</span>
        {' · '}
        {passthrough
          ? 'no backfill needed (source already at canonical)'
          : `backfilled ${rows.backfilledColumns.length} additive column(s)`}
      </p>
      {!passthrough && (
        <div className="mt-2 flex flex-wrap gap-1">
          {rows.backfilledColumns.map((c) => (
            <Chip key={c}>{c}</Chip>
          ))}
        </div>
      )}
    </Card>
  );
}

// The numerator/denominator proof: the first ingested row, resolved to a Ratio
// workload, shown with value ratio (denominator), forecast, and governance gates.
function CompositionCard({ rows }: { rows: CanonicalFocusRow[] }) {
  const featured = rows[0];
  const view = featured ? composeRatioView(featured) : null;
  if (!featured || !view) {
    return (
      <Card title="Ratio composition">
        <p className="text-xs text-dim">No resolvable workload in the ingested rows.</p>
      </Card>
    );
  }
  const monthly = view.budget?.monthly;
  return (
    <Card title={`Ratio composition — ${view.name}`}>
      <div className="grid gap-4 sm:grid-cols-4">
        <Metric label="Cost (numerator)">
          <span className="font-mono text-base font-bold text-cost">
            {formatUSD(view.monthlySpend)}/mo
          </span>
        </Metric>
        <Metric label="Value ratio (denominator)">
          <span
            className="font-mono text-base font-bold"
            style={{ color: ratioColor(view.valueRatio) }}
          >
            {formatRatio(view.valueRatio)}
          </span>
        </Metric>
        <Metric label="Forecast (EOM)">
          {monthly ? (
            <span className="font-mono text-base font-bold text-txt">
              {formatUSD(monthly.projectedEom)}
              <span className="ml-1 text-xs text-sub">
                ({formatPct(monthly.projectedPctOfBudget)} of budget)
              </span>
            </span>
          ) : (
            <span className="text-sm text-dim">—</span>
          )}
        </Metric>
        <Metric label="Governance gates">
          <span className="font-mono text-base font-bold text-gate">
            {view.gatesPassed}/4
          </span>
        </Metric>
      </div>
      {monthly && monthly.daysUntilBreach !== null && (
        <p className="mt-3 text-xs text-cost">
          Forecast breaches budget in ~{monthly.daysUntilBreach} days.
        </p>
      )}
    </Card>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-dim">{label}</span>
      {children}
    </div>
  );
}

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

function FocusRowsCard({ rows }: { rows: CanonicalFocusRow[] }) {
  return (
    <Card title={`Canonical FOCUS v1.4 rows — ${rows.length}`}>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-edge">
              <Th>ChargeDescription</Th>
              <Th>ServiceName</Th>
              <Th>ProviderName</Th>
              <Th>BilledCost</Th>
              <Th isExtension>x_RatioValueRatio</Th>
              <Th isExtension>x_RatioDemandShape</Th>
              <Th isExtension>x_RatioGovernanceGates</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.x_RatioWorkloadId || row.ResourceId}
                className="border-b border-edge hover:bg-raised/40 transition-colors"
              >
                <td className="py-2 pr-4 text-xs text-txt whitespace-nowrap">
                  {row.ChargeDescription}
                </td>
                <td className="py-2 pr-4 text-xs text-sub whitespace-nowrap">
                  {row.ServiceName}
                </td>
                <td className="py-2 pr-4 text-xs text-sub">{row.ProviderName}</td>
                <td className="py-2 pr-4 text-right font-mono text-xs text-cost">
                  {formatUSD(row.BilledCost)}
                </td>
                <td
                  className="py-2 pr-4 text-right font-mono text-xs font-semibold"
                  style={{ color: ratioColor(row.x_RatioValueRatio) }}
                >
                  {formatRatio(row.x_RatioValueRatio)}
                </td>
                <td className="py-2 pr-4 text-xs text-sub">{row.x_RatioDemandShape}</td>
                <td className="py-2 text-right font-mono text-xs text-gate">
                  {row.x_RatioGovernanceGates}/4
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function FindingsCard({ findings }: { findings: CostFinding[] }) {
  if (findings.length === 0) {
    return (
      <Card title="Findings">
        <p className="text-xs text-dim">
          This source exposes cost rows only — no waste/opportunity findings.
        </p>
      </Card>
    );
  }
  return (
    <Card title={`Findings — ${findings.length} (PointFive DeepWaste shape)`}>
      <ul className="space-y-2">
        {findings.map((f) => (
          <li
            key={f.id}
            className="flex items-start justify-between gap-4 rounded-md border border-edge bg-raised px-3 py-2"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: SEVERITY_COLOR[f.severity] }}
                />
                <span className="text-[10px] uppercase tracking-wider text-dim">
                  {f.type} · {f.category}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-txt">{f.title}</p>
            </div>
            <div className="shrink-0 text-right font-mono text-xs">
              {f.type === 'opportunity' ? (
                <span className="text-value">
                  save {formatUSD(f.estimatedMonthlySavings)}/mo
                </span>
              ) : (
                <span className="text-cost">+{formatUSD(f.observedSpendDelta)}/mo</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

