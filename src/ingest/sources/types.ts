// Source contract. Designed for extension; two implementations exist:
// S3FocusExportSource (the one real source, D2) and FakeFocusSource (tests).
//
// Deviation from the original brief (required by D6): openArtifact returns RAW
// BYTES, not rows — the worker stores them as evidence first and parses only
// the evidence copy. The artifact sha256 is computed during that capture, so a
// ref carries an opaque `version` (e.g. S3 ETag) instead of a fingerprint.
import type { Readable } from 'stream';

export interface PeriodRange {
  /** 'YYYY-MM-01' inclusive */
  from: string;
  /** 'YYYY-MM-01' inclusive */
  to: string;
}

export interface ArtifactRef {
  /** Name relative to the period's data folder (e.g. '<runId>/<file>.csv.gz'); stored in ingest_artifacts. */
  name: string;
  /** Source object key (never stored in the database). */
  key: string;
  byteSize: number;
  /** Opaque source version (S3 ETag / fake sha256) used only for the cheap listing fingerprint. */
  version: string;
}

export interface ArtifactSetControl {
  rowCount?: number;
  /** Exact decimal string. */
  billedTotal?: string;
  /** Per-artifact row counts keyed by ArtifactRef.name. */
  artifactRowCounts?: Record<string, number>;
}

export interface ManifestBytes {
  name: string;
  bytes: Buffer;
}

export interface PeriodArtifactSet {
  /** 'YYYY-MM-01' */
  billingPeriod: string;
  artifacts: ArtifactRef[];
  control?: ArtifactSetControl;
  /** sha256 over manifest bytes and sorted name|version|size — changes whenever the listing changes. */
  listingFingerprint: string;
  manifest?: ManifestBytes;
}

export type PeriodListing =
  | { ok: true; set: PeriodArtifactSet }
  | { ok: false; billingPeriod: string; code: string; message: string; manifest?: ManifestBytes };

export interface ListOptions {
  /** Aborts the listing (every request and between pages); it then rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** Options for opening one object: the run's abort signal reaches the request. */
export interface OpenOptions {
  /** Aborts the open (the in-flight request is torn down); it then rejects with the signal's reason. */
  signal?: AbortSignal;
}

export interface FocusSource {
  readonly kind: 'focus_file' | 'fake';
  /** Artifact sets per billing period, sorted by period. Throws only on whole-listing failures. */
  listPeriods(range?: PeriodRange, opts?: ListOptions): Promise<PeriodListing[]>;
  /** Raw bytes of one artifact (streamed). Refuses a ref without a version. */
  openArtifact(ref: ArtifactRef, opts?: OpenOptions): Promise<Readable>;
}

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/;
