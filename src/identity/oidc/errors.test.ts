// Checklist 1.4: the fixed-text error type, its cross-bundle instanceof, and the
// shape of the public surface.

import { describe, expect, it, vi } from 'vitest';
import { OIDC_ERROR_CODES, OidcError, oidcErrorMessage } from './errors';
import * as surface from './index';

describe('OidcError', () => {
  it('carries a code from the closed union and fixed text for it', () => {
    expect(OIDC_ERROR_CODES).toHaveLength(23);
    for (const code of OIDC_ERROR_CODES) {
      const e = new OidcError(code);
      expect(e.code).toBe(code);
      expect(e.name).toBe('OidcError');
      expect(e.message).toBe(oidcErrorMessage(code));
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('has lowercase fixed messages with no interpolation markers', () => {
    for (const code of OIDC_ERROR_CODES) {
      const m = oidcErrorMessage(code);
      expect(m).toMatch(/^[a-z][a-z ]+[a-z]$/);
      expect(m).not.toMatch(/[${}'"`:]/);
    }
  });

  it('is recognized across separately loaded copies of the module (bundle-safe instanceof)', async () => {
    vi.resetModules();
    const other = await import('./errors');
    expect(other.OidcError).not.toBe(OidcError);
    const fromOther = new other.OidcError('expired');
    expect(fromOther instanceof OidcError).toBe(true);
    expect(new OidcError('expired') instanceof other.OidcError).toBe(true);
  });

  it('is not fooled by lookalikes', () => {
    expect({ code: 'expired', message: 'token has expired', name: 'OidcError' } instanceof OidcError).toBe(false);
    expect(Object.assign(new Error('x'), { code: 'expired' }) instanceof OidcError).toBe(false);
    expect((null as unknown) instanceof OidcError).toBe(false);
    expect(('OidcError' as unknown) instanceof OidcError).toBe(false);
    expect(Object.create(null) instanceof OidcError).toBe(false);
  });

  it('keeps the brand off enumeration and serialization', () => {
    const e = new OidcError('revoked');
    expect(Object.getOwnPropertySymbols(e).length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(e))).toEqual({ name: 'OidcError', code: 'revoked' });
  });
});

describe('public surface', () => {
  it('exports the verifier, config, cache, denylist and error types and no test helpers', () => {
    for (const name of ['OidcVerifier', 'OidcError', 'JwksCache', 'resolveOidcConfig', 'createMemoryJtiDenylist', 'OIDC_ERROR_CODES', 'DEFAULT_ROLE_PRECEDENCE', 'OIDC_ALGS']) {
      expect(Object.keys(surface)).toContain(name);
    }
    for (const name of ['makeToken', 'harness', 'FakeJwks', 'rsaKey', 'keys']) expect(Object.keys(surface)).not.toContain(name);
  });

  it('can only ever offer the three allowed algorithms', () => {
    expect([...surface.OIDC_ALGS]).toEqual(['RS256', 'ES256', 'EdDSA']);
    expect(Object.isFrozen(surface.OIDC_ALGS)).toBe(true);
  });
});
