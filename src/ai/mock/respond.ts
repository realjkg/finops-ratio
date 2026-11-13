// The router: one pure function from (messages, context) to a response. No
// I/O, no clock, no randomness. Order of work:
//   1. take the last user message (bounded); "help" -> legacy help; a turn that
//      is entirely small talk (greeting, thanks, who are you...) -> smalltalk.ts
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
import { MAX_TEXT, findMentions, namesTeam, pickSubject, sameScope, unknownCapitalized, unknownTeam, type Mention } from './entities';
import { MAX_HISTORY, deriveFocus, detectReference, isElliptical, resolveReference } from './memory';
import { classifyIntent, classifyLegacy, rankingOf, type Intent } from './intents';
import { atRisk, costDriver, help, savings, summary } from './legacy';
import { SOURCE_PREFIX, render } from './format';
import { scopeLabel } from './calc';
import { buildWorld, legacyContext } from './world';
import { smallTalkAnswer, smallTalkKinds, withoutIdioms } from './smalltalk';
import type { Answer, Scope, World } from './types';

const LEGACY_HELP = /^\s*(?:help|\?)\W*$/;

function reply(content: string, referenced: string[] = []): AIResponse {
  return { message: { role: 'assistant', content }, initiativesReferenced: referenced, provider: 'mock' };
}

const MAX_REPLY = 8000;

const NOTE_MAX = 300;
const MARKER = '\u2026(answer shortened to fit; ask a narrower question for the rest)';

