// Engagement report model (1.0): the ONE model that the XLSX (now) and the
// PDF and UI (next) render, so they agree on amounts, exclusions, missing
// values, periods and assumptions. Built only from ReportFacts. Pure: no
// renderer, no pg, no clock (the generated-at instant is the facts' asOf).
//
// Every section is a table of TEXT cells whose last column is "Note". An N/A
// cell is the text 'N/A' and its reason is in the row's Note; a partial
// amount keeps its value and its Note says why. Amounts are the exact decimal
// strings from ReportFacts: never rounded, never summed across currencies or
// sources, never 0 for missing.
import { reportTimestamp } from '@/executive/reportFilename';
import { NA_REASONS, type Amounts, type CurrencyFacts, type EffectiveFact, type Fact, type ReportFacts } from './reportFacts';

export interface ReportSection {
  id: string;
  title: string;
  columns: string[];
  rows: string[][];
}
export interface EngagementReportModel {
  schema: 'ratio.engagement-report/1';
  title: string;
  generatedAt: string;
  period: string;
  sections: ReportSection[];
}
export interface EngagementLabel {
  id: string;
  displayName: string;
}

/** A cell: its text, plus why it is N/A or partial (named by its column in the row's Note). */
type Cell = { text: string; na?: string; partial?: string };
const NA = 'N/A';
const t = (text: string): Cell => ({ text });
const na = (reason: string): Cell => ({ text: NA, na: reason });
const fact = (f: Fact<string>): Cell => (f.status === 'available' ? t(f.value) : na(f.reason));
const eff = (e: EffectiveFact): Cell =>
  e.status === 'available' ? t(e.value) : e.status === 'partial' ? { text: e.value, partial: `${e.reason} (${e.rowsWithoutEffectiveCost} rows without EffectiveCost)` } : na(e.reason);
const list = <T>(v: T[] | { status: 'not_available'; reason: string }, show: (x: T) => string, empty: string): Cell =>
  Array.isArray(v) ? (v.length ? t(v.map(show).join('; ')) : na(empty)) : na(v.reason);
const naRow = (width: number, reason: string): Cell[] => Array.from({ length: width }, () => na(reason));

/** The Note: each reason once, prefixed with the columns it explains ("A, B: N/A (reason)"). */
function noteOf(cells: Cell[], names: string[]): string {
  const groups = new Map<string, string[]>();
  cells.forEach((c, i) => {
    const key = c.na !== undefined ? `N/A (${c.na})` : c.partial;
    if (key) groups.set(key, [...(groups.get(key) ?? []), names[i]]);
  });
  return [...groups].map(([key, cols]) => `${cols.join(', ')}: ${key}`).join('; ');
}
const section = (id: string, title: string, columns: string[], rows: Cell[][]): ReportSection => ({
  id,
  title,
  columns: [...columns, 'Note'],
  // In the summary the item label names the value; elsewhere the column header does.
  rows: rows.map((r) => [...r.map((c) => c.text), noteOf(r, id === 'summary' ? ['Item', r[0].text] : columns)]),
});

/** Excel's cell limit; every renderer shows the same text. */
export const MAX_CELL_CHARS = 32_767;
export const ALTERED_CELLS_ITEM = 'Altered cell values';
// XML 1.0 forbids C0 controls except tab/LF/CR, U+FFFE/U+FFFF and unpaired surrogates.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Safe text for every renderer: forbidden characters become U+FFFD; over-long text is truncated with a visible marker. */
export function safeCellText(value: string): { text: string; altered: boolean } {
  let text = value.replace(FORBIDDEN, '\uFFFD');
  if (text.length > MAX_CELL_CHARS) {
    let keep = MAX_CELL_CHARS;
    for (let i = 0; i < 3; i += 1) keep = MAX_CELL_CHARS - `... [truncated ${text.length - keep} characters]`.length;
    if (/[\uD800-\uDBFF]/.test(text[keep - 1])) keep -= 1; // never split a surrogate pair
    text = `${text.slice(0, keep)}... [truncated ${text.length - keep} characters]`;
  }
  return { text, altered: text !== value };
}

/** Applies safeCellText to every cell and reports, in the summary, how many values were altered (never silently). */
function sanitize(sections: ReportSection[]): ReportSection[] {
  let altered = 0;
  const safe = (v: string) => {
    const r = safeCellText(v);
    if (r.altered) altered += 1;
    return r.text;
  };
  const out = sections.map((s) => ({ ...s, columns: s.columns.map(safe), rows: s.rows.map((r) => r.map(safe)) }));
  if (altered) {
    const what = `${altered} cell value${altered === 1 ? ' was' : 's were'} altered for safe display: characters XML 1.0 forbids were replaced with U+FFFD and text over ${MAX_CELL_CHARS} characters was truncated with a marker`;
    out[0].rows.push([ALTERED_CELLS_ITEM, what, '']);
  }
  return out;
}

const AMOUNT_COLUMNS = ['Rows', 'Billed cost', 'Effective cost', 'Credits rows', 'Credits billed', 'Credits effective', 'Adjustments rows', 'Adjustments billed', 'Adjustments effective'];
const part = (f: Fact<Amounts>): Cell[] => (f.status === 'available' ? [t(f.value.rowCount), t(f.value.billedCost), eff(f.value.effectiveCost)] : [na(f.reason), na(f.reason), na(f.reason)]);
const amountCells = (c: CurrencyFacts): Cell[] => [t(c.rowCount), t(c.billedCost), eff(c.effectiveCost), ...part(c.credits), ...part(c.adjustments)];

