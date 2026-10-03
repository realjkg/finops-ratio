// Follow-up integrity / disclosure regressions:
// - unparseable FOCUS date columns are rejected loudly, never passed through;
// - inWindow never keeps a row whose ChargePeriodStart it cannot place;
// - CloudConnectorAdapter redacts transport error text (second line of defence).

import { describe, expect, it } from 'vitest';
import { inWindow, rowsFromExportText } from './transports/focusExport';
import type { RawSourceRow } from './focusRows';
import { CloudConnectorAdapter } from './CloudConnectorAdapter';
import { KUBERNETES_CONNECTOR_SPEC } from './kubernetesConfig';

const WINDOW = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };

describe('unparseable FOCUS dates are invalid rows', () => {
  it('rejects an unparseable ChargePeriodStart with artifact + row number', () => {
    const csv = 'BilledCost,BillingCurrency,ChargePeriodStart\n4,USD,2026-06-02T00:00:00Z\n5,USD,not-a-date\n';
    expect(() => rowsFromExportText(csv, WINDOW, 'feed.csv')).toThrow(
      /^feed\.csv: invalid FOCUS row 2: .*ChargePeriodStart/,
    );
  });

  it('rejects a present but unparseable optional date column too', () => {
    const csv = 'BilledCost,BillingCurrency,ChargePeriodStart,BillingPeriodStart\n4,USD,2026-06-02T00:00:00Z,someday\n';
    expect(() => rowsFromExportText(csv, WINDOW, 'feed.csv')).toThrow(/feed\.csv: invalid FOCUS row 1: .*BillingPeriodStart/);
  });

  it('inWindow never keeps a row with an unparseable ChargePeriodStart', () => {
    const row = { ChargePeriodStart: 'garbage' } as unknown as RawSourceRow;
    let kept: boolean | undefined;
    try {
      kept = inWindow(row, WINDOW);
    } catch {
      kept = undefined; // throwing is the loud outcome we want
    }
    expect(kept).not.toBe(true);
    expect(() => inWindow(row, WINDOW)).toThrow(/ChargePeriodStart/);
  });
});

describe('CloudConnectorAdapter redacts transport error text', () => {
  const SECRET_MSG =
    'upstream said: Authorization Bearer abc.def.ghi.0123456789 rejected for https://acct.blob.core.windows.net/c/x.csv?sv=2024&sig=SASSECRET';
  const env = { KUBERNETES_FOCUS_ENDPOINT: 'https://opencost.example/focus' };
  const failing = () => ({
    ping: async () => {
      throw new Error(SECRET_MSG);
    },
    fetchExportRows: async () => {
      throw new Error(SECRET_MSG);
    },
  });

  it('health detail is redacted', async () => {
    const health = await new CloudConnectorAdapter(KUBERNETES_CONNECTOR_SPEC, { env, transportFactory: failing }).healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.detail).toContain('health check failed');
    expect(health.detail).not.toContain('abc.def.ghi');
    expect(health.detail).not.toContain('SASSECRET');
  });

  it('fetchCostRows rethrows a redacted message', async () => {
    const err = await new CloudConnectorAdapter(KUBERNETES_CONNECTOR_SPEC, { env, transportFactory: failing })
      .fetchCostRows(WINDOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('upstream said');
    expect((err as Error).message).not.toContain('abc.def.ghi');
    expect((err as Error).message).not.toContain('SASSECRET');
  });
});
