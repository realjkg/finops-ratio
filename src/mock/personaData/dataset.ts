// Card A3: the single synthetic dataset behind every persona view.
//
// Money is integer cents only. Several values are chosen so that adding
// cents / 100 as binary floats drifts from the exact total (for example
// 0.29, 0.57 and 1.15), which is how a float-summing projection is caught.
// Nothing here is real data: teams, vendors and amounts are invented.

export type DataEnv = 'dev' | 'test' | 'prod';
export type LineKind = 'usage' | 'commitment';

export interface LineItem {
  readonly id: string;
  readonly team: string;
  readonly env: DataEnv;
  readonly vendor: string;
  readonly category: string;
  readonly kind: LineKind;
  readonly description: string;
  /** Integer cents. Never a float. */
  readonly cents: number;
}

export interface TeamBudget {
  readonly team: string;
  /** Integer cents. */
  readonly cents: number;
}

export interface Dataset {
  /** Starts at 1; every change to the data bumps it by exactly 1. */
  readonly revision: number;
  readonly teams: readonly string[];
  readonly envs: readonly DataEnv[];
  readonly vendors: readonly string[];
  readonly budgets: readonly TeamBudget[];
  readonly lines: readonly LineItem[];
}

export const TEAMS: readonly string[] = ['Platform', 'Payments', 'Analytics'];
export const ENVS: readonly DataEnv[] = ['dev', 'test', 'prod'];
export const VENDORS: readonly string[] = ['aws', 'azure', 'gcp', 'snowflake'];

export const BUDGETS: readonly TeamBudget[] = [
  { team: 'Platform', cents: 15000000 },
  { team: 'Payments', cents: 100000000 },
  { team: 'Analytics', cents: 8000000 },
];

