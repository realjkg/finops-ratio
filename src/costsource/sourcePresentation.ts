// Display wording for the offline sandbox sources, keyed by stable source id. The descriptor name,
// note and health detail are values in the public API (GET /api/costsource/*, pinned in part by
// src/compat/golden/api.json), so they stay as they are; the UI reads its wording from here instead.
// Each entry keeps the honesty that matters (offline, not a live integration) without labeling the
// data "synthetic" or "seed": the top bar's Demo badge says the whole environment is a demo.

interface SourceDisplay {
  name?: string;
  note?: string;
  /** Health-check detail as shown after "Test connection" or a failed connect. */
  detail?: string;
}

const cloud = (provider: string): SourceDisplay => ({
  name: `${provider} (offline sandbox)`,
  note: `${provider}-shaped FOCUS rows bundled with this site; offline, not a live ${provider} integration.`,
  detail: `${provider} (offline sandbox): bundled offline rows; no live cloud integration and no network call.`,
});

const SANDBOX_DETAIL = 'Sandbox adapter reachable; serving offline data bundled with this site.';

export const SOURCE_DISPLAY: Readonly<Record<string, SourceDisplay>> = {
  'pointfive-sandbox': { note: 'Offline sandbox mirroring PointFive Opportunities/Anomalies + FOCUS export (documented v1.0).', detail: SANDBOX_DETAIL },
  'focus-file-sandbox': { note: 'Offline sandbox standing in for an on-premises / private-cloud FOCUS export; the live adapter is PR F.', detail: SANDBOX_DETAIL },
  'servicenow-sandbox': {
    name: 'ServiceNow (offline sandbox)',
    note: 'CMDB/ITBM allocation lines, illustrative only. ServiceNow is not assumed to supply billing data (role unconfirmed), so these rows and findings are excluded from headline totals. Not a live integration.',
    detail: 'ServiceNow CMDB/ITBM (offline sandbox): CI-keyed allocation lines; no live integration.',
  },
  'aws-sandbox': cloud('AWS'),
  'azure-sandbox': cloud('Azure'),
  'gcp-sandbox': cloud('GCP'),
};

const entry = (id: string): SourceDisplay | undefined => (Object.hasOwn(SOURCE_DISPLAY, id) ? SOURCE_DISPLAY[id] : undefined);

export const displaySourceName = (s: { id: string; name: string }): string => entry(s.id)?.name ?? s.name;
export const displaySourceNote = (s: { id: string; note: string }): string => entry(s.id)?.note ?? s.note;
/** Only a reachable sandbox's own detail is replaced; errors and other sources pass through unchanged. */
export const displayHealthDetail = (sourceId: string, detail: string, reachable = true): string => (reachable ? entry(sourceId)?.detail : undefined) ?? detail;
