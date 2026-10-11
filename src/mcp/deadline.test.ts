import { describe, expect, it } from 'vitest';
import { runWithDeadline } from './deadline';
import { FakeClock, flush, untilTimer } from './testkit';

describe('runWithDeadline', () => {
  it('returns the value and cancels the timer', async () => {
    const clock = new FakeClock();
    expect(await runWithDeadline(async () => 7, 1000, clock)).toEqual({ ok: true, value: 7 });
    expect(clock.pending()).toBe(0);
  });
  it('times out a job that never settles, aborts the signal, ignores a late result', async () => {
    const clock = new FakeClock();
    let release: (v: string) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const p = runWithDeadline((s) => { signal = s; return new Promise<string>((r) => { release = r; }); }, 1000, clock);
    await untilTimer(clock);
    clock.advance(999);
    await flush();
    expect(signal?.aborted).toBe(false);
    clock.advance(1);
    expect(await p).toEqual({ ok: false, reason: 'timeout' });
    expect(signal?.aborted).toBe(true);
    release('late');
    await flush();
  });
  it('a late rejection after timeout is not unhandled', async () => {
    const clock = new FakeClock();
    let fail: (e: Error) => void = () => undefined;
    const p = runWithDeadline(() => new Promise<string>((_, rej) => { fail = rej; }), 10, clock);
    await untilTimer(clock);
    clock.advance(10);
    expect(await p).toEqual({ ok: false, reason: 'timeout' });
    fail(new Error('late'));
    await flush();
  });
  it('a job resolving after the budget by the clock is a timeout', async () => {
    const clock = new FakeClock();
    expect(await runWithDeadline(async () => { clock.advance(1001); return 'slow'; }, 1000, clock)).toEqual({ ok: false, reason: 'timeout' });
  });
  it('a throwing or rejecting job is an error without the message', async () => {
    const clock = new FakeClock();
    expect(await runWithDeadline(() => { throw new Error('SECRET'); }, 1000, clock)).toEqual({ ok: false, reason: 'error' });
    expect(await runWithDeadline(async () => { throw new Error('SECRET'); }, 1000, clock)).toEqual({ ok: false, reason: 'error' });
  });
});
