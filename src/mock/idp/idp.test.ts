// Card A2: mock identity provider. This module is the trust root the later
// gateway (card B1) builds on, so these tests are deliberately adversarial:
// every claim, header field and lifecycle state a caller can influence has a
// negative case. All tests are offline and use an injected clock.

import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { createHmac, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import {
  MOCK_IDP_ISSUER,
  MOCK_PERSONAS,
  MOCK_ROLES,
  MockIdpError,
  findMockPersona,
  issueLoginToken,
  issuePersonaToken,
  issueToken,
  mockIdpEnabled,
  parseClaims,
  publicJwks,
  redeemLoginToken,
  reissueSubject,
  resetMockIdpStateForTests,
  retireSigningKey,
  revokeSubject,
  revokeToken,
  rotateSigningKey,
  verifyToken,
  type MockIdpErrorCode,
} from './index';

const ON = Object.freeze({ RATIO_MOCK_IDP: '1', RATIO_ENV: 'test' });
const NOW = 1_800_000_000;

const BASE = Object.freeze({
  sub: 'mock-eng-platform',
  role: 'eng_lead' as const,
  teams: ['Platform Eng'],
  envs: ['dev', 'test'] as ('dev' | 'test' | 'prod')[],
  tenant: 'ratio-demo',
  deployEnv: 'test' as const,
  now: NOW,
});

function b64(value: unknown): string {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}
function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}
function parts(token: string): [string, string, string] {
  const p = token.split('.');
  expect(p).toHaveLength(3);
  return [p[0], p[1], p[2]];
}
function codeOf(fn: () => unknown): MockIdpErrorCode | 'no-throw' | 'not-a-mock-idp-error' {
  try {
    fn();
  } catch (err) {
    return err instanceof MockIdpError ? err.code : 'not-a-mock-idp-error';
  }
  return 'no-throw';
}
function verifyCode(token: string, deployEnv: 'dev' | 'test' | 'prod' = 'test', now = NOW + 1) {
  return codeOf(() => verifyToken(token, { now, deployEnv }, ON));
}

beforeEach(() => {
  resetMockIdpStateForTests();
});

