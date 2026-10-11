// handleMcpMessage: the transport-independent core of the allowlisted, read-only MCP
// server (checklist 5.4; DESIGN 3 and 4; PLAN 5.2). Purpose: take one message and the
// request context and return one JSON-RPC response, or null for a notification. It
// serves initialize, ping, tools/list and tools/call and nothing else.
// Trust boundary, in order, for every tools/call: size and depth caps and
// prototype-safe parsing; strict JSON-RPC envelope; caller checks (valid principal,
// not expired, principal tenant equals the context tenant); per-principal rate limit;
// closed registry lookup; authorize(principal, 'mcp.read', mcp_tool) plus the role's
// tool class; strict argument schema (no scope arguments exist); a team argument is
// authorized again; the data provider, bound to the context tenant, under a time
// budget; output schema; redaction; size cap; one audit record written before any
// result is returned. Every refusal has fixed text that never echoes input. The
// function never throws. A failed audit write turns an allowed call into an error.
import { ownRecord } from '@/identity/scope';
import { DEPLOY_ENVS, isOneOf, type DeployEnv, type Principal } from '@/identity/types';
import { decideToolAccess } from './access';
import { canonicalJson, sha256Hex } from './canonical';
import type { McpAuditRecord, McpContext, McpPolicy, AuditReason } from './context';
import { runWithDeadline } from './deadline';
import { fitToBudget } from './fit';
import { failure, parseEnvelope, RPC_ERRORS, success, type JsonRpcId, type JsonRpcResponse } from './jsonrpc';
import { parseJsonSafe, sanitizeJson, utf8Length, type JsonValue, type SanitizeLimits } from './jsonSafe';
import { resolveLimits, type McpLimits } from './limits';
import {
  LATEST_PROTOCOL_VERSION, SERVER_INFO, SERVER_INSTRUCTIONS, SUPPORTED_PROTOCOL_VERSIONS, validateCallParams, validateInitializeParams,
  validateListParams, validatePingParams, validateResultMeta,
} from './protocol';
import type { McpScope } from './provider';
import { redactResult } from './redact';
import { hasTeamArg, rowsInScope, teamScopeDenied } from './scope';
import { descriptorCopy, findTool, TOOL_REGISTRY, type ToolDescriptor } from './registry';
import type { ValidationResult } from './schema';

interface Resolved {
  readonly ctx: McpContext;
  readonly principal: Principal;
  readonly subject: string;
  readonly role: string;
  readonly env: DeployEnv;
  readonly tenant: string;
  readonly limits: McpLimits;
  readonly policy: McpPolicy;
}

const PRINCIPAL_KEYS = ['sub', 'role', 'teams', 'envs', 'tenant', 'tokenId', 'expiresAt', 'authMethod'] as const;
const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_TENANT_CHARS = 128;

/** Fixed text of tool-execution errors (isError: true). Nothing here is built from input. */
export const TOOL_ERROR_TEXT = Object.freeze({
  timeout: 'Tool timed out',
  failed: 'Tool failed',
  secret: 'Result withheld: sensitive content',
  pii: 'Result withheld: personal data',
  tooLarge: 'Result too large',
});

function resolveContext(ctx: McpContext): Resolved | null {
  try {
    if (ctx === null || typeof ctx !== 'object') return null;
    const { deployEnv, tenant, clock, provider, audit, rateLimiter } = ctx;
    if (!isOneOf(DEPLOY_ENVS, deployEnv)) return null;
    if (typeof tenant !== 'string' || tenant.length < 1 || tenant.length > MAX_TENANT_CHARS) return null;
    if (!clock || typeof clock.now !== 'function' || typeof clock.after !== 'function') return null;
    if (!provider || typeof provider !== 'object') return null;
    if (!audit || typeof audit.record !== 'function') return null;
    if (!rateLimiter || typeof rateLimiter.take !== 'function') return null;
    // One copy of the principal's own fields: nothing can change between check and use.
    const snapshot = (ownRecord(ctx.principal, PRINCIPAL_KEYS) ?? {}) as unknown as Principal;
    const policyIn = ctx.policy ?? {};
    const policy: McpPolicy = {
      email: policyIn.email === 'allow' || policyIn.email === 'reject' ? policyIn.email : 'mask',
      oversize: policyIn.oversize === 'reject' ? 'reject' : 'truncate',
    };
    return {
      ctx,
      principal: snapshot,
      subject: typeof snapshot.sub === 'string' ? snapshot.sub : '',
      role: typeof snapshot.role === 'string' ? snapshot.role : '',
      env: deployEnv,
      tenant,
      limits: resolveLimits(ctx.limits),
      policy,
    };
  } catch {
    return null;
  }
}

