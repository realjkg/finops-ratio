// Per-user query-event seed — populates the previously-unused AgentQuery shape
// (src/types §2.5). This is the only per-user cost data in the repo (findings
// gap G1): without it, user-level attribution has no data path at all.
//
// Determinism contract (the DEMO_NOW pattern): fixed specs + index-arithmetic
// derivation. No randomness, no Date.now — the log is byte-identical on every
// reload and in every process.
//
// Honesty contract: this is a SAMPLED demo query log. It ranks users against
// each other; its totals are the log's own, never the portfolio's — every
// derived row states that basis. Token counts are realistic per-event sizes,
// not a partition of the workload MTD figures.

import type { AgentQuery } from '@/types';
import { DEMO_NOW, WORKLOADS } from './workloads';
import { findModel } from './models';

const DEMO_YEAR = DEMO_NOW.getUTCFullYear();
const DEMO_MONTH = DEMO_NOW.getUTCMonth();
const DEMO_DAY = DEMO_NOW.getUTCDate(); // events cover MTD through this day

// Fixed multipliers cycle by (day + slot) so per-event tokens vary realistically
// without any randomness. Same pattern family as HISTORY_PATTERN in workloads.ts.
const TOKEN_WOBBLE = [0.82, 1.08, 0.93, 1.04, 0.88, 1.12, 0.97];

// Queries book at fixed UTC hours (all ≤ 15 < DEMO_NOW 17:42, so even the
// last day's events stay inside the demo clock).
const HOUR_SLOTS = [8, 10, 13, 15];

interface UserQuerySeedSpec {
  /** Demo user id (same style as the governance approver ids). */
  userId: string;
  /** Every logged query resolves exactly one workload — the team join key. */
  workloadId: string;
  /** Sampled events per elapsed demo day. */
  queriesPerDay: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  /** Stable demo prompt for the event log. */
  query: string;
}

const USER_QUERY_SEED_SPECS: UserQuerySeedSpec[] = [
  { userId: 'a.mendez', workloadId: 'wl-support', queriesPerDay: 6, avgInputTokens: 3400, avgOutputTokens: 900, query: 'Draft a reply to this ticket' },
  { userId: 'j.okafor', workloadId: 'wl-support', queriesPerDay: 4, avgInputTokens: 2600, avgOutputTokens: 720, query: 'Summarize the account history' },
  { userId: 's.lindqvist', workloadId: 'wl-triage', queriesPerDay: 5, avgInputTokens: 1100, avgOutputTokens: 200, query: 'Route this ticket to the right queue' },
  { userId: 'p.ramaswamy', workloadId: 'wl-sales', queriesPerDay: 4, avgInputTokens: 1500, avgOutputTokens: 1100, query: 'Draft the follow-up email' },
  { userId: 'l.hartman', workloadId: 'wl-forecast', queriesPerDay: 2, avgInputTokens: 5600, avgOutputTokens: 1900, query: 'Reconcile the pipeline forecast' },
  { userId: 'k.tanaka', workloadId: 'wl-codereview', queriesPerDay: 5, avgInputTokens: 2800, avgOutputTokens: 610, query: 'Review this diff for regressions' },
  { userId: 'd.osullivan', workloadId: 'wl-docsum', queriesPerDay: 3, avgInputTokens: 7100, avgOutputTokens: 700, query: 'Summarize this document set' },
  { userId: 'm.kowalski', workloadId: 'wl-redline', queriesPerDay: 3, avgInputTokens: 8800, avgOutputTokens: 2000, query: 'Redline this contract against the playbook' },
  { userId: 'r.desai', workloadId: 'wl-marketing', queriesPerDay: 4, avgInputTokens: 1500, avgOutputTokens: 2200, query: 'Draft landing-page copy variants' },
  { userId: 't.nguyen', workloadId: 'wl-fraud', queriesPerDay: 2, avgInputTokens: 1800, avgOutputTokens: 1200, query: 'Adjudicate this flagged transaction' },
  { userId: 'e.vargas', workloadId: 'wl-infrabot', queriesPerDay: 3, avgInputTokens: 1750, avgOutputTokens: 470, query: 'Find the runbook for this alert' },
];

/** Query cost derives from the referenced workload's model registry pricing. */
function queryCostFor(workloadId: string, inputTokens: number, outputTokens: number): number {
  const workload = WORKLOADS.find((w) => w.id === workloadId);
  const model = workload ? findModel(workload.model) : undefined;
  if (!model) throw new Error(`Unknown model in user query seed for workload: ${workloadId}`);
  const cost =
    (inputTokens / 1_000_000) * model.pricing.input_per_1m +
    (outputTokens / 1_000_000) * model.pricing.output_per_1m;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

function buildUserQueryEvents(): AgentQuery[] {
  const events: AgentQuery[] = [];
  for (const spec of USER_QUERY_SEED_SPECS) {
    const workload = WORKLOADS.find((w) => w.id === spec.workloadId);
    if (!workload) throw new Error(`Unknown workload in user query seed: ${spec.workloadId}`);
    for (let day = 1; day <= DEMO_DAY; day++) {
      for (let slot = 0; slot < spec.queriesPerDay; slot++) {
        const wobble = TOKEN_WOBBLE[(day + slot) % TOKEN_WOBBLE.length];
        const input = Math.round(spec.avgInputTokens * wobble);
        const output = Math.round(spec.avgOutputTokens * wobble);
        events.push({
          id: `aq-${spec.userId}-d${day}-q${slot}`,
          user_id: spec.userId,
          query: spec.query,
          response: `Handled by ${workload.name} (demo log entry)`,
          workloads_referenced: [spec.workloadId],
          tokens_used: { input, output },
          query_cost: queryCostFor(spec.workloadId, input, output),
          timestamp: new Date(
            Date.UTC(DEMO_YEAR, DEMO_MONTH, day, HOUR_SLOTS[slot % HOUR_SLOTS.length], 5),
          ).toISOString(),
        });
      }
    }
  }
  return events;
}

/** The full sampled demo query log, month-to-date on the DEMO_NOW clock. */
export const USER_QUERY_EVENTS: AgentQuery[] = buildUserQueryEvents();
