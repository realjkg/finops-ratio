// Schema abuse: extra keys, wrong types, huge strings, depth, __proto__, argument caps.
import { describe, expect, it } from 'vitest';
import { handleMcpMessage } from './handler';
import { asFailure, callMsg, makeCtx, toolResult } from './testkit';

const bad = async (args: unknown, over = {}) => {
  const ctx = makeCtx(over);
  const res = await handleMcpMessage(callMsg('get_spend_summary', args), ctx);
  return { ctx, res };
};
const isInvalid = (res: Awaited<ReturnType<typeof handleMcpMessage>>): boolean => {
  if (res && 'error' in res) return true;
  const r = toolResult(res);
  return r.isError && r.content[0].text.startsWith('Invalid arguments');
};

describe('argument validation', () => {
  it('refuses wrong types, ranges, formats, and enum values; never reaches the provider', async () => {
    const cases: unknown[] = [
      { period: 202609 }, { period: '2026-13' }, { period: '2026-9' }, { period: '2026-09-01' }, { period: null }, { period: ['2026-09'] },
      { group_by: 'tenant' }, { group_by: 'SERVICE' }, { group_by: 1 }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: '5' }, { limit: -1 },
      { limit: 1e300 }, { team: '' }, { team: 'a'.repeat(65) }, { team: '../etc' }, { team: '<script>' }, { team: 'x; DROP TABLE' }, { team: 7 },
      { team: { $ne: 1 } }, { extra: 1 }, { period: '2026-09', extra: true },
    ];
    for (const args of cases) {
      const { ctx, res } = await bad(args);
      expect(isInvalid(res), JSON.stringify(args)).toBe(true);
      expect(ctx.provider.calls, JSON.stringify(args)).toHaveLength(0);
    }
  });
  it('accepts the boundaries', async () => {
    for (const args of [{ limit: 1 }, { limit: 50 }, { team: 'a'.repeat(64) }, { period: '2026-12' }, { period: '2026-01' }, {}]) {
      const { res } = await bad(args);
      expect(toolResult(res).isError, JSON.stringify(args)).toBe(false);
    }
  });
  it('refuses arguments that are not an object', async () => {
    for (const args of [[], [1], 'x', 5, null, true]) {
      const { ctx, res } = await bad(args);
      expect(res && 'error' in res).toBe(true);
      expect(ctx.provider.calls).toHaveLength(0);
    }
  });
  it('error text is fixed, names only declared properties, and never echoes values or unknown keys', async () => {
    const { res } = await bad({ SENTINEL_KEY: 'SENTINEL_VALUE', limit: 'SENTINEL_VALUE' });
    expect(JSON.stringify(res)).not.toContain('SENTINEL');
    const { res: r2 } = await bad({ team: 'SENTINEL!'.repeat(3) });
    expect(JSON.stringify(r2)).not.toContain('SENTINEL');
    expect(toolResult(r2).content[0].text).toBe('Invalid arguments: pattern at team');
  });
  it('refuses huge strings (message string cap) and a long-but-valid-looking team', async () => {
    const { ctx, res } = await bad({ team: 'a'.repeat(100_000) });
    expect(res && 'error' in res).toBe(true);
    expect(ctx.provider.calls).toHaveLength(0);
  });
  it('refuses nested depth in arguments', async () => {
    let v: unknown = 1;
    for (let i = 0; i < 20; i += 1) v = { a: v };
    const { ctx, res } = await bad({ team: v });
    expect(res && 'error' in res).toBe(true);
    expect(ctx.provider.calls).toHaveLength(0);
    const { res: r2 } = await bad({ team: { a: 1 } });
    expect(isInvalid(r2)).toBe(true);
  });
  it('refuses __proto__ / constructor in arguments and leaves Object.prototype alone', async () => {
    const texts = [
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_spend_summary","arguments":{"__proto__":{"admin":true}}}}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_spend_summary","arguments":{"limit":1,"constructor":{"prototype":{"admin":true}}}}}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"__proto__","arguments":{}}}',
    ];
    for (const t of texts) {
      const ctx = makeCtx();
      expect(asFailure(await handleMcpMessage(t, ctx)).error.code).toBeLessThan(0);
      expect(ctx.provider.calls).toHaveLength(0);
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });
  it('arguments reach the provider as a null-prototype copy', async () => {
    const ctx = makeCtx();
    await handleMcpMessage(callMsg('get_spend_summary', { period: '2026-09' }), ctx);
    expect(Object.getPrototypeOf(ctx.provider.calls[0].args)).toBeNull();
  });
  it('enforces the argument byte cap on the canonical arguments', async () => {
    const lowered = { limits: { maxArgBytes: 20 } };
    const { ctx, res } = await bad({ period: '2026-09', group_by: 'service' }, lowered); // 41 bytes
    expect(toolResult(res).content[0].text).toBe('Invalid arguments: max_length');
    expect(ctx.provider.calls).toHaveLength(0);
    expect(ctx.audit.records[0].reason).toBe('invalid_arguments');
    const ok = await bad({ limit: 5 }, { limits: { maxArgBytes: 10 } }); // {"limit":5} is 11 bytes
    expect(toolResult(ok.res).isError).toBe(true);
    const fit = await bad({ limit: 5 }, { limits: { maxArgBytes: 11 } });
    expect(toolResult(fit.res).isError).toBe(false);
  });
});

