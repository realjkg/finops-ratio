// POST /api/v1/cm/change — change-management gateway (Wave 4 Slice 3).
// Mirrors /api/v1/ai/chat: Bearer auth (RATIO_API_TOKEN), rate-limited, structured
// errors, /v1/ versioning. Server-side creds only — JIRA_* and SERVICENOW_* are
// read exclusively here; NEVER via NEXT_PUBLIC_.
//
// Three operations, all via POST body { operation, ...fields }:
//   create  — { operation:'create', finding, action }         → CMTicketResult
//   attach  — { operation:'attach', provider, ticketRef }    → CMReferenceRecord
//   status  — { operation:'status', ticketRef }              → CMStatusResult
//
// Provider selected by CM_PROVIDER env ∈ {mock(default), jira, servicenow}.
// Unset/unknown → MockCMClient; offline/CI-safe with zero env vars.
// Live adapters (JiraAdapter, ServiceNowAdapter) ship dark unless CM_PROVIDER +
// their respective creds are all set.

import type { NextApiRequest, NextApiResponse } from 'next';
import type {
  CMFindingInput,
  CMProvider,
  CMTicketResult,
  CMReferenceRecord,
  CMStatusResult,
} from '@/cm/CMClient';
import { MockCMClient } from '@/cm/MockCMClient';
import {
  INVALID_JIRA_REF_MESSAGE,
  INVALID_SERVICENOW_REF_MESSAGE,
  InvalidTicketRefError,
  isJiraIssueKey,
  isServiceNowNumber,
} from '@/cm/ticketRef';
import { logUpstreamError, readJsonBody, statusReason } from '@/costsource/transports/redact';
import {
  withGateway,
  sendError,
  type GatewayContext,
  type GatewayValidation,
} from '@/server/gateway';

// --- Server-only adapter interface -------------------------------------------
// These must never be imported from src/. The interface is intentionally inline.

interface CMAdapter {
  readonly provider: CMProvider;
  /**
   * Grammar check for a caller-supplied ticketRef, run BEFORE any URL is built.
   * Returns null when valid, else a fixed message that never echoes the input.
   * Absent for the mock (it builds no request a ref could steer).
   */
  invalidRefMessage?(ticketRef: string): string | null;
  createChange(finding: CMFindingInput, action: string): Promise<CMTicketResult>;
  attachReference(input: { provider: CMProvider; ticketRef: string }): Promise<CMReferenceRecord>;
  getStatus(ticketRef: string): Promise<CMStatusResult>;
}

// --- JiraAdapter (ships dark — invoked only when CM_PROVIDER=jira + creds set) ---

