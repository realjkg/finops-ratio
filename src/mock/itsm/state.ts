// In-memory state shared by the mock Jira and mock ServiceNow stubs.
//
// Local and ephemeral: nothing here touches disk or the network. Failure
// injection is a FIFO of one-shot rules, so a run is reproducible: the next N
// requests fail in the order they were queued, then behavior returns to normal.

export type FailureKind = '401' | '429' | '500' | 'slow';

export interface FailureRule {
  kind: FailureKind;
  /** How many upcoming requests the rule applies to. Default 1. */
  times?: number;
  /** For `slow`: delay before the normal response. Default 1000 ms. */
  delayMs?: number;
}

export interface JiraIssue {
  id: string;
  key: string;
  projectKey: string;
  summary: string;
  description: string;
  status: string;
  created: string;
  updated: string;
}

export interface ServiceNowChange {
  sysId: string;
  number: string;
  shortDescription: string;
  description: string;
  state: string;
  sysCreatedOn: string;
  sysUpdatedOn: string;
}

export interface ItsmStateOptions {
  /** Clock seam; defaults to the wall clock. */
  now?: () => Date;
  /** Jira project key used when a create request names none. */
  defaultProjectKey?: string;
}

export const JIRA_INITIAL_STATUS = 'Open';
/** ServiceNow change_request `state` value for "New". */
export const SERVICENOW_INITIAL_STATE = '-5';

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** ServiceNow date-time format, `YYYY-MM-DD HH:mm:ss` (UTC). */
export function serviceNowTimestamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

export interface ItsmState {
  readonly defaultProjectKey: string;
  createJiraIssue(input: { projectKey?: string; summary: string; description?: string }): JiraIssue;
  getJiraIssue(key: string): JiraIssue | undefined;
  /** Move an issue to a new status name. Returns false for an unknown key. */
  transitionJira(key: string, status: string): boolean;
  createServiceNowChange(input: { shortDescription: string; description?: string }): ServiceNowChange;
  getServiceNowChange(number: string): ServiceNowChange | undefined;
  listServiceNowChanges(): ServiceNowChange[];
  /** Move a change to a new `state` value. Returns false for an unknown number. */
  transitionServiceNow(number: string, state: string): boolean;
  injectFailure(rule: FailureRule): void;
  clearFailures(): void;
  /** Consume the next failure rule for one request, if any. */
  nextFailure(): { kind: FailureKind; delayMs: number } | undefined;
  reset(): void;
}

export function createItsmState(options: ItsmStateOptions = {}): ItsmState {
  const now = options.now ?? (() => new Date());
  const defaultProjectKey = options.defaultProjectKey ?? 'RATIO';

  const issues = new Map<string, JiraIssue>();
  const changes = new Map<string, ServiceNowChange>();
  let failures: Array<{ kind: FailureKind; remaining: number; delayMs: number }> = [];
  let issueSeq = 0;
  let changeSeq = 0;

  return {
    defaultProjectKey,

    createJiraIssue({ projectKey, summary, description }) {
      issueSeq += 1;
      const project = projectKey ?? defaultProjectKey;
      const stamp = now().toISOString();
      const issue: JiraIssue = {
        id: String(10000 + issueSeq),
        key: `${project}-${issueSeq}`,
        projectKey: project,
        summary,
        description: description ?? '',
        status: JIRA_INITIAL_STATUS,
        created: stamp,
        updated: stamp,
      };
      issues.set(issue.key, issue);
      return { ...issue };
    },

    getJiraIssue(key) {
      const issue = issues.get(key);
      return issue ? { ...issue } : undefined;
    },

    transitionJira(key, status) {
      const issue = issues.get(key);
      if (!issue) return false;
      issue.status = status;
      issue.updated = now().toISOString();
      return true;
    },

    createServiceNowChange({ shortDescription, description }) {
      changeSeq += 1;
      const stamp = serviceNowTimestamp(now());
      const change: ServiceNowChange = {
        sysId: `${pad(changeSeq, 8)}${'0'.repeat(24)}`,
        number: `CHG${pad(30000 + changeSeq, 7)}`,
        shortDescription,
        description: description ?? '',
        state: SERVICENOW_INITIAL_STATE,
        sysCreatedOn: stamp,
        sysUpdatedOn: stamp,
      };
      changes.set(change.number, change);
      return { ...change };
    },

    getServiceNowChange(number) {
      const change = changes.get(number);
      return change ? { ...change } : undefined;
    },

    listServiceNowChanges() {
      return [...changes.values()].map((c) => ({ ...c }));
    },

    transitionServiceNow(number, state) {
      const change = changes.get(number);
      if (!change) return false;
      change.state = state;
      change.sysUpdatedOn = serviceNowTimestamp(now());
      return true;
    },

    injectFailure(rule) {
      failures.push({
        kind: rule.kind,
        remaining: Math.max(1, Math.floor(rule.times ?? 1)),
        delayMs: Math.max(0, rule.delayMs ?? 1000),
      });
    },

    clearFailures() {
      failures = [];
    },

    nextFailure() {
      const head = failures[0];
      if (!head) return undefined;
      head.remaining -= 1;
      if (head.remaining <= 0) failures.shift();
      return { kind: head.kind, delayMs: head.delayMs };
    },

    reset() {
      issues.clear();
      changes.clear();
      failures = [];
      issueSeq = 0;
      changeSeq = 0;
    },
  };
}

