// Number parsing for the Frank mock: money, percentages and the overrides a
// question may carry. Everything is validated: a value that is not finite, is
// out of its legal range, or is the wrong sign is IGNORED and reported (never
// silently used, never echoed beyond a short numeric token). Regexes are
// linear (no nested quantifiers) and always run on text capped at MAX_TEXT.

import type { Overrides } from './assumptions';

const NUM = '(\\d[\\d,]*(?:\\.\\d+)?(?:e[+-]?\\d+)?)';
const UNIT = '(thousand|million|billion|bn|mm|k|m|b)';
// optional sign, $, optional sign, number, optional magnitude unit
const MONEY = `(-)?\\s{0,2}\\$\\s{0,2}(-)?\\s{0,2}${NUM}\\s{0,2}${UNIT}?(?![a-z])`;

const MULT: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
};
export const MAX_ABS_USD = 1e15;

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

/** Value of a MONEY match's groups [neg1, neg2, num, unit]; NaN when invalid. */
function moneyValue(g: (string | undefined)[]): number {
  const base = toNumber(g[2] ?? '');
  const sign = g[0] || g[1] ? -1 : 1;
  const v = sign * base * (g[3] ? MULT[g[3].toLowerCase()] : 1);
  return Number.isFinite(v) && Math.abs(v) <= MAX_ABS_USD ? v : Number.NaN;
}

export interface Found {
  /** undefined = not mentioned. NaN-free: invalid values are reported in `ignored`. */
  value?: number;
  ignored?: string;
}

function tok(raw: string): string {
  return raw.replace(/[^\d.,e+-]/gi, '').slice(0, 14);
}

function firstMoney(text: string, pattern: string, label: string): Found {
  const m = new RegExp(pattern, 'i').exec(text);
  if (!m) return {};
  const v = moneyValue(m.slice(1, 5));
  return Number.isNaN(v) ? { ignored: `${label}: could not use "${tok(m[3] ?? '')}" (not a finite amount in range)` } : { value: v };
}

// ---------------------------------------------------------------- overrides

export interface ParsedOverrides {
  overrides: Overrides;
  /** Human-readable notes for every override that was refused. */
  ignored: string[];
}

