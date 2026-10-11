// Entity mentions: which team / workload / model / portfolio a piece of text
// names. Aliases are matched on word boundaries (hyphens count as word chars so
// "gpt-4o" never matches inside "gpt-4o-mini"), longest match wins, and a short
// alias contained in a longer match is dropped ("marketing" inside "marketing
// content gen"). Two team names double as ordinary words ("IT", "Revenue") and
// get stricter rules.

import { MODEL_REGISTRY } from '@/data/models';
import type { Scope, World } from './types';

export const MAX_TEXT = 2000;

export interface Mention {
  scope: Scope;
  start: number;
  end: number;
}

// Hand-written short names, keyed by seed workload id. Contexts with other ids
// still match on their full names.
const WORKLOAD_ALIASES: Record<string, string[]> = {
  'wl-support': ['customer support', 'support agent'],
  'wl-sales': ['sales'],
  'wl-codereview': ['code review', 'codereview'],
  'wl-docsum': ['doc summarizer', 'docsum', 'document summarization'],
  'wl-marketing': ['marketing content', 'content gen'],
  'wl-fraud': ['fraud triage', 'fraud'],
  'wl-knowledge': ['knowledge bot', 'knowledge'],
  'wl-triage': ['support triage', 'triage router', 'triage'],
  'wl-redline': ['redliner', 'redline', 'contract'],
  'wl-forecast': ['pipeline forecast', 'forecast analyst'],
  'wl-infrabot': ['infra runbook', 'runbook', 'infrabot'],
};

const TEAM_ALIASES: Record<string, string[]> = {
  'cx engineering': ['cx', 'customer experience'],
  'platform eng': ['platform engineering', 'platform'],
  'risk & trust': ['risk and trust', 'risk/trust'],
};

const MODEL_ALIASES: Record<string, string[]> = {
  'gemini-2.5-flash': ['gemini 2.5 flash', 'gemini flash', 'gemini'],
  'gpt-4o-mini': ['gpt 4o mini', 'gpt-4o mini', '4o-mini'],
  'claude-haiku-3.5': ['haiku'],
  'gpt-4o': ['gpt 4o'],
  'claude-sonnet-4-20250514': ['claude sonnet', 'sonnet'],
  'claude-opus-4-20250514': ['claude opus', 'opus'],
  'gpt-4.5': ['gpt 4.5', 'gpt-45'],
};

// Words that make the two ambiguous team names unambiguous.
const TEAM_WORD = '(?:team|group|department|dept|org|organization|organisation|business unit)';
const PREPOSITION = '(?:for|of|in|on|about|within|by|from|vs|versus|than|compare|and|the)';

/** Own-property lookup: wire-derived keys such as "constructor" must never reach the prototype chain. */
function aliasesOf(table: Record<string, string[]>, key: string): string[] {
  return Object.hasOwn(table, key) ? table[key] : [];
}

export function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordRegex(alias: string): RegExp {
  return new RegExp(`(?<![\\w-])${esc(alias).replace(/\s+/g, '\\s+')}(?![\\w-])`, 'g');
}

interface Candidate {
  scope: Scope;
  alias: string;
}

function candidates(world: World): Candidate[] {
  const out: Candidate[] = [];
  for (const w of world.workloads) {
    const names = [w.name.toLowerCase(), ...aliasesOf(WORKLOAD_ALIASES, w.id)];
    for (const alias of names) out.push({ scope: { kind: 'workload', id: w.id }, alias });
  }
  for (const m of MODEL_REGISTRY) {
    const names = [m.model_name, m.display_name.toLowerCase(), ...aliasesOf(MODEL_ALIASES, m.model_name)];
    for (const alias of names) out.push({ scope: { kind: 'model', model: m.model_name }, alias });
  }
  for (const team of world.teams) {
    const key = team.toLowerCase();
    if (key === 'it' || key === 'revenue') continue; // handled by stricter rules
    for (const alias of [key, ...aliasesOf(TEAM_ALIASES, key)]) {
      out.push({ scope: { kind: 'team', team }, alias });
    }
  }
  return out;
}

