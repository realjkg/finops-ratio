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
  const seen = new Set<string>(); // an alias shared by several entities resolves to the first one
  return out.filter((c) => !seen.has(c.alias) && seen.add(c.alias));
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
  // Sweep: sorted by start (longest first), a mention ending inside the previous reach is contained.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  let reach = -1;
  return found.filter((m) => m.end > reach && ((reach = m.end), true));
}

const KIND_RANK = { workload: 0, model: 1, team: 2, portfolio: 3 } as const;

export function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'team') return a.team === (b as typeof a).team;
  if (a.kind === 'workload') return a.id === (b as typeof a).id;
  if (a.kind === 'model') return a.model === (b as typeof a).model;
  return true;
}

/** The most specific mention (workload > model > team > portfolio), first on ties. */
export function pickSubject(mentions: Mention[]): { scope: Scope } | null {
  const best = [...mentions].sort((a, b) => KIND_RANK[a.scope.kind] - KIND_RANK[b.scope.kind] || a.start - b.start)[0];
  return best ? { scope: best.scope } : null;
}

/** Does the text name a specific team (not merely the word "team")? */
export function namesTeam(mentions: Mention[]): boolean {
  return mentions.some((m) => m.scope.kind === 'team');
}

// Words that follow "of/for/in/the" without naming anything in the data.
const NOT_A_NAME = new Set(
  `the a an this that these those it them us we you me all any each every everything everyone anything our my your its their next last now today more less portfolio overall company month year quarter week cost spend value roi savings total dollars average aggregate agents models workloads ai llm usd nan infinity same whole entire other first highest lowest best worst weakest strongest biggest largest smallest top bottom expensive costly cheapest which what one team teams group groups department departments dept show tell give list rank compare explain and or who how is are`.split(' '),
);

const WORD = "(?!the\\b)[\\p{L}&'\u00a7-]+";
// "the X team", "and X team", "for X group", any verb before it: a team-qualified name.
const TEAM_QUALIFIED_RX = new RegExp(
  `\\b(?:the|our|and|or|vs|versus|with|than|plus|for|of|in|on|about|within|to)\\s+(${WORD}(?:(?:\\s*,\\s*|\\s+)${WORD}){0,3})\\s+(?:teams?|groups?|departments?|dept)\\b`,
  'giu',
);
// A team name that opens the question: "Finance team ROI".
const START_TEAM_RX = /^\s*(\p{L}[\p{L}&'-]*(?:\s+[\p{L}&'-]+){0,2})\s+(?:team|group|department|dept)\b/giu;
// A capitalized name after a list separator ("ROI of Legal, Finance and IT", "Legal with HR").
const LIST_NAME_RX = /(?:[,&]|\b(?:and|or|vs|versus|with)\b)\s*(\p{Lu}[\p{L}&'-]*(?:\s+(?!(?:and|or|vs|versus|with)\b)[\p{L}&'-]+){0,2})/gu;
const TRAILING_NAME_RX = /(?:^|\s)(?:for|of|in|on|about)\s+(?:the\s+)?([\p{L}&'-]+(?:\s+[\p{L}&'-]+){0,3})\s*[?.!]*\s*$/gu;

const plausible = (raw: string): boolean => {
  const first = raw.split(/\s+/)[0].toLowerCase();
  return raw.length >= 2 && !NOT_A_NAME.has(first);
};

/** The text with each recognized entity replaced by a marker, so only unknown names remain. */
function mask(text: string, mentions: Mention[]): string {
  let t = text.slice(0, MAX_TEXT);
  for (const m of [...mentions].sort((a, b) => b.start - a.start)) t = `${t.slice(0, m.start)}\u00a7${t.slice(m.end)}`;
  return t;
}

/**
 * A team the user named ("the Finance team", "Finance team ROI", "the Finance and Legal teams")
 * that matches nothing in the data, else null. Recognized entities are masked first, so "Legal
 * and the Finance team" reports Finance, and generic phrases ("which team", "team group") are
 * rejected by `plausible`.
 */
export function unknownTeam(text: string, mentions: Mention[] = []): string | null {
  // "Sales team": a workload or model name used as a team name is a team that does not exist.
  for (const m of mentions) {
    if (m.scope.kind !== 'team' && m.scope.kind !== 'portfolio' && /^\s+(?:team|group|department|dept)\b/i.test(text.slice(m.end, m.end + 12))) return text.slice(m.start, m.end).slice(0, 40);
  }
  const t = mask(text, mentions);
  for (const rx of [START_TEAM_RX, TEAM_QUALIFIED_RX]) {
    for (const m of t.matchAll(rx)) {
      for (const part of m[1].split(/\s*(?:,|\band\b|\bor\b|\s&\s|\bvs\b|\bversus\b)\s*/i)) {
        const raw = part.replace(/^(?:the|our)\s+/i, '').trim();
        if (raw && !raw.includes('\u00a7') && plausible(raw)) return raw.slice(0, 40);
      }
    }
  }
  return null;
}

/**
 * A capitalized name that matches nothing in the data, else null: a trailing one ("ROI of
 * Lëgal") when nothing was recognized, or one in a list next to a recognized entity ("Legal,
 * Finance and IT"). Lowercase phrases ("in total", "on average") and the words USD, AI and LLM
 * are ordinary words, not names.
 */
export function unknownCapitalized(text: string, mentions: Mention[] = []): string | null {
  for (const m of mask(text, mentions).matchAll(mentions.length > 0 ? LIST_NAME_RX : TRAILING_NAME_RX)) {
    const raw = m[1].trim();
    if (plausible(raw) && raw[0] !== raw[0].toLowerCase()) return raw.slice(0, 40);
  }
  return null;
}
