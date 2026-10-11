// Shared plumbing for the native feed normalizers.
//
// FIELD MAPPINGS ARE BASED ON DOCUMENTED RESPONSE SHAPES AND HAVE NOT BEEN
// CHECKED AGAINST LIVE API RESPONSES (this build cannot call those APIs). Each
// provider module restates this. They MUST be validated against live responses
// before any figure from them is trusted.
//
// Trust boundary: payloads are untrusted parsed JSON. Parsing is strict about
// every field it reads (type, range, length) and tolerant of extra fields. One
// bad item never throws and never poisons the batch: it is counted and the
// batch continues. Whole-payload problems (unrecognized envelope, over the item
// cap) return a fixed refusal code and a count, not an exception.

import { isRecord, own, validateNativeRecommendation } from './validate';
import {
  CATEGORY_DEFAULTS,
  MAX_FEED_ITEMS,
  REFUSAL_MESSAGES,
  type Level,
  type NativeRecommendation,
  type NormalizeResult,
  type RecommendationCategory,
  type RecommendationSource,
  type RefusalCode,
  type RejectCode,
  type SkipCode,
} from './types';

export type ItemOutcome =
  | { kind: 'item'; value: NativeRecommendation }
  | { kind: 'skip'; code: SkipCode }
  | { kind: 'reject'; code: RejectCode };

export const reject = (code: RejectCode): ItemOutcome => ({ kind: 'reject', code });
export const skip = (code: SkipCode): ItemOutcome => ({ kind: 'skip', code });

/** Lowercase alphanumerics only: "OVER_PROVISIONED" and "Overprovisioned" both -> "overprovisioned". */
export function token(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.toLowerCase().replace(/[^a-z0-9]/g, '');
  return t.length > 0 ? t : null;
}

/** A short, conservative token safe to embed in an evidence reference; null otherwise. */
export function safeText(v: unknown, max = 64): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) return null;
  return /^[A-Za-z0-9._:/-]+$/.test(v) ? v : null;
}

export function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Builds and validates the final item; any validator rejection becomes a reject outcome. */
export function buildItem(fields: {
  source: RecommendationSource;
  sourceId: string;
  resourceId: string;
  category: RecommendationCategory;
  currentSpendMinor: bigint | null;
  estimatedSavingsMinor: bigint;
  currency: string;
  confidence: Level;
  effort?: Level;
  risk?: Level;
  evidence: Array<string | null>;
}): ItemOutcome {
  const defaults = CATEGORY_DEFAULTS[fields.category];
  const result = validateNativeRecommendation({
    source: fields.source,
    sourceId: fields.sourceId,
    resourceId: fields.resourceId,
    category: fields.category,
    currentSpendMinor: fields.currentSpendMinor,
    estimatedSavingsMinor: fields.estimatedSavingsMinor,
    currency: fields.currency,
    confidence: fields.confidence,
    effort: fields.effort ?? defaults.effort,
    risk: fields.risk ?? defaults.risk,
    evidence: fields.evidence.filter((e): e is string => e !== null),
    period: 'monthly',
    valueContext: 'none_available',
  });
  return result.ok ? { kind: 'item', value: result.value } : { kind: 'reject', code: result.code };
}

/** Accumulates per-item outcomes; the per-item try/catch is what keeps a batch alive. */
export class FeedAccumulator {
  readonly items: NativeRecommendation[] = [];
  rejected = 0;
  skipped = 0;
  readonly rejectedByReason: Partial<Record<RejectCode, number>> = {};
  readonly skippedByReason: Partial<Record<SkipCode, number>> = {};

  run(list: readonly unknown[], parse: (raw: unknown) => ItemOutcome): void {
    for (let i = 0; i < list.length; i++) {
      let out: ItemOutcome;
      try {
        out = parse(list[i]);
      } catch {
        out = reject('unexpected_error');
      }
      if (out.kind === 'item') {
        this.items.push(out.value);
      } else if (out.kind === 'skip') {
        this.skipped++;
        this.skippedByReason[out.code] = (this.skippedByReason[out.code] ?? 0) + 1;
      } else {
        this.rejected++;
        this.rejectedByReason[out.code] = (this.rejectedByReason[out.code] ?? 0) + 1;
      }
    }
  }

  result(source: RecommendationSource): NormalizeResult {
    return {
      source,
      items: this.items,
      rejected: this.rejected,
      skipped: this.skipped,
      rejectedByReason: this.rejectedByReason,
      skippedByReason: this.skippedByReason,
      refused: null,
      refusalMessage: null,
    };
  }
}

export function refusedResult(source: RecommendationSource, code: RefusalCode, rejected: number): NormalizeResult {
  return {
    source,
    items: [],
    rejected,
    skipped: 0,
    rejectedByReason: {},
    skippedByReason: {},
    refused: code,
    refusalMessage: REFUSAL_MESSAGES[code],
  };
}

/**
 * Collects the recognized item lists of an envelope. A recognized key that is
 * present but not an array makes the whole payload unrecognized (strict).
 * Returns null when the payload is not an object or has no recognized list.
 */
export function collectLists(
  payload: unknown,
  keys: readonly string[],
): Array<{ key: string; list: readonly unknown[] }> | null {
  if (!isRecord(payload)) return null;
  const found: Array<{ key: string; list: readonly unknown[] }> = [];
  for (const key of keys) {
    const v = own(payload, key);
    if (v === undefined) continue;
    if (!Array.isArray(v)) return null;
    found.push({ key, list: v });
  }
  return found.length > 0 ? found : null;
}

/** Shared envelope handling: refusal paths, the per-call item cap, then per-list parsing. */
export function normalizeEnvelope(
  source: RecommendationSource,
  payload: unknown,
  parsers: ReadonlyArray<{ key: string; parse: (raw: unknown) => ItemOutcome }>,
): NormalizeResult {
  const lists = collectLists(
    payload,
    parsers.map((p) => p.key),
  );
  if (lists === null) return refusedResult(source, 'UNRECOGNIZED_PAYLOAD', 0);
  const total = lists.reduce((n, l) => n + l.list.length, 0);
  if (total > MAX_FEED_ITEMS) return refusedResult(source, 'TOO_MANY_ITEMS', total);
  const acc = new FeedAccumulator();
  for (const { key, list } of lists) {
    const parser = parsers.find((p) => p.key === key);
    if (parser) acc.run(list, parser.parse);
  }
  return acc.result(source);
}
