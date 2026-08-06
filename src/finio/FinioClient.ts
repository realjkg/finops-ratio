// FinIO seam — the agent-to-agent (A2A) FinOps interchange layer.
//
// FinIO is not a new protocol: it is FOCUS-shaped JSON exchanged over plain
// HTTP/REST through a two-step handshake, wrapped in the same typed client seam
// the repo uses for /hello, the agent, tokenomics, and the cost-ingest slice.
//
// Schema authority: this file deliberately does NOT define its own FOCUS types.
// Ratio's canonical cost schema lives in src/costsource (FOCUS v1.0-v1.4, v1.4
// canonical, per the FOCUS Ingest Mapping rule in .obvious/obvious.md). FinIO
// speaks that same schema on the wire so a row that arrives over A2A is
// structurally identical to a row that arrives through the ingest doors — one
// internal model, two transports.
//
// x_Ratio* columns are FOCUS-legal vendor extensions (FOCUS spec §3.2) and carry
// the value denominator FOCUS does not model (R4).

import type { RatioFocusExtensions, RawSourceRow } from '@/costsource/focusRows';
import type { FocusVersion } from '@/costsource/focusVersions';

export type { FocusVersion };

/**
 * A FinIO wire row: the FOCUS core columns the negotiated version guarantees,
 * plus any additive columns that version introduced, plus Ratio's value
 * extensions. Assignable from `CanonicalFocusRow`, so canonical v1.4 rows drop
 * straight onto the wire without a shim.
 */
export type FocusRow = RawSourceRow & RatioFocusExtensions;

/** Source id stamped into `x_RatioSourceId` on every row FinIO emits. */
export const FINIO_SOURCE_ID = 'finio-a2a';

/** FinIO operations a peer can advertise in `accepts`. */
export const FINIO_OPERATIONS = ['finio.export'] as const;
export type FinioOperation = (typeof FINIO_OPERATIONS)[number];

export interface FinioExport {
  /** The version the rows are actually shaped to — the negotiated version. */
  focusVersion: FocusVersion;
  generatedAt: string; // ISO 8601
  rows: FocusRow[];
}

export interface HandshakeRequest {
  agentId: string;
  capabilities: string[]; // e.g. ['finio.export']
  focusVersion: FocusVersion;
  nonce: string;
}

export interface HandshakeResult {
  sessionId: string;
  accepts: FinioOperation[]; // operations the peer will honour
  /** The version the responder agreed to emit — may be lower than canonical. */
  focusVersion: FocusVersion;
  expiresAt: string; // ISO 8601
}

export interface FinioClient {
  readonly mode: 'mock' | 'live';
  handshake(req: HandshakeRequest): Promise<HandshakeResult>;
  export(sessionId: string): Promise<FinioExport>;
}
