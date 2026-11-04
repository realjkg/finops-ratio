// Formatting for the Frank mock. Currency matches the legacy mock exactly
// (whole dollars, en-US) so old and new answers read as one voice.

import type { EvidenceStatus } from '@/types';
import type { Answer } from './types';

export function usd(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

/** Dollars and cents, for per-unit prices. */
export function usd2(n: number): string {
  return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'n/a';
}

export function int(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : 'n/a';
}

export function pct1(n: number): string {
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : 'n/a';
}

export function signedPct1(n: number): string {
  return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(1)}%` : 'n/a';
}

/** Value-evidence suffix. An unmarked ratio says so rather than implying a status. */
export function evid(status: EvidenceStatus | undefined): string {
  return ` (value evidence: ${status ?? 'unmarked'})`;
}

/** "Value / cost 13.5×", or the honest non-positive form, or n/a with no spend. */
export function returnText(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return 'Value / cost n/a (no cost)';
  const r = `${ratio.toFixed(1)}×`;
  return ratio > 0 ? `Value / cost ${r}` : `Value / cost ${r} (no positive value)`;
}

/** Bare ratio for list rows. */
export function x(ratio: number | null): string {
  return ratio === null || !Number.isFinite(ratio) ? 'n/a' : `${ratio.toFixed(1)}×`;
}

/** ROI = (value - cost) / cost, as a whole percent. */
export function roiLine(value: number, spend: number): string {
  if (!(spend > 0)) return 'ROI (value − cost) ÷ cost: n/a (no spend)';
  const pct = Math.round(((value - spend) / spend) * 100);
  return `ROI (value − cost) ÷ cost: ${pct.toLocaleString('en-US')}%`;
}

/** Registry price per 1M tokens: at least 2 decimals, up to 4, no trailing noise. */
export function price(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  const t = n.toFixed(4).replace(/0+$/, '');
  const [i, d = ''] = t.split('.');
  return `$${i}.${d.padEnd(2, '0')}`;
}

export function months(n: number): string {
  return `${n.toFixed(1)} months`;
}

/** Every mock answer's provenance line starts with this; respond.ts keeps it in the protected tail. */
export const SOURCE_PREFIX = 'Source: demo dataset';

export function basisLine(asOf: string): string {
  return `${SOURCE_PREFIX} as of ${asOf.slice(0, 10)} — computed by a deterministic mock (no LLM, nothing live).`;
}

/** Render an Answer: header, body, assumptions, basis chip, next questions. */
export function render(a: Answer, asOf: string): string {
  const lines = [a.header, ...a.body];
  if (a.assumptions && a.assumptions.length > 0) {
    lines.push(`${a.assumptionsTitle ?? 'Assumptions'}:`, ...a.assumptions.map((s) => `• ${s}`));
  }
  lines.push(basisLine(asOf));
  if (a.next.length > 0) {
    lines.push('Next questions:', ...a.next.slice(0, 3).map((q) => `• "${q}"`));
  }
  return lines.join('\n');
}
