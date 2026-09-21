// Accuracy ledger summary (Ratio v2 PR H) — closes the feedback loop. A compact
// read of how accurate Ratio's change predictions have been, per source, at a
// glance: entries, implied accuracy, and the honest cold-start flag. Reuses the
// PR G accuracy API (/api/prediction/accuracy); offline-capable on the mock
// (empty) ledger, which is correct — no synthetic back-test is seeded.
import { useEffect, useMemo, useState } from 'react';
import type { AccuracyReport, PredictionSourceId } from '@/prediction';
import { formatSignedPct } from '@/lib/format';
import { TOKEN_HEX } from '@/lib/scales';
import { withBasePath } from '@/lib/basePath';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; report: AccuracyReport };

async function fetchAccuracy(): Promise<AccuracyReport> {
  const res = await fetch(withBasePath('/api/prediction/accuracy'));
  if (!res.ok) {
    throw new Error(`Accuracy ledger unavailable (HTTP ${res.status})`);
  }
  return (await res.json()) as AccuracyReport;
}

interface SourceRow {
  source: PredictionSourceId;
  entries: number;
  impliedAccuracy: number | null; // 1 - sample-weighted mean error; null cold-start
}

/**
 * Roll the per-source/per-change-type error distributions up to one row per
 * source: total realized entries and a sample-weighted implied accuracy
 * (1 - mean error). A source with no history reports null — surfaced honestly
 * as cold-start rather than a fabricated number.
 */
function perSourceRows(report: AccuracyReport): SourceRow[] {
  const bySource = new Map<PredictionSourceId, { entries: number; weightedErr: number }>();
  for (const d of report.distributions) {
    if (d.sampleSize <= 0 || !Number.isFinite(d.meanAbsRelError)) continue;
    const acc = bySource.get(d.source) ?? { entries: 0, weightedErr: 0 };
    acc.entries += d.sampleSize;
    acc.weightedErr += d.sampleSize * d.meanAbsRelError;
    bySource.set(d.source, acc);
  }
  const order: PredictionSourceId[] = ['pointfive', 'forecast_engine', 'provider_pricing'];
  return order.map((source) => {
    const agg = bySource.get(source);
    return {
      source,
      entries: agg?.entries ?? 0,
      impliedAccuracy: agg && agg.entries > 0 ? 1 - agg.weightedErr / agg.entries : null,
    };
  });
}

export function AccuracyLedgerSummary() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchAccuracy()
      .then((report) => {
        if (!cancelled) setState({ status: 'ready', report });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="rounded-card border border-edge bg-deep p-4 font-mono text-[11px] text-dim">
        Loading accuracy ledger…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="rounded-card border border-cost bg-deep p-4 font-mono text-[11px] text-cost">
        {state.message}
      </div>
    );
  }
  return <LedgerView report={state.report} />;
}

function LedgerView({ report }: { report: AccuracyReport }) {
  const rows = useMemo(() => perSourceRows(report), [report]);
  const overallP50 = report.overall.medianAccuracy;
  const overallP90 = report.overall.p90Accuracy;

  return (
    <div className="rounded-card border border-edge bg-deep p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-body text-sm font-semibold text-txt">Prediction accuracy ledger</h3>
        {report.coldStart ? (
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider"
            style={{ color: TOKEN_HEX.shape, backgroundColor: `${TOKEN_HEX.shape}1a` }}
          >
            COLD-START · {report.totalEntries} realized
          </span>
        ) : (
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider"
            style={{ color: TOKEN_HEX.value, backgroundColor: `${TOKEN_HEX.value}1a` }}
          >
            {report.totalEntries} realized changes
          </span>
        )}
      </div>

      <p className="mt-2 max-w-prose font-body text-[11px] text-dim">
        Accuracy = 1 − |predicted − actual| / |actual|, reported as median (p50)
        with p90 alongside; target p50 ≥ 99%. The ledger fills only as realized
        post-change cost arrives — no synthetic back-test is seeded.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Stat label="Overall p50" value={pct(overallP50)} tone={TOKEN_HEX.value} />
        <Stat label="Overall p90" value={pct(overallP90)} tone={TOKEN_HEX.unit} />
      </div>

      <table className="mt-3 w-full text-left font-mono text-[11px]">
        <thead className="text-dim">
          <tr>
            <th className="py-1 font-normal">Source</th>
            <th className="py-1 text-right font-normal">Entries</th>
            <th className="py-1 text-right font-normal">Implied accuracy</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.source} className="border-t border-edge">
              <td className="py-1 text-sub">{row.source}</td>
              <td className="py-1 text-right text-sub">{row.entries}</td>
              <td className="py-1 text-right" style={{ color: accuracyTone(row.impliedAccuracy) }}>
                {pct(row.impliedAccuracy)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function pct(value: number | null): string {
  return value === null ? '—' : formatSignedPct(value * 100, 2);
}

function accuracyTone(value: number | null): string {
  if (value === null) return TOKEN_HEX.shape;
  return value >= 0.99 ? TOKEN_HEX.value : TOKEN_HEX.shape;
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-md border border-edge bg-slab p-2">
      <div className="font-mono text-[10px] text-dim">{label}</div>
      <div className="mt-0.5 font-mono text-sm" style={{ color: tone }}>
        {value}
      </div>
    </div>
  );
}

