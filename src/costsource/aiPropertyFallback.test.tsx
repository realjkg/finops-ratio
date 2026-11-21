// FOCUS 1.5 puts model and token labels inside SkuPriceDetails. When a source
// supplies them as top-level columns instead, normalization records which ones
// (aiPropertiesFromTopLevelColumns). These tests pin that the record travels
// through every ingest path to the people reading the result.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { FocusFileAdapter } from './FocusFileAdapter';
import { ServiceNowAdapter } from './ServiceNowAdapter';
import { CloudConnectorAdapter } from './CloudConnectorAdapter';
import { KUBERNETES_CONNECTOR_SPEC } from './kubernetesConfig';
import { rawRowsForVersion } from './seed';
import type { RawSourceRow } from './focusRows';
import { AI_PROPERTY_FALLBACK_LABEL, AI_PROPERTY_FALLBACK_NOTE, AiPropertyFallback, UpgradeAuditCard } from './CostSourcePage';
import { IngestVerification } from '@/connectors/IngestVerification';
import { currentMonthWindow, landingSummary, type IngestRun } from '@/connectors/ingestLanding';

const WINDOW = currentMonthWindow();
const withTopLevel = (): RawSourceRow[] =>
  rawRowsForVersion('1.4').map((r, i) => (i === 0 ? ({ ...r, ModelId: 'm-1', TokenDirection: 'Input' } as RawSourceRow) : r));
const withDetails = (): RawSourceRow[] =>
  rawRowsForVersion('1.4').map((r, i) =>
    i === 0 ? ({ ...r, SkuPriceDetails: JSON.stringify({ ModelId: 'm-1', TokenDirection: 'Input' }) } as RawSourceRow) : r,
  );
const run = (result: IngestRun['result']): IngestRun => ({ sourceId: result.sourceId, sourceName: 'T', at: '2026-06-01T14:30:00.000Z', result, findings: [] });

describe('the ingest result says which AI labels came from top-level columns', () => {
  it('lists the properties read from top-level columns, in property order', () => {
    const r = FocusFileAdapter.ingest(withTopLevel(), '1.4', 'focus-file-sandbox', WINDOW);
    expect(r.aiPropertiesFromTopLevelColumns).toEqual(['ModelId', 'TokenDirection']);
  });

  it('is empty when the labels come from SkuPriceDetails, where FOCUS 1.5 puts them', () => {
    const r = FocusFileAdapter.ingest(withDetails(), '1.4', 'focus-file-sandbox', WINDOW);
    expect(r.aiPropertiesFromTopLevelColumns).toEqual([]);
    expect(r.rows[0].ModelId).toBe('m-1');
  });

  it('the ServiceNow adapter passes it through', () => {
    const r = ServiceNowAdapter.ingest(withTopLevel(), '1.4', 'servicenow-sandbox', WINDOW);
    expect(r.aiPropertiesFromTopLevelColumns).toEqual(['ModelId', 'TokenDirection']);
  });

  it('a live config-driven connector passes it through from its export rows', async () => {
    const adapter = new CloudConnectorAdapter(KUBERNETES_CONNECTOR_SPEC, {
      env: { KUBERNETES_FOCUS_ENDPOINT: 'http://opencost.kube-system.svc/focus' },
      transportFactory: () => ({ ping: async () => true, fetchExportRows: async () => withTopLevel() }),
    });
    const r = await adapter.fetchCostRows(WINDOW);
    expect(r.aiPropertiesFromTopLevelColumns).toEqual(['ModelId', 'TokenDirection']);
  });
});

describe('the cost source page shows it in the version normalization card', () => {
  it('names the properties and explains what it means', () => {
    const out = html(<UpgradeAuditCard rows={FocusFileAdapter.ingest(withTopLevel(), '1.4', 'focus-file-sandbox', WINDOW)} />);
    expect(out).toContain('data-testid="ai-property-fallback"');
    expect(out).toContain(AI_PROPERTY_FALLBACK_LABEL);
    expect(out).toContain('>ModelId<');
    expect(out).toContain('>TokenDirection<');
    expect(out).toContain(AI_PROPERTY_FALLBACK_NOTE.replace(/'/g, '&#x27;'));
    expect(AI_PROPERTY_FALLBACK_NOTE).toContain('FOCUS 1.5 sample data');
  });

  it('shows nothing when no label came from a top-level column', () => {
    const out = html(<UpgradeAuditCard rows={FocusFileAdapter.ingest(withDetails(), '1.4', 'focus-file-sandbox', WINDOW)} />);
    expect(out).not.toContain('ai-property-fallback');
  });

  it('reads an absent field (older server or stored result) as none', () => {
    expect(html(<AiPropertyFallback properties={undefined} />)).toBe('');
    expect(html(<AiPropertyFallback properties={[]} />)).toBe('');
  });
});

describe('the connector ingest verification shows the count', () => {
  it('names the labels inline, readable without hover', () => {
    const out = html(<IngestVerification run={run(FocusFileAdapter.ingest(withTopLevel(), '1.4', 'focus-file-sandbox', WINDOW))} sandbox={false} />);
    expect(out).toContain('data-testid="ai-property-fallback-count"');
    expect(out).toContain('Model/token labels from top-level columns, not SkuPriceDetails: ModelId, TokenDirection');
    expect(out).not.toContain('title="ModelId');
  });

  it('says nothing when there are none, and a stored run without the field reads as none', () => {
    const clean = run(FocusFileAdapter.ingest(withDetails(), '1.4', 'focus-file-sandbox', WINDOW));
    expect(html(<IngestVerification run={clean} sandbox={false} />)).not.toContain('ai-property-fallback-count');
    const { aiPropertiesFromTopLevelColumns: _omit, ...older } = clean.result;
    void _omit;
    const stored = run(older as IngestRun['result']);
    expect(landingSummary(stored).aiPropertiesFromTopLevelColumns).toEqual([]);
    expect(html(<IngestVerification run={stored} sandbox={false} />)).not.toContain('ai-property-fallback-count');
  });
});
