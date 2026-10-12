// Shared EvidenceReport for the read-only discovery harnesses. No network, no
// fetch, no product wiring: a harness only reads artifacts a human provides.

export const MATURITY_LEVELS = ['implemented', 'simulated', 'integration-tested', 'customer-validated'] as const;
export type Maturity = (typeof MATURITY_LEVELS)[number];
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

export function buildReport<R>(p: {
  harness: string;
  commands: string[];
  inputs: { id: string; kind: string }[];
  results: R;
  limitations: string[];
  revision?: string;
  env?: string;
  maturity?: Maturity;
}): EvidenceReport<R> {
  const maturity = p.maturity ?? 'simulated';
  if (MATURITY_LEVELS.indexOf(maturity) > MATURITY_LEVELS.indexOf(MATURITY_CEILING)) {
    throw new Error(`maturity '${maturity}' exceeds this build's ceiling '${MATURITY_CEILING}'`);
  }
  return {
    harness: p.harness,
    revision: p.revision ?? 'placeholder: git revision not supplied',
    env: p.env ?? 'placeholder: environment not supplied',
    commands: p.commands,
    inputs: p.inputs,
    results: p.results,
    limitations: p.limitations,
    maturity,
  };
}
