// The orchestrator: autonomy off by default, dry-run first, rollback, post-check, circuit breaker,
// idempotency, racing proposals, and audit coverage.
import { describe, expect, it } from 'vitest';
import { verifyChain } from './audit';
import { rollbackProposal, runProposal, submitSystemProposal, registerProposal, applyKillSwitch, applyBreakerReset } from './orchestrator';
import { SERVICE_ACTOR_ID } from './types';
import { MINUTE, deleteVolumeInput, emptyPolicy, mkEnv, mustPolicy, rawPolicy, classPolicy, scheduleInput, stopInput, commitmentInput } from './testkit';

const outcomes = (e: ReturnType<typeof mkEnv>) => e.audit.records().map((r) => r.outcome);
const submit = (e: ReturnType<typeof mkEnv>, input: unknown) => submitSystemProposal(e.deps, e.policy, input);

describe('autonomy off by default', () => {
  it('an_empty_policy_never_calls_the_executor', async () => {
    const e = mkEnv({ policy: emptyPolicy() });
    for (const input of [stopInput(), scheduleInput({ id: 'p2' }), deleteVolumeInput({ id: 'p3' }), commitmentInput({ id: 'p4' })]) {
      const r = await submit(e, input);
      expect(r.ok && r.result.status).toBe('not_executed');
      expect(r.ok && r.decision.kind).toBe('require_approval');
    }
    expect(e.executor.calls.length).toBe(0);
    expect(verifyChain(e.audit.records()).ok).toBe(true);
  });
  it('irreversible_and_commitment_proposals_never_reach_the_executor_even_when_the_class_is_enabled', async () => {
    const e = mkEnv();
    await submit(e, deleteVolumeInput());
    await submit(e, commitmentInput({ env: 'dev' }));
    expect(e.executor.calls.length).toBe(0);
  });
  it('invalid_input_is_refused_with_fixed_codes', async () => {
    const e = mkEnv();
    const r = await submit(e, stopInput({ params: { instanceIds: ['i-a'], idleDays: 14, extra: 1 } }));
    expect(r).toMatchObject({ ok: false, code: 'INVALID_PROPOSAL', proposalCode: 'PROPOSAL_PARAMS', paramCode: 'PARAMS_UNKNOWN_KEY' });
    expect(await submit(e, stopInput({ tenant: 'other' }))).toMatchObject({ ok: false, code: 'TENANT_MISMATCH' });
    expect(await submit(e, stopInput({ actionId: 'nope' }))).toMatchObject({ ok: false, proposalCode: 'PROPOSAL_UNKNOWN_ACTION' });
    expect(await submit(e, stopInput({ impact: { currency: 'USD', estimatedMonthlySavingsMinor: 10, costAtStakeMinor: 5 } }))).toMatchObject({ proposalCode: 'PROPOSAL_IMPACT' });
    expect(e.state.proposals.size).toBe(0);
    expect(e.executor.calls.length).toBe(0);
  });
});

