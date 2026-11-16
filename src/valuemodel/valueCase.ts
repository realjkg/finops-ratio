// The project sponsor's cost-to-value case, before (expected) and after (observed), without rewriting history.
//
// - The sponsor supplies the inputs ("terms"): KPI results, finance-register rates, observations, forecasts or
//   assumptions, each with its source kind and basis, plus two bounded formulas: benefit and full AI project cost.
// - Nobody types a ratio, a net benefit or an evidence status: they are computed (strict fields refuse them).
// - A version is frozen once Finance approves it. The first approved `expected` version is the original business
//   case and stays exactly as approved; a revised forecast is a new version with a rationale.
// - Published ratios are append-only snapshots bound to the case version's digest. A restatement is a new snapshot
//   from a newer approved version that supersedes the old one; the issued snapshot stays readable unchanged.
//
// Value / cost = V ÷ C (break-even 1×). Net benefit = V − C. ROI = (V − C) ÷ C. One currency, one period; C ≤ 0
// makes the ratio unavailable rather than infinite.
import type { EvidenceStatus } from '@/types';
import { weakestStatus } from '@/lib/valueEvidence';
import { digestOf } from './digest';
import { FORMULA_ENGINE_VERSION, FormulaError, evaluate, inferUnit, parseFormula, references } from './formula';
import { type SourceKind, SOURCE_KINDS } from './kpiDefinition';
import { type Actor, LifecycleError } from './lifecycle';
import { type Rational, RationalOverflowError, cmp, div, isDecimalString, parseDecimal, R_ZERO, sub, toDecimal, mul, fromInt } from './rational';
import { type Unit, UnitError, baseUnit, convert, describeDims, parseUnit, sameDimension } from './units';

export const BENEFIT_CLASSES = ['cash_savings', 'cost_avoidance', 'incremental_contribution', 'capacity_equivalent', 'risk_adjusted'] as const;
export type BenefitClass = (typeof BENEFIT_CLASSES)[number];

export interface ValueCaseTerm {
  key: string;
  label: string;
  unit: string;
  quantity: string | null;
  sourceKind: SourceKind;
  basis: 'observed' | 'forecast' | 'assumption';
  sourceRefs: string[];
  verificationRef?: string;
  /** The KPI result it reads. The evidence status given here is not used: a kpi_result term counts as assumed until resolved. */
  kpiResult?: { resultId: string; evidenceStatus: EvidenceStatus };
}

export interface ValueCaseVersion {
  schemaVersion: 'value-case/0-draft';
  caseId: string;
  version: number;
  tenantId: string;
  projectId: string;
  phase: 'expected' | 'observed';
  periodStart: string;
  periodEnd: string;
  currency: string;
  terms: ValueCaseTerm[];
  benefit: { expression: string; benefitClass: BenefitClass };
  cost: { expression: string };
  /** Why this version exists (required for every version after the first of its phase and period). */
  rationale?: string;
  basedOnVersion?: number;
}

export type CaseStatus = 'draft' | 'approved';
export interface CaseRecord {
  readonly caseVersion: ValueCaseVersion;
  readonly status: CaseStatus;
  readonly digest: string;
  readonly sponsorId: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly isOriginalBusinessCase: boolean;
}

export interface RatioSnapshot {
  schemaVersion: 'value-ratio-snapshot/0-draft';
  snapshotId: string;
  caseId: string;
  caseVersion: number;
  caseDigest: string;
  phase: 'expected' | 'observed';
  isOriginalBusinessCase: boolean;
  periodStart: string;
  periodEnd: string;
  currency: string;
  benefitClass: BenefitClass;
  value: string | null;
  cost: string | null;
  netBenefit: string | null;
  /** V ÷ C to 2 decimals (shown as "2.00×"); null when unavailable. */
  valueToCost: string | null;
  /** (V − C) ÷ C as a percentage to 1 decimal; null when unavailable. */
  roiPercent: string | null;
  reasons: string[];
  evidenceStatus: EvidenceStatus;
  engineVersion: typeof FORMULA_ENGINE_VERSION;
  publishedAt: string;
  publishedBy: string;
  supersedes?: string;
  supersedeReason?: string;
  snapshotDigest: string;
}

