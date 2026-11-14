// Chat size limits shared by the route (pages/api/v1/ai/chat.ts) and the panel that sends to it,
// so the browser never builds a history the route would reject on every later turn.

/** Longest single chat message, in characters (UTF-16 code units, as `String.length` counts). */
export const MAX_MESSAGE_CHARS = 10_000;
/** Most messages in one request. */
export const MAX_MESSAGES = 50;
/**
 * Largest request body the route accepts, in UTF-8 bytes (the gateway's 413 limit). 50 turns of
 * 10,000 characters can exceed it, especially in scripts that take 3 bytes per character, so the
 * panel drops the oldest turns until the body fits.
 */
export const MAX_REQUEST_BYTES = 100_000;

const utf8 = new TextEncoder();
/** UTF-8 size of a JSON request body, as the server counts it. */
export function requestBytes(body: unknown): number {
  return utf8.encode(JSON.stringify(body)).length;
}

type Turn = { role: 'user' | 'assistant'; content: string };

/**
 * The history the panel sends: non-empty turns only, each at most MAX_MESSAGE_CHARS, at most
 * MAX_MESSAGES of them, starting with a user turn, and small enough that the whole body (with
 * `extra` fields) fits in MAX_REQUEST_BYTES. The oldest turns go first; the last turn, the new
 * question, is always kept. The route would reject anything else, and because the history is
 * resent on every turn, one rejected history would make every later question fail too.
 */
export function fitHistory<T extends Turn>(turns: readonly T[], extra: Record<string, unknown> = {}): Turn[] {
  let kept: Turn[] = turns
    .filter((t) => t.content.trim() !== '')
    .map((t) => ({ role: t.role, content: t.content.length > MAX_MESSAGE_CHARS ? t.content.slice(0, MAX_MESSAGE_CHARS) : t.content }))
    .slice(-MAX_MESSAGES);
  const trimLeadingAssistant = () => { while (kept.length > 1 && kept[0].role !== 'user') kept = kept.slice(1); };
  trimLeadingAssistant();
  while (kept.length > 1 && requestBytes({ messages: kept, ...extra }) > MAX_REQUEST_BYTES) {
    kept = kept.slice(1);
    trimLeadingAssistant();
  }
  return kept;
}
