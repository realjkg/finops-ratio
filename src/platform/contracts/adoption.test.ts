import { describe, expect, it } from 'vitest';
import { validateActivityEvent, validateAdoptionDefinition, validateEligibilitySnapshot } from './adoption';
import { activityEvent, definition, snapshot } from './testing/fixtures';

const problems = (r: { ok: boolean; problems?: string[] }) => (r.ok ? [] : r.problems);

describe('ActivityEvent and EligiblePopulationSnapshot (cap 2, 3)', () => {
  it('accept the synthetic records', () => {
    expect(validateActivityEvent(activityEvent()).ok).toBe(true);
    expect(validateEligibilitySnapshot(snapshot()).ok).toBe(true);
  });
  it('an activity event never names a person directly', () => {
    expect(problems(validateActivityEvent({ ...activityEvent(), actorRef: 'Alice Example' }))).toEqual(['$.actorRef: identifier']);
    expect(problems(validateActivityEvent({ ...activityEvent(), actorRef: 'alice.example' }))).toEqual(['$.actorRef: does not match actorType human']);
  });
  it('a snapshot holds counts and a member-set hash, never a member list; missing licensed seats stay absent', () => {
    expect(problems(validateEligibilitySnapshot({ ...snapshot(), members: ['x'] }))).toEqual(['$.members: unknown key']);
    const noSeats: Partial<ReturnType<typeof snapshot>> = snapshot();
    delete noSeats.licensedSeats;
    const r = validateEligibilitySnapshot(noSeats);
    expect(r.ok && 'licensedSeats' in r.value).toBe(false);
    expect(problems(validateEligibilitySnapshot({ ...snapshot(), memberCount: -1 }))).toEqual(['$.memberCount: non-negative safe integer']);
  });
});

describe('AdoptionDefinition (cap 2)', () => {
  it('accepts a versioned human adoption rate over the eligible snapshot', () => {
    expect(validateAdoptionDefinition(definition()).ok).toBe(true);
  });
  it('human metrics count humans only; service activity never counts humans', () => {
    const d = definition();
    expect(problems(validateAdoptionDefinition({ ...d, numerator: { ...d.numerator, actorTypes: ['human', 'service'] } }))).toEqual(['$.numerator.actorTypes: human-only metric']);
    expect(problems(validateAdoptionDefinition({ ...d, metric: 'service_activity', denominator: 'none', numerator: { ...d.numerator, actorTypes: ['service', 'human'] } }))).toEqual(['$.numerator.actorTypes: service activity excludes humans']);
    expect(validateAdoptionDefinition({ ...d, metric: 'service_activity', denominator: 'none', numerator: { ...d.numerator, actorTypes: ['service', 'agent'] } }).ok).toBe(true);
  });
  it('each metric uses only its denominator', () => {
    expect(problems(validateAdoptionDefinition({ ...definition(), denominator: 'none' }))).toEqual(['$.denominator: not valid for adoption_rate']);
    expect(problems(validateAdoptionDefinition({ ...definition(), metric: 'seat_utilization' }))).toEqual(['$.denominator: not valid for seat_utilization']);
    expect(validateAdoptionDefinition({ ...definition(), metric: 'seat_utilization', denominator: 'licensed_seats' }).ok).toBe(true);
  });
  it('is effective-dated', () => {
    expect(problems(validateAdoptionDefinition({ ...definition(), effectiveTo: '2026-09-30' }))).toEqual(['$.effectiveTo: must be after effectiveFrom']);
  });
});