describe('autonomous run', () => {
  it('dry_run_first_then_execute_then_post_check_and_a_rollback_token', async () => {
    const e = mkEnv();
    const r = await submit(e, stopInput());
    expect(r).toMatchObject({ ok: true, result: { status: 'succeeded', reason: 'OK', replayed: false } });
    expect(e.executor.calls.map((c) => c.phase)).toEqual(['dry_run', 'execute', 'post_check']);
    expect(e.state.rollbacks.get('prop-1')?.token).toBe('rbk-1');
    expect(e.executor.liveEffectCount).toBe(1);
    expect(outcomes(e)).toEqual(['PROPOSED', 'DRY_RUN_OK', 'AUTO_ALL_GATES_PASSED', 'EXEC_STARTED', 'EXEC_OK']);
    const rs = e.audit.records();
    expect(rs.find((x) => x.kind === 'decision')?.actor).toBe(SERVICE_ACTOR_ID);
    expect(rs.every((x) => x.policyVersion === 'p-1')).toBe(true);
    expect(verifyChain(rs).ok).toBe(true);
  });
  it('dry_run_failure_blocks_execution_and_routes_to_a_human', async () => {
    const e = mkEnv();
    e.executor.inject({ phase: 'dry_run', mode: 'fail' });
    const r = await submit(e, stopInput());
    expect(r).toMatchObject({ ok: true, result: { status: 'not_executed', reason: 'DRY_RUN_NOT_PASSED' } });
    expect(e.executor.executeCount).toBe(0);
    expect(e.state.proposals.get('prop-1')?.status).toBe('proposed');
    expect(outcomes(e)).toContain('DRY_RUN_FAILED');
  });
  it('a_throwing_dry_run_is_a_failed_dry_run', async () => {
    const e = mkEnv();
    e.executor.inject({ phase: 'dry_run', mode: 'throw' });
    expect((await submit(e, stopInput())).ok && true).toBe(true);
    expect(e.executor.executeCount).toBe(0);
  });
  it('failed_execution_without_effect_is_failed_and_counts_toward_the_breaker', async () => {
    const e = mkEnv();
    e.executor.inject({ phase: 'execute', mode: 'fail' });
    const r = await submit(e, stopInput());
    expect(r).toMatchObject({ ok: true, result: { status: 'failed', reason: 'EXECUTE_FAILED' } });
    expect(e.state.breakers.get('idle_stop')?.consecutiveFailures).toBe(1);
    expect(e.executor.liveEffectCount).toBe(0);
  });
  it('a_thrown_execute_is_a_fixed_failure_and_never_leaks_the_message', async () => {
    const e = mkEnv();
    e.executor.inject({ phase: 'execute', mode: 'throw' });
    const r = await submit(e, stopInput());
    expect(JSON.stringify(r)).not.toContain('injected');
    expect(JSON.stringify(e.audit.records())).not.toContain('injected');
    expect(r.ok && r.result.status).toBe('failed');
  });
  it('partial_execution_with_a_token_is_rolled_back', async () => {
    const e = mkEnv();
    e.executor.inject({ phase: 'execute', mode: 'partial' });
    const r = await submit(e, stopInput());
    expect(r).toMatchObject({ ok: true, result: { status: 'rolled_back', reason: 'EXECUTE_FAILED' } });
    expect(e.executor.liveEffectCount).toBe(0);
    expect(outcomes(e)).toEqual(expect.arrayContaining(['EXEC_FAILED', 'ROLLBACK_OK']));
    expect(e.state.proposals.get('prop-1')?.status).toBe('rolled_back');
  });
  it('post_check_failure_triggers_automatic_rollback', async () => {
    const e = mkEnv();
    e.executor.inject({ phase: 'post_check', mode: 'fail' });
    const r = await submit(e, stopInput());
    expect(r).toMatchObject({ ok: true, result: { status: 'rolled_back', reason: 'POSTCHECK_FAILED' } });
    expect(e.executor.calls.map((c) => c.phase)).toEqual(['dry_run', 'execute', 'post_check', 'rollback']);
    expect(e.executor.liveEffectCount).toBe(0);
    expect(e.state.breakers.get('idle_stop')?.consecutiveFailures).toBe(1);
  });
  it('a_throwing_post_check_also_rolls_back', async () => {
    const e = mkEnv();
    e.executor.inject({ phase: 'post_check', mode: 'throw' });
    const r = await submit(e, stopInput());
    expect(r.ok && r.result.status).toBe('rolled_back');
  });
  it('a_failed_rollback_is_reported_and_needs_a_human', async () => {
    const e = mkEnv();
    e.executor.inject({ phase: 'post_check', mode: 'fail' });
    e.executor.inject({ phase: 'rollback', mode: 'fail' });
    const r = await submit(e, stopInput());
    expect(r).toMatchObject({ ok: true, result: { status: 'rollback_failed', reason: 'ROLLBACK_FAILED' } });
    expect(e.executor.liveEffectCount).toBe(1);
    expect(outcomes(e)).toContain('ROLLBACK_FAILED');
    // The token is still usable for a later manual attempt.
    const again = await rollbackProposal(e.deps, e.policy, 'prop-1', 'sub-ops');
    expect(again).toMatchObject({ status: 'rolled_back', reason: 'OK' });
    expect(e.executor.liveEffectCount).toBe(0);
  });
  it('success_without_a_rollback_token_for_a_reversible_action_is_a_failure', async () => {
    const e = mkEnv();
    const orig = e.executor.execute.bind(e.executor);
    e.executor.execute = async (a, o) => { const r = await orig(a, o); return r.ok && !o.dryRun ? { ok: true } : r; };
    const r = await submit(e, stopInput());
    expect(r).toMatchObject({ ok: true, result: { status: 'failed', reason: 'ROLLBACK_TOKEN_MISSING' } });
  });
  it('a_malformed_executor_token_is_ignored', async () => {
    const e = mkEnv();
    const orig = e.executor.execute.bind(e.executor);
    e.executor.execute = async (a, o) => { const r = await orig(a, o); return r.ok && !o.dryRun ? { ok: true, rollbackToken: 'bad token\n' } : r; };
    const r = await submit(e, stopInput());
    expect(r.ok && r.result.reason).toBe('ROLLBACK_TOKEN_MISSING');
  });
});

