// Report facts (1.0): the deterministic, typed facts a report is built from,
// assembled from the reader's aggregates over the tenant's PUBLISHED cost facts
// (src/server/costs/reportFactsRead.ts). Pure: no pg, no clock, no LLM.
//
// Rules: amounts are the exact decimal strings Postgres computed (this module
// never does arithmetic on money); nothing is summed across currencies or
// across sources (the source-role/overlap policy needs source keys the reader
// cannot see yet); anything missing is N/A with a reason, never 0.
export const REPORT_FACTS_SCHEMA = 'ratio.report-facts/1';
export const SCOPE_LABEL = 'Scope: supplied file(s) and periods; not a complete provider invoice; reconciled only against the control totals shown';

export const NA_REASONS = {
  noPublished:
    'No published batch for this period is visible to the reader. Staged, quarantined and superseded batches are not visible to the reader role yet, so a missing import cannot be told apart from a quarantined one',
  sourceKey: 'Not yet available: the reader role cannot see source keys or import metadata until the batch-status view (R4, migration 0005) exists',
  batchStatus:
    'Figures reflect the last PUBLISHED batch only: a newer delivery for this period may have been quarantined or left staged, and reconciliation status and control totals are not visible to the reader role until the batch-status view (R4, migration 0005) exists',
  operatorFile:
    "Not yet available (needs R4 import metadata): the operator file's sha256 is recorded in the staged import metadata the reader role cannot see; stagedArtifactSha256 is the per-period artifact the import wrote, so it differs from sha256sum of the operator file",
  multiSource: 'Not combined: more than one source published facts for this period, and the source-role/overlap policy cannot be applied without source keys (R4)',
  noEngagement: 'No engagement configuration (RATIO_MODE is not engagement)',
  effectivePartial: 'Partial: some rows carry no EffectiveCost; the amount covers only rows that do, and is never filled with BilledCost',
  effectiveMissing: 'No row in this group carries EffectiveCost',
  noCreditRows: 'No rows with ChargeCategory Credit in the published facts for this period',
  noAdjustmentRows: 'No rows with ChargeCategory Adjustment in the published facts for this period',
} as const;
/** Only the earliest start and latest end are compared: day-level gaps inside the span are not checked. */
export const SPAN_COVERS = 'charge-period span covers the month (day-level gaps not checked)';
export const SPAN_PARTIAL = 'partial: charge-period span does not cover the month';

export type NotAvailable = { status: 'not_available'; reason: string };
export type Fact<T> = { status: 'available'; value: T } | NotAvailable;
export type EffectiveFact = Fact<string> | { status: 'partial'; value: string; rowsWithoutEffectiveCost: string; reason: string };

/** Reader output: one row per (source, currency) total (isTotal), and per (source, currency, charge category). */
export interface FactsAggregateGroup { sourceId: string; currency: string; chargeCategory: string | null; isTotal: boolean; rowCount: string; billedCost: string; effectiveCost: string | null; effectiveMissingRows: string }
export interface FactsBatchRow { sourceId: string; batchId: string; rowCount: string; publishedAt: string; chargePeriodStart: string; chargePeriodEnd: string; providers: string[]; focusVersions: string[] }
export interface FactsArtifactRow { sourceId: string; batchId: string; artifactSha256: string; rowCount: string }
/** Declared (config) metadata of one engagement source; not linked to a published source yet. */
export interface DeclaredSource { id: string; provider: string; costBasis: string; creditsCoverage: string; completeness: string; controlTotalSource: string }
/** period: 'YYYY-MM-01'; asOf: an injected ISO instant (no clock here). */
export interface ReportFactsInput { period: string; asOf: string; groups: FactsAggregateGroup[]; batches: FactsBatchRow[]; artifacts: FactsArtifactRow[]; engagement: { currency: string; declaredSources: DeclaredSource[] } | null }

