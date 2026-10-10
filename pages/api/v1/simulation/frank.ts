import { frankGuide } from "@/agent-workflows/frank";
import { database } from "@/simulation/server/database";
import {
  requireCsrf,
  sessionFor,
  simulationRoute,
} from "@/simulation/server/http";
import { WorkflowError } from "@/simulation/server/workflow";
export const config = { api: { bodyParser: { sizeLimit: "8kb" } } };
export default simulationRoute(["POST"], (req, res) => {
  const session = sessionFor(req);
  requireCsrf(req, session);
  const { workloadId, question } = req.body ?? {};
  if (
    typeof workloadId !== "string" ||
    typeof question !== "string" ||
    !question.trim() ||
    question.length > 2000
  )
    throw new WorkflowError(
      400,
      "Choose an initiative and ask a question of up to 2,000 characters.",
    );
  const state = database().read(session.identity.tenant);
  if (!state.workloads.some((w) => w.id === workloadId))
    throw new WorkflowError(404, "Initiative not found.");
  res
    .status(200)
    .json(frankGuide(state, session.identity, workloadId, question));
});
