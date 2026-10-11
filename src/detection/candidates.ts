// Per-leaf anomaly candidates: expected-versus-actual scoring, dimension
// novelty, dormant reactivation, and region-level contributors.
//
// A "leaf" is one (tenant, currency, account, service); regions are summed
// into it (design 3.1) and kept separately only for contributors and for new
// region detection. Pure and deterministic; callers validate the as-of day.
//
// Statistical detector (documented subset of design 4.2; deviations in README):
//   For each window length k in {1, 3, 7} days a baseline model is FROZEN at
//   the anchor day (asOf - k): fit on data up to the anchor only, so the days
//   under test cannot teach the model. Each window day gets an expected value
//   and a noise scale sigma_j = max(1.2 * model sigma * weekday factor,
//   2 percent of expected, minImpact / 20): the floors keep a constant series
//   from producing an infinite z. The window statistic is the MEDIAN residual
//   (robust to one huge day) divided by its standard error, which includes the
//   forecast's own level error (0.42 sigma, design 4.2).
//     k = 1 fires when z >= zT AND the actual is above the 95 percent bound of
//           the empirical interval (design D1 and D2 together).
//     k = 3 fires when z >= zT and all 3 residuals are positive.
//     k = 7 fires when z >= zT and at least 85 percent of residuals are positive.
//   The triggered window with the largest z becomes the candidate.
//   Decreases use the same tests without the interval bound and are info only.

import { formatDay, weekdayOf } from './dates';
import { MODEL, boundsFor, calibrate, fitModel, predictAt, scaleOf, type Fit, type Obs } from './model';
import { classifySeverity, relativeDeviation, type ResolvedConfig } from './severity';
import { viewSeries } from './series';
import { mean, median, sum } from './stats';
import { DetectionError, round6, type DailySeries, type Severity } from './types';

export interface LeafKey {
  readonly tenant: string;
  readonly currency: string;
  readonly account: string;
  readonly service: string;
}

export interface RegionData {
  readonly region: string;
  readonly dns: readonly number[];
  readonly values: readonly number[];
}

export interface Leaf {
  readonly id: string;
  readonly key: LeafKey;
  readonly dns: readonly number[];
  readonly values: readonly number[];
  readonly regions: readonly RegionData[];
  readonly firstDn: number;
  /** Earliest day any series of the same (tenant, currency, account) was seen. */
  readonly accountFirstDn: number;
}

export type AnomalyCategory =
  | 'spend_spike'
  | 'level_shift'
  | 'gradual_drift'
  | 'new_service'
  | 'new_region'
  | 'reactivation'
  | 'spend_drop';

export type CandidateSource = 'statistical' | 'novelty' | 'reactivation';

export type SkipReason = 'insufficient_history' | 'no_data_asof' | 'intermittent' | 'no_min_impact';

export interface Candidate {
  readonly leaf: Leaf;
  /** Leaf id, or leaf id + '|' + region for a new-region candidate. */
  readonly memberKey: string;
  readonly region: string | null;
  readonly source: CandidateSource;
  readonly direction: 'up' | 'down';
  readonly category: AnomalyCategory;
  readonly detector: string;
  readonly windowDays: number;
  readonly windowDns: readonly number[];
  /** Day the baseline was frozen at; null for novelty (no baseline). */
  readonly anchorDn: number | null;
  readonly actual: number;
  readonly expected: number;
  readonly impact: number;
  readonly meanExcess: number;
  readonly relative: number | null;
  readonly z: number | null;
  readonly todayExcess: number;
  readonly severity: Severity;
  readonly minImpact: number;
  readonly estimated: boolean;
  readonly startDn: number;
}

export interface LeafOutcome {
  readonly candidates: readonly Candidate[];
  readonly skipped: SkipReason | null;
}

export function leafIdOf(key: LeafKey): string {
  return `${key.tenant}|${key.currency}|${key.account}|${key.service}`;
}

