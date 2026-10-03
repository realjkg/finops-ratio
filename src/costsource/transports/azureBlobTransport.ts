// Azure Cost Management FOCUS export → Azure Blob Storage, read with a SAS token.
//
// Cost Management writes each FOCUS export run into its own directory under the
// configured container path (`<path>/<YYYYMMDD-YYYYMMDD>/<runId>/part_*.csv.gz`
// plus a manifest). AZURE_FOCUS_EXPORT_URL is either:
//   - the container (optionally + path prefix), e.g.
//     https://acct.blob.core.windows.net/cost-exports/focus/ratio-daily
//     → the transport lists blobs and reads the latest run for the window; or
//   - a single blob URL ending in .csv / .csv.gz / .json → read directly.
// The SAS needs `r` (read) + `l` (list) on the container.

import type { FocusExportTransport } from '../CloudConnectorAdapter';
import type { RawSourceRow } from '../focusRows';
import {
  assertExportFileCap,
  decodeExportBytes,
  fetchChecked,
  listingTruncatedError,
  rowsFromExportText,
  selectExportObjects,
  xmlValues,
  type ExportObject,
  type FetchLike,
} from './focusExport';

export interface AzureBlobTransportOptions {
  exportUrl: string;
  sasToken: string;
  fetch?: FetchLike;
}

const LABEL = 'Azure Blob FOCUS export';
const DIRECT_BLOB = /\.(csv|csv\.gz|gz|json|ndjson|jsonl)$/i;

export interface AzureLocation {
  origin: string; // https://acct.blob.core.windows.net
  container: string;
  prefix: string; // '' or 'path/to/exports/'
  directBlob: boolean;
}

export function parseAzureExportUrl(exportUrl: string): AzureLocation {
  const url = new URL(exportUrl);
  const [container, ...rest] = url.pathname.replace(/^\/+/, '').split('/');
  if (!container) {
    throw new Error('AZURE_FOCUS_EXPORT_URL must include the container, e.g. https://acct.blob.core.windows.net/exports');
  }
  const path = rest.filter(Boolean).join('/');
  const directBlob = DIRECT_BLOB.test(path);
  return {
    origin: url.origin,
    container,
    prefix: directBlob || !path ? path : `${path}/`,
    directBlob,
  };
}

/** Blob listing XML → export objects. */
export function parseAzureListing(xml: string): { objects: ExportObject[]; nextMarker: string } {
  const blocks = xml.match(/<Blob>[\s\S]*?<\/Blob>/g) ?? [];
  const objects = blocks.map((b) => ({
    key: xmlValues(b, 'Name')[0] ?? '',
    lastModified: xmlValues(b, 'Last-Modified')[0] ?? '',
    size: Number(xmlValues(b, 'Content-Length')[0] ?? 0),
  }));
  return { objects, nextMarker: xmlValues(xml, 'NextMarker')[0] ?? '' };
}

export function createAzureBlobTransport(opts: AzureBlobTransportOptions): FocusExportTransport {
  const fetchImpl = opts.fetch ?? fetch;
  const sas = opts.sasToken.replace(/^\?/, '');
  const loc = parseAzureExportUrl(opts.exportUrl);
  const headers = { 'x-ms-version': '2021-08-06' };

  const blobUrl = (name: string) =>
    `${loc.origin}/${loc.container}/${name.split('/').map(encodeURIComponent).join('/')}?${sas}`;

  /**
   * Lists the container prefix. A full listing (fetchExportRows) THROWS if pages
   * remain after `maxPages`; only ping's 1-page reachability probe may stop early.
   */
  async function list(maxPages = 20, allowPartial = false): Promise<ExportObject[]> {
    const all: ExportObject[] = [];
    let marker = '';
    let more = false;
    for (let page = 0; page < maxPages; page += 1) {
      const params = new URLSearchParams({ restype: 'container', comp: 'list' });
      if (loc.prefix) params.set('prefix', loc.prefix);
      if (marker) params.set('marker', marker);
      const res = await fetchChecked(
        fetchImpl,
        `${loc.origin}/${loc.container}?${params.toString()}&${sas}`,
        { headers },
        LABEL,
      );
      const { objects, nextMarker } = parseAzureListing(await res.text());
      all.push(...objects);
      more = Boolean(nextMarker);
      if (!more) break;
      marker = nextMarker;
    }
    if (more && !allowPartial) throw listingTruncatedError(LABEL, maxPages);
    return all;
  }

  async function readBlob(name: string): Promise<string> {
    const res = await fetchChecked(fetchImpl, blobUrl(name), { headers }, LABEL);
    return decodeExportBytes(new Uint8Array(await res.arrayBuffer()), name);
  }

  return {
    async ping() {
      if (loc.directBlob) {
        await fetchChecked(fetchImpl, blobUrl(loc.prefix), { method: 'HEAD', headers }, LABEL);
      } else {
        await list(1, true);
      }
      return true;
    },
    async fetchExportRows(window) {
      const names = loc.directBlob
        ? [loc.prefix]
        : selectExportObjects(await list(), window).map((o) => o.key);
      if (names.length === 0) {
        throw new Error(`${LABEL}: no CSV/JSON export files found under ${loc.container}/${loc.prefix}`);
      }
      assertExportFileCap(names.length, LABEL);
      const rows: RawSourceRow[] = [];
      for (const name of names) rows.push(...rowsFromExportText(await readBlob(name), window, `${LABEL} ${name}`));
      return rows;
    },
  };
}
