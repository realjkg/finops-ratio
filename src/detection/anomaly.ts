// detectAnomalies: fleet anomaly detection over daily series (checklist 2.2, 2.3).
//
// Trust boundary: series and config are untrusted and validated; the as-of day
// is an explicit UTC day (the last COMPLETE day, see lastCompleteDay); nothing
// here reads a clock. Findings are partitioned by tenant and currency and never
// merge across either: the caller should still pass only the authenticated
// tenant's series. Errors are fixed text.
//
// Pipeline:
//   1. Roll series up into leaves (tenant, currency, account, service).
//   2. Score every leaf (candidates.ts): expected-vs-actual, novelty,
//      reactivation. A leaf with a novelty candidate suppresses its statistical
//      candidate (one root cause, one finding; design precedence D4 before D1/D2).
//   3. Group candidates hierarchically, broadest first, within one
//      (tenant, currency, direction, source) bucket:
//        tenant-wide: >= max(groupMinMembers + 2, tenantFanInShare of scored
//                     leaves) distinct leaves
//        service:     >= groupMinMembers distinct accounts with the same service
//        account:     >= groupMinMembers distinct services in one account
//        leaf / region: anything left
//      Each candidate belongs to exactly one group.
//   4. Assemble findings: group totals, severity (the highest of every member's
//      own severity and the group-level matrix evaluation), up to 10 ranked
//      contributors by excess, and a stable dedup key for the lifecycle reducer.

import { formatDay, parseDay } from './dates';
import {
  buildLeaves,
  contributorRows,
  scoreLeaf,
  type AnomalyCategory,
  type Candidate,
  type CandidateSource,
  type ContributorRow,
  type SkipReason,
} from './candidates';
import { classifySeverity, maxSeverity, relativeDeviation, resolveConfig, severityRank, type AnomalyConfig, type ResolvedConfig } from './severity';
import { sum } from './stats';
import { DetectionError, LIMITS, compareStrings, round4, round6, type DailySeries, type Severity } from './types';

export type { AnomalyCategory, AnomalyConfig, CandidateSource };

export type FindingScope = 'tenant' | 'service' | 'account' | 'leaf' | 'region';

export interface Contributor {
  readonly account: string;
  readonly service: string;
  readonly region: string;
  readonly actual: number;
  readonly expected: number;
  readonly excess: number;
  /** Share of the finding's total positive (direction-aligned) excess, 4 decimals. */
  readonly share: number;
}

export interface Finding {
  /** Stable dedup key: the same root cause maps to the same key on every day. */
  readonly key: string;
  readonly scope: FindingScope;
  readonly scopeKey: string;
  readonly tenant: string;
  readonly currency: string;
  readonly source: CandidateSource;
  readonly category: AnomalyCategory;
  readonly direction: 'up' | 'down';
  readonly severity: Severity;
  readonly startDay: string;
  readonly lastDay: string;
  /** Longest evidence window among the members, in days. */
  readonly windowDays: number;
  readonly actual: number;
  readonly expected: number;
  /** Excess over the evidence windows (sum over members). Signed: negative for drops. */
  readonly impact: number;
  /** Sum of the members' mean daily excess. */
  readonly meanDailyExcess: number;
  /** Relative deviation, or null when unbounded (expected zero or less). */
  readonly relative: number | null;
  /** Excess on the as-of day alone (used by the lifecycle's cumulative total). */
  readonly todayExcess: number;
  readonly minImpact: number;
  /** Cumulative impact at which the lifecycle escalates to critical. */
  readonly cumulativeCriticalImpact: number;
  readonly detectors: readonly string[];
  readonly memberCount: number;
  readonly memberKeys: readonly string[];
  readonly memberKeysTruncated: boolean;
  readonly contributors: readonly Contributor[];
  readonly otherExcess: number;
  readonly otherCount: number;
  /** True when any member has fewer than 56 observed days. */
  readonly estimated: boolean;
}

export interface AnomalyStats {
  readonly seriesIn: number;
  readonly leaves: number;
  readonly scoredLeaves: number;
  readonly skipped: Readonly<Record<SkipReason, number>>;
  readonly candidates: number;
  readonly findings: number;
  readonly droppedFindings: number;
}

export interface AnomalyResult {
  readonly asOf: string;
  readonly findings: readonly Finding[];
  readonly truncated: boolean;
  readonly stats: AnomalyStats;
}

const CATEGORY_PRIORITY: readonly AnomalyCategory[] = [
  'level_shift',
  'gradual_drift',
  'spend_spike',
  'new_service',
  'new_region',
  'reactivation',
  'spend_drop',
];

