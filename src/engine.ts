/**
 * Authorization engine — dispatches to a local rules engine or the hosted
 * AtlaSent API based on configuration.
 *
 * Mode selection (read on every call, so tests and hosts can toggle without
 * re-initializing the server):
 *
 *   ATLASENT_MODE=remote            → hosted AtlaSent API
 *   ATLASENT_MODE=local             → local rules engine
 *   (unset)                         → remote if ATLASENT_API_KEY
 *                                      is set (ATLASENT_BASE_URL defaults to the
 *                                      hosted endpoint), else local
 *
 * Production safeguard: local-mode permits are unsigned and forgeable
 * (Date.now() + UUID slice, no HMAC — see src/localEngine.ts shortId()).
 * Local mode is intended for development and CI only. getMode() refuses
 * to resolve to local when NODE_ENV=production unless the operator has
 * explicitly opted in with ATLASENT_ALLOW_LOCAL_MODE_IN_PROD=true.
 *
 * Maturity classification (atlasent/MATURITY_DOCTRINE.md, adopted 2026-05-26):
 *   - local mode   — **Experimental**. UI/runtime exists but permits are
 *                    unsigned and forgeable. Dev/CI only. A stderr warning
 *                    is emitted once per process when local mode resolves.
 *   - remote mode  — **GA**. Hosted backend with signed permits and audit
 *                    chain.
 *
 * The hosted backend is a configuration swap, not a rewrite: every tool
 * handler calls `authorize(ctx)` and gets back the same Decision shape.
 */

import type { ActionContext, Decision, VerifyResult } from "./decision.js";
import { denyDecision } from "./decision.js";
import { authorizeLocal, verifyLocal } from "./localEngine.js";

import { createHash } from "node:crypto";

import { VERSION } from "./version.js";

const REQUEST_TIMEOUT_MS = 10_000;

// AbortSignal.timeout() is not available in all Node 22 environments;
// use AbortController + setTimeout for broad compatibility.
function makeAbortSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

export type Mode = "local" | "remote";

// Module-level flag: emit the local-mode maturity warning at most once
// per process. getMode() is called on every authorize/verify, so without
// this gate the warning would flood stderr.
let LOCAL_MODE_WARNING_EMITTED = false;
let BASE_URL_WARNING_EMITTED = false;

function emitLocalModeWarning(): void {
  if (LOCAL_MODE_WARNING_EMITTED) return;
  if (process.env.NODE_ENV === "test") return;
  if (process.env.ATLASENT_SUPPRESS_LOCAL_MODE_WARNING === "true") return;
  LOCAL_MODE_WARNING_EMITTED = true;
  // eslint-disable-next-line no-console
  console.error(
    "[atlasent-mcp-server] WARNING: running in LOCAL mode. " +
      "Local-mode permits are unsigned and forgeable " +
      "(Date.now() + UUID, no HMAC). " +
      "Per atlasent/MATURITY_DOCTRINE.md, local mode is classified " +
      "Experimental and is intended for development and CI only. " +
      "For production-authoritative authorization, set ATLASENT_API_KEY " +
      "and ATLASENT_BASE_URL to use the hosted AtlaSent backend " +
      "(get an API key: https://console.atlasent.io/auth/sign-up?utm_source=mcp&utm_medium=cli). " +
      "See SECURITY.md § 'Maturity classification' for details. " +
      "Set ATLASENT_SUPPRESS_LOCAL_MODE_WARNING=true to silence this warning " +
      "in dev/CI scripts.",
  );
}

function emitBaseUrlWarning(): void {
  if (BASE_URL_WARNING_EMITTED) return;
  if (process.env.NODE_ENV === "test") return;
  if (process.env.ATLASENT_SUPPRESS_BASE_URL_WARNING === "true") return;
  const url = process.env.ATLASENT_BASE_URL;
  // Unset means the default hosted base, which already has the suffix.
  if (url === undefined || url.includes("/functions/v1")) return;
  BASE_URL_WARNING_EMITTED = true;
  // eslint-disable-next-line no-console
  console.error(
    "[atlasent-mcp-server] WARNING: ATLASENT_BASE_URL does not contain '/functions/v1'. " +
      "For Supabase-hosted AtlaSent instances ATLASENT_BASE_URL must end in /functions/v1 " +
      "(e.g. https://<project-ref>.supabase.co/functions/v1). " +
      "Without this suffix every API call will 404. " +
      "See README §'Remote mode (hosted API)' for details. " +
      "Set ATLASENT_SUPPRESS_BASE_URL_WARNING=true to silence this warning.",
  );
}

export function getMode(): Mode {
  const explicit = process.env.ATLASENT_MODE?.toLowerCase();
  const requested: Mode =
    explicit === "remote"
      ? "remote"
      : explicit === "local"
        ? "local"
        : // An API key alone means remote: ATLASENT_BASE_URL is optional and
          // defaults to the hosted endpoint (see baseUrl(), README, server.json).
          // Falling back to local here would silently hand a user who configured
          // a real key unsigned, forgeable local-mode permits.
          process.env.ATLASENT_API_KEY
          ? "remote"
          : "local";

  // Production safeguard (security): local-mode permits are unsigned
  // and forgeable (Date.now() + UUID slice, no HMAC; see
  // src/localEngine.ts shortId()). Refuse to run local mode under
  // NODE_ENV=production unless the operator has explicitly opted in
  // with ATLASENT_ALLOW_LOCAL_MODE_IN_PROD=true. Without this guard,
  // missing ATLASENT_API_KEY / ATLASENT_BASE_URL env vars in a
  // production deployment would silently fall through to local mode,
  // allowing anyone to mint valid-looking permits.
  if (
    requested === "local" &&
    process.env.NODE_ENV === "production" &&
    process.env.ATLASENT_ALLOW_LOCAL_MODE_IN_PROD !== "true"
  ) {
    throw new Error(
      "MCP server refuses to run in local mode with NODE_ENV=production. " +
        "Local-mode permits are unsigned and forgeable. Either set " +
        "ATLASENT_API_KEY and ATLASENT_BASE_URL to use the hosted AtlaSent " +
        "backend, or explicitly opt in (NOT RECOMMENDED) with " +
        "ATLASENT_ALLOW_LOCAL_MODE_IN_PROD=true.",
    );
  }

  // Emit the maturity warning at most once per process when local mode
  // is actually being used. This is the visibility companion to the
  // hard production refusal above: dev/CI usage is permitted, but the
  // operator should know they are running in Experimental mode.
  if (requested === "local") {
    emitLocalModeWarning();
  }

  // Emit a one-time startup warning in remote mode when ATLASENT_BASE_URL
  // doesn't contain /functions/v1. Without the suffix every API call
  // returns 404 on Supabase-hosted instances.
  if (requested === "remote") {
    emitBaseUrlWarning();
  }

  return requested;
}

export async function authorize(ctx: ActionContext): Promise<Decision> {
  try {
    return getMode() === "remote" ? await authorizeRemote(ctx) : authorizeLocal(ctx);
  } catch (err) {
    return denyDecision([err instanceof Error ? err.message : String(err)]);
  }
}

export async function verify(token: string, ctx: ActionContext): Promise<VerifyResult> {
  try {
    return getMode() === "remote" ? await verifyRemote(token, ctx) : verifyLocal(token, ctx);
  } catch (err) {
    return {
      outcome: "error",
      valid: false,
      reasons: [err instanceof Error ? err.message : String(err)],
    };
  }
}

// ---------------------------------------------------------------------------
// Remote (hosted AtlaSent backend)
// ---------------------------------------------------------------------------

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `@atlasent/mcp-server/${VERSION}`,
  };
  const key = process.env.ATLASENT_API_KEY;
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const anon = process.env.ATLASENT_ANON_KEY;
  if (anon) headers["x-anon-key"] = anon;
  return headers;
}

function baseUrl(): string {
  return (process.env.ATLASENT_BASE_URL ?? "https://api.atlasent.io/functions/v1").replace(/\/+$/, "");
}

// The generic REST family documented in atlasent-api's openapi.yaml — e.g.
// /v1/policies, /v1/permits, /v1/audit/events, /v1/webhooks, /v1/orgs/... —
// is served at the AtlaSent gateway/API DOMAIN ROOT, not under the Supabase
// "/functions/v1" invocation base. Confirmed against atlasent-api's own
// documented, working curl examples (docs/runbooks/PILOT_TROUBLESHOOTING.md,
// docs/runbooks/PILOT_CUSTOMER_ACTIVATION.md):
//   curl https://api.atlasent.io/v1/api-keys
//   curl https://api.atlasent.io/v1/audit/events
// and atlasent-control-plane's gateway (gateway/src/plugin.ts upstreamUrlFor):
// it proxies incoming "/v1/*" requests verbatim onto the runtime base with no
// path rewriting, so the caller must already address the gateway root, not
// "/functions/v1". This is a DIFFERENT base than the dash-form direct
// Supabase-function invocation used by /v1-evaluate, /v1-verify-permit, and
// /v1-authority-intelligence/* (those live at
// https://api.atlasent.io/functions/v1/v1-evaluate etc. and must keep using
// baseUrl() unchanged).
//
// README documents ATLASENT_BASE_URL as the "/functions/v1" form (matching
// the dash-form calls), so when it carries that suffix we strip it to
// recover the gateway root for the slash-form REST family below. An
// operator who has already pointed ATLASENT_BASE_URL at the gateway root
// (no "/functions/v1" suffix — as this repo's own tests do) is passed
// through unchanged.
function restBaseUrl(): string {
  const b = baseUrl();
  const suffix = "/functions/v1";
  return b.endsWith(suffix) ? b.slice(0, -suffix.length) : b;
}