/** Keep the header and the tail (notes, basis, next questions); shorten the middle if it is huge. */
function bound(text: string, notes: string[] = []): string {
  const lines = text.split('\n');
  const tailAt = lines.findIndex((l) => l.startsWith(SOURCE_PREFIX));
  const head = tailAt < 0 ? lines : lines.slice(0, tailAt);
  const safeNotes = notes.map((n) => (n.length > NOTE_MAX ? `${n.slice(0, NOTE_MAX / 2 - 1)}\u2026${n.slice(-NOTE_MAX / 2)}` : n));
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

const LEGACY = { at_risk: atRisk, cost_driver: costDriver, savings, summary };
const NAMEABLE: ReadonlySet<Intent> = new Set(['roi', 'workloads', 'tokens', 'alerts', 'outcomes', 'ebitda', 'migration']);

// Read-only intents a bare follow-up ("what about Revenue?") may carry over.
const INHERITABLE: ReadonlySet<Intent> = new Set(['roi', 'workloads', 'tokens', 'alerts', 'outcomes', 'savings', 'cost_driver']);

/** The question a bare follow-up repeats: the latest earlier user turn with a read-only intent. */
/** Frank's surname in any form: "Frank Coster", "Frank Costers", "frankcoster", "Coster", possessives. */
const NAME_RX = /\b(?:frank\s*)?coster(?:(['’]s)|s)?\b/gi;
const FRANK = "(?:frank(?:\\s*coster(?:['\u2019]s|s)?)?|coster(?:['\u2019]s|s)?)";
/** Frank addressed by name at the start ("Coster, ...") or at the end ("..., Frank?", "..., Frank 🙂"). */
const LEADING_ADDRESS = new RegExp(`^\\s*${FRANK}\\s*,`, 'i');
const TRAILING_ADDRESS = new RegExp(`,\\s*${FRANK}[\\s\\p{P}\\p{S}\\p{M}\\p{Cf}]*$`, 'iu'); // emoji sequences included

/**
 * The typed text with the words that address Frank blanked out (same length, so entity
 * positions still line up). Unknown names are looked for here: "ROI of Legal, Coster?"
 * names nothing unknown, while "ROI of Coster" and "Coster, ROI of Coster" ask about
 * something named Coster. A span inside a named entity is never blanked.
 */
function withoutAddress(t: string, mentions: Mention[]): string {
  const blank = (m: string, at: number): string =>
    mentions.some((n) => n.scope.kind !== 'portfolio' && n.start < at + m.length && at < n.end) ? m : ' '.repeat(m.length);
  return t.replace(LEADING_ADDRESS, (m: string, at: number) => blank(m, at)).replace(TRAILING_ADDRESS, (m: string, at: number) => blank(m, at));
}

/**
 * The text the question type is read from. "Coster" contains "cost", so Frank's surname
 * would route a question to cost: every form of his name becomes "Frank" ("Frank's" for a
 * possessive), except inside a team, workload or model named in the data ("Coster
 * Pipeline", the "Costers" team). Used only for classification, never to find data or to
 * quote a name, so it can never create or change an entity mention.
 */
function routingText(t: string, world: World): string {
  const named = findMentions(t, world).filter((m) => m.scope.kind !== 'portfolio');
  return t.replace(NAME_RX, (m: string, possessive: string | undefined, at: number) =>
    named.some((n) => n.start < at + m.length && at < n.end) ? m : possessive ? "Frank's" : 'Frank',
  );
}

function previousIntent(history: AIMessage[], world: World): Intent | null {
  const recent = history.slice(-MAX_HISTORY);
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m?.role !== 'user' || typeof m.content !== 'string') continue;
    const t = m.content.slice(0, 500);
    const ms = findMentions(t, world);
    const sub = pickSubject(ms);
    const intent = classifyIntent(routingText(t, world).toLowerCase(), {
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

/** Legacy answers must not silently skip rejected workloads; valid contexts add nothing. */
function withRejected(r: AIResponse, world: World): AIResponse {
  return reply(bound(r.message.content, [rejectedNote(world) ?? ''].filter(Boolean)), r.initiativesReferenced);
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
  const world = buildWorld(context);
  // Names are always read from the words the user typed, so data is found (and an unknown
  // name is quoted) exactly as written. Only the question type is read from `routed`,
  // where Frank's own name never means cost (see routingText).
  const text = raw.slice(0, MAX_TEXT);
  const mentions = findMentions(text, world);
  const routed = routingText(text, world);
  const lower = routed.toLowerCase();
  if (LEGACY_HELP.test(lower)) return help();

  const subject = pickSubject(mentions);
  const explicit = subject !== null && subject.scope.kind !== 'portfolio';
  const ref = detectReference(lower);
  const elliptical = isElliptical(lower);
  const backRef = !subject && (ref.kind !== 'none' || elliptical);

  // Small talk: only a turn that is entirely conversational, names no data and does not
  // point back at a remembered subject ("how is it going?" after an answer is a follow-up).
  const talk = smallTalkKinds(routed);
  if (talk && !mentions.some((m) => m.scope.kind !== 'portfolio')) {
    const focus = deriveFocus(messages.slice(0, at), world);
    // Skip small talk only when the raw text and the idiom-masked text both point
    // back: the analytic path reads the raw text, so the two must agree.
    const pointsBack = ref.kind !== 'none' && detectReference(withoutIdioms(lower)).kind !== 'none';
    if (!(pointsBack && focus !== null)) return done(smallTalkAnswer(talk, routed, world, focus), world);
  }

  let intent = classifyIntent(lower, { hasEntity: explicit, namesTeam: namesTeam(mentions), backRef });
  if (intent === 'legacy' && (elliptical || subject !== null)) {
    const portfolioRanges = mentions.filter((m) => m.scope.kind === 'portfolio');
    if (classifyLegacy(routingText(withoutPortfolio(text, portfolioRanges), world)) === 'help') {
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
  const only = `I answered for ${scopeLabel(world, scope)} only`;
  const notes = others.length > 0 ? [`Note: you also named ${others.map((o) => scopeLabel(world, o)).join(', ')}; ${only} \u2014 ask about the others separately.`] : [];

  // An unrecognized name is reported plainly (before any back-reference or default scope), also next
  // to a recognized entity ("ROI of Legal and the Finance team"); it is never silently substituted.
  if (intent !== 'forecast' && intent !== 'capability') {
    const asked = withoutAddress(text, mentions);
    const team = unknownTeam(asked, mentions);
    if (team && !explicit) return reply(unknownNameText(world, { name: team, team: true }));
    const lone = !subject && !backRef && (NAMEABLE.has(intent) || intent === 'legacy' || intent === 'savings' || intent === 'cost_driver');
    const name = team || !(explicit || lone) ? null : unknownCapitalized(asked, explicit ? mentions : []);
    if (team) notes.push(`Note: I don't have a team called ${team}; ${only}.`);
    else if (name && explicit) notes.push(`Note: I don't have a team, workload or model called "${name}"; ${only}.`);
    else if (name) return reply(unknownNameText(world, { name, team: false }));
  }

  const needsScope = intent !== 'forecast' && intent !== 'capability' && intent !== 'team_rank';
  if (needsScope && unresolved && intent !== 'legacy' && intent !== 'savings' && intent !== 'cost_driver') {
    return reply(clarifyText(world, unresolved));
  }

  switch (intent) {
    case 'forecast':
      return reply(unsupportedText(world, 'I do not forecast: the mock has the run-rate and month-over-month trend, not a forecast model.'));
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
  const legacy = classifyLegacy(routed);
  if (legacy !== 'help') return withRejected(LEGACY[legacy](legacyContext(context, world)), world);
  // Nothing matched. A named or remembered subject gets its detail view;
  // anything else gets an honest "cannot answer" with the closest questions.
  if (explicit || (backRef && !unresolved)) return done(workloadsAnswer(world, scope), world, notes);
  if (backRef && unresolved && ref.kind !== 'none') return reply(clarifyText(world, unresolved));
  return reply(unsupportedText(world));
}
