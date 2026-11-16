// This pure readiness check is not an authorization service. Its caller must load
// authenticated, currently authorized participants and approvals from trusted storage.
export type WorkshopSignoffRole = 'sponsor' | 'kpi_approver' | 'finance_approver';

export interface WorkshopReviewScope {
  workshopId: string;
  revision: number;
  digest: string;
}

export interface WorkshopSignoff extends WorkshopReviewScope {
  by: string;
  role: WorkshopSignoffRole;
}

export interface WorkshopReview {
  scope: WorkshopReviewScope;
  authors: readonly string[];
  financial: boolean;
  hasUnresolvedBlockers: boolean;
  signoffs: readonly WorkshopSignoff[];
}

export type WorkshopReviewBlocker =
  | 'invalid_scope'
  | 'unresolved_comments'
  | 'sponsor_signoff_required'
  | 'independent_kpi_approval_required'
  | 'distinct_finance_approval_required';

export function workshopReviewBlockers(review: WorkshopReview): WorkshopReviewBlocker[] {
  const { scope } = review;
  if (!scope.workshopId.trim() || !scope.digest.trim() || review.authors.length === 0
    || review.authors.some((author) => !author.trim())
    || !Number.isSafeInteger(scope.revision) || scope.revision < 1) return ['invalid_scope'];

  const current = review.signoffs.filter((signoff) =>
    signoff.workshopId === scope.workshopId
    && signoff.revision === scope.revision
    && signoff.digest === scope.digest
    && signoff.by.trim().length > 0,
  );
  const kpiApprovers = current.filter((s) => s.role === 'kpi_approver' && !review.authors.includes(s.by));
  const financeApprovers = current.filter((s) => s.role === 'finance_approver' && !review.authors.includes(s.by));
  const blockers: WorkshopReviewBlocker[] = [];
  if (review.hasUnresolvedBlockers) blockers.push('unresolved_comments');
  if (!current.some((s) => s.role === 'sponsor')) blockers.push('sponsor_signoff_required');
  if (kpiApprovers.length === 0) blockers.push('independent_kpi_approval_required');
  if (review.financial && !kpiApprovers.some((kpi) => financeApprovers.some((finance) => finance.by !== kpi.by))) {
    blockers.push('distinct_finance_approval_required');
  }
  return blockers;
}
