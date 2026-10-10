import { database } from '@/simulation/server/database';
import { sessionFor, simulationRoute } from '@/simulation/server/http';
export default simulationRoute(['GET'], (req, res) => {
  const { identity } = sessionFor(req);
  res.status(200).json(database().read(identity.tenant));
});