const STAGED_COLUMN = 'Staged artifact sha256 (per-period file the import wrote, not the operator file)';

export function buildEngagementReportModel(f: ReportFacts, engagement: EngagementLabel | null): EngagementReportModel {
  const p = f.period;
  const summary: Array<[string, Cell]> = [
    ['Engagement', engagement ? t(`${engagement.displayName} (${engagement.id})`) : na(NA_REASONS.noEngagement)],
    ['Reporting period', t(`${p.month} (${p.start} to ${p.endExclusive}, end exclusive)`)],
    ['Period state', t(p.state)],
    ['Period completeness', fact(p.completeness)],
    ['Generated at', t(f.freshness.asOf)],
    ['Latest published at', fact(f.freshness.latestPublishedAt)],
    ['Data through', fact(f.freshness.dataThrough)],
    ['Reporting currency', fact(f.currency.reporting)],
    ['Currencies in data', f.currency.inData.length ? t(f.currency.inData.join(', ')) : na(NA_REASONS.noPublished)],
    ['Currency rule', t(f.currency.rule)],
    ['Scope', t(f.scope)],
    ['Billed cost basis', t(f.costBasis.billed)],
    ['Effective cost basis', t(f.costBasis.effective)],
    ['Declared cost basis', list(f.costBasis.declared, (d) => `${d.sourceId}: ${d.costBasis}`, NA_REASONS.noEngagement)],
    ['Credits policy', t(f.creditsPolicy.treatment)],
    ['Declared credits coverage', list(f.creditsPolicy.declared, (d) => `${d.sourceId}: ${d.creditsCoverage}`, NA_REASONS.noEngagement)],
  ];

  const totals =
    f.totals.status === 'available' ? f.totals.value.map((c) => [t(c.currency), ...amountCells(c)]) : [naRow(1 + AMOUNT_COLUMNS.length, f.totals.reason)];
  const sourceTotals = f.sources.flatMap((s) => s.currencies.map((c) => [t(s.sourceId), t(c.currency), ...amountCells(c)]));
  const categories = f.sources.flatMap((s) =>
    s.currencies.flatMap((c) => c.byChargeCategory.map((k) => [t(s.sourceId), t(c.currency), t(k.chargeCategory), t(k.rowCount), t(k.billedCost), eff(k.effectiveCost)])),
  );
  const imports = f.sources.flatMap((s) =>
    s.batches.flatMap((b) =>
      b.stagedArtifacts.map((a) => [
        t(s.sourceId), na(s.sourceKey.reason), t(s.providers.join(', ')), t(s.focusVersions.join(', ')), t(b.batchId), t(b.status), t(b.publishedAt),
        t(a.stagedArtifactSha256), t(a.rowCount), na(b.operatorFileSha256.reason), na(b.reconciliation.reason), na(b.controlTotals.reason),
      ]),
    ),
  );
  const importColumns = ['Source id', 'Source key', 'Providers', 'FOCUS versions', 'Batch id', 'Batch status', 'Published at', STAGED_COLUMN, 'Staged artifact rows', 'Operator file sha256', 'Reconciliation', 'Control totals'];
  const declaredColumns = ['Source id (config)', 'Provider', 'Cost basis', 'Credits coverage', 'Completeness', 'Control total source'];
  const declared =
    f.declaredSources.status === 'available'
      ? f.declaredSources.value.map((d) => [d.id, d.provider, d.costBasis, d.creditsCoverage, d.completeness, d.controlTotalSource].map(t))
      : [naRow(declaredColumns.length, f.declaredSources.reason)];
  const noData = (width: number) => [naRow(width, NA_REASONS.noPublished)];

  return {
    schema: 'ratio.engagement-report/1',
    title: `Engagement cost report: ${p.month}`,
    generatedAt: f.freshness.asOf,
    period: p.month,
    sections: sanitize([
      section('summary', 'Report', ['Item', 'Value'], summary.map(([label, c]) => [t(label), c])),
      section('totals', 'Totals by currency', ['Currency', ...AMOUNT_COLUMNS], totals),
      section('sourceTotals', 'Totals by source', ['Source id', 'Currency', ...AMOUNT_COLUMNS], sourceTotals.length ? sourceTotals : noData(2 + AMOUNT_COLUMNS.length)),
      section('chargeCategories', 'Charge categories', ['Source id', 'Currency', 'Charge category', 'Rows', 'Billed cost', 'Effective cost'], categories.length ? categories : noData(6)),
      section('imports', 'Sources and imports', importColumns, imports.length ? imports : noData(importColumns.length)),
      section('declaredSources', 'Declared sources', declaredColumns, declared),
      section('coverageGaps', 'Coverage gaps', ['Code', 'Detail'], f.coverageGaps.map((g) => [t(g.code), t(g.detail)])),
    ]),
  };
}

/** e.g. ratio-engagement-report-2024-09-2026-10-31T12-00-00Z.xlsx (one instant per report). */
export function engagementReportFilename(month: string, format: 'xlsx' | 'pdf', now: Date): string {
  return `ratio-engagement-report-${month}-${reportTimestamp(now)}.${format}`;
}
