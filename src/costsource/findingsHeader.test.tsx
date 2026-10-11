// A8: the findings card title names the actual source. It used to say
// "PointFive DeepWaste shape" for every source, including ServiceNow.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FindingsCard } from './CostSourcePage';
import type { CostFinding, CostSourceDescriptor } from './CostSourceClient';

const FINDING: CostFinding = {
  id: 'f-1',
  sourceId: 'x',
  type: 'opportunity',
  category: 'idle_resource',
  title: 'Idle GPU pool',
  resourceId: 'r-1',
  workloadId: null,
  estimatedMonthlySavings: 100,
  observedSpendDelta: 0,
  severity: 'info',
  status: 'open',
  detectedAt: '2026-01-01T00:00:00Z',
};

function source(id: string, name: string, kind: CostSourceDescriptor['kind']): CostSourceDescriptor {
  return {
    id,
    name,
    kind,
    focusVersion: '1.4',
    coverage: 'public_cloud',
    capabilities: ['costRows', 'findings'],
    configured: true,
    note: '',
  };
}

describe('FindingsCard header', () => {
  it('findings_header_names_servicenow_for_the_servicenow_source', () => {
    const sn = source('servicenow-sandbox', 'ServiceNow (synthetic CMDB/ITBM)', 'servicenow');
    const html = renderToStaticMarkup(<FindingsCard findings={[FINDING]} source={sn} />);
    expect(html).toContain('ServiceNow');
    expect(html).not.toContain('PointFive DeepWaste');
  });

  it('findings_header_keeps_pointfive_deepwaste_for_pointfive', () => {
    const pf = source('pointfive-sandbox', 'PointFive (sandbox)', 'pointfive');
    const html = renderToStaticMarkup(<FindingsCard findings={[FINDING]} source={pf} />);
    expect(html).toContain('PointFive DeepWaste shape');
  });
});