const KEY_RE = /^[a-z][A-Za-z0-9_]{0,39}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CASE_FIELDS = ['schemaVersion', 'caseId', 'version', 'tenantId', 'projectId', 'phase', 'periodStart', 'periodEnd', 'currency', 'terms', 'benefit', 'cost', 'rationale', 'basedOnVersion'];
const TERM_FIELDS = ['key', 'label', 'unit', 'quantity', 'sourceKind', 'basis', 'sourceRefs', 'verificationRef', 'kpiResult'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

function termStatus(t: ValueCaseTerm): EvidenceStatus {
  // A typed assumption is the weakest evidence, even when it is labeled a forecast.
  if (t.basis === 'assumption' || t.sourceKind === 'assumption') return 'assumed';
  // Not resolved against the KPI result ledger yet, so the status would be typed: assumed until resolved.
  if (t.sourceKind === 'kpi_result') return 'assumed';
  if (t.basis === 'forecast') return 'projected';
  return t.verificationRef ? 'measured' : 'assumed';
}

/**
 * A snapshot's status: the weakest term. An expected-phase case is a forecast, so it is never
 * above projected; no case is measured until a counterfactual method and independent
 * verification are modeled (VALUE-DERIVATION §4), so an observed case is capped at projected too.
 */
function snapshotStatus(statuses: readonly EvidenceStatus[]): EvidenceStatus {
  const weakest = weakestStatus(statuses) ?? 'assumed';
  return weakest === 'measured' ? 'projected' : weakest;
}

export type CaseCheck = { ok: true; units: Record<string, Unit> } | { ok: false; problems: string[] };

/** Validates a case version: strict shape, typed terms, one currency, benefit and cost formulas that yield it. */
export function checkValueCase(v: unknown): CaseCheck {
  const p: string[] = [];
  if (!isRecord(v)) return { ok: false, problems: ['$: object'] };
  for (const k of Object.keys(v)) if (!CASE_FIELDS.includes(k)) p.push(KEY_RE.test(k) ? `$.${k}: unknown field (ratios, net benefit and evidence status are computed, never entered)` : '$: unknown field (not printed)');
  if (v.schemaVersion !== 'value-case/0-draft') p.push('$.schemaVersion: equals value-case/0-draft');
  for (const k of ['caseId', 'tenantId', 'projectId'] as const) if (typeof v[k] !== 'string' || !ID_RE.test(v[k] as string)) p.push(`$.${k}: identifier`);
  if (!Number.isSafeInteger(v.version) || (v.version as number) < 1) p.push('$.version: positive integer');
  if (v.phase !== 'expected' && v.phase !== 'observed') p.push('$.phase: expected or observed');
  for (const k of ['periodStart', 'periodEnd'] as const) if (typeof v[k] !== 'string' || !DATE_RE.test(v[k] as string)) p.push(`$.${k}: YYYY-MM-DD`);
  if (typeof v.periodStart === 'string' && typeof v.periodEnd === 'string' && v.periodEnd < v.periodStart) p.push('$.periodEnd: before periodStart');
  if (typeof v.currency !== 'string' || !/^[A-Z]{3}$/.test(v.currency)) p.push('$.currency: 3-letter currency code');
  if (v.rationale !== undefined && (typeof v.rationale !== 'string' || v.rationale.trim() === '' || v.rationale.length > 2000)) p.push('$.rationale: text of 1 to 2000 characters');
  if (v.basedOnVersion !== undefined && (!Number.isSafeInteger(v.basedOnVersion) || (v.basedOnVersion as number) < 1)) p.push('$.basedOnVersion: positive integer');

  const units: Record<string, Unit> = Object.create(null);
  if (!Array.isArray(v.terms) || v.terms.length < 1 || v.terms.length > 32) p.push('$.terms: 1 to 32 terms');
  else v.terms.forEach((t, i) => {
    const at = `$.terms[${i}]`;
    if (!isRecord(t)) return void p.push(`${at}: object`);
    for (const k of Object.keys(t)) if (!TERM_FIELDS.includes(k)) p.push(KEY_RE.test(k) ? `${at}.${k}: unknown field` : `${at}: unknown field (not printed)`);
    if (typeof t.key !== 'string' || !KEY_RE.test(t.key) || ['min', 'max', 'if'].includes(t.key)) p.push(`${at}.key: identifier`);
    else if (Object.hasOwn(units, t.key)) p.push(`${at}.key: duplicate term`);
    if (typeof t.label !== 'string' || t.label.trim() === '' || t.label.length > 200) p.push(`${at}.label: text of 1 to 200 characters`);
    if (t.quantity !== null && !isDecimalString(t.quantity)) p.push(`${at}.quantity: plain decimal string or null`);
    if (!(SOURCE_KINDS as readonly unknown[]).includes(t.sourceKind)) p.push(`${at}.sourceKind: one of ${SOURCE_KINDS.join('|')}`);
    if (!['observed', 'forecast', 'assumption'].includes(t.basis as string)) p.push(`${at}.basis: observed, forecast or assumption`);
    if (t.basis === 'observed' && t.sourceKind === 'assumption') p.push(`${at}.basis: an assumption is not an observation`);
    if (t.sourceKind === 'kpi_result' && !isRecord(t.kpiResult)) p.push(`${at}.kpiResult: required for a kpi_result term`);
    if (!Array.isArray(t.sourceRefs) || t.sourceRefs.some((r) => typeof r !== 'string' || !ID_RE.test(r))) p.push(`${at}.sourceRefs: identifiers`);
    if (v.phase === 'observed' && t.basis === 'forecast') p.push(`${at}.basis: an observed case uses observations or labeled assumptions, not forecasts`);
    try {
      const u = parseUnit(t.unit);
      if (typeof t.key === 'string' && KEY_RE.test(t.key) && !Object.hasOwn(units, t.key)) units[t.key] = u;
    } catch (e) {
      p.push(`${at}.unit: ${e instanceof UnitError ? e.message : 'invalid unit'}`);
    }
  });

  const currencyUnit = typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency) ? parseUnit(v.currency) : null;
  const used = new Set<string>();
  for (const side of ['benefit', 'cost'] as const) {
    const s = v[side];
    if (!isRecord(s) || typeof s.expression !== 'string') { p.push(`$.${side}.expression: formula`); continue; }
    if (side === 'benefit' && !(BENEFIT_CLASSES as readonly unknown[]).includes(s.benefitClass)) p.push(`$.benefit.benefitClass: one of ${BENEFIT_CLASSES.join('|')}`);
    try {
      const tree = parseFormula(s.expression);
      references(tree).forEach((r) => used.add(r));
      const u = inferUnit(tree, (k) => (Object.hasOwn(units, k) ? units[k] : undefined));
      if (currencyUnit && !sameDimension(u, currencyUnit)) p.push(`$.${side}.expression: must produce ${String(v.currency)}, not ${describeDims(u)}`);
    } catch (e) {
      p.push(`$.${side}.expression: ${e instanceof FormulaError ? e.message : 'invalid formula'}`);
    }
  }
  for (const k of Object.keys(units)) if (!used.has(k)) p.push(`$.terms: ${k} is never used by the benefit or cost formula`);
  return p.length ? { ok: false, problems: p } : { ok: true, units };
}

