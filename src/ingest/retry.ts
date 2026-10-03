// Bounded exponential backoff with full jitter, and the transient/permanent
// classifier. Only transient failures (connection loss, throttling, 5xx) are
// retried; validation, authorization, lease and integrity failures never are.
import { IngestError } from './errors';

/** Delay before retry number `retry` (1 = first retry): uniform in [0, min(cap, base·2^(retry-1))]. */
export function backoffDelay(retry: number, baseMs: number, maxMs: number, random: () => number): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, retry - 1));
  return Math.min(cap, Math.floor(random() * (cap + 1)));
}

const TRANSIENT_NODE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED']);
const TRANSIENT_S3_NAMES = new Set(['SlowDown', 'Throttling', 'ThrottlingException', 'RequestTimeout', 'RequestTimeoutException', 'InternalError', 'ServiceUnavailable', 'TimeoutError']);

export function isTransientError(e: unknown): boolean {
  if (e instanceof IngestError) return e.retryable;
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: unknown; name?: unknown; message?: unknown; $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
  const code = typeof err.code === 'string' ? err.code : '';
  if (/^(08|53)[0-9A-Z]{3}$/.test(code) || ['57P01', '57P02', '57P03', '40001', '40P01'].includes(code)) return true;
  if (TRANSIENT_NODE_CODES.has(code)) return true;
  if (typeof err.message === 'string' && /Connection terminated|connection timeout|Client has encountered a connection error/i.test(err.message)) return true;
  if (err.$retryable) return true;
  const status = err.$metadata?.httpStatusCode;
  if (typeof status === 'number' && (status >= 500 || status === 429)) return true;
  if (typeof err.name === 'string' && TRANSIENT_S3_NAMES.has(err.name)) return true;
  return false;
}

export interface RetryOptions {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called before each retry with the attempt number about to run (2, 3, …). */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => Promise<void> | void;
  isTransient?: (e: unknown) => boolean;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) throw new RangeError('maxAttempts must be a positive integer');
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  const transient = opts.isTransient ?? isTransientError;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= opts.maxAttempts || !transient(e)) throw e;
      const delayMs = backoffDelay(attempt, opts.baseMs, opts.maxMs, random);
      if (opts.onRetry) await opts.onRetry({ attempt: attempt + 1, delayMs, error: e });
      await sleep(delayMs);
    }
  }
}
