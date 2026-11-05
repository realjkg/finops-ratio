// TEST-ONLY mock AI gateway for the conformance suite (ADR-0001 slice C3). It runs the C1 policy library in the
// pre-dispatch and pre-release positions (§3.2) in front of the mock providers. It is NOT a production gateway and
// Ratio is not one (D2): it exists to prove the library's behavior in a gateway position. Never imported by app,
// worker, scripts or client code (guard.test.ts). Records carry sizes and keyed digests only, never content.
import crypto from 'node:crypto';
import http from 'node:http';
import { isId, isModelId, validatePolicyBundle, type ActorType, type DlpFinding, type GatewayRequestRecord, type PolicyBundle, type PolicyDecision } from '../contracts';
import { applicablePolicies, evaluate, failureEvaluation, type Evaluation, type EvaluationInput, type RequestContext } from '../policy';
import { CONFORMANCE_MARKER } from './mockProviders';

type Location = DlpFinding['location'];
type Flavor = 'openai' | 'anthropic';
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untrusted request and response JSON, walked defensively
type J = any;
export interface Identity { tenantId: string; workloadId?: string; actorType: ActorType; actorRef?: string; teamIds?: string[] }
export interface GatewayOptions {
  gatewayId: string;
  bundle: unknown; lastKnownGood?: unknown; accessMode: EvaluationInput['accessMode'];
  /** Gateway credentials (virtual keys) to identities: the only source of tenant, workload and actor. */
  credentials: Record<string, Identity>;
  providers: Record<string, { flavor: Flavor; url: string }>;
  /** The caller's detectors (slice C4 later); offsets only. */
  detect: (text: string, location: Location) => DlpFinding[];
  /** Inputs larger than this are never parsed or inspected (DLP unavailable, so enforcing DLP policies deny). */
  maxInspectBytes: number;
  /** Chunks per window for `buffer_window` release (default 4). */
  windowChunks?: number;
  digestKey: { keyId: string; secret: string };
  now: () => string;
  /** Defaults to the C1 `evaluate`; tests inject a hung or throwing engine. */
  engine?: (i: EvaluationInput) => Evaluation | Promise<Evaluation>;
}
export interface GatewayRequest { credential: string; path: string; headers?: Record<string, string>; body: string | Buffer }
export interface GatewayResult { status: number; released: string[]; record: GatewayRequestRecord | null; decisions: PolicyDecision[]; origin: string }

const ROUTES: Record<string, { surface: GatewayRequestRecord['surface']; flavor: Flavor; dest: string }> = {
  '/v1/chat/completions': { surface: 'openai_chat', flavor: 'openai', dest: 'openai_chat' },
  '/v1/completions': { surface: 'other', flavor: 'openai', dest: 'openai_completions' },
  '/v1/responses': { surface: 'openai_responses', flavor: 'openai', dest: 'openai_responses' },
  '/v1/messages': { surface: 'anthropic_messages', flavor: 'anthropic', dest: 'anthropic_messages' },
};
const DEFAULT_DEADLINE_MS = 50;
interface Seg { location: Location; text: string }
interface Parsed { model?: string; stream: boolean; segs: Seg[]; tools: string[]; opaque: boolean }

/** Walks request or response JSON into inspectable segments; anything it does not understand makes it opaque. */
function walker(base: Location) {
  const out: Parsed = { stream: false, segs: [], tools: [], opaque: false };
  const add = (location: Location, v: J) => { if (typeof v === 'string') out.segs.push({ location, text: v }); else out.opaque = true; };
  const tool = (name: J) => { if (isId(name)) out.tools.push(name); else out.opaque = true; };
  const message = (m: J) => {
    const loc: Location = m?.role === 'system' || m?.role === 'developer' ? 'system' : m?.role === 'tool' ? 'tool_result' : base;
    if (m?.content !== null && m?.content !== undefined) block(loc, m.content);
    for (const c of m?.tool_calls ?? []) { tool(c?.function?.name); add('tool_arguments', c?.function?.arguments); }
  };
  const block = (loc: Location, b: J): void => {
    if (typeof b === 'string') return add(loc, b);
    if (Array.isArray(b)) return b.forEach((x) => block(loc, x));
    switch (b?.type) {
      case 'text': case 'input_text': case 'output_text': return add(loc, b.text);
      case 'tool_use': tool(b.name); return add('tool_arguments', JSON.stringify(b.input ?? {}));
      case 'tool_result': return block('tool_result', b.content ?? '');
      case 'function_call': tool(b.name); return add('tool_arguments', b.arguments);
      case 'function_call_output': return add('tool_result', b.output);
      default: if (typeof b?.role === 'string') return message(b); out.opaque = true;
    }
  };
  const strings = (v: J): void => { if (typeof v === 'string') add(base, v); else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => k !== 'model' && strings(x)); };
  return { out, add, block, message, tool, strings };
}

