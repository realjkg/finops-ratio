// The offline sandbox sources: bundled seed data, no credentials, no network.
// They are the ONLY sources served anonymously by the live-data routes.
// Client-safe (no server imports), so the UI can decide which actions to offer.

export const OFFLINE_SANDBOX_SOURCE_IDS: ReadonlySet<string> = new Set([
  'pointfive-sandbox',
  'focus-file-sandbox',
]);

export function isOfflineSandboxSource(sourceId: string): boolean {
  return OFFLINE_SANDBOX_SOURCE_IDS.has(sourceId);
}
