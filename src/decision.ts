/**
 * Shared decision envelope for authorization checks.
 *
 * Every `authorize()` call returns a Decision. Every Decision serializes to
 * the same JSON shape, so clients can handle allow/deny/hold uniformly.
 */

export type ActionContext = {
  action_type: string;
  actor_id: string;
  environment: string;
  approvals?: string[];
  change_window?: string;
  tool_name?: string;
  /**
   * CROSS-064 G4: the exact provider effect this action is authorized to
   * produce (e.g. github_contents_write.v1). Sent inside the evaluated (and,
   * for agent.*, sealed) context so the runtime can later establish the effect
   * from the provider's own events against what was authorized.
   */
  expected_effect?: Record<string, unknown>;
  /** Tool being invoked; the agent.tool.invoke class requires `context.tool`. */
  tool?: string;
  state_snapshot?: Record<string, unknown>;
  /**
   * Target resource the permit is bound to (service, artifact, tool-call
   * target). Presented at the verify boundary so a permit bound to one target
   * cannot verify against another.
   */
  target_id?: string;
  /**
   * Hash of the exact executed payload (tool-call arguments / artifact digest).
   * Bind it at evaluate via `execution_payload_hash`; presenting a different
   * hash at verify yields `PAYLOAD_MISMATCH`. This is what makes an altered
   * tool call fail closed rather than silently execute.
   */
  payload_hash?: string;
  /** Host-reported app + chat/session; see ReportedAgentSession in engine.ts. */
  agent_session?: { host?: string; session_id?: string; run_id?: string };
  /**
   * Structured change plan for the four mandatory-change-control action types
   * (production.deploy, infrastructure.change, production.rollback,
   * secret.configuration.change). Sent top-level to /v1-evaluate, recorded in
   * an auto-created Change Brief, and presented again at claim time so a
   * plan mismatch only happens when the plan genuinely changed. Only real
   * inputs: nothing here is ever inferred.
   */
  change_plan?: { operation: string; revision?: string; artifact_ref?: string };
  /** Descriptive system the target lives in, for the auto Change Brief. */
  target_system?: string;
  /**
   * The runtime's per-call request identity (`request_id` on /v1-evaluate,
   * persisted on the evaluation row). One deploy_service call sends the SAME
   * attempt id on its agent.tool.invoke gate and on the action it gates (see
   * toolAttemptRequestId in engine.ts), so a reader of the decision log can tell
   * which gate belongs to which consequential action. Caller-chosen, never
   * authority; the runtime uses it for idempotency.
   */
  request_id?: string;
  /**
   * The workload the request comes from, when the host reports one. For an
   * NVIDIA OpenShell sandbox, `id` is the durable `sandbox_id`; `labels`
   * (sandbox_name, workspace) are display/evidence context only, may be reused,
   * and are never authority. Sent inside the evaluated context so the decision
   * record (and, for agent.* actions, the sealed action hash) names the exact
   * sandbox. See src/openshell.ts and docs/OPENSHELL_AUTHORITY_ADAPTER.md.
   */
  workload?: WorkloadBinding;
};

export type WorkloadBinding = {
  kind: "openshell_sandbox";
  /** Durable identity. The only field a decision or binding may key on. */
  id: string;
  labels?: { sandbox_name?: string; workspace?: string };
};

/**
 * The inputs the runtime's source-provenance sealer hashed into the sealed
 * action hash (atlasent-api _shared/source-provenance-attestation.ts
 * computeSourceProvenanceActionHash). An executor recomputes the hash from the
 * action it is ABOUT to run, so a changed action presents a different hash at
 * verify and the runtime refuses it (PAYLOAD_MISMATCH).
 */
export type SealedBinding = {
  tenant_id: string;
  actor_id: string;
  environment: string;
  resource_id: string | null;
  context: Record<string, unknown>;
};

export type AllowDecision = {
  decision: "allow";
  permit_token: string;
  audit_id?: string;
  envelope_hash?: string;
  conditions?: string[];
  /** Client-side notes (e.g. a Change Brief could not be created). */
  notes?: string[];
  /**
   * The digest the runtime bound this permit to when it admitted sealed
   * source provenance (the sealed action hash). Present it as `payload_hash`
   * at verify; any other value fails PAYLOAD_MISMATCH.
   */
  bound_payload_hash?: string;
  /** The actor the permit was issued to, when it differs from the caller's. */
  bound_actor_id?: string;
  /** What the sealed action hash was computed over, when provenance was admitted. */
  sealed_binding?: SealedBinding;
};

