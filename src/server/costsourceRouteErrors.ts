// Fixed 4xx messages for the /api/costsource routes. SERVER-SIDE ONLY.
//
// The adapters throw descriptive errors that quote the caller's sourceId (and,
// for connectors, which env keys are missing). Those specifics go to the server
// log; the caller gets one of these fixed strings, so nothing they sent is
// echoed back. Anything not recognised here is an internal error (generic 500).

export const UNKNOWN_SOURCE_MESSAGE = 'Unknown cost source';
export const NOT_CONFIGURED_MESSAGE = 'Cost source is not configured — live credentials required';
export const NO_COST_ROWS_MESSAGE = 'Cost source does not provide cost rows';

export interface ClassifiedError {
  status: number;
  message: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Only the cost-source client's own "Unknown cost source '<id>'" error is a 404. */
export function classifyUnknownSource(err: unknown): ClassifiedError | null {
  return messageOf(err).startsWith('Unknown cost source')
    ? { status: 404, message: UNKNOWN_SOURCE_MESSAGE }
    : null;
}

/**
 * The cost-rows path's known refusals:
 *   "Unknown cost source '<id>'"                                → 404
 *   "<name> not configured (<state>) — …" / "… is not configured — …" → 409
 *   "Source '<id>' does not provide cost rows"                 → 422
 */
export function classifyCostRowsError(err: unknown): ClassifiedError | null {
  const unknown = classifyUnknownSource(err);
  if (unknown) return unknown;
  const message = messageOf(err);
  if (/ not configured (\(|—)/.test(message)) return { status: 409, message: NOT_CONFIGURED_MESSAGE };
  if (/^Source '[\s\S]*' does not provide cost rows$/.test(message)) {
    return { status: 422, message: NO_COST_ROWS_MESSAGE };
  }
  return null;
}
