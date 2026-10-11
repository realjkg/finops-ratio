// Injected time for the MCP core. Purpose: the only place that may read the system
// clock or start a timer; every other file in src/mcp receives an McpClock.
// Trust boundary: none (no input). Tests supply a fake clock, so no test is timing
// dependent and nothing here touches the network.

export interface McpClock {
  /** Epoch milliseconds. */
  now(): number;
  /** Runs `fn` once after `ms` milliseconds; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void;
}

/** The production clock: Date.now and setTimeout. Never used by tests. */
export const systemClock: McpClock = Object.freeze({
  now: () => Date.now(),
  after: (ms: number, fn: () => void) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
});
