import { database } from '@/simulation/server/database';
import { requireCsrf, sessionFor, simulationRoute } from '@/simulation/server/http';
import { WorkflowError } from '@/simulation/server/workflow';
export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };
export default simulationRoute(['POST'], (req, res) => {
  const session = sessionFor(req); requireCsrf(req, session);
  const { revision, id, command } = req.body ?? {};
  if (!Number.isSafeInteger(revision) || revision < 0 || typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(id) || !command || typeof command.type !== 'string') throw new WorkflowError(400, 'Invalid command.');
  res.status(200).json(database().command(session.identity, revision, id, command));
});
