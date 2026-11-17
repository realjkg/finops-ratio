// A user-defined, versioned KPI and outcome definition (draft contract `kpi-definition/0-draft`, not a stable
// platform contract; see docs/design/value-model/KPI-DEFINITIONS.md). Users supply their own inputs, units, outcome
// conditions, project variables, formula and target. This module only checks a definition; it never stores one,
// reads a clock or evaluates observations. Problems name the field path and the rule, never a user-supplied value.
import { FormulaError, inferUnit, parseFormula, references } from './formula';
import { type Rational, cmp, isDecimalString, parseDecimal } from './rational';
import { type Unit, UnitError, currenciesOf, describeDims, isMoney, parseUnit, sameDimension } from './units';

export const KPI_DEFINITION_SCHEMA = 'kpi-definition/0-draft' as const;

/** What an input holds. `rate` values come only from the finance-approved register (loaded labor rate, unit value). */
export const INPUT_KINDS = ['count', 'quantity', 'money', 'percent', 'score', 'rate'] as const;
export type InputKind = (typeof INPUT_KINDS)[number];
/** How the source aggregates raw records into the one period value the formula reads. */
export const AGGREGATIONS = ['sum', 'count', 'count_distinct', 'mean', 'weighted_mean', 'median', 'p90', 'latest'] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];
/** Where an input's value may come from. `assumption` is a typed value with no source: it can never be `measured`. */
export const SOURCE_KINDS = ['connector', 'upload', 'manual_observation', 'assumption', 'finance_register', 'kpi_result'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface KpiInput {
  /** Formula identifier, e.g. `reviewMinutes`. */
  key: string;
  label: string;
  kind: InputKind;
  unit: string;
  /** Inclusive bounds as decimal strings; values outside them are refused, not clamped. */
  minimum?: string;
  maximum?: string;
  aggregation: Aggregation;
  sourceKinds: SourceKind[];
  description?: string;
}

/** A named condition an outcome must meet to count (applied by the source system, recorded here for review). */
export interface OutcomeRequirement {
  key: string;
  description: string;
}

/** A project variable that segments observations so before and after compare like with like. */
export interface ProjectDimension {
  key: string;
  label: string;
  /** Allowed values; absent means free text. */
  values?: string[];
}

export interface KpiTarget {
  value: string;
  unit: string;
  /** Who set the target: a policy reference, a named approver role, or the demo configuration. Never invented. */
  setBy: { kind: 'policy'; policyRef: string } | { kind: 'role'; role: string } | { kind: 'demo_configuration' };
}

export interface KpiDefinition {
  schemaVersion: typeof KPI_DEFINITION_SCHEMA;
  definitionId: string;
  version: number;
  tenantId: string;
  projectId: string;
  name: string;
  purpose: string;
  /** The unit of one successful outcome, e.g. `invoice`. It is a count unit. */
  outcomeUnit: string;
  direction: 'higher_is_better' | 'lower_is_better';
  inputs: KpiInput[];
  outcome: { requirements: OutcomeRequirement[]; qualityWindowDays?: number };
  dimensions: ProjectDimension[];
  calculation: { expression: string; resultUnit: string; scale: number; onZeroDenominator: 'unavailable' };
  periodGrain: 'day' | 'week' | 'month' | 'quarter' | 'year';
  target?: KpiTarget;
}

export const DEFINITION_LIMITS = Object.freeze({ inputs: 32, requirements: 16, dimensions: 12, dimensionValues: 50, text: 200, longText: 2000 });

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const KEY_RE = /^[a-z][A-Za-z0-9_]{0,39}$/;
const RESERVED_KEYS = new Set(['min', 'max', 'if', 'constructor', 'prototype', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const hasControl = (s: string) => {
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c === 127) return true; }
  return false;
};
const isText = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !hasControl(v);

/** Which unit families each input kind accepts. */
function kindMatchesUnit(kind: InputKind, u: Unit): boolean {
  const keys = Object.keys(u.dims);
  switch (kind) {
    case 'count': return keys.length === 1 && keys[0].startsWith('count:') && u.dims[keys[0]] === 1;
    case 'percent': return keys.length === 0;
    case 'score': return keys.length === 1 && keys[0].startsWith('score:');
    case 'money': return keys.length === 1 && keys[0].startsWith('currency:') && u.dims[keys[0]] === 1;
    case 'rate': return isMoney(u) && keys.length >= 2;
    case 'quantity': return !isMoney(u) && !keys.some((k) => k.startsWith('score:'));
  }
}

function strictKeys(v: Record<string, unknown>, allowed: readonly string[], at: string, p: string[]) {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) p.push(KEY_RE.test(k) ? `${at}.${k}: unknown field` : `${at}: unknown field (not printed)`);
}

