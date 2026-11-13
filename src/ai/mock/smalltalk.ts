// Small talk: deterministic replies to turns that are ENTIRELY conversational
// (greetings, how-are-you, thanks, acknowledgements, goodbyes, "who are you",
// "where do I start"). A message that carries anything else, a question above
// all, is not small talk and goes to the analytic router unchanged, so every
// existing answer stays byte for byte the same.
//
// Pure: no I/O, no clock, no randomness. The only figures shown are counts and
// spend read from the dataset, with the usual source line. Headers never name a
// team, workload or model, so conversation memory (which reads answer headers)
// keeps the subject the user was discussing.

import { capabilityAnswer, starterQuestions } from './answersMeta';
import { ladder } from './answerKit';
import { rollup } from './calc';
import { usd } from './format';
import type { Answer, Scope, World } from './types';

export type SmallTalkKind = 'greeting' | 'how_are_you' | 'thanks' | 'acknowledge' | 'farewell' | 'identity' | 'start';

const MAX_SMALL_TALK = 120;

/** Phrases per kind, matched at the start of the remaining text, longest first within each kind. */
const PHRASES: ReadonlyArray<[SmallTalkKind, RegExp]> = [
  ['identity', /^(?:who are you|what are you|who is frank|who s frank|what is frank|what s frank|introduce yourself|tell me about yourself|what is your name|what s your name|whats your name|are you (?:an? )?(?:ai|bot|robot|chatbot|real|human|person|llm|chatgpt|language model))\b/],
  ['start', /^(?:where (?:do|should|can) i (?:start|begin)|what (?:should|can|could) i ask(?: you)?|how do i use (?:this|you|ratio|frank)|how does this work|how do you work|can you help(?: me)?|help me(?: out)?|i need help|what do you do)\b/],
  ['how_are_you', /^(?:how are you(?: doing)?(?: today)?|how are things|how s it going|hows it going|how is it going|how have you been|what s up|whats up|sup)\b/],
  ['greeting', /^(?:good (?:morning|afternoon|evening|day)|hi there|hello there|hey there|hiya|howdy|heya|hello|hey|hi|yo|greetings)\b/],
  ['thanks', /^(?:thank you(?: so much| very much)?|thanks(?: a lot| so much)?|many thanks|much appreciated|appreciate it|thx|ty|cheers)\b/],
  ['farewell', /^(?:good ?bye|bye(?: bye)?|see you(?: later| soon)?|that s all|thats all|that is all|i m done|im done|done for now|have a (?:good|great|nice) (?:day|one)|take care|later)\b/],
  ['acknowledge', /^(?:sounds good|got it|makes sense|all right|alright|understood|i see|okay|ok|cool|great|nice|perfect|awesome|excellent|good)\b/],
];

/** Words that may surround small talk without changing it (the user addressing Frank, filler). */
const FILLER = /^(?:frank(?: coster)?|there|team|everyone|all|so|and|well|oh|please|again|then|very|much)\b/;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/'/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The small-talk kinds a message consists of, in order, or null when anything
 * in it is not small talk (a question, a name, a number). `help` alone is not
 * matched here: it keeps its original legacy reply.
 */
export function smallTalkKinds(text: string): SmallTalkKind[] | null {
  if (typeof text !== 'string' || text.length > MAX_SMALL_TALK) return null;
  // A number or amount is data the user typed: never acknowledge it and drop it.
  if (/[0-9%$€£]/.test(text)) return null;
  let rest = normalize(text);
  if (rest === '' || rest === 'help') return null;
  const kinds: SmallTalkKind[] = [];
  while (rest.length > 0) {
    const filler = FILLER.exec(rest);
    if (filler) {
      rest = rest.slice(filler[0].length).trimStart();
      continue;
    }
    const hit = PHRASES.map(([kind, rx]) => ({ kind, m: rx.exec(rest) })).find((h) => h.m !== null);
    if (!hit || !hit.m) return null;
    if (!kinds.includes(hit.kind)) kinds.push(hit.kind);
    rest = rest.slice(hit.m[0].length).trimStart();
  }
  if (kinds.length === 0) return null;
  // "that's all?", "ok?", "later?" ask something: only identity, start, greeting and
  // how-are-you may end in a question mark.
  if (/\?\s*$/.test(text) && kinds.every((k) => k === 'acknowledge' || k === 'farewell' || k === 'thanks')) return null;
  return kinds;
}

