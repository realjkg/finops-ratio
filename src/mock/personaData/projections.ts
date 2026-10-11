// Card A3 RED stub: replaced by the implementation in the next commit.
import type { Dataset } from './dataset';
import type { Scope } from './scope';

export type PersonaId = 'cto' | 'finops_lead' | 'finance' | 'eng_lead' | 'procurement' | 'auditor';
export interface PageRequest {
  offset: number;
  limit: number;
}
export interface ViewRow {
  key: string;
  cents: number;
  [field: string]: string | number;
}
export interface PersonaView {
  persona: PersonaId;
  shape: 'rollup' | 'drilldown';
  revision: number;
  totalCents: number;
  rowCount: number;
  rows: ViewRow[];
  byTeam: { team: string; cents: number }[];
  byEnv: { env: string; cents: number }[];
  budgets?: { team: string; budgetCents: number; actualCents: number; varianceCents: number }[];
  readOnly?: true;
}
export const PERSONA_IDS: readonly PersonaId[] = [
  'cto', 'finops_lead', 'finance', 'eng_lead', 'procurement', 'auditor',
];
export function project(
  _persona: PersonaId,
  _dataset: Dataset,
  _scope: Scope,
  _page?: PageRequest,
): PersonaView {
  throw new Error('not implemented');
}
