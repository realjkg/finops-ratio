// Live cost accrual — pure deterministic math over the attribution seeds.
//
// The demo shows costs running in real time, but no rate is invented: each
// team/user burn rate is derived from the SAME seeds the report ranks (MTD
// token volumes ÷ the MTD window; USD from registry pricing × those token
// rates, or the sampled log's own query_cost). The wall clock is the only new
// input, and every ticked number traces to seed × elapsed — no random walk,
// no drift, byte-identical on every reload (the DEMO_NOW pattern: the clock is
// injectable, passed in as `elapsedWallSeconds`, never read inside this file).
//
// Replay speed: seeded rates are real-world magnitudes (cents per second), so
// watching them at 1× looks frozen. ACCRUAL_REPLAY_SPEED scales the CLOCK —
// one wall second replays N seeded seconds — and is stated on the page chip.
// It never touches the rates themselves.

import type { AttributionDimension, AttributionReport, AttributionRow } from './AttributionClient';
import { DEMO_NOW } from '@/data/workloads';
import { findModel } from '@/data/models';
import type { AgentQuery, Workload } from '@/types';

/**
 * Display-speed multiplier on the clock: 1 wall-clock second replays this many
 * seeded seconds of burn (one seeded minute per second). Surfaced on the
 * honesty chip so the motion is never mistaken for live ingest.
 */
export const ACCRUAL_REPLAY_SPEED = 60;

/** Seconds elapsed in the month-to-date demo window (month start → DEMO_NOW). */
export const MTD_WINDOW_SECONDS: number =
  (DEMO_NOW.getTime() - Date.UTC(DEMO_NOW.getUTCFullYear(), DEMO_NOW.getUTCMonth(), 1)) / 1000;

// ---------------------------------------------------------------------------
// Burn rates
// ---------------------------------------------------------------------------

/**
 * A seeded burn rate for one leaderboard row. All three figures are per
 * SEEDED second — multiply by elapsed × ACCRUAL_REPLAY_SPEED to accrue.
 * `basis` states the working in the tokenomics-honesty style.
 */
export interface BurnRate {
  dimension: AttributionDimension;
  key: string;
  tokensInPerSecond: number;
  tokensOutPerSecond: number;
  usdPerSecond: number;
  basis: string;
}

/** Σ a field over records — 0 over an empty list (aggregations precedent). */
function sum(records: readonly number[]): number {
  return records.reduce((acc, v) => acc + v, 0);
}

/**
 * Team burn rates from the workload seed: token rates are the team's MTD
 * token volumes ÷ the MTD window; the USD rate is registry list pricing ×
 * those token rates, summed over the team's member workloads. Derived from
 * pricing (not stored monthly_spend, which folds in cached discounts and
 * compute overhead) — exactly the brief's "registry pricing × seeded query
 * rates", and the basis line on every live row says so.
 */
export function teamBurnRates(workloads: readonly Workload[]): BurnRate[] {
  const byTeam = new Map<string, Workload[]>();
  for (const w of workloads) {
    const group = byTeam.get(w.team) ?? [];
    group.push(w);
    byTeam.set(w.team, group);
  }

  return [...byTeam.entries()]
    .map(([team, group]) => {
      const tokensInPerSecond = sum(group.map((w) => w.costs.tokens_in_mtd)) / MTD_WINDOW_SECONDS;
      const tokensOutPerSecond = sum(group.map((w) => w.costs.tokens_out_mtd)) / MTD_WINDOW_SECONDS;

      // USD/s = Σ (tokensIn/s × input $/token + tokensOut/s × output $/token)
      // at each member workload's registry pricing. A missing model is a seed
      // error — thrown loudly (the userQueries seed precedent), never defaulted.
      let usdPerSecond = 0;
      for (const w of group) {
        const model = findModel(w.model);
        if (!model) throw new Error(`Unknown model in accrual seed for workload: ${w.id}`);
        usdPerSecond +=
          (w.costs.tokens_in_mtd / MTD_WINDOW_SECONDS) * (model.pricing.input_per_1m / 1_000_000) +
          (w.costs.tokens_out_mtd / MTD_WINDOW_SECONDS) * (model.pricing.output_per_1m / 1_000_000);
      }

      return {
        dimension: 'team' as const,
        key: team,
        tokensInPerSecond,
        tokensOutPerSecond,
        usdPerSecond,
        basis:
          `tokensIn/s = Σ tokens_in_mtd ÷ MTD window (${Math.round(MTD_WINDOW_SECONDS)} s); ` +
          `usd/s = Σ (tokensIn/s × input $/tok + tokensOut/s × output $/tok) at registry list pricing`,
      };
    });
}

