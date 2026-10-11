// The human path through authorize(): request, approve (different person), apply, rollback, admin.
import { describe, expect, it } from 'vitest';
import { DENY_REASONS } from '@/rbac/authorize';
import { verifyChain } from './audit';
import { applyChange, approveChange, requestChange, resetCircuitBreaker, rollbackChange, setKillSwitch, HUMAN_REASONS } from './human';
import { submitSystemProposal } from './orchestrator';
import { HOUR, applier, approver, commitmentInput, deleteVolumeInput, emptyPolicy, mkEnv, principal, requester, resizeInput, stopInput, TENANT } from './testkit';

const fresh = () => mkEnv({ policy: emptyPolicy() }); // autonomy off: the default posture
type E = ReturnType<typeof fresh>;
const request = (e: E, input: unknown = stopInput(), who = requester()) => requestChange(e.deps, e.policy, who, input);
const approve = (e: E, id = 'prop-1', who = approver()) => approveChange(e.deps, e.policy, who, id);
const apply = (e: E, id = 'prop-1', who = applier(), ticketState?: 'approved' | 'open') => applyChange(e.deps, e.policy, who, id, ticketState ? { ticketState } : {});

describe('happy path: request, approve, apply', () => {
  it('a_different_person_approves_and_a_third_applies_with_a_full_audit_trail', async () => {
    const e = fresh();
    expect(request(e)).toMatchObject({ ok: true, replayed: false, decision: { kind: 'require_approval' } });
    expect(approve(e)).toMatchObject({ ok: true, approvedBy: 'sub-approver' });
    const r = await apply(e);
    expect(r).toMatchObject({ ok: true, result: { status: 'succeeded', replayed: false } });
    expect(e.executor.calls.map((c) => c.phase)).toEqual(['dry_run', 'execute', 'post_check']);
    const rs = e.audit.records();
    expect(rs.map((x) => x.kind)).toEqual(['proposal', 'decision', 'approval', 'execution', 'execution', 'execution']);
    expect(rs.map((x) => x.actor)).toEqual(['sub-requester', 'svc:remediation-autonomy', 'sub-approver', 'sub-applier', 'sub-applier', 'sub-applier']);
    expect(rs.every((x) => x.policyVersion === 'default-off')).toBe(true);
    expect(verifyChain(rs).ok).toBe(true);
  });
  it('human_requests_are_never_auto_executed_even_when_the_policy_enables_the_class', async () => {
    const e = mkEnv(); // enabled policy
    e.state.dryRuns.set('prop-1', { ok: true, at: e.clock.now() });
    const r = request(e);
    expect(r).toMatchObject({ ok: true, decision: { kind: 'require_approval' } });
    expect(r.ok && r.decision.blockers).toContain('HUMAN_ORIGIN');
    expect(e.executor.calls.length).toBe(0);
  });
  it('human_approved_actions_run_even_when_ineligible_for_autonomy', async () => {
    for (const input of [deleteVolumeInput(), resizeInput(), commitmentInput({ env: 'dev' })]) {
      const e = fresh();
      const id = input.id as string;
      const who = requester();
      expect(request(e, input, who).ok, id).toBe(true);
      expect(approve(e, id).ok, id).toBe(true);
      const r = await apply(e, id);
      expect(r.ok && r.result.status, id).toBe('succeeded');
    }
  });
});