export class ValueCaseError extends Error {
  constructor(readonly code: 'INVALID_CASE' | 'NOT_APPROVED' | 'RESTATEMENT' | 'NOT_FOUND' | 'DUPLICATE', readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'ValueCaseError';
  }
}

/** One project's value cases and their published ratio snapshots. Approved versions and snapshots never change. */
export class ValueCaseRegistry {
  /** Exact Value / cost per snapshot, kept beside the rounded snapshot so variance is never computed from rounded figures. */
  private readonly exactRatios = new Map<string, Rational | null>();
  private readonly cases: CaseRecord[] = [];
  private readonly snapshots: RatioSnapshot[] = [];

  constructor(readonly tenantId: string) {}

  private find(caseId: string, version: number): CaseRecord {
    const r = this.cases.find((c) => c.caseVersion.caseId === caseId && c.caseVersion.version === version);
    if (!r) throw new ValueCaseError('NOT_FOUND', ['case version not found']);
    return r;
  }
  private replace(rec: CaseRecord): CaseRecord {
    const i = this.cases.findIndex((c) => c.caseVersion.caseId === rec.caseVersion.caseId && c.caseVersion.version === rec.caseVersion.version);
    if (i >= 0) this.cases[i] = rec;
    else this.cases.push(rec);
    return rec;
  }