interface Group {
  readonly scope: FindingScope;
  readonly scopeKey: string;
  readonly members: Candidate[];
}

function bucketKey(c: Candidate): string {
  return `${c.leaf.key.tenant}|${c.leaf.key.currency}|${c.direction}|${c.source}`;
}

function sortCandidates(list: Candidate[]): Candidate[] {
  return list.sort(
    (a, b) =>
      compareStrings(a.leaf.key.account, b.leaf.key.account) ||
      compareStrings(a.leaf.key.service, b.leaf.key.service) ||
      compareStrings(a.memberKey, b.memberKey),
  );
}

function distinct(list: readonly Candidate[], pick: (c: Candidate) => string): number {
  return new Set(list.map(pick)).size;
}

function groupBucket(bucket: Candidate[], scoredLeaves: number, cfg: ResolvedConfig): Group[] {
  const groups: Group[] = [];
  let rest = sortCandidates(bucket.slice());
  const tenantMin = Math.max(cfg.groupMinMembers + 2, Math.ceil(cfg.tenantFanInShare * scoredLeaves));
  if (distinct(rest, (c) => c.leaf.id) >= tenantMin) {
    groups.push({ scope: 'tenant', scopeKey: '*', members: rest });
    return groups;
  }
  const services = Array.from(new Set(rest.map((c) => c.leaf.key.service))).sort(compareStrings);
  for (const service of services) {
    const members = rest.filter((c) => c.leaf.key.service === service);
    if (distinct(members, (c) => c.leaf.key.account) >= cfg.groupMinMembers) {
      groups.push({ scope: 'service', scopeKey: service, members });
      const claimed = new Set(members);
      rest = rest.filter((c) => !claimed.has(c));
    }
  }
  const accounts = Array.from(new Set(rest.map((c) => c.leaf.key.account))).sort(compareStrings);
  for (const account of accounts) {
    const members = rest.filter((c) => c.leaf.key.account === account);
    if (distinct(members, (c) => c.leaf.id) >= cfg.groupMinMembers) {
      groups.push({ scope: 'account', scopeKey: account, members });
      const claimed = new Set(members);
      rest = rest.filter((c) => !claimed.has(c));
    }
  }
  for (const c of rest) {
    groups.push(
      c.region === null
        ? { scope: 'leaf', scopeKey: `${c.leaf.key.account}|${c.leaf.key.service}`, members: [c] }
        : { scope: 'region', scopeKey: `${c.leaf.key.account}|${c.leaf.key.service}|${c.region}`, members: [c] },
    );
  }
  return groups;
}

function pickCategory(members: readonly Candidate[]): AnomalyCategory {
  const counts = new Map<AnomalyCategory, number>();
  for (const m of members) counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
  let best: AnomalyCategory = members[0]?.category ?? 'spend_spike';
  let bestCount = -1;
  for (const cat of CATEGORY_PRIORITY) {
    const n = counts.get(cat) ?? 0;
    if (n > bestCount && n > 0) {
      best = cat;
      bestCount = n;
    }
  }
  return best;
}