describe('mock identity provider (card A2)', () => {
  it('issues_token_with_role_team_env_tenant_claims', () => {
    const issued = issueToken(BASE, ON);
    const [h, p, s] = parts(issued.token);
    const header = decodeSegment(h);
    const payload = decodeSegment(p);
    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: issued.kid });
    expect(Buffer.from(s, 'base64url')).toHaveLength(64);
    expect(payload).toEqual({
      iss: MOCK_IDP_ISSUER,
      aud: 'test',
      sub: 'mock-eng-platform',
      iat: NOW,
      exp: NOW + 3600,
      jti: issued.jti,
      role: 'eng_lead',
      teams: ['Platform Eng'],
      envs: ['dev', 'test'],
      tenant: 'ratio-demo',
    });
    expect(issued.expiresAt).toBe(NOW + 3600);
    expect(issued.jti).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const claims = verifyToken(issued.token, { now: NOW, deployEnv: 'test' }, ON);
    expect(claims).toEqual(payload);

    // Each token gets a fresh jti, so revocation and replay are per token.
    expect(issueToken(BASE, ON).jti).not.toBe(issued.jti);

    // The issuer validates its own input with the same strict parser: it
    // never signs a role outside the six personas, a wildcard hidden inside
    // a team list, or a lifetime above the cap.
    expect(codeOf(() => issueToken({ ...BASE, role: 'legacy_service' as never }, ON))).toBe('invalid_input');
    expect(codeOf(() => issueToken({ ...BASE, role: 'admin' as never }, ON))).toBe('invalid_input');
    expect(codeOf(() => issueToken({ ...BASE, teams: ['*'] }, ON))).toBe('invalid_input');
    expect(codeOf(() => issueToken({ ...BASE, teams: ['Platform Eng', 'Platform Eng'] }, ON))).toBe('invalid_input');
    expect(codeOf(() => issueToken({ ...BASE, teams: [''] }, ON))).toBe('invalid_input');
    expect(codeOf(() => issueToken({ ...BASE, envs: [] }, ON))).toBe('invalid_input');
    expect(codeOf(() => issueToken({ ...BASE, envs: ['production' as never] }, ON))).toBe('invalid_input');
    expect(codeOf(() => issueToken({ ...BASE, envs: ['dev', 'dev'] }, ON))).toBe('invalid_input');
    expect(codeOf(() => issueToken({ ...BASE, tenant: '' }, ON))).toBe('invalid_input');
    expect(codeOf(() => issueToken({ ...BASE, sub: 'a@b.example' }, ON))).toBe('invalid_input');
    expect(codeOf(() => issueToken({ ...BASE, ttlSeconds: 0 }, ON))).toBe('invalid_input');
    expect(codeOf(() => issueToken({ ...BASE, ttlSeconds: 12 * 3600 + 1 }, ON))).toBe('invalid_input');
    expect(codeOf(() => issueToken({ ...BASE, ttlSeconds: 1.5 }, ON))).toBe('invalid_input');
    expect(issueToken({ ...BASE, teams: '*' }, ON).token).toBeTruthy();
  });

  it('verify_rejects_tampered_role_claim', () => {
    const issued = issueToken(BASE, ON);
    const [h, p, s] = parts(issued.token);
    const payload = decodeSegment(p);

    // Escalate the role, widen the teams, widen the envs, swap the tenant:
    // each edit keeps the original signature and must fail it.
    const edits: Record<string, unknown>[] = [
      { role: 'cto' },
      { role: 'auditor' },
      { teams: '*' },
      { teams: ['Platform Eng', 'CX Engineering'] },
      { envs: ['dev', 'test', 'prod'] },
      { tenant: 'other-tenant' },
      { exp: NOW + 999_999 },
      { sub: 'mock-cto' },
    ];
    for (const edit of edits) {
      const forged = `${h}.${b64({ ...payload, ...edit })}.${s}`;
      expect(verifyCode(forged)).toBe('bad_signature');
    }

    // A token re-signed with an attacker's own Ed25519 key under the real kid.
    const attacker = generateKeyPairSync('ed25519');
    const escalated = b64({ ...payload, role: 'cto', teams: '*' });
    const attackerSig = edSign(null, Buffer.from(`${h}.${escalated}`), attacker.privateKey).toString('base64url');
    expect(verifyCode(`${h}.${escalated}.${attackerSig}`)).toBe('bad_signature');

    // Flipping one signature bit fails; a truncated signature fails.
    const sig = Buffer.from(s, 'base64url');
    sig[10] ^= 0x01;
    expect(verifyCode(`${h}.${p}.${sig.toString('base64url')}`)).toBe('bad_signature');
    expect(verifyCode(`${h}.${p}.${s.slice(0, 40)}`)).toBe('bad_signature');

    // A non-canonical base64url encoding of the same bytes is rejected, so a
    // token has exactly one accepted spelling.
    expect(verifyCode(`${h}.${p}.${s}=`)).toBe('malformed');
    expect(verifyCode(`${h}.${p}+.${s}`)).toBe('malformed');

    // The untouched token still verifies (the fixture itself is sound).
    expect(verifyCode(issued.token)).toBe('no-throw');
  });

  it('verify_rejects_expired_token', () => {
    const issued = issueToken({ ...BASE, ttlSeconds: 60 }, ON);
    expect(verifyCode(issued.token, 'test', NOW)).toBe('no-throw');
    expect(verifyCode(issued.token, 'test', NOW + 59)).toBe('no-throw');
    expect(verifyCode(issued.token, 'test', NOW + 60)).toBe('expired');
    expect(verifyCode(issued.token, 'test', NOW + 10_000)).toBe('expired');
    // A token used before its issue time is not yet valid.
    expect(verifyCode(issued.token, 'test', NOW - 1)).toBe('not_yet_valid');
    // The clock is required and must be a finite number.
    expect(codeOf(() => verifyToken(issued.token, { now: Number.NaN, deployEnv: 'test' }, ON))).toBe('invalid_input');
    expect(codeOf(() => verifyToken(issued.token, { deployEnv: 'test' } as never, ON))).toBe('invalid_input');
  });

  it('verify_rejects_wrong_audience_env', () => {
    const testToken = issueToken({ ...BASE, envs: ['dev', 'test', 'prod'], deployEnv: 'test' }, ON);
    // Even a token whose envs claim lists prod is rejected by a prod
    // deployment when its audience is test.
    expect(verifyCode(testToken.token, 'prod')).toBe('wrong_audience');
    expect(verifyCode(testToken.token, 'dev')).toBe('wrong_audience');
    expect(verifyCode(testToken.token, 'test')).toBe('no-throw');

    const prodToken = issueToken({ ...BASE, deployEnv: 'prod' }, ON);
    expect(verifyCode(prodToken.token, 'test')).toBe('wrong_audience');

    // The verifier's own deployment env must be one of the three values.
    for (const bad of ['production', 'staging', 'TEST', ' test', '', undefined]) {
      expect(codeOf(() => verifyToken(testToken.token, { now: NOW, deployEnv: bad as never }, ON))).toBe('invalid_input');
    }

    // The claims parser refuses an audience array (no "any of" audiences),
    // a missing audience and a foreign issuer.
    const ok = decodeSegment(parts(testToken.token)[1]);
    expect(codeOf(() => parseClaims(ok))).toBe('no-throw');
    expect(codeOf(() => parseClaims({ ...ok, aud: ['test', 'prod'] }))).toBe('invalid_claims');
    expect(codeOf(() => parseClaims({ ...ok, aud: 'production' }))).toBe('invalid_claims');
    const noAud: Record<string, unknown> = { ...ok };
    delete noAud.aud;
    expect(codeOf(() => parseClaims(noAud))).toBe('invalid_claims');
    expect(codeOf(() => parseClaims({ ...ok, iss: 'someone-else' }))).toBe('invalid_claims');
    expect(codeOf(() => parseClaims({ ...ok, extra: true }))).toBe('invalid_claims');
    expect(codeOf(() => parseClaims({ ...ok, once: false }))).toBe('invalid_claims');
    expect(codeOf(() => parseClaims({ ...ok, iat: '1800000000' }))).toBe('invalid_claims');
    expect(codeOf(() => parseClaims({ ...ok, exp: ok.iat }))).toBe('invalid_claims');
    expect(codeOf(() => parseClaims({ ...ok, teams: ['Platform Eng', '*'] }))).toBe('invalid_claims');
    expect(codeOf(() => parseClaims({ ...ok, role: 'legacy_service' }))).toBe('invalid_claims');
    expect(codeOf(() => parseClaims({ ...ok, jti: 'short' }))).toBe('invalid_claims');
    expect(codeOf(() => parseClaims([ok]))).toBe('invalid_claims');
    expect(codeOf(() => parseClaims(null))).toBe('invalid_claims');
    expect(codeOf(() => parseClaims(JSON.parse(`{"__proto__":{"role":"cto"},${JSON.stringify(ok).slice(1)}`)))).toBe('invalid_claims');
  });

  it('verify_rejects_alg_none_and_hs256_confusion', () => {
    const issued = issueToken(BASE, ON);
    const [h, p] = parts(issued.token);
    const header = decodeSegment(h);
    const escalated = b64({ ...decodeSegment(p), role: 'cto', teams: '*' });

    // alg none with an empty signature: malformed (no empty segments).
    for (const alg of ['none', 'None', 'NONE']) {
      expect(verifyCode(`${b64({ ...header, alg })}.${escalated}.`)).toBe('malformed');
      expect(verifyCode(`${b64({ ...header, alg })}.${escalated}.AAAA`)).toBe('unsupported_alg');
    }

    // HS256 confusion: an HMAC keyed with the public key in every form an
    // attacker can obtain from the published JWKS.
    const jwk = publicJwks(ON).keys.find((k) => k.kid === issued.kid);
    expect(jwk).toBeDefined();
    const secrets: (string | Buffer)[] = [
      JSON.stringify(jwk),
      String(jwk?.x),
      Buffer.from(String(jwk?.x), 'base64url'),
    ];
    for (const alg of ['HS256', 'HS384', 'HS512', 'hs256']) {
      const hdr = b64({ ...header, alg });
      for (const secret of secrets) {
        const mac = createHmac('sha256', secret).update(`${hdr}.${escalated}`).digest('base64url');
        expect(verifyCode(`${hdr}.${escalated}.${mac}`)).toBe('unsupported_alg');
      }
    }
    // An HMAC presented under the EdDSA header is just a bad signature.
    const mac = createHmac('sha256', secrets[0]).update(`${h}.${escalated}`).digest('base64url');
    expect(verifyCode(`${h}.${escalated}.${mac}`)).toBe('bad_signature');

    // Other algorithms, a missing alg, a wrong typ, and attacker-supplied key
    // parameters in the header are all refused before any key is used.
    for (const alg of ['ES256', 'RS256', 'PS256', 'eddsa', 'Ed25519', '', undefined]) {
      expect(verifyCode(`${b64({ ...header, alg })}.${escalated}.AAAA`)).toBe('unsupported_alg');
    }
    expect(verifyCode(`${b64({ ...header, typ: 'at+jwt' })}.${p}.AAAA`)).toBe('malformed');
    const attacker = generateKeyPairSync('ed25519');
    const attackerJwk = attacker.publicKey.export({ format: 'jwk' });
    for (const extra of [{ jwk: attackerJwk }, { jku: 'local-keys' }, { x5u: 'local-cert' }, { crit: ['exp'] }]) {
      const hdr = b64({ ...header, ...extra });
      const sig = edSign(null, Buffer.from(`${hdr}.${escalated}`), attacker.privateKey).toString('base64url');
      expect(verifyCode(`${hdr}.${escalated}.${sig}`)).toBe('malformed');
    }

    // Structural junk.
    for (const junk of ['', 'a', 'a.b', 'a.b.c.d', `${h}.${p}`, `${h}..AAAA`, `.${p}.AAAA`, ' ' + issued.token, issued.token + ' ', `${b64('not json')}.${p}.AAAA`, `${b64([header])}.${p}.AAAA`, 'x'.repeat(9000)]) {
      expect(verifyCode(junk)).toBe('malformed');
    }
    expect(codeOf(() => verifyToken(undefined as never, { now: NOW, deployEnv: 'test' }, ON))).toBe('malformed');
  });

  it('verify_rejects_unknown_kid', () => {
    const issued = issueToken(BASE, ON);
    const [h, p, s] = parts(issued.token);
    const header = decodeSegment(h);
    for (const kid of ['nope', 'AAAAAAAAAAAAAAAAAAAAAA', '__proto__', 'constructor', 'toString', '']) {
      expect(verifyCode(`${b64({ ...header, kid })}.${p}.${s}`)).toBe('unknown_kid');
    }
    for (const kid of [undefined, 42, null, ['x'], { k: 1 }]) {
      expect(verifyCode(`${b64({ ...header, kid })}.${p}.${s}`)).toBe('malformed');
    }
    // A token from a previous process state (all keys gone) is unknown.
    resetMockIdpStateForTests();
    expect(verifyCode(issued.token)).toBe('unknown_kid');
  });

  it('verify_rejects_revoked_jti', () => {
    const a = issueToken(BASE, ON);
    const b = issueToken(BASE, ON);
    revokeToken(a.jti, ON);
    expect(verifyCode(a.token)).toBe('revoked');
    expect(verifyCode(b.token)).toBe('no-throw');
    // Revocation is idempotent and survives key rotation.
    revokeToken(a.jti, ON);
    rotateSigningKey(ON);
    expect(verifyCode(a.token)).toBe('revoked');

    // revokeSubject (B7's expire-session) revokes every token issued to that
    // subject so far, and no other subject's tokens.
    const other = issueToken({ ...BASE, sub: 'mock-eng-cx', teams: ['CX Engineering'] }, ON);
    revokeSubject('mock-eng-platform', ON);
    expect(verifyCode(b.token)).toBe('revoked');
    expect(verifyCode(other.token)).toBe('no-throw');
    const later = issueToken(BASE, ON);
    expect(verifyCode(later.token)).toBe('no-throw');

    // A revoked login token cannot be redeemed.
    const login = issueLoginToken('cto', { deployEnv: 'test', now: NOW }, ON);
    revokeToken(login.jti, ON);
    expect(codeOf(() => redeemLoginToken(login.token, { now: NOW + 1, deployEnv: 'test' }, ON))).toBe('revoked');
  });

  it('single_use_token_replay_fails_second_time', () => {
    const login = issueLoginToken('eng-cx', { deployEnv: 'test', now: NOW }, ON);
    expect(login.expiresAt - NOW).toBeLessThanOrEqual(300);
    const ctx = { now: NOW + 1, deployEnv: 'test' as const };

    const first = redeemLoginToken(login.token, ctx, ON);
    expect(first.sub).toBe(findMockPersona('eng-cx')?.sub);
    expect(first.once).toBe(true);
    expect(codeOf(() => redeemLoginToken(login.token, ctx, ON))).toBe('replayed');
    expect(codeOf(() => redeemLoginToken(login.token, { ...ctx, now: NOW + 2 }, ON))).toBe('replayed');

    // A login token is not a session token, and a session token is not a
    // login token: each use is checked in both directions.
    const unused = issueLoginToken('cto', { deployEnv: 'test', now: NOW }, ON);
    expect(codeOf(() => verifyToken(unused.token, ctx, ON))).toBe('wrong_token_use');
    const session = issueToken(BASE, ON);
    expect(codeOf(() => redeemLoginToken(session.token, ctx, ON))).toBe('wrong_token_use');
    expect(verifyCode(session.token)).toBe('no-throw');

    // A failed redemption (wrong audience) does not burn the token, and the
    // later valid redemption burns it.
    expect(codeOf(() => redeemLoginToken(unused.token, { ...ctx, deployEnv: 'prod' }, ON))).toBe('wrong_audience');
    expect(codeOf(() => redeemLoginToken(unused.token, ctx, ON))).toBe('no-throw');
    expect(codeOf(() => redeemLoginToken(unused.token, ctx, ON))).toBe('replayed');

    // An expired login token is expired, not replayable later.
    const stale = issueLoginToken('cto', { deployEnv: 'test', now: NOW }, ON);
    expect(codeOf(() => redeemLoginToken(stale.token, { now: stale.expiresAt, deployEnv: 'test' }, ON))).toBe('expired');

    expect(codeOf(() => issueLoginToken('nobody', { deployEnv: 'test', now: NOW }, ON))).toBe('unknown_persona');
  });

  it('role_change_reissue_reflects_new_claims_and_old_token_is_revoked', () => {
    const old = issuePersonaToken('eng-platform', { deployEnv: 'test', now: NOW }, ON);
    const older = issuePersonaToken('eng-platform', { deployEnv: 'test', now: NOW }, ON);
    const sub = findMockPersona('eng-platform')?.sub as string;
    expect(verifyToken(old.token, { now: NOW + 1, deployEnv: 'test' }, ON).role).toBe('eng_lead');

    const next = reissueSubject(sub, { ...BASE, sub, role: 'finops_lead', teams: '*', envs: ['dev', 'test', 'prod'], now: NOW + 5 }, ON);
    const claims = verifyToken(next.token, { now: NOW + 6, deployEnv: 'test' }, ON);
    expect(claims.role).toBe('finops_lead');
    expect(claims.teams).toBe('*');
    expect(claims.envs).toEqual(['dev', 'test', 'prod']);
    expect(claims.sub).toBe(sub);
    expect(next.jti).not.toBe(old.jti);

    // Every older token of that subject is revoked, not only the latest.
    expect(verifyCode(old.token, 'test', NOW + 6)).toBe('revoked');
    expect(verifyCode(older.token, 'test', NOW + 6)).toBe('revoked');

    // A team change narrows scope the same way.
    const narrowed = reissueSubject(sub, { ...BASE, sub, teams: ['CX Engineering'], now: NOW + 7 }, ON);
    expect(verifyToken(narrowed.token, { now: NOW + 8, deployEnv: 'test' }, ON).teams).toEqual(['CX Engineering']);
    expect(verifyCode(next.token, 'test', NOW + 8)).toBe('revoked');

    // The reissue cannot move a token to a different subject.
    expect(codeOf(() => reissueSubject(sub, { ...BASE, sub: 'mock-cto', now: NOW + 9 }, ON))).toBe('invalid_input');
    expect(verifyCode(narrowed.token, 'test', NOW + 9)).toBe('no-throw');
  });

  it('key_rotation_old_kid_rejected_after_retire', () => {
    const before = issueToken(BASE, ON);
    const rotated = rotateSigningKey(ON);
    expect(rotated.kid).not.toBe(before.kid);
    const after = issueToken(BASE, ON);
    expect(after.kid).toBe(rotated.kid);

    // During the overlap both keys verify, and both are published.
    expect(verifyCode(before.token)).toBe('no-throw');
    expect(verifyCode(after.token)).toBe('no-throw');
    expect(publicJwks(ON).keys.map((k) => k.kid).sort()).toEqual([before.kid, after.kid].sort());

    // The active key cannot be retired; an unknown kid cannot be retired.
    expect(codeOf(() => retireSigningKey(rotated.kid, ON))).toBe('key_state');
    expect(codeOf(() => retireSigningKey('nope', ON))).toBe('key_state');

    retireSigningKey(before.kid, ON);
    expect(verifyCode(before.token)).toBe('unknown_kid');
    expect(verifyCode(after.token)).toBe('no-throw');
    expect(publicJwks(ON).keys.map((k) => k.kid)).toEqual([after.kid]);

    // The published key set carries public parameters only.
    for (const key of publicJwks(ON).keys) {
      expect(Object.keys(key).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x']);
      expect(key).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
    }
  });

  it('mock_idp_enabled_table', () => {
    const rows: [Record<string, string | undefined>, boolean][] = [
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'development' }, true],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'test' }, true],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'test', NODE_ENV: 'production' }, true],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'development', NODE_ENV: 'production' }, true],
      [{ RATIO_MOCK_IDP: '1' }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: undefined }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: '' }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: ' test' }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'test ' }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: ' development ' }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'test\n' }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'Test' }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'DEVELOPMENT' }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'dev' }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'staging' }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'production' }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'prod' }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'Production' }, false],
      [{ RATIO_MOCK_IDP: '1', RATIO_ENV: 'development,production' }, false],
      [{ RATIO_ENV: 'test' }, false],
      [{ RATIO_MOCK_IDP: undefined, RATIO_ENV: 'test' }, false],
      [{ RATIO_MOCK_IDP: '', RATIO_ENV: 'test' }, false],
      [{ RATIO_MOCK_IDP: 'true', RATIO_ENV: 'test' }, false],
      [{ RATIO_MOCK_IDP: ' 1', RATIO_ENV: 'test' }, false],
      [{ RATIO_MOCK_IDP: '1 ', RATIO_ENV: 'test' }, false],
      [{ RATIO_MOCK_IDP: '01', RATIO_ENV: 'test' }, false],
      [{ RATIO_MOCK_IDP: 'yes', RATIO_ENV: 'test' }, false],
      [{ RATIO_MOCK_IDP: '0', RATIO_ENV: 'test' }, false],
      [{ NODE_ENV: 'test' }, false],
      [{ NODE_ENV: 'development', RATIO_MOCK_IDP: '1' }, false],
      [{}, false],
    ];
    for (const [env, expected] of rows) {
      expect({ env, enabled: mockIdpEnabled(env) }).toEqual({ env, enabled: expected });
    }
    // The gate does not consult inherited properties of the env object.
    const inherited = Object.create({ RATIO_MOCK_IDP: '1', RATIO_ENV: 'test' });
    expect(mockIdpEnabled(inherited)).toBe(false);
  });

  it('issuer_refuses_to_run_unless_mock_idp_enabled', () => {
    const issued = issueToken(BASE, ON);
    const login = issueLoginToken('cto', { deployEnv: 'test', now: NOW }, ON);
    const disabled: Record<string, string | undefined>[] = [
      {},
      { RATIO_MOCK_IDP: '1', RATIO_ENV: 'production' },
      { RATIO_MOCK_IDP: '1', RATIO_ENV: 'staging' },
      { RATIO_MOCK_IDP: '1', RATIO_ENV: ' test' },
      { RATIO_MOCK_IDP: 'true', RATIO_ENV: 'test' },
      { RATIO_MOCK_IDP: '1', RATIO_ENV: 'Production', NODE_ENV: 'test' },
    ];
    const ctx = { now: NOW + 1, deployEnv: 'test' as const };
    for (const env of disabled) {
      const calls: (() => unknown)[] = [
        () => issueToken(BASE, env),
        () => issuePersonaToken('cto', { deployEnv: 'test', now: NOW }, env),
        () => issueLoginToken('cto', { deployEnv: 'test', now: NOW }, env),
        () => reissueSubject(BASE.sub, BASE, env),
        () => revokeToken(issued.jti, env),
        () => revokeSubject(BASE.sub, env),
        () => rotateSigningKey(env),
        () => retireSigningKey(issued.kid, env),
        () => publicJwks(env),
        () => verifyToken(issued.token, ctx, env),
        () => redeemLoginToken(login.token, ctx, env),
      ];
      for (const call of calls) expect(codeOf(call)).toBe('disabled');
    }
    // None of the refused calls changed state: the session token is not
    // revoked and the login token is still redeemable exactly once.
    expect(verifyCode(issued.token)).toBe('no-throw');
    expect(publicJwks(ON).keys).toHaveLength(1);
    expect(codeOf(() => redeemLoginToken(login.token, ctx, ON))).toBe('no-throw');

    // The gate defaults to the process environment, which in this test run
    // does not enable the mock IdP.
    vi.stubEnv('RATIO_MOCK_IDP', '');
    try {
      expect(mockIdpEnabled()).toBe(false);
      expect(codeOf(() => issueToken(BASE))).toBe('disabled');
      expect(codeOf(() => verifyToken(issued.token, ctx))).toBe('disabled');
    } finally {
      vi.unstubAllEnvs();
    }

    // A2 imports nothing from A1 (src/identity, src/rbac) or anything else in
    // the app: only node:crypto and its own sibling modules. The gate is a
    // plain string comparison with no imports at all.
    for (const file of ['issuer.ts', 'verifier.ts', 'claims.ts', 'personas.ts', 'enabled.ts', 'index.ts']) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      const specifiers = [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of specifiers) {
        expect({ file, spec, allowed: spec === 'node:crypto' || /^\.\/[a-z]+$/.test(spec) }).toEqual({ file, spec, allowed: true });
      }
      expect(src).not.toMatch(/['"](?:@\/|\.\.\/)|\brequire\s*\(|\bimport\s*\(|NODE_ENV/);
    }
    const enabledSrc = fs.readFileSync(path.join(__dirname, 'enabled.ts'), 'utf8');
    expect(enabledSrc).not.toMatch(/\bimport\b|\btrim\s*\(|toLowerCase|NODE_ENV/);
  });

  it('personas_module_has_no_imports_so_the_sign_in_page_can_import_it_alone', () => {
    const src = fs.readFileSync(path.join(__dirname, 'personas.ts'), 'utf8');
    expect(src).not.toMatch(/\bimport\b/);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bexport\s+(?:\*|\{[^}]*\})\s+from\b/);
    expect(src).not.toMatch(/process\.|globalThis|node:/);
  });

  it('issuer_requires_an_explicit_deploy_env_argument_and_sets_aud_to_it', () => {
    const noEnv: Record<string, unknown> = { ...BASE };
    delete noEnv.deployEnv;
    expect(codeOf(() => issueToken(noEnv as never, ON))).toBe('invalid_input');
    expect(codeOf(() => issuePersonaToken('cto', {} as never, ON))).toBe('invalid_input');
    expect(codeOf(() => issueLoginToken('cto', {} as never, ON))).toBe('invalid_input');
    for (const bad of ['production', 'development', 'staging', 'Test', 'test ', '', null, 1]) {
      expect(codeOf(() => issueToken({ ...BASE, deployEnv: bad as never }, ON))).toBe('invalid_input');
    }
    for (const deployEnv of ['dev', 'test', 'prod'] as const) {
      const issued = issueToken({ ...BASE, deployEnv }, ON);
      expect(decodeSegment(parts(issued.token)[1]).aud).toBe(deployEnv);
      expect(verifyToken(issued.token, { now: NOW, deployEnv }, ON).aud).toBe(deployEnv);
      const persona = issuePersonaToken('auditor', { deployEnv, now: NOW }, ON);
      expect(decodeSegment(parts(persona.token)[1]).aud).toBe(deployEnv);
    }
  });

  it('idp_state_is_shared_across_separately_loaded_module_instances', async () => {
    vi.resetModules();
    const first = await import('./index');
    vi.resetModules();
    const second = await import('./index');
    expect(first.issueToken).not.toBe(second.issueToken);

    const issued = first.issueToken(BASE, ON);
    expect(second.verifyToken(issued.token, { now: NOW, deployEnv: 'test' }, ON).jti).toBe(issued.jti);
    second.revokeToken(issued.jti, ON);
    expect(codeOf(() => first.verifyToken(issued.token, { now: NOW, deployEnv: 'test' }, ON))).toBe('revoked');
    const rotated = second.rotateSigningKey(ON);
    expect(first.issueToken(BASE, ON).kid).toBe(rotated.kid);
    const login = first.issueLoginToken('cto', { deployEnv: 'test', now: NOW }, ON);
    second.redeemLoginToken(login.token, { now: NOW, deployEnv: 'test' }, ON);
    expect(codeOf(() => first.redeemLoginToken(login.token, { now: NOW, deployEnv: 'test' }, ON))).toBe('replayed');
    // The reset helper from one instance clears the state seen by the other.
    first.resetMockIdpStateForTests();
    expect(codeOf(() => second.verifyToken(issued.token, { now: NOW, deployEnv: 'test' }, ON))).toBe('unknown_kid');
    // The process-wide registration uses the agreed global symbol.
    expect(Object.getOwnPropertySymbols(globalThis).map(String)).toContain('Symbol(ratio.mockIdp)');
  });

  it('persona_catalogue_has_two_eng_leads_on_distinct_real_team_names', () => {
    const seededTeams = new Set(WORKLOADS.map((w) => w.team));
    const leads = MOCK_PERSONAS.filter((p) => p.role === 'eng_lead');
    expect(leads.map((p) => p.id).sort()).toEqual(['eng-cx', 'eng-platform']);
    expect(findMockPersona('eng-platform')?.teams).toEqual(['Platform Eng']);
    expect(findMockPersona('eng-cx')?.teams).toEqual(['CX Engineering']);
    for (const lead of leads) {
      expect(lead.teams).not.toBe('*');
      for (const team of lead.teams as readonly string[]) expect(seededTeams.has(team)).toBe(true);
    }
    const [a, b] = leads.map((p) => new Set(p.teams as readonly string[]));
    expect([...a].filter((t) => b.has(t))).toEqual([]);
    // Each seeded lead team really owns workloads, so scoping is observable.
    expect(WORKLOADS.filter((w) => w.team === 'Platform Eng').length).toBeGreaterThan(0);
    expect(WORKLOADS.filter((w) => w.team === 'CX Engineering').length).toBeGreaterThan(0);

    // Persona tokens carry exactly the catalog's claims.
    const issued = issuePersonaToken('eng-cx', { deployEnv: 'test', now: NOW }, ON);
    const claims = verifyToken(issued.token, { now: NOW, deployEnv: 'test' }, ON);
    const cx = findMockPersona('eng-cx');
    expect(claims).toMatchObject({ sub: cx?.sub, role: 'eng_lead', teams: ['CX Engineering'], envs: [...(cx?.envs ?? [])], tenant: cx?.tenant });
    expect(codeOf(() => issuePersonaToken('Eng-CX', { deployEnv: 'test', now: NOW }, ON))).toBe('unknown_persona');
    expect(codeOf(() => issuePersonaToken('__proto__', { deployEnv: 'test', now: NOW }, ON))).toBe('unknown_persona');
    expect(findMockPersona('toString')).toBeUndefined();
  });

  it('persona_catalogue_has_org_wide_principals_for_the_other_roles', () => {
    expect([...MOCK_ROLES].sort()).toEqual(['auditor', 'cto', 'eng_lead', 'finance', 'finops_lead', 'procurement']);
    const covered = new Set(MOCK_PERSONAS.map((p) => p.role));
    expect([...covered].sort()).toEqual([...MOCK_ROLES].sort());
    for (const role of MOCK_ROLES.filter((r) => r !== 'eng_lead')) {
      const personas = MOCK_PERSONAS.filter((p) => p.role === role);
      expect(personas.length).toBeGreaterThan(0);
      for (const p of personas) {
        expect(p.teams).toBe('*');
        expect([...p.envs].sort()).toEqual(['dev', 'prod', 'test']);
      }
    }
    // Ids and subjects are unique, subjects are not emails, one tenant.
    expect(new Set(MOCK_PERSONAS.map((p) => p.id)).size).toBe(MOCK_PERSONAS.length);
    expect(new Set(MOCK_PERSONAS.map((p) => p.sub)).size).toBe(MOCK_PERSONAS.length);
    for (const p of MOCK_PERSONAS) expect(p.sub).not.toContain('@');
    expect(new Set(MOCK_PERSONAS.map((p) => p.tenant)).size).toBe(1);
    expect(MOCK_PERSONAS.some((p) => (p.role as string) === 'legacy_service')).toBe(false);
    // The catalog is frozen: a caller cannot widen a persona at runtime.
    expect(Object.isFrozen(MOCK_PERSONAS)).toBe(true);
    for (const p of MOCK_PERSONAS) {
      expect(Object.isFrozen(p)).toBe(true);
      if (p.teams !== '*') expect(Object.isFrozen(p.teams)).toBe(true);
      expect(Object.isFrozen(p.envs)).toBe(true);
    }
    // Every persona can be issued and verified.
    for (const p of MOCK_PERSONAS) {
      const issued = issuePersonaToken(p.id, { deployEnv: 'dev', now: NOW }, ON);
      expect(verifyToken(issued.token, { now: NOW, deployEnv: 'dev' }, ON).role).toBe(p.role);
    }
  });

  describe('output hygiene', () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
    let spies: MockInstance[] = [];
    let stdout: MockInstance;
    let stderr: MockInstance;
    beforeEach(() => {
      spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
      stdout = vi.spyOn(process.stdout, 'write');
      stderr = vi.spyOn(process.stderr, 'write');
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('no_key_or_token_material_in_console_output', () => {
      const secretsSeen: string[] = [];
      const errors: unknown[] = [];
      const capture = (fn: () => unknown) => {
        try {
          fn();
        } catch (err) {
          errors.push(err);
        }
      };

      const issued = issueToken(BASE, ON);
      const [h, p, s] = parts(issued.token);
      secretsSeen.push(issued.token, p, s);
      const login = issueLoginToken('cto', { deployEnv: 'test', now: NOW }, ON);
      secretsSeen.push(login.token, parts(login.token)[2]);

      const ctx = { now: NOW + 1, deployEnv: 'test' as const };
      capture(() => verifyToken(issued.token, ctx, ON));
      capture(() => verifyToken(issued.token, { ...ctx, deployEnv: 'prod' }, ON));
      capture(() => verifyToken(`${h}.${b64({ ...decodeSegment(p), role: 'cto' })}.${s}`, ctx, ON));
      capture(() => verifyToken(issued.token, { ...ctx, now: NOW + 99_999 }, ON));
      capture(() => verifyToken(`${b64({ alg: 'HS256', typ: 'JWT', kid: issued.kid })}.${p}.${s}`, ctx, ON));
      capture(() => verifyToken(issued.token, ctx, {}));
      capture(() => redeemLoginToken(login.token, ctx, ON));
      capture(() => redeemLoginToken(login.token, ctx, ON));
      capture(() => verifyToken(login.token, ctx, ON));
      capture(() => issueToken({ ...BASE, role: 'root' as never }, ON));
      rotateSigningKey(ON);
      retireSigningKey(issued.kid, ON);
      capture(() => verifyToken(issued.token, ctx, ON));
      revokeSubject(BASE.sub, ON);
      publicJwks(ON);

      // Nothing at all is written to the console or the process streams.
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();

      // Every failure is a MockIdpError with a fixed message that never
      // echoes the token, a token segment or key material, however rendered.
      expect(errors.length).toBeGreaterThanOrEqual(8);
      for (const err of errors) {
        expect(err).toBeInstanceOf(MockIdpError);
        const e = err as MockIdpError;
        const rendered = [e.message, String(e), String(e.stack), inspect(e, { depth: 5, showHidden: true }), JSON.stringify(e)].join('\n');
        for (const secret of secretsSeen) expect(rendered).not.toContain(secret);
        expect(rendered).not.toMatch(/"d"\s*:|privateKey|BEGIN/);
        expect(e.cause).toBeUndefined();
      }
      // The published key set never carries the private scalar.
      expect(JSON.stringify(publicJwks(ON))).not.toMatch(/"d"/);
      // Inspecting the issued result does not expose key objects.
      expect(inspect(issued, { depth: 5 })).not.toMatch(/KeyObject|privateKey/);
    });
  });
});
