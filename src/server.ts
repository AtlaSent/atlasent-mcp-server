/**
 * MCP server exposing AtlaSent authorization as tools.
 *
 *   evaluate       — ask for a decision; agent gates itself on the result
 *   verify_permit  — verify a permit at the execution boundary before acting
 *   deploy_service — DEMO protected tool: authorize + verify BEFORE execution.
 *                    Denied, held, or unverifiable calls never run.
 *
 * The `deploy_service` tool is the small end-to-end proof: it owns the
 * execution boundary. Look at its handler to see the exact pattern every
 * protected tool should follow.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serverInstructions } from "./upgrade.js";
import { z } from "zod";
import { toolResult, type ActionContext, type Decision } from "./decision.js";
import {
  authorize,
  verify,
  getMode,
  evaluateAction,
  listPolicies,
  getPolicy,
  listAuditEvents,
  explainAuthority,
  integrityAudit,
  createPolicy,
  updatePolicy,
  deletePolicy,
  revokePermit,
  listPermits,
  getPermit,
  checkPermit,
  getDecision,
  issuePermit,
  verifyPermitV1,
  recordExecutionEvaluation,
  createWebhook,
  deleteWebhook,
  awaitApproval,
  missingChangePlanReason,
  newToolAttemptId,
  toolAttemptRequestId,
  type ReportedAgentSession,
} from "./engine.js";
import { randomUUID } from "node:crypto";
import { registerV2Tools } from "./v2Tools.js";
import { registerComplianceTools } from "./complianceTools.js";
import { registerVqpTools } from "./vqpTools.js";
import { CANON_ACT_CATALOG, type ActSpecEntry } from "./canonCatalog.js";
import { CANON_ACTION_GRAPH } from "./canonGraph.js";
import { NO_MATCH_HINT, rankActions, type RetrievalResult } from "./actionRetrieval.js";
import { ATLAS_CONCEPTS, ATLAS_NODES, ATLAS_SOURCE } from "./atlasCatalog.js";

import { VERSION } from "./version.js";

export { VERSION };

// Bounds protect the upstream policy engine and the local rule engine
// from a misbehaving / adversarial caller (e.g. an injected prompt that
// tells the model to send a megabyte-long approvals array). Limits are
// generous for legitimate use but cap the worst case.
const MAX_FIELD_LEN = 256;
const MAX_APPROVALS = 16;

const actionType = z
  .string()
  .min(1)
  .max(MAX_FIELD_LEN)
  .regex(
    /^[A-Za-z0-9_.\.-:]+$/,
    "action_type must be lowercase identifier characters (A-Z, a-z, 0-9, _ . - :)",
  )
  .describe("Canon-backed action type (for example production.deploy, agent.tool.invoke, access.grant). Use atlasent_lookup_action to discover governed Action Types.");
const actorId = z
  .string()
  .min(1)
  .max(MAX_FIELD_LEN)
  .describe("Identifier for the user or service account the agent is acting on behalf of.");
const environment = z
  .string()
  .min(1)
  .max(MAX_FIELD_LEN)
  .describe("Target environment for the action (e.g. production, staging, development).");
const approvals = z
  .array(z.string().min(1).max(MAX_FIELD_LEN))
  .max(MAX_APPROVALS)
  .optional()
  .describe("Approval identifiers already obtained for this action (e.g. ticket IDs, reviewer handles).");
const changeWindow = z
  .string()
  .max(MAX_FIELD_LEN)
  .optional()
  .describe("ISO-8601 time window during which the change is permitted (e.g. 2025-01-15T02:00:00Z/PT4H).");
const targetId = z
  .string()
  .min(1)
  .max(MAX_FIELD_LEN)
  .optional()
  .describe("Target resource the permit is bound to (e.g. service name, artifact id, tool-call target). Presenting a different target at verify yields a binding mismatch.");
const payloadHash = z
  .string()
  .min(1)
  .max(MAX_FIELD_LEN)
  .optional()
  .describe("Hash of the exact executed payload (tool-call arguments / artifact digest). Bind it at evaluate via execution_payload_hash; presenting a different hash at verify yields PAYLOAD_MISMATCH.");
const changePlan = z
  .object({
    operation: z.string().min(1).max(MAX_FIELD_LEN).describe("What kind of change (e.g. deploy, rollback, apply)."),
    revision: z.string().min(1).max(MAX_FIELD_LEN).optional().describe("Source/config revision that will run (e.g. a git SHA)."),
    artifact_ref: z.string().min(1).max(MAX_FIELD_LEN).optional().describe("Built artifact that will run (e.g. an image digest)."),
  })
  .strict()
  .optional()
  .describe(
    "The exact change you will run. Required by AtlaSent for production.deploy, infrastructure.change, " +
      "production.rollback and secret.configuration.change: operation plus a revision and/or artifact_ref. " +
      "A Change Brief recording it is created automatically, and the same plan is presented when an approval is claimed.",
  );
const targetSystem = z
  .string()
  .min(1)
  .max(MAX_FIELD_LEN)
  .optional()
  .describe("System the target lives in (e.g. kubernetes, github). Shown in the auto-created Change Brief.");

// Fields we'll keep verbatim in the structured stderr log. Anything
// not on the allowlist is either dropped (sensitive) or hashed-and-
// truncated (correlatable but not reversible). The audit flagged
// raw `actor_id` / `action_type` flowing into stderr — mostly safe
// for self-hosted MCP, but a shared log aggregator could surface
// per-user behaviour of the calling agent. See SECURITY_PLAN.md
// (atlasent-mcp-server LOW: stderr log redaction).
const LOG_SAFE_TOP_LEVEL_KEYS = new Set([
  "ts",
  "event",
  "mode",
  "decision",      // allow/deny/hold/error — the security-relevant bit
  "outcome",       // verify outcome — same shape, public
  "audit_id",      // correlation only, no user material
  "permit_token",  // already opaque
  "duration_ms",
  "retrieval_confidence", // closed enum: confident / ambiguous / none — no user material
]);

function _hashShort(s: string): string {
  // Cheap deterministic shortening — not crypto, just stable enough
  // that a log analyst can correlate two events for the same actor
  // without seeing the actor's identifier verbatim.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function _redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length === 0) return value;
    if (value.length <= 8) return `len=${value.length}`;
    return `h:${_hashShort(value)}:len=${value.length}`;
  }
  if (Array.isArray(value)) {
    return { _kind: "array", count: value.length };
  }
  if (typeof value === "object") {
    return { _kind: "object", keys: Object.keys(value as object).length };
  }
  return value;
}

function log(event: string, data: Record<string, unknown>): void {
  // Log to stderr so we don't interfere with MCP stdio messaging.
  const safe: Record<string, unknown> = {
    ts: new Date().toISOString(),
    event,
    mode: getMode(),
  };
  for (const [key, value] of Object.entries(data)) {
    if (LOG_SAFE_TOP_LEVEL_KEYS.has(key)) {
      safe[key] = value;
      continue;
    }
    if (key === "ctx" && value && typeof value === "object") {
      // Only the action_type is preserved as a low-cardinality string
      // (it comes from a controlled vocabulary of policy actions);
      // other context fields are redacted.
      const ctx = value as Record<string, unknown>;
      safe.ctx = {
        action_type:
          typeof ctx.action_type === "string" && ctx.action_type.length <= 64
            ? ctx.action_type
            : _redact(ctx.action_type),
        actor_id: _redact(ctx.actor_id),
        environment: _redact(ctx.environment),
        approvals: _redact(ctx.approvals),
        change_window: _redact(ctx.change_window),
      };
      continue;
    }
    safe[key] = _redact(value);
  }
  const line = JSON.stringify(safe);
  process.stderr.write(line + "\n");
}

function verificationFailureDecision(
  verification: Awaited<ReturnType<typeof verify>>,
  decision?: Extract<Decision, { decision: "allow" }>,
): Decision {
  const detail = verification.reasons?.length
    ? verification.reasons
    : [`Permit verification failed (${verification.outcome})`];
  return {
    decision: "deny",
    reasons: detail,
    ...(decision?.audit_id ? { audit_id: decision.audit_id } : {}),
  };
}

// ---------------------------------------------------------------------------
// Agent tool gate — outer layer for the two-layer authorization pattern.
//
// Call this FIRST in any protected tool handler, before any tool-specific
// authorize() call. It asks: "is this AI agent permitted to invoke any
// tool on this server at all?"
//
// A positive Decision is not itself the execution Gate. The issued Permit is
// verified immediately here; only a successfully verified Permit lets the
// protected handler continue to its action-specific authorization step.
//
// Authorization primitives (evaluate, verify_permit) are intentionally
// excluded — they must always be callable to bootstrap the flow.
// ---------------------------------------------------------------------------
// One id per server process for hosts that give no session id (stdio). Marked
// as generated so nobody mistakes it for the host's own chat id.
const PROCESS_SESSION_ID = `mcp-process-${randomUUID()}`;

/**
 * Which app and which chat/session this call came from, as REPORTED by the
 * agent host (CROSS-056 §2b). Never authority: the runtime stores it
 * labelled "reported". Host = the MCP client's own name (e.g. "claude-code",
 * "cursor"). Session = the Streamable HTTP session id, else
 * ATLASENT_SESSION_ID set by the host, else a per-process generated id.
 */
