import { describe, expect, it } from 'vitest';
import type { ConnectorState } from '../../connectors/managed/health';
import { CONNECTION_LADDER, LADDER_FROM_MANAGED_STATE, validateConnectorDeclaration } from './connector';
import { connector } from './testing/fixtures';

// Compile-time: the map's keys are exactly the M0a ConnectorState union (typecheck fails if M0a adds a state).
type Keys = keyof typeof LADDER_FROM_MANAGED_STATE;
const exact: [ConnectorState] extends [Keys] ? ([Keys] extends [ConnectorState] ? true : false) : false = true;

describe('connector status ladder (extends M0a)', () => {
  it('maps every M0a state exactly; off-ladder states are never shown as a step', () => {
    expect(exact).toBe(true);
    expect(CONNECTION_LADDER).toEqual(['configured', 'authorized', 'retrieved', 'validated', 'reconciled']);
    expect(LADDER_FROM_MANAGED_STATE).toEqual({
      'not-configured': null, 'configured-not-verified': 'configured', 'auth-verified': 'authorized', 'source-access-verified': 'authorized',
      'extraction-completed': 'retrieved', 'mapping-validated': 'validated', 'reconciliation-passed': 'reconciled', 'live-verified': 'reconciled',
      degraded: null, failed: null, simulated: null,
    });
  });
});

describe('ConnectorDeclaration', () => {
  it('accepts the synthetic usage-file declaration; limitations are required until live verification', () => {
    expect(validateConnectorDeclaration(connector()).ok).toBe(true);
    expect(validateConnectorDeclaration({ ...connector(), verification: { status: 'pre_release_validated', limitations: [] } }))
      .toEqual({ ok: false, problems: ['$.verification.limitations: required until live verified'] });
  });
});
