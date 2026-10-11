// Checklist 1.1 and 1.3: configuration is parsed as strictly as a token. Every
// field has a boundary test, unknown fields are refused, and a bad value never
// shows up in the error.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_ROLE_PRECEDENCE,
  MAX_CLOCK_SKEW_SECONDS,
  MAX_LIFETIME_CEILING_SECONDS,
  MAX_TOKEN_LENGTH_CEILING,
  OidcError,
  REGISTERED_CLAIMS,
  STANDARD_IGNORED_CLAIMS,
  resolveOidcConfig,
  type OidcConfig,
  type OidcErrorCode,
} from './index';
import { BASE_CONFIG } from './testkit';

const valid = (over: Record<string, unknown> = {}): unknown => ({ ...BASE_CONFIG, ...over });
function codeOf(cfg: unknown): OidcErrorCode | 'no-throw' | 'other' {
  try {
    resolveOidcConfig(cfg);
  } catch (e) {
    return e instanceof OidcError ? e.code : 'other';
  }
  return 'no-throw';
}
const bad = (over: Record<string, unknown>) => expect(codeOf(valid(over))).toBe('invalid_config');
const good = (over: Record<string, unknown>) => expect(codeOf(valid(over))).toBe('no-throw');

describe('defaults and shape', () => {
  it('resolves the base configuration with documented defaults', () => {
    const c = resolveOidcConfig({ ...BASE_CONFIG, clockSkewSeconds: undefined, jwks: undefined });
    expect(c.clockSkewSeconds).toBe(DEFAULT_CLOCK_SKEW_SECONDS);
    expect(c.allowOrgWide).toBe(false);
    expect(c.rejectEmailSub).toBe(true);
    expect(c.maxTokenLength).toBe(8192);
    expect(c.rolePrecedence).toBe(DEFAULT_ROLE_PRECEDENCE);
    expect(c.jwks).toEqual({ ttlSeconds: 600, refreshCooldownSeconds: 30, staleIfErrorSeconds: 3600, maxKeys: 16, maxBytes: 65_536, fetchTimeoutMs: 5000 });
  });

  it('defaults authorizedParty to the audience and validates an explicit one', () => {
    expect(resolveOidcConfig(BASE_CONFIG).authorizedParty).toBe(BASE_CONFIG.audience);
    expect(resolveOidcConfig(valid({ authorizedParty: 'c1' })).authorizedParty).toBe('c1');
    for (const authorizedParty of ['', 'has space', 5, null, 'a'.repeat(257)]) bad({ authorizedParty });
  });

  it('documents the default precedence as narrowest first', () => {
    expect([...DEFAULT_ROLE_PRECEDENCE]).toEqual(['auditor', 'procurement', 'finance', 'eng_lead', 'finops_lead', 'cto']);
    expect(Object.isFrozen(DEFAULT_ROLE_PRECEDENCE)).toBe(true);
  });

  it('returns a frozen result with the only claim names a token may carry', () => {
    const c = resolveOidcConfig(BASE_CONFIG);
    expect(Object.isFrozen(c)).toBe(true);
    for (const n of [...REGISTERED_CLAIMS, ...STANDARD_IGNORED_CLAIMS, 'groups', 'tenant', 'teams', 'envs']) expect(c.knownClaims.has(n)).toBe(true);
    expect(c.knownClaims.has('cnf')).toBe(false);
    expect(c.knownClaims.has('roles')).toBe(false);
    for (const idTokenOnly of ['nonce', 'at_hash', 'c_hash']) expect(c.knownClaims.has(idTokenOnly)).toBe(false);
  });

  it('does not mutate its input', () => {
    const input = JSON.parse(JSON.stringify(BASE_CONFIG)) as OidcConfig;
    const before = JSON.stringify(input);
    resolveOidcConfig(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([[null], [undefined], ['str'], [5], [[]], [() => ({})]])('refuses a non-object configuration (%#)', (cfg) => {
    expect(codeOf(cfg)).toBe('invalid_config');
  });

  it('refuses unknown top-level fields, so a typo in a security setting never silently defaults', () => {
    bad({ allowOrgwide: true });
    bad({ allow_org_wide: true });
    bad({ extra: 1 });
    bad({ jwks: { ttl: 5 } });
    bad({ claims: { ...BASE_CONFIG.claims, extra: 'x' } });
  });

  it.each(['issuer', 'audience', 'jwksUri', 'maxTokenLifetimeSeconds', 'groupToRole', 'claims', 'allowedAlgs', 'allowedTenants'])('requires %s', (field) => {
    const cfg = { ...(valid() as Record<string, unknown>) };
    delete cfg[field];
    expect(codeOf(cfg)).toBe('invalid_config');
  });
});

describe('issuer, audience and key-set URL', () => {
  it.each([
    ['http://idp.example.test/'],
    ['ftp://idp.example.test/'],
    ['file:///etc/passwd'],
    ['javascript:alert(1)'],
    ['data:text/plain,hi'],
    ['//idp.example.test/'],
    ['idp.example.test'],
    ['https://'],
    ['https://user:pw@idp.example.test/'],
    ['https://idp.example.test/?a=1'],
    ['https://idp.example.test/#frag'],
    ['https://idp.example.test/ x'],
    ['https://idp.example.test\\@evil.test/'],
    ['https://idpé.example.test/'],
    [''],
    [5],
    [null],
  ])('refuses the issuer %j', (issuer) => {
    bad({ issuer });
  });

  it('accepts an https issuer with or without a path or trailing slash, and keeps it exactly as written', () => {
    for (const issuer of ['https://idp.example.test', 'https://idp.example.test/', 'https://login.example.test/tenant-1/v2.0']) {
      good({ issuer });
      expect(resolveOidcConfig(valid({ issuer })).issuer).toBe(issuer);
    }
  });

  it.each([
    ['http://idp.example.test/jwks'],
    ['ftp://idp.example.test/jwks'],
    ['file:///keys'],
    ['https://user:pw@idp.example.test/jwks'],
    ['https://idp.example.test/jwks#frag'],
    ['https://idp.example.test/jw ks'],
    ['https://idp.example.test\\@evil.test/jwks'],
    ['https://idp.example.test/\tjwks'],
    ['/relative/jwks.json'],
    [''],
    [undefined],
    [5],
    [`https://idp.example.test/${'a'.repeat(2048)}`],
  ])('refuses the key-set URL %j', (jwksUri) => {
    bad({ jwksUri });
  });

  it('accepts an https key-set URL with a query and normalizes it to its parsed form', () => {
    expect(resolveOidcConfig(valid({ jwksUri: 'https://idp.example.test/keys?tenant=1' })).jwksUri).toBe('https://idp.example.test/keys?tenant=1');
    expect(resolveOidcConfig(valid({ jwksUri: 'https://idp.example.test' })).jwksUri).toBe('https://idp.example.test/');
  });

  it.each([[''], ['has space'], ['a'.repeat(257)], [5], [null], ['tab\t']])('refuses the audience %j', (audience) => {
    bad({ audience });
  });
  it('accepts an audience of 256 printable characters, URIs and client ids', () => {
    good({ audience: 'a'.repeat(256) });
    good({ audience: 'api://ratio' });
    good({ audience: '0oa1b2c3d4' });
  });
});

describe('numeric limits', () => {
  it('caps the clock skew at 120 seconds', () => {
    expect(MAX_CLOCK_SKEW_SECONDS).toBe(120);
    good({ clockSkewSeconds: 0 });
    good({ clockSkewSeconds: 120 });
    bad({ clockSkewSeconds: 121 });
    bad({ clockSkewSeconds: -1 });
    bad({ clockSkewSeconds: 1.5 });
    bad({ clockSkewSeconds: '30' });
    bad({ clockSkewSeconds: Number.NaN });
    bad({ clockSkewSeconds: null });
  });

  it('bounds the token lifetime from 1 second to 24 hours', () => {
    expect(MAX_LIFETIME_CEILING_SECONDS).toBe(86_400);
    good({ maxTokenLifetimeSeconds: 1 });
    good({ maxTokenLifetimeSeconds: 86_400 });
    bad({ maxTokenLifetimeSeconds: 0 });
    bad({ maxTokenLifetimeSeconds: 86_401 });
    bad({ maxTokenLifetimeSeconds: 1.5 });
    bad({ maxTokenLifetimeSeconds: Infinity });
    bad({ maxTokenLifetimeSeconds: '3600' });
  });

  it('bounds the token length from 256 to 16384 characters', () => {
    expect(MAX_TOKEN_LENGTH_CEILING).toBe(16_384);
    good({ maxTokenLength: 256 });
    good({ maxTokenLength: 16_384 });
    bad({ maxTokenLength: 255 });
    bad({ maxTokenLength: 16_385 });
    bad({ maxTokenLength: 8192.5 });
  });

  it('bounds every key-set option at both ends', () => {
    const cases: [string, number, number][] = [
      ['ttlSeconds', 30, 86_400],
      ['staleIfErrorSeconds', 0, 86_400],
      ['maxKeys', 1, 64],
      ['maxBytes', 1024, 262_144],
      ['fetchTimeoutMs', 100, 30_000],
    ];
    for (const [name, lo, hi] of cases) {
      good({ jwks: { [name]: lo } });
      good({ jwks: { [name]: hi } });
      bad({ jwks: { [name]: lo - 1 } });
      bad({ jwks: { [name]: hi + 1 } });
      bad({ jwks: { [name]: lo + 0.5 } });
      bad({ jwks: { [name]: String(lo) } });
    }
  });

  it('keeps the refresh cooldown between 1 second and the TTL', () => {
    good({ jwks: { ttlSeconds: 60, refreshCooldownSeconds: 1 } });
    good({ jwks: { ttlSeconds: 60, refreshCooldownSeconds: 60 } });
    bad({ jwks: { ttlSeconds: 60, refreshCooldownSeconds: 0 } });
    bad({ jwks: { ttlSeconds: 60, refreshCooldownSeconds: 61 } });
    bad({ jwks: { refreshCooldownSeconds: 601 } }); // default TTL is 600
  });

  it('keeps a default cooldown no longer than a short TTL', () => {
    expect(resolveOidcConfig(valid({ jwks: { ttlSeconds: 30 } })).jwks.refreshCooldownSeconds).toBe(30);
    expect(resolveOidcConfig(valid({ jwks: { ttlSeconds: 31 } })).jwks.refreshCooldownSeconds).toBe(30);
  });

  it('refuses a key-set options value that is not an object', () => {
    for (const jwks of [null, 5, 'x', []]) bad({ jwks });
  });
});

describe('algorithms', () => {
  it('accepts any non-empty subset of RS256, ES256 and EdDSA', () => {
    for (const allowedAlgs of [['RS256'], ['ES256'], ['EdDSA'], ['ES256', 'EdDSA'], ['RS256', 'ES256', 'EdDSA']]) good({ allowedAlgs });
  });
  it.each([
    [[]],
    [['none']],
    [['HS256']],
    [['HS384']],
    [['HS512']],
    [['RS384']],
    [['PS256']],
    [['ES384']],
    [['rs256']],
    [['RS256', 'RS256']],
    [['RS256', 'none']],
    [['RS256', 'ES256', 'EdDSA', 'ES256']],
    ['RS256'],
    [null],
    [[5]],
  ])('refuses the allowlist %j', (allowedAlgs) => {
    bad({ allowedAlgs });
  });
});

describe('group-to-role map and precedence', () => {
  it('requires a non-empty map of at most 256 groups', () => {
    bad({ groupToRole: {} });
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`g${i}`, 'auditor']));
    good({ groupToRole: many(256) });
    bad({ groupToRole: many(257) });
  });
  it.each([['legacy_service'], ['admin'], ['CTO'], [''], [5], [null], [['cto']]])('refuses the role value %j', (role) => {
    bad({ groupToRole: { g: role } });
  });
  it('refuses a group name that is empty, has a control character, or is over 256 characters', () => {
    bad({ groupToRole: { '': 'cto' } });
    bad({ groupToRole: { 'a\nb': 'cto' } });
    bad({ groupToRole: { ['g'.repeat(257)]: 'cto' } });
    good({ groupToRole: { ['g'.repeat(256)]: 'cto', 'Ratio FinOps Leads': 'finops_lead' } });
  });
  it('treats prototype-looking group names as plain data', () => {
    const parsed = JSON.parse('{"__proto__":"cto","constructor":"auditor"}');
    const c = resolveOidcConfig(valid({ groupToRole: parsed }));
    expect(c.groupToRole.get('__proto__')).toBe('cto');
    expect(c.groupToRole.get('constructor')).toBe('auditor');
    expect(c.groupToRole.get('toString')).toBeUndefined();
  });
  it('accepts a precedence that ranks every mapped role and refuses one that does not', () => {
    const groupToRole = { a: 'cto', b: 'auditor' };
    good({ groupToRole, rolePrecedence: ['auditor', 'cto'] });
    good({ groupToRole, rolePrecedence: ['cto', 'auditor', 'finance'] });
    bad({ groupToRole, rolePrecedence: ['cto'] }); // auditor has no rank
    bad({ groupToRole, rolePrecedence: [] });
    bad({ groupToRole, rolePrecedence: ['cto', 'cto', 'auditor'] });
    bad({ groupToRole, rolePrecedence: ['cto', 'auditor', 'legacy_service'] });
    bad({ groupToRole, rolePrecedence: ['cto', 'auditor', 'root'] });
    bad({ groupToRole, rolePrecedence: 'cto' });
    bad({ groupToRole, rolePrecedence: ['cto', 'auditor', 'finance', 'eng_lead', 'procurement', 'finops_lead', 'cto'] });
  });
});