export function reportedSessionFor(server: McpServer): ReportedAgentSession {
  const host = server.server.getClientVersion()?.name;
  const transportSession = server.server.transport?.sessionId;
  const session_id = transportSession || process.env.ATLASENT_SESSION_ID || PROCESS_SESSION_ID;
  const run_id = process.env.ATLASENT_RUN_ID;
  return { ...(host && { host }), session_id, ...(run_id && { run_id }) };
}

async function agentToolGate(
  toolName: string,
  actorId: string,
  environment: string,
  approvals?: string[],
  agentSession?: ReportedAgentSession,
  requestId?: string,
): Promise<Decision | null> {
  // Forward the call's approvals into the gate context. Without this, a
  // production tool call is denied at the agent gate for "no approvals" even
  // when the caller supplied them — the approval never reaches the gate — so
  // no production action can ever pass, defeating the two-layer pattern.
  // Fail-closed is preserved: a production call with no approvals still denies.
  const ctx: ActionContext = {
    action_type: "agent.tool.invoke",
    actor_id: actorId,
    environment,
    tool_name: toolName,
    // The runtime's agent.tool.invoke class declares required_context_inputs
    // ['tool', 'environment'] (seed_ai_agent_safeguard, Canon ACT-0029). It
    // reads `context.tool`, not `tool_name`; without it every gated call is
    // denied for a missing required input.
    tool: toolName,
    // The tool being invoked is this gate's target. `tool_name` alone rides in
    // context for audit and is NOT one of the runtime's binding fields
    // (target/target_id/ref/workflow_id/run_id/commit_sha), so without this a
    // permit minted to invoke one tool verifies for any other.
    target_id: toolName,
    ...(approvals && approvals.length ? { approvals } : {}),
    ...(agentSession && { agent_session: agentSession }),
    ...(requestId && { request_id: requestId }),
  };
  const gate = await authorize(ctx);
  if (gate.decision !== "allow") {
    log("agent_tool_gate.blocked", { tool: toolName, actor: actorId, gate });
    return gate;
  }

  const verification = await verify(gate.permit_token, ctx);
  log("agent_tool_gate.verify", {
    tool: toolName,
    actor: actorId,
    permit_token: gate.permit_token,
    outcome: verification.outcome,
  });
  if (!verification.valid) {
    const denied = verificationFailureDecision(verification, gate);
    log("agent_tool_gate.blocked", { tool: toolName, actor: actorId, denied });
    return denied;
  }

  return null;
}

// Per-tool token bucket. Caps the calls-per-second any single tool
// handler can sustain — protects the upstream policy engine from a
// runaway agent loop, and the local mode from busywork. Tunable via
// ATLASENT_MCP_RATE_LIMIT (calls per minute, default 600).
const _rateLimitState: Map<string, { tokens: number; updatedAt: number }> =
  new Map();

function _rateLimitPerMinute(): number {
  const raw = process.env.ATLASENT_MCP_RATE_LIMIT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
}

export function _resetRateLimitForTests(): void {
  _rateLimitState.clear();
}

function rateLimitOk(toolName: string): boolean {
  const max = _rateLimitPerMinute();
  const refillPerMs = max / 60_000;
  const now = Date.now();
  const state = _rateLimitState.get(toolName) ?? { tokens: max, updatedAt: now };
  const elapsed = now - state.updatedAt;
  const refilled = Math.min(max, state.tokens + elapsed * refillPerMs);
  if (refilled < 1) {
    _rateLimitState.set(toolName, { tokens: refilled, updatedAt: now });
    return false;
  }
  _rateLimitState.set(toolName, { tokens: refilled - 1, updatedAt: now });
  return true;
}