describe('order and separation of duties', () => {
  it('apply_before_approval_is_409', async () => {
    const e = fresh();
    request(e);
    expect(await apply(e)).toEqual({ ok: false, status: 409, reason: DENY_REASONS.changeNotApproved });
    expect(e.executor.calls.length).toBe(0);
  });
  it('the_requester_cannot_approve_their_own_change', () => {
    const e = fresh();
    request(e, stopInput(), principal('cto', { sub: 'sub-same' }) && principal('finops_lead', { sub: 'sub-same' }));
    const r = approve(e, 'prop-1', principal('cto', { sub: 'sub-same' }));
    expect(r).toEqual({ ok: false, status: 403, reason: DENY_REASONS.duties });
    expect(e.state.proposals.get('prop-1')?.status).toBe('proposed');
  });
  it('autonomy_raised_proposals_can_be_approved_by_any_authorized_human', async () => {
    const e = mkEnv(); // enabled, but the dry run fails, so it routes to a human
    e.executor.inject({ phase: 'dry_run', mode: 'fail' });
    await submitSystemProposal(e.deps, e.policy, stopInput());
    expect(approve(e).ok).toBe(true);
    const r = await apply(e);
    expect(r.ok && r.result.status).toBe('succeeded');
  });
  it('approving_twice_or_approving_an_unknown_change_fails', () => {
    const e = fresh();
    request(e);
    expect(approve(e).ok).toBe(true);
    expect(approve(e, 'prop-1', principal('cto', { sub: 'sub-other' }))).toMatchObject({ ok: false, status: 409 });
    expect(approve(e, 'nope')).toMatchObject({ ok: false, status: 404 });
    expect(approve(e, 'bad id!!')).toMatchObject({ ok: false, status: 404 });
  });
  it('an_approval_expires', async () => {
    const e = fresh();
    request(e);
    approve(e);
    e.clock.advance(24 * HOUR + 1);
    expect(await apply(e)).toEqual({ ok: false, status: 409, reason: HUMAN_REASONS.expired });
    expect(e.executor.calls.length).toBe(0);
  });
  it('apply_replay_returns_the_first_result_without_executing_again', async () => {
    const e = fresh();
    request(e);
    approve(e);
    await apply(e);
    const again = await apply(e, 'prop-1', principal('eng_lead', { sub: 'sub-applier-2', teams: ['Platform Eng'] }));
    expect(again).toMatchObject({ ok: true, result: { status: 'succeeded', replayed: true } });
    expect(e.executor.executeCount).toBe(1);
  });
  it('a_replayed_apply_is_not_revealed_to_an_unauthorized_caller', async () => {
    const e = fresh();
    request(e);
    approve(e);
    await apply(e);
    expect(await apply(e, 'prop-1', principal('auditor'))).toMatchObject({ ok: false, status: 403 });
  });
});