/** Polite idioms whose "there" or "it" never points back at a subject ("hi there", "appreciate it"). */
const IDIOMS = /\b(?:(?:hi|hey|hello) there|appreciate it)\b/g;

/** Lower-cased text with those idioms blanked, for the back-reference check on small talk. */
export function withoutIdioms(lower: string): string {
  return lower.replace(IDIOMS, ' ');
}

/** The greeting word to echo back, capitalized ("good morning" -> "Good morning"). */
function greetingWord(text: string): string {
  const n = normalize(text);
  const m = /\b(good (?:morning|afternoon|evening|day)|hello|hey|howdy|greetings)\b/.exec(n);
  const w = m?.[1] ?? 'hi';
  const shown = w === 'greetings' ? 'hello' : w;
  return shown.charAt(0).toUpperCase() + shown.slice(1);
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function dataLine(world: World): string {
  if (world.workloads.length === 0) return 'No workloads are in this view yet.';
  const r = rollup(world.workloads);
  const teams = world.teams.length > 0 ? ` across ${plural(world.teams.length, 'team')}` : '';
  const spend = r.spend > 0 ? `, ${usd(r.spend)}/mo of spend` : '';
  return `In this view: ${plural(world.workloads.length, 'workload')}${teams}${spend}.`;
}

/** Next questions: a drill-down on the subject under discussion, else the starter questions. */
function suggestions(world: World, focus: Scope | null): string[] {
  if (focus && focus.kind !== 'portfolio') {
    const next = ladder(world, focus, 'roi');
    if (next.length > 0) return next;
  }
  return starterQuestions(world);
}

const IDENTITY =
  "I'm Ratio's FinOps accountability partner. I'm a deterministic assistant, not a generative AI model: fixed rules compute every answer from the data in this view, the same question in the same conversation always gets the same answer, and I say plainly when something is outside the data.";
const HOW_ARE_YOU =
  "I'm running well, thanks for asking. I'm a deterministic assistant, so the same question in the same conversation always gets the same answer.";
const TOPICS =
  'I can help with ROI and Value / cost, team and workload costs, tokens and cache, alerts, outcome evidence, savings, EBITDA impact and moving a workload to a private open model.';

/** The reply for a small-talk turn. `focus` is the subject from the conversation so far, if any. */
export function smallTalkAnswer(kinds: SmallTalkKind[], text: string, world: World, focus: Scope | null): Answer {
  const next = suggestions(world, focus);
  const base = { referenced: [] as string[] };
  if (kinds.includes('start')) return capabilityAnswer(world);
  if (kinds.includes('identity')) {
    const how = kinds.includes('how_are_you') ? [HOW_ARE_YOU] : [];
    return { ...base, header: "**I'm Frank Coster**", body: [...how, IDENTITY, TOPICS, dataLine(world)], next };
  }
  if (kinds.includes('greeting')) {
    const body = [
      ...(kinds.includes('how_are_you') ? [HOW_ARE_YOU] : []),
      "I'm Ratio's FinOps accountability partner. Ask me about cost, value and savings, and I'll show where every figure comes from.",
      dataLine(world),
      'Good places to start are below, or ask "What can you answer?" for the full list.',
    ];
    return { ...base, header: `**${greetingWord(text)} — I'm Frank Coster**`, body, next };
  }
  if (kinds.includes('how_are_you')) {
    return { ...base, header: '**Doing well**', body: [HOW_ARE_YOU, 'What would you like to look at?'], next };
  }
  if (kinds.includes('farewell')) {
    const welcome = kinds.includes('thanks') ? ["You're welcome."] : [];
    return { ...base, header: '**Goodbye**', body: [...welcome, 'Thanks for the conversation. Come back any time with a question about cost, value or savings.'], next: [] };
  }
  if (kinds.includes('thanks')) {
    return { ...base, header: "**You're welcome**", body: ['Happy to help. Want to go a level deeper?'], next };
  }
  return { ...base, header: '**Got it**', body: ['What would you like to look at next?'], next };
}
