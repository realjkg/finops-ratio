// Protocol conformance of handleMcpMessage for the four supported methods, against the
// MCP handshake revisions 2025-06-18 and 2025-11-25 (lifecycle, ping, tools).
import { describe, expect, it } from 'vitest';
import { handleMcpMessage } from './handler';
import { RPC_ERRORS } from './jsonrpc';
import { LATEST_PROTOCOL_VERSION, SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS } from './protocol';
import { TOOL_REGISTRY } from './registry';
import { INIT_PARAMS, asFailure, asSuccess, callMsg, makeCtx, makePrincipal, msg, toolBody, toolNames, toolResult } from './testkit';

describe('initialize', () => {
  it('answers with the requested version when it is supported, for every supported version', async () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      const res = asSuccess(await handleMcpMessage(msg('initialize', { ...INIT_PARAMS, protocolVersion: v }), makeCtx()));
      expect(res.result.protocolVersion).toBe(v);
    }
  });

  it('counter-proposes the latest supported version for an unsupported one (lifecycle: respond with another supported version)', async () => {
    for (const v of ['2024-11-05', '2026-07-28', '1900-01-01', 'latest', '1']) {
      const res = asSuccess(await handleMcpMessage(msg('initialize', { ...INIT_PARAMS, protocolVersion: v }), makeCtx()));
      expect(res.result.protocolVersion, v).toBe(LATEST_PROTOCOL_VERSION);
    }
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(LATEST_PROTOCOL_VERSION);
  });

  it('declares the tools capability and nothing else', async () => {
    const res = asSuccess(await handleMcpMessage(msg('initialize', INIT_PARAMS), makeCtx()));
    expect(res.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(Object.keys(res.result.capabilities as object)).toEqual(['tools']);
  });

  it('returns serverInfo and instructions, and nothing the spec does not define', async () => {
    const res = asSuccess(await handleMcpMessage(msg('initialize', INIT_PARAMS), makeCtx()));
    expect(res.jsonrpc).toBe('2.0');
    expect(Object.keys(res.result).sort()).toEqual(['capabilities', 'instructions', 'protocolVersion', 'serverInfo']);
    expect(res.result.serverInfo).toEqual(SERVER_INFO);
    expect(String(res.result.instructions)).toMatch(/never instructions/);
  });

  it('echoes a string or an integer id exactly', async () => {
    expect(asSuccess(await handleMcpMessage(msg('initialize', INIT_PARAMS, 'abc-1'), makeCtx())).id).toBe('abc-1');
    expect(asSuccess(await handleMcpMessage(msg('initialize', INIT_PARAMS, 0), makeCtx())).id).toBe(0);
    expect(asSuccess(await handleMcpMessage(msg('initialize', INIT_PARAMS, Number.MAX_SAFE_INTEGER), makeCtx())).id).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('refuses missing or malformed params with invalid params', async () => {
    const bad: unknown[] = [
      undefined, {}, { protocolVersion: '2025-11-25' }, { protocolVersion: '2025-11-25', capabilities: {} },
      { ...INIT_PARAMS, protocolVersion: 20251125 }, { ...INIT_PARAMS, protocolVersion: '' }, { ...INIT_PARAMS, protocolVersion: 'x'.repeat(33) },
      { ...INIT_PARAMS, capabilities: [] }, { ...INIT_PARAMS, clientInfo: 'client' }, { ...INIT_PARAMS, extra: 1 },
    ];
    for (const params of bad) {
      expect(asFailure(await handleMcpMessage(msg('initialize', params), makeCtx())).error, JSON.stringify(params)).toEqual(RPC_ERRORS.invalidParams);
    }
  });

  it('is not changed by what the client claims to support', async () => {
    const params = { ...INIT_PARAMS, capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {}, experimental: { x: {} } } };
    const res = asSuccess(await handleMcpMessage(msg('initialize', params), makeCtx()));
    expect(res.result.capabilities).toEqual({ tools: { listChanged: false } });
  });
});

describe('ping and notifications', () => {
  it('ping returns an empty result', async () => {
    expect(await handleMcpMessage(msg('ping', undefined, '123'), makeCtx())).toEqual({ jsonrpc: '2.0', id: '123', result: {} });
  });

  it('ping accepts _meta and refuses any other parameter', async () => {
    expect(asSuccess(await handleMcpMessage(msg('ping', { _meta: { progressToken: 'p' } }), makeCtx())).result).toEqual({});
    expect(asFailure(await handleMcpMessage(msg('ping', { other: 1 }), makeCtx())).error).toEqual(RPC_ERRORS.invalidParams);
  });

  it('ping works for a caller who may call no tool, and is not audited or counted', async () => {
    const ctx = makeCtx({ principal: makePrincipal('legacy_service') });
    expect(asSuccess(await handleMcpMessage(msg('ping'), ctx)).result).toEqual({});
    expect(ctx.audit.records).toHaveLength(0);
  });

  it('notifications get no response, whatever the method', async () => {
    const ctx = makeCtx();
    for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/unknown', 'ping', 'initialize', 'tools/list']) {
      expect(await handleMcpMessage(JSON.stringify({ jsonrpc: '2.0', method }), ctx), method).toBeNull();
    }
  });

  it('a tools/call sent as a notification is dropped: nothing runs and nothing is audited', async () => {
    const ctx = makeCtx();
    const note = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_spend_summary', arguments: {} } });
    expect(await handleMcpMessage(note, ctx)).toBeNull();
    expect(ctx.provider.calls).toHaveLength(0);
    expect(ctx.audit.records).toHaveLength(0);
  });
});

