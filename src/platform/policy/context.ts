// The request context a gateway hands to the policy library (ADR-0001 §3.2). Metadata only: no prompt, response, tool
// or attachment content. DLP findings are computed by the caller (offsets only, `DlpFinding`); a strict validator
// refuses any other key, so content cannot ride along, and problems never echo a value.
import {
  ACTOR_TYPES, C, CONFIDENCE, POLICY_PHASES, arr, checkActor, isId, obj, oneOf, opt, req, rule, set, validateDlpFinding, validator,
  type ActorType, type DlpFinding, type PolicyDecision,
} from '../contracts';

export interface RequestContext {
  /** From the gateway's trusted ingress (its own credentials), never a header the client sets. */
  tenantId: string;
  /** The gateway's request id; at most 128 characters so decision ids stay within the id rule. */
  requestRef: string;
  /** Window or chunk index within one phase (streaming); 0 when absent. */
  sequence?: number;
  phase: PolicyDecision['phase'];
  workloadId?: string;
  teamIds?: string[];
  actorType: ActorType;
  actorRef?: string;
  /** The provider whose entitlements apply. */
  provider: string;
  /** Where the request goes (provider endpoint or surface id); matched by `destination` conditions. */
  destination: string;
  /** Absent when the gateway could not read a valid model id: access is then denied with MODEL_UNKNOWN. */
  modelRequested?: string;
  /** Known after dispatch (or from a cache hit): entitlements are re-checked against it. */
  modelServed?: string;
  /** Tools declared or called in the content under evaluation. */
  tools?: string[];
  inputBytes: number;
  findings: DlpFinding[];
  signals?: { signal: string; confidence: (typeof CONFIDENCE)[number] }[];
  /** Controls the gateway could not consult for this request (ADR-0001 §3.3: they deny). */
  unavailable?: ('entitlements' | 'dlp')[];
}

const CONTEXT = obj({
  // The refused: prefix is reserved for refusal placeholders (unforgeable).
  tenantId: req(rule('tenant-ref@1', 'identifier, not refused:', (v) => isId(v) && !v.startsWith('refused:'))),
  requestRef: req(rule('request-ref@2', 'identifier of at most 128 characters, not refused:', (v) => isId(v) && v.length <= 128 && !v.startsWith('refused:'))), sequence: opt(C.count),
  phase: req(oneOf(POLICY_PHASES)), workloadId: opt(C.id), teamIds: opt(set(C.id, 0, 256)), actorType: req(oneOf(ACTOR_TYPES)), actorRef: opt(C.id),
  provider: req(C.id), destination: req(C.id), modelRequested: opt(C.model), modelServed: opt(C.model), tools: opt(set(C.id, 0, 256)), inputBytes: req(C.count),
  findings: req(arr(rule('finding@1', 'DLP finding (offsets only)', (v) => validateDlpFinding(v).ok), 0, 1000)),
  signals: opt(arr(obj({ signal: req(C.id), confidence: req(oneOf(CONFIDENCE)) }), 0, 64)), unavailable: opt(set(oneOf(['entitlements', 'dlp']), 0, 2)),
} satisfies { [K in keyof Required<RequestContext>]: unknown });

export const validateRequestContext = validator<RequestContext>(CONTEXT, { 'context-actor@1': (c, p) => checkActor(c.actorType, c.actorRef, p) });
