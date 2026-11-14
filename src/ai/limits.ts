// Chat size limits shared by the route (pages/api/v1/ai/chat.ts) and the panel that sends to it,
// so the browser never builds a history the route would reject on every later turn.

/** Longest single chat message, in characters (UTF-16 code units, as `String.length` counts). */
export const MAX_MESSAGE_CHARS = 10_000;
/** Most messages in one request. */
export const MAX_MESSAGES = 50;