export interface Amounts { rowCount: string; billedCost: string; effectiveCost: EffectiveFact }
export interface CurrencyFacts extends Amounts { currency: string; credits: Fact<Amounts>; adjustments: Fact<Amounts>; byChargeCategory: Array<Amounts & { chargeCategory: string }> }
export interface BatchFacts {
  batchId: string; status: 'published'; publishedAt: string; rowCount: string; stagedArtifacts: Array<{ stagedArtifactSha256: string; rowCount: string }>;
  operatorFileSha256: NotAvailable; reconciliation: NotAvailable; controlTotals: NotAvailable; importMetadataSha256: NotAvailable;
}
export interface SourceFacts { sourceId: string; sourceKey: NotAvailable; providers: string[]; focusVersions: string[]; batches: BatchFacts[]; currencies: CurrencyFacts[] }
export interface ReportFacts {
  schema: typeof REPORT_FACTS_SCHEMA;
  scope: typeof SCOPE_LABEL;
  period: { month: string; start: string; endExclusive: string; state: 'open' | 'closed'; completeness: Fact<string> };
  freshness: { asOf: string; latestPublishedAt: Fact<string>; dataThrough: Fact<string> };
  currency: { reporting: Fact<string>; inData: string[]; rule: string };
  costBasis: { shown: ['billed', 'effective']; billed: string; effective: string; declared: Array<{ sourceId: string; costBasis: string }> | NotAvailable };
  creditsPolicy: { treatment: string; declared: Array<{ sourceId: string; creditsCoverage: string }> | NotAvailable };
  declaredSources: Fact<DeclaredSource[]>;
  sources: SourceFacts[];
  totals: Fact<CurrencyFacts[]>;
  coverageGaps: Array<{ code: string; detail: string }>;
}

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])-01$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const na = (reason: string): NotAvailable => ({ status: 'not_available', reason });
const ok = <T>(value: T): Fact<T> => ({ status: 'available', value });
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function decimal(v: string, what: string): string {
  if (!DECIMAL_RE.test(v)) throw new Error(`report facts: ${what} is not a decimal string`);
  return v;
}

function amounts(g: FactsAggregateGroup): Amounts {
  const missing = decimal(g.effectiveMissingRows, 'effectiveMissingRows');
  let effectiveCost: EffectiveFact;
  if (g.effectiveCost === null) effectiveCost = na(NA_REASONS.effectiveMissing);
  else if (BigInt(missing) > BigInt(0)) effectiveCost = { status: 'partial', value: decimal(g.effectiveCost, 'effectiveCost'), rowsWithoutEffectiveCost: missing, reason: NA_REASONS.effectivePartial };
  else effectiveCost = ok(decimal(g.effectiveCost, 'effectiveCost'));
  return { rowCount: decimal(g.rowCount, 'rowCount'), billedCost: decimal(g.billedCost, 'billedCost'), effectiveCost };
}

function currencyFacts(groups: FactsAggregateGroup[], currency: string): CurrencyFacts {
  const total = groups.find((g) => g.isTotal && g.currency === currency);
  if (!total) throw new Error('report facts: a currency group has no total row');
  const cats = groups.filter((g) => !g.isTotal && g.currency === currency).map((g) => ({ chargeCategory: g.chargeCategory ?? '(not stated)', ...amounts(g) }));
  cats.sort((a, b) => cmp(a.chargeCategory, b.chargeCategory));
  const pick = (name: string, reason: string): Fact<Amounts> => {
    const c = cats.find((x) => x.chargeCategory === name);
    return c ? ok({ rowCount: c.rowCount, billedCost: c.billedCost, effectiveCost: c.effectiveCost }) : na(reason);
  };
  return { currency, ...amounts(total), credits: pick('Credit', NA_REASONS.noCreditRows), adjustments: pick('Adjustment', NA_REASONS.noAdjustmentRows), byChargeCategory: cats };
}