describe('authorization', () => {
  it('unauthenticated_and_malformed_principals_are_401', async () => {
    const e = fresh();
    for (const bad of [null, undefined, {}, 'cto', { ...requester(), sub: '' }]) {
      expect(requestChange(e.deps, e.policy, bad as never, stopInput()), String(bad)).toMatchObject({ ok: false, status: 401 });
    }
    expect(e.state.proposals.size).toBe(0);
  });
  it('the_shared_service_token_and_unprivileged_roles_cannot_request_approve_or_apply', async () => {
    for (const role of ['legacy_service', 'auditor', 'finance', 'procurement', 'cto'] as const) {
      const e = fresh();
      expect(request(e, stopInput(), principal(role, { sub: `sub-${role}` })), role).toMatchObject({ ok: false, status: 403 });
    }
    const e = fresh();
    request(e);
    approve(e);
    for (const role of ['cto', 'finops_lead', 'finance', 'procurement', 'auditor', 'legacy_service'] as const) {
      expect(await apply(e, 'prop-1', principal(role, { sub: `sub-${role}x` })), role).toMatchObject({ ok: false, status: 403 });
    }
    expect(e.executor.calls.length).toBe(0);
  });
  it('approver_roles_follow_the_matrix', () => {
    for (const [role, ok] of [['cto', true], ['finops_lead', true], ['finance', false /* operational impact: finance approves cost only */], ['eng_lead', false], ['auditor', false], ['legacy_service', false]] as const) {
      const e = fresh();
      request(e);
      const r = approve(e, 'prop-1', principal(role, { sub: `sub-${role}-a` }));
      expect(r.ok, role).toBe(ok);
    }
  });
  it('finance_may_approve_cost_impact_but_not_operational_and_procurement_only_commitments', () => {
    const e = fresh();
    request(e, stopInput({ id: 'op' })); // stop is operational
    expect(approve(e, 'op', principal('finance', { sub: 'sub-fin' }))).toMatchObject({ ok: false, status: 403, reason: DENY_REASONS.impact });
    expect(approve(e, 'op', principal('procurement', { sub: 'sub-proc' }))).toMatchObject({ ok: false, status: 403, reason: DENY_REASONS.impact });
    const c = fresh();
    request(c, commitmentInput({ env: 'dev' }), requester());
    expect(approve(c, 'prop-c1', principal('procurement', { sub: 'sub-proc' })).ok).toBe(true);
  });
  it('team_scope_is_enforced_for_eng_lead', async () => {
    const e = fresh();
    request(e);
    approve(e);
    const other = principal('eng_lead', { sub: 'sub-cx', teams: ['CX Engineering'] });
    expect(await apply(e, 'prop-1', other)).toMatchObject({ ok: false, status: 403, reason: DENY_REASONS.scope });
  });
  it('env_scope_is_enforced', async () => {
    const e = fresh();
    request(e);
    approve(e);
    expect(await apply(e, 'prop-1', principal('eng_lead', { sub: 'sub-prodonly', teams: ['Platform Eng'], envs: ['prod'] }))).toMatchObject({ ok: false, status: 403 });
  });
  it('production_apply_needs_an_approved_ticket_and_an_approver', async () => {
    const e = fresh();
    request(e, stopInput({ env: 'prod' }));
    approve(e);
    expect(await apply(e)).toEqual({ ok: false, status: 403, reason: DENY_REASONS.noTicket });
    expect(await apply(e, 'prop-1', applier(), 'open')).toMatchObject({ ok: false, status: 409, reason: DENY_REASONS.ticketNotApproved });
    expect(e.executor.calls.length).toBe(0);
    expect((await apply(e, 'prop-1', applier(), 'approved')).ok).toBe(true);
  });
  it('a_cross_tenant_principal_is_refused_before_anything_is_revealed', async () => {
    const e = fresh();
    request(e);
    const foreign = principal('finops_lead', { sub: 'sub-foreign', tenant: 'other' });
    expect(request(e, stopInput({ id: 'x' }), foreign)).toMatchObject({ ok: false, status: 403, reason: DENY_REASONS.scope });
    expect(approveChange(e.deps, e.policy, { ...foreign, role: 'cto' }, 'prop-1')).toMatchObject({ ok: false, status: 403, reason: DENY_REASONS.scope });
    expect(foreign.tenant).not.toBe(TENANT);
  });
  it('the_reserved_service_prefix_cannot_be_used_by_a_human', () => {
    const e = fresh();
    expect(request(e, stopInput(), principal('finops_lead', { sub: 'svc:remediation-autonomy' }))).toMatchObject({ ok: false, status: 403, reason: HUMAN_REASONS.reserved });
    expect(request(e, stopInput(), principal('finops_lead', { sub: 'svc:other' }))).toMatchObject({ ok: false, status: 403, reason: HUMAN_REASONS.reserved });
    expect(request(e, stopInput(), principal('finops_lead', { sub: 'a'.repeat(200) }))).toMatchObject({ ok: false, status: 403 });
  });
  it('a_getter_principal_cannot_change_identity_between_checks', () => {
    const e = fresh();
    request(e);
    let reads = 0;
    const sneaky = { ...approver() } as Record<string, unknown>;
    Object.defineProperty(sneaky, 'sub', { enumerable: true, get() { reads += 1; return reads === 1 ? 'sub-approver' : 'sub-requester'; } });
    // ownRecord refuses accessor-free copy semantics via reads; either way the approval must be a distinct person.
    const r = approveChange(e.deps, e.policy, sneaky as never, 'prop-1');
    if (r.ok) expect(e.state.proposals.get('prop-1')?.approvedBy).not.toBe('sub-requester');
  });
  it('invalid_input_is_400_with_fixed_text_and_never_echoed', () => {
    const e = fresh();
    const r = request(e, stopInput({ params: { instanceIds: ['EVIL-CANARY bad'], idleDays: 1 } }));
    expect(r).toMatchObject({ ok: false, status: 400, reason: HUMAN_REASONS.invalid, code: 'PROPOSAL_PARAMS' });
    expect(JSON.stringify(r)).not.toContain('CANARY');
  });
  it('requesting_the_same_id_twice_replays_and_a_changed_payload_conflicts', () => {
    const e = fresh();
    request(e);
    expect(request(e)).toMatchObject({ ok: true, replayed: true });
    expect(request(e, stopInput({ params: { instanceIds: ['i-zzz'], idleDays: 14 } }))).toMatchObject({ ok: false, status: 409, reason: HUMAN_REASONS.idConflict });
    expect(request(e, stopInput(), principal('finops_lead', { sub: 'sub-else' }))).toMatchObject({ ok: false, status: 409 }); // different requester
  });
  it('a_denied_class_is_refused_even_on_the_human_path', async () => {
    const { mustPolicy, rawPolicy } = await import('./testkit');
    const e = mkEnv({ policy: mustPolicy(rawPolicy({ classes: {}, denyClasses: ['idle_stop'] })) });
    expect(requestChange(e.deps, e.policy, requester(), stopInput())).toMatchObject({ ok: false, status: 403, reason: HUMAN_REASONS.policy, code: 'CLASS_DENIED' });
  });
});