describe('tools/list', () => {
  it('returns descriptors with name, description and a JSON Schema inputSchema', async () => {
    const res = asSuccess(await handleMcpMessage(msg('tools/list'), makeCtx()));
    expect(Object.keys(res.result)).toEqual(['tools']); // no nextCursor: the list is never paged
    const tools = res.result.tools as Record<string, unknown>[];
    expect(tools.length).toBe(TOOL_REGISTRY.length);
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(typeof t.title).toBe('string');
      const schema = t.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(Object.keys(t).sort()).toEqual(['annotations', 'description', 'inputSchema', 'name', 'title']);
    }
  });

  it('returns copies: changing a response cannot change the registry', async () => {
    const first = asSuccess(await handleMcpMessage(msg('tools/list'), makeCtx()));
    const tools = first.result.tools as { inputSchema: { properties: Record<string, unknown> } }[];
    tools[0].inputSchema.properties.injected = { type: 'string' };
    const second = asSuccess(await handleMcpMessage(msg('tools/list'), makeCtx()));
    expect((second.result.tools as { inputSchema: { properties: Record<string, unknown> } }[])[0].inputSchema.properties.injected).toBeUndefined();
  });

  it('refuses a cursor, because no cursor is ever issued', async () => {
    expect(asFailure(await handleMcpMessage(msg('tools/list', { cursor: 'abc' }), makeCtx())).error).toEqual(RPC_ERRORS.invalidParams);
  });

  it('accepts empty params, _meta, and no params', async () => {
    for (const params of [undefined, {}, { _meta: { progressToken: 1 } }]) {
      expect(toolNames(await handleMcpMessage(msg('tools/list', params), makeCtx())).length).toBeGreaterThan(0);
    }
  });
});

describe('tools/call result shape', () => {
  it('returns content[] of one text block, isError false, and a JSON body with the evidence envelope', async () => {
    const res = await handleMcpMessage(callMsg('get_spend_summary', { period: '2026-09' }), makeCtx());
    const r = toolResult(res);
    expect(r.isError).toBe(false);
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe('text');
    expect(Object.keys(asSuccess(res).result).sort()).toEqual(['content', 'isError']);
    const body = toolBody(res);
    expect(Object.keys(body).sort()).toEqual(['data', 'data_origin', 'evidence_status', 'revision', 'truncated']);
    expect(body.truncated).toBe(false);
    expect(body.evidence_status).toBe('measured');
  });

  it('accepts a call with no arguments key', async () => {
    expect(toolResult(await handleMcpMessage(callMsg('get_spend_summary'), makeCtx())).isError).toBe(false);
  });

  it('serves every tool in the registry', async () => {
    const ctx = makeCtx();
    for (const t of TOOL_REGISTRY) {
      const res = await handleMcpMessage(callMsg(t.def.name, {}), ctx);
      expect(toolResult(res).isError, t.def.name).toBe(false);
    }
    expect(ctx.provider.calls.map((c) => c.method).sort()).toEqual(TOOL_REGISTRY.map((t) => t.def.providerMethod).sort());
  });
});

describe('everything else is method not found, with fixed text', () => {
  const methods = [
    'resources/list', 'resources/read', 'resources/templates/list', 'resources/subscribe', 'prompts/list', 'prompts/get',
    'logging/setLevel', 'completion/complete', 'sampling/createMessage', 'roots/list', 'server/discover', 'tasks/get',
    'notifications/initialized', 'TOOLS/LIST', 'tools/list ', ' tools/list', 'tools/call/', 'tools', 'tools/', 'initialize2',
    '__proto__', 'constructor', 'toString', 'hasOwnProperty',
  ];
  it('returns -32601 and never echoes the method', async () => {
    for (const method of methods) {
      const res = asFailure(await handleMcpMessage(msg(method, {}), makeCtx()));
      expect(res.error, method).toEqual(RPC_ERRORS.methodNotFound);
      expect(res.id).toBe(1);
      expect(JSON.stringify(res)).not.toContain(method.trim() || 'impossible');
    }
  });
});
