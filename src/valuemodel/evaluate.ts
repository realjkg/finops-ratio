// Computes a KPI result from observations under one definition version, and keeps results append-only.
//
// - Official results need a Published definition; a Draft can be previewed only as a scenario, which is never
//   `measured` and never enters the ledger as official.
// - Every declared input needs exactly one observation for the same period and scope, in a compatible unit, from a
//   source kind the definition allows, inside its bounds.
// - Evidence status is computed, never chosen: an observation from a system of record counts as `measured` only with
//   an independent verification reference; a forecast is `projected`; an assumption or an unverified value is
//   `assumed`. The weakest input wins (src/lib/valueEvidence.ts).
// - A recalculation is a new result that `supersedes` the old one. The issued result stays readable byte for byte,
//   so a report always shows the number it was issued with.
import type { EvidenceStatus } from '@/types';
import { weakestStatus } from '@/lib/valueEvidence';
import { digestOf } from './digest';
import { FORMULA_ENGINE_VERSION, evaluate, parseFormula } from './formula';
import { type KpiDefinition, type SourceKind, checkKpiDefinition } from './kpiDefinition';
import type { DefinitionRecord } from './lifecycle';
import { type Rational, cmp, isDecimalString, parseDecimal, toDecimal } from './rational';
import { UnitError, baseUnit, convert, parseUnit, sameDimension } from './units';

export interface Observation {
  key: string;
  /** Canonical decimal string; null means the value is not available (never read as 0). */
  quantity: string | null;
  unit: string;
  sourceKind: SourceKind;
  basis: 'observed' | 'forecast' | 'assumption';
  periodStart: string;
  periodEnd: string;
  scopeRef: string;
  sourceRefs: string[];
  /** Reference to an independent verification (not the recorder or the workload owner). */
  verificationRef?: string;
  /** For a `kpi_result` source: the result it reads, and that result's evidence status. */
  kpiResult?: { resultId: string; evidenceStatus: EvidenceStatus };
}

export interface KpiResult {
  schemaVersion: 'kpi-result/0-draft';
  resultId: string;
  mode: 'official' | 'scenario';
  tenantId: string;
  projectId: string;
  definitionId: string;
  definitionVersion: number;
  definitionDigest: string;
  engineVersion: typeof FORMULA_ENGINE_VERSION;
  periodStart: string;
  periodEnd: string;
  scopeRef: string;
  availability: 'available' | 'unavailable';
  /** Rounded once, half-even, to the definition's scale; null when unavailable. */
  quantity: string | null;
  unit: string;
  reasons: string[];
  evidenceStatus: EvidenceStatus;
  inputs: { key: string; sourceKind: SourceKind; basis: Observation['basis']; evidenceStatus: EvidenceStatus; sourceRefs: string[]; verificationRef?: string }[];
  /** Against the definition's target, when one is set and the result is available. */
  target?: { value: string; unit: string; met: boolean };
  calculatedAt: string;
  calculatedBy: string;
  supersedes?: string;
  supersedeReason?: string;
  resultDigest: string;
}

export class EvaluationError extends Error {
  constructor(readonly code: 'NOT_PUBLISHED' | 'INVALID_DEFINITION' | 'INVALID_OBSERVATIONS', readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'EvaluationError';
  }
}

const SOURCE_OF_RECORD: readonly SourceKind[] = ['connector', 'upload', 'manual_observation', 'finance_register'];

function inputStatus(o: Observation): EvidenceStatus {
  if (o.sourceKind === 'kpi_result') return o.kpiResult?.evidenceStatus ?? 'assumed';
  // A typed assumption is the weakest evidence, even when it is labeled a forecast.
  if (o.basis === 'assumption' || o.sourceKind === 'assumption') return 'assumed';
  if (o.basis === 'forecast') return 'projected';
  return SOURCE_OF_RECORD.includes(o.sourceKind) && o.verificationRef ? 'measured' : 'assumed';
}

export interface EvaluateArgs {
  record: DefinitionRecord;
  observations: readonly Observation[];
  periodStart: string;
  periodEnd: string;
  scopeRef: string;
  resultId: string;
  calculatedAt: string;
  calculatedBy: string;
  mode?: 'official' | 'scenario';
  /** For a recalculation: the issued result this one replaces, and why. */
  supersedes?: string;
  supersedeReason?: string;
}

