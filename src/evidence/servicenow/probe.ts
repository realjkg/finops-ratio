// Read-only ServiceNow role-discovery probe. Reports which record classes are
// PRESENT or ABSENT in provided artifacts and never assumes cost data exists.
// Authority stays 'unknown' until a human supplies a decision. Findings and
// decisions are branded inside this module (a private WeakSet) and deep-frozen,
// so copies, spreads, clones and literals cannot be used to emit cost rows.
import { buildReport, deepFreeze, type EvidenceReport } from '../report';

export type RecordClass = 'service_ci_mapping' | 'project_demand' | 'license_asset' | 'cost_records';
export type Presence = 'present' | 'absent' | 'unknown' | 'conflict';
export type ServiceNowArtifact =
  | { id: string; kind: 'table_inventory'; complete: boolean; tables: readonly { name: string; rowCount?: number }[] }
  | { id: string; kind: 'plugin_list'; plugins: readonly { id: string; active: boolean }[] }
  | { id: string; kind: 'sample_records'; table: string; records: readonly Record<string, unknown>[] };

export interface HumanDecision { decision: 'cost_bearing' | 'not_cost_bearing'; decidedBy: string }
export interface BoundDecision extends HumanDecision { sourceId: string; recordClass: RecordClass }
export interface RoleFinding { recordClass: RecordClass; sourceId: string; presence: Presence; evidence: string[]; conflicts: string[]; authority: 'unknown' | BoundDecision }

/** ILLUSTRATIVE table-name hints and required sample fields; incomplete and not verified against a live instance. */
export const TABLE_HINTS: Record<RecordClass, readonly string[]> = {
  service_ci_mapping: ['cmdb_ci', 'cmdb_ci_service', 'cmdb_rel_ci'],
  project_demand: ['pm_project', 'dmn_demand'],
  license_asset: ['alm_license', 'alm_asset'],
  cost_records: ['fm_expense_line'],
};
const REQUIRED_FIELDS: Record<RecordClass, readonly string[]> = {
  service_ci_mapping: ['sys_id', 'name'],
  project_demand: ['number', 'short_description'],
  license_asset: ['sys_id', 'display_name'],
  cost_records: ['amount', 'currency'],
};
const PLUGIN_HINTS: Record<RecordClass, RegExp> = {
  service_ci_mapping: /cmdb|service[-_. ]?mapping/i,
  project_demand: /project|demand|itbm/i,
  license_asset: /license|sam|asset/i,
  cost_records: /cost|financial/i,
};

export interface ServiceNowRoleProbe {
  /** Read-only: inputs are never mutated; no I/O. `sourceId` names the source the findings are bound to. */
  probe(sourceId: string, artifacts: readonly ServiceNowArtifact[]): EvidenceReport<{ findings: RoleFinding[] }>;
}

export class RoleNotConfirmedError extends Error {}

const BRANDED = new WeakSet<object>(); // findings and decisions minted in this module
const mint = <T extends object>(v: T): T => { BRANDED.add(v); return deepFreeze(v); };
const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const validCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 1e9;
const isPlain = (r: unknown): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length > 0;

/** Returns a new immutable finding carrying a human decision; throws if one already exists. */
export function withHumanDecision(f: RoleFinding, d: HumanDecision): RoleFinding {
  if (!BRANDED.has(f)) throw new RoleNotConfirmedError('finding was not produced by the probe');
  if (f.authority !== 'unknown') throw new Error('a decision already exists; run the probe again to decide anew');
  const decidedBy = typeof d.decidedBy === 'string' ? d.decidedBy.trim() : '';
  if (!decidedBy) throw new Error('a human decision needs a named decider');
  const authority = mint({ decision: d.decision, decidedBy, sourceId: f.sourceId, recordClass: f.recordClass });
  return mint({ ...f, evidence: [...f.evidence], conflicts: [...f.conflicts], authority });
}