// Choose the correct base for a given request path: the generic "/v1/<resource>"
// REST family (single slash after "v1") uses restBaseUrl(); the dash-form
// direct Supabase-function paths ("/v1-evaluate", "/v1-authority-intelligence/...")
// use baseUrl() unchanged. Do not "simplify" this by string-matching "/v1" alone —
// "/v1-evaluate" also starts with "/v1" and must NOT match here.
function resolveBase(path: string): string {
  return path.startsWith("/v1/") ? restBaseUrl() : baseUrl();
}

function handleHttpError(status: number, body: string): never {
  if (status === 401) throw new Error("Authentication failed — check your ATLASENT_API_KEY");
  if (status === 403) throw new Error("Permission denied — your key lacks the required scope");
  if (status === 429) throw new Error("Rate limited — back off and retry");
  // Try to surface { error, message } from the body
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const errMsg = parsed.message ?? parsed.error ?? body;
    throw new Error(`AtlaSent API ${status}: ${errMsg}`);
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`AtlaSent API ${status}: ${body}`);
    throw e;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${resolveBase(path)}${path}`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
    signal: makeAbortSignal(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    handleHttpError(res.status, text);
  }
  return (await res.json()) as T;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${resolveBase(path)}${path}`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(body),
    signal: makeAbortSignal(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    handleHttpError(res.status, text);
  }
  return (await res.json()) as T;
}

