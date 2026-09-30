/**
 * AI Action Protection — governed execution of a consequential agent action.
 * (atlasent-docs CROSS-064; the product contract is
 * atlasent-docs architecture/ai-action-protection/AI_ACTION_PROTECTION.md.)
 *
 * This is an EXECUTION ADAPTER, not an authorization engine. It runs the same
 * Protected Action lifecycle as Production Change Protection:
 *
 *   agent attempts action
 *   -> establish agent + provenance      (engine.authorize: identity mint + seal)
 *   -> Protected Action agent.tool.invoke (runtime evaluate; org policy decides)
 *   -> allow / refuse / hold              (runtime decision, never local)
 *   -> optional human approval            (runtime approvals; awaitApproval claims)
 *   -> bounded permit                     (bound to agent, target, environment,
 *                                          and the digest of the exact arguments)
 *   -> execution-boundary verification    (runtime verify, immediately before)
 *   -> execution                          (the adapter, exactly once)
 *   -> effect                             (the adapter re-reads the system)
 *   -> proof                              (ai_action_proof.v1 + runtime records)
 *
 * What this module decides on its own is only ever a REFUSAL: the circuit
 * breaker, a target that changed since authorization, arguments that do not
 * match their digest, a local-mode "allow". It never turns a runtime refusal,
 * hold or error into an execution, and it never executes without a permit the
 * runtime verified at this boundary.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionContext, Decision, SealedBinding, VerifyResult } from "./decision.js";

export const AI_ACTION_TYPE = "agent.tool.invoke";
export const PROOF_VERSION = "ai_action_proof.v1";

// ---------------------------------------------------------------------------
// The action: what exactly the agent wants to do, as a bindable digest
// ---------------------------------------------------------------------------

/**
 * One consequential action, fully specified. `arguments` must contain every
 * input that changes what executes, INCLUDING the state it was authorized
 * against (e.g. the blob it replaces), so a changed action or a changed target
 * produces a different digest and the permit does not cover it.
 */
export interface GovernedActionSpec {
  /** The capability being exercised, e.g. "github.contents.put". */
  tool: string;
  /** The system the action changes, e.g. "github". */
  system: string;
  /** Canonical target, e.g. "github:Owner/repo@branch:path". Bound into the permit. */
  target_id: string;
  environment: string;
  arguments: Record<string, unknown>;
}

/** RFC 8785-style canonical JSON (sorted keys), same form as packages/agent-hooks/jcs.mjs. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const o = value as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  throw new Error(`not representable as JSON: ${typeof value}`);
}

export const sha256Hex = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** The digest the permit is bound to: sha256(JCS({tool, system, target_id, environment, arguments})). */
export function actionDigest(spec: GovernedActionSpec): string {
  return sha256Hex(canonicalJson({
    tool: spec.tool,
    system: spec.system,
    target_id: spec.target_id,
    environment: spec.environment,
    arguments: spec.arguments,
  }));
}

/**
 * The sealed action hash for `spec`, recomputed from what the runtime sealed
 * with the action digest replaced by the digest of `spec`. Same algorithm as
 * atlasent-api computeSourceProvenanceActionHash and
 * packages/agent-hooks provenanceActionHash. For the action that was
 * authorized, this equals the permit's bound hash; for any other action it
 * does not, so verify refuses it.
 */
export function sealedActionHash(binding: SealedBinding, spec: GovernedActionSpec): string {
  return sha256Hex(canonicalJson({
    version: "source_provenance_action.v1",
    tenant_id: binding.tenant_id,
    actor_id: binding.actor_id,
    action_type: AI_ACTION_TYPE,
    environment: binding.environment,
    resource_id: binding.resource_id,
    context: { ...binding.context, action_digest: actionDigest(spec) },
  }));
}

// ---------------------------------------------------------------------------
// Execution adapter: the only code that touches the real system
// ---------------------------------------------------------------------------

export interface ObservedState {
  /** Opaque digest of the target's current state; "absent" when it does not exist. */
  digest: string;
  detail?: Record<string, unknown>;
}

export interface ExecutionReceipt {
  /** System-issued identifiers for what executed (commit sha, request id, ...). */
  [k: string]: unknown;
}

export interface EffectObservation {
  /** True only when the system now shows exactly the authorized result. */
  established: boolean;
  expected: string;
  observed: string | null;
  detail?: Record<string, unknown>;
}