describe('claim names, tenants and flags', () => {
  const names = (over: Record<string, unknown>) => ({ ...BASE_CONFIG.claims, ...over });
  it('requires four distinct, non-registered, printable claim names', () => {
    good({ claims: names({ groups: 'https://ratio.example/groups' }) });
    good({ claims: names({ groups: 'cognito:groups' }) });
    bad({ claims: names({ teams: 'groups' }) }); // duplicate
    for (const reserved of REGISTERED_CLAIMS) bad({ claims: names({ groups: reserved }) });
    bad({ claims: names({ groups: '__proto__' }) });
    bad({ claims: names({ groups: 'constructor' }) });
    bad({ claims: names({ groups: '' }) });
    bad({ claims: names({ groups: 'has space' }) });
    bad({ claims: names({ groups: 'g'.repeat(129) }) });
    bad({ claims: names({ groups: 5 }) });
    bad({ claims: { groups: 'g', tenant: 't', teams: 'x' } }); // envs missing
    bad({ claims: 'groups' });
  });

  it('requires one to 64 well-formed tenant ids', () => {
    good({ allowedTenants: ['a'] });
    good({ allowedTenants: Array.from({ length: 64 }, (_, i) => `t${i}`) });
    bad({ allowedTenants: Array.from({ length: 65 }, (_, i) => `t${i}`) });
    bad({ allowedTenants: [] });
    bad({ allowedTenants: ['a', 'a'] });
    bad({ allowedTenants: ['has space'] });
    bad({ allowedTenants: ['a@b'] });
    bad({ allowedTenants: [''] });
    bad({ allowedTenants: ['t'.repeat(129)] });
    bad({ allowedTenants: [5] });
    bad({ allowedTenants: 'acme' });
  });

  it('accepts booleans only for the two flags', () => {
    for (const flag of ['allowOrgWide', 'rejectEmailSub']) {
      good({ [flag]: true });
      good({ [flag]: false });
      bad({ [flag]: 'true' });
      bad({ [flag]: 1 });
      bad({ [flag]: null });
    }
  });

  it('bounds the extra ignored claims', () => {
    good({ extraIgnoredClaims: [] });
    good({ extraIgnoredClaims: Array.from({ length: 64 }, (_, i) => `x${i}`) });
    bad({ extraIgnoredClaims: Array.from({ length: 65 }, (_, i) => `x${i}`) });
    bad({ extraIgnoredClaims: ['has space'] });
    bad({ extraIgnoredClaims: ['__proto__'] });
    bad({ extraIgnoredClaims: 'x' });
    expect(resolveOidcConfig(valid({ extraIgnoredClaims: ['x-custom'] })).knownClaims.has('x-custom')).toBe(true);
  });
});

describe('error hygiene', () => {
  it('never echoes a bad value', () => {
    const MARK = 'SECRET-MARKER-7c1d';
    const attempts: Record<string, unknown>[] = [
      { issuer: `http://${MARK}.test/` },
      { audience: `${MARK} x` },
      { jwksUri: `http://${MARK}.test/jwks` },
      { groupToRole: { [MARK]: 'nope' } },
      { claims: { groups: MARK, tenant: MARK, teams: 'a', envs: 'b' } },
      { allowedTenants: [`${MARK}@x`] },
      { [`typo${MARK}`]: true },
    ];
    for (const over of attempts) {
      let err: unknown;
      try {
        resolveOidcConfig(valid(over));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(OidcError);
      expect(String((err as Error).message) + String((err as Error).stack)).not.toContain(MARK);
      expect((err as OidcError).code).toBe('invalid_config');
    }
  });
});
