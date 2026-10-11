// reduceFindings: the open/resolve lifecycle for anomaly findings (checklist
// 2.3, design 4.6 subset).
//
// Pure reducer: (previous records, today's findings, asOf) -> next records plus
// the transition events. No clock, no I/O. The caller persists the records.
//
// Rules:
//  - Identity: one open record per finding key (scope + tenant + currency +
//    scope key + direction + source). Category is NOT part of the key, so a
//    spike that persists into a level shift stays one record (deviation from
//    the design's dedup key; README). The category is sticky: it can change
//    only from spend_spike to another category.
//  - Open: a finding with no open record opens a new one. Record id =
//    key@openedDay. A resolved record is never reopened; the same key later
//    opens a NEW record (design 4.5).
//  - Hysteresis (no flapping): an open record whose finding is absent stays
//    open until it has been unseen for `resolveAfterDays` (default 3) whole
//    days (asOf - lastSeenDay >= 3), then resolves as `auto_recovered`. A
//    finding that reappears earlier simply continues the same record, so a
//    series that flickers around its threshold produces one record, not many.
//  - Severity only goes up while a record is open. It is also raised to
//    critical when the cumulative impact (sum of each observed day's excess)
//    reaches the finding's cumulativeCriticalImpact (design 4.4 cumulative clause).
//  - Merge: an absent open record whose members are all inside a broader open
//    finding of the same tenant, currency, direction and source (account in
//    service in tenant) resolves as `merged` with a pointer to the survivor.
//    A survivor that is later merged re-points the records that pointed at it,
//    so pointers stay one level deep. Groups with truncated member lists never
//    merge (cannot be verified).
//  - Idempotent: applying the same (findings, asOf) twice yields identical
//    records and, the second time, no events. A day already counted is never
//    counted twice.
//  - Out-of-order: an asOf earlier than any record's lastSeenDay is refused.
//  - Bounds: resolved records are pruned `retainResolvedDays` (default 30)
//    after resolution unless a retained record points at them; more than
//    LIMITS.maxRecords records after pruning is refused.

import { formatDay, parseDay } from './dates';
import type { AnomalyCategory, Finding } from './anomaly';
import { maxSeverity, severityRank } from './severity';
import { DetectionError, LIMITS, compareStrings, isCurrency, isIdentifier, round6, type Severity } from './types';

export type RecordStatus = 'open' | 'resolved';
export type ResolveReason = 'auto_recovered' | 'merged';

export interface FindingRecord {
  readonly id: string;
  readonly key: string;
  readonly status: RecordStatus;
  readonly category: AnomalyCategory;
  readonly severity: Severity;
  readonly openedDay: string;
  readonly lastSeenDay: string;
  readonly daysObserved: number;
  /** Sum of the as-of-day excess over every distinct day the finding was seen. */
  readonly cumulativeImpact: number;
  readonly cumulativeCriticalImpact: number;
  readonly resolvedDay: string | null;
  readonly resolveReason: ResolveReason | null;
  /** Record id of the surviving broader finding when resolved as merged. */
  readonly mergedInto: string | null;
  /** The most recent finding, kept for display and for merge checks. */
  readonly latest: Finding;
}

export type LifecycleEventType = 'opened' | 'escalated' | 'resolved';

export interface LifecycleEvent {
  readonly type: LifecycleEventType;
  readonly recordId: string;
  readonly key: string;
  readonly severity: Severity;
  readonly reason: ResolveReason | null;
  readonly mergedInto: string | null;
}

export interface LifecycleOptions {
  /** Whole unseen days before an open record resolves (1 to 14, default 3). */
  readonly resolveAfterDays?: number;
  /** Days a resolved record is kept (1 to 365, default 30). */
  readonly retainResolvedDays?: number;
}

export interface LifecycleResult {
  readonly records: readonly FindingRecord[];
  readonly events: readonly LifecycleEvent[];
}

const SCOPES: ReadonlySet<string> = new Set(['tenant', 'service', 'account', 'leaf', 'region']);
const SCOPE_BREADTH: Readonly<Record<string, number>> = { region: 0, leaf: 1, account: 2, service: 3, tenant: 4 };
const SOURCES: ReadonlySet<string> = new Set(['statistical', 'novelty', 'reactivation']);
const CATEGORIES: ReadonlySet<string> = new Set([
  'spend_spike',
  'level_shift',
  'gradual_drift',
  'new_service',
  'new_region',
  'reactivation',
  'spend_drop',
]);
const SEVERITIES: ReadonlySet<string> = new Set(['info', 'warning', 'critical']);
const MAX_KEY_LENGTH = 1500;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function fail(code: 'FINDING_INVALID' | 'RECORD_INVALID', index?: number): never {
  throw new DetectionError(code, index);
}

