// Hello seam — mirrors the AIClient pattern (src/ai/). The UI talks
// to a HelloClient interface so a live /api/hello backend can drop in behind
// the same contract. MockHelloClient is the default (no network); LiveHelloClient
// fetches from the Next.js API route.

export interface HelloMessage {
  message: string;
  timestamp: string; // ISO 8601
  source: 'mock' | 'live';
}

export interface HelloClient {
  readonly mode: 'mock' | 'live';
  getGreeting(): Promise<HelloMessage>;
}