export function parseOverrides(text: string): ParsedOverrides {
  const overrides: Overrides = {};
  const ignored: string[] = [];

  // GPU price per hour: "$2.50 per GPU hour", "$1.50/GPU-hour", "$4 an hour"
  const price = new RegExp(`${MONEY}\\s{0,2}(?:/|per|an|a)\\s{0,2}(?:gpu\\s{0,2}-?\\s{0,2})?(?:hour|hr|h)\\b`, 'i').exec(text);
  if (price) {
    const v = moneyValue(price.slice(1, 5));
    if (Number.isNaN(v) || v <= 0 || v > 1000) ignored.push(`GPU price ignored: "${tok(price[3] ?? '')}" is not a positive $/hour up to $1,000; using the default.`);
    else overrides.gpuHourlyUsd = v;
  }

  // GPU count: "8 GPUs", "1 GPU", "-4 GPUs", "1e999 GPUs"
  const gpus = new RegExp(`(?<![\\w.$])(-?)${NUM}\\s{0,2}(?:x\\s{0,2})?(?:gpus?|h100s?|a100s?)\\b`, 'i').exec(text);
  if (gpus) {
    const v = (gpus[1] ? -1 : 1) * toNumber(gpus[2]);
    if (!Number.isInteger(v) || v < 1 || v > 100000) ignored.push(`GPU count ignored: "${tok(gpus[1] + gpus[2])}" is not a whole number from 1 to 100,000; using automatic sizing.`);
    else overrides.gpuCount = v;
  }

  // Migration one-time cost: "migration costs $40k", "one-time cost of $10,000", "$40k to migrate"
  const mig = firstMoney(
    text,
    `(?:migration|migrate|migrating|one[- ]?time|switch(?:ing)?|transition|cutover)[^$\\d]{0,30}?${MONEY}(?!\\s{0,2}(?:/|per|an|a)\\s{0,2}(?:gpu|hour|hr|h)\\b)`,
    'Migration cost ignored',
  );
  const mig2 = mig.value === undefined && mig.ignored === undefined
    ? firstMoney(text, `${MONEY}\\s{0,2}(?:one[- ]?time|to migrate|migration)`, 'Migration cost ignored')
    : mig;
  if (mig2.ignored) ignored.push(`${mig2.ignored}; using the default.`);
  else if (mig2.value !== undefined) {
    if (mig2.value < 0) ignored.push('Migration cost ignored: a negative cost is not valid; using the default.');
    else overrides.migrationOneTimeUsd = mig2.value;
  }

  // Utilisation: "60% utilisation", "utilization of 70%"
  const util = new RegExp(`${NUM}\\s{0,2}%\\s{0,2}(?:gpu\\s{0,2})?utili[sz]ation|utili[sz]ation[^\\d-]{0,12}?${NUM}\\s{0,2}%`, 'i').exec(text);
  if (util) {
    const v = toNumber(util[1] ?? util[2]) / 100;
    if (!(v > 0 && v <= 1)) ignored.push(`Utilisation ignored: "${tok(util[1] ?? util[2])}%" is not in (0, 100]; using the default.`);
    else overrides.utilisation = v;
  }

  // Throughput: "1500 tokens per second", "2k tokens/s", "9M tokens per GPU hour"
  const tps = new RegExp(`(?<![\\w.])(-?)${NUM}\\s{0,2}(k|m)?\\s{0,2}(?:tokens?|tok)\\s{0,2}(?:/|per)\\s{0,2}(?:(second|sec|s)\\b|gpu\\s{0,2}-?\\s{0,2}(?:hour|hr|h)\\b)`, 'i').exec(text);
  if (tps) {
    const mult = tps[3] ? MULT[tps[3].toLowerCase()] : 1;
    const raw = (tps[1] ? -1 : 1) * toNumber(tps[2]) * mult;
    const perSecond = tps[4] ? raw : raw / 3600;
    if (!Number.isFinite(perSecond) || perSecond <= 0 || perSecond > 1e7) ignored.push(`Throughput ignored: "${tok(tps[1] + tps[2])}" is not a positive tokens/s up to 10,000,000; using the default.`);
    else overrides.tokensPerSecondPerGpu = perSecond;
  }

  // Ops overhead: "30% ops overhead", "ops overhead of 20%"
  const ops = new RegExp(`${NUM}\\s{0,2}%\\s{0,2}(?:ops|operations|overhead)|(?:ops|operations)\\s{0,2}overhead[^\\d-]{0,12}?${NUM}\\s{0,2}%`, 'i').exec(text);
  if (ops) {
    const v = toNumber(ops[1] ?? ops[2]) / 100;
    if (!(v >= 0 && v <= 5)) ignored.push(`Ops overhead ignored: "${tok(ops[1] ?? ops[2])}%" is not between 0% and 500%; using the default.`);
    else overrides.opsOverheadPct = v;
  }

  return { overrides, ignored };
}

// ------------------------------------------------------------------- EBITDA

export interface Reduction {
  /** Recurring monthly reduction in USD (positive), or a percent of current spend. */
  monthlyUsd?: number;
  percent?: number;
  /** How the user phrased the period; monthly when unstated. */
  periodStated: boolean;
  ignored?: string;
}

const DOWN = '(?<![a-z])(?:went down|goes down|go down|gone down|is down|are down|down|dropped|drops?|fell|falls?|decreased?|declined?|reduced?|cut|lower(?:ed)?|sav(?:e|ed|es|ing|ings)|shrank|trimmed)';
const BY = '(?:\\s{1,3}(?:by|of|to the tune of|about|around|roughly))?';

