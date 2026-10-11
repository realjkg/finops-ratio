// Tenant policy parsing: strict, bounded, fail closed.
import { describe, expect, it } from 'vitest';
import { POLICY_ERROR_TEXT, createEmptyPolicy, isParsedPolicy, parseTenantPolicy } from './policy';
import { ACTION_REGISTRY } from './registry';
import { classPolicy, rawPolicy } from './testkit';

const parse = (raw: unknown) => parseTenantPolicy(ACTION_REGISTRY, raw);
const code = (raw: unknown) => { const r = parse(raw); return r.ok ? 'ok' : r.code; };

describe('parseTenantPolicy', () => {
  it('accepts_a_valid_policy_and_freezes_it', () => {
    const r = parse(rawPolicy());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(isParsedPolicy(r.policy)).toBe(true);
    expect(Object.isFrozen(r.policy)).toBe(true);
    expect(r.policy.classes.idle_stop.maxCostAtStakePerAction).toBe(BigInt(100_000));
  });
  it('the_empty_policy_enables_nothing_and_only_parsed_objects_count', () => {
    const e = createEmptyPolicy('t1');
    expect(Object.keys(e.classes)).toEqual([]);
    expect(isParsedPolicy({ ...e })).toBe(false);
    expect(() => createEmptyPolicy('bad tenant')).toThrow();
  });
  it('refuses_non_objects_unknown_keys_and_prototype_keys', () => {
    for (const bad of [null, 5, 'x', []]) expect(code(bad)).toBe('POLICY_NOT_OBJECT');
    expect(code({ ...rawPolicy(), extra: 1 })).toBe('POLICY_UNKNOWN_KEY');
    expect(code(JSON.parse('{"version":"v","__proto__":{"classes":{}}}'))).toBe('POLICY_UNKNOWN_KEY');
    expect(code(rawPolicy({ classes: { idle_stop: { ...classPolicy(), extra: 1 } } }))).toBe('POLICY_FIELD');
  });
  it('refuses_ineligible_unknown_and_prototype_class_names', () => {
    expect(code(rawPolicy({ classes: { commitment: classPolicy() } }))).toBe('POLICY_CLASS_NOT_ELIGIBLE');
    expect(code(rawPolicy({ classes: { orphan_cleanup: classPolicy() } }))).toBe('POLICY_CLASS_NOT_ELIGIBLE');
    expect(code(rawPolicy({ classes: { nope: classPolicy() } }))).toBe('POLICY_UNKNOWN_CLASS');
    expect(code(rawPolicy({ classes: JSON.parse('{"__proto__":{}}') }))).toBe('POLICY_UNKNOWN_CLASS');
    expect(code(rawPolicy({ classes: { constructor: classPolicy() } }))).toBe('POLICY_UNKNOWN_CLASS');
  });
  it('enable_and_deny_of_one_class_contradict', () => {
    expect(code(rawPolicy({ denyClasses: ['idle_stop'] }))).toBe('POLICY_CONTRADICTION');
    expect(code(rawPolicy({ denyClasses: ['nope'] }))).toBe('POLICY_UNKNOWN_CLASS');
  });
  it('caps_have_boundaries', () => {
    expect(code(rawPolicy({ circuitBreakerThreshold: 0 }))).toBe('POLICY_FIELD');
    expect(code(rawPolicy({ circuitBreakerThreshold: 20 }))).toBe('ok');
    expect(code(rawPolicy({ circuitBreakerThreshold: 21 }))).toBe('POLICY_FIELD');
    expect(code(rawPolicy({ classes: { idle_stop: classPolicy({ maxResourcesPerAction: 20 }) } }))).toBe('ok');
    expect(code(rawPolicy({ classes: { idle_stop: classPolicy({ maxResourcesPerAction: 21 }) } }))).toBe('POLICY_FIELD'); // registry hard max
    expect(code(rawPolicy({ classes: { idle_stop: classPolicy({ maxCostAtStakePerAction: -1 }) } }))).toBe('POLICY_FIELD');
    expect(code(rawPolicy({ classes: { idle_stop: classPolicy({ maxCostAtStakePerAction: 1.5 }) } }))).toBe('POLICY_FIELD');
    expect(code(rawPolicy({ classes: { idle_stop: classPolicy({ cooldownMs: 999 }) } }))).toBe('POLICY_FIELD');
    expect(code(rawPolicy({ classes: { idle_stop: classPolicy({ environments: [] }) } }))).toBe('POLICY_FIELD');
    expect(code(rawPolicy({ classes: { idle_stop: classPolicy({ environments: ['prod', 'prod'] }) } }))).toBe('POLICY_FIELD');
    expect(code(rawPolicy({ classes: { idle_stop: classPolicy({ environments: ['staging'] }) } }))).toBe('POLICY_FIELD');
    expect(code(rawPolicy({ currency: 'usd' }))).toBe('POLICY_FIELD');
  });
  it('freeze_windows_are_bounded', () => {
    const w = (i: number) => ({ startMs: i * 10, endMs: i * 10 + 5 });
    expect(code(rawPolicy({ freezeWindows: Array.from({ length: 32 }, (_, i) => w(i)) }))).toBe('ok');
    expect(code(rawPolicy({ freezeWindows: Array.from({ length: 33 }, (_, i) => w(i)) }))).toBe('POLICY_TOO_MANY');
    expect(code(rawPolicy({ freezeWindows: [{ startMs: 10, endMs: 10 }] }))).toBe('POLICY_FIELD');
    expect(code(rawPolicy({ freezeWindows: [{ startMs: 0, endMs: 91 * 86_400_000 }] }))).toBe('POLICY_FIELD');
  });
  it('errors_have_fixed_text', () => {
    expect(JSON.stringify(parse(rawPolicy({ version: 'EVIL CANARY ??' })))).not.toContain('CANARY');
    for (const t of Object.values(POLICY_ERROR_TEXT)) expect(t).toMatch(/^[A-Z][A-Za-z ]+$/);
  });
});