  versions(caseId: string): readonly CaseRecord[] {
    return this.cases.filter((c) => c.caseVersion.caseId === caseId).sort((a, b) => a.caseVersion.version - b.caseVersion.version);
  }

  /** The first approved expected version: the investment case as originally approved, never altered. */
  originalBusinessCase(caseId: string): CaseRecord | undefined {
    return this.versions(caseId).find((c) => c.isOriginalBusinessCase);
  }

  /**
   * A version that follows an approved version of the same phase and period is a revision: it states a
   * rationale and a basedOnVersion that names one of those approved versions. Null when the rule holds.
   */
  private revisionProblem(cv: ValueCaseVersion): string | null {
    const approvedSame = this.versions(cv.caseId).filter((c) => c.caseVersion.version < cv.version && c.status === 'approved' && c.caseVersion.phase === cv.phase && c.caseVersion.periodStart === cv.periodStart && c.caseVersion.periodEnd === cv.periodEnd);
    if (!approvedSame.length) return null;
    if (!cv.rationale || cv.basedOnVersion === undefined) return 'a revision of an approved version states a rationale and basedOnVersion';
    if (!approvedSame.some((c) => c.caseVersion.version === cv.basedOnVersion)) return 'basedOnVersion names an approved version of the same phase and period';
    return null;
  }

  /** The sponsor saves (or re-saves) a draft version with their own inputs. */
  saveDraft(cv: ValueCaseVersion, sponsor: Actor): CaseRecord {
    if (!sponsor.roles.includes('project_sponsor')) throw new LifecycleError('FORBIDDEN', 'editing cost-to-value inputs needs project_sponsor');
    if (cv.tenantId !== this.tenantId) throw new LifecycleError('FORBIDDEN', 'case belongs to another tenant');
    const existing = this.cases.find((c) => c.caseVersion.caseId === cv.caseId && c.caseVersion.version === cv.version);
    if (existing && existing.status === 'approved') throw new LifecycleError('IMMUTABLE', 'an approved case version never changes; save a new version with a rationale');
    if (existing && existing.sponsorId !== sponsor.id) throw new LifecycleError('FORBIDDEN', 'only the sponsor who started a draft edits it');
    const prior = this.versions(cv.caseId).filter((c) => c.caseVersion.version < cv.version);
    if (!existing && prior.length && cv.version !== prior[prior.length - 1].caseVersion.version + 1) throw new LifecycleError('INVALID_STATE', 'versions are consecutive');
    if (!existing && !prior.length && cv.version !== 1) throw new LifecycleError('INVALID_STATE', 'a case starts at version 1');
    const revision = this.revisionProblem(cv);
    if (revision) throw new ValueCaseError('INVALID_CASE', [revision]);
    const c = checkValueCase(cv);
    if (!c.ok) throw new ValueCaseError('INVALID_CASE', c.problems);
    const frozen = deepFreeze(clone(cv));
    return this.replace(deepFreeze({ caseVersion: frozen, status: 'draft', digest: digestOf(frozen), sponsorId: sponsor.id, isOriginalBusinessCase: false }));
  }