// Live-API demos (ATLASENT_MODE=remote with a real key) expose mutating
// CRUD tools that call the hosted API directly — they do NOT pass
// through authorize(). An adversarial prompt or a hallucinated
// "clean up" step could destroy real policies, webhooks, or revoke
// live permits. Setting ATLASENT_MCP_READONLY=1 skips registration of
// the 7 mutating tools below. The protected deploy demo now performs its
// own evaluate → verify → execute boundary. All list/get/audit-read tools,
// the standalone evaluate/verify primitives, and the approval-request
// workflow remain available.
const READONLY_DISABLED_TOOLS = new Set([
  "atlasent_create_policy",
  "atlasent_update_policy",
  "atlasent_delete_policy",
  "atlasent_create_webhook",
  "atlasent_delete_webhook",
  "atlasent_revoke_permit",
  "atlasent_permit",
  // C.MCP2: v2 mutating tools also disabled in readonly mode
  "atlasent_evaluate_many",
  "atlasent_evaluate_stream",
  // Compliance mutating tools
  "atlasent_create_scim_user",
  "atlasent_patch_scim_user",
  "atlasent_delete_scim_user",
  "atlasent_upsert_siem_config",
  "atlasent_create_evidence_export",
  // VQP tools (mutating: generate writes vqp_snapshots, verify writes vqp_audit_log)
  "atlasent_vqp_generate",
  "atlasent_vqp_verify",
]);

export function isToolDisabledByReadOnly(toolName: string): boolean {
  const flag = process.env.ATLASENT_MCP_READONLY;
  if (flag !== "1" && flag !== "true") return false;
  return READONLY_DISABLED_TOOLS.has(toolName);
}