async function get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  let url = `${resolveBase(path)}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
      .join("&");
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    method: "GET",
    headers: buildHeaders(),
    signal: makeAbortSignal(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    handleHttpError(res.status, text);
  }
  return (await res.json()) as T;
}

// Canonical evaluate response shape (v1-evaluate/handler.ts):
//   { decision: "allow"|"deny"|"hold"|"escalate",
//     permit_token?: string, request_id?: string, expires_at?: string,
//     envelope_hash?: string,
//     deny_code?: string, deny_reason?: string,
//     denial?: { reasons: string[], code: string } }
//
// `deny_code`/`deny_reason` are TOP-LEVEL fields on the real response
// (canonical-evaluate.schema.json in atlasent-api) and are what the vast
// majority of the deployed handler's deny paths actually set (56 call
// sites vs. a single conditional `denial` object reserved for a narrower
// caller-denial case) — this repo's own CANONICAL_EVALUATE_CONTRACT.md
// compat-debt ledger (CD-4) already named this exact drift: MCP read only
// the nested `denial.code` while the runtime emits top-level `deny_code`,
// so on the common path `deny_code` came back `undefined` here and the
// INSUFFICIENT_APPROVALS -> requires_human_approval routing signal below
// was silently lost even though the deny itself was (correctly) still
// fail-closed. Read top-level first, nested `denial` as a fallback.
//
// `envelope_hash` is the sha-256 of the canonical ContextEnvelopeV1 the API
// records for the evaluation (see _shared/context-envelope-v1.ts in
// atlasent-api). When present, it is the canonical join key between this
// decision, the issued permit, the consumed payload, and any constrained-
// agent finding produced during the same evaluation. We surface it through
// the Decision so MCP tool hosts can stamp it into agent-side audit.
interface RawEvaluate {
  decision: string;
  permit_token?: string;
  reasons?: string[];
  request_id?: string;
  envelope_hash?: string;
  deny_code?: string;
  deny_reason?: string;
  denial?: { reasons?: string[]; code?: string };
  conditions?: string[];
  hold_id?: string;
  approval_request_id?: string;
}

// Shared base request-body construction for POST /v1-evaluate. Both call
// paths that hit this endpoint — the canonical enforcement path
// (authorizeRemote) and the raw evaluate tool path (evaluateAction) — send
// the same canonical fields (action_type, actor_id, an optional context) and
// the same default state_snapshot injection required since the
// requires_state_snapshot backfill (20260603000019). Each caller shapes its
// OWN distinct bits before handing them here: authorizeRemote pre-shapes the
// approvals/change_window/tool_name context object, and evaluateAction passes
// the raw caller-supplied context plus the explain flag. This helper only
// assembles the shared base body — it changes no behavior.
//
// The key insertion order (action_type, actor_id, context?, explain?,
// state_snapshot) is load-bearing: it reproduces the exact JSON both paths
// serialized before this de-dup, so the wire body stays byte-identical.
// authorizeRemote never passes `explain` (so it is omitted, exactly as
// before) and always passes a shaped context; evaluateAction includes
// context/explain only when defined.
/**
 * Normalize an execution payload digest to the ONE form `/v1-evaluate` binds.
 *
 * The runtime binds `execution_hash_expected` into the signed permit only when
 * the TOP-LEVEL `execution_payload_hash` matches `/^[0-9a-f]{64}$/`, and it
 * DROPS a non-matching value rather than rejecting it — no error anywhere.
 *
 * CORRECTED 2026-09-13 (atlasent-api#3355, Copilot review). This comment used
 * to continue: the permit "mints unbound", leaving `PAYLOAD_MISMATCH`
 * unreachable, so "the altered call executes." That OVERSTATES the risk and is
 * wrong — this repo's own CLAUDE.md already carried the correction while this
 * comment did not. `v1-evaluate` persists its own `proofPayloadHash` (a hash of
 * the whole request body) as `execution_evaluations.payload_hash`, and
 * `v1-verify-permit` adopts THAT as `boundPayloadHash` whenever the signed
 * token carries none. The permit IS bound — to the server's hash rather than
 * yours — so `payload_hash_supplied_unbound` fires only when nothing is bound
 * at all, which on the ordinary path essentially never happens. Three
 * outcomes, none of them the check you meant to enable:
 *
 *   - present your own digest      -> compared against a hash of the whole
 *                                     request, which it can never equal: a
 *                                     DETERMINISTIC `PAYLOAD_MISMATCH` on
 *                                     every call, tampering or not.
 *   - present nothing, production  -> `PAYLOAD_HASH_REQUIRED`.
 *   - present nothing, elsewhere   -> passes with no payload check at all.
 *                                     This is the genuinely unchecked case.
 *
 * So the defect a malformed digest causes is that it never CONSTRAINS
 * execution — fail-closed but useless in the first two cases, unchecked in the
 * third — not that an altered payload sails through a disabled check. Which is
 * why this function still throws: the remedy is unchanged, only the reason is
 * stated accurately.
 *
 * Fail-closed at every layer: throw here rather than send something the runtime
 * will quietly discard. A `sha256:` prefix is accepted and stripped because it
 * is the natural mistake and silently produced exactly that defect elsewhere.
 */
export function normalizePayloadHash(value: string): string {
  const bare = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) {
    throw new Error(
      "execution_payload_hash must be a SHA-256 digest as 64 hex characters " +
        `(optionally "sha256:"-prefixed); got ${bare.length} character(s). ` +
        "The runtime silently drops a malformed digest and binds the permit to " +
        "its own hash of the whole request instead, so your digest would never " +
        "constrain execution: presenting it at verify would fail with " +
        "PAYLOAD_MISMATCH on every call.",
    );
  }
  return bare.toLowerCase();
}

/**
 * Attach the target binding to an evaluate request, in every shape the runtime
 * actually reads it from.
 *
 * Presenting `target_id` at verify does NOTHING on its own. `v1-verify-permit`
 * compares it against a value it reads back from the evaluate call
 * (`firstBindingMismatch` reads `target`/`target_id` out of the stored
 * `request_context`; the legacy permits-row path reads the `target_id` column).
 * Its guard is present-and-bound-and-differ — "an omitted or unbound target
 * never denies" — so when nothing bound a target at evaluate, the comparison is
 * skipped and a permit minted for target A redeems while presenting target B.
 * That is the same structural hole `normalizePayloadHash` documents for the
 * execution digest, one field over — and here the "altered call executes"
 * framing IS accurate, because nothing else ever binds a target the way
 * `proofPayloadHash` backstops the execution digest.
 *
 * Three consumers, three placements, all populated from the one value:
 *   - `resource_id` (TOP-LEVEL)   → the permit's `target_id` column
 *   - `context.target_id`         → `firstBindingMismatch`'s expected value
 *   - `context.target = { id }`   → the `permits` insert's `context.target.id`
 *
 * Applied only when the caller supplies a target, so a caller that never set
 * one sends a byte-identical request to before.
 */
function applyTargetBinding(
  body: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
  targetId: string | undefined,
): Record<string, unknown> | undefined {
  if (targetId === undefined || targetId === "") return context;
  body.resource_id = targetId;
  const existingTarget = context?.target;
  const target = existingTarget && typeof existingTarget === "object" && !Array.isArray(existingTarget)
    ? { ...(existingTarget as Record<string, unknown>), id: targetId }
    : { id: targetId };
  return { ...(context ?? {}), target_id: targetId, target };
}

/**
 * Where an agent action came from, as REPORTED by the agent host (CROSS-056
 * §2b): which app (host) and which chat/session. The runtime stores it
 * labelled "reported" and never uses it in a decision, permit or audit hash.
 * It exists so a person can trace an action back to the conversation that
 * produced it.
 */
export interface ReportedAgentSession {
  host?: string;
  session_id?: string;
  run_id?: string;
}

const MAX_SESSION_FIELD_LEN = 200;

/** Keep only non-empty string fields, trimmed and capped. Undefined if empty. */
export function sanitizeAgentSession(
  s: ReportedAgentSession | undefined,
): ReportedAgentSession | undefined {
  if (!s) return undefined;
  const out: ReportedAgentSession = {};
  for (const key of ["host", "session_id", "run_id"] as const) {
    const v = s[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim().slice(0, MAX_SESSION_FIELD_LEN);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Change control: structured change plan + auto Change Brief (IMPL-026B)
// ---------------------------------------------------------------------------
//
// For the four mandatory-change-control action types, /v1-evaluate requires a
// top-level `change_plan` ({ operation, revision and/or artifact_ref }) and,
// when a `change_brief_id` is also sent, requires the brief's stored
// execution plan to equal it exactly (atlasent-api
// _shared/mandatory-execution-binding.ts, v1-evaluate/handler.ts). A claim of
// an approved_awaiting_claim approval may present the plan again; if it
// differs from the recorded one the claim is refused with 409
// change_plan_mismatch (v1-approvals/handler.ts handleClaimTimeClaim).
//
// So this client: (1) creates a Change Brief recording EXACTLY the plan it is
// about to evaluate, (2) sends that plan and the brief id to evaluate, and
// (3) remembers the plan per approval id so the later claim presents the SAME
// plan. A mismatch then only happens when the agent's plan genuinely changed.

/** Mirrors atlasent-api MANDATORY_CHANGE_CONTROL_ACTION_TYPES. */
export const MANDATORY_CHANGE_CONTROL_ACTION_TYPES: ReadonlySet<string> = new Set([
  "production.deploy",
  "infrastructure.change",
  "production.rollback",
  "secret.configuration.change",
]);

export interface ChangePlan {
  operation: string;
  revision?: string;
  artifact_ref?: string;
}

/**
 * Validate and normalise a caller's change plan to the wire form v1-evaluate
 * binds (trimmed; empty optional fields omitted). Throws on anything else:
 * sending a plan the runtime would refuse is strictly worse than refusing
 * here. Accepts only the three plan fields — nothing is inferred.
 */
export function normalizeChangePlan(value: unknown): ChangePlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("change_plan must be an object { operation, revision?, artifact_ref? }");
  }
  const v = value as Record<string, unknown>;
  const extra = Object.keys(v).filter((k) => !["operation", "revision", "artifact_ref"].includes(k));
  if (extra.length > 0) throw new Error(`change_plan carries fields that are not part of a plan: ${extra.join(", ")}`);
  for (const f of ["operation", "revision", "artifact_ref"]) {
    if (v[f] !== undefined && typeof v[f] !== "string") throw new Error(`change_plan.${f} must be a string`);
  }
  const operation = typeof v.operation === "string" ? v.operation.trim() : "";
  const revision = typeof v.revision === "string" ? v.revision.trim() : "";
  const artifact_ref = typeof v.artifact_ref === "string" ? v.artifact_ref.trim() : "";
  if (!operation || (!revision && !artifact_ref)) {
    throw new Error("change_plan needs a non-empty operation and a revision or artifact_ref");
  }
  return { operation, ...(revision && { revision }), ...(artifact_ref && { artifact_ref }) };
}

function sameChangePlan(a: ChangePlan, b: ChangePlan): boolean {
  return a.operation === b.operation &&
    (a.revision ?? null) === (b.revision ?? null) &&
    (a.artifact_ref ?? null) === (b.artifact_ref ?? null);
}

function describeChangePlan(p: ChangePlan): string {
  return [p.operation, p.revision && `revision ${p.revision}`, p.artifact_ref && `artifact ${p.artifact_ref}`]
    .filter(Boolean)
    .join(", ");
}

/**
 * The digest v1-change-brief requires (`sha256:<64 lowercase hex>`). It is
 * this client's own commitment to the plan and its binding coordinates;
 * v1-evaluate compares it only against the brief it came from.
 */
function changeBriefPlanDigest(input: {
  action_type: string;
  target_id: string;
  environment: string;
  change_plan: ChangePlan;
}): string {
  const canonical = JSON.stringify({
    action_type: input.action_type,
    target_id: input.target_id,
    environment: input.environment,
    operation: input.change_plan.operation,
    revision: input.change_plan.revision ?? null,
    artifact_ref: input.change_plan.artifact_ref ?? null,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export interface ChangeBriefInput {
  action_type: string;
  actor_id?: string;
  target_id?: string;
  environment?: string;
  target_system?: string;
  change_plan: ChangePlan;
}

/** Placeholder used when the caller names no target system. Descriptive only. */
export const UNSPECIFIED_TARGET_SYSTEM = "unspecified";

/**
 * POST /v1-change-brief recording exactly `change_plan` as the brief's
 * execution plan. Returns the brief id, or a note when the brief cannot or
 * need not be created:
 *   - 404 (older runtime) or 403 (key lacks change_brief:read) → note, proceed
 *   - the brief's required binding fields are unknown here (actor_id,
 *     target_id, environment) → note, proceed: the brief must equal the
 *     evaluate request on those fields, and none is ever guessed
 * Every other failure (network, 5xx, 401, malformed body) THROWS: the caller
 * then does not evaluate (fail closed).
 */
export async function createChangeBriefForPlan(
  input: ChangeBriefInput,
): Promise<{ change_brief_id?: string; notes: string[] }> {
  const missing = (["actor_id", "target_id", "environment"] as const).filter((k) => !input[k]);
  if (missing.length > 0) {
    return {
      notes: [
        `No Change Brief was created: ${missing.join(", ")} not known to this server, and a brief must match ` +
          "the evaluate request on those fields. Evaluated with the change_plan alone.",
      ],
    };
  }
  const body = {
    action_type: input.action_type,
    target_system: input.target_system || UNSPECIFIED_TARGET_SYSTEM,
    target_id: input.target_id,
    environment: input.environment,
    actor_id: input.actor_id,
    canonical_plan_digest: changeBriefPlanDigest({
      action_type: input.action_type,
      target_id: input.target_id!,
      environment: input.environment!,
      change_plan: input.change_plan,
    }),
    execution_change_plan: input.change_plan,
  };
  const res = await fetch(`${baseUrl()}/v1-change-brief`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
    signal: makeAbortSignal(REQUEST_TIMEOUT_MS),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (res.status === 404) {
    return { notes: ["No Change Brief was created: this AtlaSent runtime has no v1-change-brief endpoint (HTTP 404)."] };
  }
  if (res.status === 403) {
    return { notes: ["No Change Brief was created: the API key lacks change_brief:read (HTTP 403)."] };
  }
  if (res.status !== 200 && res.status !== 201) {
    const code = typeof json?.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new Error(`Change Brief creation failed (${code}); the action was not evaluated.`);
  }
  const id = json?.change_brief_id;
  if (typeof id !== "string" || !id) {
    throw new Error("Change Brief creation returned no change_brief_id; the action was not evaluated.");
  }
  return { change_brief_id: id, notes: [] };
}

/** What a held request needs so its claim presents the same plan, and so a
 *  plan change can be re-requested as a linked request. Process-local. */
interface PendingChangeRequest {
  /** The evaluate body as sent, minus change_plan / change_brief_id / supersedes_approval_id. */
  evaluate_body: Record<string, unknown>;
  change_plan: ChangePlan;
  brief: Omit<ChangeBriefInput, "change_plan">;
}

const MAX_PENDING_CHANGE_REQUESTS = 256;
const pendingChangeRequests = new Map<string, PendingChangeRequest>();

function rememberPendingChangeRequest(approvalId: string, entry: PendingChangeRequest): void {
  pendingChangeRequests.delete(approvalId);
  pendingChangeRequests.set(approvalId, entry);
  while (pendingChangeRequests.size > MAX_PENDING_CHANGE_REQUESTS) {
    const oldest = pendingChangeRequests.keys().next().value;
    if (oldest === undefined) break;
    pendingChangeRequests.delete(oldest);
  }
}

/** The plan this server evaluated for a held approval, if it did. */
export function pendingChangePlanFor(approvalId: string): ChangePlan | undefined {
  return pendingChangeRequests.get(approvalId)?.change_plan;
}

export function _resetPendingChangeRequestsForTests(): void {
  pendingChangeRequests.clear();
}

/**
 * Attach the change plan (and, for a mandatory-change-control action, an
 * auto-created Change Brief recording exactly that plan) to an evaluate body.
 * Returns the notes to surface and a registration callback for a hold.
 * Throws (fail closed) on an invalid plan or a brief failure other than
 * 404/403.
 */
async function attachChangeControl(
  body: Record<string, unknown>,
  input: {
    action_type: string;
    actor_id?: string;
    target_id?: string;
    environment?: string;
    target_system?: string;
    change_plan?: unknown;
  },
): Promise<{ notes: string[]; remember: (approvalId: string | undefined) => void }> {
  const none = { notes: [], remember: () => {} };
  if (input.change_plan === undefined) return none;
  const plan = normalizeChangePlan(input.change_plan);
  const baseBody = { ...body };
  body.change_plan = plan;
  if (!MANDATORY_CHANGE_CONTROL_ACTION_TYPES.has(input.action_type)) return none;
  const briefInput = {
    action_type: input.action_type,
    ...(input.actor_id && { actor_id: input.actor_id }),
    ...(input.target_id && { target_id: input.target_id }),
    ...(input.environment && { environment: input.environment }),
    ...(input.target_system && { target_system: input.target_system }),
  };
  const brief = await createChangeBriefForPlan({ ...briefInput, change_plan: plan });
  if (brief.change_brief_id) body.change_brief_id = brief.change_brief_id;
  return {
    notes: brief.notes,
    remember: (approvalId) => {
      if (approvalId) {
        rememberPendingChangeRequest(approvalId, { evaluate_body: baseBody, change_plan: plan, brief: briefInput });
      }
    },
  };
}

interface EvaluateRequestBodyInput {
  action_type: string;
  /** Omit when the API key belongs to a registered agent: the runtime derives it. */
  actor_id?: string;
  agent_session?: ReportedAgentSession;
  context?: Record<string, unknown>;
  explain?: boolean;
  state_snapshot?: Record<string, unknown>;
  execution_payload_hash?: string;
  target_id?: string;
}

function buildEvaluateRequestBody(input: EvaluateRequestBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = { action_type: input.action_type };
  if (input.actor_id) body.actor_id = input.actor_id;
  const session = sanitizeAgentSession(input.agent_session);
  if (session) body.agent_session = session;
  // Must run BEFORE context is attached: it sets `resource_id` top-level and
  // returns the context to use, which may be created here when the caller
  // passed none. See applyTargetBinding.
  const boundContext = applyTargetBinding(body, input.context, input.target_id);
  if (boundContext !== undefined) body.context = boundContext;
  if (input.explain !== undefined) body.explain = input.explain;
  // state_snapshot is a top-level EvaluateBody field required when
  // requires_state_snapshot=true (all classes since backfill 20260603000019).
  body.state_snapshot = input.state_snapshot ?? { source: "atlasent-mcp", complete: true };
  // TOP-LEVEL, never inside `context` — the handler destructures this field
  // from `body` alongside `context`. See normalizePayloadHash.
  if (input.execution_payload_hash !== undefined) {
    body.execution_payload_hash = normalizePayloadHash(input.execution_payload_hash);
  }
  return body;
}

async function authorizeRemote(ctx: ActionContext): Promise<Decision> {
  const context: Record<string, unknown> = { environment: ctx.environment };
  if (ctx.approvals !== undefined) context.approvals = ctx.approvals;
  if (ctx.change_window !== undefined) context.change_window = ctx.change_window;
  if (ctx.tool_name !== undefined) context.tool_name = ctx.tool_name;
  if (ctx.tool !== undefined) context.tool = ctx.tool;

  const body = buildEvaluateRequestBody({
    action_type: ctx.action_type,
    actor_id: ctx.actor_id,
    agent_session: ctx.agent_session,
    context,
    state_snapshot: ctx.state_snapshot,
    // Bind the digest here, not only at verify. Presenting payload_hash at the
    // verify boundary against a permit that was never bound to it is a no-op:
    // the runtime refuses to trust an unbound caller-supplied digest.
    ...(ctx.payload_hash !== undefined ? { execution_payload_hash: ctx.payload_hash } : {}),
    // Bind the target too, for the same reason: a target presented at verify
    // against a permit never bound to one is not checked at all.
    ...(ctx.target_id !== undefined ? { target_id: ctx.target_id } : {}),
  });

  // Mandatory-change-control actions: top-level change_plan plus an
  // auto-created Change Brief recording exactly that plan. Throws (→ deny via
  // authorize()) on an invalid plan or a brief failure other than 404/403.
  const changeControl = await attachChangeControl(body, {
    action_type: ctx.action_type,
    actor_id: ctx.actor_id,
    target_id: ctx.target_id,
    environment: ctx.environment,
    target_system: ctx.target_system,
    change_plan: ctx.change_plan,
  });

  const data = await post<RawEvaluate>("/v1-evaluate", body);
  if (data.decision === "hold" || data.decision === "escalate") changeControl.remember(data.approval_request_id);
  const notes = changeControl.notes;

  // Normalise request_id → audit_id (canonical API contract uses request_id).
  const audit_id = data.request_id;
  const envelope_hash = data.envelope_hash;

  if (data.decision === "allow") {
    if (!data.permit_token) throw new Error("Remote allowed the action but returned no permit_token");
    const out: Decision = { decision: "allow", permit_token: data.permit_token };
    if (audit_id) out.audit_id = audit_id;
    if (envelope_hash) out.envelope_hash = envelope_hash;
    if (data.conditions?.length) out.conditions = data.conditions;
    if (notes.length) out.notes = notes;
    return out;
  }

  if (data.decision === "hold" || data.decision === "escalate") {
    const reasons =
      (data.deny_reason ? [data.deny_reason] : undefined) ??
      data.denial?.reasons ??
      data.reasons ??
      ["Held for human review"];
    const holdCode = data.deny_code ?? data.denial?.code;
    return {
      decision: "hold",
      reasons,
      ...(holdCode && { deny_code: holdCode }),
      ...(data.hold_id && { hold_id: data.hold_id }),
      ...(data.approval_request_id && { approval_request_id: data.approval_request_id }),
      ...(audit_id && { audit_id }),
      ...(envelope_hash && { envelope_hash }),
      ...(notes.length && { notes }),
    };
  }

  // Anything else (including "deny" or an unknown decision) is fail-closed.
  const reasons =
    (data.deny_reason ? [data.deny_reason] : undefined) ??
    data.denial?.reasons ??
    data.reasons ??
    [`Denied (decision=${data.decision})`];
  const deny_code = data.deny_code ?? data.denial?.code;
  const out: Decision = {
    decision: "deny",
    reasons,
    ...(deny_code && { deny_code }),
    // An insufficient-approvals denial is not a terminal refusal — a human can
    // approve (in the AtlaSent console; an agent never approves its own
    // action). Flag it so the host routes to a person instead of giving up.
    // The action still does not run now (fail-closed preserved). INSUFFICIENT_APPROVALS is the frozen
    // deny code the per-class human-in-the-loop gate emits.
    ...(deny_code === "INSUFFICIENT_APPROVALS" && { requires_human_approval: true }),
    ...(audit_id && { audit_id }),
    ...(envelope_hash && { envelope_hash }),
    ...(notes.length && { notes }),
  };
  return out;
}

// Canonical verify-permit response shape (v1-verify-permit/handler.ts):
//   { valid: boolean, outcome: "allow"|"deny",
//     verify_error_code?: string, reasons?: string[] }
interface RawVerify {
  valid: boolean;
  outcome: "allow" | "deny";
  verify_error_code?: string;
  reasons?: string[];
}

async function verifyRemote(token: string, ctx: ActionContext): Promise<VerifyResult> {
  // Present the full binding set at the verify boundary. Under-specified
  // verification is a bypass vector: without `environment` a permit bound to
  // production verifies against staging (ENVIRONMENT_MISMATCH never fires), and
  // without `payload_hash` an altered tool call verifies against the original
  // (PAYLOAD_MISMATCH never fires). The v1-verify-permit handler reads these
  // top-level fields (see its request parsing); they are additive — omitted
  // fields simply skip that binding check.
  const body: Record<string, unknown> = {
    permit_token: token,
    action_type: ctx.action_type,
    actor_id: ctx.actor_id,
    environment: ctx.environment,
    ...(ctx.target_id ? { target_id: ctx.target_id } : {}),
    ...(ctx.payload_hash ? { payload_hash: normalizePayloadHash(ctx.payload_hash) } : {}),
  };

  const data = await post<RawVerify>("/v1-verify-permit", body);

  // Map the canonical "allow"|"deny" outcome to the internal VerifyResult
  // outcome vocabulary used across both local and remote paths.
  // verify_error_code refines the deny outcome: PERMIT_EXPIRED → "expired",
  // RATE_LIMITED → "error", everything else → "invalid".
  let outcome: VerifyResult["outcome"];
  if (data.outcome === "allow") {
    outcome = "verified";
  } else {
    switch (data.verify_error_code) {
      case "PERMIT_EXPIRED":
        outcome = "expired";
        break;
      case "RATE_LIMITED":
        outcome = "error";
        break;
      default:
        outcome = "invalid";
    }
  }

  return {
    outcome,
    valid: data.valid === true,
    ...(data.reasons?.length && { reasons: data.reasons }),
    ...(data.verify_error_code && { verify_error_code: data.verify_error_code }),
  };
}

// ---------------------------------------------------------------------------
// New standalone API calls (atlasent_evaluate, list_policies, get_policy,
// list_audit_events) — these speak to /v1/* REST endpoints and return the
// raw API response; no local-engine fallback (they require remote mode).
// ---------------------------------------------------------------------------

export interface RiskEnvelopeFactor {
  score: number;
  weight: number;
  contribution: number;
}

export interface RiskEnvelope {
  weighted_score: number;
  engine_decision: string;
  envelope_decision: string;
  promoted: boolean;
  hard_blocks: string[];
  factors?: Record<string, RiskEnvelopeFactor>;
}

export interface EvaluateParams {
  /** Optional: with an agent-bound key the runtime identifies the agent. */
  actor_id?: string;
  agent_session?: ReportedAgentSession;
  action_type: string;
  context?: Record<string, unknown>;
  explain?: boolean;
  state_snapshot?: Record<string, unknown>;
  execution_payload_hash?: string;
  target_id?: string;
  /** See ActionContext.change_plan. */
  change_plan?: ChangePlan;
  target_system?: string;
}

// EvaluateResponse is the RAW /v1-evaluate response returned verbatim by the
// atlasent_evaluate tool (evaluateAction). It extends the shared RawEvaluate
// shape (the common raw evaluate fields — decision/permit_token/reasons/etc.)
// so both call paths reference ONE raw-response type, and adds the distinct
// fields this raw path exposes and the canonical enforcement path drops:
// evaluation_id, risk_envelope, and an index signature for explain-driven and
// forward-compatible fields. This is a typing-only unification — the runtime
// object is the untouched API response, so no exposed field changes.
export interface EvaluateResponse extends RawEvaluate {
  evaluation_id?: string;
  risk_envelope?: RiskEnvelope;
  [key: string]: unknown;
}

export async function evaluateAction(params: EvaluateParams): Promise<EvaluateResponse> {
  const body = buildEvaluateRequestBody({
    action_type: params.action_type,
    actor_id: params.actor_id,
    agent_session: params.agent_session,
    context: params.context,
    explain: params.explain,
    state_snapshot: params.state_snapshot,
    ...(params.execution_payload_hash !== undefined
      ? { execution_payload_hash: params.execution_payload_hash }
      : {}),
    ...(params.target_id !== undefined ? { target_id: params.target_id } : {}),
  });
  const env = params.context?.environment;
  const changeControl = await attachChangeControl(body, {
    action_type: params.action_type,
    actor_id: params.actor_id,
    target_id: params.target_id,
    environment: typeof env === "string" ? env : undefined,
    target_system: params.target_system,
    change_plan: params.change_plan,
  });
  const res = await post<EvaluateResponse>("/v1-evaluate", body);
  if (res.decision === "hold" || res.decision === "escalate") changeControl.remember(res.approval_request_id);
  if (changeControl.notes.length) {
    const prior = Array.isArray(res.notes) ? (res.notes as unknown[]) : [];
    return { ...res, notes: [...prior, ...changeControl.notes] };
  }
  return res;
}

export interface ListPoliciesParams {
  org_id: string;
  status?: string;
}

export async function listPolicies(params: ListPoliciesParams): Promise<unknown> {
  return get("/v1/policies", {
    org_id: params.org_id,
    status: params.status,
  });
}

export interface GetPolicyParams {
  policy_id: string;
  org_id: string;
}

export async function getPolicy(params: GetPolicyParams): Promise<unknown> {
  return get(`/v1/policies/${encodeURIComponent(params.policy_id)}`, {
    org_id: params.org_id,
  });
}

export interface ListAuditEventsParams {
  org_id: string;
  evaluation_id?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function listAuditEvents(params: ListAuditEventsParams): Promise<unknown> {
  return get("/v1/audit/events", {
    org_id: params.org_id,
    evaluation_id: params.evaluation_id,
    from: params.from,
    to: params.to,
    limit: params.limit !== undefined ? String(params.limit) : undefined,
  });
}

export interface CreatePolicyParams {
  org_id: string;
  policy_id: string;
  title: string;
  policy_type: string;
  rules: unknown[];
  description?: string;
  version?: string;
  priority?: number;
  applies_to?: Record<string, unknown>;
  actions?: Record<string, unknown>;
  effective_at?: string;
  expires_at?: string;
}

export async function createPolicy(params: CreatePolicyParams): Promise<unknown> {
  return post("/v1/policies", params);
}

export interface UpdatePolicyParams {
  policy_id: string;
  org_id: string;
  title?: string;
  description?: string;
  policy_type?: string;
  rules?: unknown[];
  version?: string;
  priority?: number;
  applies_to?: Record<string, unknown>;
  actions?: Record<string, unknown>;
  status?: string;
  effective_at?: string;
  expires_at?: string;
}

export async function updatePolicy(params: UpdatePolicyParams): Promise<unknown> {
  const { policy_id, ...patchBody } = params;
  return patch(`/v1/policies/${encodeURIComponent(policy_id)}`, patchBody);
}

export interface RevokePermitParams {
  permitToken: string;
  org_id: string;
  reasons?: string[];
}

export async function revokePermit(params: RevokePermitParams): Promise<unknown> {
  return post(`/v1/permits/${encodeURIComponent(params.permitToken)}/revoke`, {
    org_id: params.org_id,
    ...(params.reasons !== undefined ? { reasons: params.reasons } : {}),
  });
}

export interface ListPermitsParams {
  org_id: string;
  status?: string;
  actor_id?: string;
  action_type?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export async function listPermits(params: ListPermitsParams): Promise<unknown> {
  return redactPermitSecrets(await get("/v1/permits", {
    org_id: params.org_id,
    status: params.status,
    actor_id: params.actor_id,
    action_type: params.action_type,
    from: params.from,
    to: params.to,
    limit: params.limit !== undefined ? String(params.limit) : undefined,
    cursor: params.cursor,
  }));
}

// A permit's `token` is its bearer credential and `signature` its signing
// material. Neither belongs in an agent's context window: anything a tool
// returns is visible to the model, its transcript and any logging around it,
// and a token there can be presented as the permit. atlasent-api#3638 stops
// v1-permits returning them; this strips them again client-side so an older
// or misconfigured backend cannot leak them through these tools.
export const PERMIT_SECRET_FIELDS = ["token", "signature"] as const;

export function redactPermitSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactPermitSecrets(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((PERMIT_SECRET_FIELDS as readonly string[]).includes(k)) continue;
      out[k] = redactPermitSecrets(v);
    }
    return out as T;
  }
  return value;
}

export async function getPermit(permitId: string): Promise<unknown> {
  return redactPermitSecrets(await get(`/v1/permits/${encodeURIComponent(permitId)}`));
}

// GET /v1/permits/:id/valid — the runtime's lightweight revocation heartbeat.
// Answers 200 `{ valid, status: active|revoked|consumed|expired, revoked_at? }`
// even for an expired permit, so a caller can tell expiry from revocation.
export async function checkPermit(permitId: string): Promise<unknown> {
  return redactPermitSecrets(await get(`/v1/permits/${encodeURIComponent(permitId)}/valid`));
}

// GET /v1/execution-evaluations/:id (scope audit:read). `include_trace` adds
// the approval events, permit uses and webhook deliveries for the decision.
export async function getDecision(evaluationId: string, includeTrace?: boolean): Promise<unknown> {
  return get(`/v1/execution-evaluations/${encodeURIComponent(evaluationId)}`, {
    include: includeTrace ? "trace" : undefined,
  });
}

// ---------------------------------------------------------------------------
// Permit issuance + v1 verification
// ---------------------------------------------------------------------------

export interface IssuePermitParams {
  subject: string;
  action: string;
  resource: string;
  org_id: string;
  ttl_seconds?: number;
  context?: Record<string, unknown>;
}

export async function issuePermit(params: IssuePermitParams): Promise<unknown> {
  const body: Record<string, unknown> = {
    subject: params.subject,
    action: params.action,
    resource: params.resource,
    org_id: params.org_id,
  };
  if (params.ttl_seconds !== undefined) body.ttl_seconds = params.ttl_seconds;
  if (params.context !== undefined) body.context = params.context;
  return post("/v1/permits/issue", body);
}

export interface VerifyPermitV1Params {
  permit_token: string;
  org_id: string;
  action?: string;
  resource?: string;
}

export async function verifyPermitV1(params: VerifyPermitV1Params): Promise<unknown> {
  const body: Record<string, unknown> = {
    permit_token: params.permit_token,
    org_id: params.org_id,
  };
  if (params.action !== undefined) body.action = params.action;
  if (params.resource !== undefined) body.resource = params.resource;
  return post("/v1/permits/verify", body);
}

// ---------------------------------------------------------------------------
// Waiting for a human approval (CROSS-056)
// ---------------------------------------------------------------------------
//
// A held evaluation carries approval_request_id. A PERSON decides it in the
// AtlaSent console; this code can only wait for that decision and, on
// approval, claim the one permit the runtime minted for it. It cannot
// approve anything. Same protocol as atlasent-action's
// waitForApprovalResolution (packages/enforce):
//   GET  /v1/approvals/{id}              status poll; never carries a token
//   POST /v1/approvals/{id}/claim-permit one-time atomic claim on "approved"
// Fail-closed throughout: any terminal status other than "approved", an
// "approved" with no claimable permit, an auth/not-found error, or running
// out of time all mean NO permit.

export interface AwaitApprovalParams {
  approval_request_id: string;
  /** Upper bound on the wait. Exceeding it returns outcome "timeout". */
  max_wait_ms: number;
  /** Poll interval; tests shorten it. */
  poll_interval_ms?: number;
  /**
   * The agent's CURRENT change plan, presented at claim. Defaults to the plan
   * this server evaluated for the held request, so an unchanged plan never
   * mismatches. Only mandatory-change-control actions carry one.
   */
  change_plan?: ChangePlan;
  /**
   * What to do when the claim reports change_plan_mismatch (the presented
   * plan differs from the approved one):
   *  - "rerequest" (default): file ONE linked re-request for the presented
   *    plan (supersedes_approval_id = this approval) and wait on it.
   *  - "use_approved": claim again without a plan so the APPROVED plan runs,
   *    and return that plan so the agent executes exactly it.
   */
  on_plan_mismatch?: "rerequest" | "use_approved";
}

/** What a refused plan variance looked like, as the runtime reported it. */
export interface PlanMismatchReport {
  approval_request_id: string;
  from?: ChangePlan;
  to?: ChangePlan;
  diff?: unknown;
  variance_class?: string;
  mismatch_count?: number;
  recorded_change_plan_hash?: string;
  presented_change_plan_hash?: string;
  reconciliation?: unknown;
}

export type AwaitApprovalResult =
  | {
      outcome: "approved";
      permit_token: string;
      /** The approval (or re-request) whose permit this is. */
      approval_request_id: string;
      notes?: string[];
      /** The plan the permit is bound to. Execute exactly this plan. */
      approved_plan?: ChangePlan;
      /** Set when a plan change moved the wait to a linked re-request. */
      original_approval_request_id?: string;
      /** One line per step, e.g. plan changed → re-request sent → waiting → approved. */
      progression?: string[];
      plan_mismatch?: PlanMismatchReport;
    }
  | {
      outcome: "not_approved" | "timeout";
      approval_request_id: string;
      status?: string;
      re_evaluation_decision?: string;
      reasons: string[];
      notes?: string[];
      original_approval_request_id?: string;
      progression?: string[];
      plan_mismatch?: PlanMismatchReport;
    };

/** IMPL-026B: an approval for a verified-actor class is resolved to this
 *  status; its permit exists only after a claim that presents the ACTION
 *  actor's actor_identity triggers the claim-time re-evaluation. */
export const APPROVED_AWAITING_CLAIM = "approved_awaiting_claim";

// ---------------------------------------------------------------------------
// Agent actor identity (key-bound agent; atlasent-api v1-agent-actor-identity)
// ---------------------------------------------------------------------------
//
// An agent-bound API key can mint a short-lived actor_identity.v1 for ITS OWN
// agent. The runtime derives the subject, role ("agent") and tenant from the
// key; this client sends only the binding coordinates. The assertion is
// opaque here: the runtime verifies the signature at claim time.

export type AgentActorIdentityMint =
  | { ok: true; actor_identity: Record<string, unknown> }
  /** The runtime has no mint endpoint (HTTP 404): an older deployment. */
  | { ok: false; unsupported: true; reason: string }
  | { ok: false; unsupported: false; reason: string };

export async function mintAgentActorIdentity(
  action_type: string,
  environment: string,
): Promise<AgentActorIdentityMint> {
  const fail = (reason: string): AgentActorIdentityMint => ({ ok: false, unsupported: false, reason });
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/v1-agent-actor-identity`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({ action_type, environment }),
      signal: makeAbortSignal(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return fail(`network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (res.status === 404) {
    return { ok: false, unsupported: true, reason: "this AtlaSent runtime has no agent identity endpoint (HTTP 404)" };
  }
  if (res.status !== 200) {
    const code = typeof json?.error === "string" ? json.error : `HTTP ${res.status}`;
    return fail(code);
  }
  // Sanity only (the signature is checked server-side): refuse anything that
  // is not an agent assertion for exactly the binding we asked for.
  const a = json?.assertion as Record<string, unknown> | undefined;
  const subject = a?.subject as Record<string, unknown> | undefined;
  const binding = a?.binding as Record<string, unknown> | undefined;
  if (
    !a || typeof a !== "object" || a.version !== "actor_identity.v1" ||
    subject?.principal_kind !== "agent" ||
    binding?.action_type !== action_type || binding?.environment !== environment ||
    typeof a.signature !== "string"
  ) {
    return fail("malformed actor identity response");
  }
  return { ok: true, actor_identity: a };
}

const APPROVAL_POLL_INTERVAL_MS = 5_000;

async function rawRequest(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${resolveBase(path)}${path}`, {
    method,
    headers: buildHeaders(),
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: makeAbortSignal(REQUEST_TIMEOUT_MS),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** Runtime refusals that mean the presented plan is not the approved one. */
const PLAN_MISMATCH = "change_plan_mismatch";
const PLAN_REVOKED = "approval_revoked_suspicious_plan_variance";

/**
 * The approved (recorded) plan, rebuilt from the plan we presented and the
 * runtime's field-level diff ({ field, recorded, presented }). Undefined when
 * the diff is not usable: then the approved plan is unknown and nothing is
 * claimed on its behalf.
 */
function recordedPlanFromDiff(presented: ChangePlan | undefined, diff: unknown): ChangePlan | undefined {
  if (!presented || !Array.isArray(diff) || diff.length === 0) return undefined;
  const out: Record<string, unknown> = { ...presented };
  for (const d of diff) {
    if (!d || typeof d !== "object") return undefined;
    const { field, recorded, presented: was } = d as Record<string, unknown>;
    if (field !== "operation" && field !== "revision" && field !== "artifact_ref") return undefined;
    // The diff must describe the plan we actually presented.
    if ((presented[field] ?? null) !== (was ?? null)) return undefined;
    if (recorded === null || recorded === undefined) delete out[field];
    else if (typeof recorded === "string") out[field] = recorded;
    else return undefined;
  }
  try {
    return normalizeChangePlan(out);
  } catch {
    return undefined;
  }
}

/** Runtime policy flags (advisory): absent means true. The 409 body wins over the status row. */
function policyFlag(
  name: "auto_rerequest_on_mismatch" | "auto_change_brief",
  ...sources: Array<Record<string, unknown> | null | undefined>
): boolean {
  for (const src of sources) {
    const v = src?.[name];
    if (typeof v === "boolean") return v;
  }
  return true;
}

export async function awaitApproval(params: AwaitApprovalParams): Promise<AwaitApprovalResult> {
  const originalId = params.approval_request_id;
  let id = originalId;
  const interval = params.poll_interval_ms ?? APPROVAL_POLL_INTERVAL_MS;
  const deadline = Date.now() + params.max_wait_ms;
  const onMismatch = params.on_plan_mismatch ?? "rerequest";
  const progression: string[] = [];
  const notes: string[] = [];
  let planMismatch: PlanMismatchReport | undefined;
  // At most ONE automatic re-request per call, and at most one fall-back to
  // the approved plan. Both are latched: a second mismatch stops.
  let rerequested = false;
  let approvedPlanFallback: ChangePlan | undefined;

  const trail = () => ({
    ...(id !== originalId && { original_approval_request_id: originalId }),
    ...(progression.length > 0 && { progression: [...progression] }),
    ...(planMismatch && { plan_mismatch: planMismatch }),
  });
  const notApproved = (reasons: string[], status?: string): AwaitApprovalResult => ({
    outcome: "not_approved",
    approval_request_id: id,
    ...(status && { status }),
    reasons,
    ...(notes.length > 0 && { notes: [...notes] }),
    ...trail(),
  });
  const sleep = () => new Promise((r) => setTimeout(r, interval));

  let presented: ChangePlan | undefined;
  try {
    presented = params.change_plan !== undefined ? normalizeChangePlan(params.change_plan) : pendingChangePlanFor(id);
  } catch (e) {
    return notApproved([`The presented change_plan is not valid (${e instanceof Error ? e.message : String(e)}); nothing was claimed.`]);
  }

  while (Date.now() < deadline) {
    const pathId = encodeURIComponent(id);
    let polled: { status: number; json: Record<string, unknown> | null };
    try {
      polled = await rawRequest("GET", `/v1/approvals/${pathId}`);
    } catch {
      // Transient network failure: retry within the bounded window.
      await sleep();
      continue;
    }
    if (polled.status === 401 || polled.status === 403) {
      return notApproved([
        `Approval status check was refused (HTTP ${polled.status}). The API key needs approvals:read.`,
      ]);
    }
    if (polled.status === 404) return notApproved(["Approval request not found."]);

    const rowStatus = typeof polled.json?.status === "string" ? polled.json.status : undefined;
    if (polled.status === 200 && rowStatus && rowStatus !== "pending") {
      if (rowStatus !== "approved" && rowStatus !== APPROVED_AWAITING_CLAIM) {
        return notApproved([`A person did not approve this action (status: ${rowStatus}).`], rowStatus);
      }
      // "approved": the permit was minted at resolve; claim it with an empty
      // body exactly as before. "approved_awaiting_claim" (IMPL-026B): the
      // permit is minted only by a claim that presents the action actor's
      // actor_identity, so obtain a fresh one for THIS held action first.
      // The binding comes from the server's own approval row, never from the
      // agent. No identity -> no claim.
      let claimBody: Record<string, unknown> = {};
      let claimNote: string | undefined;
      const actionType = typeof polled.json?.action_type === "string" ? polled.json.action_type : "";
      if (rowStatus === APPROVED_AWAITING_CLAIM) {
        const environment = typeof polled.json?.environment === "string" ? polled.json.environment : "";
        if (!actionType) {
          return notApproved(
            ["Approved, but the approval record has no action_type to bind an agent identity to; the permit was not claimed."],
            rowStatus,
          );
        }
        const minted = await mintAgentActorIdentity(actionType, environment);
        if (minted.ok) {
          claimBody = { actor_identity: minted.actor_identity };
          // Present the plan so the runtime can refuse a changed one before
          // anything is evaluated (it always EXECUTES the recorded plan). Not
          // after falling back to the approved plan: that claim omits it.
          if (presented && !approvedPlanFallback && MANDATORY_CHANGE_CONTROL_ACTION_TYPES.has(actionType)) {
            claimBody.change_plan = presented;
          }
        } else if (minted.unsupported) {
          // Older runtime: claim as before and say so. The runtime decides;
          // a claim that needed an identity is refused there, not here.
          claimNote = `Claimed without an agent identity: ${minted.reason}.`;
        } else {
          return notApproved(
            [`Approved, but an agent identity could not be obtained (${minted.reason}); the permit was not claimed.`],
            rowStatus,
          );
        }
      }
      // Claim exactly once per pass. Anything but a genuine claim (lost race,
      // re-evaluation minted nothing, error) is no permit.
      let claimed: { status: number; json: Record<string, unknown> | null };
      try {
        claimed = await rawRequest("POST", `/v1/approvals/${pathId}/claim-permit`, claimBody);
      } catch {
        return notApproved(["Approved, but the permit could not be claimed (network error)."], rowStatus);
      }
      const token = claimed.json?.permit_token;
      if (claimed.status === 200 && claimed.json?.claimed === true && typeof token === "string" && token) {
        const approvedPlan = approvedPlanFallback ?? (claimBody.change_plan ? presented : undefined);
        if (progression.length > 0) progression.push(`approved; permit claimed for approval ${id}`);
        const allNotes = [...notes, ...(claimNote ? [claimNote] : [])];
        return {
          outcome: "approved",
          permit_token: token,
          approval_request_id: id,
          ...(allNotes.length > 0 && { notes: allNotes }),
          ...(approvedPlan && { approved_plan: approvedPlan }),
          ...trail(),
        };
      }
      const code = typeof claimed.json?.deny_code === "string"
        ? claimed.json.deny_code
        : typeof claimed.json?.error === "string"
        ? claimed.json.error
        : undefined;

      // ── IMPL-026B decision 5: the presented plan is not the approved one ──
      if (claimed.status === 409 && (code === PLAN_MISMATCH || code === PLAN_REVOKED)) {
        const j = claimed.json ?? {};
        const recorded = recordedPlanFromDiff(presented, j.diff);
        planMismatch = {
          approval_request_id: id,
          ...(recorded && { from: recorded }),
          ...(presented && { to: presented }),
          ...(j.diff !== undefined && { diff: j.diff }),
          ...(typeof j.variance_class === "string" && { variance_class: j.variance_class }),
          ...(typeof j.mismatch_count === "number" && { mismatch_count: j.mismatch_count }),
          ...(typeof j.recorded_change_plan_hash === "string" && { recorded_change_plan_hash: j.recorded_change_plan_hash }),
          ...(typeof j.presented_change_plan_hash === "string" && { presented_change_plan_hash: j.presented_change_plan_hash }),
          ...(j.reconciliation !== undefined && { reconciliation: j.reconciliation }),
        };
        const change = `plan changed from ${recorded ? describeChangePlan(recorded) : "the approved plan"} to ${presented ? describeChangePlan(presented) : "the presented plan"}`;
        const revoked = code === PLAN_REVOKED || j.approval_status === "revoked" || j.variance_class === "suspicious";
        if (revoked) {
          progression.push(`${change} → approval ${id} revoked as suspicious`);
          return notApproved(
            [
              `The presented change plan differs from the approved one and the runtime REVOKED approval ${id} ` +
                `as a suspicious plan variance (${code}). No permit; nothing was re-requested. A person must review.`,
            ],
            "revoked",
          );
        }
        if (onMismatch === "use_approved") {
          if (approvedPlanFallback || !recorded) {
            progression.push(`${change} → the approved plan could not be used`);
            return notApproved(
              [
                recorded
                  ? "The plan still did not match after falling back to the approved plan; stopping."
                  : "The approved plan could not be determined from the runtime's diff, so it was not claimed on the agent's behalf.",
              ],
              rowStatus,
            );
          }
          approvedPlanFallback = recorded;
          progression.push(`${change} → using the approved plan (${describeChangePlan(recorded)})`);
          continue; // re-poll, then claim WITHOUT a plan: the recorded plan runs.
        }
        if (rerequested) {
          progression.push(`${change} → second plan mismatch; no further re-request`);
          return notApproved(
            [
              "The plan changed again after the automatic re-request. Only one automatic re-request is made per call; " +
                "no permit. Re-evaluate with the plan you intend to run.",
            ],
            rowStatus,
          );
        }
        if (!policyFlag("auto_rerequest_on_mismatch", j, polled.json)) {
          progression.push(`${change} → automatic re-request disabled by policy`);
          return notApproved(
            [
              "The presented change plan differs from the approved one, and this organization's policy turns off the " +
                "automatic re-request (auto_rerequest_on_mismatch=false). Either wait again with " +
                "on_plan_mismatch=\"use_approved\" to run the approved plan, or re-evaluate the new plan with " +
                `supersedes_approval_id=${id} so a person can approve it.`,
            ],
            rowStatus,
          );
        }
        const pending = pendingChangeRequests.get(id);
        if (!pending || !presented) {
          progression.push(`${change} → cannot re-request from this server`);
          return notApproved(
            [
              "The presented change plan differs from the approved one, but this server did not evaluate the original " +
                "request, so it cannot file a linked re-request. Re-evaluate the new plan with " +
                `supersedes_approval_id=${id}, or wait again with on_plan_mismatch="use_approved".`,
            ],
            rowStatus,
          );
        }

        // ONE linked re-request: same request, the agent's current plan, a
        // fresh brief recording it, and the link to the prior approval.
        rerequested = true;
        const body: Record<string, unknown> = { ...pending.evaluate_body, change_plan: presented };
        if (MANDATORY_CHANGE_CONTROL_ACTION_TYPES.has(actionType) && policyFlag("auto_change_brief", j, polled.json)) {
          try {
            const brief = await createChangeBriefForPlan({ ...pending.brief, change_plan: presented });
            if (brief.change_brief_id) body.change_brief_id = brief.change_brief_id;
            notes.push(...brief.notes);
          } catch (e) {
            progression.push(`${change} → re-request not sent (Change Brief failed)`);
            return notApproved([e instanceof Error ? e.message : String(e)], rowStatus);
          }
        }
        body.supersedes_approval_id = id;
        let evaluated: { status: number; json: Record<string, unknown> | null };
        try {
          evaluated = await rawRequest("POST", "/v1-evaluate", body);
        } catch {
          progression.push(`${change} → re-request failed (network error)`);
          return notApproved(["The automatic re-request could not be sent (network error); no permit."], rowStatus);
        }
        const ev = evaluated.json ?? {};
        const decision = typeof ev.decision === "string" ? ev.decision : "";
        const link = ev.supersedes_approval as Record<string, unknown> | undefined;
        if (link && link.accepted === false) {
          notes.push(`The re-request was not linked to approval ${id}: ${String(link.reason ?? "no reason given")}.`);
        }
        if (evaluated.status !== 200) {
          progression.push(`${change} → re-request refused (HTTP ${evaluated.status})`);
          return notApproved([`The automatic re-request was refused (HTTP ${evaluated.status}); no permit.`], rowStatus);
        }
        if (decision === "allow") {
          const permit = ev.permit_token;
          if (typeof permit !== "string" || !permit) {
            progression.push(`${change} → re-request allowed but returned no permit`);
            return notApproved(["The re-request was allowed but returned no permit_token; no permit."], rowStatus);
          }
          progression.push(`${change} → re-request allowed without a new approval`);
          return {
            outcome: "approved",
            permit_token: permit,
            approval_request_id: id,
            ...(notes.length > 0 && { notes: [...notes] }),
            approved_plan: presented,
            ...trail(),
          };
        }
        const newId = typeof ev.approval_request_id === "string" ? ev.approval_request_id : "";
        if ((decision === "hold" || decision === "escalate") && newId) {
          rememberPendingChangeRequest(newId, { ...pending, change_plan: presented });
          progression.push(`${change} → re-request sent (approval ${newId}) → waiting`);
          id = newId;
          continue; // poll the new approval right away; pending → the normal interval.
        }
        const reason = typeof ev.deny_reason === "string" ? ev.deny_reason : typeof ev.deny_code === "string" ? ev.deny_code : `decision=${decision || "none"}`;
        progression.push(`${change} → re-request not approved (${decision || "no decision"})`);
        return notApproved([`The automatic re-request was not allowed (${reason}); no permit.`], rowStatus);
      }

      if (claimed.status === 409 && rowStatus === APPROVED_AWAITING_CLAIM) {
        // IMPL-026B claim_in_progress (and other transient lease conflicts):
        // another claim holds the lease. Wait and re-poll; the next pass
        // mints a fresh identity. Bounded by the deadline.
        await sleep();
        continue;
      }
      const reevalDecision = typeof claimed.json?.re_evaluation_decision === "string"
        ? claimed.json.re_evaluation_decision
        : undefined;
      return {
        ...notApproved(
          [
            "Approved, but no permit was available to claim (already claimed, or the re-check did not allow)." +
              (code ? ` Runtime said: ${code}.` : ""),
            ...(claimNote ? [claimNote] : []),
          ],
          rowStatus,
        ),
        ...(reevalDecision && { re_evaluation_decision: reevalDecision }),
      } as AwaitApprovalResult;
    }
    // pending, 5xx, rate limit or malformed: keep waiting until the deadline.
    await sleep();
  }

  return {
    outcome: "timeout",
    approval_request_id: id,
    reasons: ["No decision from a person within the wait time. The action must not run."],
    ...(notes.length > 0 && { notes: [...notes] }),
    ...trail(),
  };
}

// ---------------------------------------------------------------------------
// Policy deletion
// ---------------------------------------------------------------------------

export interface DeletePolicyParams {
  policy_id: string;
  org_id: string;
}

async function del<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  let url = `${resolveBase(path)}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
      .join("&");
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    method: "DELETE",
    headers: buildHeaders(),
    signal: makeAbortSignal(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    handleHttpError(res.status, text);
  }
  // DELETE responses may have no body (204 No Content) or a JSON body
  const text = await res.text().catch(() => "");
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export async function deletePolicy(params: DeletePolicyParams): Promise<unknown> {
  return del(`/v1/policies/${encodeURIComponent(params.policy_id)}`, {
    org_id: params.org_id,
  });
}

// ---------------------------------------------------------------------------
// Authority intelligence (read-only OAG-1 authority-lineage explanation)
//
// Path form: `/v1-<function>/<sub-route>` (the same shape as integrityAudit
// below), NOT the `/v1/<resource>` shape used by the generic REST readers.
// This was a real, confirmed bug: the handler routes by stripping
// `^/v1-authority-intelligence/?` off the pathname and then matching the
// first remaining segment against 'explain-authority'. The original slash
// form left 'v1' as the first segment and fell through to the handler's
// 404 on every real call. Do not "normalise" this path to match its
// siblings in this file.
// ---------------------------------------------------------------------------

export interface ExplainAuthorityParams {
  principal_id: string;
  requested_scope: string;
  resource_id?: string;
}

export async function explainAuthority(params: ExplainAuthorityParams): Promise<unknown> {
  return get("/v1-authority-intelligence/explain-authority", {
    principal_id: params.principal_id,
    requested_scope: params.requested_scope,
    resource_id: params.resource_id,
  });
}

// ---------------------------------------------------------------------------
// Authority Graph Integrity / Consistency Auditor (read-only)
//
// GET /v1-authority-intelligence/integrity-audit — the fourth sub-route of
// the v1-authority-intelligence edge function. Read-only: no authorize() /
// verify() routing, same as explainAuthority above.
//
// Path form: this uses the `/v1-<function>/<sub-route>` shape (the same shape
// as the proven-in-production `/v1-evaluate` and `/v1-verify-permit` calls at
// the top of this file), NOT the `/v1/<resource>` shape used by the generic
// REST readers. That is deliberate and load-bearing here: the handler routes
// by stripping `^/v1-authority-intelligence/?` off the pathname and then
// matching the first remaining segment against 'integrity-audit'. A request
// arriving as `/v1/authority-intelligence/integrity-audit` leaves 'v1' as the
// first segment and falls through to the handler's 404. Do not "normalise"
// this path to match its siblings in this file.
//
// The organization is derived server-side from the API key — there is
// deliberately no client-supplied org parameter on this route, so none is
// accepted here.
// ---------------------------------------------------------------------------

/**
 * A single integrity finding.
 *
 * `classification` is a THREE-WAY distinction, not a pass/fail flag:
 *   - `defect`           — a genuine inconsistency in the authority graph.
 *   - `non_exercisable`  — frequently the CORRECT, healthy state (e.g. an
 *                          expired grant that is supposed to be expired).
 *                          It is not a failure and must not be counted as one.
 *   - `unresolved`       — the proposition could NOT be verified. It must
 *                          never be treated as clean; "could not check" and
 *                          "checked and found nothing" are different facts.
 */
export type IntegrityClassification = "defect" | "non_exercisable" | "unresolved";

export type IntegritySeverity = "critical" | "high" | "medium" | "low" | "info";

export interface IntegrityFinding {
  finding_type: string;
  classification: IntegrityClassification;
  severity: IntegritySeverity;
  subject_id: string | null;
  source_table: string | null;
  source_id: string | null;
  related_source_ids: string[];
  effective_at: string | null;
  evidence_posture: "observed" | "derived";
  reason: string;
}

/**
 * The audit report as returned on the wire.
 *
 * These types are a COMPILE-TIME transcription of the documented response
 * shape, not a runtime validation of it — the object handed back is the
 * untouched API response, exactly as with EvaluateResponse above. Nothing in
 * this module derives a verdict from it.
 */
export interface IntegrityReport {
  schema_version: string;
  query: string;
  organization_id: string;
  evaluated_at: string;
  produced_by: string[];
  summary: Record<string, unknown>;
  findings: IntegrityFinding[];
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

export interface IntegrityAuditParams {
  /**
   * How far back the decision/permit scan reaches, in days (1–3650).
   * Optional and deliberately un-defaulted client-side: when the caller
   * omits it the parameter is left off the query string entirely so the
   * server applies its own window, which it echoes back in
   * `summary.audited_scope`. Inventing a default here would silently
   * narrow (or widen) an audit the caller never asked to bound.
   */
  decision_window_days?: number;
}

export async function integrityAudit(
  params: IntegrityAuditParams = {},
): Promise<IntegrityReport> {
  return get<IntegrityReport>("/v1-authority-intelligence/integrity-audit", {
    decision_window_days:
      params.decision_window_days !== undefined
        ? String(params.decision_window_days)
        : undefined,
  });
}

// ---------------------------------------------------------------------------
// Execution evaluation recording
// ---------------------------------------------------------------------------

export interface RecordExecutionEvaluationParams {
  evaluation_id: string;
  org_id: string;
  outcome: "success" | "failure" | "skipped";
  executed_at?: string;
  details?: Record<string, unknown>;
}

export async function recordExecutionEvaluation(
  params: RecordExecutionEvaluationParams,
): Promise<unknown> {
  const body: Record<string, unknown> = {
    org_id: params.org_id,
    outcome: params.outcome,
  };
  if (params.executed_at !== undefined) body.executed_at = params.executed_at;
  if (params.details !== undefined) body.details = params.details;
  return post(
    `/v1/evaluations/${encodeURIComponent(params.evaluation_id)}/execution`,
    body,
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface CreateWebhookParams {
  org_id: string;
  url: string;
  events: string[];
  description?: string;
  secret?: string;
}

export async function createWebhook(params: CreateWebhookParams): Promise<unknown> {
  const body: Record<string, unknown> = {
    org_id: params.org_id,
    url: params.url,
    events: params.events,
  };
  if (params.description !== undefined) body.description = params.description;
  if (params.secret !== undefined) body.secret = params.secret;
  return post("/v1/webhooks", body);
}

export interface DeleteWebhookParams {
  webhook_id: string;
  org_id: string;
}

export async function deleteWebhook(params: DeleteWebhookParams): Promise<unknown> {
  return del(`/v1/webhooks/${encodeURIComponent(params.webhook_id)}`, {
    org_id: params.org_id,
  });
}

// ---------------------------------------------------------------------------
// HTTP PUT helper
// ---------------------------------------------------------------------------

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${resolveBase(path)}${path}`, {
    method: "PUT",
    headers: buildHeaders(),
    body: JSON.stringify(body),
    signal: makeAbortSignal(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    handleHttpError(res.status, text);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// SCIM 2.0 provisioning
// ---------------------------------------------------------------------------

export async function listScimUsers(
  orgId: string,
  filter?: string,
  startIndex?: number,
  count?: number,
): Promise<unknown> {
  return get(`/v1/orgs/${encodeURIComponent(orgId)}/scim/v2/Users`, {
    filter,
    startIndex: startIndex !== undefined ? String(startIndex) : undefined,
    count: count !== undefined ? String(count) : undefined,
  });
}

export async function getScimUser(orgId: string, userId: string): Promise<unknown> {
  return get(
    `/v1/orgs/${encodeURIComponent(orgId)}/scim/v2/Users/${encodeURIComponent(userId)}`,
  );
}

export async function createScimUser(
  orgId: string,
  attributes: Record<string, unknown>,
): Promise<unknown> {
  return post(`/v1/orgs/${encodeURIComponent(orgId)}/scim/v2/Users`, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    ...attributes,
  });
}

export async function patchScimUser(
  orgId: string,
  userId: string,
  operations: Array<{ op: string; path?: string; value?: unknown }>,
): Promise<unknown> {
  return patch(
    `/v1/orgs/${encodeURIComponent(orgId)}/scim/v2/Users/${encodeURIComponent(userId)}`,
    {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: operations,
    },
  );
}

export async function deleteScimUser(orgId: string, userId: string): Promise<unknown> {
  return del(
    `/v1/orgs/${encodeURIComponent(orgId)}/scim/v2/Users/${encodeURIComponent(userId)}`,
  );
}

export async function listScimGroups(
  orgId: string,
  filter?: string,
  startIndex?: number,
  count?: number,
): Promise<unknown> {
  return get(`/v1/orgs/${encodeURIComponent(orgId)}/scim/v2/Groups`, {
    filter,
    startIndex: startIndex !== undefined ? String(startIndex) : undefined,
    count: count !== undefined ? String(count) : undefined,
  });
}

// ---------------------------------------------------------------------------
// SIEM export configuration
// ---------------------------------------------------------------------------

export async function getSiemConfig(orgId: string): Promise<unknown> {
  return get(`/v1/orgs/${encodeURIComponent(orgId)}/siem-config`);
}

export async function upsertSiemConfig(
  orgId: string,
  config: Record<string, unknown>,
): Promise<unknown> {
  return put(`/v1/orgs/${encodeURIComponent(orgId)}/siem-config`, config);
}

export async function testSiemDelivery(orgId: string): Promise<unknown> {
  return post(`/v1/orgs/${encodeURIComponent(orgId)}/siem-exports/test`, {});
}

// ---------------------------------------------------------------------------
// Evidence exports (compliance bundles)
// ---------------------------------------------------------------------------

export async function listEvidenceExports(orgId: string, regime?: string): Promise<unknown> {
  return get(`/v1/orgs/${encodeURIComponent(orgId)}/evidence-exports`, {
    regime,
  });
}

export async function getEvidenceExport(orgId: string, exportId: string): Promise<unknown> {
  return get(
    `/v1/orgs/${encodeURIComponent(orgId)}/evidence-exports/${encodeURIComponent(exportId)}`,
  );
}

export async function createEvidenceExport(
  orgId: string,
  payload: { regime: string; date_from?: string; date_to?: string },
): Promise<unknown> {
  return post(`/v1/orgs/${encodeURIComponent(orgId)}/evidence-exports`, payload);
}
