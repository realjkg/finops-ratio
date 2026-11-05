// Messages and value preservation. Accept/reject coverage per contract lives in the golden corpus (corpus/*.json).
import { describe, expect, it } from 'vitest';
import { validateActivityEvent, validateAdoptionDefinition, validateEligibilitySnapshot } from './adoption';
import { activityEvent, definition, snapshot } from './testing/fixtures';

const problems = (r: { ok: boolean; problems?: string[] }) => (r.ok ? [] : r.problems);

describe('ActivityEvent and EligiblePopulationSnapshot (cap 2, 3)', () => {
  it('accept the synthetic records', () => {
    expect(validateActivityEvent(activityEvent()).ok).toBe(true);
    expect(validateEligibilitySnapshot(snapshot()).ok).toBe(true);
  });
  it('missing licensed seats stay absent; services never carry seats', () => {
    const noSeats: Partial<ReturnType<typeof snapshot>> = snapshot();
    delete noSeats.licensedSeats;
    const r = validateEligibilitySnapshot(noSeats);
    expect(r.ok && 'licensedSeats' in r.value).toBe(false);
    expect(problems(validateEligibilitySnapshot({ ...snapshot(), population: 'service' }))).toEqual(['$.licensedSeats: only for a human population']);
  });
});

describe('AdoptionDefinition (cap 2)', () => {
  it('names the actor and denominator rules', () => {
    const d = definition();
    expect(problems(validateAdoptionDefinition({ ...d, numerator: { ...d.numerator, actorTypes: ['human', 'service'] } }))).toEqual(['$.numerator.actorTypes: human-only metric']);
    expect(problems(validateAdoptionDefinition({ ...d, metric: 'service_activity', denominator: 'none', numerator: { ...d.numerator, actorTypes: ['unknown'] } }))).toEqual(['$.numerator.actorTypes: service activity counts services and agents only']);
    expect(problems(validateAdoptionDefinition({ ...d, denominator: 'none' }))).toEqual(['$.denominator: not valid for adoption_rate']);
  });
});
