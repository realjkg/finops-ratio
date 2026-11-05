// Messages and value preservation. Accept/reject coverage per contract lives in the golden corpus (corpus/*.json).
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
    const { tokenUsage: _drop, ...noUsage } = usageEvent();
    expect(_drop).toBeDefined();
    const r = validateAIUsageEvent({ ...noUsage, status: 'failed' });
    expect(r.ok && 'tokenUsage' in r.value).toBe(false);
    const profileOnly = validateAIUsageEvent({ ...usageEvent(), tokenUsage: { accountingProfile: 'provider-a-chat/1' } });
    expect(profileOnly.ok && profileOnly.value.tokenUsage).toEqual({ accountingProfile: 'provider-a-chat/1' });
  });
  it('token counts are canonical whole-token strings', () => {
    expect(problems(validateAIUsageEvent({ ...usageEvent(), tokenUsage: { input: '1.5', accountingProfile: 'p/1' } }))).toEqual(['$.tokenUsage.input: canonical non-negative integer string']);
  });
  it('names the actor mismatch and the receipt order', () => {
    expect(problems(validateAIUsageEvent({ ...usageEvent(), actorType: 'service', actorRef: HUMAN }))).toEqual(['$.actorRef: does not match actorType service']);
    expect(problems(validateAIUsageEvent({ ...usageEvent(), receivedAt: '2026-10-01T11:59:59.999Z' }))).toEqual(['$.receivedAt: before occurredAt']);
  });
});

describe('FinancialRecord, RateCard, Allocation', () => {
  it('a credit is never positive; an estimate is priced at a contract or list rate', () => {
    expect(problems(validateFinancialRecord({ ...financialRecord(), kind: 'credit', amount: '5', rateCardRef: undefined, rateBasis: 'not_applicable' }))).toEqual(['$.amount: a credit is negative or 0']);
    expect(problems(validateFinancialRecord({ ...financialRecord(), rateBasis: 'unknown' }))).toEqual(['$.rateBasis: an estimate is priced at a contract or public list rate']);
  });
  it('a rate card basis matches its provenance', () => {
    expect(problems(validateRateCard({ ...rateCard(), basis: 'contract', provenance: { ...rateCard().provenance, kind: 'public_price_page' } }))).toEqual(['$.provenance.kind: does not support a contract basis']);
  });
  it('allocation: exact sum, same sign, unique targets, pseudonymous users', () => {
    expect(validateAllocation(allocation()).ok).toBe(true);
    const a = allocation();
    expect(problems(validateAllocation({ ...a, shares: [{ ...a.shares[0], amount: '-10' }, a.shares[1]], unallocated: '80.00' }))).toEqual(['$.shares[0].amount: sign differs from sourceAmount']);
    expect(problems(validateAllocation({ ...a, shares: [a.shares[0], { ...a.shares[1], targetRef: 'wl-a' }] }))).toEqual(['$.shares[1]: duplicate target']);
    expect(problems(validateAllocation({ ...a, shares: [{ ...a.shares[0], targetKind: 'user', targetRef: 'jane.doe' }, a.shares[1]] }))).toEqual(['$.shares[0].targetRef: does not match targetKind user']);
  });
});
