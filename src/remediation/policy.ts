// Tenant autonomy policy. Trust boundary: a policy is configuration owned by a human with
// authority over the tenant; it is parsed strictly and fails closed. Autonomy is OFF unless a
// class is listed in `classes`. Only autonomy-eligible classes can be listed (the registry
// decides, not the tenant), every cap is required (nothing defaults to "unlimited"), and an
// environment is allowed only if it is listed ('prod' included). `parseTenantPolicy` is the
// only way to obtain a TenantPolicy; `decide` treats any other object as an empty policy.
import { DEPLOY_ENVS, isOneOf, type DeployEnv } from '@/identity/types';
import { isCurrency, parseMinor } from './money';
import { ID_PATTERN } from './proposal';
import type { ActionRegistry } from './registry';
import { LIMITS } from './types';

export interface ClassPolicy {
  /** Environments in which this class may run without a human. 'prod' only if listed (and the action is reversible). */
  readonly environments: readonly DeployEnv[];
  readonly maxResourcesPerAction: number;
  readonly maxCostAtStakePerAction: bigint;
  readonly window: {
    readonly lengthMs: number;
    readonly maxResources: number;
    readonly maxCostAtStake: bigint;
  };
  /** Minimum time between two touches of the same resource. */
  readonly cooldownMs: number;
}

export interface FreezeWindow {
  /** Epoch ms, inclusive. */
  readonly startMs: number;
  /** Epoch ms, exclusive. */
  readonly endMs: number;
}

export interface TenantPolicy {
  readonly version: string;
  readonly tenant: string;
  /** The currency every cap is expressed in. A proposal in another currency cannot be checked, so it goes to a human. */
  readonly currency: string;
  /** Consecutive execution failures that open the circuit for a class. */
  readonly circuitBreakerThreshold: number;
  /** How long a successful dry run stays valid evidence for auto-execute. */
  readonly dryRunMaxAgeMs: number;
  /** How long a human approval stays usable. */
  readonly approvalMaxAgeMs: number;
  readonly freezeWindows: readonly FreezeWindow[];
  /** Classes that may not run at all, by any path. */
  readonly denyClasses: readonly string[];
  /** Enabled classes only. Absent means autonomy is off for that class. */
  readonly classes: Readonly<Record<string, ClassPolicy>>;
}

export type PolicyErrorCode =
  | 'POLICY_NOT_OBJECT' | 'POLICY_UNKNOWN_KEY' | 'POLICY_FIELD' | 'POLICY_UNKNOWN_CLASS' | 'POLICY_CLASS_NOT_ELIGIBLE'
  | 'POLICY_TOO_MANY' | 'POLICY_CONTRADICTION';

export const POLICY_ERROR_TEXT: Readonly<Record<PolicyErrorCode, string>> = Object.freeze({
  POLICY_NOT_OBJECT: 'Policy must be a plain object',
  POLICY_UNKNOWN_KEY: 'Unknown policy field',
  POLICY_FIELD: 'Policy field is missing or invalid',
  POLICY_UNKNOWN_CLASS: 'Policy names an unknown action class',
  POLICY_CLASS_NOT_ELIGIBLE: 'Action class is not eligible for autonomy',
  POLICY_TOO_MANY: 'Policy has too many entries',
  POLICY_CONTRADICTION: 'Policy enables and denies the same class',
});

export type PolicyResult =
  | { readonly ok: true; readonly policy: TenantPolicy }
  | { readonly ok: false; readonly code: PolicyErrorCode; /** A fixed field name from this module. */ readonly field?: string };

const PARSED = new WeakSet<object>();
/** True only for objects produced by parseTenantPolicy or createEmptyPolicy. */
export const isParsedPolicy = (p: unknown): p is TenantPolicy => typeof p === 'object' && p !== null && PARSED.has(p);

