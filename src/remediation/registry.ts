// Action registry: what remediation actions exist, how risky they are, whether they can be
// undone, and which of them may EVER run without a human. Trust boundary: the registry is
// code, not tenant data. A tenant policy can enable a class only if the registry marks it
// autonomy-eligible, and eligibility is structural:
//
//   eligible  =>  risk is low  AND  reversible  AND  impact is not 'commitment'
//
// This holds at three layers: the ActionDefinition type (a violating literal does not
// compile), buildRegistry (throws at startup, and ACTION_REGISTRY is built when this module
// loads), and decide() (re-checks on every decision). Commitment purchases are therefore
// always human-approved.
import {
  RISK_TIERS, CHANGE_IMPACTS, LIMITS,
  type ChangeImpact, type RiskTier,
} from './types';
import { freezeSchema, type ParamSchema } from './schema';

interface ActionBase {
  readonly id: string;
  /** The unit a tenant policy enables, the circuit breaker trips, and the window caps count. */
  readonly class: string;
  readonly title: string;
  readonly params: ParamSchema;
  /** Hard ceiling on resources per proposal for this action; a proposal over it is refused outright. */
  readonly hardMaxResources: number;
  /** The resources a validated parameter set touches. Derived, so the blast radius cannot be understated. */
  readonly resources: (params: Readonly<Record<string, unknown>>) => readonly string[];
  /** Optional cross-field validity check on already-validated params. */
  readonly check?: (params: Readonly<Record<string, unknown>>) => boolean;
}

/** `autonomyEligible: true` type-checks only for a low-risk, reversible, non-commitment action. */
type AutonomyShape =
  | {
      readonly risk: 'low';
      readonly reversible: true;
      readonly impact: 'cost' | 'operational';
      readonly autonomyEligible: boolean;
    }
  | {
      readonly risk: RiskTier;
      readonly reversible: boolean;
      readonly impact: ChangeImpact;
      readonly autonomyEligible: false;
    };

export type ActionDefinition = ActionBase & AutonomyShape;

export type RegistryErrorCode =
  | 'EMPTY' | 'TOO_MANY' | 'BAD_ID' | 'DUPLICATE_ID' | 'BAD_CLASS' | 'BAD_SHAPE' | 'BAD_LIMIT' | 'BAD_SCHEMA'
  | 'INELIGIBLE_AUTONOMY' | 'COMMITMENT_AUTONOMY' | 'CLASS_MIXED';

export class RegistryInvariantError extends Error {
  constructor(readonly code: RegistryErrorCode) {
    super('Action registry invariant violated');
    this.name = 'RegistryInvariantError';
  }
}

export interface ActionRegistry {
  /** Lookup by id; a non-string or prototype key never matches. */
  get(id: unknown): ActionDefinition | undefined;
  ids(): readonly string[];
  classes(): readonly string[];
  /** True only if the class exists and every action in it is autonomy-eligible. */
  isClassEligible(cls: unknown): boolean;
  /** The largest hardMaxResources among the actions of a class, or 0 for an unknown class. */
  classHardMax(cls: unknown): number;
}

const ID = /^[a-z][a-z0-9_]{1,47}$/;

/** Validate and freeze a set of definitions. Throws RegistryInvariantError, with fixed text, on any violation. */
export function buildRegistry(defs: readonly ActionDefinition[]): ActionRegistry {
  if (!Array.isArray(defs) || defs.length === 0) throw new RegistryInvariantError('EMPTY');
  if (defs.length > LIMITS.maxRegistryActions) throw new RegistryInvariantError('TOO_MANY');
  const byId = new Map<string, ActionDefinition>();
  const eligibleByClass = new Map<string, boolean>();
  const hardMaxByClass = new Map<string, number>();
  for (const raw of defs) {
    const d = raw as unknown as Record<string, unknown>;
    if (typeof d.id !== 'string' || !ID.test(d.id)) throw new RegistryInvariantError('BAD_ID');
    if (byId.has(d.id)) throw new RegistryInvariantError('DUPLICATE_ID');
    if (typeof d.class !== 'string' || !ID.test(d.class)) throw new RegistryInvariantError('BAD_CLASS');
    if (typeof d.title !== 'string' || d.title.length === 0 || d.title.length > 80) throw new RegistryInvariantError('BAD_SHAPE');
    if (!RISK_TIERS.includes(d.risk as RiskTier) || !CHANGE_IMPACTS.includes(d.impact as ChangeImpact) ||
        typeof d.reversible !== 'boolean' || typeof d.autonomyEligible !== 'boolean' ||
        typeof d.resources !== 'function' || (d.check !== undefined && typeof d.check !== 'function')) {
      throw new RegistryInvariantError('BAD_SHAPE');
    }
    if (!Number.isSafeInteger(d.hardMaxResources) || (d.hardMaxResources as number) < 1 || (d.hardMaxResources as number) > LIMITS.maxResourcesHard) {
      throw new RegistryInvariantError('BAD_LIMIT');
    }
    let params: ParamSchema;
    try {
      params = freezeSchema(d.params);
    } catch {
      throw new RegistryInvariantError('BAD_SCHEMA');
    }
    // The structural invariant, enforced at startup even if the type was bypassed.
    if (d.autonomyEligible) {
      if (d.impact === 'commitment') throw new RegistryInvariantError('COMMITMENT_AUTONOMY');
      if (d.risk !== 'low' || d.reversible !== true) throw new RegistryInvariantError('INELIGIBLE_AUTONOMY');
    }
    // A class is the unit a tenant enables, so all of its actions must agree on eligibility.
    const prior = eligibleByClass.get(d.class);
    if (prior !== undefined && prior !== d.autonomyEligible) throw new RegistryInvariantError('CLASS_MIXED');
    eligibleByClass.set(d.class, d.autonomyEligible);
    hardMaxByClass.set(d.class, Math.max(hardMaxByClass.get(d.class) ?? 0, d.hardMaxResources as number));
    byId.set(d.id, Object.freeze({ ...(raw as ActionDefinition), params }) as ActionDefinition);
  }
  const ids = Object.freeze([...byId.keys()]);
  const classes = Object.freeze([...eligibleByClass.keys()]);
  return Object.freeze({
    get: (id: unknown) => (typeof id === 'string' ? byId.get(id) : undefined),
    ids: () => ids,
    classes: () => classes,
    isClassEligible: (cls: unknown) => typeof cls === 'string' && eligibleByClass.get(cls) === true,
    classHardMax: (cls: unknown) => (typeof cls === 'string' ? hardMaxByClass.get(cls) ?? 0 : 0),
  });
}