export type DenyDecision = {
  decision: "deny";
  reasons: string[];
  /** Stable machine code from the API denial (e.g. "INSUFFICIENT_APPROVALS"). */
  deny_code?: string;
  /**
   * Set when the denial is resolvable by a human approval
   * (`deny_code === "INSUFFICIENT_APPROVALS"`). A host can route the action
   * to a person (a human approves in the AtlaSent console — no MCP tool can)
   * rather than treating it as a terminal refusal. The action still does not
   * execute now — fail-closed is preserved.
   */
  requires_human_approval?: boolean;
  audit_id?: string;
  envelope_hash?: string;
  notes?: string[];
};

export type HoldDecision = {
  decision: "hold";
  reasons: string[];
  /** Stable machine code from the API denial, when present. */
  deny_code?: string;
  hold_id?: string;
  /**
   * Present when the runtime opened an approval request for this hold. Pass
   * it to `atlasent_await_approval` to wait for a person's decision.
   */
  approval_request_id?: string;
  audit_id?: string;
  envelope_hash?: string;
  notes?: string[];
  /**
   * What the permit claimed after approval will be bound to, when the runtime
   * admitted sealed source provenance for this held request (the sealed action
   * hash). Present it as `payload_hash` at verify after the claim.
   */
  bound_payload_hash?: string;
  /** The actor the permit will be issued to, when it differs from the caller's. */
  bound_actor_id?: string;
  /** What the sealed action hash was computed over, when provenance was admitted. */
  sealed_binding?: SealedBinding;
};

export type Decision = AllowDecision | DenyDecision | HoldDecision;

/** Result of verifying a previously issued permit. */
export type VerifyResult = {
  outcome: "verified" | "expired" | "invalid" | "error";
  valid: boolean;
  reasons?: string[];
  verify_error_code?: string;
  audit_id?: string;
};

/**
 * Wrap a decision / verify result / REST result in the MCP tool-result
 * envelope. The same helper serves three caller shapes:
 *
 *   1. Decision (`{ decision: "allow" | "deny" | "hold", ... }`)
 *      from the local authorize() path. `isError` is set when decision !== "allow".
 *   2. VerifyResult (`{ valid, outcome, ... }`) from verify(). `isError`
 *      when `valid !== true`.
 *   3. Generic REST envelopes from the hosted-API tools — `listPolicies`,
 *      `getPolicy`, `createPolicy`, etc. return `unknown` (the API response
 *      shape), and rate-limit short-circuits return `{ error, reasons }`.
 *      `isError` is set when an `error` field is present; otherwise the
 *      response is treated as success.
 *
 * Payload is accepted as `Record<string, unknown>` so all three shapes
 * flow through. Callers that hand us an arbitrary REST response (`unknown`)
 * should `as Record<string, unknown>` it — the envelope contract is "this
 * is a JSON object the host should display"; non-object payloads are not
 * a real use case here.
 */
export function toolResult(
  payload: unknown,
  extra?: Record<string, unknown>,
) {
  const obj = isObject(payload) ? payload : { value: payload };
  const body = { ...obj, ...(extra ?? {}) };
  const isError = computeIsError(obj);

  const result: { content: Array<{ type: "text"; text: string }>; isError?: true } = {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
  };
  if (isError) result.isError = true;
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function computeIsError(payload: Record<string, unknown>): boolean {
  // Decision envelope: only "allow" is success.
  if (typeof payload.decision === "string") {
    return payload.decision !== "allow";
  }
  // VerifyResult envelope: explicit valid flag.
  if (typeof payload.valid === "boolean") {
    return payload.valid !== true;
  }
  // Error envelope from rate-limit short-circuits and similar.
  if (payload.error != null) {
    return true;
  }
  // Plain REST success response — no error signal.
  return false;
}

export function denyDecision(reasons: string[], audit_id?: string): DenyDecision {
  return audit_id ? { decision: "deny", reasons, audit_id } : { decision: "deny", reasons };
}