function parseRequest(dest: string | undefined, j: J): Parsed {
  const w = walker('input');
  if (dest === 'openai_chat') (j.messages ?? []).forEach(w.message);
  else if (dest === 'openai_completions') w.block('input', j.prompt);
  else if (dest === 'openai_responses') { if (j.instructions !== undefined) w.add('system', j.instructions); w.block('input', j.input); }
  else if (dest === 'anthropic_messages') { if (j.system !== undefined) w.block('system', j.system); (j.messages ?? []).forEach(w.message); }
  else w.strings(j);
  for (const t of j.tools ?? []) w.tool(t?.function?.name ?? t?.name);
  return { ...w.out, model: isModelId(j.model) ? j.model : undefined, stream: j.stream === true };
}
function parseResponse(dest: string, j: J): Parsed {
  const w = walker('output');
  if (dest === 'anthropic_messages') w.block('output', j.content);
  else if (dest === 'openai_responses') w.block('output', j.output);
  else for (const c of j.choices ?? []) { if (dest === 'openai_completions') w.add('output', c?.text); else w.message(c?.message); }
  return { ...w.out, model: isModelId(j.model) ? j.model : undefined };
}
/** One streamed event: the served model, a chunk of output or tool arguments, or the terminal event. */
function parseEvent(flavor: Flavor, data: string): { model?: string; chunk?: Seg; done?: boolean } {
  if (flavor === 'openai' && data === '[DONE]') return { done: true };
  const j = JSON.parse(data);
  if (flavor === 'anthropic') {
    if (j.type === 'message_start') return { model: j.message?.model };
    if (j.type === 'message_stop') return { done: true };
    if (j.type !== 'content_block_delta') return {};
    if (j.delta?.type === 'text_delta' && typeof j.delta.text === 'string') return { chunk: { location: 'output', text: j.delta.text } };
    if (j.delta?.type === 'input_json_delta' && typeof j.delta.partial_json === 'string') return { chunk: { location: 'tool_arguments', text: j.delta.partial_json } };
    throw new Error('opaque event');
  }
  const d = j.choices?.[0]?.delta ?? {};
  const args = d.tool_calls?.[0]?.function?.arguments;
  return { model: j.model, ...(typeof d.content === 'string' ? { chunk: { location: 'output', text: d.content } } : typeof args === 'string' ? { chunk: { location: 'tool_arguments', text: args } } : {}) };
}
async function* sseData(res: http.IncomingMessage): AsyncGenerator<string> {
  let buf = '';
  for await (const part of res) {
    buf += (part as Buffer).toString('utf8');
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const event = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of event.split('\n')) if (line.startsWith('data: ')) yield line.slice(6);
    }
  }
}
const post = (url: string, body: Buffer) => new Promise<http.IncomingMessage>((resolve, reject) => {
  const r = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length } }, resolve);
  r.once('error', reject);
  r.end(body);
});
const readAll = async (res: http.IncomingMessage) => { const parts: Buffer[] = []; for await (const p of res) parts.push(p as Buffer); return Buffer.concat(parts).toString('utf8'); };

