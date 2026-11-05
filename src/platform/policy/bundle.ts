// Policy bundles, compiled once at load (ADR-0001 slice C1; review round 1 L1, L4, L5). A compiled bundle is a strict
// deep copy (structuredClone: getters read once, symbol keys and prototypes dropped), validated as policy-bundle/1,
// frozen, and with superseded versions removed: of each policy or entitlement id only the highest version is
// evaluated. Only compileBundle makes one; a look-alike object is validated as a raw bundle.
import { instantBefore, validatePolicyBundle, type Entitlement, type Policy, type PolicyBundle } from '../contracts';

export type BundleFailure = 'policy_expired' | 'policy_invalid';
export interface CompiledBundle {
  readonly bundle: PolicyBundle;
  /** Current policies with their index in `bundle.policies` (a decision names its policy as `p<index>`). */
  readonly policies: readonly { policy: Policy; index: number }[];
  readonly entitlements: readonly Entitlement[];
}
export type Selected = { ok: true; compiled: CompiledBundle; lkg?: { contentSha256: string; reason: BundleFailure } }
  | { ok: false; compiled: CompiledBundle | null; failure: BundleFailure; codes: string[] };

const COMPILED = new WeakSet<object>();
const freeze = <T>(x: T): T => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
function latest<T extends { version: number }>(xs: readonly T[], id: (x: T) => string): (x: T) => boolean {
  const top = new Map<string, number>();
  for (const x of xs) top.set(id(x), Math.max(top.get(id(x)) ?? 0, x.version));
  return (x) => top.get(id(x)) === x.version;
}

export const isCompiled = (x: unknown): x is CompiledBundle => typeof x === 'object' && x !== null && COMPILED.has(x);

/** Validate once: the compiled bundle, or null when the input is not a valid policy-bundle/1. Never throws. */
export function compileBundle(raw: unknown): CompiledBundle | null {
  if (isCompiled(raw)) return raw;
  try {
    const r = validatePolicyBundle(structuredClone(raw));
    if (!r.ok) return null;
    const b = r.value;
    const policy = latest(b.policies, (p) => p.policyId);
    const entitlement = latest(b.entitlements, (e) => e.entitlementId);
    const c: CompiledBundle = freeze({ bundle: b, policies: b.policies.map((p, index) => ({ policy: p, index })).filter((x) => policy(x.policy)), entitlements: b.entitlements.filter(entitlement) });
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