describe('human-path failures and rollback', () => {
  it('a_failed_dry_run_on_the_human_path_executes_nothing', async () => {
    const e = fresh();
    e.executor.inject({ phase: 'dry_run', mode: 'fail' });
    request(e);
    approve(e);
    const r = await apply(e);
    expect(r).toMatchObject({ ok: true, result: { status: 'dry_run_failed' } });
    expect(e.executor.executeCount).toBe(0);
  });
  it('a_failed_post_check_rolls_back_automatically', async () => {
    const e = fresh();
    e.executor.inject({ phase: 'post_check', mode: 'fail' });
    request(e);
    approve(e);
    expect(await apply(e)).toMatchObject({ ok: true, result: { status: 'rolled_back', reason: 'POSTCHECK_FAILED' } });
    expect(e.executor.liveEffectCount).toBe(0);
  });
  it('irreversible_actions_record_no_rollback_token_and_a_failed_post_check_is_not_rolled_back', async () => {
    const e = fresh();
    e.executor.inject({ phase: 'post_check', mode: 'fail' });
    request(e, deleteVolumeInput());
    approve(e, 'prop-d1');
    const r = await apply(e, 'prop-d1');
    expect(r).toMatchObject({ ok: true, result: { status: 'failed', reason: 'POSTCHECK_FAILED' } });
    expect(e.state.rollbacks.size).toBe(0);
    expect(e.executor.calls.some((c) => c.phase === 'rollback')).toBe(false);
  });
  it('rollback_needs_change_apply_authority_and_works_once', async () => {
    const e = fresh();
    request(e);
    approve(e);
    await apply(e);
    expect(await rollbackChange(e.deps, e.policy, principal('auditor'), 'prop-1')).toMatchObject({ ok: false, status: 403 });
    expect(await rollbackChange(e.deps, e.policy, applier(), 'prop-1')).toMatchObject({ ok: true, outcome: { status: 'rolled_back' } });
    expect(await rollbackChange(e.deps, e.policy, applier(), 'prop-1')).toMatchObject({ ok: false, status: 409, reason: HUMAN_REASONS.noRollback });
    expect(e.audit.records().at(-1)).toMatchObject({ kind: 'rollback', actor: 'sub-applier' });
  });
});

