// Conversation memory: a small typed focus derived ONLY from the messages the
// route already passes. Bounded in both directions: at most MAX_HISTORY prior
// messages are looked at, user text is read for at most USER_SCAN characters,
// assistant text only on its first line (every answer puts exactly one subject
// in its header line), and system messages are ignored.

import type { AIMessage } from '../AIClient';
import { findMentions, pickSubject } from './entities';
import type { Scope, World } from './types';

export const MAX_HISTORY = 12;
const USER_SCAN = 500;
const ASSISTANT_SCAN = 300;

/** Most recent subject in the bounded history, or null when there is none. */
export function deriveFocus(history: AIMessage[], world: World): Scope | null {
  const recent = history.slice(-MAX_HISTORY);
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (typeof m?.content !== 'string') continue;
    let text: string;
    if (m.role === 'user') text = m.content.slice(0, USER_SCAN);
    else if (m.role === 'assistant') text = (m.content.split('\n', 1)[0] ?? '').slice(0, ASSISTANT_SCAN);
    else continue;
    const subject = pickSubject(findMentions(text, world));
    if (subject) return subject.scope;
  }
  return null;
}

type Reference =
  | { kind: 'none' }
  | { kind: 'bare' } // it / its / they / there ...
  | { kind: 'team' | 'workload' | 'model' }; // "the same team", "that workload" ...

/**
 * Does the question refer back to something said earlier? Deliberately narrow:
 * "that" / "this" alone are too common in ordinary sentences to count.
 */
export function detectReference(lower: string): Reference {
  const typed = /\b(?:the same|that|this|the above|same)\s+(team|group|department|workload|model|one)\b/.exec(lower);
  if (typed) {
    const k = typed[1];
    if (k === 'team' || k === 'group' || k === 'department') return { kind: 'team' };
    if (k === 'workload') return { kind: 'workload' };
    if (k === 'model') return { kind: 'model' };
    return { kind: 'bare' };
  }
  if (/(?<![\w-])(?:it|its|they|them|their|theirs)(?![\w-])|(?<![\w-])there\s*[?.!]*\s*$/.test(lower)) return { kind: 'bare' };
  if (/(?:about|of|for|on|in)\s+(?:that|this)\s*[?.!]*\s*$/.test(lower)) return { kind: 'bare' };
  return { kind: 'none' };
}

/** "and ...", "what about ...", "how about ...", "then ..." opener. */
export function isElliptical(lower: string): boolean {
  return /^\s*(?:and|what about|how about|what of|then|ok(?:ay)?|so|also)\b/.test(lower);
}

type Resolution =
  | { ok: true; scope: Scope }
  | { ok: false; wanted: 'team' | 'workload' | 'model' | 'any' };

/** Coerce the remembered focus to the kind a typed reference asks for. */
export function resolveReference(ref: Reference, focus: Scope | null, world: World): Resolution {
  if (!focus) return { ok: false, wanted: ref.kind === 'none' || ref.kind === 'bare' ? 'any' : ref.kind };
  if (ref.kind === 'none' || ref.kind === 'bare') return { ok: true, scope: focus };
  const owner = focus.kind === 'workload' ? world.workloads.find((w) => w.id === focus.id) : undefined;
  if (ref.kind === 'team') {
    if (focus.kind === 'team') return { ok: true, scope: focus };
    if (owner?.team) return { ok: true, scope: { kind: 'team', team: owner.team } };
  }
  if (ref.kind === 'workload' && focus.kind === 'workload') return { ok: true, scope: focus };
  if (ref.kind === 'model') {
    if (focus.kind === 'model') return { ok: true, scope: focus };
    if (owner?.model) return { ok: true, scope: { kind: 'model', model: owner.model } };
  }
  return { ok: false, wanted: ref.kind };
}