// --- Shared loopback HTTP plumbing for both stubs ------------------------------

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const LOOPBACK_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;

/** One line per request, safe to log: never carries headers or bodies. */
export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
}

export interface StubOptions {
  state?: ItsmState;
  /** Must be a loopback address; anything else is refused. Default 127.0.0.1. */
  host?: string;
  /** 0 (default) picks a free port. */
  port?: number;
  /** Optional sink for method, path and status only. */
  log?: (entry: RequestLogEntry) => void;
}

export interface RunningStub {
  readonly baseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly state: ItsmState;
  close(): Promise<void>;
}

export function isLoopbackHost(host: string): boolean {
  return host === '::1' || /^127(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}$/.test(host);
}

/** Constant-time string comparison (hash first so lengths always match). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface FailureResponses {
  unauthorized: unknown;
  rateLimited: unknown;
  serverError: unknown;
}

/**
 * Apply the next injected failure, if any. Returns true when the request was
 * fully answered (401, 429, 500). A `slow` rule delays and returns false so the
 * normal handler still runs.
 */
export async function applyInjectedFailure(
  state: ItsmState,
  res: ServerResponse,
  bodies: FailureResponses,
): Promise<boolean> {
  const failure = state.nextFailure();
  if (!failure) return false;
  switch (failure.kind) {
    case '401':
      sendJson(res, 401, bodies.unauthorized);
      return true;
    case '429':
      sendJson(res, 429, bodies.rateLimited, { 'Retry-After': '1' });
      return true;
    case '500':
      sendJson(res, 500, bodies.serverError);
      return true;
    case 'slow':
      await new Promise<void>((resolve) => setTimeout(resolve, failure.delayMs));
      return false;
  }
}

export type StubHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

/** Bind a handler on a loopback address. Throws before binding for any other host. */
export async function listenLoopback(options: StubOptions, handler: StubHandler): Promise<RunningStub> {
  const host = options.host ?? LOOPBACK_HOST;
  if (!isLoopbackHost(host)) {
    throw new Error('mock ITSM stubs bind to a loopback address only');
  }
  const state = options.state ?? createItsmState();
  const log = options.log;

  const server: Server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    let path = '/';
    try {
      const url = new URL(req.url ?? '/', 'http://loopback.invalid');
      path = url.pathname;
      res.on('finish', () => log?.({ method, path, status: res.statusCode }));
      handler(req, res, url).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { message: 'mock stub error' });
        else res.end();
      });
    } catch {
      sendJson(res, 400, { message: 'bad request' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  const origin = host.includes(':') ? `http://[${host}]:${port}` : `http://${host}:${port}`;
  return {
    baseUrl: origin,
    host,
    port,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