function ambiguousTeams(world: World, text: string): Mention[] {
  const out: Mention[] = [];
  const hasLower = /[a-z]/.test(text);
  for (const team of world.teams) {
    const key = team.toLowerCase();
    if (key === 'it') {
      const rx = new RegExp(`(?<![\\w-])IT(?![\\w-])`, 'g');
      for (let m = rx.exec(text); m; m = rx.exec(text)) {
        const after = text.slice(m.index + 2, m.index + 40);
        const before = text.slice(Math.max(0, m.index - 40), m.index);
        const qualified =
          new RegExp(`^\\s+${TEAM_WORD}\\b`, 'i').test(after) ||
          (hasLower && new RegExp(`\\b(?:${TEAM_WORD}|${PREPOSITION})\\s+$`, 'i').test(before));
        if (qualified) out.push({ scope: { kind: 'team', team }, start: m.index, end: m.index + 2 });
      }
    } else if (key === 'revenue') {
      const rx = /(?<![\w-])revenue(?![\w-])/gi;
      for (let m = rx.exec(text); m; m = rx.exec(text)) {
        const end = m.index + m[0].length;
        const after = text.slice(end, end + 40);
        const before = text.slice(Math.max(0, m.index - 40), m.index);
        const qualified =
          new RegExp(`^\\s+${TEAM_WORD}\\b`, 'i').test(after) ||
          (new RegExp(`\\b${PREPOSITION}\\s+$`, 'i').test(before) &&
            !/^\s*(?:of|is|was|were|at|=|:)?\s*[$€£]?\d/i.test(after) &&
            !/^\s+(?:protected|growth|number|figure|baseline|target|impact|stream|loss|forecast|and\b.*\bebitda)/i.test(after));
        if (qualified) out.push({ scope: { kind: 'team', team }, start: m.index, end });
      }
    }
  }
  return out;
}

const PORTFOLIO_RX =
  /(?<![\w-])(?:portfolio|overall|company[- ]?wide|(?:across|for) (?:the )?(?:whole )?(?:company|organi[sz]ation)|all (?:teams|workloads|initiatives)|everything|whole (?:company|portfolio))(?![\w-])/g;

/** All entity mentions in `text`, left to right, longest-match, de-overlapped. */
export function findMentions(text: string, world: World): Mention[] {
  const t = text.slice(0, MAX_TEXT);
  const lower = t.toLowerCase();
  const found: Mention[] = [];
  for (const c of candidates(world)) {
    const rx = wordRegex(c.alias);
    for (let m = rx.exec(lower); m; m = rx.exec(lower)) {
      found.push({ scope: c.scope, start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) rx.lastIndex++;
    }
  }
  found.push(...ambiguousTeams(world, t));
  for (let m = PORTFOLIO_RX.exec(lower); m; m = PORTFOLIO_RX.exec(lower)) {
    found.push({ scope: { kind: 'portfolio' }, start: m.index, end: m.index + m[0].length });
  }
  PORTFOLIO_RX.lastIndex = 0;
  // Drop any mention fully inside a longer one.
  const kept = found.filter(
    (a) =>
      !found.some(
        (b) =>
          b !== a &&
          b.start <= a.start &&
          b.end >= a.end &&
          (b.end - b.start > a.end - a.start || (b.end - b.start === a.end - a.start && found.indexOf(b) < found.indexOf(a))),
      ),
  );
  return kept.sort((a, b) => a.start - b.start);
}

const KIND_RANK = { workload: 0, model: 1, team: 2, portfolio: 3 } as const;

export function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'team') return a.team === (b as typeof a).team;
  if (a.kind === 'workload') return a.id === (b as typeof a).id;
  if (a.kind === 'model') return a.model === (b as typeof a).model;
  return true;
}

