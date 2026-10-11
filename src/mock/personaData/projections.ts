// Card A3: pure persona projections over the one synthetic dataset.
//
// Rules every projection follows:
//   1. Money is integer cents end to end. Nothing is divided by 100 and no
//      float is summed; `sumCents` rejects a non-integer amount.
//   2. The scope filter runs first. Every total, count and breakdown is
//      computed from the filtered lines, never from the whole dataset.
//   3. An empty scope yields an empty view, not the whole dataset.
//   4. Every view carries the dataset revision it was computed from.
//
// The projections only choose which rows a persona may see and at what
// granularity: `rollup` rows carry no line items; `drilldown` rows are lines.

import { validateDataset } from './dataset';
import type { Dataset, LineItem } from './dataset';
import { filterLines } from './scope';
import type { Scope } from './scope';

export type PersonaId = 'cto' | 'finops_lead' | 'finance' | 'eng_lead' | 'procurement' | 'auditor';

export const PERSONA_IDS: readonly PersonaId[] = [
  'cto',
  'finops_lead',
  'finance',
  'eng_lead',
  'procurement',
  'auditor',
];

export interface PageRequest {
  /** Zero-based index of the first row of the page. */
  offset: number;
  /** Maximum rows in the page; at least 1. */
  limit: number;
}

export interface ViewRow {
  key: string;
  /**
   * Integer cents. The complete (unpaged) row set sums to the view total; a
   * paged view holds only the current page, while the total covers every row.
   */
  cents: number;
  [field: string]: string | number;
}

export interface BudgetLine {
  team: string;
  budgetCents: number;
  actualCents: number;
  /** budgetCents minus actualCents; negative when over budget. */
  varianceCents: number;
}

export interface PersonaView {
  persona: PersonaId;
  shape: 'rollup' | 'drilldown';
  revision: number;
  /** Total of the whole scoped view, not of the current page. */
  totalCents: number;
  /** Row count of the whole scoped view, not of the current page. */
  rowCount: number;
  /** The current page of rows (all rows when no page is requested). */
  rows: ViewRow[];
  byTeam: { team: string; cents: number }[];
  byEnv: { env: string; cents: number }[];
  budgets?: BudgetLine[];
  readOnly?: true;
}

function sumCents(items: readonly { cents: number }[]): number {
  // Accumulate exactly: an intermediate total may leave the safe range even
  // when the final result does not. Convert only after validating the result.
  let total = BigInt(0);
  for (const item of items) {
    if (!Number.isInteger(item.cents)) {
      throw new RangeError('amount is not an integer number of cents');
    }
    total += BigInt(item.cents);
  }
  const result = Number(total);
  if (!Number.isSafeInteger(result) || BigInt(result) !== total) {
    throw new RangeError('total is outside the safe integer range');
  }
  return result;
}

/** a minus b, computed exactly; throws if the exact result is not a safe integer. */
function exactDifference(a: number, b: number): number {
  const exact = BigInt(a) - BigInt(b);
  const result = Number(exact);
  if (!Number.isSafeInteger(result) || BigInt(result) !== exact) {
    throw new RangeError('difference is outside the safe integer range');
  }
  return result;
}

function lineRow(l: LineItem): ViewRow {
  return {
    key: l.id,
    id: l.id,
    team: l.team,
    env: l.env,
    vendor: l.vendor,
    category: l.category,
    kind: l.kind,
    description: l.description,
    cents: l.cents,
  };
}

function financeRow(l: LineItem): ViewRow {
  return { key: l.id, id: l.id, team: l.team, env: l.env, category: l.category, cents: l.cents };
}

function rollupRows(ds: Dataset, lines: readonly LineItem[]): ViewRow[] {
  const rows: ViewRow[] = [];
  for (const team of ds.teams) {
    for (const env of ds.envs) {
      const cell = lines.filter((l) => l.team === team && l.env === env);
      if (cell.length > 0) rows.push({ key: `${team}/${env}`, team, env, cents: sumCents(cell) });
    }
  }
  return rows;
}

function vendorRows(ds: Dataset, lines: readonly LineItem[]): ViewRow[] {
  const rows: ViewRow[] = [];
  for (const vendor of ds.vendors) {
    const own = lines.filter((l) => l.vendor === vendor);
    if (own.length === 0) continue;
    const commitments = own.filter((l) => l.kind === 'commitment');
    rows.push({
      key: vendor,
      vendor,
      usageCents: sumCents(own.filter((l) => l.kind === 'usage')),
      commitmentCents: sumCents(commitments),
      commitmentLines: commitments.length,
      cents: sumCents(own),
    });
  }
  return rows;
}

function breakdownByTeam(ds: Dataset, lines: readonly LineItem[]) {
  return ds.teams
    .map((team) => ({ team, own: lines.filter((l) => l.team === team) }))
    .filter((x) => x.own.length > 0)
    .map((x) => ({ team: x.team, cents: sumCents(x.own) }));
}

function breakdownByEnv(ds: Dataset, lines: readonly LineItem[]) {
  return ds.envs
    .map((env) => ({ env: String(env), own: lines.filter((l) => l.env === env) }))
    .filter((x) => x.own.length > 0)
    .map((x) => ({ env: x.env, cents: sumCents(x.own) }));
}

function budgetLines(ds: Dataset, lines: readonly LineItem[]): BudgetLine[] {
  const out: BudgetLine[] = [];
  for (const b of ds.budgets) {
    const own = lines.filter((l) => l.team === b.team);
    if (own.length === 0) continue;
    const actualCents = sumCents(own);
    out.push({ team: b.team, budgetCents: b.cents, actualCents, varianceCents: exactDifference(b.cents, actualCents) });
  }
  return out;
}

function checkPage(page: PageRequest): void {
  if (!Number.isSafeInteger(page.offset) || page.offset < 0) {
    throw new RangeError('page offset must be a non-negative integer');
  }
  if (!Number.isSafeInteger(page.limit) || page.limit < 1) {
    throw new RangeError('page limit must be a positive integer');
  }
}

export function project(
  persona: PersonaId,
  dataset: Dataset,
  scope: Scope,
  page?: PageRequest,
): PersonaView {
  if (page) checkPage(page);
  // One entry check for the whole class of unsafe-amount bugs: after this,
  // every amount is a safe integer, so the exact (BigInt) sums below are valid.
  validateDataset(dataset);

  // Scope first: everything below reads only `lines`.
  const lines = filterLines(dataset.lines, scope);

  let shape: PersonaView['shape'] = 'drilldown';
  let all: ViewRow[];
  switch (persona) {
    case 'cto':
      shape = 'rollup';
      all = rollupRows(dataset, lines);
      break;
    case 'procurement':
      shape = 'rollup';
      all = vendorRows(dataset, lines);
      break;
    case 'finance':
      all = lines.map(financeRow);
      break;
    case 'finops_lead':
    case 'eng_lead':
    case 'auditor':
      all = lines.map(lineRow);
      break;
    default: {
      const never: never = persona;
      throw new RangeError(`unknown persona: ${String(never)}`);
    }
  }

  const view: PersonaView = {
    persona,
    shape,
    revision: dataset.revision,
    totalCents: sumCents(lines),
    rowCount: all.length,
    rows: page ? all.slice(page.offset, page.offset + page.limit) : all,
    byTeam: breakdownByTeam(dataset, lines),
    byEnv: breakdownByEnv(dataset, lines),
  };
  if (persona === 'finance') view.budgets = budgetLines(dataset, lines);
  if (persona === 'auditor') view.readOnly = true;
  return view;
}