export function evaluateKpi(args: EvaluateArgs): KpiResult {
  const mode = args.mode ?? 'official';
  const def: KpiDefinition = args.record.definition;
  if (mode === 'official' && args.record.status !== 'published') throw new EvaluationError('NOT_PUBLISHED', ['an official result needs a published definition version (preview a draft as a scenario)']);
  const check = checkKpiDefinition(def);
  if (!check.ok) throw new EvaluationError('INVALID_DEFINITION', check.problems);

  const p: string[] = [];
  const byKey = new Map<string, Observation>();
  args.observations.forEach((o, i) => {
    const at = `observations[${i}]`;
    const input = def.inputs.find((x) => x.key === o.key);
    if (!input) return void p.push(`${at}.key: not a declared input`);
    if (byKey.has(o.key)) return void p.push(`${at}.key: more than one observation for ${o.key}`);
    byKey.set(o.key, o);
    if (o.periodStart !== args.periodStart || o.periodEnd !== args.periodEnd) p.push(`${at}: period differs from the result period`);
    if (o.scopeRef !== args.scopeRef) p.push(`${at}: scope differs from the result scope`);
    if (!input.sourceKinds.includes(o.sourceKind)) p.push(`${at}.sourceKind: not allowed for ${o.key}`);
    if (o.sourceKind === 'kpi_result' && !o.kpiResult) p.push(`${at}.kpiResult: required for a kpi_result source`);
    if (o.basis === 'observed' && o.sourceKind === 'assumption') p.push(`${at}.basis: an assumption is not an observation`);
    if (o.quantity !== null && !isDecimalString(o.quantity)) p.push(`${at}.quantity: plain decimal string or null`);
    try {
      if (!sameDimension(parseUnit(o.unit), check.inputUnits[o.key])) p.push(`${at}.unit: not convertible to ${input.unit}`);
    } catch (e) {
      p.push(`${at}.unit: ${e instanceof UnitError ? e.message : 'invalid unit'}`);
    }
  });
  if (p.length) throw new EvaluationError('INVALID_OBSERVATIONS', p);

  const reasons: string[] = [];
  const base: Record<string, Rational | null> = Object.create(null);
  for (const input of def.inputs) {
    const o = byKey.get(input.key);
    if (!o) { reasons.push(`missing observation for ${input.key}`); base[input.key] = null; continue; }
    if (o.quantity === null) { reasons.push(`no value for ${input.key}`); base[input.key] = null; continue; }
    const declared = check.inputUnits[input.key];
    const inDeclared = convert(parseDecimal(o.quantity) as Rational, parseUnit(o.unit), declared) as Rational;
    const lo = input.minimum !== undefined ? parseDecimal(input.minimum) : null;
    const hi = input.maximum !== undefined ? parseDecimal(input.maximum) : null;
    if ((lo && cmp(inDeclared, lo) < 0) || (hi && cmp(inDeclared, hi) > 0)) {
      throw new EvaluationError('INVALID_OBSERVATIONS', [`observation for ${input.key} is outside its declared bounds`]);
    }
    // Hold every value in base units (minutes, not hours) so the formula mixes compatible units safely.
    base[input.key] = convert(inDeclared, declared, baseUnit(declared));
  }

  let quantity: string | null = null;
  if (reasons.length === 0) {
    const r = evaluate(parseFormula(def.calculation.expression), (k) => (Object.hasOwn(base, k) ? base[k] : null));
    if (r.ok) {
      const out = convert(r.value, baseUnit(check.resultUnit), check.resultUnit) as Rational;
      quantity = toDecimal(out, def.calculation.scale);
    } else reasons.push(r.reason === 'zero_denominator' ? 'unavailable: a denominator is zero' : r.reason === 'overflow' ? 'unavailable: value exceeds supported precision' : `unavailable: ${r.detail}`);
  }

  const inputs = def.inputs.map((input) => {
    const o = byKey.get(input.key);
    if (!o) return { key: input.key, sourceKind: 'assumption' as SourceKind, basis: 'assumption' as const, evidenceStatus: 'assumed' as EvidenceStatus, sourceRefs: [] };
    return { key: o.key, sourceKind: o.sourceKind, basis: o.basis, evidenceStatus: inputStatus(o), sourceRefs: [...o.sourceRefs], ...(o.verificationRef ? { verificationRef: o.verificationRef } : {}) };
  });
  let evidenceStatus = weakestStatus(inputs.map((x) => x.evidenceStatus)) ?? 'assumed';
  if (mode === 'scenario' && evidenceStatus === 'measured') evidenceStatus = 'projected';

  let target: KpiResult['target'];
  if (def.target && quantity !== null) {
    const t = convert(parseDecimal(def.target.value) as Rational, parseUnit(def.target.unit), check.resultUnit) as Rational;
    const c = cmp(parseDecimal(quantity) as Rational, t);
    target = { value: def.target.value, unit: def.target.unit, met: def.direction === 'higher_is_better' ? c >= 0 : c <= 0 };
  }

  const body: Omit<KpiResult, 'resultDigest'> = {
    schemaVersion: 'kpi-result/0-draft', resultId: args.resultId, mode, tenantId: def.tenantId, projectId: def.projectId,
    definitionId: def.definitionId, definitionVersion: def.version, definitionDigest: args.record.digest, engineVersion: FORMULA_ENGINE_VERSION,
    periodStart: args.periodStart, periodEnd: args.periodEnd, scopeRef: args.scopeRef,
    availability: quantity === null ? 'unavailable' : 'available', quantity, unit: def.calculation.resultUnit, reasons, evidenceStatus, inputs,
    ...(target ? { target } : {}), calculatedAt: args.calculatedAt, calculatedBy: args.calculatedBy,
    ...(args.supersedes ? { supersedes: args.supersedes, supersedeReason: args.supersedeReason } : {}),
  };
  return Object.freeze({ ...body, resultDigest: digestOf(body) }) as KpiResult;
}

