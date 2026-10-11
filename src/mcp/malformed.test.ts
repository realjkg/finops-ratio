// Malformed JSON-RPC, batch refusal, oversize, depth and prototype-pollution abuse at
// the message boundary. Every refusal must be a fixed error and must never echo input.
import { describe, expect, it } from 'vitest';
import { handleMcpMessage } from './handler';
import { RPC_ERRORS, type JsonRpcResponse } from './jsonrpc';
import { HARD_LIMITS } from './limits';
import { asFailure, asSuccess, makeCtx, msg } from './testkit';

const SENTINEL = 'SENTINEL_9f3a_DO_NOT_ECHO';
const ping = (extra: Record<string, unknown> = {}): string => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', ...extra });
const run = (message: unknown, over = {}): Promise<JsonRpcResponse | null> => handleMcpMessage(message, makeCtx(over));

/** A ping whose UTF-8 length is exactly `bytes`, padded with four _meta strings. */
function pingOfSize(bytes: number): string {
  const make = (pad: number): string => {
    const parts = [0, 1, 2, 3].map((i) => 'x'.repeat(Math.max(0, Math.min(2048, pad - i * 2048))));
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { a: parts[0], b: parts[1], c: parts[2], d: parts[3] } } });
  };
  const empty = new TextEncoder().encode(make(0)).length;
  const text = make(bytes - empty);
  expect(new TextEncoder().encode(text).length).toBe(bytes);
  return text;
}

describe('syntax and shape', () => {
  it('answers non-JSON text with parse error and a null id', async () => {
    for (const text of ['', '{', '}', 'nope', '{"jsonrpc":', "{'jsonrpc':'2.0'}", '﻿{}', '{"a":1,}', '01', `{"${SENTINEL}":}`]) {
      const res = asFailure(await run(text));
      expect(res.error, text).toEqual(RPC_ERRORS.parse);
      expect(res.id).toBeNull();
      expect(JSON.stringify(res)).not.toContain(SENTINEL);
    }
  });

  it('refuses JSON that is not a request object', async () => {
    for (const text of ['null', '1', '"ping"', 'true', '"[]"']) {
      expect(asFailure(await run(text)).error, text).toEqual(RPC_ERRORS.invalidRequest);
    }
  });

  it('refuses non-string, non-object messages', async () => {
    for (const m of [undefined, 42, true, () => 1, Symbol('x'), BigInt(10)]) {
      expect(asFailure(await run(m)).error).toEqual(RPC_ERRORS.invalidRequest);
    }
  });

  it('refuses a wrong or missing protocol version marker', async () => {
    const bad: unknown[] = [undefined, '1.0', '2', 2, 2.0 + 0.1, '2.0 ', ' 2.0', null, true, ['2.0']];
    for (const jsonrpc of bad) {
      const body = JSON.stringify({ jsonrpc, id: 1, method: 'ping' });
      expect(asFailure(await run(body)).error, body).toEqual(RPC_ERRORS.invalidRequest);
    }
  });

  it('refuses bad ids with a null id in the answer', async () => {
    const ids: unknown[] = [null, 1.5, true, false, {}, [], '', 'x'.repeat(129), 2 ** 53, -(2 ** 53), 1e300];
    for (const id of ids) {
      const res = asFailure(await run(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })));
      expect(res.error, JSON.stringify(id)).toEqual(RPC_ERRORS.invalidRequest);
      expect(res.id).toBeNull();
    }
  });

  it('accepts the id boundaries: 1 and 128 characters, zero, negative integers, the safe maximum', async () => {
    for (const id of ['a', 'x'.repeat(128), 0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      const res = asSuccess(await run(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })));
      expect(res.id).toBe(id);
    }
  });

  it('refuses a missing, non-string or out-of-range method', async () => {
    const methods: unknown[] = [undefined, 1, null, {}, [], '', 'm'.repeat(65)];
    for (const method of methods) {
      expect(asFailure(await run(JSON.stringify({ jsonrpc: '2.0', id: 1, method }))).error).toEqual(RPC_ERRORS.invalidRequest);
    }
    expect(asFailure(await run(msg('m'.repeat(64)))).error).toEqual(RPC_ERRORS.methodNotFound); // 64 is the boundary
  });

  it('refuses extra envelope keys and responses sent as requests', async () => {
    for (const extra of [{ extra: 1 }, { result: {} }, { error: { code: 1, message: 'm' } }, { Jsonrpc: '2.0' }, { [SENTINEL]: 1 }]) {
      const res = asFailure(await run(ping(extra)));
      expect(res.error).toEqual(RPC_ERRORS.invalidRequest);
      expect(JSON.stringify(res)).not.toContain(SENTINEL);
    }
    const response = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
    expect(asFailure(await run(response)).error).toEqual(RPC_ERRORS.invalidRequest);
  });

  it('refuses params that are not an object, keeping the (valid) id', async () => {
    for (const params of [[], [1], 'x', 7, null, true]) {
      const res = asFailure(await run(JSON.stringify({ jsonrpc: '2.0', id: 'r1', method: 'ping', params })));
      expect(res.error).toEqual(RPC_ERRORS.invalidParams);
      expect(res.id).toBe('r1');
    }
  });

  it('never echoes input in any error', async () => {
    const inputs = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: SENTINEL }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: SENTINEL } }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_spend_summary', arguments: { [SENTINEL]: SENTINEL } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_spend_summary', arguments: { team: SENTINEL.repeat(8) } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: SENTINEL, capabilities: [], clientInfo: {} } }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { [SENTINEL]: 1 } }),
      `[${SENTINEL}]`,
    ];
    for (const text of inputs) expect(JSON.stringify(await run(text)), text).not.toContain(SENTINEL);
  });
});

