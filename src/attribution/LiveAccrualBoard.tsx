// LiveAccrualBoard — the live layer over a stored attribution report: a
// ticking portfolio hero, a rolling spend-accrual curve, per-row animated
// spend bars, and the leaderboard re-ordered by framer-motion layout
// animations when seeded rates overtake each other.
//
// Register discipline (obvious.md UI Direction): calm motion only — a 1s data
// cadence, 0.5s layout transitions, hairline SVG. No confetti, badges, or
// streaks. The two charts are standard forms (line + horizontal bars), not a
// third signature component. The honesty chip is load-bearing: nothing here
// is live ingest.
import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { formatCents, formatInt, formatTokens, formatUSD } from '@/lib/format';
import { USER_QUERY_EVENTS } from '@/data/userQueries';
import { WORKLOADS } from '@/data/workloads';
import type { AttributionReport } from './AttributionClient';
import {
  ACCRUAL_REPLAY_SPEED,
  liveAttributionView,
  spendAccrualCurve,
  teamBurnRates,
  totalUsdPerSecond,
  userBurnRates,
  type AccrualCurvePoint,
  type BurnRate,
  type LiveAttributionRow,
} from './accrual';
import { useLiveSpend } from './useLiveSpend';

// Design-token hex values (obvious.md §Design Tokens) — SVG can't read the
// Tailwind theme, same precedent as SpendToValueGraph.
const C_EDGE = '#1a2235';
const C_RAISED = '#141a26';
const C_SUB = '#8895ad';
const C_DIM = '#4d5a72';
const C_COST = '#ff5c72';
const C_COST_FILL = 'rgba(255, 92, 114, 0.08)';

const MONO = "'JetBrains Mono', monospace";

/** Seeded rates for the report's dimension — same seeds the report ranked. */
function useRates(dimension: AttributionReport['dimension']): BurnRate[] {
  return useMemo(
    () => (dimension === 'team' ? teamBurnRates(WORKLOADS) : userBurnRates(USER_QUERY_EVENTS)),
    [dimension],
  );
}

