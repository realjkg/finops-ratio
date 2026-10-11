// The policy engine: autonomy is off by default, and every gate blocks on its own.
import { describe, expect, it } from 'vitest';
import { decide } from './decide';
import { parseProposal } from './proposal';
import { ACTION_REGISTRY } from './registry';
import type { Proposal } from './types';
import {
  CX, HOUR, MINUTE, NOW, TENANT, classPolicy, commitmentInput, deleteVolumeInput, emptyPolicy, enabledPolicy, mkEnv, mustPolicy, mustProposal,
  rawPolicy, resizeInput, scheduleInput, stopInput,
} from './testkit';

/** An env where the dry run for `p` already passed at NOW. */
function ready(p: Proposal, policy = enabledPolicy()) {
  const e = mkEnv({ policy });
  e.state.dryRuns.set(p.id, { ok: true, at: NOW });
  return e;
}
const only = (p: Proposal, e: ReturnType<typeof mkEnv>, now = NOW) => decide(p, e.policy, e.state, now);

describe('decide: default posture', () => {
  it('all_gates_open_auto_executes', () => {
    const p = mustProposal(stopInput());
    const d = only(p, ready(p));
    expect(d).toMatchObject({ kind: 'auto_execute', reason: 'AUTO_ALL_GATES_PASSED', blockers: [], policyVersion: 'p-1' });
  });
  it('autonomy_is_off_with_an_empty_policy_for_every_seed_action', () => {
    for (const input of [stopInput(), scheduleInput(), resizeInput(), deleteVolumeInput(), commitmentInput()]) {
      const p = mustProposal(input);
      const e = mkEnv({ policy: emptyPolicy() });
      e.state.dryRuns.set(p.id, { ok: true, at: NOW });
      const d = decide(p, e.policy, e.state, NOW);
      expect(d.kind, p.action.id).toBe('require_approval');
      expect(d.blockers).toContain('CLASS_NOT_ENABLED');
    }
  });
  it('a_hand_built_or_missing_policy_is_treated_as_empty', () => {
    const p = mustProposal(stopInput());
    const e = ready(p);
    for (const fake of [{ ...enabledPolicy() }, null, undefined, {}]) {
      const d = decide(p, fake as never, e.state, NOW);
      expect(d.kind).toBe('require_approval');
      expect(d.blockers).toContain('POLICY_INVALID');
    }
  });
  it('a_hand_built_proposal_is_denied', () => {
    const p = mustProposal(stopInput());
    const e = ready(p);
    expect(decide({ ...p } as Proposal, e.policy, e.state, NOW)).toMatchObject({ kind: 'deny', reason: 'BAD_PROPOSAL' });
    expect(decide(null as never, e.policy, e.state, NOW).kind).toBe('deny');
  });
  it('human_origin_never_auto_executes', () => {
    const p = mustProposal(stopInput(), 'human');
    const d = only(p, ready(p));
    expect(d.kind).toBe('require_approval');
    expect(d.blockers).toEqual(['HUMAN_ORIGIN']);
  });
  it('tenant_mismatch_and_denied_class_deny', () => {
    const p = mustProposal(stopInput());
    expect(decide(p, enabledPolicy(), mkEnv({ tenant: 'other' }).state, NOW).reason).toBe('TENANT_MISMATCH');
    const wrongPolicy = mustPolicy(rawPolicy({ tenant: 'other' }));
    expect(decide(p, wrongPolicy, ready(p).state, NOW).reason).toBe('TENANT_MISMATCH');
    const denyPolicy = mustPolicy(rawPolicy({ classes: {}, denyClasses: ['idle_stop'] }));
    expect(decide(p, denyPolicy, ready(p).state, NOW)).toMatchObject({ kind: 'deny', reason: 'CLASS_DENIED' });
  });
});

