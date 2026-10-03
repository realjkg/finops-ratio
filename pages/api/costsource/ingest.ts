// POST /api/costsource/ingest — accepts a FOCUS payload and normalizes it via
// FocusFileAdapter (focus_file kind sources only).
//
// This is the live path for private-cloud / on-prem FOCUS exports: a caller
// POSTs rows from their billing tool at whatever FOCUS version they export, and
// the adapter upgrades them to canonical v1.4 + attaches Ratio value context.
//
// Body: {
//   sourceId: string           — must be a configured focus_file source
//   version:  FocusVersion     — '1.0' | '1.1' | '1.2' | '1.3' | '1.4'
//   rows:     RawSourceRow[]   — FOCUS-shaped rows at the stated version
//   window?:  CostWindow       — defaults to current calendar month
// }
// Returns: CostRowsResult (normalized v1.4 rows + upgrade audit)
//
// Errors:
//   400 — missing / invalid body fields, or an invalid FOCUS row (named by
//         number — rows are validated, never silently normalized)
//   422 — sourceId is not a focus_file kind source
//   405 — non-POST method

import type { NextApiRequest, NextApiResponse } from 'next';
import { FocusFileAdapter } from '@/costsource/FocusFileAdapter';
import { findSource } from '@/costsource/seed';
import type { CostRowsResult } from '@/costsource';
import type { FocusVersion } from '@/costsource';
import { FOCUS_VERSIONS } from '@/costsource';
import {
  assertValidWindow,
  INVALID_WINDOW_MESSAGE,
  validateFocusRecords,
} from '@/costsource/transports/focusExport';
import { withInternalErrorGuard } from '@/server/gateway/internalError';

function currentMonth(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CostRowsResult | { error: string }>,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body as Record<string, unknown>;

  const sourceId = typeof body?.sourceId === 'string' ? body.sourceId : undefined;
  const versionRaw = typeof body?.version === 'string' ? body.version : undefined;
  const version =
    versionRaw && (FOCUS_VERSIONS as readonly string[]).includes(versionRaw)
      ? (versionRaw as FocusVersion)
      : undefined;
  const rows = Array.isArray(body?.rows) ? body.rows : undefined;

  if (!sourceId || !version || !rows) {
    res.status(400).json({
      error:
        'Body must include sourceId (string), version (\'1.0\'–\'1.4\'), and rows (array).',
    });
    return;
  }

  const src = findSource(sourceId);
  if (!src || src.kind !== 'focus_file') {
    res.status(422).json({
      // Fixed: never echo the caller's sourceId.
      error: 'sourceId is not a focus_file source. Use /api/costsource/rows for other sources.',
    });
    return;
  }

  // Resolve window: accept caller-supplied or default to current calendar month.
  const windowRaw = body?.window;
  const window =
    typeof windowRaw === 'object' &&
    windowRaw !== null &&
    typeof (windowRaw as Record<string, unknown>).start === 'string' &&
    typeof (windowRaw as Record<string, unknown>).end === 'string'
      ? (windowRaw as { start: string; end: string })
      : currentMonth();
  try {
    assertValidWindow(window);
  } catch {
    res.status(400).json({ error: INVALID_WINDOW_MESSAGE });
    return;
  }

  let validated;
  try {
    // Tags and x_* extension columns are preserved for direct ingest.
    validated = validateFocusRecords(rows as Record<string, unknown>[], sourceId, { keepExtensions: true });
  } catch (err) {
    // `<known sourceId>: invalid FOCUS row N: <known column> <fixed reason>` —
    // composed only of server-known tokens; cell values are never quoted.
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const result = FocusFileAdapter.ingest(validated, version, sourceId, window);
  res.status(200).json(result);
}

export default withInternalErrorGuard(handler);
