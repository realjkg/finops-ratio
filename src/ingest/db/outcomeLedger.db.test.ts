// Durable outcome ledger (D3) integration tests. Every test file gets its own
// freshly created, migrated database (the harness), seeded with the shared
// two-tenant fixture — which includes one approved outcome-unit registration,
// two classified events on the published batch, one unverified measured
// financial claim and one supplemental cost per tenant. The suite verifies the
// governance the migration enforces (registry lifecycle, evidence shapes,
// tenant scoping), the published read path, and that durable rows feed the
// pure rules of `src/outcomes/durable.ts` — including the R4 line: an
// unvalidated benefit can never produce a value-to-cost ratio.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { attempt, createTestDatabase, withRole, type TestDatabase } from './testing/harness';
import { artifactSha, seedTwoTenants, type Seeded } from './testing/fixtures';
import { evaluateBenefit, evaluateCost, successfulOutcomeCount, valueToCostRatio, type BenefitClaimRow, type SupplementalCostRow } from '@/outcomes/durable';

let db: TestDatabase;
let seed: Seeded;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  seed = await seedTwoTenants(db.pool);
});

afterAll(async () => {
  await db?.close();
});

/** Either a pooled client (role-scoped transactions) or the pool itself (superuser plumbing). */
type Queryable = Pool | PoolClient;

type PendingOver = {
  tenantId: string;
  id: string;
  projectId: string;
  status?: string;
  requestedBy?: string;
  thresholds?: { stopBelow: number; continueAt: number; expandAt: number };
};

/** The only INSERT the lifecycle trigger allows: a pending registration. */
const PENDING_INSERT_SQL = `INSERT INTO ratio.outcome_unit_registrations (tenant_id, id, project_id, use_case_pattern, outcome_unit_key, outcome_unit_label, metric, unit, direction, target, baseline, observation, quality_metric, quality_direction, quality_threshold, stop_below, continue_at, expand_at, status, requested_by)
     VALUES ($1, $2, $3, 'support_assistant', 'resolved_ticket', 'Resolved tickets', 'resolution_quality', 'quality_result',
             'higher', 15, $4, $5, 'resolution_quality', 'higher', 0.9, $6, $7, $8, $9, $10)`;

function pendingInsertParams(over: PendingOver): unknown[] {
  const t = over.thresholds ?? { stopBelow: 0.5, continueAt: 1, expandAt: 3 };
  return [
    over.tenantId,
    over.id,
    over.projectId,
    JSON.stringify({ start: '2026-07-01', end: '2026-07-31', value: 12.5 }),
    JSON.stringify({ start: '2026-08-01', end: '2026-08-31', value: 15 }),
    t.stopBelow,
    t.continueAt,
    t.expandAt,
    over.status ?? 'pending',
    over.requestedBy ?? 'reg-requester',
  ];
}

/** Inserts a pending registration. Tests that need to observe a refusal run PENDING_INSERT_SQL through `attempt` instead. */
async function insertPending(c: Queryable, over: PendingOver): Promise<void> {
  await c.query(PENDING_INSERT_SQL, pendingInsertParams(over));
}