/** Validates series and rolls them up into leaves (regions summed). */
export function buildLeaves(seriesList: readonly DailySeries[]): Leaf[] {
  const seen = new Set<string>();
  const groups = new Map<string, { key: LeafKey; regions: RegionData[] }>();
  for (let i = 0; i < seriesList.length; i += 1) {
    const s = seriesList[i] as DailySeries;
    const view = viewSeries(s, i);
    if (seen.has(s.id)) throw new DetectionError('SERIES_INVALID', i);
    seen.add(s.id);
    if (view.dns.length === 0) continue;
    const key: LeafKey = {
      tenant: s.key.tenant,
      currency: s.key.currency,
      account: s.key.account,
      service: s.key.service,
    };
    const id = leafIdOf(key);
    let g = groups.get(id);
    if (g === undefined) {
      g = { key, regions: [] };
      groups.set(id, g);
    }
    g.regions.push({ region: s.key.region, dns: view.dns, values: view.values });
  }
  const accountFirst = new Map<string, number>();
  const built: Omit<Leaf, 'accountFirstDn'>[] = [];
  for (const id of Array.from(groups.keys()).sort()) {
    const g = groups.get(id) as { key: LeafKey; regions: RegionData[] };
    const parts = new Map<number, number[]>();
    for (const r of g.regions) {
      for (let i = 0; i < r.dns.length; i += 1) {
        const dn = r.dns[i] as number;
        const list = parts.get(dn);
        if (list === undefined) parts.set(dn, [r.values[i] as number]);
        else list.push(r.values[i] as number);
      }
    }
    const dns = Array.from(parts.keys()).sort((a, b) => a - b);
    const values = dns.map((dn) => round6(sum(parts.get(dn) as number[])));
    const regions = g.regions.slice().sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
    const firstDn = dns[0] as number;
    const accountKey = `${g.key.tenant}|${g.key.currency}|${g.key.account}`;
    const prior = accountFirst.get(accountKey);
    if (prior === undefined || firstDn < prior) accountFirst.set(accountKey, firstDn);
    built.push({ id, key: g.key, dns, values, regions, firstDn });
  }
  return built.map((b) => ({
    ...b,
    accountFirstDn: accountFirst.get(`${b.key.tenant}|${b.key.currency}|${b.key.account}`) as number,
  }));
}

const WINDOWS: readonly { k: number; need: number; share: number }[] = [
  { k: 1, need: 1, share: 0 },
  { k: 3, need: 2, share: 1 },
  { k: 7, need: 5, share: 0.85 },
];

function obsOf(dns: readonly number[], values: readonly number[], throughDn: number): Obs[] {
  const out: Obs[] = [];
  for (let i = 0; i < dns.length; i += 1) {
    const dn = dns[i] as number;
    if (dn > throughDn) break;
    out.push({ dn, v: values[i] as number });
  }
  return out;
}

interface Scored {
  readonly k: number;
  readonly z: number;
  readonly days: readonly Obs[];
  readonly expected: readonly number[];
  readonly residuals: readonly number[];
  readonly anchorDn: number;
  readonly fit: Fit;
}

function scoreWindow(
  all: readonly Obs[],
  asOfDn: number,
  spec: { k: number; need: number; share: number },
  minImpact: number,
  cfg: ResolvedConfig,
): Scored | null {
  const anchorDn = asOfDn - spec.k;
  const history = all.filter((o) => o.dn <= anchorDn);
  const fit = fitModel(history);
  if (fit === null) return null;
  const days = all.filter((o) => o.dn > anchorDn);
  const n = days.length;
  if (n < spec.need) return null;
  const expected = days.map((o) => predictAt(fit, o.dn));
  const residuals = days.map((o, i) => o.v - (expected[i] as number));
  const sigmas = days.map((o, i) =>
    Math.max(
      fit.sigma * MODEL.sigmaInflation * (fit.factors[weekdayOf(o.dn)] as number),
      0.02 * (expected[i] as number),
      minImpact / 20,
    ),
  );
  // Variance per day: noise plus the error of the estimated weekday factor
  // (about 1.34 sigma / sqrt(ratios behind it); zero when the factors are flat).
  const variances = days.map((o, i) => {
    const n = fit.factorCounts[weekdayOf(o.dn)] as number;
    const factorTerm = fit.weekdayAdjusted ? 1.8 / Math.max(n, 2) : 0;
    return (sigmas[i] as number) ** 2 * (1 + factorTerm);
  });
  const sigmaMean = mean(sigmas);
  const medianFactor = n === 1 ? 1 : 1.2533;
  // The noise scale itself is estimated from few residuals: a t-like widening.
  const tWiden = 1 + 1.5 / Math.sqrt(fit.levelCount);
  const sd = tWiden * Math.sqrt((medianFactor ** 2 * mean(variances)) / n + (0.42 * sigmaMean) ** 2);
  const z = median(residuals) / sd;
  // Sign consistency (windows longer than one day).
  const up = z > 0;
  const agreeing = residuals.filter((r) => (up ? r > 0 : r < 0)).length;
  if (Math.abs(z) >= cfg.zThreshold && agreeing < Math.ceil(spec.share * n)) return null;
  return { k: spec.k, z, days, expected, residuals, anchorDn, fit };
}

