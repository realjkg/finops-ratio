import { afterEach, expect, it, vi } from 'vitest';
import { useStore } from './useStore';
import { simulationRequest } from '@/simulation/client';
import { seedWorkspace } from '@/simulation/server/workflow';
import type { SimSession } from '@/simulation/types';
vi.mock('@/simulation/client', async importOriginal => ({ ...await importOriginal<typeof import('@/simulation/client')>(), simulationRequest: vi.fn() }));
const session = (csrf: string): SimSession => ({ csrf, expiresAt: Date.now() + 1000, identity: { tenant: csrf, user: csrf, persona: 'technical' } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
afterEach(() => { useStore.getState().clearSimulation(); vi.mocked(simulationRequest).mockReset(); });
it('old command completion cannot unlock a new identity command', async () => {
  const first = deferred<ReturnType<typeof seedWorkspace>>(), second = deferred<ReturnType<typeof seedWorkspace>>();
  vi.mocked(simulationRequest).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  useStore.getState().loadSimulation(session('A'), seedWorkspace());
  const a = useStore.getState().simulationCommand({ type: 'sync', source: 'aws' });
  useStore.getState().clearSimulation(); useStore.getState().loadSimulation(session('B'), seedWorkspace());
  const b = useStore.getState().simulationCommand({ type: 'sync', source: 'azure' });
  first.resolve(seedWorkspace()); await a;
  expect(useStore.getState().simulation?.session.csrf).toBe('B');
  expect(useStore.getState().simulationBusy).toBe(true);
  second.resolve(seedWorkspace()); await b;
  expect(useStore.getState().simulationBusy).toBe(false);
});
it('old chat rejection cannot contaminate or stop a new identity conversation', async () => {
  const first = deferred<never>(), second = deferred<never>();
  vi.mocked(simulationRequest).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  useStore.getState().loadSimulation(session('A'), seedWorkspace());
  const a = useStore.getState().sendAIMessage('A request');
  useStore.getState().clearSimulation(); useStore.getState().loadSimulation(session('B'), seedWorkspace());
  const b = useStore.getState().sendAIMessage('B request');
  first.reject(new Error('A failure')); await a;
  expect(useStore.getState().aiMessages.map(x => x.content)).toEqual(['B request']);
  expect(useStore.getState().aiThinking).toBe(true);
  second.reject(new Error('B failure')); await b;
  expect(useStore.getState().aiMessages.at(-1)?.content).toBe('AI error: B failure');
  expect(useStore.getState().aiThinking).toBe(false);
});

it('a same-session command during a question: the answer still lands, with no "session" notice', async () => {
  const ws = seedWorkspace();
  const session = { csrf: 'A', identity: { tenant: 't', user: 'u', persona: 'technical' } } as unknown as SimSession;
  useStore.getState().loadSimulation(session, ws);
  const chat = deferred<{ message: { role: 'assistant'; content: string }; initiativesReferenced: string[]; provider: 'mock' }>();
  const command = deferred<ReturnType<typeof seedWorkspace>>();
  vi.mocked(simulationRequest).mockImplementation((path: string) => (path === 'chat' ? chat.promise : command.promise) as never);
  const asking = useStore.getState().sendAIMessage('which initiative is riskiest?');
  const commanding = useStore.getState().simulationCommand({ type: 'refresh' } as never);
  command.resolve({ ...ws, revision: ws.revision + 1 });
  await commanding;
  chat.resolve({ message: { role: 'assistant', content: 'Fraud Triage.' }, initiativesReferenced: [], provider: 'mock' });
  await asking;
  const msgs = useStore.getState().aiMessages;
  expect(msgs.at(-1)).toMatchObject({ role: 'assistant', content: expect.stringContaining('Fraud Triage.') });
  expect(msgs.some((m) => /simulation session was loaded/.test(m.content))).toBe(false);
  expect(useStore.getState().aiThinking).toBe(false);
});

it('a simulation-path timeout reads in plain words, whatever the browser calls it', async () => {
  const ws = seedWorkspace();
  useStore.getState().loadSimulation({ csrf: 'A', identity: { tenant: 't', user: 'u', persona: 'technical' } } as unknown as SimSession, ws);
  vi.mocked(simulationRequest).mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));
  await useStore.getState().sendAIMessage('q');
  expect(useStore.getState().aiMessages.at(-1)?.content).toBe('AI error: The request timed out. Ask again.');
});
