// The five original answers, moved verbatim from MockAIClient so that every
// old question keeps its exact text. They are not given the new provenance
// footer (open decision in DESIGN.md).

import type { AIContext, AIResponse } from '../AIClient';
import { CACHE_HIT_RATE_MATERIAL } from '@/lib/derive';
import type { EvidenceStatus } from '@/types';

function evidenceNote(status?: EvidenceStatus): string {
  return status ? ` (value evidence: ${status})` : '';
}

function formatUSD(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export function atRisk(ctx: AIContext): AIResponse {
  const risky = ctx.initiatives.filter((i) => i.status === 'At Risk' || i.status === 'Pending Approval');
  // Initiatives whose budget metric is N/A keep their real status: they are listed too.
  const naRisky = (ctx.omitted ?? []).filter((o) => o.status === 'At Risk' || o.status === 'Pending Approval');
  const lines = risky.map(
    (i) =>
      `• **${i.name}** — ${i.status}, ${formatUSD(i.monthlyCost)}/mo at ${i.valueRatio.toFixed(1)}× return${evidenceNote(i.valueEvidenceStatus)}` +
      (i.savingsOpportunity > 0 ? `, ${formatUSD(i.savingsOpportunity)}/mo savings identified` : ''),
  );
  const text =
    risky.length + naRisky.length === 0
      ? `All ${ctx.summary.initiativesActive} initiatives are on track. Portfolio spend: ${formatUSD(ctx.summary.totalMonthlySpend)}/mo.`
      : [
          `${risky.length + naRisky.length} initiative(s) need attention:`,
          ...lines,
          ...naRisky.map((o) => `• **${o.name}** — ${o.status}, budget N/A (${o.reason})`),
          `Total portfolio: ${formatUSD(ctx.summary.totalMonthlySpend)}/mo across ${ctx.summary.initiativesActive} initiatives.`,
        ].join('\n');
  return { message: { role: 'assistant', content: text }, initiativesReferenced: risky.map((i) => i.id), provider: 'mock' };
}

// Initiatives map 1:1 to workloads by id, so the workload snapshot joins safely;
// mentioned only when the hit rate clears CACHE_HIT_RATE_MATERIAL.
function cacheLine(initiativeId: string, ctx: AIContext): string {
  const workload = ctx.workloads?.find((w) => w.id === initiativeId);
  const rate = workload?.cacheHitRate;
  if (typeof rate !== 'number' || rate < CACHE_HIT_RATE_MATERIAL) return '';
  return `Cache hit rate: ${(rate * 100).toFixed(1)}% of its input tokens are billed at the cached rate.`;
}

export function costDriver(ctx: AIContext): AIResponse {
  const top = [...ctx.initiatives].sort((a, b) => b.monthlyCost - a.monthlyCost)[0];
  if (!top) return help();
  const text = [
    `The largest cost driver is **${top.name}** at ${formatUSD(top.monthlyCost)}/mo (${top.valueRatio.toFixed(1)}× return${evidenceNote(top.valueEvidenceStatus)} — R4: cost paired with value).`,
    top.status !== 'On Track'
      ? `It is currently **${top.status}** — consider a budget review.`
      : `Its value ratio justifies the spend; monitor budget consumption (${top.budgetConsumedPct}% consumed this period).`,
    top.savingsOpportunity > 0 ? `${formatUSD(top.savingsOpportunity)}/mo in savings opportunities are identified for this initiative.` : '',
    cacheLine(top.id, ctx),
  ]
    .filter(Boolean)
    .join(' ');
  return { message: { role: 'assistant', content: text }, initiativesReferenced: [top.id], provider: 'mock' };
}

export function savings(ctx: AIContext): AIResponse {
  const opportunities = ctx.initiatives.filter((i) => i.savingsOpportunity > 0);
  const text = [
    `Projected savings across the portfolio: **${formatUSD(ctx.summary.projectedSavings)}/mo**.`,
    `Top opportunities by initiative:`,
    ...[...opportunities]
      .sort((a, b) => b.savingsOpportunity - a.savingsOpportunity)
      .slice(0, 3)
      .map((i) => `• ${i.name}: ${formatUSD(i.savingsOpportunity)}/mo`),
  ].join('\n');
  return { message: { role: 'assistant', content: text }, initiativesReferenced: opportunities.map((i) => i.id), provider: 'mock' };
}

export function summary(ctx: AIContext): AIResponse {
  const onTrack = ctx.initiatives.filter((i) => i.status === 'On Track').length;
  const text = [
    `**Portfolio summary — ${ctx.asOf.slice(0, 10)}**`,
    `Total spend: ${formatUSD(ctx.summary.totalMonthlySpend)}/mo across ${ctx.summary.initiativesActive} initiatives.`,
    `Status: ${onTrack} on track, ${ctx.summary.pendingApproval} pending approval.`,
    `Projected savings: ${formatUSD(ctx.summary.projectedSavings)}/mo.`,
  ].join('\n');
  return { message: { role: 'assistant', content: text }, initiativesReferenced: [], provider: 'mock' };
}

const HELP_TEXT = [
  "I'm Frank Coster, your FinOps accountability partner. I reason over your initiative portfolio — value ratios, budget status, and savings opportunities. Try:",
  '• "Which initiatives are at risk?"',
  '• "What\'s driving cloud cost?"',
  '• "How much can we save?"',
  '• "Summarize the portfolio"',
].join('\n');

export function help(): AIResponse {
  return { message: { role: 'assistant', content: HELP_TEXT }, initiativesReferenced: [], provider: 'mock' };
}