// ---------------------------------------------------------------------------
// Seed actions (illustrative classes; the owner decides what ships)
// ---------------------------------------------------------------------------

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SIZE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ids = (key: string) => (p: Readonly<Record<string, unknown>>): readonly string[] => p[key] as readonly string[];
const idList = (maxItems: number) => ({ kind: 'idList', maxItems, itemMaxLen: 128, itemPattern: RESOURCE_ID }) as const;

const SEED: readonly ActionDefinition[] = [
  {
    id: 'stop_idle_dev_instance', class: 'idle_stop', title: 'Stop idle development instances',
    risk: 'low', reversible: true, impact: 'operational', autonomyEligible: true, // a stopped instance can be started again
    params: { instanceIds: idList(20), idleDays: { kind: 'int', min: 1, max: 365 } },
    hardMaxResources: 20, resources: ids('instanceIds'),
  },
  {
    id: 'schedule_on_off', class: 'schedule', title: 'Apply an on/off schedule',
    risk: 'low', reversible: true, impact: 'cost', autonomyEligible: true, // removing the schedule restores the prior state
    params: {
      resourceIds: idList(20), onHourUtc: { kind: 'int', min: 0, max: 23 }, offHourUtc: { kind: 'int', min: 0, max: 23 },
      weekdaysOnly: { kind: 'bool' },
    },
    hardMaxResources: 20, resources: ids('resourceIds'), check: (p) => p.onHourUtc !== p.offHourUtc,
  },
  {
    id: 'resize_down', class: 'rightsize', title: 'Resize a resource to a smaller size',
    risk: 'medium', reversible: true, impact: 'cost', autonomyEligible: false, // reversible, but restarts and changes performance
    params: {
      resourceId: { kind: 'string', maxLen: 128, pattern: RESOURCE_ID },
      fromSize: { kind: 'string', maxLen: 32, pattern: SIZE }, toSize: { kind: 'string', maxLen: 32, pattern: SIZE },
    },
    hardMaxResources: 1, resources: (p) => [p.resourceId as string], check: (p) => p.fromSize !== p.toSize,
  },
  {
    id: 'delete_unattached_volume', class: 'orphan_cleanup', title: 'Delete unattached volumes',
    risk: 'medium', reversible: false, impact: 'operational', autonomyEligible: false, // deletion loses data: irreversible
    params: { volumeIds: idList(25), unattachedDays: { kind: 'int', min: 1, max: 365 } },
    hardMaxResources: 25, resources: ids('volumeIds'),
  },
  {
    id: 'buy_commitment', class: 'commitment', title: 'Purchase a spend commitment',
    risk: 'high', reversible: false, impact: 'commitment', autonomyEligible: false, // always human-approved
    params: {
      scopeId: { kind: 'string', maxLen: 128, pattern: RESOURCE_ID },
      commitmentKind: { kind: 'enum', values: ['compute_savings_plan', 'reserved_instance'] },
      term: { kind: 'enum', values: ['1y', '3y'] },
      payment: { kind: 'enum', values: ['no_upfront', 'partial_upfront', 'all_upfront'] },
      monthlyCommitMinor: { kind: 'int', min: 1, max: 1_000_000_000_000 },
    },
    hardMaxResources: 1, resources: (p) => [p.scopeId as string],
  },
];

export const SEED_ACTIONS: readonly ActionDefinition[] = Object.freeze([...SEED]);

/** The default registry. Built at module load, so a violated invariant fails startup, not a request. */
export const ACTION_REGISTRY: ActionRegistry = buildRegistry(SEED_ACTIONS);
