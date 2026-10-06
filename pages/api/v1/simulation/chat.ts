import { frankGuide } from '@/agent-workflows/frank';
import { database } from '@/simulation/server/database';
import { requireCsrf, sessionFor, simulationRoute } from '@/simulation/server/http';
import { WorkflowError } from '@/simulation/server/workflow';
import { MockAIClient } from '@/ai/MockAIClient';
import { buildAIContext } from '@/ai/buildAIContext';
export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };
export default simulationRoute(['POST'], async (req, res) => {
  const session = sessionFor(req); requireCsrf(req, session);
  const message = req.body?.message;
  if (typeof message !== 'string' || !message.trim() || message.length > 2000) throw new WorkflowError(400, 'Enter a question of up to 2,000 characters.');
  const state = database().read(session.identity.tenant);
  if (/baseline|owner|evidence|full cost|expand|governance|permission|credential/.test(message.toLowerCase())) {
    const workloadId = req.body?.workloadId ?? state.workloads[0].id;
    if (typeof workloadId !== 'string' || !state.workloads.some(w => w.id === workloadId)) throw new WorkflowError(404, 'Initiative not found.');
    const guide = frankGuide(state, session.identity, workloadId, message);
    res.status(200).json({ message: { role: 'assistant', content: `${guide.initiative} · saved revision ${guide.revision}\n${guide.message}` }, initiativesReferenced: [workloadId], provider: 'mock' }); return;
  }
  const answer = await new MockAIClient().chat([{ role: 'user', content: message }], buildAIContext(state.workloads, null, new Date(state.asOf), { budgets: state.budgets, alerts: state.alerts }));
  res.status(200).json(answer);
});
