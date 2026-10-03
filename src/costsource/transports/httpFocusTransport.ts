// Generic HTTPS FOCUS-endpoint transport. Serves every connector whose source
// exposes its FOCUS export over a plain URL: Kubernetes (OpenCost / Kubecost),
// Nutanix Cloud Manager.
//
// The endpoint may return CSV, JSON, or NDJSON, optionally gzip-compressed.
// Window placeholders `{start}` / `{end}` in the URL are substituted (URL-
// encoded ISO 8601) so a server that filters by period can do so; without them
// the URL is fetched as-is and rows are window-filtered client-side.

import type { CostWindow } from '../CostSourceClient';
import type { FocusExportTransport } from '../CloudConnectorAdapter';
import {
  DEFAULT_MAX_OBJECT_BYTES,
  decodeExportBytes,
  fetchChecked,
  readBodyCapped,
  rowsFromExportText,
  windowIso,
  type FetchLike,
} from './focusExport';

export interface HttpFocusTransportOptions {
  endpoint: string;
  /** Header carrying the credential, e.g. `Authorization` or `X-ntnx-api-key`. */
  authHeader?: string;
  /** Credential value. For `Authorization`, a bare token is sent as `Bearer <token>`. */
  token?: string;
  label: string;
  fetch?: FetchLike;
  /** Cap on the export body, counted while streaming (default 512 MiB). */
  maxObjectBytes?: number;
}

/** Substitutes the parsed, normalized UTC instants (never the raw strings). */
export function expandWindow(endpoint: string, window: CostWindow): string {
  const w = windowIso(window);
  return endpoint
    .replace(/\{start\}/g, encodeURIComponent(w.start))
    .replace(/\{end\}/g, encodeURIComponent(w.end));
}

function currentMonthWindow(): CostWindow {
  const now = new Date();
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  };
}

export function createHttpFocusTransport(opts: HttpFocusTransportOptions): FocusExportTransport {
  const fetchImpl = opts.fetch ?? fetch;
  const headers: Record<string, string> = {
    Accept: 'text/csv, application/json, application/x-ndjson;q=0.9, */*;q=0.5',
  };
  if (opts.token) {
    const header = opts.authHeader ?? 'Authorization';
    headers[header] =
      header.toLowerCase() === 'authorization' && !/^\w+\s/.test(opts.token)
        ? `Bearer ${opts.token}`
        : opts.token;
  }

  async function get(window: CostWindow): Promise<Response> {
    return fetchChecked(fetchImpl, expandWindow(opts.endpoint, window), { headers }, opts.label);
  }

  return {
    async ping() {
      // A GET of the current month proves reachability AND auth in one call.
      const res = await get(currentMonthWindow());
      await res.body?.cancel();
      return true;
    },
    async fetchExportRows(window) {
      const res = await get(window);
      const bytes = await readBodyCapped(res, opts.label, opts.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES);
      const text = await decodeExportBytes(bytes, opts.label);
      return rowsFromExportText(text, window, opts.label);
    },
  };
}