const TOP_KEYS = ['version', 'tenant', 'currency', 'circuitBreakerThreshold', 'dryRunMaxAgeMs', 'approvalMaxAgeMs', 'freezeWindows', 'denyClasses', 'classes'] as const;
const CLASS_KEYS = ['environments', 'maxResourcesPerAction', 'maxCostAtStakePerAction', 'window', 'cooldownMs'] as const;
const WINDOW_KEYS = ['lengthMs', 'maxResources', 'maxCostAtStake'] as const;
const FREEZE_KEYS = ['startMs', 'endMs'] as const;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const inRange = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** Own data properties of a plain object, restricted to known keys; null on anything else. */
function plain(v: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(v).length > 0) return null;
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.getOwnPropertyNames(v)) {
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!keys.includes(k) || !d || !('value' in d)) return null;
      out[k] = d.value;
    }
    return out;
  } catch {
    return null;
  }
}

/** A dense array of at most `max` elements, read once; null otherwise. */
function denseArray(v: unknown, max: number): unknown[] | 'too_many' | null {
  try {
    if (!Array.isArray(v)) return null;
    const n = v.length;
    if (n > max) return 'too_many';
    const out: unknown[] = [];
    for (let i = 0; i < n; i += 1) {
      const d = Object.getOwnPropertyDescriptor(v, i);
      if (!d || !('value' in d)) return null;
      out.push(d.value);
    }
    return out;
  } catch {
    return null;
  }
}