function toolError(e: unknown) {
  return toolResult({
    error: e instanceof Error ? e.message : String(e),
  });
}

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "@atlasent/mcp-server",
      version: VERSION,
    },
    { instructions: serverInstructions() },
  );

  if (
    process.env.ATLASENT_MCP_READONLY === "1" ||
    process.env.ATLASENT_MCP_READONLY === "true"
  ) {
    log("server.readonly_mode", {
      disabled_tools: [...READONLY_DISABLED_TOOLS].sort(),
    });
  }

  // -------------------------------------------------------------------------
  // evaluate — for agents that gate their own tool calls
  // -------------------------------------------------------------------------
  server.registerTool(
    "evaluate",
    {
      title: "AtlaSent — Evaluate Action",
      description:
        "Call this BEFORE performing any sensitive action. Returns a Decision: " +
        "`allow` (verify the returned permit_token at the execution boundary before proceeding), " +
        "`deny` (you MUST NOT proceed), or `hold` (do not proceed; route for review).",
      inputSchema: z.object({
        action_type: actionType,
        actor_id: actorId,
        environment,
        approvals,
        change_window: changeWindow,
        target_id: targetId,
        change_plan: changePlan,
        target_system: targetSystem,
      }),
      annotations: {
        title: "AtlaSent — Evaluate Action",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("evaluate")) {
        const decision = {
          decision: "deny" as const,
          reasons: ["MCP tool rate limit exceeded — slow down and retry"],
        };
        log("evaluate.rate_limited", { decision });
        return toolResult(decision);
      }
      const ctx: ActionContext = {
        action_type: args.action_type,
        actor_id: args.actor_id,
        environment: args.environment,
        ...(args.approvals ? { approvals: args.approvals } : {}),
        ...(args.change_window ? { change_window: args.change_window } : {}),
        ...(args.target_id ? { target_id: args.target_id } : {}),
        ...(args.change_plan ? { change_plan: args.change_plan } : {}),
        ...(args.target_system ? { target_system: args.target_system } : {}),
        agent_session: reportedSessionFor(server),
      };
      const decision = await authorize(ctx);
      log("evaluate", { ctx, decision });
      return toolResult(decision);
    },
  );

  // -------------------------------------------------------------------------
  // verify_permit — execution-boundary Gate
  // -------------------------------------------------------------------------
  server.registerTool(
    "verify_permit",
    {
      title: "AtlaSent — Verify Permit",
      description:
        "Call this AFTER `evaluate` returns allow and BEFORE the protected native side effect. " +
        "It verifies the permit for the presented execution context. Proceed only when `valid` is true; " +
        "expired, invalid, replayed, mismatched, or error outcomes must block the action.",
      inputSchema: z.object({
        permit_token: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The permit_token returned by a prior evaluate call."),
        action_type: actionType,
        actor_id: actorId,
        environment,
        approvals,
        change_window: changeWindow,
        target_id: targetId,
        payload_hash: payloadHash,
      }),
      annotations: {
        title: "AtlaSent — Verify Permit",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("verify_permit")) {
        const result = {
          outcome: "error" as const,
          valid: false,
          reasons: ["MCP tool rate limit exceeded — slow down and retry"],
        };
        log("verify_permit.rate_limited", { result });
        return toolResult(result);
      }
      const ctx: ActionContext = {
        action_type: args.action_type,
        actor_id: args.actor_id,
        environment: args.environment,
        ...(args.approvals ? { approvals: args.approvals } : {}),
        ...(args.change_window ? { change_window: args.change_window } : {}),
        ...(args.target_id ? { target_id: args.target_id } : {}),
        ...(args.payload_hash ? { payload_hash: args.payload_hash } : {}),
      };
      const result = await verify(args.permit_token, ctx);
      log("verify_permit", { ctx, permit_token: args.permit_token, result });
      return toolResult(result);
    },
  );

  // -------------------------------------------------------------------------
  // deploy_service — protected tool
  //
  // This is the verify-before-execute proof. The tool:
  //   1. verifies the generic agent-tool authorization Permit
  //   2. builds the production.deploy ActionContext
  //   3. calls authorize(ctx)
  //   4. if the Decision is not allow, returns without executing
  //   5. verifies the action-specific Permit at the Gate
  //   6. only after successful Verification executes the native effect
  //
  // In production, domain tools may live on other MCP servers. Their protected
  // execution path must preserve the same ordering: evaluate → verify → execute.
  // -------------------------------------------------------------------------
  server.registerTool(
    "deploy_service",
    {
      title: "Deploy Service (authorization-gated)",
      description:
        "Example protected tool. Every call is authorized AND its Permit is verified by AtlaSent " +
        "before the deploy runs. Denied, held, expired, replayed, mismatched, or unverifiable calls " +
        "are blocked and never touch the target system.",
      inputSchema: z.object({
        service_name: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Name of the service to deploy."),
        environment,
        actor_id: actorId,
        approvals,
        change_window: changeWindow,
        change_plan: changePlan,
        target_system: targetSystem,
      }),
      annotations: {
        title: "Deploy Service",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk("deploy_service")) {
        const decision = {
          decision: "deny" as const,
          reasons: ["MCP tool rate limit exceeded — slow down and retry"],
        };
        log("deploy_service.rate_limited", { decision });
        return toolResult(decision);
      }

      // production.deploy is mandatory change control: without a complete
      // change_plan the runtime can only deny it, and would do so AFTER the
      // agent.tool.invoke gate below. Refuse here, before any call, with an
      // answer the agent can act on (ask for the revision) instead of a bare
      // deny. Fail-closed: nothing is evaluated and nothing executes.
      // Remote mode only: the local demo engine has no change-control gate.
      const planMissing =
        getMode() === "remote" ? missingChangePlanReason("production.deploy", args.change_plan) : null;
      if (planMissing !== null) {
        const decision = { decision: "deny" as const, reasons: [planMissing] };
        log("deploy_service.change_plan_required", { service: args.service_name, decision });
        return toolResult(decision);
      }

      // Outer Gate: agent.tool.invoke is authorized and its Permit is
      // verified inside agentToolGate before this handler can continue.
      // One attempt id ties the outer gate to the deploy it guards: both
      // evaluation rows carry it in request_id (see toolAttemptRequestId).
      const attemptId = newToolAttemptId();
      const agentGate = await agentToolGate(
        "deploy_service",
        args.actor_id,
        args.environment,
        args.approvals,
        reportedSessionFor(server),
        toolAttemptRequestId(attemptId, "tool-gate"),
      );
      if (agentGate !== null) return toolResult(agentGate);

      const ctx: ActionContext = {
        action_type: "production.deploy",
        actor_id: args.actor_id,
        environment: args.environment,
        // The service being deployed MUST reach the authorization request.
        // Without it the permit authorizes "a production deploy by this actor
        // in this environment" and says nothing about WHICH service, so one
        // permit covers a deploy of any of them and the target-substitution
        // check at verify has no binding to compare against.
        target_id: args.service_name,
        ...(args.approvals ? { approvals: args.approvals } : {}),
        ...(args.change_window ? { change_window: args.change_window } : {}),
        // production.deploy is a mandatory-change-control action: the plan
        // goes to evaluate top-level with an auto-created Change Brief.
        ...(args.change_plan ? { change_plan: args.change_plan } : {}),
        ...(args.target_system ? { target_system: args.target_system } : {}),
        agent_session: reportedSessionFor(server),
        request_id: toolAttemptRequestId(attemptId, "action"),
      };

      const decision = await authorize(ctx);
      log("deploy_service.authorize", { service: args.service_name, ctx, decision });

      if (decision.decision !== "allow") {
        log("deploy_service.blocked", { service: args.service_name, reasons: (decision as { reasons?: string[] }).reasons });
        return toolResult(decision);
      }

      // ---- EXECUTION GATE -------------------------------------------------
      // A positive Decision is not enough. Consume/verify the bounded Permit
      // before the native side effect. If verification fails, result stays absent.
      const verification = await verify(decision.permit_token, ctx);
      log("deploy_service.verify", {
        service: args.service_name,
        permit_token: decision.permit_token,
        outcome: verification.outcome,
      });
      if (!verification.valid) {
        const denied = verificationFailureDecision(verification, decision);
        log("deploy_service.blocked", { service: args.service_name, denied });
        return toolResult(denied, { verification });
      }
      // --------------------------------------------------------------------

      // Execute the deploy (simulated — real integrations would call out here).
      const result = {
        status: "deployed",
        service: args.service_name,
        environment: args.environment,
        deployed_at: new Date().toISOString(),
      };
      log("deploy_service.executed", { service: args.service_name, permit_token: decision.permit_token, result });

      return toolResult(decision, { verification, result });
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_evaluate — evaluate an action against AtlaSent policies
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_evaluate",
    {
      title: "AtlaSent — Evaluate (Remote API)",
      description:
        "Evaluate an action against your published AtlaSent policies. " +
        "Returns allow/deny/hold/escalate with a permitToken on allow. " +
        "Use this when ATLASENT_MODE=remote and you need to gate an action " +
        "against your hosted policy engine.",
      inputSchema: z.object({
        actor_id: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe(
            "Leave empty when using an agent API key: AtlaSent identifies the agent and its owner " +
              "from the key. Only set this for a non-agent key (e.g. 'service:deploy-bot').",
          ),
        action_type: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Canon-backed Action Type (for example 'production.deploy' or 'agent.tool.invoke')."),
        context: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Key-value context matched against constraint rules (include target/resource info here)."),
        explain: z
          .boolean()
          .optional()
          .describe("When true, populates risk_envelope.factors with a per-factor score breakdown"),
        execution_payload_hash: payloadHash,
        target_id: targetId,
        change_plan: changePlan,
        target_system: targetSystem,
      }),
      annotations: {
        title: "AtlaSent — Evaluate (Remote API)",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (isToolDisabledByReadOnly("atlasent_evaluate")) {
        return toolResult({ decision: "deny", reasons: ["Tool disabled: ATLASENT_MCP_READONLY=1"] });
      }
      if (!rateLimitOk("atlasent_evaluate")) {
        return toolResult({ decision: "deny", reasons: ["MCP tool rate limit exceeded — slow down and retry"] });
      }
      try {
        const result = await evaluateAction({
          ...(args.actor_id ? { actor_id: args.actor_id } : {}),
          agent_session: reportedSessionFor(server),
          action_type: args.action_type,
          context: args.context,
          ...(args.explain !== undefined ? { explain: args.explain } : {}),
          ...(args.execution_payload_hash !== undefined
            ? { execution_payload_hash: args.execution_payload_hash }
            : {}),
          ...(args.target_id !== undefined ? { target_id: args.target_id } : {}),
          ...(args.change_plan !== undefined ? { change_plan: args.change_plan } : {}),
          ...(args.target_system !== undefined ? { target_system: args.target_system } : {}),
        });
        log("atlasent_evaluate", { result });
        return toolResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_list_policies
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_list_policies",
    {
      title: "AtlaSent — List Policies",
      description: "List all constraint bundles / policies for this organization.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID to list policies for."),
        status: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Filter by status (e.g. 'draft', 'published', 'archived')."),
      }),
      annotations: {
        title: "AtlaSent — List Policies",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_list_policies")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await listPolicies({ org_id: args.org_id, status: args.status });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_get_policy
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_get_policy",
    {
      title: "AtlaSent — Get Policy",
      description: "Retrieve a single constraint bundle / policy by ID.",
      inputSchema: z.object({
        policy_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The bundle ID returned by list_policies or create_policy."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID that owns the policy."),
      }),
      annotations: {
        title: "AtlaSent — Get Policy",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_get_policy")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await getPolicy({ policy_id: args.policy_id, org_id: args.org_id });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_list_audit_events
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_list_audit_events",
    {
      title: "AtlaSent — List Audit Events",
      description: "Retrieve recent evaluation events from the audit log.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID to fetch audit events for."),
        evaluation_id: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Filter to events for a specific evaluation ID."),
        from: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 start timestamp for the query window."),
        to: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 end timestamp for the query window."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max number of events to return (default 20, max 100)."),
      }),
      annotations: {
        title: "AtlaSent — List Audit Events",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_list_audit_events")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await listAuditEvents({
          org_id: args.org_id,
          evaluation_id: args.evaluation_id,
          from: args.from,
          to: args.to,
          limit: args.limit,
        });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_explain_authority
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_explain_authority",
    {
      title: "AtlaSent — Explain Authority",
      description:
        "Explain why a principal currently has (or lacks) authority for a scope. " +
        "Answers 'why may principal P exercise scope/action A in organization O " +
        "right now?' — strictly read-only, does not change /v1-evaluate, " +
        "/v1-verify-permit, or any deny/hold/allow semantics; it explains the " +
        "same facts those paths already read. Every matched authority mechanism " +
        "(direct_grant, delegation, role_capability) is reported as its own " +
        "path entry; every excluded or ambiguous relationship is reported as " +
        "its own unresolved finding.",
      inputSchema: z.object({
        principal_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The principal (UUID) whose authority is being explained."),
        requested_scope: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe(
            "The <environment>:<action> authority scope being explained (the same " +
            "wire format /v1-evaluate's authority_scope and " +
            "enterprise_permissions.permission already use), or a bare " +
            "resource:action capability string.",
          ),
        resource_id: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Optional resource ID to scope the explanation to."),
      }),
      annotations: {
        title: "AtlaSent — Explain Authority",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_explain_authority")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await explainAuthority({
          principal_id: args.principal_id,
          requested_scope: args.requested_scope,
          resource_id: args.resource_id,
        });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_integrity_audit
  //
  // Read-only. Registered alongside the other generic read tools, with the
  // same rateLimitOk + toolError idiom and no local-engine fallback — an
  // authority-graph integrity audit is inherently a hosted-mode capability
  // (it reads the runtime system of record), not a local allow/deny decision.
  // In local mode the underlying GET simply fails and surfaces as an isError
  // result, exactly as it does for list_policies / explain_authority. That is
  // the fail-closed outcome: no report is synthesized.
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_integrity_audit",
    {
      title: "AtlaSent — Authority Graph Integrity Audit",
      description:
        "Audit the organization's authority graph for internal inconsistency and " +
        "return the report verbatim. Strictly read-only; changes no policy, permit, " +
        "or decision. THIS IS NOT A PASS/FAIL HEALTH CHECK and the tool synthesizes " +
        "no verdict of its own. Each finding carries a three-way `classification`: " +
        "`defect` is a genuine inconsistency; `non_exercisable` is frequently the " +
        "CORRECT, healthy state (e.g. an expired grant that is supposed to be " +
        "expired) and must not be read as a failure; `unresolved` means the " +
        "proposition COULD NOT BE VERIFIED and must never be treated as clean. " +
        "Read `summary.audited_scope` before drawing any conclusion from an empty " +
        "findings list — a short decision window is not an absence of findings. " +
        "If the audit cannot complete, the server refuses rather than returning a " +
        "partial report, and this tool surfaces that as an error — never an empty " +
        "report.",
      inputSchema: z.object({
        decision_window_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe(
            "Optional. How far back the decision/permit scan reaches, in days " +
              "(1-3650). Omit to let the server apply its own window, which it " +
              "echoes back in summary.audited_scope. There is no client-side " +
              "default.",
          ),
      }),
      annotations: {
        title: "AtlaSent — Authority Graph Integrity Audit",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_integrity_audit")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await integrityAudit(
          args.decision_window_days !== undefined
            ? { decision_window_days: args.decision_window_days }
            : {},
        );
        // Faithful pass-through. toolResult() is the right envelope here even
        // though a report is not a Decision: its isError computation keys off
        // `decision` / `valid` / `error`, none of which are top-level fields of
        // IntegrityReport, so a successful report flows through unchanged and
        // un-annotated. No pass/fail boolean, "healthy" string, or status emoji
        // is added — the three-way classification is the caller's to read.
        return toolResult(result as unknown as Record<string, unknown>);
      } catch (e) {
        // Fail closed: a non-2xx means the audit could not complete (the server
        // refuses a partial report rather than letting unevaluated checks read
        // as passing ones). Surface the error; never substitute an empty report.
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_create_policy (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_create_policy")) {
    server.registerTool(
      "atlasent_create_policy",
      {
        title: "AtlaSent — Create Policy",
        description:
          "Create a new constraint bundle for an action. " +
          "The bundle starts in 'draft' status — call update_policy to publish it.",
        inputSchema: z.object({
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID that will own the policy."),
          policy_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Client-assigned unique ID for this policy bundle (e.g. 'production-change')."),
          title: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Human-readable policy title."),
          policy_type: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Policy type (e.g. 'access_control', 'approval_gate')."),
          rules: z
            .array(z.record(z.string(), z.unknown()))
            .describe("Ordered list of rules — first match wins."),
          description: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("Optional human-readable description."),
          version: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("Semantic version string (e.g. '1.0.0')."),
          priority: z
            .number()
            .int()
            .optional()
            .describe("Evaluation priority (lower number = higher priority)."),
          applies_to: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Scope selector controlling which requests this policy applies to."),
          actions: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Action-specific configuration."),
          effective_at: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("ISO-8601 timestamp when the policy becomes effective."),
          expires_at: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("ISO-8601 timestamp when the policy expires."),
        }),
        annotations: {
          title: "AtlaSent — Create Policy",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!rateLimitOk("atlasent_create_policy")) {
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await createPolicy({
            org_id: args.org_id,
            policy_id: args.policy_id,
            title: args.title,
            policy_type: args.policy_type,
            rules: args.rules,
            description: args.description,
            version: args.version,
            priority: args.priority,
            applies_to: args.applies_to,
            actions: args.actions,
            effective_at: args.effective_at,
            expires_at: args.expires_at,
          });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_update_policy (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_update_policy")) {
    server.registerTool(
      "atlasent_update_policy",
      {
        title: "AtlaSent — Update Policy",
        description:
          "Update a constraint bundle — change rules, title, or publish/archive it. " +
          "Only fields you provide are updated; omitted fields are unchanged.",
        inputSchema: z.object({
          policy_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("ID of the bundle to update."),
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID that owns the policy."),
          title: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("New title for the policy."),
          status: z
            .string()
            .optional()
            .describe("New lifecycle status (e.g. 'draft', 'published', 'archived', 'enforce')."),
          priority: z
            .number()
            .int()
            .optional()
            .describe("New evaluation priority (lower number = higher priority)."),
          rules: z
            .array(z.record(z.string(), z.unknown()))
            .optional()
            .describe("Replacement rules array (replaces all existing rules)."),
          description: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("New description."),
          version: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("New semantic version string."),
          applies_to: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Updated scope selector."),
          actions: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Updated action-specific configuration."),
          effective_at: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("Updated ISO-8601 effective timestamp."),
          expires_at: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("Updated ISO-8601 expiry timestamp."),
        }),
        annotations: {
          title: "AtlaSent — Update Policy",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!rateLimitOk("atlasent_update_policy")) {
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await updatePolicy({
            policy_id: args.policy_id,
            org_id: args.org_id,
            title: args.title,
            status: args.status,
            priority: args.priority,
            rules: args.rules,
            description: args.description,
            version: args.version,
            applies_to: args.applies_to,
            actions: args.actions,
            effective_at: args.effective_at,
            expires_at: args.expires_at,
          });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_delete_policy (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_delete_policy")) {
    server.registerTool(
      "atlasent_delete_policy",
      {
        title: "AtlaSent — Delete Policy",
        description: "Permanently delete a constraint bundle. Prefer archiving over deleting.",
        inputSchema: z.object({
          policy_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("ID of the bundle to delete."),
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID that owns the policy."),
        }),
        annotations: {
          title: "AtlaSent — Delete Policy",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!rateLimitOk("atlasent_delete_policy")) {
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await deletePolicy({ policy_id: args.policy_id, org_id: args.org_id });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_revoke_permit (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_revoke_permit")) {
    server.registerTool(
      "atlasent_revoke_permit",
      {
        title: "AtlaSent — Revoke Permit",
        description:
          "Revoke a permit before it expires. The permit immediately becomes " +
          "invalid for verify_permit calls.",
        inputSchema: z.object({
          permitToken: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("The permit token to revoke."),
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID that owns the permit."),
          reasons: z
            .array(z.string().max(MAX_FIELD_LEN))
            .optional()
            .describe("Human-readable reasons for revocation."),
        }),
        annotations: {
          title: "AtlaSent — Revoke Permit",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!rateLimitOk("atlasent_revoke_permit")) {
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await revokePermit({
            permitToken: args.permitToken,
            org_id: args.org_id,
            reasons: args.reasons,
          });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_list_permits
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_list_permits",
    {
      title: "AtlaSent — List Permits",
      description: "List issued permit tokens for audit and monitoring.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID to list permits for."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max number of permits to return (default 20)."),
        status: z
          .enum(["active", "consumed", "expired", "revoked", "issued"])
          .optional()
          .describe("Filter by permit status."),
        actor_id: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Filter to permits issued for this actor."),
        action_type: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Filter to permits for this action type."),
        from: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 start timestamp filter."),
        to: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 end timestamp filter."),
        cursor: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Pagination cursor from a previous response."),
      }),
      annotations: {
        title: "AtlaSent — List Permits",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_list_permits")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await listPermits({
          org_id: args.org_id,
          limit: args.limit,
          status: args.status,
          actor_id: args.actor_id,
          action_type: args.action_type,
          from: args.from,
          to: args.to,
          cursor: args.cursor,
        });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_get_permit / atlasent_check_permit / atlasent_get_decision
  // Read-only lookups of a single permit or decision. Permit responses never
  // carry the bearer `token` or `signature` (see engine.redactPermitSecrets).
  // -------------------------------------------------------------------------
  const permitIdSchema = z
    .string()
    .min(1)
    .max(MAX_FIELD_LEN)
    .describe("Permit id (UUID) as returned by atlasent_list_permits.");

  server.registerTool(
    "atlasent_get_permit",
    {
      title: "AtlaSent — Get Permit",
      description:
        "Fetch one permit's record: status, actor, action, environment, issue/expiry/consume " +
        "times and the decision that issued it. Never returns the permit token itself.",
      inputSchema: z.object({ permit_id: permitIdSchema }),
      annotations: {
        title: "AtlaSent — Get Permit",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_get_permit")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        return toolResult((await getPermit(args.permit_id)) as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "atlasent_check_permit",
    {
      title: "AtlaSent — Check Permit",
      description:
        "Check whether a permit is still usable without consuming it. Returns " +
        "{ valid, status } where status is active, revoked, consumed or expired. Use " +
        "before a deferred action to avoid acting on a permit that was revoked meanwhile. " +
        "This is a status read, not authorization: execute only after atlasent_verify_permit.",
      inputSchema: z.object({ permit_id: permitIdSchema }),
      annotations: {
        title: "AtlaSent — Check Permit",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_check_permit")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        return toolResult((await checkPermit(args.permit_id)) as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "atlasent_get_decision",
    {
      title: "AtlaSent — Get Decision",
      description:
        "Fetch one authorization decision (execution evaluation) by id: the decision, " +
        "deny code, actor, action, context and evidence fields. Set include_trace to also " +
        "return its approval events, permit uses and webhook deliveries. Requires audit:read.",
      inputSchema: z.object({
        evaluation_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Execution evaluation id (UUID), e.g. a permit's decision_id."),
        include_trace: z
          .boolean()
          .optional()
          .describe("Also return approval events, permit uses and webhook deliveries."),
      }),
      annotations: {
        title: "AtlaSent — Get Decision",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_get_decision")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        return toolResult((await getDecision(args.evaluation_id, args.include_trace)) as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_permit (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_permit")) {
    server.registerTool(
      "atlasent_permit",
      {
        title: "AtlaSent — Issue Permit",
        description:
          "Manually issue a permit token for an action. Use for pre-authorized " +
          "operations where a full evaluate call is not practical.",
        inputSchema: z.object({
          subject: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("The actor the permit is issued for (e.g. 'user:alice')."),
          action: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("The action being permitted (e.g. 'production.deploy')."),
          resource: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("The resource the permit applies to (e.g. 'env:prod')."),
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID that owns the policy."),
          ttl_seconds: z
            .number()
            .int()
            .min(60)
            .max(86400)
            .optional()
            .describe("How long the permit is valid in seconds (default 300, max 86400)."),
          context: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional context to bind to the permit."),
        }),
        annotations: {
          title: "AtlaSent — Issue Permit",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!rateLimitOk("atlasent_permit")) {
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await issuePermit({
            subject: args.subject,
            action: args.action,
            resource: args.resource,
            org_id: args.org_id,
            ttl_seconds: args.ttl_seconds,
            context: args.context,
          });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_verify_permit
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_verify_permit",
    {
      title: "AtlaSent — Verify Permit (V1)",
      description:
        "Verify a permit token with full binding inputs against the V1 endpoint. " +
        "Use this at the execution boundary before the governed native effect; under-specified verification is a bypass vector.",
      inputSchema: z.object({
        permit_token: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The permit_token from a prior evaluate call."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID that issued the permit."),
        action: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Action to verify the permit against."),
        resource: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Resource to verify the permit against."),
      }),
      annotations: {
        title: "AtlaSent — Verify Permit (V1)",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_verify_permit")) {
        return toolResult({ valid: false, outcome: "error", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await verifyPermitV1({
          permit_token: args.permit_token,
          org_id: args.org_id,
          action: args.action,
          resource: args.resource,
        });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_await_approval (CROSS-056)
  // -------------------------------------------------------------------------
  // WAITS for a person's decision on a held action. It cannot approve: there
  // is no decision/resolution input, and a person approves only in the
  // AtlaSent console. On approval it claims the single permit the runtime
  // minted; that permit must still go through atlasent_verify_permit before
  // anything runs. Every other outcome is no permit (fail-closed).
  server.registerTool(
    "atlasent_await_approval",
    {
      title: "AtlaSent — Wait for Human Approval",
      description:
        "Wait for a person to approve or reject a held action in the AtlaSent console. " +
        "Use the approval_request_id from a 'hold' result. This tool cannot approve anything; " +
        "it only waits. If approved, it returns a permit_token that you MUST verify with " +
        "atlasent_verify_permit before running the action. Any other outcome (rejected, expired, " +
        "timed out) means the action must not run.",
      inputSchema: z.object({
        approval_request_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The approval_request_id from a 'hold' evaluate result."),
        max_wait_seconds: z
          .number()
          .int()
          .min(5)
          .max(900)
          .optional()
          .describe("How long to wait for a decision (default 120, max 900)."),
        change_plan: changePlan.describe(
          "Your CURRENT change plan, if it changed since the action was evaluated. Omit it to present the plan " +
            "this server evaluated. It is only a declaration: the approved plan is what runs unless a person approves the new one.",
        ),
        on_plan_mismatch: z
          .enum(["rerequest", "use_approved"])
          .optional()
          .describe(
            "If your plan differs from the approved one: 'rerequest' (default) files ONE linked re-request for your " +
              "plan and keeps waiting; 'use_approved' claims the approved plan instead and returns it so you run exactly that.",
          ),
      }),
      annotations: {
        title: "AtlaSent — Wait for Human Approval",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_await_approval")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      if (getMode() !== "remote") {
        return toolResult({
          outcome: "not_approved",
          approval_request_id: args.approval_request_id,
          reasons: ["Human approval needs the hosted AtlaSent API (remote mode). Local mode never approves."],
        });
      }
      try {
        const result = await awaitApproval({
          approval_request_id: args.approval_request_id,
          max_wait_ms: (args.max_wait_seconds ?? 120) * 1000,
          ...(args.change_plan ? { change_plan: args.change_plan } : {}),
          ...(args.on_plan_mismatch ? { on_plan_mismatch: args.on_plan_mismatch } : {}),
        });
        const summary = result.progression?.length ? { summary: result.progression.join(" → ") } : {};
        log("atlasent_await_approval", { outcome: result.outcome, approval_request_id: result.approval_request_id, ...summary });
        if (result.outcome === "approved") {
          return toolResult({
            ...result,
            ...summary,
            next_step:
              "Call atlasent_verify_permit with this permit_token before running the action" +
              (result.approved_plan ? ", and run exactly approved_plan." : "."),
          });
        }
        return toolResult({ ...result, ...summary });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_record_execution_evaluation
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_record_execution_evaluation",
    {
      title: "AtlaSent — Record Execution Evaluation",
      description:
        "Record the outcome of an execution that was permitted by a prior evaluate " +
        "call. Closes the evidence loop with the observed execution result; it does not replace pre-execution Permit Verification.",
      inputSchema: z.object({
        evaluation_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("The evaluation_id from the prior evaluate call."),
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID that owns the evaluation."),
        outcome: z
          .enum(["success", "failure", "skipped"])
          .describe("The actual outcome of the execution."),
        executed_at: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 timestamp when the execution completed."),
        details: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional details about what was executed and the result."),
      }),
      annotations: {
        title: "AtlaSent — Record Execution Evaluation",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_record_execution_evaluation")) {
        return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
      }
      try {
        const result = await recordExecutionEvaluation({
          evaluation_id: args.evaluation_id,
          org_id: args.org_id,
          outcome: args.outcome,
          executed_at: args.executed_at,
          details: args.details,
        });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_create_webhook (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_create_webhook")) {
    server.registerTool(
      "atlasent_create_webhook",
      {
        title: "AtlaSent — Create Webhook",
        description: "Register a webhook URL to receive evaluation events.",
        inputSchema: z.object({
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID to register the webhook for."),
          url: z
            .string()
            .url()
            .describe("The HTTPS URL to deliver events to."),
          events: z
            .array(z.string().min(1).max(MAX_FIELD_LEN))
            .describe("Event types to subscribe to (e.g. ['evaluation.deny', 'permit.issued'])."),
          description: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("Optional human-readable description of this webhook."),
          secret: z
            .string()
            .min(8)
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("Signing secret for HMAC verification of payloads."),
        }),
        annotations: {
          title: "AtlaSent — Create Webhook",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async (args) => {
        if (!rateLimitOk("atlasent_create_webhook")) {
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await createWebhook({
            org_id: args.org_id,
            url: args.url,
            events: args.events,
            description: args.description,
            secret: args.secret,
          });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_delete_webhook (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isToolDisabledByReadOnly("atlasent_delete_webhook")) {
    server.registerTool(
      "atlasent_delete_webhook",
      {
        title: "AtlaSent — Delete Webhook",
        description: "Remove a registered webhook.",
        inputSchema: z.object({
          webhook_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("ID of the webhook to delete."),
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID that owns the webhook."),
        }),
        annotations: {
          title: "AtlaSent — Delete Webhook",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!rateLimitOk("atlasent_delete_webhook")) {
          return toolResult({ error: "rate_limit", reasons: ["MCP tool rate limit exceeded"] });
        }
        try {
          const result = await deleteWebhook({ webhook_id: args.webhook_id, org_id: args.org_id });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_lookup_action — read-only canonical action spec lookup.
  // Returns matching entries from the Authorization Intelligence Library.
  // No authorization gate; no network calls; no side effects.
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_lookup_action",
    {
      title: "Lookup Canonical Action Spec",
      description:
        "Look up canonical action specifications from the Authorization Intelligence Library. " +
        "Returns the permanent canon_id, gate flags (requires_human_approval, requires_mfa, requires_verified_actor, requires_state_snapshot), " +
        "authorization pattern, risk posture, AI risk classification, regulatory mappings, evidence requirements, and the action's " +
        "knowledge-graph relationships (what it requires and produces, and which frameworks / control objectives it satisfies) " +
        "for every governed action type in the Canon. " +
        "Use `slug` for an exact match (e.g. 'production.deploy') or `query` to describe what you want to do in " +
        "plain language (e.g. 'deploy the api service to prod', 'grant admin access', 'close the books'). " +
        "`query` is ranked offline against the vendored Canon and returns a `retrieval` block with " +
        "`confidence` = confident | ambiguous | none — act only on `confident`; the tool never invents an " +
        "action type, and a `none` result means the Canon has no such action (see the hint). " +
        "Omit both to list the full Canon.",
      inputSchema: z.object({
        slug: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Exact canonical action slug (e.g. 'production.deploy', 'access.grant')."),
        query: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe(
            "Plain-language description of the action to find. Ranked deterministically (offline, no network) " +
              "over slug, display name, family, description and a curated alias vocabulary.",
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_lookup_action")) {
        return {
          ...toolResult({ error: "rate_limit_exceeded", message: "MCP tool rate limit exceeded — slow down and retry" }),
          isError: true as const,
        };
      }

      let results = CANON_ACT_CATALOG;
      let retrieval: RetrievalResult | undefined;

      if (args.slug !== undefined && args.slug !== "") {
        const target = args.slug.toLowerCase();
        results = CANON_ACT_CATALOG.filter((a) => a.slug === target);
      } else if (args.query !== undefined && args.query.trim() !== "") {
        // Natural-language path: deterministic offline ranking over the
        // vendored Canon (actionRetrieval.ts). Every candidate is a Canon
        // entry by reference — nothing here can synthesize a slug. A "none"
        // verdict returns found:false with an intake-pipeline hint rather
        // than a plausible-looking guess.
        retrieval = rankActions(args.query);
        const bySlug = new Map(CANON_ACT_CATALOG.map((a) => [a.slug, a] as const));
        results =
          retrieval.confidence === "none"
            ? []
            : retrieval.candidates
                .map((c) => bySlug.get(c.slug))
                .filter((a): a is ActSpecEntry => a !== undefined);
      }

      log("atlasent_lookup_action", {
        slug: args.slug,
        query: args.query,
        result_count: results.length,
        retrieval_confidence: retrieval?.confidence,
      });

      if (results.length === 0) {
        return toolResult({
          found: false,
          result_count: 0,
          actions: [],
          ...(retrieval ? { retrieval } : {}),
          hint: retrieval
            ? NO_MATCH_HINT
            : "No matching canonical action found. Use query='' or omit all parameters to list the full Canon.",
        } as unknown as Record<string, unknown>);
      }

      // Enrich each result with its knowledge-graph neighborhood (relationships)
      // so an agent gets the full profile — requires/produces/frameworks/controls —
      // from the compiler output rather than guessing.
      const enriched = results.map((a) => ({
        ...a,
        relationships: CANON_ACTION_GRAPH[a.slug] ?? null,
      }));

      return toolResult({
        found: true,
        result_count: enriched.length,
        actions: enriched,
        ...(retrieval ? { retrieval } : {}),
      } as unknown as Record<string, unknown>);
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_atlas_lookup — the Knowledge Atlas as an MCP tool.
  // Read-only, no network, no auth gate. Lets any MCP host reason about
  // AtlaSent's own vocabulary from the same compiled graph the docs/console use.
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_atlas_lookup",
    {
      title: "AtlaSent — Knowledge Atlas Lookup",
      description:
        "Look up a canonical AtlaSent concept from the Knowledge Atlas — the compiled graph of the system's own " +
        "vocabulary (Caller, Authority, Policy, Decision, Permit, Verification, Evidence, Audit Chain, Gate, Trust Root, ...). " +
        "Returns the concept's canonical definition (its source-of-truth doc), its relationships (what it depends on and " +
        "what depends on it), the surfaces that realize it, and its ADR / API / SDK / implementation anchors — so every AI " +
        "host reasons from the same canonical knowledge instead of guessing. " +
        "Use `id` for an exact concept id (e.g. 'permit', 'audit-chain', 'gate') or `query` for a case-insensitive substring " +
        "search across id, term, and definition. Omit both to list every concept.",
      inputSchema: z.object({
        id: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Exact concept id (e.g. 'permit', 'audit-chain', 'gate', 'trust-root')."),
        query: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("Substring search across id, term, and definition. Case-insensitive."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_atlas_lookup")) {
        return {
          ...toolResult({ error: "rate_limit_exceeded", message: "MCP tool rate limit exceeded — slow down and retry" }),
          isError: true as const,
        };
      }

      const byId = new Map(ATLAS_CONCEPTS.map((c) => [c.id, c]));
      const nodeById = new Map(ATLAS_NODES.map((n) => [n.id, n]));
      const term = (id: string) => byId.get(id)?.term ?? id;
      const surface = (id: string) => {
        const n = nodeById.get(id);
        return n ? { id: n.id, name: n.name, ref: n.ref } : { id, name: id, ref: null };
      };

      // Omit both -> return the index of every concept.
      if ((args.id === undefined || args.id === "") && (args.query === undefined || args.query === "")) {
        log("atlasent_atlas_lookup", { mode: "index", result_count: ATLAS_CONCEPTS.length });
        return toolResult({
          found: true,
          source: ATLAS_SOURCE,
          result_count: ATLAS_CONCEPTS.length,
          concepts: ATLAS_CONCEPTS.map((c) => ({ id: c.id, term: c.term, canon: c.canon })),
        } as unknown as Record<string, unknown>);
      }

      let results = ATLAS_CONCEPTS;
      if (args.id !== undefined && args.id !== "") {
        const t = args.id.toLowerCase();
        results = ATLAS_CONCEPTS.filter((c) => c.id === t);
      } else if (args.query !== undefined && args.query !== "") {
        const q = args.query.toLowerCase();
        results = ATLAS_CONCEPTS.filter(
          (c) =>
            c.id.includes(q) ||
            c.term.toLowerCase().includes(q) ||
            (c.definition ?? "").toLowerCase().includes(q),
        );
      }

      log("atlasent_atlas_lookup", { id: args.id, query: args.query, result_count: results.length });

      if (results.length === 0) {
        return toolResult({
          found: false,
          source: ATLAS_SOURCE,
          result_count: 0,
          concepts: [],
          hint: "No matching concept. Omit all parameters to list every concept id.",
        } as unknown as Record<string, unknown>);
      }

      const enriched = results.map((c) => ({
        id: c.id,
        term: c.term,
        status: c.status,
        source_of_truth: c.definition,
        canon: c.canon,
        adr: c.adr,
        product_spec: c.product_spec,
        implementation: c.implementation,
        api: c.api,
        sdk: c.sdk,
        docs: c.docs,
        depends_on: c.depends_on.map((d) => ({ id: d, term: term(d) })),
        used_by: c.used_by.map((u) => ({ id: u, term: term(u) })),
        realized_by: c.realized_by.map(surface),
      }));

      return toolResult({
        found: true,
        source: ATLAS_SOURCE,
        result_count: enriched.length,
        concepts: enriched,
      } as unknown as Record<string, unknown>);
    },
  );

  // -------------------------------------------------------------------------
  // V2 Wave B tools — atlasent_evaluate_many, atlasent_evaluate_stream,
  // atlasent_query. Closed-by-default: 404 from the API surfaces as a
  // typed `feature_not_enabled` error.
  // -------------------------------------------------------------------------
  registerV2Tools(server);

  // -------------------------------------------------------------------------
  // Compliance tools: SCIM provisioning, SIEM delivery, evidence exports.
  // -------------------------------------------------------------------------
  registerComplianceTools(server);

  // -------------------------------------------------------------------------
  // VQP tools: generate snapshots, verify hash integrity, detect model drift.
  // -------------------------------------------------------------------------
  registerVqpTools(server);

  return server;
}