describe('safety rails bind the human apply path', () => {
  const approved = () => { const e = fresh(); request(e); approve(e); return e; };
  const refused = (e: E) => e.audit.records().filter((r) => r.outcome === 'EXEC_REFUSED_HALTED');
  it('kill_switch_blocks_apply_audits_the_refusal_and_the_approval_survives', async () => {
    const e = approved();
    setKillSwitch(e.deps, e.policy, principal('finops_lead', { sub: 'sub-ks' }), true);
    expect(await apply(e)).toEqual({ ok: false, status: 409, reason: HUMAN_REASONS.halted, code: 'HALTED' });
    expect(e.executor.calls.length).toBe(0);
    expect(refused(e)).toHaveLength(1);
    expect(refused(e)[0].actor).toBe('sub-applier');
    expect(verifyChain(e.audit.records()).ok).toBe(true);
    setKillSwitch(e.deps, e.policy, approver(), false);
    expect((await apply(e)).ok).toBe(true);
  });
  it('platform_halt_blocks_apply_including_a_throwing_halt', async () => {
    for (const halt of [() => true, () => { throw new Error('x'); }]) {
      const e = mkEnv({ policy: emptyPolicy(), state: { platformHalt: halt } });
      request(e); approve(e);
      expect(await apply(e)).toMatchObject({ ok: false, status: 409, code: 'HALTED' });
      expect(e.executor.calls.length).toBe(0);
    }
  });
  it('open_breaker_blocks_apply_until_reset', async () => {
    const e = approved();
    e.state.breakers.set('idle_stop', { consecutiveFailures: 3, open: true });
    expect(await apply(e)).toMatchObject({ ok: false, code: 'HALTED' });
    expect(refused(e)).toHaveLength(1);
    resetCircuitBreaker(e.deps, e.policy, approver(), 'idle_stop');
    expect((await apply(e)).ok).toBe(true);
  });
  it('change_freeze_blocks_apply_at_start_and_not_at_end', async () => {
    const { mustPolicy, rawPolicy, NOW } = await import('./testkit');
    const e = mkEnv({ policy: mustPolicy(rawPolicy({ classes: {}, freezeWindows: [{ startMs: NOW, endMs: NOW + HOUR }] })) });
    request(e); approve(e);
    expect(await apply(e)).toMatchObject({ ok: false, status: 409, code: 'HALTED' });
    expect(refused(e)[0].detail.freeze).toBe(true);
    e.clock.set(NOW + HOUR);
    expect((await apply(e)).ok).toBe(true);
  });
});

describe('kill switch and breaker admin', () => {
  it('only_listed_roles_may_engage_or_release_and_every_change_is_audited', () => {
    const e = fresh();
    expect(setKillSwitch(e.deps, e.policy, principal('auditor'), true)).toMatchObject({ ok: false, status: 403 });
    expect(setKillSwitch(e.deps, e.policy, principal('legacy_service'), true)).toMatchObject({ ok: false, status: 403 });
    expect(setKillSwitch(e.deps, e.policy, null, true)).toMatchObject({ ok: false, status: 401 });
    expect(setKillSwitch(e.deps, e.policy, principal('eng_lead', { sub: 'sub-eng' }), true)).toEqual({ ok: true, changed: true });
    expect(setKillSwitch(e.deps, e.policy, principal('eng_lead', { sub: 'sub-eng' }), false)).toMatchObject({ ok: false, status: 403 }); // engage yes, release no
    expect(setKillSwitch(e.deps, e.policy, approver(), false)).toEqual({ ok: true, changed: true });
    expect(e.audit.records().map((r) => [r.outcome, r.actor])).toEqual([['KILL_SWITCH_ENGAGED', 'sub-eng'], ['KILL_SWITCH_RELEASED', 'sub-approver']]);
  });
  it('breaker_reset_is_restricted_and_validates_the_class', () => {
    const e = fresh();
    e.state.breakers.set('idle_stop', { consecutiveFailures: 3, open: true });
    expect(resetCircuitBreaker(e.deps, e.policy, principal('eng_lead', { sub: 'sub-eng' }), 'idle_stop')).toMatchObject({ ok: false, status: 403 });
    expect(resetCircuitBreaker(e.deps, e.policy, approver(), 'bogus')).toMatchObject({ ok: false, status: 400 });
    expect(resetCircuitBreaker(e.deps, e.policy, approver(), 'idle_stop').ok).toBe(true);
    expect(e.state.breakers.get('idle_stop')?.open).toBe(false);
  });
});
