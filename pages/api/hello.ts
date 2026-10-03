// GET /api/hello — Next.js API route backing the LiveHelloClient.
// Returns a HelloMessage with source='live' so the seam toggle proves
// the real network path end-to-end.
import type { NextApiRequest, NextApiResponse } from 'next';
import type { HelloMessage } from '@/hello/HelloClient';
import { withInternalErrorGuard } from '@/server/gateway/internalError';

function handler(
  _req: NextApiRequest,
  res: NextApiResponse<HelloMessage>,
): void {
  res.status(200).json({
    message: 'Hello from the Next.js API route — live path confirmed.',
    timestamp: new Date().toISOString(),
    source: 'live',
  });
}

export default withInternalErrorGuard(handler);
