// The router: one pure function from (messages, context) to a response. No
// I/O, no clock, no randomness. Order of work:
//   1. take the last user message (bounded), greeting -> legacy help
//   2. read entity mentions and back-references
//   3. classify the intent (contract order in intents.ts)
//   4. resolve the scope: named entity > remembered focus > portfolio
//   5. build the answer, render it with the honesty chips, list what it cites

import type { AIContext, AIMessage, AIResponse } from '../AIClient';
import { parseOverrides, parseReduction, parseBaselines } from './parse';
import { capabilityAnswer, clarifyText, rejectedNote, unknownNameText, unsupportedText } from './answersMeta';
import { alertsAnswer, outcomesAnswer, tokensAnswer, workloadsAnswer } from './answersDrill';
import { ebitdaAnswer, migrationAnswer } from './answersFinance';
import { costDriverAnswer, roiAnswer, savingsAnswer, teamRankAnswer } from './answersRoi';
import { MAX_TEXT, findMentions, namesTeam, pickSubject, sameScope, unknownAlongside, unknownCapitalized, unknownTeam, type Mention } from './entities';
import { MAX_HISTORY, deriveFocus, detectReference, isElliptical, resolveReference } from './memory';
import { classifyIntent, classifyLegacy, rankingOf, type Intent } from './intents';
import { atRisk, costDriver, help, savings, summary } from './legacy';
import { render } from './format';
import { scopeLabel } from './calc';
import { buildWorld, legacyContext } from './world';
import type { Answer, Scope, World } from './types';

const GREETING = /^\s*(?:help|hi|hello|hey|\?)\W*$/;

function reply(content: string, referenced: string[] = []): AIResponse {
  return { message: { role: 'assistant', content }, initiativesReferenced: referenced, provider: 'mock' };
}

const MAX_REPLY = 8000;

const NOTE_MAX = 300;
const MARKER = '\u2026(answer shortened to fit; ask a narrower question for the rest)';

/** Keep the header and the tail (notes, basis, next questions); shorten the middle if it is huge. */
function bound(text: string, notes: string[] = []): string {
  const lines = text.split('\n');
  const tailAt = lines.findIndex((l) => l.startsWith('Basis:'));
  const head = tailAt < 0 ? lines : lines.slice(0, tailAt);
  const safeNotes = notes.map((n) => (n.length > NOTE_MAX ? `${n.slice(0, NOTE_MAX - 1)}\u2026` : n));
  const tail = [...safeNotes, ...(tailAt < 0 ? [] : lines.slice(tailAt))];
  const full = [...head, ...tail].join('\n');
  if (full.length <= MAX_REPLY) return full;
  // The tail (notes, basis, next questions) always survives: budget the head by its real length.
  const budget = MAX_REPLY - tail.join('\n').length - MARKER.length - 2;
  const kept: string[] = [];
  let used = 0;
  for (const l of head) if ((used += l.length + 1) <= budget) kept.push(l); else break;
  return [...kept, MARKER, ...tail].join('\n');
}

function done(a: Answer, world: World, notes: string[] = []): AIResponse {
  const rejected = rejectedNote(world);
  return reply(bound(render(a, world.asOf), rejected ? [...notes, rejected] : notes), a.referenced);
}

/** Entities named in the question that the answer does not cover (other kinds too). */
function alsoNamed(world: World, chosen: Scope, mentions: Mention[]): Scope[] {
  const owner = chosen.kind === 'workload' ? world.workloads.find((w) => w.id === chosen.id) : undefined;
  const out: Scope[] = [];
  for (const m of mentions) {
    const sc = m.scope;
    if (sc.kind === 'portfolio' || sameScope(sc, chosen) || out.some((o) => sameScope(o, sc))) continue;
    if (owner && ((sc.kind === 'team' && sc.team === owner.team) || (sc.kind === 'model' && sc.model === owner.model))) continue;
    out.push(sc);
  }
  return out;
}

const NAMEABLE: ReadonlySet<Intent> = new Set(['roi', 'workloads', 'tokens', 'alerts', 'outcomes', 'ebitda', 'migration']);

// Read-only intents a bare follow-up ("what about Revenue?") may carry over.
const INHERITABLE: ReadonlySet<Intent> = new Set(['roi', 'workloads', 'tokens', 'alerts', 'outcomes', 'savings', 'cost_driver']);

/** The question a bare follow-up repeats: the latest earlier user turn with a read-only intent. */
function previousIntent(history: AIMessage[], world: World): Intent | null {
  const recent = history.slice(-MAX_HISTORY);
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m?.role !== 'user' || typeof m.content !== 'string') continue;
    const t = m.content.slice(0, 500);
    const ms = findMentions(t, world);
    const sub = pickSubject(ms);
    const intent = classifyIntent(t.toLowerCase(), {
      hasEntity: sub !== null && sub.scope.kind !== 'portfolio',
      namesTeam: namesTeam(ms),
      backRef: false,
    });
    if (INHERITABLE.has(intent)) return intent;
  }
  return null;
}

/** The question text with portfolio words removed (they are scope, not a legacy keyword). */
function withoutPortfolio(text: string, ranges: { start: number; end: number }[]): string {
  let out = text;
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + ' ' + out.slice(r.end);
  return out;
}

function lastUserIndex(messages: AIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') return i;
  return -1;
}