export function createMockGateway(o: GatewayOptions) {
  const engine = o.engine ?? evaluate;
  const checked = validatePolicyBundle(o.bundle);
  const bundle: PolicyBundle | null = checked.ok ? checked.value : null;
  const digest = (b: Buffer | string) => `hm1:${o.digestKey.keyId}:${crypto.createHmac('sha256', o.digestKey.secret).update(b).digest('hex')}`;
  let seq = 0;

  /** One C1 evaluation under the gateway's deadline: a hung engine times out, a throwing one is an engine error. */
  async function decide(context: RequestContext): Promise<Evaluation> {
    const input: EvaluationInput = { bundle: o.bundle, lastKnownGood: o.lastKnownGood, context, clock: { now: o.now() }, accessMode: o.accessMode };
    const ms = Math.min(DEFAULT_DEADLINE_MS, ...(bundle ? applicablePolicies(bundle, context, input.clock.now).map((x) => x.policy.evaluationTimeoutMs) : []));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), ms); });
    try {
      const e = await Promise.race([Promise.resolve().then(() => engine(input)), deadline]);
      return e === 'timeout' ? failureEvaluation(input, 'timeout', ms * 1000) : e;
    } catch {
      return failureEvaluation(input, 'engine_error');
    } finally { clearTimeout(timer); }
  }
  /** Strictest release mode of the applicable stream policies; unknown policy state buffers everything. */
  function windowSize(context: RequestContext): number {
    if (!bundle) return Infinity;
    const modes = applicablePolicies(bundle, context, o.now()).map((x) => x.policy.release ?? 'pass_through');
    return modes.includes('buffer_full') ? Infinity : modes.includes('buffer_window') ? (o.windowChunks ?? 4) : 1;
  }

  async function handle(req: GatewayRequest): Promise<GatewayResult> {
    const id = o.credentials[req.credential]; // claimed identity headers are never read
    if (!id) return { status: 401, released: [], record: null, decisions: [], origin: CONFORMANCE_MARKER };
    const receivedAt = o.now();
    const requestRef = `${o.gatewayId}-req-${++seq}`;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, 'utf8');
    const route = ROUTES[req.path];
    const provider = (route && Object.keys(o.providers).find((k) => o.providers[k].flavor === route.flavor)) || 'unrouted';
    let parsed: Parsed = { stream: false, segs: [], tools: [], opaque: true };
    const oversized = raw.length > o.maxInspectBytes;
    if (!oversized) { try { parsed = parseRequest(route?.dest, JSON.parse(raw.toString('utf8'))); } catch { /* opaque: fails closed below */ } }
    const decisions: PolicyDecision[] = [];
    const base = { tenantId: id.tenantId, requestRef, workloadId: id.workloadId, teamIds: id.teamIds, actorType: id.actorType, actorRef: id.actorRef, provider,
      destination: `${provider}:${route?.dest ?? 'unknown'}`, modelRequested: parsed.model ?? 'unknown', inputBytes: raw.length };
    const finish = (status: number, released: string[], dispatch: GatewayRequestRecord['dispatch'], rel: GatewayRequestRecord['released'], output?: { text: string; model?: string }): GatewayResult => ({
      status, released, decisions, origin: CONFORMANCE_MARKER,
      record: {
        schemaVersion: 'gateway-request/1', requestRef, tenantId: id.tenantId, gatewayId: o.gatewayId, workloadId: id.workloadId, actorRef: id.actorRef, actorType: id.actorType,
        surface: route?.surface ?? 'other', provider, modelRequested: parsed.model, modelServed: output?.model, streamed: parsed.stream, inputBytes: raw.length, inputDigest: digest(raw),
        ...(output ? { outputBytes: Buffer.byteLength(output.text), outputDigest: digest(output.text) } : {}), decisionIds: decisions.map((d) => d.decisionId), dispatch, released: rel, receivedAt,
      },
    });
    const run = async (c: RequestContext) => { const e = await decide(c); decisions.push(...e.decisions); return e.verdict === 'allow'; };
    const findings = (segs: Seg[]) => segs.flatMap((s) => o.detect(s.text, s.location));

    // Pre-dispatch (§3.2 steps 2-3): redact, approval and block all stop here (redaction is slice C4).
    const unavailable = parsed.opaque ? { unavailable: ['dlp' as const] } : {};
    if (!(await run({ ...base, phase: 'pre_request', tools: parsed.tools, findings: oversized ? [] : findings(parsed.segs), ...unavailable }))) return finish(403, [], 'not_dispatched', 'none');
    const target = o.providers[provider];
    if (!route || !target) return finish(404, [], 'not_dispatched', 'none');
    let res: http.IncomingMessage;
    try { res = await post(target.url + req.path, raw); } catch { return finish(502, [], 'unknown', 'none'); }
    if (res.statusCode !== 200) { await readAll(res).catch(() => ''); return finish(502, [], 'dispatched', 'none'); }

    if (!parsed.stream) { // Pre-release (§3.2 step 6): nothing leaves before the output decision.
      let out: Parsed;
      try { out = parseResponse(route.dest, JSON.parse(await readAll(res))); } catch { return finish(502, [], 'dispatched', 'none'); }
      const text = out.segs.map((s) => s.text).join('');
      const ok = await run({ ...base, phase: 'pre_response', modelServed: out.model, tools: out.tools, findings: findings(out.segs), ...(out.opaque ? { unavailable: ['dlp' as const] } : {}) });
      return ok ? finish(200, [text], 'dispatched', 'full', { text, model: out.model }) : finish(403, [], 'dispatched', 'none', { text, model: out.model });
    }
    // Streaming: each window is decided BEFORE it is released; a released window cannot be withdrawn later.
    const size = windowSize({ ...base, phase: 'stream_chunk', findings: [] });
    const released: string[] = [];
    let pending: Seg[] = [], windowNo = 0, served: string | undefined, received = '', ended = false, blocked = false, failed = false;
    const flush = async () => {
      if (pending.length === 0) return true;
      const ok = await run({ ...base, phase: 'stream_chunk', sequence: windowNo++, modelServed: served, findings: findings(pending) });
      if (ok) released.push(...pending.map((s) => s.text));
      pending = [];
      return ok;
    };
    try {
      for await (const data of sseData(res)) {
        const ev = parseEvent(route.flavor, data);
        if (isModelId(ev.model)) served = ev.model;
        if (ev.done) { ended = true; break; }
        if (!ev.chunk) continue;
        pending.push(ev.chunk);
        received += ev.chunk.text;
        if (pending.length >= size && !(await flush())) { blocked = true; break; }
      }
    } catch { failed = true; }
    if (!blocked && !failed && !ended) failed = true; // the stream stopped without its terminal event
    if (!blocked && !failed && !(await flush())) blocked = true;
    res.destroy();
    const rel = blocked || failed ? (released.length ? 'partial' : 'none') : 'full';
    return finish(blocked ? 403 : failed ? 502 : 200, released, 'dispatched', rel, { text: received, model: served });
  }
  return { handle, engine };
}
