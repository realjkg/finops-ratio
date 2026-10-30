// M0a: the retriever registry. Connector rows add one registration line each.
import { describe, expect, it } from 'vitest';
import { RetrieverRegistry, managedRegistry } from './registry';
import type { RetrieverFactory } from './runtime';

const f: RetrieverFactory = () => {
  throw new Error('not used');
};

describe('RetrieverRegistry', () => {
  it('registers once per connector id and refuses a duplicate or a malformed id', () => {
    const r = new RetrieverRegistry();
    r.register('aws-data-exports', f);
    expect(r.factory('aws-data-exports')).toBe(f);
    expect(r.factory('opencost')).toBeUndefined();
    expect(() => r.register('aws-data-exports', f)).toThrow(/already registered/);
    expect(() => r.register('Bad Id', f)).toThrow(/connector id/);
    expect(r.connectors()).toEqual(['aws-data-exports']);
  });

  it('ships exactly the connectors whose rows have landed (M1a: aws-data-exports)', () => {
    expect(managedRegistry.connectors()).toEqual(['aws-data-exports']);
  });
});