function shapeOf(residuals: readonly number[], k: number, direction: 'up' | 'down'): AnomalyCategory {
  if (direction === 'down') return 'spend_drop';
  if (k === 1) return 'spend_spike';
  const peak = Math.max(...residuals);
  const plateau = residuals.filter((r) => r >= 0.8 * peak).length / residuals.length;
  return plateau >= 0.5 ? 'level_shift' : 'gradual_drift';
}

function build(
  leaf: Leaf,
  cfg: ResolvedConfig,
  minImpact: number,
  parts: {
    memberKey: string;
    region: string | null;
    source: CandidateSource;
    direction: 'up' | 'down';
    category: AnomalyCategory;
    detector: string;
    dns: readonly number[];
    actual: readonly number[];
    expected: readonly number[];
    anchorDn: number | null;
    z: number | null;
    startDn: number;
    severityOverride?: Severity;
  },
): Candidate {
  const n = parts.dns.length;
  const actual = sum(parts.actual);
  const expected = sum(parts.expected);
  const impact = actual - expected;
  const meanExcess = impact / n;
  const severity =
    parts.severityOverride ??
    classifySeverity(
      { direction: parts.direction, meanExcess, expectedSum: expected, cumulativeImpact: impact, windowDays: n },
      cfg,
      minImpact,
    );
  return {
    leaf,
    memberKey: parts.memberKey,
    region: parts.region,
    source: parts.source,
    direction: parts.direction,
    category: parts.category,
    detector: parts.detector,
    windowDays: n,
    windowDns: parts.dns,
    anchorDn: parts.anchorDn,
    actual: round6(actual),
    expected: round6(expected),
    impact: round6(impact),
    meanExcess: round6(meanExcess),
    relative: ((): number | null => {
      const r = relativeDeviation(meanExcess, expected, n);
      return r === null ? null : round6(r);
    })(),
    z: parts.z === null ? null : round6(parts.z),
    todayExcess: round6((parts.actual[n - 1] as number) - (parts.expected[n - 1] as number)),
    severity,
    minImpact,
    estimated: leaf.dns.length < MODEL.fullHistoryDays,
    startDn: parts.startDn,
  };
}

