// MockAIClient — offline/CI mock, no network, no API key. Returns canned but
// data-grounded responses. Mirrors MockAgentClient: intent classification with a
// small delay for UX. Every response honors the R4 principles from
// .obvious/skills/agent-prompt — cost is always paired with its value ratio.

import type { AIClient, AIContext, AIMessage, AIResponse } from './AIClient';
import type { EvidenceStatus } from '@/types';

type Intent = 'at_risk' | 'cost_driver' | 'savings' | 'summary' | 'help';

// Provenance suffix (audit C1/C2): every cited ratio states its evidence
// status — the agent never presents an assumed value as measured.
function evidenceNote(status?: EvidenceStatus): string {
  return status ? ` (value evidence: ${status})` : '';
}

function classify(query: string): Intent {
  const q = query.toLowerCase();
  if (/(risk|approval|pending|caution)/.test(q)) return 'at_risk';
  if (/(cost|driv|expensive|spike|spend)/.test(q)) return 'cost_driver';
  if (/(sav|opportunit|reduc|cut)/.test(q)) return 'savings';
  if (/(summar|overview|report|portfolio)/.test(q)) return 'summary';
  return 'help';
}

function formatUSD(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

function atRisk(ctx: AIContext): AIResponse {
  const risky = ctx.initiatives.filter(
    (i) => i.status === 'At Risk' || i.status === 'Pending Approval',
  );
  const lines = risky.map(
    (i) =>
      `• **${i.name}** — ${i.status}, ${formatUSD(i.monthlyCost)}/mo at ${i.valueRatio.toFixed(1)}× return${evidenceNote(i.valueEvidenceStatus)}` +
      (i.savingsOpportunity > 0
        ? `, ${formatUSD(i.savingsOpportunity)}/mo savings identified`
        : ''),
  );
  const text =
    risky.length === 0
      ? `All ${ctx.summary.initiativesActive} initiatives are on track. Portfolio spend: ${formatUSD(ctx.summary.totalMonthlySpend)}/mo.`
      : [
          `${risky.length} initiative(s) need attention:`,
          ...lines,
          `Total portfolio: ${formatUSD(ctx.summary.totalMonthlySpend)}/mo across ${ctx.summary.initiativesActive} initiatives.`,
        ].join('\n');
  return {
    message: { role: 'assistant', content: text },
    initiativesReferenced: risky.map((i) => i.id),
    provider: 'mock',
  };
}

function costDriver(ctx: AIContext): AIResponse {
  const top = [...ctx.initiatives].sort((a, b) => b.monthlyCost - a.monthlyCost)[0];
  if (!top) return help();
  const text = [
    `The largest cost driver is **${top.name}** at ${formatUSD(top.monthlyCost)}/mo (${top.valueRatio.toFixed(1)}× return${evidenceNote(top.valueEvidenceStatus)} — R4: cost paired with value).`,
    top.status !== 'On Track'
      ? `It is currently **${top.status}** — consider a budget review.`
      : `Its value ratio justifies the spend; monitor budget consumption (${top.budgetConsumedPct}% consumed this period).`,
    top.savingsOpportunity > 0
      ? `${formatUSD(top.savingsOpportunity)}/mo in savings opportunities are identified for this initiative.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    message: { role: 'assistant', content: text },
    initiativesReferenced: [top.id],
    provider: 'mock',
  };
}

function savings(ctx: AIContext): AIResponse {
  const opportunities = ctx.initiatives.filter((i) => i.savingsOpportunity > 0);
  const text = [
    `Projected savings across the portfolio: **${formatUSD(ctx.summary.projectedSavings)}/mo**.`,
    `Top opportunities by initiative:`,
    ...[...opportunities]
      .sort((a, b) => b.savingsOpportunity - a.savingsOpportunity)
      .slice(0, 3)
      .map((i) => `• ${i.name}: ${formatUSD(i.savingsOpportunity)}/mo`),
  ].join('\n');
  return {
    message: { role: 'assistant', content: text },
    initiativesReferenced: opportunities.map((i) => i.id),
    provider: 'mock',
  };
}

function summary(ctx: AIContext): AIResponse {
  const onTrack = ctx.initiatives.filter((i) => i.status === 'On Track').length;
  const text = [
    `**Portfolio summary — ${ctx.asOf.slice(0, 10)}**`,
    `Total spend: ${formatUSD(ctx.summary.totalMonthlySpend)}/mo across ${ctx.summary.initiativesActive} initiatives.`,
    `Status: ${onTrack} on track, ${ctx.summary.pendingApproval} pending approval.`,
    `Projected savings: ${formatUSD(ctx.summary.projectedSavings)}/mo.`,
  ].join('\n');
  return {
    message: { role: 'assistant', content: text },
    initiativesReferenced: [],
    provider: 'mock',
  };
}

function help(): AIResponse {
  return {
    message: {
      role: 'assistant',
      content: [
        "I'm Frank Coster, your FinOps accountability partner. I reason over your initiative portfolio — value ratios, budget status, and savings opportunities. Try:",
        '• "Which initiatives are at risk?"',
        '• "What\'s driving cloud cost?"',
        '• "How much can we save?"',
        '• "Summarize the portfolio"',
      ].join('\n'),
    },
    initiativesReferenced: [],
    provider: 'mock',
  };
}

export class MockAIClient implements AIClient {
  readonly mode = 'mock' as const;

  async chat(messages: AIMessage[], context: AIContext): Promise<AIResponse> {
    await new Promise((resolve) => setTimeout(resolve, 280));
    const last = messages.filter((m) => m.role === 'user').at(-1);
    if (!last) return help();
    switch (classify(last.content)) {
      case 'at_risk':
        return atRisk(context);
      case 'cost_driver':
        return costDriver(context);
      case 'savings':
        return savings(context);
      case 'summary':
        return summary(context);
      default:
        return help();
    }
  }
}

