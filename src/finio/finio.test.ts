// Tests for the FinIO A2A seam: FOCUS conformance of the emitted rows, version
// negotiation, session integrity, and mock/live behavioural parity.
//
// These encode the acceptance criteria the FinIO spec states but that nothing in
// the repo checked — FinIO was the only client seam shipping with no tests while
// costsource, tokenomics, prediction, ai, and the gateway all had them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import { governanceGatesPassed } from '@/lib/derive';
import { FOCUS_VERSIONS, CANONICAL_FOCUS_VERSION } from '@/costsource/focusVersions';
import { resolveWorkloadId } from '@/costsource/seed';
import { FINIO_SOURCE_ID, type FocusRow } from './FinioClient';
import { finioRowsForVersion } from './finioRows';
import { validateFocusRow, validateFocusRows } from './focusValidation';
import {
  SUPPORTED_FOCUS_VERSIONS,
  acceptedOperations,
  buildFinioExport,
  negotiateFocusVersion,
  parseHandshakeRequest,
} from './exchange';
import { createSession, validateSession } from './sessionStore';
import { createFinioClient } from './index';

// ---------------------------------------------------------------------------
// FOCUS conformance — the spec's stated row-validity rules
// ---------------------------------------------------------------------------

describe('validateFocusRow', () => {
  const good = (): FocusRow => finioRowsForVersion('1.4')[0];

  it('accepts every row the responder emits, at every supported version', () => {
    for (const version of FOCUS_VERSIONS) {
      const result = validateFocusRows(finioRowsForVersion(version));
      expect(result, `version ${version}`).toEqual({ ok: true });
    }
  });

  it('rejects a null or non-finite BilledCost', () => {
    for (const bad of [null, undefined, NaN, Infinity, '100']) {
      const row = { ...good(), BilledCost: bad } as unknown as FocusRow;
      const result = validateFocusRow(row);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.errors.join()).toContain('BilledCost');
    }
  });

  it('rejects a missing BillingCurrency', () => {
    const result = validateFocusRow({ ...good(), BillingCurrency: '' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join()).toContain('BillingCurrency');
  });

  it('requires BillingPeriodStart strictly before BillingPeriodEnd', () => {
    const same = '2026-06-01T00:00:00.000Z';
    const equal = validateFocusRow({
      ...good(),
      BillingPeriodStart: same,
      BillingPeriodEnd: same,
    });
    expect(equal.ok).toBe(false);
    expect(equal.ok === false && equal.errors.join()).toContain('strictly before');

    const reversed = validateFocusRow({
      ...good(),
      BillingPeriodStart: '2026-07-01T00:00:00.000Z',
      BillingPeriodEnd: '2026-06-01T00:00:00.000Z',
    });
    expect(reversed.ok).toBe(false);
  });

  it('rejects a row that lost its value denominator (R4)', () => {
    const result = validateFocusRow({
      ...good(),
      x_RatioValueRatio: undefined,
    } as unknown as FocusRow);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join()).toContain('x_RatioValueRatio');
  });

  it('rejects a governance-gate count outside 0-4', () => {
    for (const gates of [-1, 5]) {
      expect(validateFocusRow({ ...good(), x_RatioGovernanceGates: gates }).ok).toBe(false);
    }
  });

  it('reports the offending row index in a batch', () => {
    const rows = finioRowsForVersion('1.4');
    const broken = [...rows];
    broken[1] = { ...broken[1], BillingCurrency: '' };
    const result = validateFocusRows(broken);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors[0]).toMatch(/^row\[1\]:/);
  });
});

// ---------------------------------------------------------------------------
// Row construction — mandatory columns, value round-trip
// ---------------------------------------------------------------------------

