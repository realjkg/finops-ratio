// M0a: the managed retriever registry. Each connector row adds ONE line below,
// `managedRegistry.register('<connector>', <factory>)`, in plan order after M0a,
// plus `'managed'` for its connector in R1's SUPPORTED_IN_THIS_BUILD. This build
// registers none: a managed source is refused (CONNECTOR_NOT_REGISTERED).
import type { RetrieverFactory } from './runtime';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class RetrieverRegistry {
  private readonly factories = new Map<string, RetrieverFactory>();

  register(connector: string, factory: RetrieverFactory): void {
    if (!ID_RE.test(connector)) throw new TypeError('connector id must match [a-z0-9][a-z0-9-]*');
    if (this.factories.has(connector)) throw new TypeError(`a retriever for ${connector} is already registered`);
    this.factories.set(connector, factory);
  }

  factory(connector: string): RetrieverFactory | undefined {
    return this.factories.get(connector);
  }

  connectors(): string[] {
    return [...this.factories.keys()].sort();
  }
}

export const managedRegistry = new RetrieverRegistry();
// Connector registrations (one line per connector row) go here.
