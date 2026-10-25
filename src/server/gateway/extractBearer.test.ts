// extractBearer must run in linear time on hostile headers (CodeQL
// js/polynomial-redos on the former /^Bearer\s+(.+)$/i) and keep its contract.

import { describe, it, expect } from 'vitest';
import { extractBearer, MAX_AUTH_HEADER_LENGTH } from './auth';

describe('extractBearer', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['BEARER   abc  ', 'abc'],
    ['Bearer \tabc def', 'abc def'],
  ])('accepts %j', (header, token) => {
    expect(extractBearer(header)).toBe(token);
  });

  it.each([undefined, '', 'Bearer', 'Bearer ', 'Bearer    ', 'Basic abc', 'Bearerabc', ' Bearer abc', 'Bearer a\nb', 'Bearer a\rb'])(
    'rejects %j',
    (header) => {
      expect(extractBearer(header)).toBeNull();
    },
  );

  it('uses the first value of an array header', () => {
    expect(extractBearer(['Bearer one', 'Bearer two'])).toBe('one');
  });

  it('rejects a header over the length cap even when well formed', () => {
    expect(extractBearer(`Bearer ${'a'.repeat(MAX_AUTH_HEADER_LENGTH)}`)).toBeNull();
  });

  it.each([2000, 8000, 16000])('stays fast on spaces then a newline (n=%i)', (n) => {
    const start = performance.now();
    expect(extractBearer(`Bearer${' '.repeat(n)}\n`)).toBeNull();
    expect(extractBearer(`Bearer${' '.repeat(n)}x\n`)).toBeNull();
    expect(performance.now() - start).toBeLessThan(50);
  });
});
