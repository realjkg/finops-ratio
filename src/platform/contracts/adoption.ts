// Adoption and utilization contracts (ADR-0001 §4.2, Stream B). Activity is not productivity or value. Humans appear
// only as tenant-keyed pseudonyms; services and agents are counted separately and never in a human denominator.
import { arr, C, checkActor, instantBefore, literal, obj, oneOf, opt, req, set, validator, ACTOR_TYPES, type ActorType } from './validate';

/** One qualifying-activity observation from an activity source (append-only; corrections via `supersedes`). */
export interface ActivityEvent {
  schemaVersion: 'activity-event/1';
  eventId: string; tenantId: string; sourceConnectionId: string; dedupKey: string; supersedes?: string;
  occurredAt: string; receivedAt: string;
  actorRef?: string; actorType: ActorType;
  /** A source-defined activity id (e.g. `chat.message_sent`) that adoption definitions select. */
  activityKind: string;
  workloadId?: string; sessionRef?: string;
  evidenceRef: string;
}

export const validateActivityEvent = validator<ActivityEvent>(obj({
  schemaVersion: req(literal('activity-event/1')), eventId: req(C.id), tenantId: req(C.id), sourceConnectionId: req(C.id), dedupKey: req(C.id),
  supersedes: opt(C.id), occurredAt: req(C.instant), receivedAt: req(C.instant), actorRef: opt(C.id), actorType: req(oneOf(ACTOR_TYPES)),
  activityKind: req(C.id), workloadId: opt(C.id), sessionRef: opt(C.id), evidenceRef: req(C.id),
} satisfies { [K in keyof Required<ActivityEvent>]: unknown }), {
  'actor-ref@1': (e, p) => checkActor(e.actorType, e.actorRef, p),
  'no-self-supersede@1': (e, p) => { if (e.supersedes === e.eventId) p.push('$.supersedes: an event cannot supersede itself'); },
  'received-after-occurred@1': (e, p) => { if (instantBefore(e.receivedAt, e.occurredAt)) p.push('$.receivedAt: before occurredAt'); },
});

/** Who was eligible on one effective date, from one identity source. Members are held elsewhere as pseudonyms. */
export interface EligiblePopulationSnapshot {
  schemaVersion: 'eligibility-snapshot/1';
  snapshotId: string; tenantId: string; sourceConnectionId: string;
  effectiveDate: string; takenAt: string;
  population: 'human' | 'service';
  memberCount: number;
  /** sha256 over the sorted pseudonymous member refs: the denominator is reproducible without listing people. */
  memberSetSha256: string;
  exclusions: { reasonCode: string; count: number }[];
  /** Licensed seats from a license source, when one exists; absent means unavailable, never 0. Humans only. */
  licensedSeats?: number;
  evidenceRef: string;
}

export const validateEligibilitySnapshot = validator<EligiblePopulationSnapshot>(obj({
  schemaVersion: req(literal('eligibility-snapshot/1')), snapshotId: req(C.id), tenantId: req(C.id), sourceConnectionId: req(C.id),
  effectiveDate: req(C.date), takenAt: req(C.instant), population: req(oneOf(['human', 'service'])), memberCount: req(C.count),
  memberSetSha256: req(C.sha256), exclusions: req(arr(obj({ reasonCode: req(C.reason), count: req(C.count) }))),
  licensedSeats: opt(C.count), evidenceRef: req(C.id),
} satisfies { [K in keyof Required<EligiblePopulationSnapshot>]: unknown }), {
  'seats-human-only@1': (s, p) => { if (s.population === 'service' && s.licensedSeats !== undefined) p.push('$.licensedSeats: only for a human population'); },
});

export const ADOPTION_METRICS = ['adoption_rate', 'seat_utilization', 'activity_frequency', 'workload_utilization', 'service_activity'] as const;
export type AdoptionMetric = (typeof ADOPTION_METRICS)[number];
export const DENOMINATORS = ['eligible_snapshot', 'licensed_seats', 'none'] as const;
/** Which denominator each metric may use; a missing denominator is reported as unavailable, never as 0 or 100%. */
export const METRIC_DENOMINATORS: Record<AdoptionMetric, readonly (typeof DENOMINATORS)[number][]> = {
  adoption_rate: ['eligible_snapshot'], seat_utilization: ['licensed_seats'], activity_frequency: ['none'],
  workload_utilization: ['none'], service_activity: ['none'],
};

/** A versioned, effective-dated definition: the same version over the same events gives the same number. */
export interface AdoptionDefinition {
  schemaVersion: 'adoption-definition/1';
  definitionId: string; version: number; tenantId: string;
  metric: AdoptionMetric;
  periodGrain: 'day' | 'week' | 'month' | 'quarter';
  effectiveFrom: string; effectiveTo?: string;
  numerator: { activityKinds: string[]; minEventsPerActor: number; actorTypes: ActorType[] };
  denominator: (typeof DENOMINATORS)[number];
  /** Which snapshot in the period is the denominator. */
  snapshotRule: 'period_start' | 'period_end';
  exclusions: string[];
}

export const validateAdoptionDefinition = validator<AdoptionDefinition>(obj({
  schemaVersion: req(literal('adoption-definition/1')), definitionId: req(C.id), version: req(C.positive), tenantId: req(C.id),
  metric: req(oneOf(ADOPTION_METRICS)), periodGrain: req(oneOf(['day', 'week', 'month', 'quarter'])), effectiveFrom: req(C.date), effectiveTo: opt(C.date),
  numerator: req(obj({ activityKinds: req(set(C.id, 1)), minEventsPerActor: req(C.positive), actorTypes: req(set(oneOf(ACTOR_TYPES), 1, 4)) })),
  denominator: req(oneOf(DENOMINATORS)), snapshotRule: req(oneOf(['period_start', 'period_end'])), exclusions: req(set(C.reason)),
} satisfies { [K in keyof Required<AdoptionDefinition>]: unknown }), { 'definition-rules@1': definitionRules });

function definitionRules(d: AdoptionDefinition, p: string[]) {
  const t = d.numerator.actorTypes;
  if (d.metric === 'service_activity' ? t.some((x) => x !== 'service' && x !== 'agent') : t.length !== 1 || t[0] !== 'human') {
    p.push(d.metric === 'service_activity' ? '$.numerator.actorTypes: service activity counts services and agents only' : '$.numerator.actorTypes: human-only metric');
  }
  if (!METRIC_DENOMINATORS[d.metric].includes(d.denominator)) p.push(`$.denominator: not valid for ${d.metric}`);
  if (d.effectiveTo !== undefined && d.effectiveTo <= d.effectiveFrom) p.push('$.effectiveTo: must be after effectiveFrom');
}
