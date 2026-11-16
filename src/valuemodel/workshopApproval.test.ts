import { describe, expect, it } from 'vitest';
import { type WorkshopReview, type WorkshopSignoff, workshopReviewBlockers } from './workshopApproval';

const scope = { workshopId: 'workshop-1', revision: 1, digest: 'digest-1' };
const signoff = (by: string, role: WorkshopSignoff['role']): WorkshopSignoff => ({ ...scope, by, role });
const review = (signoffs: WorkshopSignoff[], financial = true): WorkshopReview => ({
  scope, authors: ['author'], financial, hasUnresolvedBlockers: false, signoffs,
});

describe('workshop review readiness', () => {
  it('requires sponsor acceptance and independent KPI and Finance approvals for financial cases', () => {
    expect(workshopReviewBlockers(review([]))).toEqual([
      'sponsor_signoff_required', 'independent_kpi_approval_required', 'distinct_finance_approval_required',
    ]);
    expect(workshopReviewBlockers(review([
      signoff('author', 'sponsor'), signoff('reviewer', 'kpi_approver'), signoff('finance', 'finance_approver'),
    ]))).toEqual([]);
  });

  it('does not allow the author or one dual-role person to satisfy both approvals', () => {
    expect(workshopReviewBlockers(review([
      signoff('author', 'sponsor'), signoff('author', 'kpi_approver'), signoff('author', 'finance_approver'),
    ]))).toEqual(['independent_kpi_approval_required', 'distinct_finance_approval_required']);
    expect(workshopReviewBlockers(review([
      signoff('author', 'sponsor'), signoff('reviewer', 'kpi_approver'), signoff('reviewer', 'finance_approver'),
    ]))).toEqual(['distinct_finance_approval_required']);
  });

  it('does not allow any material author to approve', () => {
    expect(workshopReviewBlockers({
      ...review([signoff('author', 'sponsor'), signoff('coauthor', 'kpi_approver'), signoff('finance', 'finance_approver')]),
      authors: ['author', 'coauthor'],
    })).toEqual(['independent_kpi_approval_required', 'distinct_finance_approval_required']);
  });

  it('accepts a distinct pair even when one approver has both responsibilities', () => {
    expect(workshopReviewBlockers(review([
      signoff('sponsor', 'sponsor'), signoff('reviewer', 'kpi_approver'),
      signoff('reviewer', 'finance_approver'), signoff('finance', 'finance_approver'),
    ]))).toEqual([]);
  });

  it('requires only an independent KPI approval for nonfinancial cases', () => {
    expect(workshopReviewBlockers(review([
      signoff('author', 'sponsor'), signoff('reviewer', 'kpi_approver'),
    ], false))).toEqual([]);
  });

  it('rejects signoffs from another workshop, revision, or digest and blocks unresolved comments', () => {
    const r = review([
      { ...signoff('sponsor', 'sponsor'), workshopId: 'other' },
      { ...signoff('reviewer', 'kpi_approver'), revision: 2 },
      { ...signoff('finance', 'finance_approver'), digest: 'other' },
    ]);
    expect(workshopReviewBlockers({ ...r, hasUnresolvedBlockers: true })).toEqual([
      'unresolved_comments', 'sponsor_signoff_required', 'independent_kpi_approval_required',
      'distinct_finance_approval_required',
    ]);
  });

  it('fails closed on invalid scope and blank identities', () => {
    expect(workshopReviewBlockers({ ...review([]), scope: { ...scope, revision: 0 } })).toEqual(['invalid_scope']);
    expect(workshopReviewBlockers({ ...review([]), authors: [' '] })).toEqual(['invalid_scope']);
    expect(workshopReviewBlockers({ ...review([]), authors: [] })).toEqual(['invalid_scope']);
    expect(workshopReviewBlockers(review([
      signoff(' ', 'sponsor'), signoff('', 'kpi_approver'), signoff('', 'finance_approver'),
    ]))).toHaveLength(3);
  });
});
