// In-memory mock — no network. Returns a fixed greeting so the /hello route
// works entirely offline, mirroring the MockAIClient pattern.
import type { HelloClient, HelloMessage } from './HelloClient';

export class MockHelloClient implements HelloClient {
  readonly mode = 'mock' as const;

  async getGreeting(): Promise<HelloMessage> {
    // Small delay so the UI can show a realistic loading state.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      message: 'Hello from the mock client — no network required.',
      timestamp: new Date().toISOString(),
      source: 'mock',
    };
  }
}