describe('decide: each gate blocks by itself', () => {
  it('class_not_enabled', () => {
    const p = mustProposal(scheduleInput());
    const e = ready(p, mustPolicy(rawPolicy({ classes: { idle_stop: classPolicy() } })));
    expect(only(p, e)).toMatchObject({ kind: 'require_approval', blockers: ['CLASS_NOT_ENABLED'] });
  });
  it('environment_not_listed', () => {
    const p = mustProposal(stopInput({ env: 'test' }));
    const e = ready(p, mustPolicy(rawPolicy({ classes: { idle_stop: classPolicy({ environments: ['dev'] }) } })));
    expect(only(p, e).blockers).toEqual(['ENV_NOT_ALLOWED']);
  });
  it('prod_needs_explicit_listing', () => {
    const p = mustProposal(stopInput({ env: 'prod' }));
    expect(only(p, ready(p)).blockers).toEqual(['PROD_NOT_PERMITTED']); // dev and test listed, prod not
    const listed = mustPolicy(rawPolicy({ classes: { idle_stop: classPolicy({ environments: ['prod'] }) } }));
    expect(only(p, ready(p, listed))).toMatchObject({ kind: 'auto_execute' });
  });
  it('dry_run_missing_failed_or_stale', () => {
    const p = mustProposal(stopInput());
    const none = mkEnv();
    expect(only(p, none).blockers).toEqual(['DRY_RUN_NOT_PASSED']);
    const failed = mkEnv();
    failed.state.dryRuns.set(p.id, { ok: false, at: NOW });
    expect(only(p, failed).blockers).toEqual(['DRY_RUN_NOT_PASSED']);
    const e = ready(p);
    expect(only(p, e, NOW + 5 * MINUTE).kind).toBe('auto_execute'); // at the age limit
    expect(only(p, e, NOW + 5 * MINUTE + 1).blockers).toEqual(['DRY_RUN_NOT_PASSED']); // one past it
    e.state.dryRuns.set(p.id, { ok: true, at: NOW + 10 }); // dated in the future
    expect(only(p, e).blockers).toEqual(['DRY_RUN_NOT_PASSED']);
  });
  it('per_action_count_cap_boundary', () => {
    const ok = mustProposal(stopInput({ params: { instanceIds: ['a', 'b', 'c', 'd', 'e'], idleDays: 3 } }));
    expect(only(ok, ready(ok)).kind).toBe('auto_execute');
    const over = mustProposal(stopInput({ params: { instanceIds: ['a', 'b', 'c', 'd', 'e', 'f'], idleDays: 3 } }));
    expect(only(over, ready(over)).blockers).toEqual(['COUNT_CAP']);
  });
  it('per_action_cost_cap_boundary', () => {
    const at = mustProposal(stopInput({ impact: { currency: 'USD', estimatedMonthlySavingsMinor: 1, costAtStakeMinor: 100_000 } }));
    expect(only(at, ready(at)).kind).toBe('auto_execute');
    const over = mustProposal(stopInput({ impact: { currency: 'USD', estimatedMonthlySavingsMinor: 1, costAtStakeMinor: 100_001 } }));
    expect(only(over, ready(over)).blockers).toEqual(['COST_CAP']);
  });
  it('currency_mismatch_routes_to_a_human', () => {
    const p = mustProposal(stopInput({ impact: { currency: 'EUR', estimatedMonthlySavingsMinor: 1, costAtStakeMinor: 5 } }));
    expect(only(p, ready(p)).blockers).toEqual(['CURRENCY_MISMATCH']);
  });
  it('rolling_window_count_cap_and_expiry', () => {
    const p = mustProposal(stopInput({ params: { instanceIds: ['a', 'b'], idleDays: 3 } }));
    const e = ready(p);
    e.state.windowUsage.push({ at: NOW - 10 * MINUTE, actionClass: 'idle_stop', resources: 8, currency: 'USD', costMinor: BigInt(1) });
    expect(only(p, e).kind).toBe('auto_execute'); // 8 + 2 = 10, exactly the cap
    e.state.windowUsage.push({ at: NOW - 5 * MINUTE, actionClass: 'idle_stop', resources: 1, currency: 'USD', costMinor: BigInt(1) });
    expect(only(p, e).blockers).toEqual(['WINDOW_COUNT_CAP']);
    expect(only(p, e, NOW + HOUR + 6 * MINUTE).kind).toBe('require_approval'); // dry run stale by then
    e.state.dryRuns.set(p.id, { ok: true, at: NOW + HOUR + 6 * MINUTE });
    expect(only(p, e, NOW + HOUR + 6 * MINUTE).kind).toBe('auto_execute'); // both entries rolled out of the window
  });
  it('rolling_window_ignores_other_classes_and_counts_future_stamps', () => {
    const p = mustProposal(stopInput());
    const e = ready(p);
    e.state.windowUsage.push({ at: NOW - MINUTE, actionClass: 'schedule', resources: 9999, currency: 'USD', costMinor: BigInt(9999999) });
    expect(only(p, e).kind).toBe('auto_execute');
    e.state.windowUsage.push({ at: NOW + HOUR, actionClass: 'idle_stop', resources: 10, currency: 'USD', costMinor: BigInt(1) });
    expect(only(p, e).blockers).toEqual(['WINDOW_COUNT_CAP']);
  });
  it('rolling_window_cost_cap_and_currency_mix', () => {
    const p = mustProposal(stopInput()); // 6000 at stake
    const e = ready(p);
    e.state.windowUsage.push({ at: NOW - MINUTE, actionClass: 'idle_stop', resources: 1, currency: 'USD', costMinor: BigInt(244_000) });
    expect(only(p, e).kind).toBe('auto_execute'); // 250000 exactly
    e.state.windowUsage[0] = { ...e.state.windowUsage[0], costMinor: BigInt(244_001) };
    expect(only(p, e).blockers).toEqual(['WINDOW_COST_CAP']);
    e.state.windowUsage[0] = { ...e.state.windowUsage[0], currency: 'EUR', costMinor: BigInt(1) };
    expect(only(p, e).blockers).toEqual(['WINDOW_COST_CAP']); // unsummable, so closed
  });
  it('cooldown_boundary', () => {
    const p = mustProposal(stopInput());
    const e = ready(p);
    e.state.lastTouched.set('i-aaa', NOW - 10 * MINUTE + 1);
    expect(only(p, e).blockers).toEqual(['COOLDOWN']);
    e.state.lastTouched.set('i-aaa', NOW - 10 * MINUTE);
    expect(only(p, e).kind).toBe('auto_execute');
    e.state.lastTouched.set('i-aaa', NOW + HOUR); // clock skew
    expect(only(p, e).blockers).toEqual(['COOLDOWN']);
    e.state.lastTouched.clear();
    e.state.lastTouched.set('i-other', NOW);
    expect(only(p, e).kind).toBe('auto_execute'); // a different resource
  });
  it('resource_in_flight', () => {
    const p = mustProposal(stopInput());
    const e = ready(p);
    e.state.locks.add('i-aaa');
    expect(only(p, e).blockers).toEqual(['RESOURCE_BUSY']);
  });
  it('kill_switch_and_platform_halt', () => {
    const p = mustProposal(stopInput());
    const e = ready(p);
    e.state.killSwitch.engaged = true;
    expect(only(p, e).blockers).toEqual(['KILL_SWITCH']);
    for (const halt of [() => true, () => { throw new Error('x'); }, () => 'no' as never]) {
      const h = mkEnv({ state: { platformHalt: halt } });
      h.state.dryRuns.set(p.id, { ok: true, at: NOW });
      expect(only(p, h).blockers, String(halt)).toEqual(['KILL_SWITCH']);
    }
    const off = mkEnv({ state: { platformHalt: () => false } });
    off.state.dryRuns.set(p.id, { ok: true, at: NOW });
    expect(only(p, off).kind).toBe('auto_execute');
  });
  it('change_freeze_window_boundaries', () => {
    const p = mustProposal(stopInput());
    const policy = mustPolicy(rawPolicy({ freezeWindows: [{ startMs: NOW, endMs: NOW + HOUR }] }));
    expect(only(p, ready(p, policy)).blockers).toEqual(['CHANGE_FREEZE']); // start is inclusive
    const e = ready(p, policy);
    e.state.dryRuns.set(p.id, { ok: true, at: NOW + HOUR });
    expect(only(p, e, NOW + HOUR).kind).toBe('auto_execute'); // end is exclusive
    const before = ready(p, mustPolicy(rawPolicy({ freezeWindows: [{ startMs: NOW + 1, endMs: NOW + HOUR }] })));
    expect(only(p, before).kind).toBe('auto_execute');
  });
  it('circuit_open', () => {
    const p = mustProposal(stopInput());
    const e = ready(p);
    e.state.breakers.set('idle_stop', { consecutiveFailures: 3, open: true });
    expect(only(p, e).blockers).toEqual(['CIRCUIT_OPEN']);
    e.state.breakers.set('schedule', { consecutiveFailures: 3, open: true }); // other class does not matter
    e.state.breakers.set('idle_stop', { consecutiveFailures: 2, open: false });
    expect(only(p, e).kind).toBe('auto_execute');
  });
  it('bad_clock_fails_closed', () => {
    const p = mustProposal(stopInput());
    for (const t of [Number.NaN, -1, 1.5, Infinity]) {
      const d = only(p, ready(p), t);
      expect(d.kind, String(t)).toBe('require_approval');
      expect(d.blockers).toContain('BAD_TIME');
    }
  });
  it('reports_every_failed_gate_with_the_first_as_reason', () => {
    const p = mustProposal(stopInput(), 'human');
    const e = mkEnv();
    e.state.killSwitch.engaged = true;
    const d = only(p, e);
    expect(d.reason).toBe('HUMAN_ORIGIN');
    expect(d.blockers).toEqual(['HUMAN_ORIGIN', 'DRY_RUN_NOT_PASSED', 'KILL_SWITCH']);
  });
});

