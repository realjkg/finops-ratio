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