describe('circuit breaker', () => {
  it('trips_after_n_consecutive_failures_and_stops_the_class', async () => {
    const e = mkEnv({ policy: mustPolicy(rawPolicy({ circuitBreakerThreshold: 2 })) });
    e.clock.set(e.clock.now());
    e.executor.inject({ phase: 'execute', mode: 'fail', times: 2 });
    await submit(e, stopInput({ id: 'a1', params: { instanceIds: ['i-1'], idleDays: 5 } }));
    expect(e.state.breakers.get('idle_stop')?.open).toBe(false);
    await submit(e, stopInput({ id: 'a2', params: { instanceIds: ['i-2'], idleDays: 5 } }));
    expect(e.state.breakers.get('idle_stop')).toEqual({ consecutiveFailures: 2, open: true });
    expect(outcomes(e)).toContain('BREAKER_TRIPPED');
    const calls = e.executor.calls.length;
    const r = await submit(e, stopInput({ id: 'a3', params: { instanceIds: ['i-3'], idleDays: 5 } }));
    expect(r).toMatchObject({ ok: true, result: { status: 'not_executed' }, decision: { blockers: ['CIRCUIT_OPEN'] } });
    expect(e.executor.calls.length).toBe(calls); // blocked before any executor call
    expect(e.executor.executeCount).toBe(2);
  });
  it('a_success_resets_the_count_and_other_classes_are_unaffected', async () => {
    const e = mkEnv({ policy: mustPolicy(rawPolicy({ circuitBreakerThreshold: 2 })) });
    e.executor.inject({ phase: 'execute', mode: 'fail', proposalId: 'a1' });
    await submit(e, stopInput({ id: 'a1', params: { instanceIds: ['i-1'], idleDays: 5 } }));
    await submit(e, stopInput({ id: 'a2', params: { instanceIds: ['i-2'], idleDays: 5 } }));
    expect(e.state.breakers.get('idle_stop')).toEqual({ consecutiveFailures: 0, open: false });
    e.state.breakers.set('idle_stop', { consecutiveFailures: 2, open: true });
    const r = await submit(e, scheduleInput({ id: 's1' }));
    expect(r.ok && r.result.status).toBe('succeeded');
  });
  it('a_human_reset_closes_it_and_is_audited', async () => {
    const e = mkEnv();
    e.state.breakers.set('idle_stop', { consecutiveFailures: 3, open: true });
    expect(applyBreakerReset(e.deps, e.policy, 'sub-ops', 'idle_stop')).toEqual({ ok: true });
    expect(e.state.breakers.get('idle_stop')?.open).toBe(false);
    expect(e.audit.records().at(-1)).toMatchObject({ kind: 'circuit_breaker', outcome: 'BREAKER_RESET', actor: 'sub-ops' });
    expect(applyBreakerReset(e.deps, e.policy, 'sub-ops', 'nope')).toEqual({ ok: false });
  });
});