describe('decide: ineligible actions can never auto-execute', () => {
  it('irreversible_high_risk_and_commitment_stay_with_humans_even_in_a_permissive_policy', () => {
    for (const input of [deleteVolumeInput(), resizeInput(), commitmentInput({ env: 'dev' })]) {
      const p = mustProposal(input);
      const e = mkEnv({ policy: enabledPolicy() });
      e.state.dryRuns.set(p.id, { ok: true, at: NOW });
      const d = decide(p, e.policy, e.state, NOW);
      expect(d.kind, p.action.id).toBe('require_approval');
      expect(d.blockers).toContain('ACTION_NOT_ELIGIBLE');
    }
  });
  it('a_forged_eligible_flag_on_a_proposal_does_not_help_without_the_registry', () => {
    // Proposal metadata comes from the registry; a hand-built copy is denied outright.
    const p = mustProposal(commitmentInput());
    expect(decide({ ...p, action: { ...p.action, autonomyEligible: true, risk: 'low', reversible: true, impact: 'cost' } } as Proposal, enabledPolicy(), mkEnv().state, NOW).kind).toBe('deny');
  });
  it('team_does_not_affect_the_decision', () => {
    const p = mustProposal(stopInput({ team: CX }));
    expect(only(p, ready(p)).kind).toBe('auto_execute');
  });
  it('tenant_is_a_proposal_field_checked_at_parse', () => {
    expect(parseProposal(ACTION_REGISTRY, stopInput({ tenant: 'bad tenant!' }), 'system').ok).toBe(false);
    expect(TENANT).toBe('t1');
  });
});
