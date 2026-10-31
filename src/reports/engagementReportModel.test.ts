// Engagement report model (1.0): the ONE model the XLSX (now) and the PDF and
// UI (next) render. Built only from ReportFacts. SYNTHETIC aggregates shaped
// like the public FOCUS 1.0 sample's AWS 2024-09 published facts.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { assembleReportFacts, NA_REASONS, SCOPE_LABEL, type ReportFactsInput } from './reportFacts';
import { ENGAGEMENT, g, SRC, SRC_B, STAGED, sampleInput } from './fixtures/sampleFacts';
import { buildEngagementReportModel, engagementReportFilename, type EngagementReportModel, type ReportSection } from './engagementReportModel';

const model = (o: Partial<ReportFactsInput> = {}, e: typeof ENGAGEMENT | null = ENGAGEMENT) => buildEngagementReportModel(assembleReportFacts(sampleInput(o)), e);
const section = (m: EngagementReportModel, id: string): ReportSection => {
  const s = m.sections.find((x) => x.id === id);
  if (!s) throw new Error(`no section ${id}`);
  return s;
};
const col = (s: ReportSection, name: string) => s.columns.indexOf(name);
const item = (m: EngagementReportModel, label: string) => section(m, 'summary').rows.find((r) => r[0] === label);

describe('engagement report model: the sample, AWS 2024-09', () => {
  const m = model();

  it('matches the committed golden model exactly', () => {
    const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'engagementReport.sample-2024-09.golden.json'), 'utf8'));
    expect(JSON.parse(JSON.stringify(m))).toEqual(golden);
  });

  it('identifies engagement, period, generated-at, scope, currency, cost basis, credits policy and freshness', () => {
    expect(m.title).toBe('Engagement cost report: 2024-09');
    expect(item(m, 'Engagement')).toEqual(['Engagement', 'Example engagement (example-engagement)', '']);
    expect(item(m, 'Reporting period')?.[1]).toBe('2024-09 (2024-09-01 to 2024-10-01, end exclusive)');
    expect(item(m, 'Generated at')?.[1]).toBe('2026-10-31T12:00:00.000Z');
    expect(item(m, 'Scope')?.[1]).toBe(SCOPE_LABEL);
    expect(item(m, 'Reporting currency')?.[1]).toBe('USD');
    expect(item(m, 'Billed cost basis')?.[1]).toMatch(/BilledCost/);
    expect(item(m, 'Effective cost basis')?.[1]).toMatch(/EffectiveCost/);
    expect(item(m, 'Credits policy')?.[1]).toMatch(/included once in both/);
    expect(item(m, 'Declared credits coverage')?.[1]).toBe('aws-focus-sample: included');
    expect(item(m, 'Latest published at')?.[1]).toBe('2026-10-31T03:00:00.000000Z');
    expect(item(m, 'Data through')?.[1]).toBe('2024-10-01T00:00:00.000000Z');
  });

  it('per-currency totals are exact decimal strings; the Credit row is shown separately', () => {
    const t = section(m, 'totals');
    expect(t.rows).toHaveLength(1);
    const r = t.rows[0];
    expect([r[col(t, 'Currency')], r[col(t, 'Rows')], r[col(t, 'Billed cost')], r[col(t, 'Effective cost')]]).toEqual(['USD', '942', '18.00663861840', '13.00000000000']);
    expect([r[col(t, 'Credits rows')], r[col(t, 'Credits billed')], r[col(t, 'Credits effective')]]).toEqual(['1', '-2.61370000000', '-3.00000000000']);
    expect(r[col(t, 'Adjustments billed')]).toBe('N/A');
    expect(r[col(t, 'Note')]).toBe(NA_REASONS.noAdjustmentRows);
    const c = section(m, 'chargeCategories').rows.map((x) => x.slice(2, 6));
    expect(c).toEqual([['Credit', '1', '-2.61370000000', '-3.00000000000'], ['Usage', '941', '20.62033861840', '16.00000000000']]);
  });

  it('labels the artifact hash as staged and shows every unavailable trust field as N/A with its reason', () => {
    const s = section(m, 'imports');
    const r = s.rows[0];
    expect(s.columns).toContain('Staged artifact sha256 (per-period file the import wrote, not the operator file)');
    expect(r[col(s, 'Staged artifact sha256 (per-period file the import wrote, not the operator file)')]).toBe(STAGED);
    for (const c of ['Source key', 'Operator file sha256', 'Reconciliation', 'Control totals']) expect(r[col(s, c)], c).toBe('N/A');
    for (const reason of [NA_REASONS.sourceKey, NA_REASONS.operatorFile, NA_REASONS.batchStatus]) expect(r[col(s, 'Note')]).toContain(reason);
    expect(section(m, 'coverageGaps').rows.map((x) => x[0])).toEqual(['BATCH_STATUS_NOT_VISIBLE', 'DECLARED_SOURCES_NOT_LINKED']);
  });

  it('every row has one Note column; an N/A cell never lacks a reason in its row', () => {
    for (const s of m.sections) {
      expect(s.columns[s.columns.length - 1], s.id).toBe('Note');
      for (const r of s.rows) {
        expect(r).toHaveLength(s.columns.length);
        if (r.slice(0, -1).includes('N/A')) expect(r[r.length - 1], `${s.id}: ${r.join('|')}`).not.toBe('');
      }
    }
  });
});