export class ResultLedgerError extends Error {
  constructor(readonly code: 'DUPLICATE' | 'NOT_FOUND' | 'SCENARIO' | 'MISMATCH' | 'ALREADY_SUPERSEDED', what: string) {
    super(what);
    this.name = 'ResultLedgerError';
  }
}

/** Append-only store of official KPI results. Nothing is ever updated or deleted. */
export class KpiResultLedger {
  private readonly results: KpiResult[] = [];

  /** Records a first result, or a recalculation that names the result it supersedes and why. */
  append(r: KpiResult): KpiResult {
    if (r.mode !== 'official') throw new ResultLedgerError('SCENARIO', 'scenario results are previews and are never recorded as official');
    if (this.results.some((x) => x.resultId === r.resultId)) throw new ResultLedgerError('DUPLICATE', 'result id already recorded');
    if (r.supersedes !== undefined) {
      const old = this.issued(r.supersedes);
      if (old.definitionId !== r.definitionId || old.periodStart !== r.periodStart || old.periodEnd !== r.periodEnd || old.scopeRef !== r.scopeRef) {
        throw new ResultLedgerError('MISMATCH', 'a recalculation must cover the same KPI, period and scope');
      }
      if (this.results.some((x) => x.supersedes === r.supersedes)) throw new ResultLedgerError('ALREADY_SUPERSEDED', 'that result was already superseded');
      if (!r.supersedeReason) throw new ResultLedgerError('MISMATCH', 'a recalculation states its reason');
    }
    this.results.push(r);
    return r;
  }

  /** The exact result as issued, even when a later recalculation superseded it. */
  issued(resultId: string): KpiResult {
    const r = this.results.find((x) => x.resultId === resultId);
    if (!r) throw new ResultLedgerError('NOT_FOUND', 'result not found');
    return r;
  }

  /** The latest result in force for one KPI, period and scope. */
  current(definitionId: string, periodStart: string, periodEnd: string, scopeRef: string): KpiResult | undefined {
    const superseded = new Set(this.results.map((x) => x.supersedes).filter(Boolean));
    return this.results.find((x) => x.definitionId === definitionId && x.periodStart === periodStart && x.periodEnd === periodEnd && x.scopeRef === scopeRef && !superseded.has(x.resultId));
  }

  all(): readonly KpiResult[] {
    return [...this.results];
  }
}

/** Builds a recalculation of an issued result under newer data or a newer definition version. */
export function recalculate(previous: KpiResult, args: EvaluateArgs, reason: string): KpiResult {
  return evaluateKpi({ ...args, supersedes: previous.resultId, supersedeReason: reason });
}