/** Refuses unless a branded, source- and class-bound cost_bearing decision exists and records were observed. */
export function emitCostRows<T>(f: RoleFinding, rows: readonly T[], sourceId: string): T[] {
  const a = f.authority;
  const ok = BRANDED.has(f) && f.recordClass === 'cost_records' && f.presence === 'present' && f.sourceId === sourceId
    && a !== 'unknown' && BRANDED.has(a) && a.decision === 'cost_bearing' && a.sourceId === sourceId && a.recordClass === 'cost_records' && a.decidedBy.trim() !== '';
  if (!ok) throw new RoleNotConfirmedError('source role is not confirmed as cost-bearing; refusing to emit cost rows');
  return [...rows];
}

function findFor(recordClass: RecordClass, sourceId: string, artifacts: readonly ServiceNowArtifact[]): RoleFinding {
  const hints = TABLE_HINTS[recordClass];
  const evidence: string[] = [], conflicts: string[] = [];
  let rowsSeen = false, completeInventory = false, countUnknown = false;
  const completeWithRows = new Set<string>(); // hint tables with rows in a COMPLETE inventory
  const sampled: { id: string; table: string }[] = [];
  for (const a of artifacts) {
    if (a.kind === 'table_inventory') {
      completeInventory ||= a.complete;
      for (const t of a.tables.filter((x) => hints.includes(norm(x.name)))) {
        if (validCount(t.rowCount) && t.rowCount > 0) { rowsSeen = true; if (a.complete) completeWithRows.add(norm(t.name)); evidence.push(`${a.id}: table ${norm(t.name)} has ${t.rowCount} rows`); }
        else if (!(validCount(t.rowCount) && t.rowCount === 0)) countUnknown = true;
      }
    } else if (a.kind === 'sample_records' && hints.includes(norm(a.table))) {
      const recs = a.records;
      const valid = Array.isArray(recs) && recs.length > 0 && recs.every((r) => isPlain(r) && REQUIRED_FIELDS[recordClass].every((k) => r[k] !== undefined && r[k] !== null));
      evidence.push(`${a.id}: ${valid ? `${recs.length} sample record(s) from` : 'invalid sample (empty or missing required fields) from'} ${norm(a.table)}`);
      if (valid) { rowsSeen = true; sampled.push({ id: a.id, table: norm(a.table) }); }
    } else if (a.kind === 'plugin_list') {
      for (const p of a.plugins.filter((x) => x.active && PLUGIN_HINTS[recordClass].test(x.id))) evidence.push(`${a.id}: module ${p.id} active (records not verified)`);
    }
  }
  if (completeInventory) for (const s of sampled) if (!completeWithRows.has(s.table)) conflicts.push(`${s.id}: sample records exist but a complete inventory does not list ${s.table} with rows`);
  const presence: Presence = conflicts.length ? 'conflict' : rowsSeen ? 'present' : completeInventory && !countUnknown ? 'absent' : 'unknown';
  return mint({ recordClass, sourceId, presence, evidence, conflicts, authority: 'unknown' as const });
}

export function createServiceNowRoleProbe(): ServiceNowRoleProbe {
  return {
    probe(sourceId, artifacts) {
      if (typeof sourceId !== 'string' || !sourceId.trim()) throw new Error('probe needs a non-empty source id');
      const classes = Object.keys(TABLE_HINTS) as RecordClass[];
      return buildReport({
        harness: 'servicenow_role',
        commands: [`inspect ${artifacts.length} provided artifact(s) in memory; no network`],
        inputs: artifacts.map((a) => ({ id: a.id, kind: a.kind })),
        results: { findings: classes.map((c) => findFor(c, sourceId.trim(), artifacts)) },
        limitations: [
          'Synthetic fixtures only; no live ServiceNow instance was queried.',
          'Table-name hints and required fields are illustrative and incomplete: "absent" means only that no hint table was found in a complete inventory.',
          'A module being active is not evidence that records exist; presence needs rows or valid samples.',
          'Authority is unknown for every class until a human supplies a decision; presence is never authority.',
        ],
      });
    },
  };
}
