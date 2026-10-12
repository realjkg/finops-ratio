// @vitest-environment happy-dom
// useLiveSpend behavior tests — interval cadence, unmount cleanup, and the
// drift-free hidden-tab pause. vi.useFakeTimers is the injected clock
// (the DEMO_NOW pattern, applied to the wall clock); happy-dom provides the
// document surface the hook's visibility wiring needs.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveSpend, type LiveSpendState } from './useLiveSpend';

// React 18 requires this flag for act() outside react-test-renderer.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let latest: LiveSpendState | null = null;

function Probe({ tickMs }: { tickMs?: number }) {
  latest = useLiveSpend(tickMs);
  return null;
}

const container = document.createElement('div');
let root: Root | undefined;

function mount(tickMs?: number): void {
  act(() => {
    root = createRoot(container);
    root.render(<Probe tickMs={tickMs} />);
  });
}

function unmount(): void {
  const r = root;
  if (r) {
    act(() => r.unmount());
    root = undefined;
  }
}

/** Flip document.hidden and fire the visibilitychange event, inside act(). */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('useLiveSpend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latest = null;
    setHidden(false);
    document.body.appendChild(container);
    mount();
  });

  afterEach(() => {
    unmount();
    container.remove();
    vi.useRealTimers();
  });

  it('ticks on a 1s interval while visible', () => {
    expect(latest!.elapsedSeconds).toBe(0);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(latest!.elapsedSeconds).toBe(5);
  });

  it('honors a custom tick interval', () => {
    unmount();
    mount(250);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(latest!.elapsedSeconds).toBe(1);
  });

  it('does not accrue while the tab is hidden, and resumes without drift', () => {
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(latest!.elapsedSeconds).toBe(5);

    setHidden(true);
    expect(latest!.paused).toBe(true);
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(latest!.elapsedSeconds).toBe(5); // hidden time never counts

    setHidden(false);
    expect(latest!.paused).toBe(false);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(latest!.elapsedSeconds).toBe(8); // resumes exactly where it held
  });

  it('re-baselines on the hidden→visible edge, so throttled-timer latency never counts', () => {
    setHidden(true);
    act(() => {
      // Simulate a background-tab throttled interval: only one tick fires in
      // 60s, then the tab becomes visible and the next tick lands late.
      vi.advanceTimersByTime(60000);
    });
    setHidden(false);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(latest!.elapsedSeconds).toBe(1); // not 61 — the pause is drift-free
  });

  it('clears its interval on unmount (no leaks, no further ticks)', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    expect(latest!.elapsedSeconds).toBe(0);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    clearSpy.mockRestore();
  });
});