export function parseTenantPolicy(registry: ActionRegistry, input: unknown): PolicyResult {
  const bad = (code: PolicyErrorCode, field?: string): PolicyResult => ({ ok: false, code, ...(field === undefined ? {} : { field }) });
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return bad('POLICY_NOT_OBJECT');
    const o = plain(input, TOP_KEYS);
    if (!o) return bad('POLICY_UNKNOWN_KEY');
    if (typeof o.version !== 'string' || !VERSION.test(o.version)) return bad('POLICY_FIELD', 'version');
    if (typeof o.tenant !== 'string' || !ID_PATTERN.test(o.tenant)) return bad('POLICY_FIELD', 'tenant');
    if (!isCurrency(o.currency)) return bad('POLICY_FIELD', 'currency');
    if (!inRange(o.circuitBreakerThreshold, 1, 20)) return bad('POLICY_FIELD', 'circuitBreakerThreshold');
    if (!inRange(o.dryRunMaxAgeMs, 1_000, 3_600_000)) return bad('POLICY_FIELD', 'dryRunMaxAgeMs');
    if (!inRange(o.approvalMaxAgeMs, 1_000, LIMITS.maxApprovalAgeMs)) return bad('POLICY_FIELD', 'approvalMaxAgeMs');

    const freezeRaw = o.freezeWindows === undefined ? [] : denseArray(o.freezeWindows, LIMITS.maxFreezeWindows);
    if (freezeRaw === 'too_many') return bad('POLICY_TOO_MANY', 'freezeWindows');
    if (!freezeRaw) return bad('POLICY_FIELD', 'freezeWindows');
    const freezeWindows: FreezeWindow[] = [];
    for (const f of freezeRaw) {
      const w = plain(f, FREEZE_KEYS);
      if (!w || !inRange(w.startMs, 0, Number.MAX_SAFE_INTEGER) || !inRange(w.endMs, 0, Number.MAX_SAFE_INTEGER) ||
          (w.endMs as number) <= (w.startMs as number) || (w.endMs as number) - (w.startMs as number) > LIMITS.maxFreezeMs) {
        return bad('POLICY_FIELD', 'freezeWindows');
      }
      freezeWindows.push(Object.freeze({ startMs: w.startMs as number, endMs: w.endMs as number }));
    }

    const denyRaw = o.denyClasses === undefined ? [] : denseArray(o.denyClasses, LIMITS.maxPolicyClasses);
    if (denyRaw === 'too_many') return bad('POLICY_TOO_MANY', 'denyClasses');
    if (!denyRaw) return bad('POLICY_FIELD', 'denyClasses');
    const known = new Set(registry.classes());
    for (const c of denyRaw) if (typeof c !== 'string' || !known.has(c)) return bad('POLICY_UNKNOWN_CLASS', 'denyClasses');
    if (new Set(denyRaw).size !== denyRaw.length) return bad('POLICY_FIELD', 'denyClasses');

    const classes: Record<string, ClassPolicy> = Object.create(null);
    if (o.classes !== undefined) {
      if (o.classes === null || typeof o.classes !== 'object' || Array.isArray(o.classes)) return bad('POLICY_FIELD', 'classes');
      const proto = Object.getPrototypeOf(o.classes);
      if (proto !== Object.prototype && proto !== null) return bad('POLICY_FIELD', 'classes');
      if (Object.getOwnPropertySymbols(o.classes).length > 0) return bad('POLICY_FIELD', 'classes');
      const names = Object.getOwnPropertyNames(o.classes);
      if (names.length > LIMITS.maxPolicyClasses) return bad('POLICY_TOO_MANY', 'classes');
      for (const name of names) {
        if (!known.has(name)) return bad('POLICY_UNKNOWN_CLASS', 'classes'); // also catches __proto__ and constructor
        if (!registry.isClassEligible(name)) return bad('POLICY_CLASS_NOT_ELIGIBLE', 'classes');
        if (denyRaw.includes(name)) return bad('POLICY_CONTRADICTION', 'classes');
        const d = Object.getOwnPropertyDescriptor(o.classes, name);
        const c = d && 'value' in d ? plain(d.value, CLASS_KEYS) : null;
        if (!c) return bad('POLICY_FIELD', 'classes');
        const envs = denseArray(c.environments, DEPLOY_ENVS.length);
        if (!Array.isArray(envs) || envs.length === 0 || !envs.every((e) => isOneOf(DEPLOY_ENVS, e)) || new Set(envs).size !== envs.length) {
          return bad('POLICY_FIELD', 'environments');
        }
        const hard = registry.classHardMax(name);
        if (!inRange(c.maxResourcesPerAction, 1, hard)) return bad('POLICY_FIELD', 'maxResourcesPerAction');
        const perAction = parseMinor(c.maxCostAtStakePerAction);
        if (perAction === null) return bad('POLICY_FIELD', 'maxCostAtStakePerAction');
        const w = plain(c.window, WINDOW_KEYS);
        if (!w || !inRange(w.lengthMs, 60_000, LIMITS.maxWindowMs) || !inRange(w.maxResources, 1, 10_000)) return bad('POLICY_FIELD', 'window');
        const windowCost = parseMinor(w.maxCostAtStake);
        if (windowCost === null) return bad('POLICY_FIELD', 'window');
        if (!inRange(c.cooldownMs, 1_000, LIMITS.maxCooldownMs)) return bad('POLICY_FIELD', 'cooldownMs');
        classes[name] = Object.freeze({
          environments: Object.freeze([...(envs as DeployEnv[])]),
          maxResourcesPerAction: c.maxResourcesPerAction as number,
          maxCostAtStakePerAction: perAction,
          window: Object.freeze({ lengthMs: w.lengthMs as number, maxResources: w.maxResources as number, maxCostAtStake: windowCost }),
          cooldownMs: c.cooldownMs as number,
        });
      }
    }

    const policy: TenantPolicy = Object.freeze({
      version: o.version, tenant: o.tenant, currency: o.currency,
      circuitBreakerThreshold: o.circuitBreakerThreshold, dryRunMaxAgeMs: o.dryRunMaxAgeMs, approvalMaxAgeMs: o.approvalMaxAgeMs,
      freezeWindows: Object.freeze(freezeWindows), denyClasses: Object.freeze([...(denyRaw as string[])]), classes: Object.freeze(classes),
    });
    PARSED.add(policy);
    return { ok: true, policy };
  } catch {
    return bad('POLICY_NOT_OBJECT');
  }
}

/** The default for every tenant: autonomy off, nothing denied, a one-day approval lifetime. */
export function createEmptyPolicy(tenant: string): TenantPolicy {
  if (typeof tenant !== 'string' || !ID_PATTERN.test(tenant)) throw new Error('Invalid tenant');
  const policy: TenantPolicy = Object.freeze({
    version: 'default-off', tenant, currency: 'USD', circuitBreakerThreshold: 3, dryRunMaxAgeMs: 300_000, approvalMaxAgeMs: 86_400_000,
    freezeWindows: Object.freeze([]), denyClasses: Object.freeze([]), classes: Object.freeze(Object.create(null) as Record<string, ClassPolicy>),
  });
  PARSED.add(policy);
  return policy;
}