/** Strict shape check of a finding. `lastDay` must equal `expectedLastDay` when given. */
export function validateFinding(f: unknown, code: 'FINDING_INVALID' | 'RECORD_INVALID', index?: number, expectedLastDay?: string): Finding {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) fail(code, index);
  const x = f as Record<string, unknown>;
  if (typeof x.key !== 'string' || x.key.length === 0 || x.key.length > MAX_KEY_LENGTH) fail(code, index);
  if (typeof x.scope !== 'string' || !SCOPES.has(x.scope)) fail(code, index);
  if (typeof x.source !== 'string' || !SOURCES.has(x.source)) fail(code, index);
  if (typeof x.category !== 'string' || !CATEGORIES.has(x.category)) fail(code, index);
  if (typeof x.severity !== 'string' || !SEVERITIES.has(x.severity)) fail(code, index);
  if (x.direction !== 'up' && x.direction !== 'down') fail(code, index);
  if (!isIdentifier(x.tenant) || !isCurrency(x.currency)) fail(code, index);
  if (typeof x.scopeKey !== 'string' || x.scopeKey.length === 0 || x.scopeKey.length > MAX_KEY_LENGTH) fail(code, index);
  if (x.key !== `${x.scope}|${x.tenant}|${x.currency}|${x.scopeKey}|${x.direction}|${x.source}`) fail(code, index);
  parseDay(x.startDay, code, index);
  const last = parseDay(x.lastDay, code, index);
  if (expectedLastDay !== undefined && last !== parseDay(expectedLastDay, code, index)) fail(code, index);
  for (const n of [x.actual, x.expected, x.impact, x.meanDailyExcess, x.todayExcess, x.minImpact, x.cumulativeCriticalImpact, x.otherExcess]) {
    if (!isFiniteNumber(n)) fail(code, index);
  }
  if (x.relative !== null && !isFiniteNumber(x.relative)) fail(code, index);
  for (const n of [x.windowDays, x.memberCount, x.otherCount]) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) fail(code, index);
  }
  if (!Array.isArray(x.memberKeys) || x.memberKeys.length > LIMITS.maxMemberKeys) fail(code, index);
  for (const m of x.memberKeys) if (typeof m !== 'string' || m.length === 0 || m.length > MAX_KEY_LENGTH) fail(code, index);
  if (typeof x.memberKeysTruncated !== 'boolean' || typeof x.estimated !== 'boolean') fail(code, index);
  if (!Array.isArray(x.contributors) || x.contributors.length > LIMITS.maxContributors) fail(code, index);
  if (!Array.isArray(x.detectors) || x.detectors.length > 16) fail(code, index);
  return f as Finding;
}

function validateRecord(r: unknown, index: number, asOfDn: number): FindingRecord {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) fail('RECORD_INVALID', index);
  const x = r as Record<string, unknown>;
  const latest = validateFinding(x.latest, 'RECORD_INVALID', index);
  if (typeof x.id !== 'string' || x.id.length === 0 || x.id.length > MAX_KEY_LENGTH + 40) fail('RECORD_INVALID', index);
  if (x.key !== latest.key) fail('RECORD_INVALID', index);
  if (x.status !== 'open' && x.status !== 'resolved') fail('RECORD_INVALID', index);
  if (typeof x.category !== 'string' || !CATEGORIES.has(x.category)) fail('RECORD_INVALID', index);
  if (typeof x.severity !== 'string' || !SEVERITIES.has(x.severity)) fail('RECORD_INVALID', index);
  const opened = parseDay(x.openedDay, 'RECORD_INVALID', index);
  const last = parseDay(x.lastSeenDay, 'RECORD_INVALID', index);
  if (last < opened || last > asOfDn) fail('RECORD_INVALID', index);
  if (typeof x.daysObserved !== 'number' || !Number.isInteger(x.daysObserved) || x.daysObserved < 1) fail('RECORD_INVALID', index);
  if (!isFiniteNumber(x.cumulativeImpact) || !isFiniteNumber(x.cumulativeCriticalImpact)) fail('RECORD_INVALID', index);
  if (x.status === 'open') {
    if (x.resolvedDay !== null || x.resolveReason !== null || x.mergedInto !== null) fail('RECORD_INVALID', index);
  } else {
    parseDay(x.resolvedDay, 'RECORD_INVALID', index);
    if (x.resolveReason !== 'auto_recovered' && x.resolveReason !== 'merged') fail('RECORD_INVALID', index);
    if (x.resolveReason === 'merged' ? typeof x.mergedInto !== 'string' : x.mergedInto !== null) fail('RECORD_INVALID', index);
  }
  return r as FindingRecord;
}

