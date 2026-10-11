// Proposal parsing. Trust boundary: a proposal's input (id, tenant, action, params, env, team,
// impact figures) is untrusted. `parseProposal` is the ONLY way to obtain a Proposal; the
// result is deeply frozen and registered in a module WeakSet, so `decide` can refuse any
// hand-built object. The origin ('system' or 'human') is set by the entry point and is never
// read from input. Derived facts (action class, risk, reversibility, resource list and count)
// come from the registry and the validated params, never from the caller.
import { DEPLOY_ENVS, isOneOf } from '@/identity/types';
import { isCurrency, parseMinor } from './money';
import { validateParams, type ParamErrorCode } from './schema';
import type { ActionRegistry } from './registry';
import { LIMITS, type Proposal, type ProposalOrigin } from './types';

export type ProposalErrorCode =
  | 'PROPOSAL_NOT_OBJECT' | 'PROPOSAL_UNKNOWN_KEY' | 'PROPOSAL_FIELD' | 'PROPOSAL_UNKNOWN_ACTION' | 'PROPOSAL_PARAMS'
  | 'PROPOSAL_IMPACT' | 'PROPOSAL_NO_RESOURCES' | 'PROPOSAL_TOO_MANY_RESOURCES';

export const PROPOSAL_ERROR_TEXT: Readonly<Record<ProposalErrorCode, string>> = Object.freeze({
  PROPOSAL_NOT_OBJECT: 'Proposal must be a plain object',
  PROPOSAL_UNKNOWN_KEY: 'Unknown proposal field',
  PROPOSAL_FIELD: 'Proposal field is missing or invalid',
  PROPOSAL_UNKNOWN_ACTION: 'Unknown action',
  PROPOSAL_PARAMS: 'Action parameters are invalid',
  PROPOSAL_IMPACT: 'Impact figures are invalid',
  PROPOSAL_NO_RESOURCES: 'Action touches no resources',
  PROPOSAL_TOO_MANY_RESOURCES: 'Action touches too many resources',
});

export type ProposalResult =
  | { readonly ok: true; readonly proposal: Proposal }
  | { readonly ok: false; readonly code: ProposalErrorCode; /** A fixed field name from this module. */ readonly field?: string; readonly paramCode?: ParamErrorCode; readonly paramField?: string };

const KEYS = ['id', 'tenant', 'actionId', 'params', 'env', 'team', 'impact'] as const;
const IMPACT_KEYS = ['currency', 'estimatedMonthlySavingsMinor', 'costAtStakeMinor'] as const;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TEAM = /^[A-Za-z0-9][A-Za-z0-9 ._&-]{0,63}$/;

const PARSED = new WeakSet<object>();
/** True only for objects produced by parseProposal. */
export const isParsedProposal = (p: unknown): p is Proposal => typeof p === 'object' && p !== null && PARSED.has(p);

function plainData(v: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(v).length > 0) return null;
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.getOwnPropertyNames(v)) {
      if (!keys.includes(k)) return null; // unknown key, including __proto__
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d || !('value' in d)) return null; // accessor
      out[k] = d.value;
    }
    return out;
  } catch {
    return null;
  }
}

export function parseProposal(registry: ActionRegistry, input: unknown, origin: ProposalOrigin): ProposalResult {
  const bad = (code: ProposalErrorCode, field?: string): ProposalResult => ({ ok: false, code, ...(field === undefined ? {} : { field }) });
  try {
    if (origin !== 'system' && origin !== 'human') return bad('PROPOSAL_FIELD', 'origin');
    // Distinguish "not an object" from "unknown key" without echoing either.
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return bad('PROPOSAL_NOT_OBJECT');
    const o = plainData(input, KEYS);
    if (!o) return bad('PROPOSAL_UNKNOWN_KEY');
    for (const k of ['id', 'tenant', 'actionId', 'env', 'team'] as const) if (o[k] === undefined) return bad('PROPOSAL_FIELD', k);
    if (typeof o.id !== 'string' || !ID_PATTERN.test(o.id)) return bad('PROPOSAL_FIELD', 'id');
    if (typeof o.tenant !== 'string' || !ID_PATTERN.test(o.tenant)) return bad('PROPOSAL_FIELD', 'tenant');
    if (!isOneOf(DEPLOY_ENVS, o.env)) return bad('PROPOSAL_FIELD', 'env');
    if (typeof o.team !== 'string' || !TEAM.test(o.team)) return bad('PROPOSAL_FIELD', 'team');
    const def = registry.get(o.actionId);
    if (!def) return bad('PROPOSAL_UNKNOWN_ACTION');

    const params = validateParams(def.params, o.params);
    if (!params.ok) return { ok: false, code: 'PROPOSAL_PARAMS', paramCode: params.code, ...(params.field === undefined ? {} : { paramField: params.field }) };
    if (def.check && !def.check(params.value)) return { ok: false, code: 'PROPOSAL_PARAMS', paramCode: 'PARAMS_INVALID' };
    const resourceIds = Object.freeze([...def.resources(params.value)]);
    if (resourceIds.length === 0) return bad('PROPOSAL_NO_RESOURCES');
    if (resourceIds.length > def.hardMaxResources || resourceIds.length > LIMITS.maxResourcesHard) return bad('PROPOSAL_TOO_MANY_RESOURCES');

    const imp = plainData(o.impact, IMPACT_KEYS);
    if (!imp || !isCurrency(imp.currency)) return bad('PROPOSAL_IMPACT');
    const savings = parseMinor(imp.estimatedMonthlySavingsMinor);
    const cost = parseMinor(imp.costAtStakeMinor);
    // Savings above the cost at stake are implausible for a monthly figure and are rejected, not clamped.
    if (savings === null || cost === null || savings > cost) return bad('PROPOSAL_IMPACT');
    const impact = Object.freeze({ currency: imp.currency, estimatedMonthlySavingsMinor: savings, costAtStakeMinor: cost });

    const proposal: Proposal = Object.freeze({
      id: o.id, tenant: o.tenant, origin, env: o.env, team: o.team,
      action: Object.freeze({ id: def.id, class: def.class, risk: def.risk, reversible: def.reversible, autonomyEligible: def.autonomyEligible, impact: def.impact }),
      params: params.value, resourceIds, impact,
      blastRadius: Object.freeze({ resourceCount: resourceIds.length, currency: impact.currency, costAtStakeMinor: cost }),
    });
    PARSED.add(proposal);
    return { ok: true, proposal };
  } catch {
    return bad('PROPOSAL_NOT_OBJECT'); // a throwing Proxy or getter
  }
}