export interface ExecutionAdapter {
  system: string;
  /** Current state of the target. Compared with the state the action was authorized against. */
  readState(spec: GovernedActionSpec): Promise<ObservedState>;
  /** The state digest the action was authorized against (from spec.arguments). */
  authorizedBaseState(spec: GovernedActionSpec): string;
  /** Perform the action. Called at most once per permit. */
  execute(spec: GovernedActionSpec): Promise<ExecutionReceipt>;
  /** Re-read the system and decide whether the authorized result is really there. */
  observeEffect(spec: GovernedActionSpec, receipt: ExecutionReceipt): Promise<EffectObservation>;
}

// ---------------------------------------------------------------------------
// Circuit breaker: can only STOP execution, never authorize it
// ---------------------------------------------------------------------------

export type BreakerTripReason =
  | "execution_outcome_unknown"
  | "effect_not_established"
  | "operator_stop";

export interface BreakerTrip {
  scope: string;
  reason: BreakerTripReason;
  detail: string;
  tripped_at: string;
}

/**
 * The execution-boundary half of the AI Action Protection circuit breaker
 * (CROSS-064 conditions E1-E4). The runtime half (agent no longer active,
 * permit bindings, provenance, approvals, expiry, replay) is enforced by the
 * runtime at evaluate / claim / verify and is not duplicated here.
 *
 * Scopes: `agent:<id>` (everything this agent does) and `target:<target_id>`
 * (everything touching this target). A trip is sticky: only a person resets
 * it, through `reset()` from an operator path. No MCP tool exposes reset,
 * because an agent must not be able to clear its own stop.
 *
 * State lives in memory, optionally persisted to a JSON file so a restart does
 * not silently clear a stop. It is local to this adapter. It is not
 * organizational state and not a policy engine (see CROSS-064 "Not decided").
 */
