// What a transport hands to handleMcpMessage, and what the core hands to the audit sink.
// Purpose: the injected dependencies in one place. Trust boundary: the transport has
// already authenticated the caller and built the Principal; this core re-checks the
// principal (authorize validates its shape), its expiry against the injected clock,
// and that its tenant is the context tenant, and fails closed on any doubt. Time, the
// data provider, the audit sink and the limiter are all injected, so a test is offline
// and deterministic and the core reads no environment variable, clock or network.
import type { DeployEnv, Principal } from '@/identity/types';
import type { McpClock } from './clock';
import type { McpLimits } from './limits';
import type { McpDataProvider } from './provider';
import type { McpRateLimiter } from './rateLimit';
import type { EmailPolicy } from './redact';

export interface McpPolicy {
  /** How email addresses in a result are handled. Default 'mask'. */
  email: EmailPolicy;
  /**
   * What to do with a result over maxResultBytes. 'truncate' (default) cuts the longest
   * arrays and marks the result truncated; 'reject' withholds it, as DESIGN 3.6 and A2 say.
   */
  oversize: 'truncate' | 'reject';
}

export interface McpContext {
  /** Already authenticated. The core still refuses an invalid, expired or other-tenant principal. */
  readonly principal: Principal;
  /** The deployment's own environment, already mapped (src/identity/envMap.ts). */
  readonly deployEnv: DeployEnv;
  /** The tenant this deployment serves this request for. Never taken from a tool argument. */
  readonly tenant: string;
  readonly clock: McpClock;
  readonly provider: McpDataProvider;
  readonly audit: McpAuditSink;
  readonly rateLimiter: McpRateLimiter;
  readonly limits?: Partial<McpLimits>;
  readonly policy?: Partial<McpPolicy>;
}

/** Closed reason codes. Every audit record carries exactly one. */
export const AUDIT_REASONS = Object.freeze([
  'ok', 'invalid_params', 'unknown_tool', 'not_authorized', 'unauthenticated', 'tenant_mismatch', 'principal_expired',
  'rate_limited', 'invalid_arguments', 'timeout', 'provider_error', 'output_invalid', 'secret_in_result', 'pii_in_result',
  'result_too_large', 'internal_error',
] as const);
export type AuditReason = (typeof AUDIT_REASONS)[number];

export interface McpAuditRecord {
  /** Epoch milliseconds from the injected clock. */
  readonly at: number;
  readonly method: 'tools/call' | 'tools/list';
  /** The acting subject (Principal.sub); empty when the principal was not valid. */
  readonly subject: string;
  readonly role: string;
  readonly tenant: string;
  readonly env: DeployEnv;
  /** A registered tool name, or a caller-supplied name only if it is plain lowercase snake case of at most 64 characters; else null. */
  readonly tool: string | null;
  /** allow: the call passed authorization and rate limiting. deny: it did not. */
  readonly decision: 'allow' | 'deny';
  readonly reason: AuditReason;
  readonly argBytes: number;
  /** SHA-256 of the canonical arguments. Absent for sensitive tools and for denied calls. */
  readonly argHash?: string;
  readonly resultBytes: number;
  readonly truncated: boolean;
  readonly redactedCount: number;
  readonly durationMs: number;
}

/**
 * Receives one record per tools/call and tools/list. A record never holds an argument or
 * a result value. A sink that throws or exceeds the audit budget fails the call closed.
 */
export interface McpAuditSink {
  record(record: McpAuditRecord): void | Promise<void>;
}
