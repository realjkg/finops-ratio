// Policy bundles, compiled once at load (ADR-0001 slice C1; review rounds 1-2). A compiled bundle is a strict deep copy
// (structuredClone: getters read once, symbol keys and prototypes dropped), validated as policy-bundle/1 and frozen.
// Only compileBundle makes one; a look-alike object is validated as a raw bundle. Supersession is decided at
// evaluation time (current()): of each id, the highest version EFFECTIVE at now; versions not yet effective wait.
import { instantBefore, validatePolicyBundle, type Entitlement, type Policy, type PolicyBundle } from '../contracts';

export type BundleFailure = 'policy_expired' | 'policy_invalid';
export interface CompiledBundle {
  readonly bundle: PolicyBundle;
  /** All policies with their index in `bundle.policies` (a decision names its policy as `p<index>`). */
  readonly policies: readonly { policy: Policy; index: number }[];
  readonly entitlements: readonly Entitlement[];
}
export type Selected = { ok: true; compiled: CompiledBundle; lkg?: { contentSha256: string; reason: BundleFailure } }
  | { ok: false; compiled: CompiledBundle | null; failure: BundleFailure; codes: string[] };

/** Reserved for refusal placeholders: refused in request contexts and bundle ids, so a placeholder cannot be forged. */
export const RESERVED_PREFIX = 'refused:';
/** A tool the gateway could not identify: never listable (a bundle naming one is refused), refused by the access decision. */
export const UNIDENTIFIED_PREFIX = 'unidentified:';
const toolIdsOf = (b: PolicyBundle) => b.policies.flatMap((p) => p.rules.flatMap((r) => (r.condition.kind === 'tool' ? r.condition.tools : [])));
/** Advisory (non-gating): tool ids without a gateway namespace (fn:, mcp:, type:, container:, skill:, prompt:), which never match a gateway identity. */
export const unnamespacedTools = (c: CompiledBundle) => [...new Set(toolIdsOf(c.bundle).filter((t) => !/^(fn|mcp|type|container|skill|prompt)(-h)?:/.test(t)))];
const COMPILED = new WeakSet<object>();
const freeze = <T>(x: T): T => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
type Versioned = { id: string; version: number; effectiveFrom: string; effectiveTo?: string };
/** Per id, the highest version effective on `day` (YYYY-MM-DD). Gap: no effective version, no rule. Revival: a lower open-ended version applies again after a higher one ends. */
export function current<T>(xs: readonly T[], of: (x: T) => Versioned, day: string): T[] {
  const live = xs.filter((x) => { const v = of(x); return v.effectiveFrom <= day && (v.effectiveTo === undefined || day < v.effectiveTo); });
  const top = new Map<string, number>();
  for (const x of live) top.set(of(x).id, Math.max(top.get(of(x).id) ?? 0, of(x).version));
  return live.filter((x) => top.get(of(x).id) === of(x).version);
}

export const isCompiled = (x: unknown): x is CompiledBundle => typeof x === 'object' && x !== null && COMPILED.has(x);

/** Validate once: the compiled bundle, or null when the input is not a valid policy-bundle/1. Never throws. */
export function compileBundle(raw: unknown): CompiledBundle | null {
  if (isCompiled(raw)) return raw;
  try {
    const r = validatePolicyBundle(structuredClone(raw));
    if (!r.ok || r.value.bundleId.startsWith(RESERVED_PREFIX) || toolIdsOf(r.value).some((x) => x.startsWith(UNIDENTIFIED_PREFIX))) return null;
    const b = r.value;
    const c: CompiledBundle = freeze({ bundle: b, policies: b.policies.map((p, index) => ({ policy: p, index })), entitlements: b.entitlements });
    COMPILED.add(c);
    return c;
  } catch {
    return null;
  }
}

function usable(c: CompiledBundle | null, tenantId: string, now: string): { failure?: BundleFailure; code?: string } {
  if (!c) return { failure: 'policy_invalid', code: 'BUNDLE_INVALID' };
  if (c.bundle.tenantId !== tenantId) return { failure: 'policy_invalid', code: 'BUNDLE_TENANT_MISMATCH' };
  if (instantBefore(now, c.bundle.issuedAt)) return { failure: 'policy_invalid', code: 'BUNDLE_NOT_YET_VALID' };
  if (!instantBefore(now, c.bundle.notAfter)) return { failure: 'policy_expired', code: 'BUNDLE_EXPIRED' };
  return {};
}

/** The bundle to evaluate: the current one when usable, else an approved last-known-good within its own validity. */
export function selectBundle(current: unknown, lastKnownGood: unknown, tenantId: string, now: string): Selected {
  const cur = compileBundle(current);
  const u = usable(cur, tenantId, now);
  if (!u.failure && cur) return { ok: true, compiled: cur };
  const failure = u.failure as BundleFailure;
  if (lastKnownGood === undefined) return { ok: false, compiled: cur, failure, codes: [u.code as string] };
  const lkg = compileBundle(lastKnownGood);
  if (lkg && !usable(lkg, tenantId, now).failure && lkg.bundle.lastKnownGoodApproved === true) return { ok: true, compiled: lkg, lkg: { contentSha256: lkg.bundle.contentSha256, reason: failure } };
  return { ok: false, compiled: cur, failure, codes: [u.code as string, 'LAST_KNOWN_GOOD_REFUSED'] };
}