/** Approves a pending registration as a different identity. */
const approve = (c: Queryable, tenantId: string, id: string, approvedBy: string) =>
  c.query(`UPDATE ratio.outcome_unit_registrations SET status = 'approved', approved_by = $3, approved_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, id, approvedBy]);

const newId = (n: number, prefix = 'cccccccc'): string => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('outcome-unit registry governance', () => {
  it('refuses a directly-approved insert — approval is a transition, not a state', async () => {
    await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
      const r = await attempt(c, `SELECT 1`, []);
      expect(r.ok).toBe(true);
      const direct = await attempt(
        c,
        `INSERT INTO ratio.outcome_unit_registrations (tenant_id, id, project_id, use_case_pattern, outcome_unit_key, outcome_unit_label, metric, unit, direction, target, baseline, observation, quality_metric, quality_direction, quality_threshold, stop_below, continue_at, expand_at, status, requested_by)
         VALUES ($1, $2, 'governed-project', 'support_assistant', 'resolved_ticket', 'Resolved tickets', 'resolution_quality', 'quality_result',
                 'higher', 15, $3, $4, 'resolution_quality', 'higher', 0.9, 0.5, 1, 3, 'approved', 'reg-requester')`,
        [
          seed.a.tenantId,
          newId(1),
          JSON.stringify({ start: '2026-07-01', end: '2026-07-31', value: 12.5 }),
          JSON.stringify({ start: '2026-08-01', end: '2026-08-31', value: 15 }),
        ],
      );
      expect(direct.ok).toBe(false);
    });
  });

  it('requires a separate approver and records both identities', async () => {
    await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
      const id = newId(2);
      await insertPending(c, { tenantId: seed.a.tenantId, id, projectId: 'governed-project-2' });
      // Same identity approves own request: refused (requester ≠ approver).
      const bad = await attempt(c, `UPDATE ratio.outcome_unit_registrations SET status = 'approved', approved_by = $3, approved_at = now() WHERE tenant_id = $1 AND id = $2`, [
        seed.a.tenantId,
        id,
        'reg-requester',
      ]);
      expect(bad.ok).toBe(false);
      // Approval without a timestamp: refused (approved rows must carry the act).
      const noTime = await attempt(c, `UPDATE ratio.outcome_unit_registrations SET status = 'approved', approved_by = $3 WHERE tenant_id = $1 AND id = $2`, [seed.a.tenantId, id, 'reg-approver']);
      expect(noTime.ok).toBe(false);
      await approve(c, seed.a.tenantId, id, 'reg-approver');
      const row = await c.query(`SELECT requested_by, approved_by, approved_at FROM ratio.outcome_unit_registrations WHERE tenant_id = $1 AND id = $2`, [seed.a.tenantId, id]);
      expect(row.rows[0]).toMatchObject({ requested_by: 'reg-requester', approved_by: 'reg-approver' });
      expect(row.rows[0].approved_at).not.toBeNull();
    });
  });

  it('keeps exactly one approved registration per tenant and project, superseding the incumbent', async () => {
    const c = db.pool; // superuser (bypasses RLS) — registry plumbing under test, tenancy is tested separately
    const second = newId(3);
    await insertPending(c, { tenantId: seed.a.tenantId, id: second, projectId: 'fixture-support-copilot' });
    await approve(c, seed.a.tenantId, second, 'reg-approver-2');
    const rows = await c.query(`SELECT id, status FROM ratio.outcome_unit_registrations WHERE tenant_id = $1 AND project_id = 'fixture-support-copilot' ORDER BY status`, [seed.a.tenantId]);
    // The incumbent was demoted to superseded by the lifecycle trigger; only
    // the challenger holds the approved slot.
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.filter((r) => r.status === 'approved')).toEqual([{ id: second, status: 'approved' }]);
    expect(rows.rows.find((r) => r.id === seed.a.outcomeRegistryId)?.status).toBe('superseded');
  });

  it('enforces the ordered threshold ladder and same-duration comparison periods as data shapes', async () => {
    await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
      const unordered = await attempt(c, `SELECT 1`, []);
      expect(unordered.ok).toBe(true);
      let refusal: { ok: false; code: string; message: string } | null = null;
      const ladder = await attempt(
        c,
        PENDING_INSERT_SQL,
        pendingInsertParams({ tenantId: seed.a.tenantId, id: newId(6), projectId: 'bad-ladder', thresholds: { stopBelow: 1, continueAt: 0.5, expandAt: 3 } }),
      );
      if (!ladder.ok) refusal = ladder;
      expect(refusal).not.toBeNull(); // stop_below < continue_at < expand_at is data, not convention
      const invertedPeriod = await attempt(
        c,
        `INSERT INTO ratio.outcome_unit_registrations (tenant_id, id, project_id, use_case_pattern, outcome_unit_key, outcome_unit_label, metric, unit, direction, target, baseline, observation, quality_metric, quality_direction, quality_threshold, stop_below, continue_at, expand_at, status, requested_by)
         VALUES ($1, $2, 'bad-periods', 'support_assistant', 'resolved_ticket', 'Resolved tickets', 'resolution_quality', 'quality_result',
                 'higher', 15, $3, $4, 'resolution_quality', 'higher', 0.9, 0.5, 1, 3, 'pending', 'reg-requester')`,
        [
          seed.a.tenantId,
          newId(7),
          JSON.stringify({ start: '2026-08-01', end: '2026-07-01', value: 12.5 }), // end before start
          JSON.stringify({ start: '2026-08-01', end: '2026-08-31', value: 15 }),
        ],
      );
      expect(invertedPeriod.ok).toBe(false);
      const overlapping = await attempt(
        c,
        `INSERT INTO ratio.outcome_unit_registrations (tenant_id, id, project_id, use_case_pattern, outcome_unit_key, outcome_unit_label, metric, unit, direction, target, baseline, observation, quality_metric, quality_direction, quality_threshold, stop_below, continue_at, expand_at, status, requested_by)
         VALUES ($1, $2, 'bad-periods', 'support_assistant', 'resolved_ticket', 'Resolved tickets', 'resolution_quality', 'quality_result',
                 'higher', 15, $3, $4, 'resolution_quality', 'higher', 0.9, 0.5, 1, 3, 'pending', 'reg-requester')`,
        [
          seed.a.tenantId,
          newId(8),
          JSON.stringify({ start: '2026-07-01', end: '2026-08-15', value: 12.5 }), // overlaps observation
          JSON.stringify({ start: '2026-08-01', end: '2026-08-31', value: 15 }),
        ],
      );
      expect(overlapping.ok).toBe(false);
    });
  });
});

describe('outcome events join batch provenance and project identity', () => {
  it('seeded events sit on the published batch with artifact provenance and the approved registration', async () => {
    const rows = await db.pool.query(
      `SELECT e.trace_id, e.outcome_status, e.quality_result, e.registry_id, r.project_id, r.status AS registry_status
       FROM ratio.outcome_events e JOIN ratio.outcome_unit_registrations r ON r.tenant_id = e.tenant_id AND r.id = e.registry_id
       WHERE e.tenant_id = $1 ORDER BY e.trace_id`,
      [seed.a.tenantId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ trace_id: 'tenant-a-trace-1', outcome_status: 'successful', project_id: 'fixture-support-copilot' });
    expect(Number(rows.rows[0].quality_result)).toBeCloseTo(0.97, 6);
    expect(rows.rows[1]).toMatchObject({ trace_id: 'tenant-a-trace-2', outcome_status: 'failed', project_id: 'fixture-support-copilot' });
    expect(Number(rows.rows[1].quality_result)).toBeCloseTo(0.55, 6);
  });

  it('refuses duplicate trace identity within a batch (re-ingest never double counts)', async () => {
    await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
      // The seeded traces live on the published batch, whose events are no
      // longer writable; dedup is exercised on the staged batch, where the
      // same trace inserted twice must refuse the second row.
      const sha = artifactSha('tenant-a', seed.a.batchStaged);
      const insert = (ordinal: number) =>
        attempt(
          c,
          `INSERT INTO ratio.outcome_events
         (tenant_id, source_id, batch_id, artifact_sha256, row_ordinal, billing_period, project_id, registry_id, trace_id, agent_run_id, request_id,
          outcome_type, outcome_status, quality_result, completion_latency, validated_benefit, benefit_validation_status, currency, allocation_method, data_as_of, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'fixture-support-copilot', $7, 'tenant-a-trace-1', 'run', 'req',
               'resolved_ticket', 'successful', 0.97, 1000, NULL, 'unvalidated', 'USD', 'direct', '2026-08-05T12:00:00Z', '2026-08-05T12:00:00Z')`,
          [seed.a.tenantId, seed.a.sourceId, seed.a.batchStaged, sha, ordinal, seed.a.period, seed.a.outcomeRegistryId],
        );
      const first = await insert(310);
      expect(first.ok).toBe(true); // the trace is new to this batch
      const dupe = await insert(311); // the same trace identity again
      expect(dupe.ok).toBe(false);
      if (!dupe.ok) expect(dupe.code).toBe('23505');
    });
  });

  it('enforces contract-v1 evidence shapes: quality on success, benefit buckets, allocation bounds, period month', async () => {
    await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
    // The batch-child guard only accepts event writes on a staged batch.
    const sha = artifactSha('tenant-a', seed.a.batchStaged);
    const insert = (over: { ordinal: number; traceId: string; status: string; quality: number | null; validated: string | null; kind: string; allocation: string; occurred: string }) =>
      attempt(
        c,
        `INSERT INTO ratio.outcome_events
           (tenant_id, source_id, batch_id, artifact_sha256, row_ordinal, billing_period, project_id, registry_id, trace_id, agent_run_id, request_id,
            outcome_type, outcome_status, quality_result, completion_latency, validated_benefit, benefit_validation_status, currency, allocation_method, data_as_of, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,'fixture-support-copilot',$7,$8,'run','req','resolved_ticket',$9,$10,1000,$11,$12,'USD',$13,'2026-08-05T12:00:00Z',$14)`,
        [seed.a.tenantId, seed.a.sourceId, seed.a.batchStaged, sha, over.ordinal, seed.a.period, seed.a.outcomeRegistryId, over.traceId, over.status, over.quality, over.validated, over.kind, over.allocation, over.occurred],
      );
    const successWithoutQuality = await insert({ ordinal: 200, traceId: 't-sq', status: 'successful', quality: null, validated: null, kind: 'unvalidated', allocation: 'direct', occurred: '2026-08-05T12:00:00Z' });
    expect(successWithoutQuality.ok).toBe(false);
    if (!successWithoutQuality.ok) expect(successWithoutQuality.code).toBe('23514');
    const unvalidatedWithBenefit = await insert({ ordinal: 201, traceId: 't-ub', status: 'failed', quality: null, validated: '500.00', kind: 'unvalidated', allocation: 'direct', occurred: '2026-08-05T12:00:00Z' });
    expect(unvalidatedWithBenefit.ok).toBe(false);
    if (!unvalidatedWithBenefit.ok) expect(unvalidatedWithBenefit.code).toBe('23514');
    const overAllocated = await attempt(
      c,
      `INSERT INTO ratio.outcome_benefit_evidence
         (tenant_id, id, project_id, billing_period, benefit_kind, category, title, amount, currency, unit_label, unit_amount, attribution_pct, method, reference, recorded_by, allocation_method, data_as_of)
       VALUES ($1, $2, 'fixture-support-copilot', $3, 'measured_financial', 'cost_savings', 'Over-allocated claim', '100.00', 'USD', 'USD', '100.00', 150, 'ledger diff', 'fixture://over-allocated', 'fixture-bot', 'direct', '2026-08-31T00:00:00Z')`,
      [seed.a.tenantId, newId(60), seed.a.period],
    );
    expect(overAllocated.ok).toBe(false);
    if (!overAllocated.ok) expect(overAllocated.code).toBe('23514'); // attribution_pct is bounded to 0-100
    const wrongMonth = await insert({ ordinal: 203, traceId: 't-wm', status: 'failed', quality: null, validated: null, kind: 'unvalidated', allocation: 'direct', occurred: '2026-09-05T12:00:00Z' });
    expect(wrongMonth.ok).toBe(false);
    if (!wrongMonth.ok) expect(wrongMonth.code).toBe('23514');
    });
  });

  it('exposes only the currently published batch through the published view, tenant-scoped', async () => {
    // An event on the still-staged batch exists in the base table but must
    // never surface through the published view.
    await db.pool.query(
      `INSERT INTO ratio.outcome_events
         (tenant_id, source_id, batch_id, artifact_sha256, row_ordinal, billing_period, project_id, registry_id, trace_id, agent_run_id, request_id,
          outcome_type, outcome_status, quality_result, completion_latency, validated_benefit, benefit_validation_status, currency, allocation_method, data_as_of, occurred_at)
       VALUES ($1, $2, $3, $4, 300, $5, 'fixture-support-copilot', $6, 'staged-only-trace', 'run', 'req',
               'resolved_ticket', 'successful', 0.99, 900, NULL, 'unvalidated', 'USD', 'direct', '2026-08-06T12:00:00Z', '2026-08-06T12:00:00Z')`,
      [seed.a.tenantId, seed.a.sourceId, seed.a.batchStaged, artifactSha('tenant-a', seed.a.batchStaged), seed.a.period, seed.a.outcomeRegistryId],
    );
    await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
      const published = await c.query(`SELECT trace_id FROM ratio.outcome_events_published WHERE tenant_id = $1 ORDER BY trace_id`, [seed.a.tenantId]);
      expect(published.rows.map((r) => r.trace_id)).toEqual(['tenant-a-trace-1', 'tenant-a-trace-2']); // the staged-only event is absent
      const base = await c.query(`SELECT count(*)::int AS n FROM ratio.outcome_events WHERE tenant_id = $1`, [seed.a.tenantId]);
      expect(base.rows[0].n).toBe(3); // but it is durably stored
    });
    // Tenant B sees none of tenant A's published events.
    await withRole(db.pool, 'ratio_worker', seed.b.tenantId, async (c) => {
      const cross = await c.query(`SELECT count(*)::int AS n FROM ratio.outcome_events_published WHERE tenant_id = $1`, [seed.a.tenantId]);
      expect(cross.rows[0].n).toBe(0);
    });
  });

  it('aggregates period counts per project from the published view', async () => {
    await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
      const counts = await c.query(`SELECT * FROM ratio.outcome_period_counts WHERE tenant_id = $1`, [seed.a.tenantId]);
      expect(counts.rows).toHaveLength(1);
      // pg returns bigint aggregates as text and DATE as a Date.
      expect(counts.rows[0]).toMatchObject({
        project_id: 'fixture-support-copilot',
        outcomes_total: '2',
        successful_outcomes: '1',
        failed_outcomes: '1',
        validated_benefit_events: '0',
        validated_benefit_total: null,
      });
      expect((counts.rows[0].billing_period as Date).toISOString().slice(0, 10)).toBe(seed.a.period);
    });
  });
});

describe('quality-gated counts over durable rows (trace → outcome join)', () => {
  it('counts successes only when the approved quality condition holds', async () => {
    const registration = await db.pool.query(`SELECT quality_direction, quality_threshold FROM ratio.outcome_unit_registrations WHERE tenant_id = $1 AND id = $2`, [seed.a.tenantId, seed.a.outcomeRegistryId]);
    // The incumbent was superseded by the governance tests; the approved row
    // carries the same quality condition — read whichever is approved, else
    // fall back to the seeded row's condition.
    const approvedRow = await db.pool.query(`SELECT quality_direction, quality_threshold FROM ratio.outcome_unit_registrations WHERE tenant_id = $1 AND project_id = 'fixture-support-copilot' AND status = 'approved'`, [seed.a.tenantId]);
    const condition = approvedRow.rows[0] ?? registration.rows[0];
    expect(condition).toBeTruthy();
    // Count over the published view: a staged-only event is durably stored
    // but never published, so it must not be counted. The view re-checks
    // tenancy through current_tenant_id() even for a bypassing superuser,
    // so the count runs through a tenanted reader.
    const events = await withRole(db.pool, 'ratio_reader', seed.a.tenantId, (c) =>
      c.query(`SELECT trace_id, outcome_status, quality_result, occurred_at FROM ratio.outcome_events_published WHERE tenant_id = $1 ORDER BY trace_id`, [seed.a.tenantId]),
    );
    const rows = events.rows.map((r) => ({
      traceId: r.trace_id as string,
      outcomeStatus: r.outcome_status as 'successful' | 'failed' | 'partial',
      qualityResult: r.quality_result === null ? null : Number(r.quality_result), // pg numeric arrives as text
      completionLatency: null,
      occurredAt: String(r.occurred_at).slice(0, 10),
    }));
    const successful = successfulOutcomeCount(rows, { qualityDirection: condition.quality_direction, qualityThreshold: Number(condition.quality_threshold) });
    expect(successful).toBe(1); // trace-1 (0.97 ≥ 0.9, successful); trace-2 is failed with a quality miss (0.55 < 0.9)
  });
});

describe('unvalidated benefit can never produce a ratio (durable rows → pure rules)', () => {
  it('returns null with blockers while evidence is unreviewed, then a ratio once verified and complete', async () => {
    const claimRows = await db.pool.query(`SELECT id, benefit_kind, amount, unit_label, unit_amount, attribution_pct, currency, recorded_by, verified_by, verified_at FROM ratio.outcome_benefit_evidence WHERE tenant_id = $1`, [seed.a.tenantId]);
    const supplementalRows = await db.pool.query(`SELECT id, category, evidence_status, amount, verified_by, verified_at FROM ratio.outcome_supplemental_costs WHERE tenant_id = $1`, [seed.a.tenantId]);
    const claims: BenefitClaimRow[] = claimRows.rows.map((r) => ({
      id: r.id,
      benefitKind: r.benefit_kind,
      amount: r.amount,
      unitLabel: r.unit_label,
      unitAmount: r.unit_amount,
      attributionPct: r.attribution_pct === null ? null : Number(r.attribution_pct),
      currency: r.currency,
      recordedBy: r.recorded_by,
      verifiedBy: r.verified_by,
      verifiedAt: r.verified_at,
    }));
    const supplemental: SupplementalCostRow[] = supplementalRows.rows.map((r) => ({
      id: r.id,
      category: r.category,
      evidenceStatus: r.evidence_status,
      amount: r.amount,
      verifiedBy: r.verified_by,
      verifiedAt: r.verified_at,
    }));
    const benefit = evaluateBenefit(claims);
    const registration = {
      projectId: 'fixture-support-copilot',
      useCasePattern: 'support_assistant' as const,
      outcomeUnitKey: 'resolved_ticket',
      metric: 'resolution_quality',
      unit: 'quality_result',
      direction: 'higher' as const,
      target: 15,
      thresholds: { stopBelow: 0.5, continueAt: 1, expandAt: 3 },
      baseline: { start: '2026-07-01', end: '2026-07-31', value: 12.5 },
      observation: { start: '2026-08-01', end: '2026-08-31', value: 15 },
      qualityMetric: 'resolution_quality',
      qualityDirection: 'higher' as const,
      qualityThreshold: 0.9,
      status: 'approved' as const,
      approvedAt: '2026-08-01T00:00:00Z',
    };
    const observation = registration.observation;
    // Synthetic model-usage coverage of the observation window (the cost
    // ledger's day coverage is D4's engine input; here it isolates the
    // benefit-side gating).
    const modelUsageDays = Array.from({ length: 31 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, cents: 1000 }));
    const cost = evaluateCost({ modelUsageDays, supplemental }, observation);
    const blocked = valueToCostRatio({ registration, benefit, cost });
    expect(blocked.ratio).toBeNull();
    expect(blocked.blockers).toContain('Measured benefit claims await evidence review.');

    // The full-cost rule requires every supplemental category to carry an
    // amount; the fixture records only labor. Record the remaining three as
    // assumed zero (an amount is present, so the cost is complete; the
    // evidence status owes no review), then have the separate reviewer
    // verify the measured labor row and the financial claim.
    for (const [i, category] of ['infrastructure', 'implementation', 'oversight'].entries()) {
      await db.pool.query(
        `INSERT INTO ratio.outcome_supplemental_costs
           (tenant_id, id, project_id, billing_period, category, amount, currency, evidence_status, reference, recorded_by, allocation_method, data_as_of)
         VALUES ($1, $2, 'fixture-support-copilot', $3, $4, '0.00', 'USD', 'assumed', 'fixture://assumed-zero/' || $4, 'fixture-bot', 'direct', '2026-08-31T00:00:00Z')`,
        [seed.a.tenantId, newId(50 + i), seed.a.period, category],
      );
    }
    await db.pool.query(`UPDATE ratio.outcome_supplemental_costs SET verified_by = 'e2e-reviewer', verified_at = now() WHERE tenant_id = $1 AND id = $2`, [seed.a.tenantId, seed.a.outcomeSupplementalId]);
    // A separate reviewer verifies the measured financial claim: the ratio
    // then exists and is deterministic (500 USD attributed over 310 USD of
    // model usage plus 250 USD of verified labor).
    await db.pool.query(`UPDATE ratio.outcome_benefit_evidence SET verified_by = 'e2e-reviewer', verified_at = now() WHERE tenant_id = $1 AND id = $2`, [seed.a.tenantId, seed.a.outcomeBenefitId]);
    const verifiedClaims = await db.pool.query(`SELECT id, benefit_kind, amount, unit_label, unit_amount, attribution_pct, currency, recorded_by, verified_by, verified_at FROM ratio.outcome_benefit_evidence WHERE tenant_id = $1`, [seed.a.tenantId]);
    const verified = evaluateBenefit(
      verifiedClaims.rows.map((r) => ({
        id: r.id,
        benefitKind: r.benefit_kind,
        amount: r.amount,
        unitLabel: r.unit_label,
        unitAmount: r.unit_amount,
        attributionPct: r.attribution_pct === null ? null : Number(r.attribution_pct),
        currency: r.currency,
        recordedBy: r.recorded_by,
        verifiedBy: r.verified_by,
        verifiedAt: r.verified_at,
      })),
    );
    // The cost evidence changed (categories recorded, labor verified): the
    // earlier snapshot is stale by design — re-read it before judging the ratio.
    const supplementalAfter = (await db.pool.query(`SELECT id, category, evidence_status, amount, verified_by, verified_at FROM ratio.outcome_supplemental_costs WHERE tenant_id = $1`, [seed.a.tenantId])).rows.map((r) => ({
      id: r.id,
      category: r.category,
      evidenceStatus: r.evidence_status,
      amount: r.amount,
      verifiedBy: r.verified_by,
      verifiedAt: r.verified_at,
    }));
    const costAfter = evaluateCost({ modelUsageDays, supplemental: supplementalAfter }, observation);
    const unblocked = valueToCostRatio({ registration, benefit: verified, cost: costAfter });
    expect(unblocked.ratio).not.toBeNull();
    expect(unblocked.blockers).toEqual([]);
    expect(unblocked.ratio).toBeCloseTo(50000 / 56000, 6); // 50000 attributed cents over 31000 model + 25000 labor cents
  });

  it('keeps unverified measured claims out of the numerator even with other verified claims', async () => {
    const other = newId(40);
    await db.pool.query(
      `INSERT INTO ratio.outcome_benefit_evidence (tenant_id, id, project_id, billing_period, benefit_kind, category, title, amount, currency, attribution_pct, method, reference, recorded_by, allocation_method, data_as_of)
       VALUES ($1, $2, 'fixture-support-copilot', $3, 'measured_financial', 'revenue', 'Unreviewed claim', '999.00', 'USD', 100, 'ledger diff', 'fixture://unreviewed', 'fixture-bot', 'direct', '2026-08-31T00:00:00Z')`,
      [seed.a.tenantId, other, seed.a.period],
    );
    const rows = await db.pool.query(`SELECT benefit_kind, amount, verified_by FROM ratio.outcome_benefit_evidence WHERE tenant_id = $1`, [seed.a.tenantId]);
    const benefit = evaluateBenefit(
      rows.rows.map((r) => ({
        id: String(rows.rows.indexOf(r)),
        benefitKind: r.benefit_kind,
        amount: r.amount,
        unitLabel: null,
        unitAmount: null,
        attributionPct: 100,
        currency: 'USD',
        recordedBy: null,
        verifiedBy: r.verified_by,
        verifiedAt: null,
      })),
    );
    expect(benefit.unverifiedMeasured).toBe(1); // the fixture claim was verified by the previous test
    expect(benefit.measuredCents).toBe(50000); // the unreviewed 999.00 contributes nothing
  });
});
