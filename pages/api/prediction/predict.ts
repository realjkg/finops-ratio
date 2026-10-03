// POST /api/prediction/predict — predict a proposed change's cost impact.
// Delegates to the mock client seam; pure over offline seed data. Mirrors the
// costsource route's thin shape.
//
// Errors:
//   400 — missing/invalid ProposedChange body
//   404 — unknown workload or model
//   405 — non-POST method
import type { NextApiRequest, NextApiResponse } from 'next';
import { createPredictionClient } from '@/prediction';
import type { ChangePrediction, ProposedChange } from '@/prediction';
import { withInternalErrorGuard } from '@/server/gateway/internalError';
import { renderThrown } from '@/costsource/transports/redact';

/** Known "unknown id" refusals → fixed 404 strings that never echo the input. */
function classify(err: unknown): string | null {
  const message = renderThrown(err);
  if (message.startsWith('Unknown workload:')) return 'Unknown workload';
  if (message.startsWith('Unknown model in switch:')) return 'Unknown model';
  return null;
}

const CHANGE_TYPES = ['model_switch', 'demand_shape', 'scale', 'budget'] as const;
const UNKNOWN_TYPE_MESSAGE = `\`type\` must be one of ${CHANGE_TYPES.join(', ')}`;

function isProposedChange(body: unknown): body is ProposedChange {
  return (
    typeof body === 'object' &&
    body !== null &&
    'type' in body &&
    'workloadId' in body
  );
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ChangePrediction | { error: string }>,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!isProposedChange(req.body)) {
    res
      .status(400)
      .json({ error: 'A ProposedChange with `type` and `workloadId` is required' });
    return;
  }

  // Fixed 400 for an unknown change type (never echoed); previously it fell
  // through the predictor switch and surfaced as a 500.
  if (!(CHANGE_TYPES as readonly unknown[]).includes((req.body as { type?: unknown }).type)) {
    res.status(400).json({ error: UNKNOWN_TYPE_MESSAGE });
    return;
  }

  const client = createPredictionClient('mock');
  try {
    res.status(200).json(await client.predictChange(req.body));
  } catch (err) {
    const known = classify(err);
    if (!known) throw err; // the guard's generic 500
    res.status(404).json({ error: known });
  }
}

export default withInternalErrorGuard(handler);

