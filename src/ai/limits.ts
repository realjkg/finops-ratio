// Chat size limits shared by the route (pages/api/v1/ai/chat.ts) and the panel that sends to it,
// so the browser never builds a history the route would reject on every later turn.

/** Longest single chat message, in characters (UTF-16 code units, as `String.length` counts; an emoji is 2). */
export const MAX_MESSAGE_CHARS = 10_000;
/** Longest question the simulation chat route accepts (pages/api/v1/simulation/chat.ts); it sends one message, no history. */
export const SIM_MAX_QUESTION_CHARS = 2_000;
/** Opens every inline chat error the panel shows; a user turn followed by one is a failed question. */
export const AI_ERROR_PREFIX = 'AI error: ';

/**
 * `s` cut to at most `max` UTF-16 code units, never between the two halves of a surrogate pair
 * (an emoji): a lone half is malformed text that a provider may reject on every later turn.
 */
export function capChars(s: string, max: number = MAX_MESSAGE_CHARS): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** What the route returns instead of an empty provider reply, so a resent history never holds an empty turn. */
export const NO_ANSWER_TEXT = 'No answer was produced for this question. Ask again or rephrase it.';
/** Most messages in one request. */
export const MAX_MESSAGES = 50;
/**
 * Largest request body the route accepts, in UTF-8 bytes (the gateway's 413 limit). The turn and
 * character limits alone allow far more (about ten maximum-length English turns already exceed it),
 * so the panel drops the oldest turns until the body fits.
 */
export const MAX_REQUEST_BYTES = 100_000;

const utf8 = new TextEncoder();
/** UTF-8 size of a JSON request body, as the server counts it. */
export function requestBytes(body: unknown): number {
  return utf8.encode(JSON.stringify(body)).length;
}

type Turn = { role: 'user' | 'assistant'; content: string };

/**
 * The history the panel sends: turns cut to MAX_MESSAGE_CHARS and then non-empty only (so cutting
 * cannot leave a blank turn), at most MAX_MESSAGES of them, starting with a user turn (a provider may
 * require it), and small enough that the whole body (with `extra` fields) fits in MAX_REQUEST_BYTES.
 * The oldest turns go first; the last turn, the new question, is always kept. The route rejects a
 * blank, over-long or over-budget history, and because the history is resent on every turn, one
 * rejected history would make every later question fail too.
 */
export function fitHistory<T extends Turn>(turns: readonly T[], extra: Record<string, unknown> = {}): Turn[] {
  let kept: Turn[] = turns
    .map((t) => ({ role: t.role, content: capChars(t.content) }))
    .filter((t) => t.content.trim() !== '')
    .slice(-MAX_MESSAGES);
  const trimLeadingAssistant = () => { while (kept.length > 1 && kept[0].role !== 'user') kept = kept.slice(1); };
  trimLeadingAssistant();
  while (kept.length > 1 && requestBytes({ messages: kept, ...extra }) > MAX_REQUEST_BYTES) {
    kept = kept.slice(1);
    trimLeadingAssistant();
  }
  return kept;
}
