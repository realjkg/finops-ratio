// Size, depth and time caps for the MCP core (DESIGN 3.6, OD-8). Purpose: one frozen
// table of defaults and one hard ceiling per cap. Trust boundary: a caller may lower
// any cap or raise it up to its ceiling, never above; a missing, non-finite or
// non-integer override falls back to the default. The default values are placeholders
// the design says have no measurement behind them (OD-8), not tuned numbers.

export interface McpLimits {
  /** UTF-8 bytes of one incoming message. */
  maxMessageBytes: number;
  /** Nesting depth of containers in one incoming message. */
  maxMessageDepth: number;
  /** Values (of any type) in one incoming message. */
  maxMessageNodes: number;
  /** UTF-8 bytes of any single string in an incoming message. */
  maxStringBytes: number;
  /** UTF-8 bytes of any single object key. */
  maxKeyBytes: number;
  /** UTF-8 bytes of a tool's canonical arguments (DESIGN 3.3 max_arg_bytes, 2 KB). */
  maxArgBytes: number;
  /** UTF-8 bytes of the delivered result text (DESIGN 3.3 max_result_bytes, 32 KB). */
  maxResultBytes: number;
  /** Per-call time budget for the data provider (DESIGN 3.3 timeout_ms, 5 s). */
  toolTimeoutMs: number;
  /** Time budget for one audit write; a slow sink fails the call closed. */
  auditTimeoutMs: number;
  /** UTF-8 bytes (approximate) of one data-provider result before redaction and the result cap. */
  maxOutputBytes: number;
  /** Values in one data-provider result before any cap is applied. */
  maxOutputNodes: number;
  /** Nesting depth of one data-provider result. */
  maxOutputDepth: number;
}

export const DEFAULT_LIMITS: Readonly<McpLimits> = Object.freeze({
  maxMessageBytes: 8_192,
  maxMessageDepth: 8,
  maxMessageNodes: 512,
  maxStringBytes: 2_048,
  maxKeyBytes: 64,
  maxArgBytes: 2_048,
  maxResultBytes: 32_768,
  toolTimeoutMs: 5_000,
  auditTimeoutMs: 2_000,
  maxOutputBytes: 262_144,
  maxOutputNodes: 20_000,
  maxOutputDepth: 8,
});

export const HARD_LIMITS: Readonly<McpLimits> = Object.freeze({
  maxMessageBytes: 65_536,
  maxMessageDepth: 16,
  maxMessageNodes: 4_096,
  maxStringBytes: 16_384,
  maxKeyBytes: 128,
  maxArgBytes: 16_384,
  maxResultBytes: 262_144,
  toolTimeoutMs: 30_000,
  auditTimeoutMs: 10_000,
  maxOutputBytes: 1_048_576,
  maxOutputNodes: 100_000,
  maxOutputDepth: 12,
});

const KEYS = Object.keys(DEFAULT_LIMITS) as (keyof McpLimits)[];

/** Defaults overlaid with the valid overrides, each clamped to [1, hard ceiling]. */
export function resolveLimits(overrides?: Partial<McpLimits>): McpLimits {
  const out = { ...DEFAULT_LIMITS };
  if (overrides === null || typeof overrides !== 'object') return out;
  for (const key of KEYS) {
    const v = Object.hasOwn(overrides, key) ? overrides[key] : undefined;
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1) out[key] = Math.min(v, HARD_LIMITS[key]);
  }
  return out;
}
