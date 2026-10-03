// The reviewed 0001 foundation manifest. Since round 14 the manifests live next
// to the migrations as GENERATED `NNNN_name.manifest.json` files (one per
// migration that changes the reviewed foundation; see
// scripts/ingest/generate-foundation-manifest.mjs) so that the expected
// snapshot is versioned by applied migration state. This module exposes the
// 0001 manifest for the policy-shape rules and the tests.
import { DEFAULT_MIGRATIONS_DIR, loadManifests } from './migrationFiles';

export const FOUNDATION_0001: readonly string[] = (() => {
  const m = loadManifests(DEFAULT_MIGRATIONS_DIR)['0001'];
  if (!m) throw new Error('0001_ratio_schema.manifest.json is missing from the migrations directory');
  return m;
})();
