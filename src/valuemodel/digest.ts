// sha256 over the canonical JSON of a record, so an approval, a result and a published snapshot are bound to the exact
// content they were made from. Server-side only (node:crypto); the pure modules never hash.
import { createHash } from 'node:crypto';
import { canonicalJson } from './kpiDefinition';

export const digestOf = (v: unknown): string => `sha256:${createHash('sha256').update(canonicalJson(v)).digest('hex')}`;