function nextMonth(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return `${String(m === 12 ? y + 1 : y).padStart(4, '0')}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
}

export function assembleReportFacts(input: ReportFactsInput): ReportFacts {
  if (!PERIOD_RE.test(input.period)) throw new Error('report facts: period must be YYYY-MM-01');
  if (!ISO_RE.test(input.asOf) || Number.isNaN(Date.parse(input.asOf))) throw new Error('report facts: asOf must be an ISO instant');
  const start = input.period;
  const end = nextMonth(start);
  const gaps: Array<{ code: string; detail: string }> = [];
  const gap = (code: string, detail: string) => gaps.push({ code, detail });

  const sourceIds = [...new Set([...input.groups.map((g) => g.sourceId), ...input.batches.map((b) => b.sourceId)])].sort(cmp);
  const sources: SourceFacts[] = sourceIds.map((sourceId) => {
    const groups = input.groups.filter((g) => g.sourceId === sourceId);
    const batches = input.batches.filter((b) => b.sourceId === sourceId).sort((a, b) => cmp(a.batchId, b.batchId));
    return {
      sourceId,
      sourceKey: na(NA_REASONS.sourceKey),
      providers: [...new Set(batches.flatMap((b) => b.providers))].sort(cmp),
      focusVersions: [...new Set(batches.flatMap((b) => b.focusVersions))].sort(cmp),
      batches: batches.map((b) => ({
        batchId: b.batchId,
        status: 'published' as const,
        publishedAt: b.publishedAt,
        rowCount: decimal(b.rowCount, 'rowCount'),
        stagedArtifacts: input.artifacts
          .filter((a) => a.batchId === b.batchId)
          .map((a) => ({ stagedArtifactSha256: a.artifactSha256, rowCount: decimal(a.rowCount, 'rowCount') }))
          .sort((x, y) => cmp(x.stagedArtifactSha256, y.stagedArtifactSha256)),
        operatorFileSha256: na(NA_REASONS.operatorFile),
        reconciliation: na(NA_REASONS.batchStatus),
        controlTotals: na(NA_REASONS.batchStatus),
        importMetadataSha256: na(NA_REASONS.sourceKey),
      })),
      currencies: [...new Set(groups.map((g) => g.currency))].sort(cmp).map((c) => currencyFacts(groups, c)),
    };
  });

  const inData = [...new Set(input.groups.map((g) => g.currency))].sort(cmp);
  const latest = input.batches.map((b) => b.publishedAt).sort(cmp).pop();
  const minStart = input.batches.map((b) => b.chargePeriodStart).sort(cmp)[0];
  const maxEnd = input.batches.map((b) => b.chargePeriodEnd).sort(cmp).pop();
  const state = Date.parse(input.asOf) < Date.parse(`${end}T00:00:00Z`) ? 'open' : 'closed';

  let totals: Fact<CurrencyFacts[]>;
  let completeness: Fact<string>;
  if (sources.length === 0) {
    totals = na(NA_REASONS.noPublished);
    completeness = na(NA_REASONS.noPublished);
    gap('NO_PUBLISHED_BATCH', NA_REASONS.noPublished);
  } else {
    totals = sources.length === 1 ? ok(sources[0].currencies) : na(NA_REASONS.multiSource);
    if (sources.length > 1) gap('MULTI_SOURCE_NOT_COMBINED', NA_REASONS.multiSource);
    const covers = (minStart ?? '') <= `${start}T00:00:00.000000Z` && (maxEnd ?? '') >= `${end}T00:00:00.000000Z`;
    completeness = ok(covers ? SPAN_COVERS : SPAN_PARTIAL);
    if (!covers) gap('PERIOD_PARTIAL', `Published charge periods run from ${minStart} to ${maxEnd}; the month is ${start} to ${end} (exclusive)`);
  }
  gap('BATCH_STATUS_NOT_VISIBLE', NA_REASONS.batchStatus);
  if (state === 'open') gap('PERIOD_OPEN', `The period has not ended as of ${input.asOf}`);
  if (sources.some((s) => s.currencies.some((c) => c.effectiveCost.status !== 'available'))) gap('EFFECTIVE_PARTIAL', NA_REASONS.effectivePartial);

  const e = input.engagement;
  if (!e) gap('NO_ENGAGEMENT_CONFIG', NA_REASONS.noEngagement);
  else {
    const other = inData.filter((c) => c !== e.currency);
    if (other.length) gap('CURRENCY_NOT_REPORTING', `Amounts in ${other.join(', ')} are shown separately; the reporting currency is ${e.currency} and no FX is applied`);
    if (sources.length && e.declaredSources.length) gap('DECLARED_SOURCES_NOT_LINKED', NA_REASONS.sourceKey);
  }
  const declared = e ? [...e.declaredSources].sort((a, b) => cmp(a.id, b.id)) : [];

  return {
    schema: REPORT_FACTS_SCHEMA,
    scope: SCOPE_LABEL,
    period: { month: start.slice(0, 7), start, endExclusive: end, state, completeness },
    freshness: {
      asOf: input.asOf,
      latestPublishedAt: latest ? ok(latest) : na(NA_REASONS.noPublished),
      dataThrough: maxEnd ? ok(maxEnd) : na(NA_REASONS.noPublished),
    },
    currency: { reporting: e ? ok(e.currency) : na(NA_REASONS.noEngagement), inData, rule: 'Amounts are never summed or converted across currencies; no FX is applied' },
    costBasis: {
      shown: ['billed', 'effective'],
      billed: 'FOCUS BilledCost: the invoiced amount, after Credit and Adjustment rows',
      effective: 'FOCUS EffectiveCost: the amortized cost after discounts; partial or N/A where rows lack it',
      declared: e ? declared.map((s) => ({ sourceId: s.id, costBasis: s.costBasis })) : na(NA_REASONS.noEngagement),
    },
    creditsPolicy: {
      treatment: 'Credit and Adjustment rows (FOCUS ChargeCategory) are included once in both the billed and the effective totals, and are also listed separately',
      declared: e ? declared.map((s) => ({ sourceId: s.id, creditsCoverage: s.creditsCoverage })) : na(NA_REASONS.noEngagement),
    },
    declaredSources: e ? ok(declared) : na(NA_REASONS.noEngagement),
    sources,
    totals,
    coverageGaps: gaps,
  };
}
