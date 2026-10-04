// The reviewed 0001 foundation manifest. Since round 14 the manifests live next
// to the migrations as GENERATED `NNNN_name.manifest.json` files (one per
// migration that changes the reviewed foundation; see
// scripts/ingest/generate-foundation-manifest.mjs) so that the expected
// snapshot is versioned by applied migration state. This module exposes the
// 0001 manifest for the policy-shape rules and the tests.
//
// LAZY since Slice 2: importing this module (or privilegeModel) does no file
// I/O. The manifest is read on FIRST USE and memoised. Bundlers (Next 16 /
// Turbopack) rewrite __dirname, so an import-time read crashed the read API,
// which imports privilegeModel for REFUSED_PREDEFINED_ROLES. A missing
// directory, a missing 0001 manifest or a corrupt one still fails closed, at
// first use and on every later use, with the same error as before.
import { DEFAULT_MIGRATIONS_DIR, loadManifests } from './migrationFiles';

/**
 * A read-only array computed on first use and memoised (a failed computation
 * is NOT memoised: every use throws again). Behaves as the array it stands
 * for (Array.isArray, length, indexes, iteration, every Array method,
 * JSON.stringify); writes are refused (TypeError in strict mode).
 */
export function lazyReadonlyArray<T>(compute: () => readonly T[]): readonly T[] {
  let value: T[] | undefined;
  const get = (): T[] => {
    if (value === undefined) value = [...compute()];
    return value;
  };
  return new Proxy([] as T[], {
    get: (_target, p) => Reflect.get(get(), p),
    has: (_target, p) => Reflect.has(get(), p),
    ownKeys: () => Reflect.ownKeys(get()),
    getOwnPropertyDescriptor: (_target, p) => Reflect.getOwnPropertyDescriptor(get(), p),
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

export const FOUNDATION_0001: readonly string[] = lazyReadonlyArray(() => {
  const m = loadManifests(DEFAULT_MIGRATIONS_DIR)['0001'];
  if (!m) throw new Error('0001_ratio_schema.manifest.json is missing from the migrations directory');
  return m;
});