/** Novelty candidates: a new service, or a new region of an established service. */
function noveltyCandidates(leaf: Leaf, asOfDn: number, cfg: ResolvedConfig, minImpact: number): Candidate[] {
  const out: Candidate[] = [];
  const warmup = cfg.minHistoryDays;
  const triggers = (dns: readonly number[], values: readonly number[], firstDn: number): boolean => {
    for (let i = 0; i < dns.length; i += 1) {
      const dn = dns[i] as number;
      if (dn > firstDn + 2) break;
      if (dn <= asOfDn && (values[i] as number) >= minImpact) return true;
    }
    return false;
  };
  const windowOf = (dns: readonly number[], values: readonly number[]): { d: number[]; v: number[] } => {
    const d: number[] = [];
    const v: number[] = [];
    for (let i = 0; i < dns.length; i += 1) {
      if ((dns[i] as number) > asOfDn) break;
      d.push(dns[i] as number);
      v.push(values[i] as number);
    }
    return { d, v };
  };
  const leafAgeDays = asOfDn - leaf.firstDn;
  const accountAgeAtFirst = leaf.firstDn - leaf.accountFirstDn;
  if (leafAgeDays < warmup && accountAgeAtFirst >= cfg.noveltyMinAccountAgeDays && triggers(leaf.dns, leaf.values, leaf.firstDn)) {
    const w = windowOf(leaf.dns, leaf.values);
    out.push(
      build(leaf, cfg, minImpact, {
        memberKey: leaf.id,
        region: null,
        source: 'novelty',
        direction: 'up',
        category: 'new_service',
        detector: 'novelty',
        dns: w.d,
        actual: w.v,
        expected: w.v.map(() => 0),
        anchorDn: null,
        z: null,
        startDn: leaf.firstDn,
      }),
    );
    return out;
  }
  // New region of an established service: the leaf already had history.
  for (const r of leaf.regions) {
    if (r.region === '') continue;
    const first = r.dns[0] as number;
    if (asOfDn - first >= warmup) continue;
    const established = leaf.dns.filter((dn) => dn < first).length >= warmup;
    if (!established) continue;
    if (first - leaf.accountFirstDn < cfg.noveltyMinAccountAgeDays) continue;
    if (!triggers(r.dns, r.values, first)) continue;
    const w = windowOf(r.dns, r.values);
    out.push(
      build(leaf, cfg, minImpact, {
        memberKey: `${leaf.id}|${r.region}`,
        region: r.region,
        source: 'novelty',
        direction: 'up',
        category: 'new_region',
        detector: 'novelty',
        dns: w.d,
        actual: w.v,
        expected: w.v.map(() => 0),
        anchorDn: null,
        z: null,
        startDn: first,
      }),
    );
  }
  return out;
}

