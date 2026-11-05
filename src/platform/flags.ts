// ADR-0001 D7: the per-instance opt-in `platform` block of the engagement config,
//   { "enabled": false, "economics": false, "adoption": false, "policyMonitor": false, "enforcement": false }.
// Absent means all off; an omitted flag is false; a capability flag needs `enabled`. A capability is on only with
// both. SUPPORTED_IN_THIS_BUILD (src/engagement/config.ts) says what a build can accept and never turns one on.
// Pure and dependency-free: R1 (app server) and the worker parse the block with this one module. Problems name the
// key, never the value.

export const PLATFORM_CAPABILITIES = ['economics', 'adoption', 'policyMonitor', 'enforcement'] as const;
export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];
export type PlatformFlags = Readonly<{ enabled: boolean } & Record<PlatformCapability, boolean>>;

const KEYS = ['enabled', ...PLATFORM_CAPABILITIES] as const;
export const PLATFORM_OFF: PlatformFlags = Object.freeze({ enabled: false, economics: false, adoption: false, policyMonitor: false, enforcement: false });

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export type PlatformBlockResult = { ok: true; flags: PlatformFlags } | { ok: false; problems: string[] };

/** The validated, normalized flags of a `platform` block (`undefined` = absent = all off). */
export function parsePlatformBlock(v: unknown, at = 'platform'): PlatformBlockResult {
  if (v === undefined) return { ok: true, flags: PLATFORM_OFF };
  if (!isPlainObject(v)) return { ok: false, problems: [`${at}: must be an object of true/false flags (${KEYS.join(', ')})`] };
  const p: string[] = [];
  for (const k of Object.keys(v)) {
    if (!(KEYS as readonly string[]).includes(k)) p.push(/^[A-Za-z0-9_]{1,40}$/.test(k) ? `${at}.${k}: unknown key` : `${at}: unknown key (not printed)`);
  }
  for (const k of KEYS) if (v[k] !== undefined && typeof v[k] !== 'boolean') p.push(`${at}.${k}: must be true or false`);
  if (p.length) return { ok: false, problems: p };
  for (const k of PLATFORM_CAPABILITIES) if (v[k] === true && v.enabled !== true) p.push(`${at}.${k}: requires ${at}.enabled to be true`);
  if (p.length) return { ok: false, problems: p };
  return { ok: true, flags: Object.freeze(Object.fromEntries(KEYS.map((k) => [k, v[k] === true])) as PlatformFlags) };
}

/** True only when the platform is enabled AND the capability's own flag is set. */
export const capabilityOn = (flags: PlatformFlags | undefined, cap: PlatformCapability): boolean => flags?.enabled === true && flags[cap] === true;

export class PlatformDisabledError extends Error {
  readonly code = 'PLATFORM_DISABLED';
  constructor(cap: PlatformCapability) {
    super(`platform capability ${cap} is off (engagement config platform.enabled and platform.${cap})`);
    this.name = 'PlatformDisabledError';
  }
}

/** Every platform entry point calls this first: nothing platform-related runs unless the owner enabled it. */
export function requireCapability(flags: PlatformFlags | undefined, cap: PlatformCapability): void {
  if (!capabilityOn(flags, cap)) throw new PlatformDisabledError(cap);
}
