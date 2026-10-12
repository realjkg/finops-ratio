// Value-ratio + budget-bar color scales (spec §10.3, §10.4).
// Returns the design-token color name so callers can compose Tailwind classes
// or inline styles from a single source of truth.

import type { Workload } from '@/types';

export type RatioRating = 'excellent' | 'good' | 'marginal' | 'poor';

// Theme variables (src/index.css), not literals: the accent follows the active theme,
// so Light and High contrast get their darker, readable values and Dark is unchanged.
export const TOKEN_COLOR = {
  value: 'rgb(var(--c-value))',
  unit: 'rgb(var(--c-unit))',
  shape: 'rgb(var(--c-shape))',
  cost: 'rgb(var(--c-cost))',
  gate: 'rgb(var(--c-gate))',
  purple: 'rgb(var(--c-purple))',
} as const;

/** `color` at `pct` percent over transparent (badge and border tints); works for any CSS color. */
export const tint = (color: string, pct = 10) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

// Spec §10.3: ≥10× excellent, 5–9.9× good, 2–4.9× marginal, <2× poor.
export function ratioRating(ratio: number): RatioRating {
  if (ratio >= 10) return 'excellent';
  if (ratio >= 5) return 'good';
  if (ratio >= 2) return 'marginal';
  return 'poor';
}

export function ratioColor(ratio: number): string {
  switch (ratioRating(ratio)) {
    case 'excellent':
      return TOKEN_COLOR.value;
    case 'good':
      return TOKEN_COLOR.unit;
    case 'marginal':
      return TOKEN_COLOR.shape;
    case 'poor':
      return TOKEN_COLOR.cost;
  }
}

// Spec §10.4: budget bar fill color by utilization fraction.
export function budgetColor(pctUsed: number): string {
  if (pctUsed >= 0.9) return TOKEN_COLOR.cost;
  if (pctUsed >= 0.7) return TOKEN_COLOR.shape;
  return TOKEN_COLOR.value;
}

export type ThresholdStatus = 'healthy' | 'soft' | 'hard' | 'kill';

export function thresholdStatus(
  pctUsed: number,
  soft: number,
  hard: number,
  kill: number,
): ThresholdStatus {
  if (pctUsed >= kill) return 'kill';
  if (pctUsed >= hard) return 'hard';
  if (pctUsed >= soft) return 'soft';
  return 'healthy';
}

export const PROVIDER_LABEL: Record<Workload['model_provider'], string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  aws_bedrock: 'AWS Bedrock',
  azure_openai: 'Azure OpenAI',
  custom: 'Custom',
};

