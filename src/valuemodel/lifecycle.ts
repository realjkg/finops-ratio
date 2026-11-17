// Versioning for user-defined KPI definitions: Draft → Validated → Approved → Published → Superseded.
//
// - A sponsor (or other author) creates and edits drafts with their own custom inputs.
// - Validation runs the full definition check; an edit after validation returns the draft to Draft and clears approvals.
// - Approval needs someone other than the author with `kpi_approver`; a definition that reads or produces money also
//   needs a `finance_approver` who is not the author. Approvals are bound to the definition's digest.
// - Publishing freezes the version for good. Publishing a newer version marks the older one Superseded; it is still
//   readable, so every historical result can show the exact definition it was computed under.
// - Changing a published definition is impossible: `newVersion` copies it into a new draft with version + 1.
//
// In-memory reference implementation of the rules. A durable store must enforce the same transitions (and the same
// append-only history) in its own schema; that is a separate, reviewed change.
import { digestOf } from './digest';
import { type KpiDefinition, checkKpiDefinition } from './kpiDefinition';
import { isMoney } from './units';

export type DefinitionStatus = 'draft' | 'validated' | 'approved' | 'published' | 'superseded';
export interface Actor {
  id: string;
  roles: readonly string[];
}
export interface Approval {
  by: string;
  role: 'kpi_approver' | 'finance_approver';
  at: string;
  digest: string;
}
export interface DefinitionEvent {
  at: string;
  by: string;
  action: 'created' | 'edited' | 'validated' | 'validation_failed' | 'approved' | 'published' | 'superseded' | 'new_version';
  digest: string;
}
export interface DefinitionRecord {
  readonly definition: KpiDefinition;
  readonly status: DefinitionStatus;
  readonly digest: string;
  readonly authoredBy: string;
  readonly basedOnVersion?: number;
  readonly approvals: readonly Approval[];
  readonly requiresFinanceApproval: boolean;
  readonly problems: readonly string[];
  readonly publishedAt?: string;
  readonly supersededBy?: number;
  readonly history: readonly DefinitionEvent[];
}

export class LifecycleError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'IMMUTABLE' | 'FORBIDDEN' | 'INVALID_STATE' | 'INVALID_DEFINITION' | 'SEPARATION_OF_DUTIES' | 'CONFLICT', what: string) {
    super(what);
    this.name = 'LifecycleError';
  }
}

const AUTHOR_ROLES = ['project_sponsor', 'kpi_author'];

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function moneyInvolved(def: KpiDefinition): boolean {
  const c = checkKpiDefinition(def);
  if (!c.ok) return false;
  return isMoney(c.resultUnit) || Object.values(c.inputUnits).some(isMoney);
}

export class KpiDefinitionRegistry {
  private readonly records = new Map<string, DefinitionRecord[]>();

  constructor(readonly tenantId: string) {}

  private versions(definitionId: string): DefinitionRecord[] {
    return this.records.get(definitionId) ?? [];
  }

  private put(rec: DefinitionRecord): DefinitionRecord {
    const list = [...this.versions(rec.definition.definitionId)];
    const i = list.findIndex((r) => r.definition.version === rec.definition.version);
    if (i >= 0) list[i] = rec;
    else list.push(rec);
    this.records.set(rec.definition.definitionId, list);
    return rec;
  }

  get(definitionId: string, version: number): DefinitionRecord {
    const r = this.versions(definitionId).find((x) => x.definition.version === version);
    if (!r) throw new LifecycleError('NOT_FOUND', 'definition version not found');
    return r;
  }

  /** The published version in force, if any. */
  published(definitionId: string): DefinitionRecord | undefined {
    return this.versions(definitionId).find((r) => r.status === 'published');
  }

  list(definitionId: string): readonly DefinitionRecord[] {
    return [...this.versions(definitionId)].sort((a, b) => a.definition.version - b.definition.version);
  }

  private build(prev: Partial<DefinitionRecord> & { definition: KpiDefinition; authoredBy: string }, patch: Partial<DefinitionRecord>, event: Omit<DefinitionEvent, 'digest'>): DefinitionRecord {
    const definition = deepFreeze(clone(patch.definition ?? prev.definition));
    const digest = digestOf(definition);
    const rec: DefinitionRecord = {
      status: 'draft', approvals: [], problems: [], history: [],
      ...prev, ...patch, definition, digest,
      // Recomputed on every change: an edit that adds money must gain the finance approval.
      requiresFinanceApproval: moneyInvolved(definition),
    } as DefinitionRecord;
    return deepFreeze({ ...rec, history: [...(prev.history ?? []), { ...event, digest }] });
  }

  createDraft(def: KpiDefinition, actor: Actor, at: string): DefinitionRecord {
    if (!actor.roles.some((r) => AUTHOR_ROLES.includes(r))) throw new LifecycleError('FORBIDDEN', 'creating a KPI definition needs project_sponsor or kpi_author');
    if (def.tenantId !== this.tenantId) throw new LifecycleError('FORBIDDEN', 'definition belongs to another tenant');
    if (this.versions(def.definitionId).length > 0) throw new LifecycleError('CONFLICT', 'definition already exists; use newVersion');
    if (def.version !== 1) throw new LifecycleError('INVALID_STATE', 'a new definition starts at version 1');
    return this.put(this.build({ definition: def, authoredBy: actor.id }, {}, { at, by: actor.id, action: 'created' }));
  }

