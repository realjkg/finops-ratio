// M0b: shared evidence types for every managed connector. Worker-only module
// family (src/connectors/managed/evidence/**); no web route may import it.

/** Where an original came from: an object in a store, or one page of an API/query response. */
export type ObjectIdentity =
  | { kind: 'object'; bucket: string; key: string; etag?: string; versionId?: string }
  | { kind: 'page'; endpoint: string; method: string; params: Record<string, string>; pageIndex: number; requestId?: string; jobId?: string; pageToken?: string };

export interface CapturedOriginal {
  sha256: string;
  byteSize: number;
  /** Key in the restricted evidence store. */
  key: string;
  identity: ObjectIdentity;
  retrievedAt: string;
  stored: 'stored' | 'exists';
}

/** A column-list snapshot of what was actually delivered, with its sha256. */
export interface SchemaSnapshot { columns: string[]; sha256: string }

/** Each version is its own field; 'unknown' when the source does not state it. Never merged, never invented. */
export interface VersionFacts {
  provider: string;
  dataset: string;
  apiVersion: string;
  exportSchemaVersion: string;
  observedSchema: SchemaSnapshot | 'unknown';
  sourceFocusVersion: string;
  mappingVersion: string;
  canonicalModelVersion: string;
}

export interface DeliveryInventory {
  scope: string;
  usageWindow: { start: string; end: string } | 'unknown';
  billingPeriod: string | 'unknown';
  extractedAt: string;
  filters: Record<string, string>;
  grouping: string[];
  /** complete: manifest present and every listed object read, or every page consumed. */
  completion: 'complete' | 'incomplete';
  revision: string | 'unknown';
  exclusions: string[];
}

export type FixtureClass = 'original' | 'sanitized' | 'synthetic';
export type FixtureUse = 'contract-test' | 'reconciliation-proof' | 'demo';
export type Readiness = 'none' | 'demo' | 'fixture' | 'live';
/** T transport, S schema mapping, F financial-role verification, O operational. */
export interface ReadinessDimensions { T: Readiness; S: Readiness; F: Readiness; O: Readiness }
