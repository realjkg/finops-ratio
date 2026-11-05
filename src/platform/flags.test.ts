// D7 (ADR-0001): the per-instance opt-in `platform` block. Absent means all off; a capability is on only with
// `enabled` AND its own flag; nothing is ever turned on by default. Problems name the key, never the value.
import { describe, expect, it } from 'vitest';
import { PLATFORM_CAPABILITIES, PLATFORM_OFF, PlatformDisabledError, capabilityOn, parsePlatformBlock, requireCapability } from './flags';

describe('platform flags (D7)', () => {
  it('absent, empty or all-false blocks are all off; nothing is on by default', () => {
    expect(PLATFORM_CAPABILITIES).toEqual(['economics', 'adoption', 'policyMonitor', 'enforcement']);
    expect(PLATFORM_OFF).toEqual({ enabled: false, economics: false, adoption: false, policyMonitor: false, enforcement: false });
    expect(Object.isFrozen(PLATFORM_OFF)).toBe(true);
    for (const v of [undefined, {}, { enabled: false }, { ...PLATFORM_OFF }]) expect(parsePlatformBlock(v)).toEqual({ ok: true, flags: PLATFORM_OFF });
    for (const cap of PLATFORM_CAPABILITIES) {
      expect(capabilityOn(undefined, cap)).toBe(false);
      expect(capabilityOn(PLATFORM_OFF, cap)).toBe(false);
    }
  });
  it('a capability is on only with enabled and its own flag; omitted flags are false', () => {
    const r = parsePlatformBlock({ enabled: true, economics: true });
    expect(r).toEqual({ ok: true, flags: { enabled: true, economics: true, adoption: false, policyMonitor: false, enforcement: false } });
    const flags = r.ok ? r.flags : PLATFORM_OFF;
    expect(PLATFORM_CAPABILITIES.filter((c) => capabilityOn(flags, c))).toEqual(['economics']);
    expect(PLATFORM_CAPABILITIES.filter((c) => capabilityOn({ ...PLATFORM_OFF, enabled: true }, c))).toEqual([]);
    // A hand-built object that bypassed parsing still needs `enabled`.
    expect(capabilityOn({ ...PLATFORM_OFF, economics: true }, 'economics')).toBe(false);
  });
  it('a sub-flag without enabled, a non-boolean or an unknown key is refused by key, never by value', () => {
    expect(parsePlatformBlock({ economics: true })).toEqual({ ok: false, problems: ['platform.economics: requires platform.enabled to be true'] });
    expect(parsePlatformBlock({ enabled: false, enforcement: true, adoption: true })).toEqual({ ok: false, problems: ['platform.adoption: requires platform.enabled to be true', 'platform.enforcement: requires platform.enabled to be true'] });
    expect(parsePlatformBlock({ enabled: 'yes' })).toEqual({ ok: false, problems: ['platform.enabled: must be true or false'] });
    expect(parsePlatformBlock({ enabled: true, economics: 1 })).toEqual({ ok: false, problems: ['platform.economics: must be true or false'] });
    expect(parsePlatformBlock({ enabled: true, gateway: true })).toEqual({ ok: false, problems: ['platform.gateway: unknown key'] });
    expect(parsePlatformBlock({ 'sk-LEAKED-VALUE-9f3c x': true })).toEqual({ ok: false, problems: ['platform: unknown key (not printed)'] });
    for (const v of [null, true, 'on', [], [true]]) expect(parsePlatformBlock(v), JSON.stringify(v)).toEqual({ ok: false, problems: ['platform: must be an object of true/false flags (enabled, economics, adoption, policyMonitor, enforcement)'] });
    expect(parsePlatformBlock({ __proto__: { enabled: true } } as unknown)).toEqual({ ok: false, problems: ['platform: must be an object of true/false flags (enabled, economics, adoption, policyMonitor, enforcement)'] });
  });
  it('only own keys count: an inherited Object.prototype flag never turns the platform on (review L3)', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, 'enabled', { value: true, configurable: true, writable: true });
    Object.defineProperty(proto, 'economics', { value: true, configurable: true, writable: true });
    try {
      expect(parsePlatformBlock({})).toEqual({ ok: true, flags: PLATFORM_OFF });
      expect(parsePlatformBlock({ adoption: false })).toEqual({ ok: true, flags: PLATFORM_OFF });
      expect(parsePlatformBlock({ economics: true })).toEqual({ ok: false, problems: ['platform.economics: requires platform.enabled to be true'] });
    } finally {
      delete proto.enabled;
      delete proto.economics;
    }
    expect(({} as Record<string, unknown>).enabled).toBeUndefined();
  });
  it('the parsed flags are a fresh frozen object, never the input', () => {
    const input = { enabled: true, economics: true };
    const r = parsePlatformBlock(input);
    expect(r.ok && r.flags !== (input as unknown)).toBe(true);
    expect(r.ok && Object.isFrozen(r.flags)).toBe(true);
  });
  it('requireCapability refuses (PLATFORM_DISABLED) unless the capability is on', () => {
    expect(() => requireCapability(undefined, 'economics')).toThrow(PlatformDisabledError);
    expect(() => requireCapability({ ...PLATFORM_OFF, enabled: true, adoption: true }, 'economics')).toThrow(/platform capability economics is off/);
    try { requireCapability(PLATFORM_OFF, 'enforcement'); } catch (e) { expect((e as PlatformDisabledError).code).toBe('PLATFORM_DISABLED'); }
    expect(() => requireCapability({ ...PLATFORM_OFF, enabled: true, economics: true }, 'economics')).not.toThrow();
  });
});
