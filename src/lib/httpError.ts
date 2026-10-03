// Browser-safe description of a non-2xx response for the Live*Clients.
//
// NEVER surfaces response-body text. A proxy / WAF / CDN can answer with an
// envelope-shaped body (`{"error":"…"}`) whose text is arbitrary, so the shape
// alone proves nothing. The thrown message is `<label> error <status>`, plus:
//   - `: <message>` only when the envelope's message is EXACTLY one of the
//     fixed strings our own routes emit (SAFE_ERROR_MESSAGES), else
//   - `: <code>` only when its code is EXACTLY one of our own codes
//     (SAFE_ERROR_CODES), else nothing.
// src/lib/liveClientErrors.test.ts checks that the server-side message
// constants are on this list, so the two cannot drift silently.

/** Fixed messages our own API routes put in error envelopes. */
export const SAFE_ERROR_MESSAGES: ReadonlySet<string> = new Set([
  // Generic 500 (gateway + non-gateway routes).
  'Internal error',
  // Gateway / auth.
  'Method not allowed',
  'Rate limit exceeded: 1000 requests per minute',
  'Missing Authorization: Bearer <token> header',
  'Invalid API token',
  'API token required: configure RATIO_API_TOKEN to enable authenticated access',
  'RATIO_API_TOKEN is too weak to serve live cost data (≥32 chars, ≥10 distinct)',
  'Too many failed authentication attempts',
  // Cost sources.
  'Unknown cost source',
  'Cost source is not configured — live credentials required',
  'Cost source does not provide cost rows',
  'sourceId query param is required',
  'sourceId, start, and end query params are required',
  'invalid cost window: start and end must be ISO-8601 (YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±hh:mm]) with start < end',
  'sourceId is not a focus_file source. Use /api/costsource/rows for other sources.',
  // Prediction.
  'A ProposedChange with `type` and `workloadId` is required',
  '`type` must be one of model_switch, demand_shape, scale, budget',
  'Unknown workload',
  'Unknown model',
  // Change management.
  'ticketRef is not a valid Jira issue key',
  'ticketRef is not a valid ServiceNow record number',
  // FinIO.
  'focusVersion not supported; responder supports 1.0–1.4',
  'Invalid or expired sessionId',
  'Missing FinIO peer token',
  'Invalid FinIO peer token',
  'FinIO peer authentication is misconfigured',
  'Handshake body must be a JSON object',
  'agentId is required',
  'nonce is required',
  'capabilities must be an array of strings',
  'focusVersion is required',
  'Refusing to emit non-conformant FOCUS rows',
]);

/** Error codes our own API routes emit. */
export const SAFE_ERROR_CODES: ReadonlySet<string> = new Set([
  'internal_error',
  'invalid_request',
  'unauthorized',
  'unauthorized_peer',
  'weak_token',
  'rate_limited',
  'method_not_allowed',
  'payload_too_large',
  'provider_misconfigured',
  'focus_version_mismatch',
  'invalid_session',
  'invalid_focus_export',
]);

/**
 * The safe suffix for an envelope body: an allow-listed message, else an
 * allow-listed code, else null. Never any other body text.
 */
export function envelopeMessage(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error === 'string') return SAFE_ERROR_MESSAGES.has(error) ? error : null;
  if (typeof error !== 'object' || error === null) return null;
  const { message, code } = error as { message?: unknown; code?: unknown };
  if (typeof message === 'string' && SAFE_ERROR_MESSAGES.has(message)) return message;
  if (typeof code === 'string' && SAFE_ERROR_CODES.has(code)) return code;
  return null;
}

/** `<label> error <status>[: <allow-listed message or code>]` from a read body. */
export function describeHttpErrorBody(label: string, status: number, body: string): string {
  const message = envelopeMessage(body);
  return message ? `${label} error ${status}: ${message}` : `${label} error ${status}`;
}

/** Read the body (never throws) and describe the failure. */
export async function describeHttpError(label: string, res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return describeHttpErrorBody(label, res.status, body);
}