const intakeLimits = (l: McpLimits): SanitizeLimits => ({
  maxBytes: l.maxMessageBytes, maxDepth: l.maxMessageDepth, maxNodes: l.maxMessageNodes, maxStringBytes: l.maxStringBytes, maxKeyBytes: l.maxKeyBytes,
});

type Gate = { ok: true } | { ok: false; reason: 'tenant_mismatch' | 'principal_expired' };

/** Caller checks that authorize() does not make: tenant binding and expiry on the injected clock. */
function gate(r: Resolved, nowMs: number): Gate {
  if (typeof r.principal.tenant === 'string' && r.principal.tenant !== r.tenant) return { ok: false, reason: 'tenant_mismatch' };
  const exp = r.principal.expiresAt;
  if (typeof exp === 'number' && Number.isFinite(exp) && nowMs / 1000 >= exp) return { ok: false, reason: 'principal_expired' };
  return { ok: true };
}

interface Outcome {
  response: JsonRpcResponse;
  decision: 'allow' | 'deny';
  reason: AuditReason;
  tool: string | null;
  argBytes?: number;
  argHash?: string;
  resultBytes?: number;
  truncated?: boolean;
  redactedCount?: number;
}

/** Write the one audit record. A refusal stands whatever the sink does; an allowed call does not. */
async function finish(r: Resolved, id: string | number, method: 'tools/call' | 'tools/list', startedAt: number, o: Outcome): Promise<JsonRpcResponse> {
  const record: McpAuditRecord = {
    at: startedAt,
    method,
    subject: r.subject,
    role: r.role,
    tenant: r.tenant,
    env: r.env,
    tool: o.tool,
    decision: o.decision,
    reason: o.reason,
    argBytes: o.argBytes ?? 0,
    ...(o.argHash === undefined ? {} : { argHash: o.argHash }),
    resultBytes: o.resultBytes ?? 0,
    truncated: o.truncated ?? false,
    redactedCount: o.redactedCount ?? 0,
    durationMs: Math.max(0, r.ctx.clock.now() - startedAt),
  };
  const written = await runWithDeadline(() => r.ctx.audit.record(record), r.limits.auditTimeoutMs, r.ctx.clock);
  if (written.ok || o.decision === 'deny') return o.response;
  return failure(id, RPC_ERRORS.internal);
}

const toolError = (text: string): Record<string, unknown> => ({ content: [{ type: 'text', text }], isError: true });

function invalidArgumentsText(v: Extract<ValidationResult, { ok: false }>): string {
  // The rule is a code and the path holds declared property names only: neither is input.
  return `Invalid arguments: ${v.rule}${v.path.length > 0 ? ` at ${v.path.join('.')}` : ''}`;
}

type ParamBag = Record<string, JsonValue> | undefined;

// ---- methods ----------------------------------------------------------------------

function initialize(id: string | number, params: ParamBag): JsonRpcResponse {
  if (!validateInitializeParams(params).ok) return failure(id, RPC_ERRORS.invalidParams);
  const requested = (params as Record<string, JsonValue>).protocolVersion;
  const protocolVersion = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
  return success(id, {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { ...SERVER_INFO },
    instructions: SERVER_INSTRUCTIONS,
  });
}

function ping(id: string | number, params: ParamBag): JsonRpcResponse {
  return validatePingParams(params ?? {}).ok ? success(id, {}) : failure(id, RPC_ERRORS.invalidParams);
}

