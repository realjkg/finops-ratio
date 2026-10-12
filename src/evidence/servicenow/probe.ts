// Read-only ServiceNow role-discovery probe. Reports which record classes are
// PRESENT or ABSENT in provided artifacts and never assumes cost data exists.
// Authority stays 'unknown' until a human supplies a decision.
import { buildReport, type EvidenceReport } from '../report';

export type RecordClass = 'service_ci_mapping' | 'project_demand' | 'license_asset' | 'cost_records';
export type Presence = 'present' | 'absent' | 'unknown';
export type ServiceNowArtifact =
  | { id: string; kind: 'table_inventory'; complete: boolean; tables: readonly { name: string; rowCount?: number }[] }
  | { id: string; kind: 'plugin_list'; plugins: readonly { id: string; active: boolean }[] }
  | { id: string; kind: 'sample_records'; table: string; records: readonly Record<string, unknown>[] };

export interface HumanDecision { decision: 'cost_bearing' | 'not_cost_bearing'; decidedBy: string }
export interface RoleFinding { recordClass: RecordClass; presence: Presence; evidence: string[]; authority: 'unknown' | HumanDecision }

/** ILLUSTRATIVE table-name hints; incomplete and not verified against a live instance. */
export const TABLE_HINTS: Record<RecordClass, readonly string[]> = {
  service_ci_mapping: ['cmdb_ci', 'cmdb_ci_service', 'cmdb_rel_ci'],
  project_demand: ['pm_project', 'dmn_demand'],
  license_asset: ['alm_license', 'alm_asset'],
  cost_records: ['fm_expense_line'],
};
const PLUGIN_HINTS: Record<RecordClass, RegExp> = {
  service_ci_mapping: /cmdb|service[-_. ]?mapping/i,
  project_demand: /project|demand|itbm/i,
  license_asset: /license|sam|asset/i,
  cost_records: /cost|financial/i,
};

export interface ServiceNowRoleProbe {
  /** Read-only: inputs are never mutated; no I/O. */
  probe(artifacts: readonly ServiceNowArtifact[]): EvidenceReport<{ findings: RoleFinding[] }>;
}

export class RoleNotConfirmedError extends Error {}

export function withHumanDecision(f: RoleFinding, d: HumanDecision): RoleFinding {
  if (!d.decidedBy.trim()) throw new Error('a human decision needs a named decider');
  return { ...f, authority: { ...d } };
}

/** Refuses unless a human confirmed cost-bearing AND records were observed. */
export function emitCostRows<T>(f: RoleFinding, rows: readonly T[]): T[] {
  const confirmed = f.authority !== 'unknown' && f.authority.decision === 'cost_bearing';
  if (f.recordClass !== 'cost_records' || !confirmed || f.presence !== 'present') {
    throw new RoleNotConfirmedError('source role is not confirmed as cost-bearing; refusing to emit cost rows');
  }
  return [...rows];
}

function findFor(recordClass: RecordClass, artifacts: readonly ServiceNowArtifact[]): RoleFinding {
  const hints = TABLE_HINTS[recordClass];
  const evidence: string[] = [];
  let rowsSeen = false;
  let completeInventory = false;
  for (const a of artifacts) {
    if (a.kind === 'table_inventory') {
      completeInventory ||= a.complete;
      for (const t of a.tables.filter((x) => hints.includes(x.name))) {
        if ((t.rowCount ?? 0) > 0) { rowsSeen = true; evidence.push(`${a.id}: table ${t.name} has ${t.rowCount} rows`); }
      }
    } else if (a.kind === 'sample_records' && hints.includes(a.table) && a.records.length > 0) {
      rowsSeen = true;
      evidence.push(`${a.id}: ${a.records.length} sample record(s) from ${a.table}`);
    } else if (a.kind === 'plugin_list') {
      for (const p of a.plugins.filter((x) => x.active && PLUGIN_HINTS[recordClass].test(x.id))) evidence.push(`${a.id}: module ${p.id} active (records not verified)`);
    }
  }
  const absent = !rowsSeen && completeInventory; // hint tables missing or empty in a complete inventory
  return { recordClass, presence: rowsSeen ? 'present' : absent ? 'absent' : 'unknown', evidence, authority: 'unknown' };
}

export function createServiceNowRoleProbe(): ServiceNowRoleProbe {
  return {
    probe(artifacts) {
      const classes = Object.keys(TABLE_HINTS) as RecordClass[];
      return buildReport({
        harness: 'servicenow_role',
        commands: [`inspect ${artifacts.length} provided artifact(s) in memory; no network`],
        inputs: artifacts.map((a) => ({ id: a.id, kind: a.kind })),
        results: { findings: classes.map((c) => findFor(c, artifacts)) },
        limitations: [
          'Synthetic fixtures only; no live ServiceNow instance was queried.',
          'Table-name hints are illustrative and incomplete: "absent" means only that no hint table was found in a complete inventory.',
          'A module being active is not evidence that records exist; presence needs rows or samples.',
          'Authority is unknown for every class until a human supplies a decision; presence is never authority.',
        ],
      });
    },
  };
}
