// Registry invariants: only low-risk reversible non-commitment actions can ever be autonomy-eligible.
import { describe, expect, it } from 'vitest';
import { ACTION_REGISTRY, SEED_ACTIONS, buildRegistry, RegistryInvariantError, type ActionDefinition } from './registry';
import { parseTenantPolicy } from './policy';
import { rawPolicy, classPolicy } from './testkit';

const base = (over: Record<string, unknown> = {}): ActionDefinition => ({
  id: 'x_action', class: 'x_class', title: 'X', risk: 'low', reversible: true, impact: 'cost', autonomyEligible: false,
  params: { a: { kind: 'bool' } }, hardMaxResources: 1, resources: () => ['r1'], ...over,
} as unknown as ActionDefinition);
const code = (d: unknown[]) => { try { buildRegistry(d as ActionDefinition[]); return 'ok'; } catch (e) { return e instanceof RegistryInvariantError ? e.code : 'other'; } };

describe('registry', () => {
  it('seed_marks_only_idle_stop_and_schedule_eligible', () => {
    const eligible = SEED_ACTIONS.filter((a) => a.autonomyEligible).map((a) => a.id).sort();
    expect(eligible).toEqual(['schedule_on_off', 'stop_idle_dev_instance']);
    for (const a of SEED_ACTIONS.filter((x) => x.autonomyEligible)) { expect(a.risk).toBe('low'); expect(a.reversible).toBe(true); }
  });
  it('irreversible_high_risk_and_commitment_are_ineligible', () => {
    for (const id of ['delete_unattached_volume', 'buy_commitment', 'resize_down']) expect(ACTION_REGISTRY.isClassEligible(ACTION_REGISTRY.get(id)!.class)).toBe(false);
    expect(ACTION_REGISTRY.get('buy_commitment')!.impact).toBe('commitment');
  });
  it('startup_check_refuses_each_violation', () => {
    expect(code([base({ autonomyEligible: true, risk: 'medium' })])).toBe('INELIGIBLE_AUTONOMY');
    expect(code([base({ autonomyEligible: true, risk: 'high' })])).toBe('INELIGIBLE_AUTONOMY');
    expect(code([base({ autonomyEligible: true, reversible: false })])).toBe('INELIGIBLE_AUTONOMY');
    expect(code([base({ autonomyEligible: true, impact: 'commitment' })])).toBe('COMMITMENT_AUTONOMY');
    expect(code([base({ autonomyEligible: true })])).toBe('ok');
  });
  it('structural_refusals', () => {
    expect(code([])).toBe('EMPTY');
    expect(code([base(), base()])).toBe('DUPLICATE_ID');
    expect(code([base({ id: 'Bad Id' })])).toBe('BAD_ID');
    expect(code([base({ hardMaxResources: 0 })])).toBe('BAD_LIMIT');
    expect(code([base({ hardMaxResources: 101 })])).toBe('BAD_LIMIT');
    expect(code([base({ params: {} })])).toBe('BAD_SCHEMA');
    expect(code([base({ risk: 'extreme' })])).toBe('BAD_SHAPE');
    expect(code([base({ autonomyEligible: true }), base({ id: 'y_action' })])).toBe('CLASS_MIXED');
    expect(code(Array.from({ length: 65 }, (_, i) => base({ id: `a_${i}` })))).toBe('TOO_MANY');
  });
  it('lookup_ignores_prototype_keys', () => {
    for (const k of ['__proto__', 'constructor', 'toString', 5, null]) expect(ACTION_REGISTRY.get(k)).toBeUndefined();
    expect(ACTION_REGISTRY.isClassEligible('constructor')).toBe(false);
  });
  it('a_policy_cannot_enable_an_ineligible_or_unknown_class', () => {
    for (const cls of ['commitment', 'orphan_cleanup', 'rightsize']) {
      const r = parseTenantPolicy(ACTION_REGISTRY, rawPolicy({ classes: { [cls]: classPolicy() } }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('POLICY_CLASS_NOT_ELIGIBLE');
    }
    const r = parseTenantPolicy(ACTION_REGISTRY, rawPolicy({ classes: JSON.parse('{"__proto__":{}}') }));
    expect(r.ok).toBe(false);
  });
});
