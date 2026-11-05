// TEST-ONLY mock model providers for the conformance suite (ADR-0001 slice C3, D5). Never imported by app, worker,
// scripts or client code (guard.test.ts; check:bundle refuses CONFORMANCE_MARKER). OpenAI-compatible and
// Anthropic-compatible request and response SHAPES modeled from public documentation, to be verified live; SYNTHETIC
// replies only. Listens on 127.0.0.1, ephemeral port; counts every call so a test can prove zero dispatch.
import http from 'node:http';

export const CONFORMANCE_MARKER = 'ratio-conformance-test-only';

export interface MockProviderOptions {
  flavor: 'openai' | 'anthropic';
  /** Text chunks of the reply (streamed one per event, or joined). */
  reply: string[];
  /** Streamed tool-call argument fragments, sent after the text. */
  toolArguments?: string[];
  /** The model the response reports; differs from the requested one to simulate a provider-side fallback. */
  serveModel?: string;
  /** Drop the connection after this many streamed events (a mid-stream provider failure). */
  failAfterChunks?: number;
  /** End the stream cleanly but without its terminal event (a truncated response). */
  omitTerminal?: boolean;
  status?: number;
  /** Extra top-level fields merged into a non-streamed response (e.g. numbers to inspect). */
  extra?: Record<string, unknown>;
}
export interface MockProvider { url: string; calls: { path: string; bytes: number }[]; close(): Promise<void> }

const pause = () => new Promise((r) => setTimeout(r, 5));
const sse = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

function whole(o: MockProviderOptions, path: string, model: string): unknown {
  const text = o.reply.join('');
  const args = (o.toolArguments ?? []).join('');
  if (o.flavor === 'anthropic') {
    return { id: 'msg-syn', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }, ...(args ? [{ type: 'tool_use', id: 'tu-1', name: 'search', input: JSON.parse(args) }] : [])], stop_reason: 'end_turn' };
  }
  if (path === '/v1/responses') return { id: 'resp-syn', object: 'response', model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
  if (path === '/v1/completions') return { id: 'cmpl-syn', object: 'text_completion', model, choices: [{ index: 0, text, finish_reason: 'stop' }] };
  const calls = args ? [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: args } }] : undefined;
  return { id: 'chat-syn', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: 'stop' }] };
}

function events(o: MockProviderOptions, model: string): string[] {
  const args = o.toolArguments ?? [];
  if (o.flavor === 'anthropic') {
    return [sse({ type: 'message_start', message: { model } }, 'message_start'), ...o.reply.map((text) => sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, 'content_block_delta')),
      ...args.map((partial_json) => sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } }, 'content_block_delta')), sse({ type: 'message_stop' }, 'message_stop')];
  }
  return [sse({ model, choices: [{ index: 0, delta: { role: 'assistant' } }] }), ...o.reply.map((content) => sse({ model, choices: [{ index: 0, delta: { content } }] })),
    ...args.map((a) => sse({ model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a } }] } }] })), sse('[DONE]')];
}

export async function startMockProvider(o: MockProviderOptions): Promise<MockProvider> {
  const calls: MockProvider['calls'] = [];
  const server = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const p of req) parts.push(p as Buffer);
    const raw = Buffer.concat(parts);
    calls.push({ path: req.url ?? '', bytes: raw.length });
    let body: { model?: string; stream?: boolean } = {};
    try { body = JSON.parse(raw.toString('utf8')); } catch { /* answered below as a bad request */ }
    const model = o.serveModel ?? body.model ?? 'model-unknown';
    if (o.status && o.status !== 200) { res.writeHead(o.status, { 'content-type': 'application/json', 'x-mock-origin': CONFORMANCE_MARKER }); res.end('{"error":{"type":"synthetic"}}'); return; }
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json', 'x-mock-origin': CONFORMANCE_MARKER }); res.end(JSON.stringify({ ...(whole(o, req.url ?? '', model) as object), ...o.extra })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-mock-origin': CONFORMANCE_MARKER });
    let sent = 0;
    const all = events(o, model);
    for (const e of o.omitTerminal ? all.slice(0, -1) : all) {
      if (o.failAfterChunks !== undefined && sent >= o.failAfterChunks) { await pause(); res.socket?.destroy(); return; }
      res.write(e);
      sent++;
      await pause();
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
