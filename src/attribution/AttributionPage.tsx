// Standalone /attribution route — the "Who ran up this cost?" leaderboard.
// Isolated from the main Ratio app; does not touch the store. Presentation
// follows the TokenomicsPage pattern (mock/live toggle + load-state machine).
//
// Two product rules are load-bearing here:
//   - Value-agnostic ranking: rows sort by ABSOLUTE inference cost. The value
//     ratio appears exactly once — as a single line of portfolio context below
//     the header — and never feeds the sort (R4 at display).
//   - Honest bases: each row states what it sums (team = workload MTD totals;
//     user = the sampled demo query log), and the UI renders it verbatim.
import Link from 'next/link';
import { useState, useCallback } from 'react';
import { WORKLOADS } from '@/data/workloads';
import { createAttributionClient } from './index';
import { LiveAccrualBoard } from './LiveAccrualBoard';
import type { AttributionDimension, AttributionReport } from './index';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: AttributionReport }
  | { status: 'error'; message: string };

// One line of value context beside the ranking (R4). Display-only: this number
// is never passed to the sort — the ranking stays value-agnostic by construction.
function portfolioValueRatio(): number {
  const spend = WORKLOADS.reduce((acc, w) => acc + w.costs.monthly_spend, 0);
  const value = WORKLOADS.reduce((acc, w) => acc + w.value.total_value, 0);
  return spend === 0 ? 0 : value / spend;
}

// ---------------------------------------------------------------------------
// Page — the success view renders the LIVE leaderboard (LiveAccrualBoard):
// ticking totals, animated share bars, a rolling accrual curve, and
// framer-motion rank re-ordering. The static ranked list is gone; the base
// report figures remain visible as each live row's base + working.
// ---------------------------------------------------------------------------

export function AttributionPage() {
  const [dimension, setDimension] = useState<AttributionDimension>('team');
  const [clientMode, setClientMode] = useState<'mock' | 'live'>('mock');
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });

  const runReport = useCallback(async () => {
    setLoadState({ status: 'loading' });
    try {
      const client = createAttributionClient(clientMode);
      const data = await client.getAttributionReport(dimension);
      setLoadState({ status: 'success', data });
    } catch (err) {
      setLoadState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [clientMode, dimension]);

  return (
    <div className="min-h-screen bg-void px-4 py-10 font-body text-txt">
      <div className="mx-auto max-w-4xl">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-txt">Cost Attribution</h1>
          <p className="mt-1 text-sm text-sub">
            Who ran up this cost? Ranked by absolute burn — tokens and inference cost, worst burner first.
          </p>
          {/* R4 — the one line of value context. Display-only; never in the sort. */}
          <p className="mt-2 text-xs text-dim">
            Value context: the portfolio returned {portfolioValueRatio().toFixed(1)}× its inference
            cost this month. This list ranks absolute burn only — value never sorts it.
          </p>
        </div>

        {/* Controls */}
        <div className="mb-6 rounded-card border border-edge bg-slab p-6">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-sub">Dimension</p>
          <div className="mb-5 flex gap-2">
            {(['team', 'user'] as const).map((d) => (
              <button
                key={d}
                onClick={() => {
                  setDimension(d);
                  setLoadState({ status: 'idle' });
                }}
                className={[
                  'rounded-card border px-4 py-1.5 text-sm font-medium capitalize transition-colors',
                  dimension === d
                    ? 'border-unit bg-unit/10 text-unit'
                    : 'border-edge bg-raised text-sub hover:text-txt',
                ].join(' ')}
              >
                {d === 'team' ? 'By team' : 'By user'}
              </button>
            ))}
          </div>

          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-sub">Client mode</p>
          <div className="mb-5 flex gap-2">
            {(['mock', 'live'] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setClientMode(m);
                  setLoadState({ status: 'idle' });
                }}
                className={[
                  'rounded-card border px-4 py-1.5 text-sm font-medium capitalize transition-colors',
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

          <button
            onClick={() => void runReport()}
            disabled={loadState.status === 'loading'}
            className="w-full rounded-card bg-gate px-4 py-2 text-sm font-semibold text-void transition-opacity disabled:opacity-50"
          >
            {loadState.status === 'loading' ? 'Aggregating…' : 'Run attribution'}
          </button>
        </div>

        {/* Idle */}
        {loadState.status === 'idle' && (
          <p className="text-center text-sm text-dim">
            Pick a dimension and run the report to rank the burners.
          </p>
        )}

        {/* Loading */}
        {loadState.status === 'loading' && (
          <p className="text-center text-sm text-sub">Aggregating attribution rows…</p>
        )}

        {/* Error */}
        {loadState.status === 'error' && (
          <div className="rounded-card border border-cost/40 bg-cost/10 p-4">
            <p className="text-sm font-medium text-cost">Report failed</p>
            <p className="mt-1 text-xs text-sub">{loadState.message}</p>
          </div>
        )}

        {/* Success */}
        {loadState.status === 'success' && (
          <div className="space-y-4">
            {loadState.data.rows.length === 0 ? (
              <p className="rounded-card border border-edge bg-slab p-6 text-center text-sm text-dim">
                Nothing to rank — the report found no records for this dimension.
              </p>
            ) : (
              <LiveAccrualBoard
                key={`${clientMode}:${dimension}:${loadState.data.generatedAt}`}
                report={loadState.data}
              />
            )}

            <div className="rounded-card border border-edge bg-slab px-4 py-3">
              <dl className="flex flex-wrap gap-x-8 gap-y-1 text-xs">
                <div>
                  <dt className="text-sub">generatedAt</dt>
                  <dd className="font-mono text-dim">{loadState.data.generatedAt}</dd>
                </div>
                <div>
                  <dt className="text-sub">dimension</dt>
                  <dd className="font-mono font-semibold text-unit">{loadState.data.dimension}</dd>
                </div>
                <div>
                  <dt className="text-sub">mode</dt>
                  <dd
                    className={`font-mono font-semibold ${
                      clientMode === 'mock' ? 'text-shape' : 'text-value'
                    }`}
                  >
                    {clientMode}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        )}

        {/* Back link */}
        <Link href="/" className="mt-8 block text-center text-xs text-dim hover:text-sub">
          ← back to Ratio
        </Link>
      </div>
    </div>
  );
}