describe('idempotency', () => {
  it('the_same_proposal_id_never_executes_twice_and_replay_returns_the_first_result', async () => {
    const e = mkEnv();
    const first = await submit(e, stopInput());
    const second = await submit(e, stopInput());
    expect(second.ok && second.replayed).toBe(true);
    expect(second.ok && second.result).toMatchObject({ status: 'succeeded', replayed: true });
    expect(e.executor.executeCount).toBe(1);
    const third = await runProposal(e.deps, e.policy, 'prop-1', { kind: 'service' });
    expect(third).toMatchObject({ status: 'succeeded', replayed: true });
    expect(e.executor.executeCount).toBe(1);
    expect(first.ok && first.result.replayed).toBe(false);
  });
  it('the_same_id_with_a_different_payload_is_refused', async () => {
    const e = mkEnv();
    await submit(e, stopInput());
    const r = await submit(e, stopInput({ params: { instanceIds: ['i-zzz'], idleDays: 14 } }));
    expect(r).toMatchObject({ ok: false, code: 'ID_CONFLICT' });
    expect(e.executor.executeCount).toBe(1);
  });
  it('a_concurrent_duplicate_shares_the_in_flight_run', async () => {
    const e = mkEnv();
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    e.executor.beforeExecute = () => gate;
    const a = submit(e, stopInput());
    await Promise.resolve();
    const b = submit(e, stopInput());
    await new Promise((r) => setTimeout(r, 5));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && ra.result.status).toBe('succeeded');
    expect(rb.ok && rb.result.status).toBe('succeeded');
    expect(e.executor.executeCount).toBe(1);
  });
  it('a_failed_run_is_also_replayed_not_retried', async () => {
    const e = mkEnv();
    e.executor.inject({ phase: 'execute', mode: 'fail' });
    await submit(e, stopInput());
    const again = await runProposal(e.deps, e.policy, 'prop-1', { kind: 'service' });
    expect(again).toMatchObject({ status: 'failed', replayed: true });
    expect(e.executor.executeCount).toBe(1);
  });
});

describe('racing proposals', () => {
  it('two_proposals_for_one_resource_cannot_both_execute', async () => {
    const e = mkEnv();
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    e.executor.beforeExecute = () => gate;
    const p1 = submit(e, stopInput({ id: 'race-1' }));
    const p2 = submit(e, stopInput({ id: 'race-2' }));
    await new Promise((r) => setTimeout(r, 5));
    release();
    const [a, b] = await Promise.all([p1, p2]);
    const statuses = [a, b].map((x) => (x.ok ? x.result.status : 'err')).sort();
    expect(statuses).toEqual(['not_executed', 'succeeded']);
    expect(e.executor.executeCount).toBe(1);
    const loser = [a, b].find((x) => x.ok && x.result.status === 'not_executed');
    expect(loser?.ok && loser.decision.blockers).toEqual(expect.arrayContaining(['RESOURCE_BUSY']));
    expect(e.state.locks.size).toBe(0);
  });
  it('after_success_the_cooldown_blocks_the_same_resource_until_it_passes', async () => {
    const e = mkEnv();
    await submit(e, stopInput({ id: 'c1' }));
    const blocked = await submit(e, stopInput({ id: 'c2' }));
    expect(blocked.ok && blocked.decision.blockers).toEqual(['COOLDOWN']);
    e.clock.advance(10 * MINUTE);
    const later = await submit(e, stopInput({ id: 'c3' }));
    expect(later.ok && later.result.status).toBe('succeeded');
  });
  it('the_rolling_window_cap_stops_a_burst_across_different_resources', async () => {
    const e = mkEnv({ policy: mustPolicy(rawPolicy({ classes: { idle_stop: classPolicy({ window: { lengthMs: 3_600_000, maxResources: 3, maxCostAtStake: 1_000_000 } }) } })) });
    const results: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await submit(e, stopInput({ id: `w${i}`, params: { instanceIds: [`i-${i}`], idleDays: 3 } }));
      results.push(r.ok ? r.result.status : 'err');
    }
    expect(results).toEqual(['succeeded', 'succeeded', 'succeeded', 'not_executed', 'not_executed']);
    expect(e.executor.executeCount).toBe(3);
  });
  it('failed_executions_still_consume_the_window', async () => {
    const e = mkEnv({ policy: mustPolicy(rawPolicy({ classes: { idle_stop: classPolicy({ window: { lengthMs: 3_600_000, maxResources: 1, maxCostAtStake: 1_000_000 } }) } })) });
    e.executor.inject({ phase: 'execute', mode: 'fail' });
    await submit(e, stopInput({ id: 'f1', params: { instanceIds: ['i-1'], idleDays: 3 } }));
    const r = await submit(e, stopInput({ id: 'f2', params: { instanceIds: ['i-2'], idleDays: 3 } }));
    expect(r.ok && r.result.status).toBe('not_executed');
  });
});

