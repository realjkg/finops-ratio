// Browser Live*Clients never build a thrown message from raw response text.
// A non-2xx becomes `<label> error <status>`, plus — only when the body is the
// known safe envelope ({error: string} or {error: {message: string}}, which the
// server now fills with fixed text) — that envelope's message. Anything else in
// the body (proxy HTML, upstream text, stack traces) is dropped.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveAIClient } from '@/ai/LiveAIClient';
import { LiveHelloClient } from '@/hello/LiveHelloClient';
import { LivePredictionClient } from '@/prediction/LivePredictionClient';
import { LiveTokenomicsClient } from '@/tokenomics/LiveTokenomicsClient';
import { LiveCostSourceClient } from '@/costsource/LiveCostSourceClient';
import { LiveCMClient } from '@/cm/LiveCMClient';
import { LiveFinioClient } from '@/finio/LiveFinioClient';
import { describeHttpErrorBody, envelopeMessage } from './httpError';

const MARKER = 'RAW-BODY-MARKER';

afterEach(() => vi.unstubAllGlobals());

type Case = [label: string, call: () => Promise<unknown>];

const CASES: Case[] = [
  ['AI chat', () => new LiveAIClient().chat([], {} as never)],
  ['Hello API', () => new LiveHelloClient().getGreeting()],
  ['Prediction API', () => new LivePredictionClient().predictChange({ type: 'scale', workloadId: 'w', volumeMultiplier: 2 })],
  ['Accuracy API', () => new LivePredictionClient().getAccuracyReport()],
  ['Tokenomics API', () => new LiveTokenomicsClient().getTokenomicsReport()],
  ['CostSource listSources', () => new LiveCostSourceClient().listSources()],
  ['CostSource fetchCostRows', () => new LiveCostSourceClient().fetchCostRows('s', { start: 'a', end: 'b' })],
  ['CostSource fetchFindings', () => new LiveCostSourceClient().fetchFindings('s')],
  ['CostSource healthCheck', () => new LiveCostSourceClient().healthCheck('s')],
  [
    'CM gateway',
    () =>
      new LiveCMClient().createChange(
        { workloadId: 'w', workloadName: 'n', recommendedAction: 'a', projectedMonthlyImpact: 1 },
        'a',
      ),
  ],
  ['CM gateway', () => new LiveCMClient().getStatus('OPS-1')],
  [
    'FinIO handshake',
    () => new LiveFinioClient().handshake({ agentId: 'a', capabilities: ['finio.export'], focusVersion: '1.4', nonce: 'n' }),
  ],
  ['FinIO export', () => new LiveFinioClient().export('s')],
];

function respond(body: string, status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
}