async function toolsList(id: string | number, params: ParamBag, r: Resolved): Promise<JsonRpcResponse> {
  const startedAt = r.ctx.clock.now();
  const done = (o: Omit<Outcome, 'tool'>): Promise<JsonRpcResponse> => finish(r, id, 'tools/list', startedAt, { ...o, tool: null });
  try {
    const p = params ?? {};
    if (!validateListParams(p).ok || Object.hasOwn(p, 'cursor')) {
      return done({ response: failure(id, RPC_ERRORS.invalidParams), decision: 'deny', reason: 'invalid_params' });
    }
    const g = gate(r, startedAt);
    if (!g.ok) return done({ response: failure(id, RPC_ERRORS.unauthenticated), decision: 'deny', reason: g.reason });
    const tools: ToolDescriptor[] = [];
    for (const tool of TOOL_REGISTRY) {
      const access = decideToolAccess(r.principal, tool.def, r.env);
      if (access.allow && teamScopeDenied(r.principal.teams, tool.def, hasTeamArg(tool.def) ? r.principal.teams[0] : undefined)) continue;
      if (access.allow) tools.push(descriptorCopy(tool));
      else if (access.reason === 'unauthenticated') {
        return done({ response: failure(id, RPC_ERRORS.unauthenticated), decision: 'deny', reason: 'unauthenticated' });
      }
    }
    const result = { tools };
    return done({ response: success(id, result), decision: 'allow', reason: 'ok', resultBytes: utf8Length(JSON.stringify(result)) });
  } catch {
    return done({ response: failure(id, RPC_ERRORS.internal), decision: 'deny', reason: 'internal_error' });
  }
}

async function toolsCall(id: string | number, params: ParamBag, r: Resolved): Promise<JsonRpcResponse> {
  const startedAt = r.ctx.clock.now();
  const done = (o: Outcome): Promise<JsonRpcResponse> => finish(r, id, 'tools/call', startedAt, o);
  const deny = (reason: AuditReason, tool: string | null, response: JsonRpcResponse, extra: Partial<Outcome> = {}): Promise<JsonRpcResponse> =>
    done({ ...extra, response, decision: 'deny', reason, tool });
  try {
    const g = gate(r, startedAt);
    if (!g.ok) return deny(g.reason, null, failure(id, RPC_ERRORS.unauthenticated));
    if (!r.ctx.rateLimiter.take(`${r.tenant}\u0000${r.subject}`, startedAt).allowed) return deny('rate_limited', null, failure(id, RPC_ERRORS.rateLimited));
    if (!validateCallParams(params).ok || params === undefined) return deny('invalid_params', null, failure(id, RPC_ERRORS.invalidParams));

    const name = params.name as string;
    const tool = findTool(name);
    if (tool === undefined) return deny('unknown_tool', SAFE_TOOL_NAME.test(name) ? name : null, failure(id, RPC_ERRORS.toolNotAvailable));
    const toolName = tool.def.name;
    const access = decideToolAccess(r.principal, tool.def, r.env);
    if (!access.allow) {
      return deny(access.reason, toolName, failure(id, access.reason === 'unauthenticated' ? RPC_ERRORS.unauthenticated : RPC_ERRORS.toolNotAvailable));
    }

    const args = (params.arguments ?? Object.create(null)) as { [key: string]: JsonValue };
    const canonical = canonicalJson(args);
    const argBytes = utf8Length(canonical);
    const argHash = tool.def.sensitive ? undefined : await sha256Hex(canonical);
    const base: Partial<Outcome> = { tool: toolName, argBytes, ...(argHash === undefined ? {} : { argHash }) };
    const allowed = (reason: AuditReason, response: JsonRpcResponse, extra: Partial<Outcome> = {}): Promise<JsonRpcResponse> =>
      done({ ...base, ...extra, response, decision: 'allow', reason, tool: toolName });

    if (argBytes > r.limits.maxArgBytes) return allowed('invalid_arguments', success(id, toolError('Invalid arguments: max_length')));
    const checked = tool.validateInput(args);
    if (!checked.ok) return allowed('invalid_arguments', success(id, toolError(invalidArgumentsText(checked))));
    const team = args.team;
    if (teamScopeDenied(r.principal.teams, tool.def, team)) return deny('not_authorized', toolName, failure(id, RPC_ERRORS.toolNotAvailable), base);
    if (typeof team === 'string') {
      const scoped = decideToolAccess(r.principal, tool.def, r.env, team);
      if (!scoped.allow) return deny('not_authorized', toolName, failure(id, RPC_ERRORS.toolNotAvailable), base);
    }

    const scope: McpScope = {
      tenant: r.tenant,
      env: r.env,
      subject: r.subject,
      teams: r.principal.teams === '*' ? '*' : Object.freeze([...r.principal.teams]),
    };
    const ran = await runWithDeadline((signal) => tool.def.invoke(r.ctx.provider, scope, args, signal), r.limits.toolTimeoutMs, r.ctx.clock);
    if (!ran.ok) {
      const timedOut = ran.reason === 'timeout';
      return allowed(timedOut ? 'timeout' : 'provider_error', success(id, toolError(timedOut ? TOOL_ERROR_TEXT.timeout : TOOL_ERROR_TEXT.failed)));
    }
    const invalidOutput = (): Promise<JsonRpcResponse> => allowed('output_invalid', success(id, toolError(TOOL_ERROR_TEXT.failed)));

    const clean = sanitizeJson(ran.value, {
      maxBytes: r.limits.maxOutputBytes, maxDepth: r.limits.maxOutputDepth, maxNodes: r.limits.maxOutputNodes,
      maxStringBytes: r.limits.maxStringBytes, maxKeyBytes: r.limits.maxKeyBytes,
    });
    if (!clean.ok) return invalidOutput();
    const out = clean.value;
    // The provider returns exactly { data, revision, evidence_status, data_origin }: any other key is refused.
    if (out === null || typeof out !== 'object' || Array.isArray(out)) return invalidOutput();
    const keys = Object.keys(out);
    if (keys.length !== 4 || !Object.hasOwn(out, 'data')) return invalidOutput();
    const meta: { [key: string]: JsonValue } = Object.create(null);
    for (const k of ['revision', 'evidence_status', 'data_origin']) if (Object.hasOwn(out, k)) meta[k] = out[k];
    if (!validateResultMeta(meta).ok || !tool.validateData(out.data).ok) return invalidOutput();

    if (!rowsInScope(r.principal.teams, out.data)) return invalidOutput();
    const body: { [key: string]: JsonValue } = { data: out.data, revision: out.revision, evidence_status: out.evidence_status, data_origin: out.data_origin, truncated: false };
    const redacted = redactResult(body, { onSecret: tool.def.onSecret, email: r.policy.email });
    if (!redacted.ok) {
      const secret = redacted.reason === 'secret_in_result';
      return allowed(redacted.reason, success(id, toolError(secret ? TOOL_ERROR_TEXT.secret : TOOL_ERROR_TEXT.pii)));
    }
    const fitted = fitToBudget(redacted.value as { [key: string]: JsonValue }, r.limits.maxResultBytes, r.policy.oversize);
    if (!fitted.ok) return allowed('result_too_large', success(id, toolError(TOOL_ERROR_TEXT.tooLarge)), { redactedCount: redacted.redactedCount });
    return allowed('ok', success(id, { content: [{ type: 'text', text: fitted.text }], isError: false }), {
      resultBytes: utf8Length(fitted.text), truncated: fitted.truncated, redactedCount: redacted.redactedCount,
    });
  } catch {
    return deny('internal_error', null, failure(id, RPC_ERRORS.internal));
  }
}

