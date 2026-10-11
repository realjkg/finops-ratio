// The anomaly row must show the sign of observedSpendDelta without a stray '+'.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FindingsCard } from './CostSourcePage';
import type { CostFinding } from './index';

function anomaly(id: string, observedSpendDelta: number): CostFinding {
  return {
    id,
    sourceId: 'fixture',
    type: 'anomaly',
    category: 'spend_spike',
    title: `Anomaly ${id}`,
    resourceId: 'r-1',
    workloadId: null,
    estimatedMonthlySavings: 0,
    observedSpendDelta,
    severity: 'medium',
    status: 'open',
    detectedAt: '2026-01-01T00:00:00Z',
  } as CostFinding;
}

describe('FindingsCard anomaly delta', () => {
  it('renders +$ for a positive delta and -$ for a negative delta', () => {
    const html = renderToStaticMarkup(
      <FindingsCard findings={[anomaly('up', 5), anomaly('down', -5)]} />,
    );
    expect(html).toContain('+$5.00/mo');
    expect(html).toContain('-$5.00/mo');
    expect(html).not.toMatch(/\+-|\+\$-/);
  });
});
