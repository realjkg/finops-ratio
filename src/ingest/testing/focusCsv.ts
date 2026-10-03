// Test-only builders for synthetic FOCUS 1.0 CSV artifacts. Nothing here is
// real provider data. Excluded from the worker build (src/ingest/**/testing/**).
import zlib from 'zlib';

export const FOCUS_HEADER = [
  'BilledCost',
  'BillingAccountId',
  'BillingCurrency',
  'BillingPeriodEnd',
  'BillingPeriodStart',
  'ChargeCategory',
  'ChargePeriodEnd',
  'ChargePeriodStart',
  'ConsumedQuantity',
  'ConsumedUnit',
  'ContractedCost',
  'EffectiveCost',
  'ListCost',
  'PricingQuantity',
  'PricingUnit',
  'ProviderName',
  'ResourceId',
  'ServiceCategory',
  'ServiceName',
  'SubAccountId',
  'Tags',
] as const;

export type FocusRow = Record<string, string>;

/** First day of the month after `period` ('YYYY-MM-01'), as an ISO instant. */
export function nextMonthIso(period: string): string {
  const [y, m] = period.split('-').map((x) => parseInt(x, 10));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-01T00:00:00Z`;
}

/** A valid synthetic row for `period` ('YYYY-MM-01'); override any column. */
export function focusRow(period: string, overrides: FocusRow = {}): FocusRow {
  const day = period.slice(0, 8) + '02';
  return {
    BilledCost: '1.25',
    BillingAccountId: '000000000001',
    BillingCurrency: 'USD',
    BillingPeriodEnd: nextMonthIso(period),
    BillingPeriodStart: `${period}T00:00:00Z`,
    ChargeCategory: 'Usage',
    ChargePeriodEnd: `${day}T01:00:00Z`,
    ChargePeriodStart: `${day}T00:00:00Z`,
    ConsumedQuantity: '1',
    ConsumedUnit: 'Hours',
    ContractedCost: '1.25',
    EffectiveCost: '1.25',
    ListCost: '1.50',
    PricingQuantity: '1',
    PricingUnit: 'Hours',
    ProviderName: 'SyntheticCloud',
    ResourceId: 'res-synthetic-1',
    ServiceCategory: 'Compute',
    ServiceName: 'Synthetic Compute',
    SubAccountId: '000000000002',
    Tags: '{"env":"test"}',
    ...overrides,
  };
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Serializes rows with the given header (default FOCUS_HEADER). Missing cells are empty. */
export function toCsv(rows: FocusRow[], header: readonly string[] = FOCUS_HEADER): string {
  const lines = [header.map(csvField).join(',')];
  for (const r of rows) lines.push(header.map((h) => csvField(r[h] ?? '')).join(','));
  return lines.join('\n') + '\n';
}

export function gz(text: string | Buffer): Buffer {
  return zlib.gzipSync(typeof text === 'string' ? Buffer.from(text, 'utf8') : text);
}

/** gzip CSV artifact bytes for rows. */
export function csvGz(rows: FocusRow[], header: readonly string[] = FOCUS_HEADER): Buffer {
  return gz(toCsv(rows, header));
}

/** `n` distinct valid rows with BilledCost `cost` each (string, never a JS number). */
export function rowsOf(period: string, n: number, cost = '1.25', tag = 'r'): FocusRow[] {
  return Array.from({ length: n }, (_, i) => focusRow(period, { BilledCost: cost, ResourceId: `${tag}-${i}` }));
}

/** First day of the current UTC month and the previous one, as 'YYYY-MM-01'. */
export function currentAndPreviousPeriod(now: Date = new Date()): { current: string; previous: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const fmt = (yy: number, mm: number) => `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-01`;
  return { current: fmt(y, m), previous: m === 1 ? fmt(y - 1, 12) : fmt(y, m - 1) };
}
