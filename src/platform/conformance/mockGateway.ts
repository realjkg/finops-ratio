// TEST-ONLY mock AI gateway for the conformance suite (ADR-0001 slice C3). It runs the C1 policy library in the
// pre-dispatch and pre-release positions (§3.2) in front of the mock providers. It is NOT a production gateway and
// Ratio is not one (D2): it exists to prove the library's behavior in a gateway position. Never imported by app,
// worker, scripts or client code (guard.test.ts). Records carry sizes and keyed digests only, never content.
// Limit: the deadline cannot preempt a synchronous engine; it is measured afterward and an overrun is a timeout.
// True preemption needs the evaluation in a worker or isolate (a production integration concern, slice C6).
import crypto from 'node:crypto';
import http from 'node:http';
import { isId, isModelId, type ActorType, type DlpFinding, type GatewayRequestRecord, type PolicyDecision } from '../contracts';
import { applicablePolicies, compileBundle, evaluate, failureEvaluation, selectBundle, UNIDENTIFIED_PREFIX, type Evaluation, type EvaluationInput, type RequestContext } from '../policy';
import { CONFORMANCE_MARKER } from './mockProviders';

type Location = DlpFinding['location'];
type Flavor = 'openai' | 'anthropic';
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untrusted request and response JSON, walked defensively
type J = any;
export interface Identity { tenantId: string; workloadId?: string; actorType: ActorType; actorRef?: string; teamIds?: string[] }
export interface GatewayOptions {
  gatewayId: string;
  bundle: unknown; lastKnownGood?: unknown;
  /** Mapped to the D7 flags C1 requires (policyMonitor on; enforcement on only for enforce). */
  accessMode: NonNullable<EvaluationInput['accessMode']>;
  /** Gateway credentials (virtual keys) to identities: the only source of tenant, workload and actor. */
  credentials: Record<string, Identity>;
  providers: Record<string, { flavor: Flavor; url: string }>;
  /** The caller's detectors (slice C4 later); offsets only. */
  detect: (text: string, location: Location) => DlpFinding[];
  /** Requests and responses larger than this are never parsed or inspected (model unknown, DLP unavailable). */
  maxInspectBytes: number;
  /** Chunks per window for `buffer_window` release (default 4). */
  windowChunks?: number;
  /** The longest detector match, carried between stream windows as overlap (default 64 characters). */
  maxDetectorSpan?: number;
  digestKey: { keyId: string; secret: string };
  now: () => string;
  /** Defaults to the C1 `evaluate`; tests inject a hung, slow or throwing engine. */
  engine?: (i: EvaluationInput) => Evaluation | Promise<Evaluation>;
}
export interface GatewayRequest { credential: string; path: string; headers?: Record<string, string>; body: string | Buffer }
export interface GatewayResult { status: number; released: string[]; record: GatewayRequestRecord | null; decisions: PolicyDecision[]; origin: string }

const ROUTES = new Map<string, { surface: GatewayRequestRecord['surface']; flavor: Flavor; dest: string }>([
  ['/v1/chat/completions', { surface: 'openai_chat', flavor: 'openai', dest: 'openai_chat' }],
  ['/v1/completions', { surface: 'other', flavor: 'openai', dest: 'openai_completions' }],
  ['/v1/responses', { surface: 'openai_responses', flavor: 'openai', dest: 'openai_responses' }],
  ['/v1/messages', { surface: 'anthropic_messages', flavor: 'anthropic', dest: 'anthropic_messages' }],
]);
const DEFAULT_DEADLINE_MS = 50;
const MAX_DEPTH = 64, MAX_SEGMENTS = 10000, NESTED_JSON = 2;
/** Media blocks (any case) carry binary content the text detectors cannot inspect: opaque, so DLP is unavailable. */
const MEDIA = /^(input_)?(image|audio|video|file|document)(_url|_file)?$/i;
interface Seg { location: Location; text: string }
interface Parsed { model?: string; stream: boolean; segs: Seg[]; tools: string[]; opaque: boolean }

/** A JSON number as written (JSON.parse source text access, Node >= 21), so long numbers keep every digit. No fallback. */
class Num { constructor(readonly src: string) {} }
type Reviver = (k: string, v: unknown, ctx?: { source?: string }) => unknown;
const parse = (text: string): J => JSON.parse(text, (_k, v, ctx?: { source: string }) => (typeof v === 'number' ? new Num((ctx as { source: string }).source) : v));
/** Fails loudly (at gateway creation) when the runtime has no source text access. */
export function requireSourceText(p: (text: string, r: Reviver) => unknown = JSON.parse) {
  let s: unknown;
  p('1', (_k, v, ctx) => { s = ctx?.source; return v; });
  if (s !== '1') throw new Error('JSON.parse source text access is required (Node >= 21): numbers must keep their digits');
}
const ident = (kind: string, n: string) => (isId(`${kind}:${n}`) ? `${kind}:${n}` : `${kind}-h:${crypto.createHash('sha256').update(n).digest('hex').slice(0, 16)}`);
/**
 * Every identity of a tool, namespaced so none collides: function tools (type function or none, and named calls) by
 * `fn:<name>` (all names given), mcp tools by `mcp:<server_label>`, other typed tools by `type:<type>` (a name there is
 * not an identity). With no identity, `unidentified:<requestRef>`, which no policy can list. Anthropic `mcp_servers` entries
 * are `mcp:<name>`; any other top-level parameter that may declare tools is unidentified (refused in enforce).
 */