describe('batch', () => {
  it('refuses every JSON array, including an empty one, with one fixed error and a null id', async () => {
    const batches = ['[]', `[${ping()}]`, `[${ping()},${ping()}]`, '[1,2,3]', '[[]]', `[${ping()},null]`];
    for (const text of batches) {
      const res = asFailure(await run(text));
      expect(res.error, text).toEqual(RPC_ERRORS.batchRefused);
      expect(res.id).toBeNull();
    }
  });

  it('runs nothing inside a batch', async () => {
    const ctx = makeCtx();
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_spend_summary', arguments: {} } };
    await handleMcpMessage(JSON.stringify([call, call]), ctx);
    await handleMcpMessage([call, call], ctx);
    expect(ctx.provider.calls).toHaveLength(0);
    expect(ctx.audit.records).toHaveLength(0);
  });
});

describe('message size', () => {
  it('accepts a message of exactly the cap and refuses one byte more', async () => {
    expect(asSuccess(await run(pingOfSize(8192))).result).toEqual({});
    const over = asFailure(await run(pingOfSize(8193)));
    expect(over.error).toEqual(RPC_ERRORS.tooLarge);
    expect(over.id).toBeNull();
  });

  it('counts bytes, not characters', async () => {
    // Each string is 2040 bytes (under the 2048 string cap) but only 680 characters.
    const make = (strings: number): string =>
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: Object.fromEntries(Array.from({ length: strings }, (_, i) => [`k${i}`, '€'.repeat(680)])) } });
    expect(asSuccess(await run(make(3))).result).toEqual({}); // 6120 bytes of strings: fits
    const tooBig = make(4); // 8160 bytes of strings plus the envelope: over 8192 bytes, under 8192 characters
    expect(tooBig.length).toBeLessThan(8192);
    expect(new TextEncoder().encode(tooBig).length).toBeGreaterThan(8192);
    expect(asFailure(await run(tooBig)).error).toEqual(RPC_ERRORS.tooLarge);
  });

  it('lets a deployment lower the cap and never raise it past the hard ceiling', async () => {
    expect(asFailure(await run(pingOfSize(300), { limits: { maxMessageBytes: 299 } })).error).toEqual(RPC_ERRORS.tooLarge);
    expect(asSuccess(await run(pingOfSize(300), { limits: { maxMessageBytes: 300 } })).result).toEqual({});
    const huge = pingOfSize(8192) + ' '.repeat(HARD_LIMITS.maxMessageBytes);
    expect(asFailure(await run(huge, { limits: { maxMessageBytes: 10 ** 9 } })).error).toEqual(RPC_ERRORS.tooLarge);
  });

  it('refuses a very large string without parsing it', async () => {
    const res = asFailure(await run(`{"jsonrpc":"2.0","id":1,"method":"ping","x":"${'a'.repeat(5_000_000)}"}`));
    expect(res.error).toEqual(RPC_ERRORS.tooLarge);
  });

  it('refuses a single string over the string cap and a key over the key cap', async () => {
    const longString = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { a: 'x'.repeat(2049) } } });
    expect(asFailure(await run(longString)).error).toEqual(RPC_ERRORS.invalidRequest);
    const longKey = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { ['k'.repeat(65)]: 1 } } });
    expect(asFailure(await run(longKey)).error).toEqual(RPC_ERRORS.invalidRequest);
    const okKey = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { ['k'.repeat(64)]: 1 } } });
    expect(asSuccess(await run(okKey)).result).toEqual({});
  });
});