describe('kill switch and audit exhaustion', () => {
  it('kill_switch_blocks_autonomy_and_is_audited', async () => {
    const e = mkEnv();
    expect(applyKillSwitch(e.deps, e.policy, 'sub-ops', true)).toEqual({ ok: true, changed: true });
    expect(applyKillSwitch(e.deps, e.policy, 'sub-ops', true)).toEqual({ ok: true, changed: false });
    const r = await submit(e, stopInput());
    expect(r.ok && r.decision.blockers).toEqual(['KILL_SWITCH']);
    expect(e.executor.executeCount).toBe(0);
    expect(e.audit.records().find((x) => x.kind === 'kill_switch')).toMatchObject({ actor: 'sub-ops', outcome: 'KILL_SWITCH_ENGAGED' });
    applyKillSwitch(e.deps, e.policy, 'sub-ops', false);
    expect(outcomes(e)).toContain('KILL_SWITCH_RELEASED');
  });
  it('engaging_works_even_when_the_audit_log_is_full_but_releasing_does_not', () => {
    const e = mkEnv({ auditMax: 1 });
    e.audit.append({ at: 1, kind: 'proposal', actor: 'x', policyVersion: 'p', outcome: 'PROPOSED' });
    expect(applyKillSwitch(e.deps, e.policy, 'sub-ops', true)).toEqual({ ok: true, changed: true });
    expect(e.state.killSwitch.engaged).toBe(true);
    expect(applyKillSwitch(e.deps, e.policy, 'sub-ops', false)).toEqual({ ok: false, changed: false });
    expect(e.state.killSwitch.engaged).toBe(true);
  });
  it('a_full_audit_log_means_no_effect', async () => {
    const e = mkEnv({ auditMax: 3 });
    const r = await submit(e, stopInput());
    expect(r).toMatchObject({ ok: true, result: { status: 'rejected', reason: 'AUDIT_UNAVAILABLE' } });
    expect(e.executor.executeCount).toBe(0);
    expect(e.state.locks.size).toBe(0);
  });
  it('a_bad_clock_registers_nothing', async () => {
    const e = mkEnv();
    e.clock.set(Number.NaN);
    expect(registerProposal(e.deps, e.policy, stopInput(), 'system', SERVICE_ACTOR_ID)).toEqual({ ok: false, code: 'BAD_TIME' });
  });
});

describe('manual rollback', () => {
  it('rolls_back_an_executed_reversible_change_once', async () => {
    const e = mkEnv();
    await submit(e, stopInput());
    expect(await rollbackProposal(e.deps, e.policy, 'prop-1', 'sub-ops')).toMatchObject({ status: 'rolled_back' });
    expect(await rollbackProposal(e.deps, e.policy, 'prop-1', 'sub-ops')).toMatchObject({ status: 'rejected', reason: 'NO_ROLLBACK_AVAILABLE' });
    expect(await rollbackProposal(e.deps, e.policy, 'nope', 'sub-ops')).toMatchObject({ reason: 'NOT_FOUND' });
    expect(e.executor.liveEffectCount).toBe(0);
  });
});
