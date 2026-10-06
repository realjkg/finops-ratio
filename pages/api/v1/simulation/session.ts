import { database } from '@/simulation/server/database';
import { IDENTITIES, requireCsrf, sameOrigin, sessionFor, setCookie, simulationRoute, tokenFrom } from '@/simulation/server/http';
import { WorkflowError } from '@/simulation/server/workflow';

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };
export default simulationRoute(['GET', 'POST', 'DELETE'], (req, res) => {
  if (req.method === 'GET') {
    const session = database().session(tokenFrom(req));
    res.status(200).json({ session, identities: IDENTITIES }); return;
  }
  if (req.method === 'DELETE') {
    requireCsrf(req, sessionFor(req)); database().revoke(tokenFrom(req)); setCookie(res, '');
    res.status(200).json({ session: null }); return;
  }
  sameOrigin(req);
  const id = req.body?.identity;
  if (typeof id !== 'string' || !Object.hasOwn(IDENTITIES, id)) throw new WorkflowError(400, 'Choose a simulated identity.');
  database().revoke(tokenFrom(req));
  const { token, ...session } = database().createSession(IDENTITIES[id]);
  setCookie(res, token); res.status(200).json({ session });
});