export class CircuitBreaker {
  private trips = new Map<string, BreakerTrip>();
  constructor(private readonly opts: { stateFile?: string; stopFile?: string; now?: () => Date } = {}) {
    if (opts.stateFile && existsSync(opts.stateFile)) {
      // An unreadable state file is not "no trips": refuse to start rather
      // than silently clearing a stop someone recorded.
      const parsed = JSON.parse(readFileSync(opts.stateFile, "utf8")) as { trips?: BreakerTrip[] };
      for (const t of parsed.trips ?? []) this.trips.set(t.scope, t);
    }
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  /** The first open scope among those given, or an operator stop, or null. */
  check(scopes: string[]): BreakerTrip | null {
    if (this.opts.stopFile && existsSync(this.opts.stopFile)) {
      return { scope: "*", reason: "operator_stop", detail: `operator stop file present: ${this.opts.stopFile}`, tripped_at: this.now().toISOString() };
    }
    if (process.env.ATLASENT_CIRCUIT_BREAKER_STOP === "1") {
      return { scope: "*", reason: "operator_stop", detail: "ATLASENT_CIRCUIT_BREAKER_STOP=1", tripped_at: this.now().toISOString() };
    }
    for (const s of scopes) {
      const t = this.trips.get(s);
      if (t) return t;
    }
    return null;
  }

  trip(scopes: string[], reason: BreakerTripReason, detail: string): BreakerTrip[] {
    const at = this.now().toISOString();
    const out = scopes.map((scope) => ({ scope, reason, detail, tripped_at: at }));
    for (const t of out) if (!this.trips.has(t.scope)) this.trips.set(t.scope, t);
    this.persist();
    return out;
  }

  /** Operator path only. Records who reset it; never called by an MCP tool. */
  reset(scope: string, by: string): boolean {
    if (!by.trim()) throw new Error("a reset must name the person resetting it");
    const had = this.trips.delete(scope);
    this.persist();
    return had;
  }

  list(): BreakerTrip[] {
    return [...this.trips.values()];
  }

  private persist(): void {
    if (!this.opts.stateFile) return;
    mkdirSync(dirname(this.opts.stateFile), { recursive: true });
    writeFileSync(this.opts.stateFile, JSON.stringify({ trips: this.list() }, null, 2), { mode: 0o600 });
  }
}

export const agentScope = (actor: string) => `agent:${actor}`;
export const targetScope = (target: string) => `target:${target}`;

// ---------------------------------------------------------------------------
// Authorization request (the runtime decides)
// ---------------------------------------------------------------------------

export interface AuthorizeFns {
  authorize: (ctx: ActionContext) => Promise<Decision>;
  verify: (token: string, ctx: ActionContext) => Promise<VerifyResult>;
  getMode: () => "local" | "remote";
}

export interface AuthorizationOutcome {
  decision: Decision;
  context: ActionContext;
  digest: string;
}

/** Build the agent.tool.invoke context for an action. The digest goes in as payload_hash, and engine.ts seals it into context.action_digest. */
export function contextFor(spec: GovernedActionSpec, actorId: string, requestId: string): ActionContext {
  return {
    action_type: AI_ACTION_TYPE,
    actor_id: actorId,
    environment: spec.environment,
    tool: spec.tool,
    tool_name: spec.tool,
    target_id: spec.target_id,
    payload_hash: actionDigest(spec),
    request_id: requestId,
    state_snapshot: { source: "atlasent-mcp-governed-action", complete: true, system: spec.system },
  };
}

export async function requestAuthorization(
  spec: GovernedActionSpec,
  actorId: string,
  fns: AuthorizeFns,
): Promise<AuthorizationOutcome> {
  const ctx = contextFor(spec, actorId, randomUUID());
  const digest = actionDigest(spec);
  if (fns.getMode() !== "remote") {
    // A real mutation never runs on a local-engine "allow": it signs nothing
    // and the runtime never saw the request.
    return {
      context: ctx,
      digest,
      decision: {
        decision: "deny",
        reasons: ["AI Action Protection requires the AtlaSent runtime (remote mode). Local mode cannot authorize a real change."],
        deny_code: "RUNTIME_REQUIRED",
      },
    };
  }
  return { context: ctx, digest, decision: await fns.authorize(ctx) };
}

// ---------------------------------------------------------------------------
// Execution at the boundary
// ---------------------------------------------------------------------------

export type GovernedOutcome =
  | "executed"             // verified, executed, effect established
  | "effect_not_established" // executed, but the system does not show the authorized result
  | "outcome_unknown"      // the execution call failed or timed out; result unknown
  | "refused_circuit_open"
  | "refused_target_changed"
  | "refused_arguments_mismatch"
  | "refused_verify";

export interface AiActionProof {
  version: typeof PROOF_VERSION;
  outcome: GovernedOutcome;
  agent: { actor_id: string };
  action: {
    action_type: typeof AI_ACTION_TYPE;
    tool: string;
    system: string;
    target_id: string;
    environment: string;
    action_digest: string;
    arguments: Record<string, unknown>;
  };
  decision: {
    decision: string;
    audit_id?: string;
    envelope_hash?: string;
    approval_request_id?: string;
    binding: "sealed_provenance" | "action_digest";
  };
  permit: {
    token_sha256: string;
    verified: boolean;
    verify_outcome?: string;
    verify_error_code?: string;
    verified_at?: string;
  };
  execution?: { receipt: ExecutionReceipt; at: string } | { error: string; at: string };
  effect?: EffectObservation & { at: string };
  circuit?: { open?: BreakerTrip; tripped?: BreakerTrip[] };
  /** sha256 of this record's canonical JSON with proof_sha256 omitted. */
  proof_sha256: string;
}

export interface ExecuteGovernedParams {
  spec: GovernedActionSpec;
  /** The actor the permit was issued to (the runtime's agent:<id> when it replaced it). */
  actorId: string;
  permitToken: string;
  /**
   * What the runtime sealed, when it admitted provenance. The hash presented at
   * verify is recomputed from `spec` (sealedActionHash), never replayed from
   * the decision, so a changed action cannot verify against the old permit.
   */
  sealedBinding?: SealedBinding;
  decision: { decision: string; audit_id?: string; envelope_hash?: string; approval_request_id?: string };
  adapter: ExecutionAdapter;
  breaker: CircuitBreaker;
  verify: AuthorizeFns["verify"];
  now?: () => Date;
  /** Optional check that the bytes about to be written are the bytes the digest names. */
  argumentsCheck?: () => string | null;
}

function finalize(p: Omit<AiActionProof, "proof_sha256">): AiActionProof {
  return { ...p, proof_sha256: sha256Hex(canonicalJson(p)) };
}

/**
 * Verify at the boundary, execute once, observe the effect, emit proof.
 * Every refusal happens BEFORE verify when possible, so a stop does not spend
 * the permit; a refusal after verify leaves it spent and nothing executed.
 */
export async function executeGoverned(p: ExecuteGovernedParams): Promise<AiActionProof> {
  const now = () => (p.now ? p.now() : new Date()).toISOString();
  const digest = actionDigest(p.spec);
  const scopes = [agentScope(p.actorId), targetScope(p.spec.target_id)];
  const base = {
    version: PROOF_VERSION as typeof PROOF_VERSION,
    agent: { actor_id: p.actorId },
    action: {
      action_type: AI_ACTION_TYPE as typeof AI_ACTION_TYPE,
      tool: p.spec.tool,
      system: p.spec.system,
      target_id: p.spec.target_id,
      environment: p.spec.environment,
      action_digest: digest,
      arguments: p.spec.arguments,
    },
    decision: {
      decision: p.decision.decision,
      ...(p.decision.audit_id && { audit_id: p.decision.audit_id }),
      ...(p.decision.envelope_hash && { envelope_hash: p.decision.envelope_hash }),
      ...(p.decision.approval_request_id && { approval_request_id: p.decision.approval_request_id }),
      binding: (p.sealedBinding ? "sealed_provenance" : "action_digest") as "sealed_provenance" | "action_digest",
    },
  };
  const permitBase = { token_sha256: sha256Hex(p.permitToken), verified: false };

  // E4 / E2 / E3 (sticky trips): stop before the permit is spent.
  const open = p.breaker.check(scopes);
  if (open) {
    return finalize({ ...base, outcome: "refused_circuit_open", permit: permitBase, circuit: { open } });
  }

  // The bytes about to execute must be the bytes the digest names.
  const argsProblem = p.argumentsCheck ? p.argumentsCheck() : null;
  if (argsProblem) {
    return finalize({ ...base, outcome: "refused_arguments_mismatch", permit: permitBase, execution: { error: argsProblem, at: now() } });
  }

  // E1: the target changed since the action was authorized.
  let state: ObservedState;
  try {
    state = await p.adapter.readState(p.spec);
  } catch (e) {
    return finalize({
      ...base, outcome: "refused_target_changed", permit: permitBase,
      execution: { error: `target state could not be read: ${e instanceof Error ? e.message : String(e)}`, at: now() },
    });
  }
  const authorizedBase = p.adapter.authorizedBaseState(p.spec);
  if (state.digest !== authorizedBase) {
    return finalize({
      ...base, outcome: "refused_target_changed", permit: permitBase,
      execution: { error: `target is now ${state.digest}; the action was authorized against ${authorizedBase}`, at: now() },
    });
  }

  // Execution-boundary verification: the runtime consumes the permit here.
  const v = await p.verify(p.permitToken, {
    action_type: AI_ACTION_TYPE,
    actor_id: p.actorId,
    environment: p.spec.environment,
    target_id: p.spec.target_id,
    payload_hash: p.sealedBinding ? sealedActionHash(p.sealedBinding, p.spec) : digest,
  });
  const verifiedAt = now();
  const permit = {
    ...permitBase,
    verified: v.valid === true,
    verify_outcome: v.outcome,
    ...(v.verify_error_code && { verify_error_code: v.verify_error_code }),
    verified_at: verifiedAt,
  };
  if (v.valid !== true) {
    return finalize({ ...base, outcome: "refused_verify", permit });
  }

  // Execute exactly once. An exception means we do not know what happened.
  let receipt: ExecutionReceipt;
  try {
    receipt = await p.adapter.execute(p.spec);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const tripped = p.breaker.trip(scopes, "execution_outcome_unknown", detail);
    return finalize({ ...base, outcome: "outcome_unknown", permit, execution: { error: detail, at: now() }, circuit: { tripped } });
  }
  const execution = { receipt, at: now() };

  // Effect: re-read the real system.
  let effect: EffectObservation;
  try {
    effect = await p.adapter.observeEffect(p.spec, receipt);
  } catch (e) {
    effect = { established: false, expected: "authorized result", observed: null, detail: { error: e instanceof Error ? e.message : String(e) } };
  }
  if (!effect.established) {
    const tripped = p.breaker.trip(scopes, "effect_not_established", `expected ${effect.expected}, observed ${effect.observed ?? "unreadable"}`);
    return finalize({ ...base, outcome: "effect_not_established", permit, execution, effect: { ...effect, at: now() }, circuit: { tripped } });
  }
  return finalize({ ...base, outcome: "executed", permit, execution, effect: { ...effect, at: now() } });
}