describe('provider output is untrusted too', () => {
  const run = async (data: unknown) => {
    const ctx = makeCtx({ provider: { ...makeCtxProvider(), getSpendSummary: async () => data as never } });
    return { ctx, res: await handleMcpMessage(callMsg('get_spend_summary', {}), ctx) };
  };
  function makeCtxProvider() { return makeCtx().provider; }
  const good = { data: { period: '2026-09', group_by: 'service', groups: [] }, revision: 'r1', evidence_status: 'measured', data_origin: 'synthetic_seed' };

  it('accepts a valid empty result', async () => {
    expect(toolResult((await run(good)).res).isError).toBe(false);
  });
  it('refuses wrong shape, extra fields, bad metadata, bad money, and non-JSON', async () => {
    const cases: unknown[] = [
      null, 'x', [], {}, { ...good, extra: 1 }, { data: good.data, revision: 'r1', evidence_status: 'measured' },
      { ...good, evidence_status: 'certain' }, { ...good, data_origin: 'prod' }, { ...good, revision: '' }, { ...good, revision: 'a b' },
      { ...good, data: { ...good.data, extra: 1 } }, { ...good, data: { ...good.data, period: 'now' } },
      { ...good, data: { ...good.data, groups: [{ currency: 'usd', total: '1', rows: [] }] } },
      { ...good, data: { ...good.data, groups: [{ currency: 'USD', total: '1e3', rows: [] }] } },
      { ...good, data: { ...good.data, groups: [{ currency: 'USD', total: 1, rows: [] }] } },
      { ...good, data: { ...good.data, groups: Array.from({ length: 9 }, () => ({ currency: 'USD', total: '1', rows: [] })) } },
      { ...good, data: { ...good.data, groups: [{ currency: 'USD', total: '1', rows: Array.from({ length: 51 }, () => ({ key: 'a', amount: '1' })) }] } },
      { ...good, revision: Infinity }, { ...good, data: undefined },
      JSON.parse('{"data":{"period":"2026-09","group_by":"service","groups":[]},"revision":"r1","evidence_status":"measured","data_origin":"synthetic_seed","__proto__":{"x":1}}'),
    ];
    for (const c of cases) {
      const { ctx, res } = await run(c);
      const r = toolResult(res);
      expect(r.isError, JSON.stringify(c)).toBe(true);
      expect(r.content[0].text).toBe('Tool failed');
      expect(ctx.audit.records[0].reason).toBe('output_invalid');
    }
  });
  it('turns a provider throw into fixed text without the message', async () => {
    const ctx = makeCtx({ provider: { ...makeCtx().provider, getSpendSummary: async () => { throw new Error('db password=hunter2 at host-x'); } } });
    const res = await handleMcpMessage(callMsg('get_spend_summary', {}), ctx);
    expect(toolResult(res).content[0].text).toBe('Tool failed');
    expect(JSON.stringify(res) + JSON.stringify(ctx.audit.records)).not.toContain('hunter2');
    expect(ctx.audit.records[0].reason).toBe('provider_error');
  });
  it('times out a hung provider on the injected clock', async () => {
    const { untilTimer } = await import('./testkit');
    const ctx = makeCtx({ provider: { ...makeCtx().provider, getSpendSummary: () => new Promise(() => undefined) } });
    const p = handleMcpMessage(callMsg('get_spend_summary', {}), ctx);
    await untilTimer(ctx.clock);
    ctx.clock.advance(4_999);
    ctx.clock.advance(1);
    const res = await p;
    expect(toolResult(res).content[0].text).toBe('Tool timed out');
    expect(ctx.audit.records[0].reason).toBe('timeout');
  });
});
