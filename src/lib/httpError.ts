// Browser-safe description of a non-2xx response for the Live*Clients.
//
// Never quotes raw response text (proxy HTML, upstream bodies, stack traces).
// The message is `<label> error <status>`, plus `: <message>` only when the
// body is one of the repo's known envelopes — `{ error: string }` or
// `{ error: { message: string } }` — whose message the server fills with fixed
// text (generic "Internal error" for 500s, fixed strings for 4xx).

const MAX_ENVELOPE_MESSAGE_CHARS = 200;

/** The envelope's message, or null when the body is not a known envelope. */
export function envelopeMessage(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const error = (parsed as { error?: unknown }).error;
  const message =
    typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : null;
  if (message === null || message.length === 0) return null;
  return message.slice(0, MAX_ENVELOPE_MESSAGE_CHARS);
}

/** `<label> error <status>[: <envelope message>]` from an already-read body. */
export function describeHttpErrorBody(label: string, status: number, body: string): string {
  const message = envelopeMessage(body);
  return message ? `${label} error ${status}: ${message}` : `${label} error ${status}`;
}

/** Read the body (never throws) and describe the failure. */
export async function describeHttpError(label: string, res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return describeHttpErrorBody(label, res.status, body);
}
