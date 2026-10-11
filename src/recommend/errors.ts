// Fixed-text errors for the native savings recommendation engine.
//
// Trust boundary: these errors are thrown only for whole-input refusals of
// INTERNAL callers (an invalid window, an over-cap row array). Untrusted feed
// payloads never throw: the normalizers return counts and a fixed refusal code.
// The message is looked up from a constant table and NEVER built from input, so
// nothing a caller or a feed supplied can appear in an error.

export type RecommendInputErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_WINDOW'
  | 'WINDOW_TOO_LONG'
  | 'TOO_MANY_ROWS'
  | 'TOO_MANY_TERMS'
  | 'TOO_MANY_ITEMS';

export const RECOMMEND_INPUT_ERROR_MESSAGES: Readonly<Record<RecommendInputErrorCode, string>> = {
  INVALID_INPUT: 'recommend: input is not in the expected shape',
  INVALID_WINDOW: 'recommend: window start and end must be ISO-8601 with start before end',
  WINDOW_TOO_LONG: 'recommend: window is longer than the supported lookback',
  TOO_MANY_ROWS: 'recommend: too many rows in one call',
  TOO_MANY_TERMS: 'recommend: too many commitment terms in one call',
  TOO_MANY_ITEMS: 'recommend: too many recommendations in one call',
};

export class RecommendInputError extends Error {
  readonly code: RecommendInputErrorCode;
  constructor(code: RecommendInputErrorCode) {
    super(RECOMMEND_INPUT_ERROR_MESSAGES[code]);
    this.name = 'RecommendInputError';
    this.code = code;
  }
}