  /** Finance approves the exact draft it reviewed. The sponsor never approves their own case. */
  approve(caseId: string, version: number, approver: Actor, digest: string, at: string): CaseRecord {
    const cur = this.find(caseId, version);
    if (cur.status === 'approved') throw new LifecycleError('IMMUTABLE', 'already approved');
    if (!approver.roles.includes('finance_approver')) throw new LifecycleError('FORBIDDEN', 'approving a value case needs finance_approver');
    if (approver.id === cur.sponsorId) throw new LifecycleError('SEPARATION_OF_DUTIES', 'the sponsor cannot approve their own value case');
    if (digest !== cur.digest) throw new LifecycleError('CONFLICT', 'the case changed since it was reviewed');
    // Versions of one phase and period are approved in order, so a later version can never become the original.
    const later = this.versions(caseId).some((c) => c.caseVersion.version > version && c.status === 'approved' && c.caseVersion.phase === cur.caseVersion.phase && c.caseVersion.periodStart === cur.caseVersion.periodStart && c.caseVersion.periodEnd === cur.caseVersion.periodEnd);
    if (later) throw new ValueCaseError('INVALID_CASE', ['a later version of this phase and period is already approved; approve versions in order']);
    // Rechecked at approval: a draft saved before an earlier version was approved must still state its lineage.
    const revision = this.revisionProblem(cur.caseVersion);
    if (revision) throw new ValueCaseError('INVALID_CASE', [revision]);
    const isOriginal = cur.caseVersion.phase === 'expected' && !this.originalBusinessCase(caseId);
    return this.replace(deepFreeze({ ...cur, status: 'approved', approvedBy: approver.id, approvedAt: at, isOriginalBusinessCase: isOriginal }));
  }

  /** Computes and appends a ratio snapshot for an approved version. A restatement names what it supersedes and why. */
  publish(caseId: string, version: number, by: Actor, snapshotId: string, at: string, restatement?: { supersedes: string; reason: string }): RatioSnapshot {
    const rec = this.find(caseId, version);
    if (rec.status !== 'approved') throw new ValueCaseError('NOT_APPROVED', ['only an approved case version is published']);
    if (this.snapshots.some((s) => s.snapshotId === snapshotId)) throw new ValueCaseError('DUPLICATE', ['snapshot id already used']);
    const cv = rec.caseVersion;
    // The original business case is published first, so a revised forecast can never stand in for it.
    if (cv.phase === 'expected' && !rec.isOriginalBusinessCase && !this.snapshots.some((s) => s.caseId === caseId && s.isOriginalBusinessCase)) {
      throw new ValueCaseError('RESTATEMENT', ['publish the original business case before a revised forecast']);
    }
    const live = this.snapshots.filter((s) => s.caseId === caseId && s.phase === cv.phase && s.periodStart === cv.periodStart && s.periodEnd === cv.periodEnd && !this.snapshots.some((x) => x.supersedes === s.snapshotId));
    if (restatement) {
      const old = this.snapshots.find((s) => s.snapshotId === restatement.supersedes);
      if (old?.isOriginalBusinessCase) throw new ValueCaseError('RESTATEMENT', ['the original business case is never superseded; publish a revised forecast beside it']);
      if (!old || !live.includes(old)) throw new ValueCaseError('RESTATEMENT', ['a restatement supersedes the snapshot currently in force for the same phase and period']);
      if (old.caseVersion >= version) throw new ValueCaseError('RESTATEMENT', ['a restatement comes from a newer approved case version']);
      if (!restatement.reason.trim()) throw new ValueCaseError('RESTATEMENT', ['a restatement states its reason']);
    } else if (live.length && !(cv.phase === 'expected' && live.every((s) => s.isOriginalBusinessCase) && !rec.isOriginalBusinessCase)) {
      throw new ValueCaseError('RESTATEMENT', ['a snapshot for this phase and period is already in force; publish a restatement that supersedes it']);
    }

    const units = (checkValueCase(cv) as { ok: true; units: Record<string, Unit> }).units;
    const reasons: string[] = [];
    const base: Record<string, Rational | null> = Object.create(null);
    for (const t of cv.terms) {
      if (t.quantity === null) { reasons.push(`no value for ${t.key}`); base[t.key] = null; continue; }
      base[t.key] = convert(parseDecimal(t.quantity) as Rational, units[t.key], baseUnit(units[t.key]));
    }
    const run = (expr: string) => {
      const r = evaluate(parseFormula(expr), (k) => (Object.hasOwn(base, k) ? base[k] : null));
      if (!r.ok) { if (r.reason !== 'missing_input') reasons.push(r.reason === 'zero_denominator' ? 'a denominator is zero' : 'value exceeds supported precision'); return null; }
      return r.value;
    };
    const V = run(cv.benefit.expression);
    const C = run(cv.cost.expression);
    let ratio: string | null = null;
    let roi: string | null = null;
    let net: string | null = null;
    let exactRatio: Rational | null = null;
    if (V && C) {
      try {
        net = toDecimal(sub(V, C), 2);
        if (cmp(C, R_ZERO) <= 0) reasons.push('full AI project cost is zero or negative; the ratio is unavailable');
        else {
          exactRatio = div(V, C) as Rational;
          ratio = toDecimal(exactRatio, 2);
          roi = toDecimal(mul(div(sub(V, C), C) as Rational, fromInt(100)), 1);
        }
      } catch (e) {
        if (!(e instanceof RationalOverflowError)) throw e;
        net = ratio = roi = null;
        exactRatio = null;
        reasons.push('value exceeds supported precision');
      }
    }
    const statuses = cv.terms.map(termStatus);
    const body: Omit<RatioSnapshot, 'snapshotDigest'> = {
      schemaVersion: 'value-ratio-snapshot/0-draft', snapshotId, caseId, caseVersion: version, caseDigest: rec.digest, phase: cv.phase,
      isOriginalBusinessCase: rec.isOriginalBusinessCase, periodStart: cv.periodStart, periodEnd: cv.periodEnd, currency: cv.currency,
      benefitClass: cv.benefit.benefitClass, value: V ? toDecimal(V, 2) : null, cost: C ? toDecimal(C, 2) : null,
      netBenefit: net, valueToCost: ratio, roiPercent: roi, reasons,
      evidenceStatus: snapshotStatus(statuses), engineVersion: FORMULA_ENGINE_VERSION, publishedAt: at, publishedBy: by.id,
      ...(restatement ? { supersedes: restatement.supersedes, supersedeReason: restatement.reason } : {}),
    };
    const snap = deepFreeze({ ...body, snapshotDigest: digestOf(body) }) as RatioSnapshot;
    this.snapshots.push(snap);
    this.exactRatios.set(snapshotId, exactRatio);
    return snap;
  }