/** A stated spend reduction: "went down $2,000 a month", "dropped 20%", "a 10% cut". */
export function parseReduction(text: string): Reduction {
  const money = new RegExp(`${DOWN}${BY}\\s{0,3}${MONEY}\\s{0,3}((?:a|per|/|each)\\s{0,2}(?:month|mo|year|yr|annum)\\b|monthly|annually|yearly)?`, 'i').exec(text);
  if (money) {
    const v = moneyValue(money.slice(1, 5));
    const unit = (money[5] ?? '').toLowerCase();
    const annual = /year|yr|annum|annual|yearly/.test(unit);
    if (Number.isNaN(v) || v <= 0) {
      return { periodStated: false, ignored: `Spend reduction ignored: could not use "${tok(money[3] ?? '')}" (needs a positive, finite amount).` };
    }
    return { monthlyUsd: annual ? v / 12 : v, periodStated: unit.length > 0 };
  }
  const pctRx = new RegExp(`${DOWN}${BY}\\s{0,3}${NUM}\\s{0,2}%|(?<![\\w.])${NUM}\\s{0,2}%\\s{0,2}(?:cut|reduction|drop|decrease|decline|saving|savings)`, 'i').exec(text);
  if (pctRx) {
    const raw = pctRx[1] ?? pctRx[2];
    const v = toNumber(raw);
    if (!(v > 0 && v < 100)) return { periodStated: false, ignored: `Spend reduction ignored: "${tok(raw)}%" is not between 0% and 100%.` };
    return { percent: v, periodStated: false };
  }
  return { periodStated: false };
}

export interface Baselines {
  /** Annual USD, as stated or annualized. */
  ebitda?: number;
  ebitdaNote?: string;
  revenue?: number;
  revenueNote?: string;
  marginPct?: number;
  ignored: string[];
}

function labelled(text: string, label: string): { found: Found; monthly: boolean; stated: number | null } {
  const fwd = new RegExp(`${label}(?:\\s{1,3}(?:baseline|figure|number))?(?:\\s{0,3}(?::|=|\\bof\\b|\\bis\\b|\\bwas\\b|\\bat\\b|\\babout\\b|\\baround\\b|\\broughly\\b|\\btotals?\\b)){0,2}\\s{0,3}${MONEY}`, 'i').exec(text);
  const rev = fwd ? null : new RegExp(`${MONEY}\\s{0,3}(?:in\\s|of\\s|on\\s)?(?:annual\\s|group\\s)?${label}`, 'i').exec(text);
  const m = fwd ?? rev;
  if (!m) return { found: {}, monthly: false, stated: null };
  const v = moneyValue(m.slice(1, 5));
  const before = text.slice(Math.max(0, m.index - 12), m.index);
  const after = text.slice(m.index + m[0].length, m.index + m[0].length + 16);
  const monthly = /monthly\s*$/i.test(before) || /^\s*(?:per month|a month|\/mo\b|monthly)/i.test(after);
  return Number.isNaN(v)
    ? { found: { ignored: `I could not use the ${label.toUpperCase()} figure you gave ("${tok(m[3] ?? '')}"): not a finite amount in range; ignored.` }, monthly, stated: null }
    : { found: { value: v }, monthly, stated: v };
}

/** Baselines only from the CURRENT question text (never from history). */
export function parseBaselines(text: string): Baselines {
  const out: Baselines = { ignored: [] };
  const e = labelled(text, 'ebitda');
  if (e.found.ignored) out.ignored.push(e.found.ignored);
  else if (e.found.value !== undefined) {
    out.ebitda = e.monthly ? e.found.value * 12 : e.found.value;
    out.ebitdaNote = e.monthly ? `stated by you as ${usdPlain(e.found.value)} monthly, ×12` : 'stated by you; annual assumed';
  }
  const r = labelled(text, 'revenue');
  if (r.found.ignored) out.ignored.push(r.found.ignored);
  else if (r.found.value !== undefined) {
    out.revenue = r.monthly ? r.found.value * 12 : r.found.value;
    out.revenueNote = r.monthly ? `stated by you as ${usdPlain(r.found.value)} monthly, ×12` : 'stated by you; annual assumed';
  }
  const margin = new RegExp(`${NUM}\\s{0,2}%\\s{0,2}(?:ebitda\\s{0,2})?margin|margin[^\\d-]{0,12}?${NUM}\\s{0,2}%`, 'i').exec(text);
  if (margin) {
    const v = toNumber(margin[1] ?? margin[2]);
    if (v > -1000 && v < 100 && Number.isFinite(v)) out.marginPct = v;
    else out.ignored.push(`I could not use the margin figure you gave ("${tok(margin[1] ?? margin[2])}%"); ignored.`);
  }
  return out;
}

function usdPlain(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