// Exported (with ServiceNowAdapter and createChangeHandler) only so tests can
// prove each layer of the ticketRef defence holds on its own.
export class JiraAdapter implements CMAdapter {
  readonly provider = 'jira' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    private readonly projectKey: string,
  ) {}

  private get authHeader(): string {
    return `Bearer ${this.apiToken}`;
  }

  private issueUrl(path = ''): string {
    return `${this.baseUrl.replace(/\/$/, '')}/rest/api/2/${path}`;
  }

  invalidRefMessage(ticketRef: string): string | null {
    return isJiraIssueKey(ticketRef) ? null : INVALID_JIRA_REF_MESSAGE;
  }

  /**
   * The only way a ref enters a Jira URL: grammar-checked, then encoded
   * (defence in depth — a valid key encodes to itself).
   */
  private issuePath(ticketRef: string): string {
    if (!isJiraIssueKey(ticketRef)) throw new InvalidTicketRefError(INVALID_JIRA_REF_MESSAGE);
    return `issue/${encodeURIComponent(ticketRef)}`;
  }

  private browseUrl(ticketRef: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/browse/${encodeURIComponent(ticketRef)}`;
  }

  async createChange(finding: CMFindingInput, action: string): Promise<CMTicketResult> {
    const res = await fetch(this.issueUrl('issue'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader,
      },
      body: JSON.stringify({
        fields: {
          project: { key: this.projectKey },
          summary: `[Ratio] ${action} — ${finding.workloadName}`,
          description:
            `Ratio automated finding\n\n` +
            `Workload: ${finding.workloadId}\n` +
            `Recommended action: ${finding.recommendedAction}\n` +
            `Projected monthly impact: $${finding.projectedMonthlyImpact.toFixed(0)}/mo`,
          issuetype: { name: 'Change' },
          labels: ['ratio', 'finops'],
        },
      }),
    });
    if (!res.ok) {
      // Status + fixed reason only; the ITSM body goes to the redacted log.
      const text = await res.text().catch(() => '');
      if (text) logUpstreamError('Jira createChange', res.status, text);
      throw new Error(`Jira createChange failed (${res.status} ${statusReason(res.status)})`);
    }
    const data = await readJsonBody<{ key: string }>(res, 'Jira');
    const ticketRef = data.key;
    return {
      provider: 'jira',
      ticketRef,
      url: this.browseUrl(ticketRef),
      status: 'created',
      createdAt: new Date().toISOString(),
    };
  }

  async attachReference(input: {
    provider: CMProvider;
    ticketRef: string;
  }): Promise<CMReferenceRecord> {
    // Validate the ref exists before recording it as the audit trail.
    const res = await fetch(this.issueUrl(this.issuePath(input.ticketRef)), {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) {
      // Never quote the ref: errors are for logs, not an echo of caller input.
      throw new Error(`Jira ref not found or inaccessible (${res.status})`);
    }
    return {
      provider: 'jira',
      ticketRef: input.ticketRef,
      url: this.browseUrl(input.ticketRef),
      createdAt: new Date().toISOString(),
    };
  }

  async getStatus(ticketRef: string): Promise<CMStatusResult> {
    const res = await fetch(this.issueUrl(this.issuePath(ticketRef)), {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) {
      throw new Error(`Jira getStatus failed (${res.status} ${statusReason(res.status)})`);
    }
    const data = await readJsonBody<{
      fields: { status: { name: string }; updated: string };
    }>(res, 'Jira');
    return {
      ticketRef,
      status: data.fields.status.name,
      updatedAt: data.fields.updated,
    };
  }
}

// --- ServiceNowAdapter (ships dark — invoked only when CM_PROVIDER=servicenow + creds set) ---

export class ServiceNowAdapter implements CMAdapter {
  readonly provider = 'servicenow' as const;

  constructor(
    /** e.g. 'myinstance.service-now.com' */
    private readonly instance: string,
    private readonly username: string,
    private readonly password: string,
  ) {}

  private get baseUrl(): string {
    return `https://${this.instance}/api/now`;
  }

  invalidRefMessage(ticketRef: string): string | null {
    return isServiceNowNumber(ticketRef) ? null : INVALID_SERVICENOW_REF_MESSAGE;
  }

  /**
   * The only way a ref enters a ServiceNow URL: grammar-checked (no encoded-
   * query operators such as `^OR`), then encoded as defence in depth.
   */
  private numberParam(ticketRef: string): string {
    if (!isServiceNowNumber(ticketRef)) {
      throw new InvalidTicketRefError(INVALID_SERVICENOW_REF_MESSAGE);
    }
    return encodeURIComponent(ticketRef);
  }

  private recordUrl(ticketRef: string): string {
    return `https://${this.instance}/nav_to.do?uri=change_request.do?number=${encodeURIComponent(ticketRef)}`;
  }

  private get authHeader(): string {
    const creds = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return `Basic ${creds}`;
  }

  async createChange(finding: CMFindingInput, action: string): Promise<CMTicketResult> {
    const res = await fetch(`${this.baseUrl}/table/change_request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: this.authHeader,
      },
      body: JSON.stringify({
        short_description: `[Ratio] ${action} — ${finding.workloadName}`,
        description:
          `Ratio automated finding\n` +
          `Workload: ${finding.workloadId}\n` +
          `Recommended action: ${finding.recommendedAction}\n` +
          `Projected monthly impact: $${finding.projectedMonthlyImpact.toFixed(0)}/mo`,
        category: 'software',
        type: 'normal',
        assignment_group: 'FinOps',
      }),
    });
    if (!res.ok) {
      // Status + fixed reason only; the ITSM body goes to the redacted log.
      const text = await res.text().catch(() => '');
      if (text) logUpstreamError('ServiceNow createChange', res.status, text);
      throw new Error(`ServiceNow createChange failed (${res.status} ${statusReason(res.status)})`);
    }
    const data = await readJsonBody<{ result: { number: string } }>(res, 'ServiceNow');
    const ticketRef = data.result.number;
    return {
      provider: 'servicenow',
      ticketRef,
      url: this.recordUrl(ticketRef),
      status: 'created',
      createdAt: new Date().toISOString(),
    };
  }

  async attachReference(input: {
    provider: CMProvider;
    ticketRef: string;
  }): Promise<CMReferenceRecord> {
    const url =
      `${this.baseUrl}/table/change_request` +
      `?sysparm_query=number=${this.numberParam(input.ticketRef)}` +
      `&sysparm_fields=number,sys_id&sysparm_limit=1`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: this.authHeader },
    });
    if (!res.ok) {
      throw new Error(`ServiceNow lookup failed (${res.status})`);
    }
    const data = await readJsonBody<{ result: Array<{ number: string }> }>(res, 'ServiceNow');
    if (data.result.length === 0) {
      throw new Error('ServiceNow ref not found');
    }
    return {
      provider: 'servicenow',
      ticketRef: input.ticketRef,
      url: this.recordUrl(input.ticketRef),
      createdAt: new Date().toISOString(),
    };
  }

  async getStatus(ticketRef: string): Promise<CMStatusResult> {
    const url =
      `${this.baseUrl}/table/change_request` +
      `?sysparm_query=number=${this.numberParam(ticketRef)}` +
      `&sysparm_fields=number,state,sys_updated_on&sysparm_limit=1`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: this.authHeader },
    });
    if (!res.ok) {
      throw new Error(`ServiceNow getStatus failed (${res.status})`);
    }
    const data = await readJsonBody<{
      result: Array<{ state: string; sys_updated_on: string }>;
    }>(res, 'ServiceNow');
    const record = data.result[0];
    if (!record) throw new Error('ServiceNow ref not found');
    return {
      ticketRef,
      status: record.state,
      updatedAt: record.sys_updated_on,
    };
  }
}

// --- Provider resolution -----------------------------------------------------
// Misconfiguration surfaces as a thrown AdapterError BEFORE any external call,
// so a missing key is actionable — not a cryptic 500.

interface AdapterError {
  status: number;
  message: string;
}

function resolveAdapter(env: NodeJS.ProcessEnv): CMAdapter {
  const provider = (env.CM_PROVIDER ?? '').toLowerCase();
  switch (provider) {
    case 'jira': {
      const base = env.JIRA_BASE_URL;
      const token = env.JIRA_API_TOKEN;
      const project = env.JIRA_PROJECT_KEY;
      if (!base || !token || !project) {
        throw {
          status: 422,
          message:
            'JIRA_BASE_URL, JIRA_API_TOKEN, and JIRA_PROJECT_KEY are required for CM_PROVIDER=jira',
        } satisfies AdapterError;
      }
      return new JiraAdapter(base, token, project);
    }
    case 'servicenow': {
      const instance = env.SERVICENOW_INSTANCE;
      const username = env.SERVICENOW_USERNAME;
      const password = env.SERVICENOW_PASSWORD;
      if (!instance || !username || !password) {
        throw {
          status: 422,
          message:
            'SERVICENOW_INSTANCE, SERVICENOW_USERNAME, and SERVICENOW_PASSWORD are required for CM_PROVIDER=servicenow',
        } satisfies AdapterError;
      }
      return new ServiceNowAdapter(instance, username, password);
    }
    default:
      // Offline-safe default — no creds, no network, CI-safe.
      return new MockCMClient();
  }
}

function isAdapterError(err: unknown): err is AdapterError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as AdapterError).status === 'number' &&
    typeof (err as AdapterError).message === 'string'
  );
}

// --- Request body types -------------------------------------------------------

interface CreateBody {
  operation: 'create';
  finding: CMFindingInput;
  action: string;
}

interface AttachBody {
  operation: 'attach';
  provider: CMProvider;
  ticketRef: string;
}

interface StatusBody {
  operation: 'status';
  ticketRef: string;
}

type CMRequestBody = CreateBody | AttachBody | StatusBody;

// --- Validation ---------------------------------------------------------------

function isValidFinding(f: unknown): f is CMFindingInput {
  if (typeof f !== 'object' || f === null) return false;
  const { workloadId, workloadName, recommendedAction, projectedMonthlyImpact } =
    f as Record<string, unknown>;
  return (
    typeof workloadId === 'string' &&
    typeof workloadName === 'string' &&
    typeof recommendedAction === 'string' &&
    typeof projectedMonthlyImpact === 'number'
  );
}

const VALID_PROVIDERS = new Set<string>(['mock', 'jira', 'servicenow']);

function isValidBody(body: unknown): body is CMRequestBody {
  if (typeof body !== 'object' || body === null) return false;
  const { operation } = body as { operation?: unknown };
  switch (operation) {
    case 'create': {
      const { finding, action } = body as { finding?: unknown; action?: unknown };
      return isValidFinding(finding) && typeof action === 'string' && action.length > 0;
    }
    case 'attach': {
      const { provider, ticketRef } = body as { provider?: unknown; ticketRef?: unknown };
      return (
        typeof provider === 'string' &&
        VALID_PROVIDERS.has(provider) &&
        typeof ticketRef === 'string' &&
        ticketRef.trim().length > 0
      );
    }
    case 'status': {
      const { ticketRef } = body as { ticketRef?: unknown };
      return typeof ticketRef === 'string' && ticketRef.trim().length > 0;
    }
    default:
      return false;
  }
}

/** Gateway body validator — wraps the type guard with a human-readable message. */
export function validateCMBody(body: unknown): GatewayValidation {
  return isValidBody(body)
    ? { ok: true }
    : {
        ok: false,
        message:
          'Body must be one of: ' +
          '{ operation:"create", finding, action } | ' +
          '{ operation:"attach", provider, ticketRef } | ' +
          '{ operation:"status", ticketRef }',
      };
}

// --- Guarded handler ---------------------------------------------------------
// The gateway owns: 405, 413, 401, 429, 400, 500 envelopes.
// This handler owns: 422 misconfigured provider, 400 invalid ticketRef (fixed
// message, input never echoed) and 200 success.

async function changeHandler(
  req: NextApiRequest,
  res: NextApiResponse,
  resolve: (env: NodeJS.ProcessEnv) => CMAdapter,
): Promise<void> {
  const body = req.body as CMRequestBody;

  let adapter: CMAdapter;
  try {
    adapter = resolve(process.env);
  } catch (err) {
    if (isAdapterError(err)) {
      sendError(res, err.status, 'provider_misconfigured', err.message);
      return;
    }
    throw err; // unexpected — let the gateway return a 500 envelope.
  }

  // ticketRef grammar gate — BEFORE any adapter builds a URL from it.
  if (body.operation === 'attach' || body.operation === 'status') {
    const invalid = adapter.invalidRefMessage?.(body.ticketRef) ?? null;
    if (invalid) {
      sendError(res, 400, 'invalid_request', invalid);
      return;
    }
  }

  try {
    await dispatch(adapter, body, res);
  } catch (err) {
    if (isInvalidTicketRef(err)) {
      sendError(res, 400, 'invalid_request', err.message);
      return;
    }
    throw err; // the gateway returns its generic 500 envelope.
  }
}

/** `instanceof` itself can throw (a Proxy's getPrototypeOf trap); never here. */
function isInvalidTicketRef(err: unknown): err is InvalidTicketRefError {
  try {
    return err instanceof InvalidTicketRefError;
  } catch {
    return false;
  }
}

async function dispatch(adapter: CMAdapter, body: CMRequestBody, res: NextApiResponse): Promise<void> {
  switch (body.operation) {
    case 'create': {
      const result = await adapter.createChange(body.finding, body.action);
      res.status(200).json(result);
      break;
    }
    case 'attach': {
      // The audit record names the provider this deployment actually resolved
      // (CM_PROVIDER / mock). The body's `provider` is ignored: a caller must
      // not be able to label a mock or Jira reference as another system's.
      const record = await adapter.attachReference({
        provider: adapter.provider,
        ticketRef: body.ticketRef,
      });
      res.status(200).json({ ...record, provider: adapter.provider });
      break;
    }
    case 'status': {
      const status = await adapter.getStatus(body.ticketRef);
      res.status(200).json(status);
      break;
    }
  }
}

/** The gateway-wrapped route; `resolve` is injectable for tests only. */
export function createChangeHandler(resolve: (env: NodeJS.ProcessEnv) => CMAdapter = resolveAdapter) {
  return withGateway((req, res, _ctx: GatewayContext) => changeHandler(req, res, resolve), {
    methods: ['POST'],
    validateBody: validateCMBody,
  });
}

export default createChangeHandler();

