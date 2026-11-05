import { describe, expect, it } from 'vitest';
import { validateAIUsageEvent, validateAllocation, validateFinancialRecord, validateRateCard } from './economics';
import { allocation, financialRecord, HUMAN, rateCard, usageEvent } from './testing/fixtures';

const problems = (r: { ok: boolean; problems?: string[] }) => (r.ok ? [] : r.problems);

describe('AIUsageEvent (cap 1, 4)', () => {
  it('accepts the synthetic event and returns it unchanged', () => {
    const e = usageEvent();
    expect(validateAIUsageEvent(e)).toEqual({ ok: true, value: e });
  });
  it('absent usage stays absent: nothing is filled with 0', () => {
    const e = { ...usageEvent(), tokenUsage: { accountingProfile: 'provider-a-chat/1' } };
    const r = validateAIUsageEvent(e);
    expect(r.ok && r.value.tokenUsage).toEqual({ accountingProfile: 'provider-a-chat/1' });
  });
  it('token counts are non-negative decimal strings, never numbers', () => {
    expect(problems(validateAIUsageEvent({ ...usageEvent(), tokenUsage: { input: 1200, accountingProfile: 'p/1' } }))).toEqual(['$.tokenUsage.input: non-negative exact decimal string']);
    expect(problems(validateAIUsageEvent({ ...usageEvent(), tokenUsage: { output: '-1', accountingProfile: 'p/1' } }))).toEqual(['$.tokenUsage.output: non-negative exact decimal string']);
  });
  it('token usage always names its accounting profile (overlap vs additive categories)', () => {
    expect(problems(validateAIUsageEvent({ ...usageEvent(), tokenUsage: { input: '1' } }))).toEqual(['$.tokenUsage.accountingProfile: missing']);
  });
  it('humans only as keyed pseudonyms; services and agents by registered id; unknown carries no ref', () => {
    expect(problems(validateAIUsageEvent({ ...usageEvent(), actorRef: 'alice@example.test' }))).toEqual(['$.actorRef: does not match actorType human']);
    expect(validateAIUsageEvent({ ...usageEvent(), actorType: 'service', actorRef: 'svc:batch-summarizer' }).ok).toBe(true);
    expect(problems(validateAIUsageEvent({ ...usageEvent(), actorType: 'service', actorRef: HUMAN }))).toEqual(['$.actorRef: does not match actorType service']);
    expect(validateAIUsageEvent({ ...usageEvent(), actorType: 'unknown', actorRef: undefined }).ok).toBe(true);
    expect(problems(validateAIUsageEvent({ ...usageEvent(), actorType: 'unknown' }))).toEqual(['$.actorRef: does not match actorType unknown']);
  });
  it('carries no prompt or response body', () => {
    for (const k of ['prompt', 'messages', 'response', 'content', 'input_messages']) {
      expect(problems(validateAIUsageEvent({ ...usageEvent(), [k]: 'x' }))).toEqual([`$.${k}: unknown key`]);
    }
  });
  it('a correction supersedes another event, never itself', () => {
    expect(validateAIUsageEvent({ ...usageEvent(), eventId: 'evt-2', supersedes: 'evt-1' }).ok).toBe(true);
    expect(problems(validateAIUsageEvent({ ...usageEvent(), supersedes: 'evt-1' }))).toEqual(['$.supersedes: an event cannot supersede itself']);
  });
  it('a retry is a separate attempt numbered from 1', () => {
    expect(validateAIUsageEvent({ ...usageEvent(), attempt: 2, dedupKey: 'req-123:2' }).ok).toBe(true);
    expect(problems(validateAIUsageEvent({ ...usageEvent(), attempt: 0 }))).toEqual(['$.attempt: positive safe integer']);
  });
});

describe('FinancialRecord', () => {
  it('accepts the synthetic estimate linked to its usage event and rate card version', () => {
    expect(validateFinancialRecord(financialRecord()).ok).toBe(true);
  });
  it('an estimate names the rate card version that priced it', () => {
    expect(problems(validateFinancialRecord({ ...financialRecord(), rateCardRef: undefined }))).toEqual(['$.rateCardRef: required for an estimated_invocation record']);
  });
  it('money is an exact decimal string with an ISO currency over a half-open period', () => {
    expect(problems(validateFinancialRecord({ ...financialRecord(), amount: 0.0042, currency: 'usd', periodEnd: '2026-10-01' }))).toEqual(['$.amount: exact decimal string', '$.currency: ISO 4217 code']);
    expect(problems(validateFinancialRecord({ ...financialRecord(), periodEnd: '2026-10-01' }))).toEqual(['$.periodEnd: must be after periodStart']);
  });
});

describe('RateCard', () => {
  it('accepts explicit cache and batch rows', () => {
    expect(validateRateCard(rateCard()).ok).toBe(true);
  });
  it('refuses duplicate rows, unit/category mismatches and an empty or reversed effective range', () => {
    const rc = rateCard();
    rc.entries.push({ ...rc.entries[0] }, { ...rc.entries[0], category: 'output', unit: 'per_unit' });
    expect(problems(validateRateCard({ ...rc, effectiveTo: '2026-10-01' }))).toEqual([
      '$.effectiveTo: must be after effectiveFrom', '$.entries[4]: duplicate model, sku, category and tier', '$.entries[5].unit: does not fit category',
    ]);
    expect(problems(validateRateCard({ ...rateCard(), entries: [] }))).toEqual(['$.entries: array of 1 to 10000 items']);
  });
  it('prices are non-negative exact decimals; no multiplier field exists', () => {
    expect(problems(validateRateCard({ ...rateCard(), entries: [{ ...rateCard().entries[0], price: '1e-6' }] }))).toEqual(['$.entries[0].price: non-negative exact decimal string']);
    expect(problems(validateRateCard({ ...rateCard(), entries: [{ ...rateCard().entries[0], multiplier: '0.5' }] }))).toEqual(['$.entries[0].multiplier: unknown key']);
  });
});

describe('Allocation (cap 1)', () => {
  it('shares plus the explicit unallocated remainder equal the source amount exactly', () => {
    expect(validateAllocation(allocation()).ok).toBe(true);
    expect(problems(validateAllocation({ ...allocation(), unallocated: '9.89' }))).toEqual(['$.unallocated: shares plus unallocated must equal sourceAmount exactly']);
  });
  it('a non-zero remainder carries reason codes; a zero remainder is still stated', () => {
    expect(problems(validateAllocation({ ...allocation(), unallocatedReasons: [] }))).toEqual(['$.unallocatedReasons: required when unallocated is not 0']);
    const full = { ...allocation(), shares: [...allocation().shares, { targetKind: 'team' as const, targetRef: 'team-x', amount: '9.90', ruleId: 'r' }], unallocated: '0.00', unallocatedReasons: [] };
    expect(validateAllocation(full).ok).toBe(true);
    expect(problems(validateAllocation({ ...full, unallocated: undefined }))).toEqual(['$.unallocated: missing']);
  });
});