function clockLabel(elapsedSeconds: number): string {
  const s = Math.floor(elapsedSeconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Charts — inline SVG (SpendToValueGraph precedent), no chart library
// ---------------------------------------------------------------------------

/** Rolling spend-accrual curve: portfolio USD accrued across the trailing window. */
function LiveAccrualCurve({ series }: { series: AccrualCurvePoint[] }) {
  const VW = 480;
  const VH = 150;
  const M = { top: 14, right: 74, bottom: 24, left: 46 };
  const PW = VW - M.left - M.right;
  const PH = VH - M.top - M.bottom;

  const t0 = series[0]?.tSeconds ?? 0;
  const t1 = series[series.length - 1]?.tSeconds ?? 0;
  const span = Math.max(t1 - t0, 1e-9);
  const maxUsd = Math.max(...series.map((p) => p.usd), 1e-9) * 1.1;

  const xFor = (t: number) => M.left + ((t - t0) / span) * PW;
  const yFor = (usd: number) => M.top + PH - (usd / maxUsd) * PH;
  const line = series.map((p) => `${xFor(p.tSeconds).toFixed(2)},${yFor(p.usd).toFixed(2)}`).join(' ');

  return (
    <figure className="w-full" aria-label="Rolling spend accrual — portfolio USD accrued this session">
      <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" aria-hidden="true" style={{ display: 'block' }}>
        {/* Baseline + end labels, hairline per the visual register */}
        <line x1={M.left} y1={M.top + PH} x2={M.left + PW} y2={M.top + PH} stroke={C_EDGE} strokeWidth={1} />
        <text x={M.left} y={M.top + 4} fontSize={9} fill={C_DIM} fontFamily={MONO}>
          session +$
        </text>
        <text x={M.left + PW + 6} y={yFor(maxUsd / 1.1) + 3.5} fontSize={9} fill={C_SUB} fontFamily={MONO}>
          {formatUSD(maxUsd / 1.1)}
        </text>
        <text x={M.left} y={M.top + PH + 14} fontSize={9} fill={C_DIM} fontFamily={MONO}>
          {Math.round(t0)}s
        </text>
        <text x={M.left + PW} y={M.top + PH + 14} fontSize={9} fill={C_DIM} fontFamily={MONO} textAnchor="end">
          {Math.round(t1)}s
        </text>

        {/* Accrual line + quiet fill */}
        {series.length > 1 && (
          <polygon
            points={`${xFor(t0).toFixed(2)},${(M.top + PH).toFixed(2)} ${line} ${xFor(t1).toFixed(2)},${(M.top + PH).toFixed(2)}`}
            fill={C_COST_FILL}
          />
        )}
        <polyline points={line} fill="none" stroke={C_COST} strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
    </figure>
  );
}

/** Per-row animated spend bars — live share of burn, standard horizontal bars. */
function LiveSpendBars({ rows }: { rows: LiveAttributionRow[] }) {
  const VW = 480;
  const ROW_H = 26;
  const labelW = 118;
  const valueW = 64;
  const M = { top: 4, bottom: 4 };
  const VH = rows.length * ROW_H + M.top + M.bottom;
  const plotW = VW - labelW - valueW - 12;

  return (
    <figure className="w-full" aria-label="Live share of burn by row — animated spend bars">
      <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" aria-hidden="true" style={{ display: 'block' }}>
        {rows.map((r, i) => {
          const y = M.top + i * ROW_H;
          const barW = Math.max(r.liveShareOfTotal * plotW, 1);
          return (
            <g key={`bar:${r.base.dimension}:${r.base.key}`}>
              <text x={labelW} y={y + 11} fontSize={9} fill={C_SUB} fontFamily={MONO} textAnchor="end">
                {r.base.key.length > 16 ? `${r.base.key.slice(0, 15)}…` : r.base.key}
              </text>
              <rect x={labelW + 8} y={y + 3} width={plotW} height={10} rx={2} fill={C_RAISED} />
              <motion.rect
                x={labelW + 8}
                y={y + 3}
                height={10}
                rx={2}
                fill={C_COST}
                initial={{ width: 0 }}
                animate={{ width: barW }}
                transition={{ duration: 1, ease: 'linear' }}
              />
              <text x={VW} y={y + 11} fontSize={9} fill={C_DIM} fontFamily={MONO} textAnchor="end">
                {formatUSD(r.liveInferenceCost)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Row + board
// ---------------------------------------------------------------------------

function LiveLeaderboardRow({ row, rate }: { row: LiveAttributionRow; rate: BurnRate }) {
  const sharePct = `${(row.liveShareOfTotal * 100).toFixed(1)}%`;
  return (
    <div className="rounded-card border border-edge bg-slab p-4">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-dim">
            #{row.rank} · {row.base.dimension}
          </p>
          <h3 className="truncate text-base font-semibold text-txt">{row.base.key}</h3>
        </div>
        <div className="text-right">
          <p className="font-mono text-lg font-bold text-cost">{formatUSD(row.liveInferenceCost)}</p>
          <p className="font-mono text-xs text-cost/80">+{formatCents(row.accrued.usd)} session</p>
          <p className="text-xs text-sub">{sharePct} of burn</p>
        </div>
      </div>

      {/* Live share bar — animates at the 1s data cadence. */}
      <div className="mt-3 h-1.5 w-full rounded-full bg-raised" role="presentation">
        <div
          className="h-full rounded-full bg-cost transition-[width] duration-1000 ease-linear"
          style={{ width: `${Math.min(row.liveShareOfTotal * 100, 100)}%` }}
        />
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-sub">Tokens in (live)</dt>
          <dd className="font-mono text-txt">{formatTokens(row.liveTokensIn)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-sub">Tokens out (live)</dt>
          <dd className="font-mono text-txt">{formatTokens(row.liveTokensOut)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-sub">Session tokens</dt>
          <dd className="font-mono text-cost/80">
            +{formatTokens(row.accrued.tokensIn)} in / +{formatTokens(row.accrued.tokensOut)} out
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-sub">Workloads</dt>
          <dd className="font-mono text-txt">{formatInt(row.base.inputs.workloadIds.length)}</dd>
        </div>
      </dl>

      {/* The working, always shown — base aggregation plus the accrual rate. */}
      <p className="mt-3 border-t border-edge pt-2 text-[11px] leading-relaxed text-dim">
        <span className="font-mono">{row.base.formulaLabel}</span> · {row.base.basis}
        <br />
        <span className="font-mono">accrual: {rate.basis}</span> · replayed at {ACCRUAL_REPLAY_SPEED}× demo clock
      </p>
    </div>
  );
}

export function LiveAccrualBoard({ report }: { report: AttributionReport }) {
  const { elapsedSeconds, paused } = useLiveSpend();
  const rates = useRates(report.dimension);
  const rateByKey = useMemo(() => new Map(rates.map((r) => [`${r.dimension}:${r.key}`, r] as const)), [rates]);

  const view = useMemo(
    () => liveAttributionView(report, rates, elapsedSeconds),
    [report, rates, elapsedSeconds],
  );
  const curve = useMemo(
    () =>
      spendAccrualCurve({
        usdPerSecond: totalUsdPerSecond(rates),
        elapsedWallSeconds: elapsedSeconds,
        points: 60,
        windowSeconds: 60,
      }),
    [rates, elapsedSeconds],
  );

  return (
    <div className="space-y-4">
      {/* Honesty chip — load-bearing: this is a deterministic replay, not ingest. */}
      <div className="rounded-card border border-shape/30 bg-shape/10 px-4 py-3">
        <p className="text-xs font-medium text-shape" data-testid="honesty-chip">
          {paused
            ? 'Simulated live feed — paused: tab hidden, clock holding (no drift)'
            : `Simulated live feed — deterministic replay of seeded rates (${ACCRUAL_REPLAY_SPEED}× demo clock)`}
        </p>
        <p className="mt-1 text-[11px] text-dim">
          True real-time — live ingest → SSE/WebSocket through the gateway — is planned product
          scope, not built in this demo. Every ticked number traces to seed × elapsed.
        </p>
      </div>

      {/* Live hero — the portfolio total ticks; the session line shows the delta. */}
      <div className="rounded-card border border-edge bg-deep px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs text-sub">
            Portfolio burn (live){' '}
            <span className="ml-1 font-mono text-lg font-bold text-cost" data-testid="live-portfolio-burn">
              {formatUSD(view.totalLiveUsd)}
            </span>
            <span className="ml-2 text-dim">· {report.window}</span>
          </p>
          <p className="font-mono text-xs text-dim" data-testid="live-session-line">
            session {clockLabel(elapsedSeconds)} · +{formatCents(view.totalAccruedUsd)} · +
            {formatTokens(view.totalAccruedTokensIn)} tok in / +
            {formatTokens(view.totalAccruedTokensOut)} tok out
          </p>
        </div>
      </div>

      {/* Dynamic charts — rolling accrual curve + per-row spend bars. */}
      <div className="rounded-card border border-edge bg-slab p-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-sub">
          Spend accrual — trailing 60s (replayed)
        </p>
        <LiveAccrualCurve series={curve} />
      </div>
      <div className="rounded-card border border-edge bg-slab p-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-sub">Live share of burn</p>
        <LiveSpendBars rows={view.rows} />
      </div>

      {/* Live leaderboard — ranks re-order via layout animation when rates overtake. */}
      <ol className="space-y-3">
        {view.rows.map((row) => (
          <motion.li
            key={`${row.base.dimension}:${row.base.key}`}
            layout
            transition={{ layout: { duration: 0.5, ease: 'easeOut' } }}
          >
            <LiveLeaderboardRow row={row} rate={rateByKey.get(`${row.base.dimension}:${row.base.key}`)!} />
          </motion.li>
        ))}
      </ol>
    </div>
  );
}