export type DefinitionCheck = { ok: true; definition: KpiDefinition; resultUnit: Unit; inputUnits: Record<string, Unit> } | { ok: false; problems: string[] };

/** Validates a KPI definition: shape, custom inputs, units, outcome conditions, formula and target. */
export function checkKpiDefinition(v: unknown): DefinitionCheck {
  const p: string[] = [];
  if (!isRecord(v)) return { ok: false, problems: ['$: object'] };
  strictKeys(v, ['schemaVersion', 'definitionId', 'version', 'tenantId', 'projectId', 'name', 'purpose', 'outcomeUnit', 'direction', 'inputs', 'outcome', 'dimensions', 'calculation', 'periodGrain', 'target'], '$', p);
  if (v.schemaVersion !== KPI_DEFINITION_SCHEMA) p.push(`$.schemaVersion: equals ${KPI_DEFINITION_SCHEMA}`);
  for (const k of ['definitionId', 'tenantId', 'projectId'] as const) if (typeof v[k] !== 'string' || !ID_RE.test(v[k] as string)) p.push(`$.${k}: identifier (lower case, digits, . _ -)`);
  if (!Number.isSafeInteger(v.version) || (v.version as number) < 1) p.push('$.version: positive integer');
  if (!isText(v.name, DEFINITION_LIMITS.text)) p.push('$.name: text of 1 to 200 characters');
  if (!isText(v.purpose, DEFINITION_LIMITS.longText)) p.push('$.purpose: text of 1 to 2000 characters');
  if (!['higher_is_better', 'lower_is_better'].includes(v.direction as string)) p.push('$.direction: higher_is_better or lower_is_better');
  if (!['day', 'week', 'month', 'quarter', 'year'].includes(v.periodGrain as string)) p.push('$.periodGrain: day, week, month, quarter or year');

  let outcomeUnitOk = false;
  try {
    const u = parseUnit(v.outcomeUnit);
    outcomeUnitOk = kindMatchesUnit('count', u);
    if (!outcomeUnitOk) p.push('$.outcomeUnit: a count unit such as invoice or case');
  } catch {
    p.push('$.outcomeUnit: a count unit such as invoice or case');
  }

  // Custom inputs.
  const inputUnits: Record<string, Unit> = Object.create(null);
  if (!Array.isArray(v.inputs) || v.inputs.length < 1 || v.inputs.length > DEFINITION_LIMITS.inputs) {
    p.push(`$.inputs: 1 to ${DEFINITION_LIMITS.inputs} inputs`);
  } else {
    v.inputs.forEach((raw, i) => {
      const at = `$.inputs[${i}]`;
      if (!isRecord(raw)) return void p.push(`${at}: object`);
      strictKeys(raw, ['key', 'label', 'kind', 'unit', 'minimum', 'maximum', 'aggregation', 'sourceKinds', 'description'], at, p);
      const key = raw.key;
      const keyOk = typeof key === 'string' && KEY_RE.test(key) && !RESERVED_KEYS.has(key);
      if (!keyOk) p.push(`${at}.key: identifier starting with a lower-case letter (letters, digits, _), not a reserved word`);
      else if (Object.hasOwn(inputUnits, key as string)) p.push(`${at}.key: duplicate input key`);
      if (!isText(raw.label, DEFINITION_LIMITS.text)) p.push(`${at}.label: text of 1 to 200 characters`);
      if (raw.description !== undefined && !isText(raw.description, DEFINITION_LIMITS.longText)) p.push(`${at}.description: text of 1 to 2000 characters`);
      const kindOk = (INPUT_KINDS as readonly unknown[]).includes(raw.kind);
      if (!kindOk) p.push(`${at}.kind: one of ${INPUT_KINDS.join('|')}`);
      if (!(AGGREGATIONS as readonly unknown[]).includes(raw.aggregation)) p.push(`${at}.aggregation: one of ${AGGREGATIONS.join('|')}`);
      let unit: Unit | null = null;
      try {
        unit = parseUnit(raw.unit);
      } catch (e) {
        p.push(`${at}.unit: ${e instanceof UnitError ? e.message : 'invalid unit'}`);
      }
      if (unit && kindOk && !kindMatchesUnit(raw.kind as InputKind, unit)) p.push(`${at}.unit: does not fit kind ${String(raw.kind)} (${describeDims(unit)})`);
      for (const b of ['minimum', 'maximum'] as const) if (raw[b] !== undefined && !isDecimalString(raw[b])) p.push(`${at}.${b}: plain decimal string`);
      if (isDecimalString(raw.minimum) && isDecimalString(raw.maximum) && cmp(parseDecimal(raw.minimum) as Rational, parseDecimal(raw.maximum) as Rational) > 0) p.push(`${at}.maximum: must not be less than the lower bound`);
      const sk = raw.sourceKinds;
      if (!Array.isArray(sk) || sk.length < 1 || sk.some((s) => !(SOURCE_KINDS as readonly unknown[]).includes(s)) || new Set(sk).size !== sk.length) {
        p.push(`${at}.sourceKinds: 1 or more distinct of ${SOURCE_KINDS.join('|')}`);
      } else if (raw.kind === 'rate' && (sk.length !== 1 || sk[0] !== 'finance_register')) {
        p.push(`${at}.sourceKinds: a rate comes only from finance_register`);
      } else if (raw.kind !== 'rate' && sk.includes('finance_register')) {
        p.push(`${at}.sourceKinds: finance_register supplies rates only`);
      }
      if (keyOk && unit && !Object.hasOwn(inputUnits, key as string)) inputUnits[key as string] = unit;
    });
  }

  // Outcome conditions: what makes one outcome count.
  const o = v.outcome;
  if (!isRecord(o)) p.push('$.outcome: object');
  else {
    strictKeys(o, ['requirements', 'qualityWindowDays'], '$.outcome', p);
    const reqs = o.requirements;
    if (!Array.isArray(reqs) || reqs.length < 1 || reqs.length > DEFINITION_LIMITS.requirements) p.push(`$.outcome.requirements: 1 to ${DEFINITION_LIMITS.requirements} conditions (an outcome with no quality condition is not a successful outcome)`);
    else {
      const seen = new Set<string>();
      reqs.forEach((r, i) => {
        const at = `$.outcome.requirements[${i}]`;
        if (!isRecord(r)) return void p.push(`${at}: object`);
        strictKeys(r, ['key', 'description'], at, p);
        if (typeof r.key !== 'string' || !KEY_RE.test(r.key)) p.push(`${at}.key: identifier`);
        else if (seen.has(r.key)) p.push(`${at}.key: duplicate condition`);
        else seen.add(r.key);
        if (!isText(r.description, DEFINITION_LIMITS.longText)) p.push(`${at}.description: text of 1 to 2000 characters`);
      });
    }
    if (o.qualityWindowDays !== undefined && (!Number.isSafeInteger(o.qualityWindowDays) || (o.qualityWindowDays as number) < 1 || (o.qualityWindowDays as number) > 366)) p.push('$.outcome.qualityWindowDays: integer from 1 to 366');
  }

  // Project variables.
  if (!Array.isArray(v.dimensions) || v.dimensions.length > DEFINITION_LIMITS.dimensions) p.push(`$.dimensions: 0 to ${DEFINITION_LIMITS.dimensions} project variables`);
  else {
    const seen = new Set<string>();
    v.dimensions.forEach((d, i) => {
      const at = `$.dimensions[${i}]`;
      if (!isRecord(d)) return void p.push(`${at}: object`);
      strictKeys(d, ['key', 'label', 'values'], at, p);
      if (typeof d.key !== 'string' || !KEY_RE.test(d.key)) p.push(`${at}.key: identifier`);
      else if (seen.has(d.key) || Object.hasOwn(inputUnits, d.key)) p.push(`${at}.key: duplicate of another variable or input`);
      else seen.add(d.key);
      if (!isText(d.label, DEFINITION_LIMITS.text)) p.push(`${at}.label: text of 1 to 200 characters`);
      if (d.values !== undefined && (!Array.isArray(d.values) || d.values.length < 1 || d.values.length > DEFINITION_LIMITS.dimensionValues || d.values.some((x) => !isText(x, DEFINITION_LIMITS.text)) || new Set(d.values).size !== d.values.length)) {
        p.push(`${at}.values: 1 to ${DEFINITION_LIMITS.dimensionValues} distinct short texts`);
      }
    });
  }

  // Calculation: the formula must read only declared inputs, use all of them, and produce the declared unit.
  let resultUnit: Unit | null = null;
  const c = v.calculation;
  if (!isRecord(c)) p.push('$.calculation: object');
  else {
    strictKeys(c, ['expression', 'resultUnit', 'scale', 'onZeroDenominator'], '$.calculation', p);
    if (c.onZeroDenominator !== 'unavailable') p.push('$.calculation.onZeroDenominator: unavailable (a zero denominator is never shown as 0)');
    if (!Number.isSafeInteger(c.scale) || (c.scale as number) < 0 || (c.scale as number) > 12) p.push('$.calculation.scale: integer from 0 to 12');
    try {
      resultUnit = parseUnit(c.resultUnit);
    } catch (e) {
      p.push(`$.calculation.resultUnit: ${e instanceof UnitError ? e.message : 'invalid unit'}`);
    }
    try {
      const tree = parseFormula(c.expression);
      const refs = references(tree);
      for (const k of Object.keys(inputUnits)) if (!refs.includes(k)) p.push(`$.calculation.expression: input ${k} is declared but never used`);
      const inferred = inferUnit(tree, (name) => (Object.hasOwn(inputUnits, name) ? inputUnits[name] : undefined));
      if (resultUnit && !sameDimension(inferred, resultUnit)) p.push(`$.calculation.resultUnit: the formula produces ${describeDims(inferred)}, not ${describeDims(resultUnit)}`);
      if (currenciesOf(inferred).length > 1) p.push('$.calculation.expression: mixes currencies (never converted or summed across currencies)');
    } catch (e) {
      p.push(`$.calculation.expression: ${e instanceof FormulaError ? e.message : 'invalid formula'}`);
    }
  }

  // Target: in the result's dimension, with an honest setter.
  const t = v.target;
  if (t !== undefined) {
    if (!isRecord(t)) p.push('$.target: object');
    else {
      strictKeys(t, ['value', 'unit', 'setBy'], '$.target', p);
      if (!isDecimalString(t.value)) p.push('$.target.value: plain decimal string');
      try {
        const tu = parseUnit(t.unit);
        if (resultUnit && !sameDimension(tu, resultUnit)) p.push('$.target.unit: must match the result dimension');
      } catch {
        p.push('$.target.unit: invalid unit');
      }
      const s = t.setBy;
      const okSetter = isRecord(s) && (
        (s.kind === 'policy' && typeof s.policyRef === 'string' && ID_RE.test(s.policyRef) && Object.keys(s).length === 2) ||
        (s.kind === 'role' && typeof s.role === 'string' && ID_RE.test(s.role) && Object.keys(s).length === 2) ||
        (s.kind === 'demo_configuration' && Object.keys(s).length === 1));
      if (!okSetter) p.push('$.target.setBy: {kind:policy,policyRef} | {kind:role,role} | {kind:demo_configuration}');
    }
  }

  if (p.length || !resultUnit || !outcomeUnitOk) return { ok: false, problems: p.length ? p : ['$: invalid'] };
  return { ok: true, definition: v as unknown as KpiDefinition, resultUnit, inputUnits };
}