/**
 * Handle one MCP message. `message` is raw JSON text (preferred: the size check is exact)
 * or an already-parsed value (checked by a bounded walk). Returns the response to send, or
 * null when nothing should be sent (a notification). Never throws.
 */
export async function handleMcpMessage(message: unknown, ctx: McpContext): Promise<JsonRpcResponse | null> {
  let id: JsonRpcId = null;
  try {
    const r = resolveContext(ctx);
    if (r === null) return failure(null, RPC_ERRORS.internal);
    const limits = intakeLimits(r.limits);
    const parsed = typeof message === 'string' ? parseJsonSafe(message, limits) : sanitizeJson(message, limits);
    if (!parsed.ok) {
      if (parsed.code === 'syntax') return failure(null, RPC_ERRORS.parse);
      return failure(null, parsed.code === 'size' ? RPC_ERRORS.tooLarge : RPC_ERRORS.invalidRequest);
    }
    const envelope = parseEnvelope(parsed.value);
    if (envelope.kind === 'notification') return null;
    if (envelope.kind === 'invalid') return failure(envelope.id, envelope.error);
    id = envelope.id;
    switch (envelope.method) {
      case 'initialize':
        return initialize(id, envelope.params);
      case 'ping':
        return ping(id, envelope.params);
      case 'tools/list':
        return await toolsList(id, envelope.params, r);
      case 'tools/call':
        return await toolsCall(id, envelope.params, r);
      default:
        return failure(id, RPC_ERRORS.methodNotFound);
    }
  } catch {
    return failure(id, RPC_ERRORS.internal);
  }
}