/**
 * User burn rates from the sampled query log. Token rates = the user's MTD
 * event tokens ÷ the MTD window; the USD rate = the user's MTD Σ query_cost ÷
 * the same window — query_cost already derives from the referenced workload's
 * registry pricing (userQueries seed), so this is pricing × seeded query rates.
 */
export function userBurnRates(events: readonly AgentQuery[]): BurnRate[] {
  const byUser = new Map<string, AgentQuery[]>();
  for (const e of events) {
    const group = byUser.get(e.user_id) ?? [];
    group.push(e);
    byUser.set(e.user_id, group);
  }

  return [...byUser.entries()].map(([userId, group]) => {
    const tokensInPerSecond = sum(group.map((e) => e.tokens_used.input)) / MTD_WINDOW_SECONDS;
    const tokensOutPerSecond = sum(group.map((e) => e.tokens_used.output)) / MTD_WINDOW_SECONDS;
    const usdPerSecond = sum(group.map((e) => e.query_cost)) / MTD_WINDOW_SECONDS;
    return {
      dimension: 'user' as const,
      key: userId,
      tokensInPerSecond,
      tokensOutPerSecond,
      usdPerSecond,
      basis:
        `tokensIn/s = Σ tokens_used ÷ MTD window (${Math.round(MTD_WINDOW_SECONDS)} s); ` +
        `usd/s = Σ query_cost ÷ MTD window (query_cost derives from the referenced workload's registry pricing)`,
    };
  });
}

/** Portfolio USD rate per seeded second — the accrual curve's slope. */
export function totalUsdPerSecond(rates: readonly BurnRate[]): number {
  return sum(rates.map((r) => r.usdPerSecond));
}

// ---------------------------------------------------------------------------
// Accrual + live view
// ---------------------------------------------------------------------------

