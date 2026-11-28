// Hello slice public API — mirrors src/ai/index.ts.
import { LiveHelloClient } from './LiveHelloClient';
import { MockHelloClient } from './MockHelloClient';
import type { HelloClient } from './HelloClient';

export type { HelloClient, HelloMessage } from './HelloClient';

/** Returns MockHelloClient by default; pass `'live'` to get LiveHelloClient. */
export function createHelloClient(mode: 'mock' | 'live' = 'mock'): HelloClient {
  return mode === 'live' ? new LiveHelloClient() : new MockHelloClient();
}

