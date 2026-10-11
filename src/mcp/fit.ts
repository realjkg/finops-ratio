// Result size cap with an explicit truncation marker (brief for checklist 5.4; DESIGN
// 3.6 prefers rejection, so both modes exist and the policy chooses). Purpose: make a
// serialized result fit maxBytes, or say it cannot. Trust boundary: this runs after
// redaction, so cutting an array can never leave half of a secret behind, and it only
// removes array elements, never edits a value. Truncation is never silent: the body
// gets "truncated": true and a "truncation" object naming the reason, the number of
// items omitted and the cap, so a reader (or a model) knows rows are missing. Totals
// that the provider computed over all rows are left as they were.
import { utf8Length, type JsonValue } from './jsonSafe';

export type FitResult = { ok: true; text: string; truncated: boolean } | { ok: false };

export const MAX_FIT_PASSES = 64;

/** The longest array under `root` (first one on a tie), or undefined if there is none. */
function longestArray(root: JsonValue): JsonValue[] | undefined {
  let best: JsonValue[] | undefined;
  const stack: JsonValue[] = [root];
  while (stack.length > 0) {
    const v = stack.pop() as JsonValue;
    if (Array.isArray(v)) {
      if (best === undefined || v.length > best.length) best = v;
      for (const item of v) stack.push(item);
    } else if (v !== null && typeof v === 'object') {
      for (const k of Object.keys(v)) stack.push(v[k]);
    }
  }
  return best;
}

/** Mutates `body.data` (halving the longest array per pass) and adds the marker when it cuts. */
export function fitToBudget(body: { [key: string]: JsonValue }, maxBytes: number, mode: 'truncate' | 'reject'): FitResult {
  let text = JSON.stringify(body);
  if (utf8Length(text) <= maxBytes) return { ok: true, text, truncated: false };
  if (mode === 'reject') return { ok: false };
  let omitted = 0;
  for (let pass = 0; pass < MAX_FIT_PASSES; pass += 1) {
    const longest = longestArray(body.data);
    if (longest === undefined || longest.length === 0) return { ok: false };
    const keep = Math.floor(longest.length / 2);
    omitted += longest.length - keep;
    longest.length = keep;
    body.truncated = true;
    body.truncation = { reason: 'result_size_cap', omitted_items: omitted, max_bytes: maxBytes };
    text = JSON.stringify(body);
    if (utf8Length(text) <= maxBytes) return { ok: true, text, truncated: true };
  }
  return { ok: false };
}