describe('depth and node caps', () => {
  const nested = (levels: number): string => {
    let inner = '1';
    for (let i = 0; i < levels; i += 1) inner = `{"a":${inner}}`;
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: JSON.parse(inner) } });
  };

  it('allows the deepest message the cap permits and refuses one level more', async () => {
    // envelope (1) + params (2) + the nested levels (_meta is the first): depth 8 is the cap.
    expect(asSuccess(await run(nested(6))).result).toEqual({});
    expect(asFailure(await run(nested(7))).error).toEqual(RPC_ERRORS.invalidRequest);
  });

  it('refuses very deep text quickly, without building it', async () => {
    const deep = `${'['.repeat(200_000)}${']'.repeat(200_000)}`;
    expect(asFailure(await run(deep)).error).toEqual(RPC_ERRORS.tooLarge); // over the byte cap first
    const underCap = `${'['.repeat(4000)}${']'.repeat(4000)}`;
    expect(asFailure(await run(underCap)).error).toEqual(RPC_ERRORS.invalidRequest); // then the depth scan
  });

  it('refuses a message with more values than the node cap', async () => {
    const wide = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { a: Array.from({ length: 600 }, () => 1) } } });
    expect(new TextEncoder().encode(wide).length).toBeLessThan(8192);
    expect(asFailure(await run(wide)).error).toEqual(RPC_ERRORS.invalidRequest);
  });

  it('survives a cyclic parsed object', async () => {
    const cyclic: Record<string, unknown> = { jsonrpc: '2.0', id: 1, method: 'ping' };
    cyclic.params = { _meta: cyclic };
    expect(asFailure(await run(cyclic)).error).toEqual(RPC_ERRORS.invalidRequest);
  });
});

describe('prototype pollution', () => {
  const polluted = (): unknown => (({}) as Record<string, unknown>).polluted;

  it('refuses __proto__, constructor and prototype keys at any depth', async () => {
    const texts = [
      '{"jsonrpc":"2.0","id":1,"method":"ping","__proto__":{"polluted":true}}',
      '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":{"__proto__":{"polluted":true}}}}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_spend_summary","arguments":{"__proto__":{"polluted":true}}}}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_spend_summary","arguments":{"constructor":{"prototype":{"polluted":true}}}}}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_spend_summary","arguments":{"team":"x","prototype":1}}}',
      '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":{"a":[{"__proto__":1}]}}}',
    ];
    for (const text of texts) {
      const ctx = makeCtx();
      expect(asFailure(await handleMcpMessage(text, ctx)).error, text).toEqual(RPC_ERRORS.invalidRequest);
      expect(ctx.provider.calls).toHaveLength(0);
      expect(polluted()).toBeUndefined();
    }
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it('refuses the same keys in an already-parsed object, including one made with JSON.parse', async () => {
    const parsed: unknown = JSON.parse('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":{"__proto__":{"polluted":true}}}}');
    expect(asFailure(await run(parsed)).error).toEqual(RPC_ERRORS.invalidRequest);
    expect(polluted()).toBeUndefined();
  });

  it('treats a plain "toString" or "hasOwnProperty" key as ordinary data, not as an attack', async () => {
    const res = asSuccess(await run(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { toString: 'x', hasOwnProperty: 1 } } })));
    expect(res.result).toEqual({});
  });
});

describe('already-parsed input', () => {
  it('serves a plain object', async () => {
    expect(asSuccess(await run({ jsonrpc: '2.0', id: 1, method: 'ping' })).result).toEqual({});
  });

  it('refuses accessors, class instances, Maps, Dates and throwing proxies', async () => {
    const withGetter = { jsonrpc: '2.0', id: 1, get method() { return 'ping'; } };
    class Req { jsonrpc = '2.0'; id = 1; method = 'ping'; }
    const throwing = new Proxy({}, { ownKeys() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } });
    for (const m of [withGetter, new Req(), new Map([['jsonrpc', '2.0']]), new Date(0), throwing, Object.create({ jsonrpc: '2.0' })]) {
      const res = await run(m);
      expect(res === null || 'error' in res).toBe(true);
      if (res !== null && 'error' in res) expect(res.error.code).toBe(RPC_ERRORS.invalidRequest.code);
    }
  });

  it('refuses non-finite numbers, undefined values and sparse arrays', async () => {
    for (const params of [{ _meta: { a: Infinity } }, { _meta: { a: NaN } }, { _meta: { a: undefined } }, { _meta: { a: new Array(3) } }]) {
      expect(asFailure(await run({ jsonrpc: '2.0', id: 1, method: 'ping', params })).error).toEqual(RPC_ERRORS.invalidRequest);
    }
    expect(asFailure(await run('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":{"a":1e999}}}')).error).toEqual(RPC_ERRORS.invalidRequest);
  });
});

describe('the handler never throws', () => {
  it('answers a broken context with a fixed internal error', async () => {
    const good = makeCtx();
    const broken: unknown[] = [
      null, undefined, {}, { ...good, audit: undefined }, { ...good, provider: null }, { ...good, clock: {} }, { ...good, rateLimiter: {} },
      { ...good, tenant: '' }, { ...good, tenant: 't'.repeat(129) }, { ...good, deployEnv: 'prod2' }, { ...good, deployEnv: undefined },
    ];
    for (const ctx of broken) {
      const res = asFailure(await handleMcpMessage(ping(), ctx as never));
      expect(res.error).toEqual(RPC_ERRORS.internal);
    }
  });

  it('survives a context whose getters throw', async () => {
    const hostile = new Proxy(makeCtx(), { get() { throw new Error('boom'); } });
    expect(asFailure(await handleMcpMessage(ping(), hostile)).error).toEqual(RPC_ERRORS.internal);
  });
});
