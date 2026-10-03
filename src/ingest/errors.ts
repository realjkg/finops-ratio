// Error type for the ingestion worker. Codes fit sync_runs.error_code
// (^[A-Z][A-Z0-9_]{0,63}$). Messages must never contain row contents or secrets.

export class IngestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'IngestError';
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) throw new TypeError(`invalid error code ${code}`);
    this.code = code;
    this.retryable = opts.retryable ?? false;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

export function isIngestError(e: unknown, code?: string): e is IngestError {
  return e instanceof IngestError && (code === undefined || e.code === code);
}

/** A stable error code for any thrown value (pg SQLSTATEs are mapped to DB_<state>). */
export function errorCodeOf(e: unknown): string {
  if (e instanceof IngestError) return e.code;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `DB_${code}`;
  return 'INTERNAL_ERROR';
}

/**
 * Text that may be persisted or printed for an error. Database errors are
 * reduced to their SQLSTATE: Postgres messages can quote the offending value
 * (a cell of the provider's file), so raw pg text is never stored or logged.
 */
export function messageOf(e: unknown): string {
  if (e instanceof IngestError) return e.message;
  const code = errorCodeOf(e);
  if (code.startsWith('DB_')) return `database error (SQLSTATE ${code.slice(3)})`;
  if (e instanceof Error) return e.message;
  return String(e);
}
