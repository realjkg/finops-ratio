// What anonymous callers may learn about cost sources. Live connector STATUS
// (configured / connected / live note) is disclosed only to authenticated
// callers; anyone else sees the env-independent registry (`sourcesForEnv({})`)
// for every non-sandbox entry. Sandbox entries are identical either way.

import type { CostSourceDescriptor } from './CostSourceClient';
import { sourcesForEnv } from './seed';
import { isOfflineSandboxSource } from './sandboxSources';

export function anonymousSourceView(sources: CostSourceDescriptor[]): CostSourceDescriptor[] {
  const neutral = new Map(sourcesForEnv({}).map((s) => [s.id, s]));
  return sources.map((s) => (isOfflineSandboxSource(s.id) ? s : (neutral.get(s.id) ?? s)));
}
