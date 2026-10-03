import { describe, expect, it } from 'vitest';
import { IngestError } from './errors';
import { backoffDelay, isTransientError, withRetry } from './retry';

describe('backoffDelay', () => {
  it('is full jitter within [0, min(cap, base * 2^(n-1))]', () => {
    for (const [attempt, cap] of [
      [1, 100],
      [2, 200],
      [3, 400],
      [10, 1000],
    ] as const) {
      expect(backoffDelay(attempt, 100, 1000, () => 0)).toBe(0);
      expect(backoffDelay(attempt, 100, 1000, () => 0.999999)).toBeLessThanOrEqual(cap);
      expect(backoffDelay(attempt, 100, 1000, () => 0.999999)).toBeGreaterThan(cap * 0.99);
      expect(Number.isInteger(backoffDelay(attempt, 100, 1000, () => 0.5))).toBe(true);
    }
  });
});

describe('isTransientError', () => {
  const transient = [
    Object.assign(new Error('conn'), { code: '08006' }),
    Object.assign(new Error('admin'), { code: '57P01' }),
    Object.assign(new Error('ser'), { code: '40001' }),
    Object.assign(new Error('dead'), { code: '40P01' }),
    Object.assign(new Error('mem'), { code: '53200' }),
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    new Error('Connection terminated unexpectedly'),
    Object.assign(new Error('s3'), { $metadata: { httpStatusCode: 503 } }),
    Object.assign(new Error('s3'), { $retryable: { throttling: true } }),
    Object.assign(new Error('slow'), { name: 'SlowDown' }),
    new IngestError('SOURCE_READ_FAILED', 'x', { retryable: true }),
  ];
  const permanent = [
    new IngestError('VALIDATION_FAILED', 'x'),
    new IngestError('LEASE_LOST', 'x'),
    Object.assign(new Error('unique'), { code: '23505' }),
    Object.assign(new Error('denied'), { code: '42501' }),
    Object.assign(new Error('s3'), { $metadata: { httpStatusCode: 403 } }),
    new TypeError('bug'),
    'a string',
  ];
  it('classifies transient errors', () => {
    for (const e of transient) expect(isTransientError(e), String((e as Error).message ?? e)).toBe(true);
  });
  it('classifies permanent errors', () => {
    for (const e of permanent) expect(isTransientError(e), String((e as Error).message ?? e)).toBe(false);
  });
});

describe('withRetry', () => {
  const opts = (sleeps: number[], retries: number[]) => ({
    maxAttempts: 3,
    baseMs: 10,
    maxMs: 100,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    onRetry: ({ attempt }: { attempt: number }) => {
      retries.push(attempt);
    },
  });

  it('retries transient errors and returns the eventual result', async () => {
    const sleeps: number[] = [];
    const retries: number[] = [];
    let calls = 0;
    const r = await withRetry(async (attempt) => {
      calls++;
      if (attempt < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return 'ok';
    }, opts(sleeps, retries));
    expect(r).toBe('ok');
    expect(calls).toBe(3);
    expect(retries).toEqual([2, 3]);
    expect(sleeps).toEqual([5, 10]);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const sleeps: number[] = [];
    const retries: number[] = [];
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw Object.assign(new Error(`reset ${calls}`), { code: 'ECONNRESET' });
      }, opts(sleeps, retries)),
    ).rejects.toThrow('reset 3');
    expect(calls).toBe(3);
    expect(retries).toEqual([2, 3]);
  });

  it('never retries permanent errors', async () => {
    const sleeps: number[] = [];
    const retries: number[] = [];
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new IngestError('VALIDATION_FAILED', 'bad row');
      }, opts(sleeps, retries)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(retries).toEqual([]);
  });

  it('rejects a non-positive maxAttempts', async () => {
    await expect(withRetry(async () => 1, { maxAttempts: 0, baseMs: 1, maxMs: 1 })).rejects.toThrow(/maxAttempts/);
  });
});