/**
 * The canonical semantic form of a definition: sorted keys, so two definitions with the same meaning compare equal
 * regardless of key order. Labels and descriptions are included: changing what a user reads about a KPI is a change.
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Fields whose change alters what is measured. A new version that changes any of them breaks comparability. */
export const MEASUREMENT_FIELDS = ['outcomeUnit', 'direction', 'inputs', 'outcome', 'dimensions', 'calculation', 'periodGrain'] as const;

export type Comparability =
  | { comparable: true; basis: 'same_version' | 'measurement_unchanged' | 'reviewed_mapping'; mappingRef?: string }
  | { comparable: false; changed: string[] };

/**
 * Whether results computed under two definition versions may be compared (before vs after). Same version, or a new
 * version whose measurement fields are identical (only name, purpose or target changed), or a reviewed mapping.
 */
export function comparability(a: KpiDefinition, b: KpiDefinition, reviewedMappingRef?: string): Comparability {
  if (a.tenantId !== b.tenantId || a.definitionId !== b.definitionId) return { comparable: false, changed: ['definitionId'] };
  if (a.version === b.version) return { comparable: true, basis: 'same_version' };
  const changed = MEASUREMENT_FIELDS.filter((f) => canonicalJson(a[f]) !== canonicalJson(b[f]));
  if (changed.length === 0) return { comparable: true, basis: 'measurement_unchanged' };
  if (reviewedMappingRef && ID_RE.test(reviewedMappingRef)) return { comparable: true, basis: 'reviewed_mapping', mappingRef: reviewedMappingRef };
  return { comparable: false, changed: [...changed] };
}