/** What one row accrues over `elapsedWallSeconds` of visible wall time. */
export interface AccruedDelta {
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

/** Seeded rate × elapsed, exactly. Monotonic, deterministic, no randomness. */
export function accruedAt(rate: BurnRate, elapsedWallSeconds: number): AccruedDelta {
  const demoSeconds = clampElapsed(elapsedWallSeconds) * ACCRUAL_REPLAY_SPEED;
  return {
    tokensIn: rate.tokensInPerSecond * demoSeconds,
    tokensOut: rate.tokensOutPerSecond * demoSeconds,
    usd: rate.usdPerSecond * demoSeconds,
  };
}

/** Negative or non-finite clocks accrue nothing (the calculations.ts guard). */
function clampElapsed(elapsedWallSeconds: number): number {
  if (!Number.isFinite(elapsedWallSeconds) || elapsedWallSeconds < 0) return 0;
  return elapsedWallSeconds;
}

/** One leaderboard row with its live accrual layered on the stored base. */
export interface LiveAttributionRow {
  /** The stored report row — ranking basis, formulas, and basis text. */
  base: AttributionRow;
  rank: number;
  accrued: AccruedDelta;
  liveInferenceCost: number;
  liveTokensIn: number;
  liveTokensOut: number;
  /** liveInferenceCost ÷ live total, guarded to 0 when the total is 0. */
  liveShareOfTotal: number;
}

export interface LiveAttributionView {
  /** Sorted by live inference cost descending (worst burner first), key ascending as tiebreak. */
  rows: LiveAttributionRow[];
  totalBaseUsd: number;
  totalAccruedUsd: number;
  totalLiveUsd: number;
  totalAccruedTokensIn: number;
  totalAccruedTokensOut: number;
  elapsedSeconds: number;
}

/**
 * Layer live accrual over a stored report and re-rank. Pure: same report,
 * rates, and elapsed → identical view, so ranks flip only when the seeded
 * rates actually overtake each other.
 *
 * Every report row must have a rate (both come from the same seeds); a
 * mismatch is a wiring bug and throws rather than silently freezing a row.
 */
export function liveAttributionView(
  report: AttributionReport,
  rates: readonly BurnRate[],
  elapsedWallSeconds: number,
): LiveAttributionView {
  const rateByKey = new Map(rates.map((r) => [`${r.dimension}:${r.key}`, r] as const));

  const unsorted = report.rows.map((base) => {
    const rate = rateByKey.get(`${base.dimension}:${base.key}`);
    if (!rate) throw new Error(`No accrual rate for report row: ${base.dimension}:${base.key}`);
    const accrued = accruedAt(rate, elapsedWallSeconds);
    return { base, accrued } as const;
  });

  const totalAccruedUsd = sum(unsorted.map((r) => r.accrued.usd));
  const totalBaseUsd = sum(unsorted.map((r) => r.base.inferenceCost));
  const totalLiveUsd = totalBaseUsd + totalAccruedUsd;

  const rows: LiveAttributionRow[] = unsorted
    .map(({ base, accrued }) => ({
      base,
      rank: 0,
      accrued,
      liveInferenceCost: base.inferenceCost + accrued.usd,
      liveTokensIn: base.tokensIn + accrued.tokensIn,
      liveTokensOut: base.tokensOut + accrued.tokensOut,
      liveShareOfTotal: totalLiveUsd === 0 ? 0 : (base.inferenceCost + accrued.usd) / totalLiveUsd,
    }))
    .sort(
      (a, b) =>
        b.liveInferenceCost - a.liveInferenceCost ||
        (a.base.key < b.base.key ? -1 : a.base.key > b.base.key ? 1 : 0),
    )
    .map((row, i) => ({ ...row, rank: i + 1 }));

  return {
    rows,
    totalBaseUsd,
    totalAccruedUsd,
    totalLiveUsd,
    totalAccruedTokensIn: sum(unsorted.map((r) => r.accrued.tokensIn)),
    totalAccruedTokensOut: sum(unsorted.map((r) => r.accrued.tokensOut)),
    elapsedSeconds: clampElapsed(elapsedWallSeconds),
  };
}

// ---------------------------------------------------------------------------
// Rolling accrual curve — chart data derivation
// ---------------------------------------------------------------------------

export interface AccrualCurvePoint {
  /** Seconds of session elapsed at this sample. */
  tSeconds: number;
  /** Accrued USD at that sample. */
  usd: number;
}

/**
 * The rolling spend-accrual curve, derived — not buffered. The curve of a
 * linear accrual is fully determined by the rate and the current elapsed, so
 * each render recomputes `points` samples across the trailing window. No
 * history state, no drift after a hidden-tab pause.
 */
export function spendAccrualCurve(args: {
  usdPerSecond: number;
  elapsedWallSeconds: number;
  /** Samples across the window (default 60 → one per second on the default window). */
  points?: number;
  /** Trailing window length in wall seconds (default 60). */
  windowSeconds?: number;
}): AccrualCurvePoint[] {
  const points = Math.max(1, Math.floor(args.points ?? 60));
  const windowSeconds = Math.max(0, args.windowSeconds ?? 60);
  const elapsed = clampElapsed(args.elapsedWallSeconds);

  const out: AccrualCurvePoint[] = [];
  for (let i = 0; i < points; i++) {
    // A single sample sits at `elapsed` (the current value); otherwise spread
    // evenly across the trailing window, clamped to the session start.
    const span = points === 1 ? windowSeconds : (windowSeconds * i) / (points - 1);
    const t = Math.max(0, elapsed - windowSeconds + span);
    out.push({ tSeconds: t, usd: args.usdPerSecond * t * ACCRUAL_REPLAY_SPEED });
  }
  return out;
}