async function messageOf(call: () => Promise<unknown>): Promise<string> {
  const err = await call().then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

describe.each(CASES)('%s', (label, call) => {
  it('a raw (non-JSON) body is never quoted: "<label> error <status>"', async () => {
    respond(`<html>${MARKER} upstream stack at /srv/app.js:12</html>`, 502);
    expect(await messageOf(call)).toBe(`${label} error 502`);
  });

  it('a JSON body that is not the envelope is not quoted', async () => {
    respond(JSON.stringify({ detail: MARKER, trace: ['x'] }), 400);
    expect(await messageOf(call)).toBe(`${label} error 400`);
  });

  it('the gateway envelope contributes only its (fixed) message', async () => {
    respond(JSON.stringify({ error: { code: 'internal_error', message: 'Internal error', requestId: 'rid-1' } }), 500);
    expect(await messageOf(call)).toBe(`${label} error 500: Internal error`);
  });

  it('the flat envelope contributes only its (fixed) message', async () => {
    respond(JSON.stringify({ error: 'Unknown cost source', requestId: 'rid-2', extra: MARKER }), 404);
    const msg = await messageOf(call);
    expect(msg).toBe(`${label} error 404: Unknown cost source`);
    expect(msg).not.toContain(MARKER);
  });
});

describe.each(CASES)('%s — proxy / WAF envelope-shaped bodies', (label, call) => {
  it('a flat envelope with arbitrary text is not quoted', async () => {
    respond(JSON.stringify({ error: `${MARKER} blocked by WAF rule 942100` }), 403);
    const msg = await messageOf(call);
    expect(msg).toBe(`${label} error 403`);
    expect(msg).not.toContain(MARKER);
  });

  it('a nested envelope with an unknown code and arbitrary message is not quoted', async () => {
    respond(JSON.stringify({ error: { code: `waf_${MARKER}`, message: `${MARKER} denied` } }), 403);
    const msg = await messageOf(call);
    expect(msg).toBe(`${label} error 403`);
    expect(msg).not.toContain(MARKER);
  });

  it('a known code with an unknown message surfaces the code only', async () => {
    respond(JSON.stringify({ error: { code: 'rate_limited', message: `${MARKER} slow down` } }), 429);
    const msg = await messageOf(call);
    expect(msg).toBe(`${label} error 429: rate_limited`);
    expect(msg).not.toContain(MARKER);
  });
});

describe('allow-list', () => {
  it('surfaces only exact allow-listed messages (no prefix / suffix / long variants)', () => {
    expect(envelopeMessage(JSON.stringify({ error: 'Internal error' }))).toBe('Internal error');
    expect(envelopeMessage(JSON.stringify({ error: `Internal error ${MARKER}` }))).toBeNull();
    expect(envelopeMessage(JSON.stringify({ error: 'A'.repeat(500) }))).toBeNull();
    expect(describeHttpErrorBody('X', 500, JSON.stringify({ error: 'B'.repeat(1000) }))).toBe('X error 500');
  });

  it("every fixed message / code our own routes emit is allow-listed", async () => {
    const { INTERNAL_ERROR_MESSAGE } = await import('@/server/gateway/internalError');
    const costsource = await import('@/server/costsourceRouteErrors');
    const { INVALID_WINDOW_MESSAGE } = await import('@/costsource/transports/focusExport');
    const { WEAK_TOKEN_MESSAGE, THROTTLED_MESSAGE } = await import('@/server/gateway/liveDataAuth');
    const ticket = await import('@/cm/ticketRef');
    const finio = await import('@/finio/exchange');
    const { SAFE_ERROR_MESSAGES, SAFE_ERROR_CODES } = await import('./httpError');
    const messages = [
      INTERNAL_ERROR_MESSAGE,
      costsource.UNKNOWN_SOURCE_MESSAGE,
      costsource.NOT_CONFIGURED_MESSAGE,
      costsource.NO_COST_ROWS_MESSAGE,
      INVALID_WINDOW_MESSAGE,
      WEAK_TOKEN_MESSAGE,
      THROTTLED_MESSAGE,
      ticket.INVALID_JIRA_REF_MESSAGE,
      ticket.INVALID_SERVICENOW_REF_MESSAGE,
      finio.FOCUS_VERSION_UNSUPPORTED_MESSAGE,
      finio.INVALID_SESSION.message,
    ];
    for (const m of messages) expect(SAFE_ERROR_MESSAGES.has(m), m).toBe(true);
    for (const c of ['internal_error', 'invalid_request', 'unauthorized', 'rate_limited', finio.INVALID_SESSION.code, 'focus_version_mismatch']) {
      expect(SAFE_ERROR_CODES.has(c), c).toBe(true);
    }
  });
});

// --- Round 6: a failed response whose BODY READ rejects -----------------------
// fetch() resolves, but res.text() / the body stream then fails (connection
// reset mid-body). Every client must still throw its typed
// "<label> error <status>" error — never the raw stream error.

const STREAM_MARKER = 'STREAM-MARKER socket hang up at 10.0.0.7:443';

/** A real Response whose body stream errors as soon as it is read. */
function erroringStreamResponse(status: number): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.error(new Error(STREAM_MARKER));
    },
  });
  return new Response(stream, { status });
}

/** A Response-like object whose text() / json() reject. */
function rejectingBodyResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: () => Promise.reject(new Error(STREAM_MARKER)),
    json: () => Promise.reject(new Error(STREAM_MARKER)),
  } as unknown as Response;
}

describe.each(CASES)('%s — body read rejects on a failed response', (label, call) => {
  it.each([
    ['erroring body stream', erroringStreamResponse],
    ['rejecting text()', rejectingBodyResponse],
  ] as const)('%s → typed "<label> error <status>", no stream text', async (_k, make) => {
    for (const status of [500, 401, 403]) {
      vi.stubGlobal('fetch', vi.fn(async () => make(status)));
      const err = await call().then(
        () => {
          throw new Error('expected a rejection');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).not.toContain('STREAM-MARKER');
      expect(msg).not.toContain('socket hang up');
      // LiveCostSourceClient maps every 401 to its typed LiveDataAuthError
      // without reading the body; everything else is the label + status.
      if (!(label.startsWith('CostSource') && status === 401)) {
        expect(msg).toBe(`${label} error ${status}`);
      }
    }
  });
});

describe('FinIO handshake peer-auth with an unreadable body', () => {
  it('a 401 whose body cannot be read is the typed FinIO HTTP error (code unknown), not a raw stream error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rejectingBodyResponse(401)));
    const err = (await new LiveFinioClient()
      .handshake({ agentId: 'a', capabilities: ['finio.export'], focusVersion: '1.4', nonce: 'n' })
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('FinIO handshake error 401');
    expect(err.message).not.toContain('STREAM-MARKER');
  });

  it('a readable unauthorized_peer 401 is still FinioPeerAuthError', async () => {
    const { FinioPeerAuthError } = await import('@/finio/LiveFinioClient');
    respond(JSON.stringify({ error: { code: 'unauthorized_peer', message: 'Missing FinIO peer token' } }), 401);
    const err = await new LiveFinioClient()
      .handshake({ agentId: 'a', capabilities: ['finio.export'], focusVersion: '1.4', nonce: 'n' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FinioPeerAuthError);
  });
});

