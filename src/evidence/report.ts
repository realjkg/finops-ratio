// Shared EvidenceReport for the read-only discovery harnesses. No network, no
// fetch, no product wiring: a harness only reads artifacts a human provides.

export const MATURITY_LEVELS: readonly string[] = Object.freeze(['implemented', 'simulated', 'integration-tested', 'customer-validated']);
export type Maturity = 'implemented' | 'simulated' | 'integration-tested' | 'customer-validated';
/** Highest label this build may claim: everything here runs on synthetic fixtures. */
export const MATURITY_CEILING: Maturity = 'simulated';

export interface EvidenceReport<R> {
  harness: string;
  revision: string; // placeholder until a run supplies the real git revision
  env: string; // placeholder until a run supplies the environment
  commands: string[]; // commands / inputs used
  inputs: { id: string; kind: string }[];
  results: R;
  limitations: string[];
  maturity: Maturity;
}

export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

const BUILT = new WeakSet<object>(); // reports minted by buildReport only

function checkMaturity(m: unknown): asserts m is Maturity {
  if (typeof m !== 'string' || !MATURITY_LEVELS.includes(m)) throw new Error(`unknown maturity label '${String(m)}'`);
  if (MATURITY_LEVELS.indexOf(m) > MATURITY_LEVELS.indexOf(MATURITY_CEILING)) {
    throw new Error(`maturity '${m}' exceeds this build's ceiling '${MATURITY_CEILING}'`);
  }
}

/** The single validated factory: copies, deep-freezes and brands the report. */
export function buildReport<R>(p: Omit<EvidenceReport<R>, 'revision' | 'env' | 'maturity'> & { revision?: string; env?: string; maturity?: unknown }): EvidenceReport<R> {
  const maturity = p.maturity ?? 'simulated';
  checkMaturity(maturity);
  const report: EvidenceReport<R> = deepFreeze({
    harness: p.harness,
    revision: p.revision ?? 'placeholder: git revision not supplied',
    env: p.env ?? 'placeholder: environment not supplied',
    commands: [...p.commands],
    inputs: p.inputs.map((i) => ({ ...i })),
    results: p.results,
    limitations: [...p.limitations],
    maturity,
  });
  BUILT.add(report);
  return report;
}

/** Consumers and tests call this: only reports from buildReport pass. */
export function assertReport(r: EvidenceReport<unknown>): void {
  if (!BUILT.has(r)) throw new Error('not a report produced by buildReport');
  checkMaturity(r.maturity);
}