  /** The exact snapshot as issued, even after a restatement. */
  issued(snapshotId: string): RatioSnapshot {
    const s = this.snapshots.find((x) => x.snapshotId === snapshotId);
    if (!s) throw new ValueCaseError('NOT_FOUND', ['snapshot not found']);
    return s;
  }

  /**
   * Before vs after for one period: the original business case, the latest approved forecast, and the observed
   * result in force. Variance is measured against the original, so a revised forecast cannot hide a shortfall.
   */
  expectedVsObserved(caseId: string, periodStart: string, periodEnd: string) {
    const inForce = (phase: 'expected' | 'observed') => this.snapshots.filter((s) => s.caseId === caseId && s.phase === phase && s.periodStart === periodStart && s.periodEnd === periodEnd && !this.snapshots.some((x) => x.supersedes === s.snapshotId));
    const expected = inForce('expected');
    const original = expected.find((s) => s.isOriginalBusinessCase) ?? this.snapshots.find((s) => s.caseId === caseId && s.isOriginalBusinessCase && s.periodStart === periodStart && s.periodEnd === periodEnd);
    const latestForecast = expected.filter((s) => !s.isOriginalBusinessCase).sort((a, b) => b.caseVersion - a.caseVersion)[0];
    const observed = inForce('observed')[0];
    // Variance comes from the exact ratios, rounded once, so two rounded ratios can never hide a shortfall.
    const o = original && this.exactRatios.get(original.snapshotId);
    const b = observed && this.exactRatios.get(observed.snapshotId);
    let varianceVsOriginal: string | null = null;
    if (o && b && original.currency === observed.currency) {
      try { varianceVsOriginal = toDecimal(sub(b, o), 2); } catch (e) { if (!(e instanceof RationalOverflowError)) throw e; }
    }
    return { original, latestForecast, observed, varianceVsOriginal };
  }
}