describe('engagement report model: missing and incomplete data stay explicit', () => {
  it('no published data: totals and imports are N/A rows with the reason, never 0', () => {
    const m = model({ groups: [], batches: [], artifacts: [] });
    const t = section(m, 'totals');
    expect(t.rows).toEqual([[...t.columns.slice(0, -1).map(() => 'N/A'), NA_REASONS.noPublished]]);
    expect(section(m, 'imports').rows[0].at(-1)).toContain(NA_REASONS.noPublished);
    expect(item(m, 'Currencies in data')).toEqual(['Currencies in data', 'N/A', NA_REASONS.noPublished]);
    expect(JSON.stringify(m)).not.toMatch(/"0(\.0+)?"/);
  });

  it('partial effective: the amount is labeled with the reason and the count of rows without it', () => {
    const m = model({ groups: [g({ effectiveCost: '12.00000000000', effectiveMissingRows: '2' }), g({ isTotal: false, chargeCategory: 'Usage', effectiveCost: '12.00000000000', effectiveMissingRows: '2' })] });
    const t = section(m, 'totals');
    expect(t.rows[0][col(t, 'Effective cost')]).toBe('12.00000000000');
    expect(t.rows[0][col(t, 'Note')]).toContain(`${NA_REASONS.effectivePartial} (2 rows without EffectiveCost)`);
  });

  it('two sources in two currencies: no combined totals row; each source and currency listed separately', () => {
    const m = model({
      groups: [g({}), g({ isTotal: false, chargeCategory: 'Usage' }), g({ sourceId: SRC_B, currency: 'EUR', billedCost: '7.00', effectiveCost: '7.00' }), g({ sourceId: SRC_B, currency: 'EUR', isTotal: false, chargeCategory: 'Usage', billedCost: '7.00', effectiveCost: '7.00' })],
      batches: [...sampleInput().batches, { ...sampleInput().batches[0], sourceId: SRC_B, batchId: 'bbbbbbbb-0000-4000-8000-000000000002' }],
    });
    expect(section(m, 'totals').rows[0].at(-1)).toBe(NA_REASONS.multiSource);
    const st = section(m, 'sourceTotals');
    expect(st.rows.map((r) => [r[0], r[1], r[col(st, 'Billed cost')]])).toEqual([[SRC, 'USD', '18.00663861840'], [SRC_B, 'EUR', '7.00']]);
    expect(item(m, 'Currencies in data')?.[1]).toBe('EUR, USD');
  });

  it('without an engagement config the engagement and declared policies are N/A with the reason', () => {
    const m = buildEngagementReportModel(assembleReportFacts(sampleInput({ engagement: null })), null);
    expect(item(m, 'Engagement')).toEqual(['Engagement', 'N/A', NA_REASONS.noEngagement]);
    expect(item(m, 'Declared credits coverage')).toEqual(['Declared credits coverage', 'N/A', NA_REASONS.noEngagement]);
    expect(section(m, 'declaredSources').rows).toEqual([[...section(m, 'declaredSources').columns.slice(0, -1).map(() => 'N/A'), NA_REASONS.noEngagement]]);
  });

  it('filename: deterministic, period and instant stamped', () => {
    expect(engagementReportFilename('2024-09', 'xlsx', new Date('2026-10-31T12:00:00.000Z'))).toBe('ratio-engagement-report-2024-09-2026-10-31T12-00-00Z.xlsx');
  });
});