describe('finioRowsForVersion', () => {
  it('emits one row per seed workload', () => {
    expect(finioRowsForVersion('1.4')).toHaveLength(WORKLOADS.length);
  });

  it('carries the FOCUS v1.0 mandatory columns the old mapper dropped', () => {
    const row = finioRowsForVersion('1.0')[0];
    // These eight were absent from the original 11-column FinIO row, which left
    // a peer unable to resolve a charge back to a resource or an account.
    expect(row.BillingAccountId).toBeTruthy();
    expect(row.SubAccountId).toBeTruthy();
    expect(row.ChargeCategory).toBe('Usage');
    expect(row.ResourceId).toBeTruthy();
    expect(row.PricingQuantity).toBeTypeOf('number');
    expect(row.PricingUnit).toBeTruthy();
    expect(row.UsageQuantity).toBeTypeOf('number');
    expect(row.UsageUnit).toBeTruthy();
  });

  it('shapes rows to the requested version — additive columns appear only at or above their version', () => {
    const v10 = finioRowsForVersion('1.0')[0];
    expect(v10.ListCost).toBeUndefined(); // v1.1 column
    expect(v10.ServiceSubcategory).toBeUndefined(); // v1.2 column
    expect(v10.CapacityReservationId).toBeUndefined(); // v1.4 column

    const v12 = finioRowsForVersion('1.2')[0];
    expect(v12.ListCost).toBeTypeOf('number');
    expect(v12.ServiceSubcategory).toBeTruthy();
    expect(v12.CapacityReservationId).toBeUndefined();

    const v14 = finioRowsForVersion('1.4')[0];
    expect(v14.CapacityReservationId).toBeNull(); // present, explicitly null
    expect('CapacityReservationId' in v14).toBe(true);
  });

  it('round-trips every x_Ratio* value column unchanged from the source Workload', () => {
    for (const row of finioRowsForVersion('1.4')) {
      const workload = WORKLOADS.find((w) => w.id === row.x_RatioWorkloadId);
      expect(workload, `row ${row.x_RatioWorkloadId} resolves to a workload`).toBeDefined();
      if (!workload) continue;
      expect(row.x_RatioValueRatio).toBe(workload.value.value_ratio);
      expect(row.x_RatioTotalValue).toBe(workload.value.total_value);
      expect(row.x_RatioDemandShape).toBe(workload.demand_shape);
      expect(row.x_RatioGovernanceGates).toBe(governanceGatesPassed(workload));
      expect(row.BilledCost).toBe(workload.costs.monthly_spend);
    }
  });

  it('stamps the FinIO source id and the emitted version on every row', () => {
    for (const row of finioRowsForVersion('1.1')) {
      expect(row.x_RatioSourceId).toBe(FINIO_SOURCE_ID);
      expect(row.x_RatioSourceVersion).toBe('1.1');
    }
  });

  it('keeps ResourceId resolvable back to the Ratio workload id', () => {
    for (const row of finioRowsForVersion('1.4')) {
      expect(resolveWorkloadId(row.ResourceId)).toBe(row.x_RatioWorkloadId);
    }
  });

  it('defaults to the repo canonical version', () => {
    expect(buildFinioExport().focusVersion).toBe(CANONICAL_FOCUS_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Version negotiation
// ---------------------------------------------------------------------------

describe('negotiateFocusVersion', () => {
  it('accepts every version in the canonical v1.0-v1.4 range', () => {
    for (const version of FOCUS_VERSIONS) {
      expect(negotiateFocusVersion(version)).toEqual({ ok: true, version });
    }
  });

  it('refuses an out-of-range version with a 409 naming both sides', () => {
    const result = negotiateFocusVersion('2.0');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.status).toBe(409);
    expect(result.failure.message).toContain("requested '2.0'");
    expect(result.failure.message).toContain(SUPPORTED_FOCUS_VERSIONS.join(', '));
  });

  it('refuses a non-string version rather than coercing it', () => {
    for (const bad of [undefined, null, 1.1, {}]) {
      expect(negotiateFocusVersion(bad).ok).toBe(false);
    }
  });

  it('emits rows at the negotiated version, not always the default', () => {
    expect(buildFinioExport('1.0').focusVersion).toBe('1.0');
    expect(buildFinioExport('1.0').rows[0].ListCost).toBeUndefined();
    expect(buildFinioExport('1.4').rows[0].ListCost).toBeTypeOf('number');
  });
});

describe('parseHandshakeRequest', () => {
  const valid = {
    agentId: 'peer-agent',
    capabilities: ['finio.export'],
    focusVersion: '1.4',
    nonce: 'abc',
  };

  it('accepts a well-formed body', () => {
    const result = parseHandshakeRequest(valid);
    expect(result.ok).toBe(true);
  });

  it('rejects each missing required field with a 400', () => {
    for (const field of ['agentId', 'nonce', 'focusVersion', 'capabilities'] as const) {
      const body: Record<string, unknown> = { ...valid };
      delete body[field];
      const result = parseHandshakeRequest(body);
      expect(result.ok, `missing ${field}`).toBe(false);
      expect(result.ok === false && result.failure.status).toBe(400);
    }
  });

  it('rejects a non-object body', () => {
    for (const bad of [null, 'string', 42, undefined]) {
      expect(parseHandshakeRequest(bad).ok).toBe(false);
    }
  });

  it('rejects capabilities that are not an array of strings', () => {
    expect(parseHandshakeRequest({ ...valid, capabilities: 'finio.export' }).ok).toBe(false);
    expect(parseHandshakeRequest({ ...valid, capabilities: [1, 2] }).ok).toBe(false);
  });
});

describe('acceptedOperations', () => {
  it('advertises only operations the peer asked for and the responder honours', () => {
    expect(acceptedOperations(['finio.export'])).toEqual(['finio.export']);
    expect(acceptedOperations(['finio.export', 'finio.push'])).toEqual(['finio.export']);
    expect(acceptedOperations(['finio.push'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Session integrity
// ---------------------------------------------------------------------------

describe('sessionStore', () => {
  const env = { FINIO_SESSION_SECRET: 'test-secret-aaa' };

  it('mints a session that validates and recovers the negotiated version', () => {
    const session = createSession('1.2', env);
    const check = validateSession(session.sessionId, env);
    expect(check).toEqual({ ok: true, focusVersion: '1.2' });
  });

  // Regression: the token was originally dot-delimited, but FOCUS versions are
  // themselves dotted ("1.4"), so a token split into four fields and EVERY
  // session read as malformed. Any version with a dot in it must round-trip.
  it('round-trips a dotted FOCUS version through the token', () => {
    for (const version of FOCUS_VERSIONS) {
      const session = createSession(version, env);
      expect(session.sessionId.split('-')).toHaveLength(3);
      expect(validateSession(session.sessionId, env)).toEqual({ ok: true, focusVersion: version });
    }
  });

  it('binds the version into the signature — a tampered version fails', () => {
    const session = createSession('1.0', env);
    const [expires, , signature] = session.sessionId.split('-');
    expect(validateSession(`${expires}-1.4-${signature}`, env).ok).toBe(false);
  });

  it('rejects a tampered expiry', () => {
    const session = createSession('1.4', env);
    const [, version, signature] = session.sessionId.split('-');
    const farFuture = Date.now() + 10 * 365 * 24 * 3600_000;
    expect(validateSession(`${farFuture}-${version}-${signature}`, env).ok).toBe(false);
  });

  it('rejects a session signed with a different secret', () => {
    const session = createSession('1.4', { FINIO_SESSION_SECRET: 'other-secret' });
    const check = validateSession(session.sessionId, env);
    expect(check).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects malformed shapes without throwing', () => {
    for (const bad of ['', 'nope', 'a-b', 'a-b-c-d', 'abc-1.4-deadbeef', '123-9.9-deadbeef']) {
      expect(() => validateSession(bad, env)).not.toThrow();
      expect(validateSession(bad, env).ok, bad).toBe(false);
    }
  });

  it('rejects an expired session', () => {
    const session = createSession('1.4', env);
    const expiresAtMs = new Date(session.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThan(Date.now());

    const realTimeNow = Date.now;
    try {
      Date.now = () => expiresAtMs + 1;
      expect(validateSession(session.sessionId, env)).toEqual({ ok: false, reason: 'expired' });
    } finally {
      Date.now = realTimeNow;
    }
  });
});

// ---------------------------------------------------------------------------
// Client seam + mock/live parity
// ---------------------------------------------------------------------------

describe('createFinioClient', () => {
  it('returns the mock client by default and the live client on request', () => {
    expect(createFinioClient().mode).toBe('mock');
    expect(createFinioClient('mock').mode).toBe('mock');
    expect(createFinioClient('live').mode).toBe('live');
  });
});

describe('MockFinioClient', () => {
  const request = {
    agentId: 'ratio-agent-v1',
    capabilities: ['finio.export'],
    focusVersion: '1.4' as const,
    nonce: 'n1',
  };

  it('completes the two-phase exchange and returns conformant rows', async () => {
    const client = createFinioClient('mock');
    const handshake = await client.handshake(request);
    expect(handshake.accepts).toEqual(['finio.export']);
    expect(handshake.focusVersion).toBe('1.4');
    expect(new Date(handshake.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const data = await client.export(handshake.sessionId);
    expect(data.focusVersion).toBe('1.4');
    expect(validateFocusRows(data.rows)).toEqual({ ok: true });
  });

  it('honours the negotiated version in the export, like the live route', async () => {
    const client = createFinioClient('mock');
    const handshake = await client.handshake({ ...request, focusVersion: '1.0' });
    const data = await client.export(handshake.sessionId);
    expect(data.focusVersion).toBe('1.0');
    expect(data.rows[0].ListCost).toBeUndefined();
  });

  it('refuses an unsupported version with the same 409 text the route produces', async () => {
    const client = createFinioClient('mock');
    await expect(
      client.handshake({ ...request, focusVersion: '2.0' as never }),
    ).rejects.toThrow(/FinIO handshake error 409: focusVersion mismatch/);
  });

  it('refuses a malformed handshake with a 400', async () => {
    const client = createFinioClient('mock');
    await expect(
      client.handshake({ ...request, agentId: '' }),
    ).rejects.toThrow(/FinIO handshake error 400/);
  });

  it('refuses an export against a session it never issued', async () => {
    const client = createFinioClient('mock');
    await expect(client.export('never-issued')).rejects.toThrow(
      /FinIO export error 401: Invalid or expired sessionId/,
    );
  });

  it('refuses an export against an expired session', async () => {
    const client = createFinioClient('mock');
    const handshake = await client.handshake(request);
    const realTimeNow = Date.now;
    try {
      Date.now = () => new Date(handshake.expiresAt).getTime() + 1;
      await expect(client.export(handshake.sessionId)).rejects.toThrow(
        /FinIO export error 401/,
      );
    } finally {
      Date.now = realTimeNow;
    }
  });

  it('does not leak sessions between client instances', async () => {
    const a = createFinioClient('mock');
    const b = createFinioClient('mock');
    const handshake = await a.handshake(request);
    await expect(b.export(handshake.sessionId)).rejects.toThrow(/401/);
  });
});

// ---------------------------------------------------------------------------
// Peer-token config
// ---------------------------------------------------------------------------

describe('peer auth config', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.FINIO_PEER_TOKEN;
    delete process.env.FINIO_PEER_TOKEN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FINIO_PEER_TOKEN;
    else process.env.FINIO_PEER_TOKEN = saved;
  });

  it('does not enforce a peer token when none is configured (offline-safe default)', async () => {
    const { resolveFinioPeerAuth, checkPeerToken } = await import('./config');
    const config = resolveFinioPeerAuth();
    expect(config.enforce).toBe(false);
    expect(checkPeerToken(null, config)).toEqual({ ok: true });
  });

  it('enforces the token once one is configured', async () => {
    const { resolveFinioPeerAuth, checkPeerToken } = await import('./config');
    const config = resolveFinioPeerAuth({ FINIO_PEER_TOKEN: 'peer-secret' });
    expect(config.enforce).toBe(true);
    expect(checkPeerToken('peer-secret', config)).toEqual({ ok: true });
    expect(checkPeerToken('wrong', config).ok).toBe(false);
    expect(checkPeerToken(null, config).ok).toBe(false);
  });

  it('compares tokens of differing length without throwing', async () => {
    const { checkPeerToken } = await import('./config');
    const config = { enforce: true, token: 'a-long-peer-secret' };
    expect(() => checkPeerToken('x', config)).not.toThrow();
    expect(checkPeerToken('x', config).ok).toBe(false);
  });
});