const toolIds = (t: J, unidentified: string): string[] => {
  const type = typeof t?.type === 'string' && !['function', 'tool_use', 'function_call'].includes(t.type) ? t.type : undefined;
  const named = (kind: string, n: unknown) => [typeof n === 'string' ? ident(kind, n) : unidentified];
  if (type?.startsWith('mcp')) return named('mcp', t.server_label ?? t.server_name); // mcp tools, mcp_call and mcp_tool_use history items
  if (type === 'server_tool_use') return named('type', t.name); // a server tool call in history names its tool
  if (type) return [ident('type', type)];
  const names = [t?.function?.name, t?.name].filter((n): n is string => typeof n === 'string');
  return names.length ? names.map((n) => ident('fn', n)) : [unidentified];
};
/**
 * Content-block positions (chat and Responses message `content`, Responses `input` items and function_call_output `output`,
 * Messages `content`, `system` and tool_result `content`):
 * a block of an unknown type, or a typeless part with binary-ish fields, is uninspectable. Elsewhere (e.g. JSON schemas in
 * tool definitions) objects are data and are walked.
 */
const TEXT_BLOCKS = new Set(['text', 'input_text', 'output_text', 'refusal', 'thinking', 'tool_use', 'tool_result', 'function_call', 'function_call_output',
  'message', 'mcp_call', 'server_tool_use', 'mcp_tool_use']);
const TOOLISH = /tool|function|mcp|server|plugin|connector/i, NOT_DECLARING = new Set(['tools', 'functions', 'tool_choice', 'parallel_tool_calls', 'function_call', 'max_tool_calls']);
const BINARY = ['image_url', 'image', 'input_audio', 'audio', 'file', 'file_data', 'source', 'data'];
const inspectable = (b: J) => !b || typeof b !== 'object' || Array.isArray(b) || b instanceof Num || (typeof b.type === 'string' ? TEXT_BLOCKS.has(b.type) : !BINARY.some((k) => k in b));
/**
 * Every key and scalar of the JSON is content (unknown keys included; numbers as written, an all-number array such as
 * token ids as one segment), with bounded depth and segments and bounded nested-JSON decoding (deeper JSON-in-strings,
 * exponent-form or split digits are slice C4).
 */