function resolveOptions(options: LifecycleOptions | undefined): { resolveAfter: number; retain: number } {
  if (options === undefined) return { resolveAfter: 3, retain: 30 };
  if (options === null || typeof options !== 'object') throw new DetectionError('OPTIONS_INVALID');
  const pick = (v: unknown, min: number, max: number, fallback: number): number => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new DetectionError('OPTIONS_INVALID');
    return v;
  };
  return { resolveAfter: pick(options.resolveAfterDays, 1, 14, 3), retain: pick(options.retainResolvedDays, 1, 365, 30) };
}

function isSubset(inner: readonly string[], outer: ReadonlySet<string>): boolean {
  if (inner.length === 0) return false;
  for (const k of inner) if (!outer.has(k)) return false;
  return true;
}

function compareRecords(a: FindingRecord, b: FindingRecord): number {
  return compareStrings(a.key, b.key) || compareStrings(a.openedDay, b.openedDay) || compareStrings(a.id, b.id);
}

export function reduceFindings(
  previous: readonly FindingRecord[],
  current: readonly Finding[],
  asOf: string,
  options?: LifecycleOptions,
): LifecycleResult {
  const asOfDn = parseDay(asOf);
  const asOfDay = formatDay(asOfDn);
  const { resolveAfter, retain } = resolveOptions(options);
  if (!Array.isArray(previous) || !Array.isArray(current)) throw new DetectionError('RECORD_INVALID');
  if (previous.length > LIMITS.maxRecords) throw new DetectionError('RECORD_CAP_EXCEEDED');
  if (current.length > LIMITS.maxFindings) throw new DetectionError('FINDING_INVALID');

  const records = new Map<string, FindingRecord>();
  const openByKey = new Map<string, string>();
  previous.forEach((r, i) => {
    const rec = validateRecord(r, i, asOfDn);
    if (records.has(rec.id)) fail('RECORD_INVALID', i);
    records.set(rec.id, rec);
    if (rec.status === 'open') {
      if (openByKey.has(rec.key)) fail('RECORD_INVALID', i);
      openByKey.set(rec.key, rec.id);
    }
  });
  const seenKeys = new Set<string>();
  const findings = current.map((f, i) => validateFinding(f, 'FINDING_INVALID', i, asOfDay));
  for (let i = 0; i < findings.length; i += 1) {
    const k = (findings[i] as Finding).key;
    if (seenKeys.has(k)) fail('FINDING_INVALID', i);
    seenKeys.add(k);
  }
  findings.sort((a, b) => compareStrings(a.key, b.key));

  const events: LifecycleEvent[] = [];
  const touchedToday = new Set<string>();

  // 1. Open or continue a record for every current finding.
  for (const f of findings) {
    const existingId = openByKey.get(f.key);
    if (existingId !== undefined) {
      const rec = records.get(existingId) as FindingRecord;
      const newDay = rec.lastSeenDay !== asOfDay;
      const cumulative = newDay ? round6(rec.cumulativeImpact + f.todayExcess) : rec.cumulativeImpact;
      let severity = maxSeverity(rec.severity, f.severity);
      if (f.direction === 'up' && cumulative >= f.cumulativeCriticalImpact) severity = 'critical';
      const category = rec.category === 'spend_spike' ? f.category : rec.category;
      const next: FindingRecord = {
        ...rec,
        category,
        severity,
        lastSeenDay: asOfDay,
        daysObserved: newDay ? rec.daysObserved + 1 : rec.daysObserved,
        cumulativeImpact: cumulative,
        cumulativeCriticalImpact: f.cumulativeCriticalImpact,
        latest: f,
      };
      records.set(existingId, next);
      touchedToday.add(existingId);
      if (severityRank(severity) > severityRank(rec.severity)) {
        events.push({ type: 'escalated', recordId: existingId, key: f.key, severity, reason: null, mergedInto: null });
      }
    } else {
      let id = `${f.key}@${asOfDay}`;
      for (let n = 2; records.has(id); n += 1) id = `${f.key}@${asOfDay}#${n}`;
      let severity = f.severity;
      if (f.direction === 'up' && f.todayExcess >= f.cumulativeCriticalImpact) severity = 'critical';
      const rec: FindingRecord = {
        id,
        key: f.key,
        status: 'open',
        category: f.category,
        severity,
        openedDay: asOfDay,
        lastSeenDay: asOfDay,
        daysObserved: 1,
        cumulativeImpact: round6(f.todayExcess),
        cumulativeCriticalImpact: f.cumulativeCriticalImpact,
        resolvedDay: null,
        resolveReason: null,
        mergedInto: null,
        latest: f,
      };
      records.set(id, rec);
      openByKey.set(f.key, id);
      touchedToday.add(id);
      events.push({ type: 'opened', recordId: id, key: f.key, severity, reason: null, mergedInto: null });
    }
  }

  // 2. Merge absent open records into broader current findings, then resolve
  //    the ones unseen for resolveAfter whole days.
  const resolveRecord = (rec: FindingRecord, reason: ResolveReason, mergedInto: string | null): void => {
    const next: FindingRecord = { ...rec, status: 'resolved', resolvedDay: asOfDay, resolveReason: reason, mergedInto };
    records.set(rec.id, next);
    openByKey.delete(rec.key);
    events.push({ type: 'resolved', recordId: rec.id, key: rec.key, severity: rec.severity, reason, mergedInto });
  };
  const absentOpen = Array.from(openByKey.entries())
    .filter(([, id]) => !touchedToday.has(id))
    .map(([, id]) => records.get(id) as FindingRecord)
    .sort(compareRecords);
  for (const rec of absentOpen) {
    const narrow = rec.latest;
    let survivor: FindingRecord | null = null;
    if (!narrow.memberKeysTruncated) {
      for (const g of findings) {
        if (g.memberKeysTruncated) continue;
        if (g.tenant !== narrow.tenant || g.currency !== narrow.currency) continue;
        if (g.direction !== narrow.direction || g.source !== narrow.source) continue;
        if ((SCOPE_BREADTH[g.scope] as number) <= (SCOPE_BREADTH[narrow.scope] as number)) continue;
        if (!isSubset(narrow.memberKeys, new Set(g.memberKeys))) continue;
        survivor = records.get(openByKey.get(g.key) as string) as FindingRecord;
        break;
      }
    }
    if (survivor !== null) {
      resolveRecord(rec, 'merged', survivor.id);
    } else if (asOfDn - parseDay(rec.lastSeenDay) >= resolveAfter) {
      resolveRecord(rec, 'auto_recovered', null);
    }
  }

  // 3. Keep merge pointers one level deep: re-point at the terminal survivor.
  for (const rec of Array.from(records.values())) {
    if (rec.status !== 'resolved' || rec.mergedInto === null) continue;
    let target = records.get(rec.mergedInto);
    let hops = 0;
    while (target !== undefined && target.mergedInto !== null && hops < 8) {
      target = records.get(target.mergedInto);
      hops += 1;
    }
    if (target !== undefined && target.id !== rec.mergedInto) {
      records.set(rec.id, { ...rec, mergedInto: target.id });
    }
  }

  // 4. Prune old resolved records that nothing retained points at.
  const cutoff = asOfDn - retain;
  const isOld = (r: FindingRecord): boolean => r.status === 'resolved' && parseDay(r.resolvedDay as string) < cutoff;
  const referenced = new Set<string>();
  for (const r of records.values()) if (!isOld(r) && r.mergedInto !== null) referenced.add(r.mergedInto);
  const kept = Array.from(records.values()).filter((r) => !isOld(r) || referenced.has(r.id));
  if (kept.length > LIMITS.maxRecords) throw new DetectionError('RECORD_CAP_EXCEEDED');

  kept.sort(compareRecords);
  events.sort((a, b) => compareStrings(a.recordId, b.recordId) || compareStrings(a.type, b.type));
  return { records: kept, events };
}