  /** Edits a draft or validated version. Any edit returns it to Draft and clears approvals. */
  editDraft(def: KpiDefinition, actor: Actor, at: string): DefinitionRecord {
    const cur = this.get(def.definitionId, def.version);
    if (cur.status === 'published' || cur.status === 'superseded') throw new LifecycleError('IMMUTABLE', 'a published definition never changes; create a new version');
    if (cur.status === 'approved') throw new LifecycleError('IMMUTABLE', 'an approved definition is frozen for publishing; create a new version to change it');
    if (actor.id !== cur.authoredBy) throw new LifecycleError('FORBIDDEN', 'only the author edits a draft');
    if (def.tenantId !== this.tenantId) throw new LifecycleError('FORBIDDEN', 'definition belongs to another tenant');
    if (def.projectId !== cur.definition.projectId) throw new LifecycleError('FORBIDDEN', 'a definition stays in its project; create a new definition for another project');
    return this.put(this.build(cur, { definition: def, status: 'draft', approvals: [], problems: [] }, { at, by: actor.id, action: 'edited' }));
  }

  validate(definitionId: string, version: number, actor: Actor, at: string): DefinitionRecord {
    const cur = this.get(definitionId, version);
    if (cur.status !== 'draft') throw new LifecycleError('INVALID_STATE', 'only a draft is validated');
    const c = checkKpiDefinition(cur.definition);
    if (!c.ok) return this.put(this.build(cur, { problems: c.problems }, { at, by: actor.id, action: 'validation_failed' }));
    return this.put(this.build(cur, { status: 'validated', problems: [] }, { at, by: actor.id, action: 'validated' }));
  }

  approve(definitionId: string, version: number, actor: Actor, role: Approval['role'], digest: string, at: string): DefinitionRecord {
    const cur = this.get(definitionId, version);
    if (cur.status !== 'validated') throw new LifecycleError('INVALID_STATE', 'only a validated definition is approved');
    if (digest !== cur.digest) throw new LifecycleError('CONFLICT', 'the definition changed since it was reviewed');
    if (!actor.roles.includes(role)) throw new LifecycleError('FORBIDDEN', `approving as ${role} needs that role`);
    if (actor.id === cur.authoredBy) throw new LifecycleError('SEPARATION_OF_DUTIES', 'the author cannot approve their own definition');
    if (role === 'finance_approver' && !cur.requiresFinanceApproval) throw new LifecycleError('INVALID_STATE', 'this definition involves no money; finance approval is not needed');
    if (cur.approvals.some((a) => a.role === role)) throw new LifecycleError('CONFLICT', `already approved as ${role}`);
    if (cur.approvals.some((a) => a.by === actor.id)) throw new LifecycleError('SEPARATION_OF_DUTIES', 'one person gives at most one of the required approvals');
    const approvals = [...cur.approvals, { by: actor.id, role, at, digest }];
    const needed: Approval['role'][] = cur.requiresFinanceApproval ? ['kpi_approver', 'finance_approver'] : ['kpi_approver'];
    const complete = needed.every((r) => approvals.some((a) => a.role === r));
    return this.put(this.build(cur, { approvals, status: complete ? 'approved' : 'validated' }, { at, by: actor.id, action: 'approved' }));
  }

  publish(definitionId: string, version: number, actor: Actor, at: string): DefinitionRecord {
    const cur = this.get(definitionId, version);
    if (cur.status !== 'approved') throw new LifecycleError('INVALID_STATE', 'only an approved definition is published');
    if (!actor.roles.includes('kpi_approver')) throw new LifecycleError('FORBIDDEN', 'publishing needs kpi_approver');
    const prior = this.published(definitionId);
    if (prior && prior.definition.version > version) throw new LifecycleError('INVALID_STATE', 'a newer version is already published');
    if (prior) this.put(this.build(prior, { status: 'superseded', supersededBy: version }, { at, by: actor.id, action: 'superseded' }));
    return this.put(this.build(cur, { status: 'published', publishedAt: at }, { at, by: actor.id, action: 'published' }));
  }

  /** Starts a new draft from the latest version. The original stays exactly as published. */
  newVersion(definitionId: string, actor: Actor, at: string): DefinitionRecord {
    const all = this.list(definitionId);
    if (all.length === 0) throw new LifecycleError('NOT_FOUND', 'definition not found');
    if (!actor.roles.some((r) => AUTHOR_ROLES.includes(r))) throw new LifecycleError('FORBIDDEN', 'a new version needs project_sponsor or kpi_author');
    if (all.some((r) => r.status === 'draft' || r.status === 'validated' || r.status === 'approved')) throw new LifecycleError('CONFLICT', 'a newer version is already in progress');
    const latest = all[all.length - 1];
    const def = { ...clone(latest.definition), version: latest.definition.version + 1 };
    return this.put(this.build({ definition: def, authoredBy: actor.id }, { basedOnVersion: latest.definition.version }, { at, by: actor.id, action: 'new_version' }));
  }
}