export function scoreLeaf(leaf: Leaf, asOfDn: number, cfg: ResolvedConfig): LeafOutcome {
  const minImpact = cfg.minImpact[leaf.key.currency];
  if (minImpact === undefined) return { candidates: [], skipped: 'no_min_impact' };
  const all = obsOf(leaf.dns, leaf.values, asOfDn);
  if (all.length === 0 || (all[all.length - 1] as Obs).dn !== asOfDn) {
    return { candidates: [], skipped: 'no_data_asof' };
  }

  // Dimension novelty works from the first day, before any history exists.
  const novelty = noveltyCandidates(leaf, asOfDn, cfg, minImpact);
  if (novelty.length > 0) return { candidates: novelty, skipped: null };

  if (all.length < cfg.minHistoryDays) return { candidates: [], skipped: 'insufficient_history' };

  // Routing on the 56 days before the scored day (design 4.2): dormant series
  // go to the reactivation rule, intermittent series are not scored daily.
  const prior = all.filter((o) => o.dn >= asOfDn - 56 && o.dn < asOfDn);
  const positives = prior.filter((o) => o.v > 0).length;
  const today = all[all.length - 1] as Obs;
  if (positives < 3) {
    if (prior.length < cfg.minHistoryDays - 1 || today.v < minImpact) return { candidates: [], skipped: null };
    // Size override of design D4(b)(ii), simplified: only a restart of at least
    // criticalMultiple x the minimum impact may exceed info.
    const big = today.v >= cfg.criticalMultiple * minImpact;
    return {
      candidates: [
        build(leaf, cfg, minImpact, {
          memberKey: leaf.id,
          region: null,
          source: 'reactivation',
          direction: 'up',
          category: 'reactivation',
          detector: 'reactivation',
          dns: [today.dn],
          actual: [today.v],
          expected: [0],
          anchorDn: asOfDn - 1,
          z: null,
          startDn: today.dn,
          severityOverride: big ? undefined : 'info',
        }),
      ],
      skipped: null,
    };
  }
  const nonPositive = prior.filter((o) => o.v <= 0).length;
  if (prior.length > 0 && nonPositive / prior.length >= 0.3) return { candidates: [], skipped: 'intermittent' };

  let best: Scored | null = null;
  for (const spec of WINDOWS) {
    const s = scoreWindow(all, asOfDn, spec, minImpact, cfg);
    if (s === null || Math.abs(s.z) < cfg.zThreshold) continue;
    if (s.k === 1 && s.z > 0) {
      // D1: the actual must also lie above the empirical 95 percent bound.
      const history = all.filter((o) => o.dn <= s.anchorDn);
      const cal = calibrate(history);
      const bounds = boundsFor(s.fit, cal, s.expected[0] as number, today.dn);
      if (!(today.v > bounds.hi95)) continue;
      // Out-of-sample check: the in-sample noise estimate is optimistic, so the
      // residual must also clear zT against the rolling-origin error scale.
      if (cal.method === 'empirical') {
        const sd = Math.max(cal.sigma1 * scaleOf(s.fit), minImpact / 20);
        if (!((today.v - (s.expected[0] as number)) / sd >= cfg.zThreshold)) continue;
      }
    }
    if (best === null || Math.abs(s.z) > Math.abs(best.z)) best = s;
  }
  if (best === null) return { candidates: [], skipped: null };

  const direction: 'up' | 'down' = best.z > 0 ? 'up' : 'down';
  // Start of the run: walk back while each day still carries at least half of
  // the window's median excess, so noise days before a step are not counted.
  const sign = direction === 'up' ? 1 : -1;
  const floor = 0.5 * Math.abs(median(best.residuals));
  let startDn = (best.days[best.days.length - 1] as Obs).dn;
  for (let i = best.days.length - 1; i >= 0; i -= 1) {
    if (sign * (best.residuals[i] as number) >= floor) startDn = (best.days[i] as Obs).dn;
    else break;
  }
  return {
    candidates: [
      build(leaf, cfg, minImpact, {
        memberKey: leaf.id,
        region: null,
        source: 'statistical',
        direction,
        category: shapeOf(best.residuals, best.k, direction),
        detector: best.k === 1 ? 'residual_1d' : `window_${best.k}d`,
        dns: best.days.map((o) => o.dn),
        actual: best.days.map((o) => o.v),
        expected: best.expected,
        anchorDn: best.anchorDn,
        z: best.z,
        startDn,
      }),
    ],
    skipped: null,
  };
}

// ---------------------------------------------------------------------------
// Contributors (region-level rows)
// ---------------------------------------------------------------------------

export interface ContributorRow {
  readonly account: string;
  readonly service: string;
  readonly region: string;
  readonly actual: number;
  readonly expected: number;
  /** actual - expected over the candidate's window days. */
  readonly excess: number;
}

/** Region-level rows behind a candidate: the finest-grain dimensions of the leaf. */
export function contributorRows(c: Candidate): ContributorRow[] {
  const rows: ContributorRow[] = [];
  const regions = c.region === null ? c.leaf.regions : c.leaf.regions.filter((r) => r.region === c.region);
  for (const r of regions) {
    const byDn = new Map<number, number>();
    for (let i = 0; i < r.dns.length; i += 1) byDn.set(r.dns[i] as number, r.values[i] as number);
    const actualParts: number[] = [];
    const expectedParts: number[] = [];
    let fit: Fit | null = null;
    let fallback = 0;
    if (c.anchorDn !== null) {
      const history = obsOf(r.dns, r.values, c.anchorDn);
      fit = fitModel(history);
      fallback = history.length > 0 ? Math.max(0, mean(history.map((o) => o.v))) : 0;
    }
    for (const dn of c.windowDns) {
      actualParts.push(byDn.get(dn) ?? 0);
      expectedParts.push(c.anchorDn === null ? 0 : fit !== null ? predictAt(fit, dn) : fallback);
    }
    rows.push({
      account: c.leaf.key.account,
      service: c.leaf.key.service,
      region: r.region,
      actual: round6(sum(actualParts)),
      expected: round6(sum(expectedParts)),
      excess: round6(sum(actualParts) - sum(expectedParts)),
    });
  }
  return rows;
}

export function dayString(dn: number): string {
  return formatDay(dn);
}
