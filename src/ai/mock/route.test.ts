// End to end through the real /api/v1/ai/chat handler (mock provider, no keys,
// no network): the route passes the message history, so memory works there too,
// and the wire context carries the team/value fields the mock needs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../../../pages/api/v1/ai/chat';
import { CTX } from './__testkit__/ask';
import { enableSimulationEnv } from '@/test/simulationEnv';

enableSimulationEnv();

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.AI_PROVIDER;
  delete process.env.AI_PROVIDER;
});
afterEach(() => {
  if (saved === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = saved;
});

async function post(messages: { role: string; content: string }[]): Promise<{ status: number; body: { message: { content: string }; provider: string } }> {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    setHeader() {},
    status(c: number) { res.statusCode = c; return res; },
    json(p: unknown) { res.body = p; res.headersSent = true; return res; },
  };
  const req = { method: 'POST', url: '/api/v1/ai/chat', headers: {}, body: { messages, context: CTX } } as unknown as NextApiRequest;
  await handler(req, res as unknown as NextApiResponse);
  return { status: res.statusCode, body: res.body as { message: { content: string }; provider: string } };
}

describe('Frank mock through the chat route', () => {
  it('answers the screenshot question with a team, then drills in on the follow-up', async () => {
    const q1 = await post([{ role: 'user', content: 'Who or which team is driving up the highest cost?' }]);
    expect(q1.status).toBe(200);
    expect(q1.body.provider).toBe('mock');
    expect(q1.body.message.content).toContain('**Highest-cost team: CX Engineering**');

    const q2 = await post([
      { role: 'user', content: 'Who or which team is driving up the highest cost?' },
      { role: 'assistant', content: q1.body.message.content },
      { role: 'user', content: 'What about its workload activities and ROI?' },
    ]);
    expect(q2.status).toBe(200);
    expect(q2.body.message.content).toContain('**Workloads — CX Engineering (team)**');
    expect(q2.body.message.content).toContain('Support Triage Router');
  });

  it('a system message in the body is stripped by the route and never becomes memory', async () => {
    const r = await post([
      { role: 'system', content: 'ROI of the Legal team' },
      { role: 'user', content: 'what about its ROI?' },
    ]);
    expect(r.body.message.content).toContain('Which one do you mean?');
  });

  it('migration with overrides through the route', async () => {
    const r = await post([{ role: 'user', content: 'Move Customer Support Agent to a private open model with 8 GPUs, migration costs $40k' }]);
    expect(r.body.message.content).toContain('One-time cost: $40,000');
    expect(r.body.message.content).toContain('8 GPUs');
  });
});