interface Subject {
  scope: Scope;
  /** Other distinct entities of the same kind that were also named. */
  others: Scope[];
}

/** The most specific mention (workload > model > team > portfolio), first on ties. */
export function pickSubject(mentions: Mention[]): Subject | null {
  if (mentions.length === 0) return null;
  const best = [...mentions].sort(
    (a, b) => KIND_RANK[a.scope.kind] - KIND_RANK[b.scope.kind] || a.start - b.start,
  )[0];
  const others: Scope[] = [];
  for (const m of mentions) {
    if (m.scope.kind === best.scope.kind && !sameScope(m.scope, best.scope) && !others.some((o) => sameScope(o, m.scope))) {
      others.push(m.scope);
    }
  }
  return { scope: best.scope, others };
}

/** Does the text name a specific team (not merely the word "team")? */
export function namesTeam(mentions: Mention[]): boolean {
  return mentions.some((m) => m.scope.kind === 'team');
}

// Words that follow "of/for/in/the" without naming anything in the data.
const NOT_A_NAME = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'them', 'us', 'we', 'you', 'me', 'all', 'any', 'each', 'every',
  'everything', 'everyone', 'anything', 'our', 'my', 'your', 'its', 'their', 'next', 'last', 'now', 'today', 'more', 'less',
  'portfolio', 'overall', 'company', 'month', 'year', 'quarter', 'week', 'cost', 'spend', 'value', 'roi', 'savings',
  'total', 'dollars', 'average', 'aggregate', 'agents', 'models', 'workloads', 'ai', 'llm', 'usd',
  'same', 'whole', 'entire', 'other', 'first', 'highest', 'lowest', 'best', 'worst', 'weakest', 'strongest', 'biggest',
  'largest', 'smallest', 'top', 'bottom', 'expensive', 'costly', 'cheapest', 'which', 'what', 'one',
]);

const WORD = "(?!the\\b)[\\p{L}&'-]+";
// "the X team", "our X group", "for X team": a team-qualified name, whatever the verb before it.
const TEAM_QUALIFIED_RX = new RegExp(
  `(?:\\b(?:the|our)|\\b(?:for|of|in|on|about|within|to))\\s+(${WORD}(?:\\s+${WORD}){0,2})\\s+(?:team|group|department|dept)\\b`,
  'giu',
);
const TRAILING_NAME_RX = /(?:^|\s)(?:for|of|in|on|about)\s+(?:the\s+)?([\p{L}&'-]+(?:\s+[\p{L}&'-]+){0,3})\s*[?.!]*\s*$/u;

const plausible = (raw: string): boolean => {
  const first = raw.split(/\s+/)[0].toLowerCase();
  return raw.length >= 2 && !NOT_A_NAME.has(first);
};

/** A team the user named ("the Finance team") that matches nothing in the data, else null. */
export function unknownTeam(text: string): string | null {
  const t = text.slice(0, MAX_TEXT);
  for (const m of t.matchAll(TEAM_QUALIFIED_RX)) {
    const raw = m[1].trim();
    if (plausible(raw)) return raw.slice(0, 40);
  }
  return null;
}

/**
 * A trailing capitalized name ("ROI of Lëgal") that matches nothing in the data, else null.
 * Lowercase phrases ("in total", "on average", "for agents") and short acronyms ("USD", "AI") are
 * ordinary words, not names, so they never trigger this.
 */
export function unknownCapitalized(text: string): string | null {
  const raw = TRAILING_NAME_RX.exec(text.slice(0, MAX_TEXT))?.[1]?.trim();
  if (!raw || !plausible(raw)) return null;
  const first = raw.split(/\s+/)[0];
  if (first[0] === first[0].toLowerCase() || (first === first.toUpperCase() && first.length <= 4)) return null;
  return raw.slice(0, 40);
}