export const LINES: readonly LineItem[] = [
  { id: 'L01', team: 'Platform', env: 'dev', vendor: 'aws', category: 'compute', kind: 'usage', description: 'Platform dev compute line 1', cents: 10 },
  { id: 'L02', team: 'Platform', env: 'dev', vendor: 'azure', category: 'storage', kind: 'usage', description: 'Platform dev storage line 2', cents: 20 },
  { id: 'L03', team: 'Platform', env: 'dev', vendor: 'gcp', category: 'network', kind: 'usage', description: 'Platform dev network line 3', cents: 29 },
  { id: 'L04', team: 'Platform', env: 'test', vendor: 'snowflake', category: 'database', kind: 'usage', description: 'Platform test database line 1', cents: 57 },
  { id: 'L05', team: 'Platform', env: 'test', vendor: 'aws', category: 'support', kind: 'usage', description: 'Platform test support line 2', cents: 115 },
  { id: 'L06', team: 'Platform', env: 'test', vendor: 'azure', category: 'compute', kind: 'commitment', description: 'Platform test compute line 3', cents: 820 },
  { id: 'L07', team: 'Platform', env: 'prod', vendor: 'gcp', category: 'storage', kind: 'usage', description: 'Platform prod storage line 1', cents: 1999 },
  { id: 'L08', team: 'Platform', env: 'prod', vendor: 'snowflake', category: 'network', kind: 'commitment', description: 'Platform prod network line 2', cents: 100005 },
  { id: 'L09', team: 'Platform', env: 'prod', vendor: 'aws', category: 'database', kind: 'usage', description: 'Platform prod database line 3', cents: 12345678 },
  { id: 'L10', team: 'Payments', env: 'dev', vendor: 'azure', category: 'support', kind: 'usage', description: 'Payments dev support line 1', cents: 333 },
  { id: 'L11', team: 'Payments', env: 'dev', vendor: 'gcp', category: 'compute', kind: 'usage', description: 'Payments dev compute line 2', cents: 7 },
  { id: 'L12', team: 'Payments', env: 'dev', vendor: 'snowflake', category: 'storage', kind: 'usage', description: 'Payments dev storage line 3', cents: 1 },
  { id: 'L13', team: 'Payments', env: 'test', vendor: 'aws', category: 'network', kind: 'usage', description: 'Payments test network line 1', cents: 4999 },
  { id: 'L14', team: 'Payments', env: 'test', vendor: 'azure', category: 'database', kind: 'usage', description: 'Payments test database line 2', cents: 2999 },
  { id: 'L15', team: 'Payments', env: 'test', vendor: 'gcp', category: 'support', kind: 'usage', description: 'Payments test support line 3', cents: 29 },
  { id: 'L16', team: 'Payments', env: 'prod', vendor: 'snowflake', category: 'compute', kind: 'commitment', description: 'Payments prod compute line 1', cents: 99999999 },
  { id: 'L17', team: 'Payments', env: 'prod', vendor: 'aws', category: 'storage', kind: 'usage', description: 'Payments prod storage line 2', cents: 15 },
  { id: 'L18', team: 'Payments', env: 'prod', vendor: 'azure', category: 'network', kind: 'usage', description: 'Payments prod network line 3', cents: 250050 },
  { id: 'L19', team: 'Analytics', env: 'dev', vendor: 'gcp', category: 'database', kind: 'usage', description: 'Analytics dev database line 1', cents: 5 },
  { id: 'L20', team: 'Analytics', env: 'dev', vendor: 'snowflake', category: 'support', kind: 'usage', description: 'Analytics dev support line 2', cents: 10 },
  { id: 'L21', team: 'Analytics', env: 'dev', vendor: 'aws', category: 'compute', kind: 'usage', description: 'Analytics dev compute line 3', cents: 30 },
  { id: 'L22', team: 'Analytics', env: 'test', vendor: 'azure', category: 'storage', kind: 'usage', description: 'Analytics test storage line 1', cents: 114 },
  { id: 'L23', team: 'Analytics', env: 'test', vendor: 'gcp', category: 'network', kind: 'usage', description: 'Analytics test network line 2', cents: 57 },
  { id: 'L24', team: 'Analytics', env: 'test', vendor: 'snowflake', category: 'database', kind: 'usage', description: 'Analytics test database line 3', cents: 8250 },
  { id: 'L25', team: 'Analytics', env: 'prod', vendor: 'aws', category: 'support', kind: 'usage', description: 'Analytics prod support line 1', cents: 7777777 },
  { id: 'L26', team: 'Analytics', env: 'prod', vendor: 'azure', category: 'compute', kind: 'usage', description: 'Analytics prod compute line 2', cents: 410 },
  { id: 'L27', team: 'Analytics', env: 'prod', vendor: 'gcp', category: 'storage', kind: 'commitment', description: 'Analytics prod storage line 3', cents: 19999 },
];

export const DATASET: Dataset = {
  revision: 1,
  teams: TEAMS,
  envs: ENVS,
  vendors: VENDORS,
  budgets: BUDGETS,
  lines: LINES,
};

/** Every stored amount must be a safe integer number of cents. */
export function assertSafeCents(cents: number): void {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError('cents must be a safe integer');
  }
}

/** Entry validation: every line amount and every team budget is a safe integer. */
export function validateDataset(ds: Dataset): void {
  for (const l of ds.lines) assertSafeCents(l.cents);
  for (const b of ds.budgets) assertSafeCents(b.cents);
}

/**
 * Returns a new dataset in which one line has a new amount and the revision is
 * one higher. The input is never mutated. Throws on an unknown line or a
 * non-integer amount, so a bad edit cannot silently produce a float.
 */
export function reviseDataset(base: Dataset, lineId: string, cents: number): Dataset {
  assertSafeCents(cents);
  if (!base.lines.some((l) => l.id === lineId)) {
    throw new RangeError('unknown line id');
  }
  return {
    ...base,
    revision: base.revision + 1,
    lines: base.lines.map((l) => (l.id === lineId ? { ...l, cents } : l)),
  };
}
