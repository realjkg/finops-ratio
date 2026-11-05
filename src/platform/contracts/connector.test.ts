import { describe, expect, it } from 'vitest';
import type { ConnectorState } from '../../connectors/managed/health';
import { CONNECTION_LADDER, LADDER_FROM_MANAGED_STATE, validateConnectorDeclaration } from './connector';
import { connector } from './testing/fixtures';

// Compile-time: the map's keys are exactly the M0a ConnectorState union (typecheck fails if M0a adds a state).
type Keys = keyof typeof LADDER_FROM_MANAGED_STATE;
const exact: [ConnectorState] extends [Keys] ? ([Keys] extends [ConnectorState] ? true : false) : false = true;

const problems = (r: { ok: boolean; problems?: string[] }) => (r.ok ? [] : r.problems);

describe('connector status ladder (extends M0a)', () => {
  it('maps every M0a state; off-ladder states are never shown as a step', () => {
    expect(exact).toBe(true);
    expect(CONNECTION_LADDER).toEqual(['configured', 'authorized', 'retrieved', 'validated', 'reconciled']);
    for (const s of ['not-configured', 'degraded', 'failed', 'simulated'] as const) expect(LADDER_FROM_MANAGED_STATE[s]).toBeNull();
    expect(LADDER_FROM_MANAGED_STATE['source-access-verified']).toBe('authorized');
    expect(LADDER_FROM_MANAGED_STATE['extraction-completed']).toBe('retrieved');
  });
});

describe('ConnectorDeclaration', () => {
  it('accepts the synthetic usage-file declaration', () => {
    expect(validateConnectorDeclaration(connector()).ok).toBe(true);
  });
  it('operations emit known contract versions only', () => {
    expect(problems(validateConnectorDeclaration({ ...connector(), operations: [{ name: 'x', emits: 'ai-usage-event/2' }] }))).toHaveLength(1);
  });
  it('limitations are required until live verification, and "connected" is not a status', () => {
    expect(problems(validateConnectorDeclaration({ ...connector(), verification: { status: 'pre_release_validated', limitations: [] } }))).toEqual(['$.verification.limitations: required until live verified']);
    expect(problems(validateConnectorDeclaration({ ...connector(), verification: { status: 'connected', limitations: [] } }))).toEqual(['$.verification.status: one of not_verified|pre_release_validated|live_verified']);
  });
});