export function respond(messages: AIMessage[], context: AIContext): AIResponse {
  const at = lastUserIndex(Array.isArray(messages) ? messages : []);
  if (at < 0) return help();
  const raw = messages[at].content;
  if (typeof raw !== 'string') return help();
  const text = raw.slice(0, MAX_TEXT);
  const lower = text.toLowerCase();
  if (GREETING.test(lower)) return help();

  const world = buildWorld(context);
  const mentions = findMentions(text, world);
  const subject = pickSubject(mentions);
  const explicit = subject !== null && subject.scope.kind !== 'portfolio';
  const ref = detectReference(lower);
  const elliptical = isElliptical(lower);
  const backRef = !subject && (ref.kind !== 'none' || elliptical);

  let intent = classifyIntent(lower, { hasEntity: explicit, namesTeam: namesTeam(mentions), backRef });
  if (intent === 'legacy' && (elliptical || subject !== null)) {
    const portfolioRanges = mentions.filter((m) => m.scope.kind === 'portfolio');
    if (classifyLegacy(withoutPortfolio(text, portfolioRanges)) === 'help') {
      intent = previousIntent(messages.slice(0, at), world) ?? intent;
    }
  }

  // Scope: a named entity always wins; otherwise a back-reference reads the
  // bounded history; otherwise the portfolio.
  let scope: Scope = { kind: 'portfolio' };
  let unresolved: 'team' | 'workload' | 'model' | 'any' | null = null;
  if (subject) scope = subject.scope;
  else if (backRef) {
    const focus = deriveFocus(messages.slice(0, at), world);
    if (focus === null && ref.kind === 'none') scope = { kind: 'portfolio' };
    else {
      const res = resolveReference(ref, focus, world);
      if (res.ok) scope = res.scope;
      else unresolved = res.wanted;
    }
  }
  const others = subject && explicit ? alsoNamed(world, scope, mentions) : [];
  const notes: string[] = [];
  if (others.length > 0) {
    notes.push(`Note: you also named ${others.map((o) => scopeLabel(world, o)).join(', ')}; I answered for ${scopeLabel(world, scope)} only \u2014 ask about the others separately.`);
  }

  // An unrecognized named team is reported plainly, before any back-reference or default scope,
  // and also next to a recognized entity ("ROI of Legal and the Finance team").
  if (intent !== 'forecast' && intent !== 'capability') {
    const team = unknownTeam(text, mentions);
    if (team && !explicit) return reply(unknownNameText(world, { name: team, team: true }));
    const alongside = explicit && !team ? unknownAlongside(text, mentions) : null;
    if (team) notes.push(`Note: I don't have a team called ${team}; I answered for ${scopeLabel(world, scope)} only.`);
    else if (alongside) notes.push(`Note: I don't have a team, workload or model called "${alongside}"; I answered for ${scopeLabel(world, scope)} only.`);
    else if (!subject && !backRef && (NAMEABLE.has(intent) || intent === 'legacy' || intent === 'savings' || intent === 'cost_driver')) {
      const name = unknownCapitalized(text);
      if (name) return reply(unknownNameText(world, { name, team: false }));
    }
  }

  const needsScope = intent !== 'forecast' && intent !== 'capability' && intent !== 'team_rank';
  if (needsScope && unresolved && intent !== 'legacy' && intent !== 'savings' && intent !== 'cost_driver') {
    return reply(clarifyText(world, unresolved));
  }

  switch (intent) {
    case 'forecast':
      return reply(unsupportedText(world, 'I do not forecast: the mock has the seeded run-rate and month-over-month trend, not a forecast model.'));
    case 'capability':
      return done(capabilityAnswer(world), world);
    case 'migration': {
      const { overrides, ignored } = parseOverrides(text);
      return done(migrationAnswer(world, scope, overrides, ignored), world, notes);
    }
    case 'ebitda':
      return done(ebitdaAnswer(world, scope, parseReduction(text), parseBaselines(text)), world, notes);
    case 'outcomes':
      return done(outcomesAnswer(world, scope), world, notes);
    case 'alerts':
      return done(alertsAnswer(world, scope), world, notes);
    case 'tokens':
      return done(tokensAnswer(world, scope), world, notes);
    case 'team_rank': {
      if (world.teams.length === 0) {
        const a = costDriverAnswer(world, { kind: 'portfolio' });
        return done({
          ...a,
          header: '**Team data is not available**',
          body: ['Team data is not present in this context, so I cannot rank teams. Workloads by cost instead:', ...a.body],
        }, world);
      }
      const { metric, ascending } = rankingOf(lower);
      return done(teamRankAnswer(world, metric, ascending), world);
    }
    case 'workloads':
      return done(workloadsAnswer(world, scope), world, notes);
    case 'roi':
      return done(roiAnswer(world, scope), world, notes);
    case 'savings':
      if (!unresolved) return done(savingsAnswer(world, scope), world, notes);
      break;
    case 'cost_driver':
      if (!unresolved) return done(costDriverAnswer(world, scope), world, notes);
      break;
    default:
      break;
  }

  // Legacy path: byte-identical answers for the original keyword questions.
  switch (classifyLegacy(text)) {
    case 'at_risk':
      return atRisk(legacyContext(context, world));
    case 'cost_driver':
      return costDriver(legacyContext(context, world));
    case 'savings':
      return savings(legacyContext(context, world));
    case 'summary':
      return summary(legacyContext(context, world));
    default:
      break;
  }
  // Nothing matched. A named or remembered subject gets its detail view;
  // anything else gets an honest "cannot answer" with the closest questions.
  if (explicit || (backRef && !unresolved)) return done(workloadsAnswer(world, scope), world, notes);
  if (backRef && unresolved && ref.kind !== 'none') return reply(clarifyText(world, unresolved));
  return reply(unsupportedText(world));
}