function inspect(root: J, base: Location, unidentified: string): Parsed {
  const out: Parsed = { stream: root?.stream === true, segs: [], tools: [], opaque: false, model: isModelId(root?.model) ? root.model : undefined };
  const add = (location: Location, text: string) => out.segs.push({ location, text });
  const id = (x: string) => { if (!out.tools.includes(x)) out.tools.push(x); };
  const tool = (t: J) => { for (const x of toolIds(t, unidentified)) id(x); };
  const walk = (v: J, loc: Location, depth: number, nested: number): void => {
    if (depth > MAX_DEPTH || out.segs.length > MAX_SEGMENTS) { out.opaque = true; return; }
    if (typeof v === 'string') {
      if (nested < NESTED_JSON && /^\s*[[{]/.test(v)) { try { return walk(parse(v), loc, depth + 1, nested + 1); } catch { /* not JSON: text */ } }
      add(loc, v);
      return;
    }
    if (v instanceof Num) { add(loc, v.src); return; }
    if (Array.isArray(v)) {
      if (v.length > 1 && v.every((x) => x instanceof Num)) { add(loc, v.map((x: Num) => x.src).join(' ')); return; }
      for (const x of v) walk(x, loc, depth + 1, nested);
      return;
    }
    if (!v || typeof v !== 'object') return; // booleans and null carry no text
    if (typeof v.type === 'string' && MEDIA.test(v.type)) { out.opaque = true; return; }
    const here: Location = v.role === 'system' || v.role === 'developer' ? 'system' : v.role === 'tool' || v.type === 'tool_result' || v.type === 'function_call_output' ? 'tool_result' : loc;
    if (v.role === undefined && (['tool_use', 'function_call', 'server_tool_use', 'mcp_tool_use'].includes(v.type) || 'arguments' in v || (v.type === 'function' && v.function))) tool(v);
    for (const [k, x] of Object.entries(v)) {
      add(here, k);
      if (k === 'model' && depth === 0) continue;
      if ((k === 'tools' || k === 'functions') && Array.isArray(x)) for (const t of x) tool(t);
      if (depth === 0 && k === 'mcp_servers') for (const s of Array.isArray(x) ? x : [x]) id(typeof s?.name === 'string' ? ident('mcp', s.name) : unidentified);
      else if (depth === 0 && TOOLISH.test(k) && !NOT_DECLARING.has(k)) id(unidentified);
      const blocks = (k === 'content' && (v.role !== undefined || v.type === 'tool_result' || v.type === 'message')) || (k === 'output' && v.type === 'function_call_output')
        || (depth === 0 && (k === 'system' || (k === 'input' && Array.isArray(x))));
      if (blocks && !(Array.isArray(x) ? x : [x]).every(inspectable)) out.opaque = true;
      const l: Location = k === 'system' || k === 'instructions' ? 'system' : k === 'arguments' || k === 'partial_json' || (k === 'input' && v.type === 'tool_use') ? 'tool_arguments' : here;
      walk(x, l, depth + 1, nested);
    }
  };
  walk(root, base, 0, 0);
  return out;
}
/** The text a client receives (the mock models release at the text level). */
function outputText(dest: string, j: J): string {
  const parts = dest === 'anthropic_messages' ? (j?.content ?? []).map((c: J) => c?.text) : dest === 'openai_responses' ? (j?.output ?? []).flatMap((o: J) => (o?.content ?? []).map((c: J) => c?.text))
    : (j?.choices ?? []).map((c: J) => (dest === 'openai_completions' ? c?.text : c?.message?.content));
  return parts.filter((x: J) => typeof x === 'string').join('');
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
  const r = http.request(url, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': body.length } }, resolve);
  r.once('error', reject);
  r.end(body);
});
const readAll = async (res: http.IncomingMessage) => { const parts: Buffer[] = []; for await (const p of res) parts.push(p as Buffer); return Buffer.concat(parts); };

export function createMockGateway(o: GatewayOptions) {
  requireSourceText();
  const engine = o.engine ?? evaluate;
  const flags = Object.freeze({ enabled: true, economics: false, adoption: false, policyMonitor: true, enforcement: o.accessMode === 'enforce' });
  const bundle = compileBundle(o.bundle) ?? o.bundle; // compiled once at load (C1 L4); an invalid one is decided by C1
  const lastKnownGood = o.lastKnownGood === undefined ? undefined : compileBundle(o.lastKnownGood) ?? o.lastKnownGood;
  const digest = (b: Buffer | string) => `hm1:${o.digestKey.keyId}:${crypto.createHmac('sha256', o.digestKey.secret).update(b).digest('hex')}`;
  const span = o.maxDetectorSpan ?? 64;
  if (!Number.isInteger(span) || span < 2) throw new RangeError('maxDetectorSpan must be an integer >= 2 (the overlap carried is span - 1)');
  let seq = 0;
  /** Policies of the bundle that will actually be evaluated (the last-known-good when it is in use). */
  const policiesFor = (c: RequestContext, now: string) => { const r = selectBundle(bundle, lastKnownGood, c.tenantId, now); return r.ok ? applicablePolicies(r.compiled, c, now).map((x) => x.policy) : null; };

  /** One C1 evaluation under the policy deadline: hung or slow (also synchronous) engines time out, throwing ones are engine errors. */
  async function decide(context: RequestContext): Promise<Evaluation> {
    const t0 = performance.now();
    const micros = () => Math.round((performance.now() - t0) * 1000);
    const now = o.now();
    const input: EvaluationInput = { bundle, lastKnownGood, context, clock: { now, elapsedMicros: micros }, flags };
    const ms = Math.min(DEFAULT_DEADLINE_MS, ...(policiesFor(context, now) ?? []).map((p) => p.evaluationTimeoutMs));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), ms); });
    try {
      const e = await Promise.race([Promise.resolve().then(() => engine(input)), deadline]);
      return e === 'timeout' || micros() > ms * 1000 ? failureEvaluation(input, 'timeout', micros()) : e;
    } catch {
      return failureEvaluation(input, 'engine_error', micros());
    } finally { clearTimeout(timer); }
  }
  /** Strictest release mode of the stream policies that will be evaluated; an unusable bundle buffers everything. */
  function windowSize(c: RequestContext): number {
    const ps = policiesFor(c, o.now());
    if (!ps) return Infinity;
    const modes = ps.map((p) => p.release ?? 'pass_through');
    return modes.includes('buffer_full') ? Infinity : modes.includes('buffer_window') ? (o.windowChunks ?? 4) : 1;
  }

  async function handle(req: GatewayRequest): Promise<GatewayResult> {
    // Own properties only: '__proto__' or 'constructor' is never a credential or a route. Claimed identity headers are never read.
    const id = Object.hasOwn(o.credentials, req.credential) ? o.credentials[req.credential] : undefined;
    if (!id) return { status: 401, released: [], record: null, decisions: [], origin: CONFORMANCE_MARKER };
    const receivedAt = o.now();
    const requestRef = `${o.gatewayId}-req-${++seq}`;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, 'utf8');
    const route = ROUTES.get(req.path);
    const provider = (route && Object.keys(o.providers).find((k) => o.providers[k].flavor === route.flavor)) || 'unrouted';
    let parsed: Parsed = { stream: false, segs: [], tools: [], opaque: true };
    const oversized = raw.length > o.maxInspectBytes; // bytes, not characters
    if (!oversized) { try { parsed = inspect(parse(raw.toString('utf8')), 'input', `${UNIDENTIFIED_PREFIX}${requestRef}`); } catch { /* opaque: fails closed below */ } }
    const decisions: PolicyDecision[] = [];
    const base = { tenantId: id.tenantId, requestRef, workloadId: id.workloadId, teamIds: id.teamIds, actorType: id.actorType, actorRef: id.actorRef, provider,
      destination: `${provider}:${route?.dest ?? 'unknown'}`, modelRequested: parsed.model, inputBytes: raw.length };
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
    const dlpGap = (opaque: boolean) => (opaque ? { unavailable: ['dlp' as const] } : {});

    // Pre-dispatch (§3.2 steps 2-3): an unreadable model is MODEL_UNKNOWN; redact, approval and block all stop here.
    if (!(await run({ ...base, phase: 'pre_request', tools: parsed.tools, findings: findings(parsed.segs), ...dlpGap(parsed.opaque) }))) return finish(403, [], 'not_dispatched', 'none');
    const target = o.providers[provider];
    if (!route || !target) return finish(404, [], 'not_dispatched', 'none');
    let res: http.IncomingMessage;
    try { res = await post(target.url + req.path, raw); } catch { return finish(502, [], 'unknown', 'none'); }
    if (res.statusCode !== 200) { await readAll(res).catch(() => null); return finish(502, [], 'dispatched', 'none'); }

    if (!parsed.stream) { // Pre-release (§3.2 step 6): nothing leaves before the output decision.
      let j: J, body: Buffer, bodyText: string;
      try { body = await readAll(res); bodyText = body.toString('utf8'); j = parse(bodyText); } catch { return finish(502, [], 'dispatched', 'none'); }
      const big = body.length > o.maxInspectBytes;
      const out: Parsed = big ? { stream: false, segs: [], tools: [], opaque: true, model: isModelId(j?.model) ? j.model : undefined } : inspect(j, 'output', `${UNIDENTIFIED_PREFIX}${requestRef}`);
      const text = outputText(route.dest, j);
      const ok = await run({ ...base, phase: 'pre_response', modelServed: out.model, tools: out.tools, findings: findings(out.segs), ...dlpGap(out.opaque) });
      return ok ? finish(200, [text], 'dispatched', 'full', { text, model: out.model }) : finish(403, [], 'dispatched', 'none', { text, model: out.model });
    }
    // Streaming: each window is decided BEFORE it is released, on its joined text per location plus the carried
    // overlap of the previous window (a marker split across chunks or windows is caught). Released windows cannot be withdrawn.
    const size = windowSize({ ...base, phase: 'stream_chunk', findings: [] });
    const released: string[] = [];
    const carry = new Map<Location, string>();
    let pending: Seg[] = [], windowNo = 0, served: string | undefined, received = '', ended = false, blocked = false, failed = false;
    const flush = async (force = false) => {
      if (pending.length === 0 && !force) return true;
      let found: DlpFinding[] = [], opaque = false;
      for (const location of [...new Set(pending.map((s) => s.location))]) {
        const prior = carry.get(location) ?? '';
        const text = prior + pending.filter((s) => s.location === location).map((s) => s.text).join('');
        if (Buffer.byteLength(text) > o.maxInspectBytes) opaque = true;
        else found = [...found, ...o.detect(text, location).filter((f) => f.end > prior.length)];
        carry.set(location, text.slice(-(span - 1)));
      }
      const ok = await run({ ...base, phase: 'stream_chunk', sequence: windowNo++, modelServed: served, findings: found, ...dlpGap(opaque) });
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
    // The last window; an empty stream still gets its output-phase decision (served model re-checked).
    if (!blocked && !failed && !(await flush(windowNo === 0))) blocked = true;
    res.destroy();
    const rel = blocked || failed ? (released.length ? 'partial' : 'none') : 'full';
    return finish(blocked ? 403 : failed ? 502 : 200, released, 'dispatched', rel, { text: received, model: served });
  }
  return { handle, engine };
}
