// The fixed first lines of Frank's conversational and meta replies (small talk,
// identity, capability, legacy help). They never name a subject, so conversation
// memory skips them: otherwise a team that happens to be called "FinOps",
// "Welcome" or "What" would become the remembered subject (challenger round 15).
// The replies themselves use these constants, so the list cannot drift.
// No imports: memory.ts, smalltalk.ts, answersMeta.ts and legacy.ts all use it.

export const IDENTITY_HEADER = "**I'm Frank Coster, Ratio's FinOps accountability partner**";
export const DOING_WELL_HEADER = '**Doing well**';
export const GOODBYE_HEADER = '**Goodbye**';
export const WELCOME_HEADER = "**You're welcome**";
export const GOT_IT_HEADER = '**Got it**';
export const CAPABILITY_HEADER = '**What I can answer**';
/** The opening sentence of the legacy help reply (legacy.ts keeps its text byte-identical). */
export const LEGACY_HELP_PREFIX = "I'm Frank Coster, your FinOps accountability partner.";

/** "**Hi — I'm Frank Coster**", "**Good morning — I'm Frank Coster**", ... */
export const greetingHeader = (word: string): string => `**${word} — I'm Frank Coster**`;
const GREETING = /^\*\*[A-Z][a-z]*(?: [a-z]+)? — I'm Frank Coster\*\*$/;

const FIXED: ReadonlySet<string> = new Set([
  IDENTITY_HEADER,
  DOING_WELL_HEADER,
  GOODBYE_HEADER,
  WELCOME_HEADER,
  GOT_IT_HEADER,
  CAPABILITY_HEADER,
]);

/** True for the first line of a reply that never names a subject. */
export function isMetaHeader(firstLine: string): boolean {
  const line = firstLine.trim();
  return FIXED.has(line) || GREETING.test(line) || line.startsWith(LEGACY_HELP_PREFIX);
}