function assemble(group: Group, asOfDn: number, cfg: ResolvedConfig): Finding {
  const members = group.members;
  const first = members[0] as Candidate;
  const direction = first.direction;
  const minImpact = first.minImpact;

  const actual = sum(members.map((m) => m.actual));
  const expected = sum(members.map((m) => m.expected));
  const impact = sum(members.map((m) => m.impact));
  const meanDaily = sum(members.map((m) => m.meanExcess));
  const expectedPerDay = sum(members.map((m) => m.expected / m.windowDays));

  let severity: Severity = 'info';
  for (const m of members) severity = maxSeverity(severity, m.severity);
  severity = maxSeverity(
    severity,
    first.source === 'reactivation' && members.length === 1
      ? members[0]?.severity ?? 'info'
      : classifySeverity(
          { direction, meanExcess: meanDaily, expectedSum: expectedPerDay, cumulativeImpact: impact, windowDays: 1 },
          cfg,
          minImpact,
        ),
  );
  if (direction === 'down') severity = 'info';

  // Contributors: region-level rows across members, ranked by direction-aligned excess.
  const rows: ContributorRow[] = [];
  for (const m of members) rows.push(...contributorRows(m));
  const sign = direction === 'up' ? 1 : -1;
  rows.sort(
    (a, b) =>
      sign * (b.excess - a.excess) ||
      compareStrings(a.account, b.account) ||
      compareStrings(a.service, b.service) ||
      compareStrings(a.region, b.region),
  );
  const positive = rows.filter((r) => sign * r.excess > 0);
  const totalPositive = sum(positive.map((r) => sign * r.excess));
  const top = positive.slice(0, LIMITS.maxContributors);
  const contributors: Contributor[] = top.map((r) => ({
    ...r,
    share: totalPositive > 0 ? round4((sign * r.excess) / totalPositive) : 0,
  }));
  const otherExcess = round6(sum(positive.slice(LIMITS.maxContributors).map((r) => r.excess)));

  const memberKeys = members.map((m) => m.memberKey).sort(compareStrings);
  const scopeText = `${group.scope}|${first.leaf.key.tenant}|${first.leaf.key.currency}|${group.scopeKey}|${direction}|${first.source}`;
  return {
    key: scopeText,
    scope: group.scope,
    scopeKey: group.scopeKey,
    tenant: first.leaf.key.tenant,
    currency: first.leaf.key.currency,
    source: first.source,
    category: pickCategory(members),
    direction,
    severity,
    startDay: formatDay(Math.min(...members.map((m) => m.startDn))),
    lastDay: formatDay(asOfDn),
    windowDays: Math.max(...members.map((m) => m.windowDays)),
    actual: round6(actual),
    expected: round6(expected),
    impact: round6(impact),
    meanDailyExcess: round6(meanDaily),
    relative: ((): number | null => {
      const r = relativeDeviation(meanDaily, expectedPerDay, 1);
      return r === null ? null : round6(r);
    })(),
    todayExcess: round6(sum(members.map((m) => m.todayExcess))),
    minImpact,
    cumulativeCriticalImpact: round6(cfg.cumulativeCriticalMultiple * minImpact),
    detectors: Array.from(new Set(members.map((m) => m.detector))).sort(compareStrings),
    memberCount: members.length,
    memberKeys: memberKeys.slice(0, LIMITS.maxMemberKeys),
    memberKeysTruncated: memberKeys.length > LIMITS.maxMemberKeys,
    contributors,
    otherExcess,
    otherCount: Math.max(0, positive.length - LIMITS.maxContributors),
    estimated: members.some((m) => m.estimated),
  };
}

/** Detects anomalies on the as-of UTC day (the last complete day). */
export function detectAnomalies(
  seriesList: readonly DailySeries[],
  asOf: string,
  config?: AnomalyConfig,
): AnomalyResult {
  const asOfDn = parseDay(asOf);
  const cfg = resolveConfig(config);
  if (!Array.isArray(seriesList)) throw new DetectionError('SERIES_INVALID');
  if (seriesList.length > LIMITS.maxSeries) throw new DetectionError('SERIES_CAP_EXCEEDED');

  const leaves = buildLeaves(seriesList);
  const skipped: Record<SkipReason, number> = { insufficient_history: 0, no_data_asof: 0, intermittent: 0, no_min_impact: 0 };
  const candidates: Candidate[] = [];
  const scoredByBucket = new Map<string, number>();
  let scoredLeaves = 0;
  for (const leaf of leaves) {
    const outcome = scoreLeaf(leaf, asOfDn, cfg);
    if (outcome.skipped !== null) {
      skipped[outcome.skipped] += 1;
      continue;
    }
    scoredLeaves += 1;
    const tc = `${leaf.key.tenant}|${leaf.key.currency}`;
    scoredByBucket.set(tc, (scoredByBucket.get(tc) ?? 0) + 1);
    candidates.push(...outcome.candidates);
  }

  const buckets = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = bucketKey(c);
    const list = buckets.get(k);
    if (list === undefined) buckets.set(k, [c]);
    else list.push(c);
  }
  const findings: Finding[] = [];
  for (const k of Array.from(buckets.keys()).sort(compareStrings)) {
    const list = buckets.get(k) as Candidate[];
    const first = list[0] as Candidate;
    const scored = scoredByBucket.get(`${first.leaf.key.tenant}|${first.leaf.key.currency}`) ?? 0;
    for (const g of groupBucket(list, scored, cfg)) findings.push(assemble(g, asOfDn, cfg));
  }

  findings.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      Math.abs(b.impact) - Math.abs(a.impact) ||
      compareStrings(a.key, b.key),
  );
  const kept = findings.slice(0, cfg.maxFindings);
  return {
    asOf: formatDay(asOfDn),
    findings: kept,
    truncated: findings.length > kept.length,
    stats: {
      seriesIn: seriesList.length,
      leaves: leaves.length,
      scoredLeaves,
      skipped,
      candidates: candidates.length,
      findings: kept.length,
      droppedFindings: findings.length - kept.length,
    },
  };
}
