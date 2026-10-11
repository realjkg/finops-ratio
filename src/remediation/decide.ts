// The policy engine: decide(proposal, tenantPolicy, state, now). Pure and deterministic:
// it reads state, never writes it, never calls the executor, and never throws.
//
// Trust boundary: the proposal must come from parseProposal and the policy from
// parseTenantPolicy (both are branded; anything else is refused or treated as an empty
// policy). The result is one of:
//   auto_execute      every gate below passed at once
//   require_approval  at least one gate failed; a different person must approve, then apply
//   deny              the request is not eligible even for the approval path
//
// Auto-execute needs ALL of: system origin; class enabled by the tenant; action
// autonomy-eligible in the registry; environment listed (prod only if listed AND the action
// is reversible); a fresh successful dry run; within the per-action count and cost caps;
// within the rolling-window count and cost caps; outside the cooldown of every resource and
// no execution in flight on it; kill switch off; outside every change-freeze window; circuit
// closed. Every failed gate is reported, and `reason` is the first in the fixed order below.
import { isParsedPolicy, type TenantPolicy } from './policy';
import { isParsedProposal } from './proposal';
import { addMoney, type Money } from './money';
import { isHalted, type RemediationState } from './state';
import type { Decision, Proposal, ReasonCode, RouteCode } from './types';

const NONE = 'none';

function result(kind: Decision['kind'], blockers: readonly ReasonCode[], policyVersion: string): Decision {
  return Object.freeze({
    kind,
    reason: blockers[0] ?? 'AUTO_ALL_GATES_PASSED',
    blockers: Object.freeze([...blockers]),
    policyVersion,
  });
}

export function decide(proposal: Proposal, tenantPolicy: TenantPolicy, state: RemediationState, now: number): Decision {
  try {
    if (!isParsedProposal(proposal)) return result('deny', ['BAD_PROPOSAL'], NONE);
    const policy = isParsedPolicy(tenantPolicy) ? tenantPolicy : null;
    const version = policy ? policy.version : NONE;
    if (proposal.tenant !== state.tenant || (policy && policy.tenant !== proposal.tenant)) return result('deny', ['TENANT_MISMATCH'], version);
    if (policy && policy.denyClasses.includes(proposal.action.class)) return result('deny', ['CLASS_DENIED'], version);

    const blockers: RouteCode[] = [];
    const block = (code: RouteCode, when: boolean): void => {
      if (when) blockers.push(code);
    };

    block('HUMAN_ORIGIN', proposal.origin !== 'system');
    // A non-finite or negative clock would make every time comparison below false, which reads as "passed".
    const timeOk = Number.isSafeInteger(now) && now >= 0;
    block('BAD_TIME', !timeOk);
    block('POLICY_INVALID', policy === null);

    const cls = policy && Object.hasOwn(policy.classes, proposal.action.class) ? policy.classes[proposal.action.class] : undefined;
    block('CLASS_NOT_ENABLED', policy !== null && cls === undefined);
    // Registry eligibility is re-checked here: a policy can never lift it.
    const eligible = proposal.action.autonomyEligible && proposal.action.risk === 'low' && proposal.action.reversible &&
      proposal.action.impact !== 'commitment';
    block('ACTION_NOT_ELIGIBLE', !eligible);

    if (policy && cls) {
      const env = proposal.env;
      const listed = cls.environments.includes(env);
      block('ENV_NOT_ALLOWED', env !== 'prod' && !listed);
      block('PROD_NOT_PERMITTED', env === 'prod' && !(listed && proposal.action.reversible));

      const dry = state.dryRuns.get(proposal.id);
      const fresh = timeOk && dry !== undefined && dry.ok && dry.at <= now && now - dry.at <= policy.dryRunMaxAgeMs;
      block('DRY_RUN_NOT_PASSED', !fresh);

      block('COUNT_CAP', proposal.blastRadius.resourceCount > cls.maxResourcesPerAction);
      const sameCurrency = proposal.impact.currency === policy.currency;
      block('CURRENCY_MISMATCH', !sameCurrency);
      block('COST_CAP', sameCurrency && proposal.blastRadius.costAtStakeMinor > cls.maxCostAtStakePerAction);

      if (timeOk) {
        // Rolling window, (now - length, now]: reservations of this class, counted when made so in-flight work counts.
        let resources = proposal.blastRadius.resourceCount;
        let cost: Money | null = { currency: policy.currency, minor: sameCurrency ? proposal.blastRadius.costAtStakeMinor : BigInt(0) };
        const floor = now - cls.window.lengthMs;
        for (const e of state.windowUsage) {
          if (e.actionClass !== proposal.action.class || e.at <= floor) continue; // a future timestamp still counts
          resources += e.resources;
          cost = cost && addMoney(cost, { currency: e.currency, minor: e.costMinor }); // null on a currency mix: fail closed
        }
        block('WINDOW_COUNT_CAP', resources > cls.window.maxResources);
        block('WINDOW_COST_CAP', sameCurrency && (cost === null || cost.minor > cls.window.maxCostAtStake));

        let cooling = false;
        let busy = false;
        for (const r of proposal.resourceIds) {
          const last = state.lastTouched.get(r);
          if (last !== undefined && now - last < cls.cooldownMs) cooling = true; // a future timestamp also blocks
          if (state.locks.has(r)) busy = true;
        }
        block('COOLDOWN', cooling);
        block('RESOURCE_BUSY', busy);
      }
    }

    block('KILL_SWITCH', isHalted(state));
    block('CHANGE_FREEZE', !policy || !timeOk ? false : policy.freezeWindows.some((w) => now >= w.startMs && now < w.endMs));
    block('CIRCUIT_OPEN', state.breakers.get(proposal.action.class)?.open === true);

    return result(blockers.length === 0 ? 'auto_execute' : 'require_approval', blockers, version);
  } catch {
    // Anything unexpected fails closed to a human.
    return result('require_approval', ['POLICY_INVALID'], NONE);
  }
}
