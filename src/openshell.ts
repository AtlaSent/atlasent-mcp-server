/**
 * NVIDIA OpenShell × AtlaSent adapter contract.
 *
 * OpenShell decides REACHABILITY: whether this sandbox may reach a resource.
 * AtlaSent decides ORGANIZATIONAL AUTHORITY: whether this exact action, target,
 * revision and effect is authorized. Neither substitutes for the other. This
 * module holds the adapter-side rules that keep them apart:
 *
 *  1. Identity. A request is bound to the OpenShell `sandbox_id`, the durable
 *     identity OpenShell hands supervisor middleware. `sandbox_name` and
 *     `workspace` are display labels that may be reused; they ride along as
 *     evidence for the approval UI and are never authority. A request with no
 *     usable `sandbox_id` is refused. There is no fallback to the name.
 *  2. Approvals. An OpenShell Policy Advisor approval means "this sandbox may
 *     reach this resource". It never resolves an AtlaSent HOLD. The canonical
 *     envelope is strict, so an envelope carrying approval-shaped fields is
 *     refused rather than forwarded into `context.approvals`.
 *  3. Policy changes. A HOLD or an unconsumed permit obtained under one
 *     OpenShell policy generation is not carried across a generation change.
 *     The adapter evaluates afresh. That includes the spurious startup bump in
 *     OpenShell 0.1.2 (NVIDIA/OpenShell#3994): the cost is one extra evaluation
 *     (possibly a new HOLD), never a silent inherit and never an allow.
 *  4. Execution boundary. Before the external effect, the sandbox presenting
 *     the permit must be the sandbox it was evaluated for, and the permit is
 *     verified (and consumed) by the runtime.
 *
 * Fail-closed throughout: any error yields DENY, never PERMIT.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

import type { ActionContext, Decision, VerifyResult, WorkloadBinding } from "./decision.js";
import { authorize as engineAuthorize, verify as engineVerify, awaitApproval as engineAwaitApproval } from "./engine.js";
import type { AwaitApprovalParams, AwaitApprovalResult } from "./engine.js";

// ── 1. Sandbox identity ─────────────────────────────────────────────────────

/** What OpenShell supervisor middleware hands the adapter for one request. */
export interface OpenShellSandboxContext {
  /** Durable sandbox identity. Required. */
  sandbox_id: string;
  /** Human-readable, reusable. Display/evidence only. */
  sandbox_name?: string;
  /** Human-readable, reusable. Display/evidence only. */
  workspace?: string;
  /**
   * The sandbox's current OpenShell policy generation, when the host can
   * observe it. Used only to decide whether a held/unconsumed authorization was
   * obtained under the current policy. Never authority.
   */
  policy_generation?: string | number;
}

const MAX_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

export type SandboxParse =
  | { ok: true; sandbox: Required<Pick<OpenShellSandboxContext, "sandbox_id">> & OpenShellSandboxContext }
  | { ok: false; reason: string };

/**
 * Validate what middleware reported. Refuses a missing, blank, over-long or
 * whitespace-bearing `sandbox_id`; never derives one from `sandbox_name` or
 * `workspace`. Labels are trimmed, stripped of control characters and capped,
 * and dropped when empty.
 */
export function parseSandboxContext(raw: unknown): SandboxParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "OpenShell sandbox context missing: refusing to evaluate without a sandbox_id." };
  }
  const r = raw as Record<string, unknown>;
  const id = r.sandbox_id;
  if (typeof id !== "string" || id.trim() === "") {
    return {
      ok: false,
      reason:
        "OpenShell sandbox_id missing: authority binds to the durable sandbox_id, never to sandbox_name or workspace.",
    };
  }
  if (id !== id.trim() || CONTROL_OR_SPACE.test(id) || id.length > MAX_ID_LENGTH) {
    return { ok: false, reason: "OpenShell sandbox_id malformed (whitespace, control characters or over 256 chars)." };
  }
  const out: OpenShellSandboxContext & { sandbox_id: string } = { sandbox_id: id };
  // OpenShell's middleware RequestContext (proto/supervisor_middleware.proto)
  // calls the display name `sandbox`; `sandbox_name` is accepted too.
  const name = cleanLabel(r.sandbox) ?? cleanLabel(r.sandbox_name);
  if (name !== undefined) out.sandbox_name = name;
  const ws = cleanLabel(r.workspace);
  if (ws !== undefined) out.workspace = ws;
  const gen = r.policy_generation;
  if ((typeof gen === "string" && gen.trim() !== "") || (typeof gen === "number" && Number.isFinite(gen))) {
    out.policy_generation = gen;
  }
  return { ok: true, sandbox: out };
}

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.replace(CONTROL, "").trim().slice(0, MAX_LABEL_LENGTH);
  return s === "" ? undefined : s;
}

/** The workload binding sent to /v1-evaluate. Labels are nested, never the id. */
export function workloadBinding(sandbox: OpenShellSandboxContext): WorkloadBinding {
  const binding: WorkloadBinding = { kind: "openshell_sandbox", id: sandbox.sandbox_id };
  const labels: NonNullable<WorkloadBinding["labels"]> = {};
  if (sandbox.sandbox_name !== undefined) labels.sandbox_name = sandbox.sandbox_name;
  if (sandbox.workspace !== undefined) labels.workspace = sandbox.workspace;
  if (Object.keys(labels).length > 0) binding.labels = labels;
  return binding;
}

// ── 2. Canonical action envelope (strict) ───────────────────────────────────

/**
 * Field names that would carry an OpenShell (or any caller-held) approval into
 * the authorization path. Named so the refusal says why, rather than a generic
 * "unknown key".
 */
export const EXTERNAL_APPROVAL_FIELDS: readonly string[] = [
  "approvals",
  "approved_by",
  "approval",
  "approval_id",
  "policy_advisor",
  "policy_advisor_approval",
  "policy_proposal",
  "proposal_id",
  "openshell_approval",
];

const ChangePlanSchema = z
  .object({
    operation: z.string().min(1),
    revision: z.string().min(1).optional(),
    artifact_ref: z.string().min(1).optional(),
  })
  .strict();

export const CanonicalActionEnvelopeSchema = z
  .object({
    action_type: z.string().min(1),
    actor_id: z.string().min(1),
    environment: z.string().min(1),
    target_id: z.string().min(1).optional(),
    target_system: z.string().min(1).optional(),
    payload_hash: z.string().min(1).optional(),
    change_plan: ChangePlanSchema.optional(),
    expected_effect: z.record(z.string(), z.unknown()).optional(),
    request_id: z.string().min(1).optional(),
  })
  .strict();

export type CanonicalActionEnvelope = z.infer<typeof CanonicalActionEnvelopeSchema>;

export type EnvelopeParse = { ok: true; envelope: CanonicalActionEnvelope } | { ok: false; reason: string };

export function parseActionEnvelope(raw: unknown): EnvelopeParse {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const present = EXTERNAL_APPROVAL_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(raw, k));
    if (present.length > 0) {
      return {
        ok: false,
        reason:
          `Refusing envelope carrying approval field(s) ${present.join(", ")}: an OpenShell Policy Advisor ` +
          "approval grants reachability only and can never satisfy an AtlaSent HOLD. Approve the HOLD in AtlaSent.",
      };
    }
  }
  const parsed = CanonicalActionEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `Invalid canonical action envelope: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  return { ok: true, envelope: parsed.data };
}

/** Stable digest of the envelope, used to key pending HOLDs and permits. */
export function envelopeDigest(envelope: CanonicalActionEnvelope): string {
  return createHash("sha256").update(stableStringify(envelope)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function toActionContext(envelope: CanonicalActionEnvelope, sandbox: OpenShellSandboxContext): ActionContext {
  // `approvals` is deliberately never set here: no OpenShell signal is an
  // AtlaSent approval.
  const ctx: ActionContext = {
    action_type: envelope.action_type,
    actor_id: envelope.actor_id,
    environment: envelope.environment,
    workload: workloadBinding(sandbox),
  };
  if (envelope.target_id !== undefined) ctx.target_id = envelope.target_id;
  if (envelope.target_system !== undefined) ctx.target_system = envelope.target_system;
  if (envelope.payload_hash !== undefined) ctx.payload_hash = envelope.payload_hash;
  if (envelope.change_plan !== undefined) ctx.change_plan = envelope.change_plan;
  if (envelope.expected_effect !== undefined) ctx.expected_effect = envelope.expected_effect;
  if (envelope.request_id !== undefined) ctx.request_id = envelope.request_id;
  return ctx;
}

// ── 3. Adapter: DENY | HOLD | PERMIT ────────────────────────────────────────

export type AdapterResult =
  | { outcome: "DENY"; reasons: string[]; audit_id?: string }
  | { outcome: "HOLD"; approval_request_id?: string; reasons: string[]; audit_id?: string; display: DisplayLabels }
  | {
      outcome: "PERMIT";
      permit_token: string;
      /** Present this at verify; the opaque execution binding. */
      payload_hash?: string;
      bound_actor_id?: string;
      audit_id?: string;
      display: DisplayLabels;
    };

/** What an approval UI shows. Evidence, not identity. */
export interface DisplayLabels {
  sandbox_id: string;
  sandbox_name?: string;
  workspace?: string;
}

interface Issued {
  sandbox_id: string;
  digest: string;
  policy_generation?: string | number;
  envelope: CanonicalActionEnvelope;
}

export interface OpenShellAdapterDeps {
  authorize?: (ctx: ActionContext) => Promise<Decision>;
  verify?: (token: string, ctx: ActionContext) => Promise<VerifyResult>;
  awaitApproval?: (params: AwaitApprovalParams) => Promise<AwaitApprovalResult>;
}

/**
 * The generation comparison. Both known and different → changed. Known on one
 * side only → changed (the adapter cannot show the policy is the same). Unknown
 * on both → not comparable, so not treated as a change.
 */
export function policyGenerationChanged(
  recorded: string | number | undefined,
  current: string | number | undefined,
): boolean {
  if (recorded === undefined && current === undefined) return false;
  return String(recorded) !== String(current);
}

export class OpenShellAuthorityAdapter {
  private readonly authorizeFn: NonNullable<OpenShellAdapterDeps["authorize"]>;
  private readonly verifyFn: NonNullable<OpenShellAdapterDeps["verify"]>;
  private readonly awaitApprovalFn: NonNullable<OpenShellAdapterDeps["awaitApproval"]>;
  private readonly holds = new Map<string, Issued>();
  private readonly permits = new Map<string, Issued>();

  constructor(deps: OpenShellAdapterDeps = {}) {
    this.authorizeFn = deps.authorize ?? engineAuthorize;
    this.verifyFn = deps.verify ?? engineVerify;
    this.awaitApprovalFn = deps.awaitApproval ?? engineAwaitApproval;
  }

  /** Evaluate one consequential action from one sandbox. */
  async evaluate(rawEnvelope: unknown, rawSandbox: unknown): Promise<AdapterResult> {
    const sb = parseSandboxContext(rawSandbox);
    if (!sb.ok) return { outcome: "DENY", reasons: [sb.reason] };
    const env = parseActionEnvelope(rawEnvelope);
    if (!env.ok) return { outcome: "DENY", reasons: [env.reason] };
    return this.evaluateParsed(env.envelope, sb.sandbox);
  }

  private async evaluateParsed(envelope: CanonicalActionEnvelope, sandbox: OpenShellSandboxContext): Promise<AdapterResult> {
    const display = displayLabels(sandbox);
    let decision: Decision;
    try {
      decision = await this.authorizeFn(toActionContext(envelope, sandbox));
    } catch (err) {
      return { outcome: "DENY", reasons: [`AtlaSent evaluation failed: ${errMessage(err)}`] };
    }
    const issued: Issued = {
      sandbox_id: sandbox.sandbox_id,
      digest: envelopeDigest(envelope),
      policy_generation: sandbox.policy_generation,
      envelope,
    };
    if (decision.decision === "allow") {
      this.permits.set(decision.permit_token, issued);
      const out: AdapterResult = { outcome: "PERMIT", permit_token: decision.permit_token, display };
      if (decision.bound_payload_hash !== undefined) out.payload_hash = decision.bound_payload_hash;
      else if (envelope.payload_hash !== undefined) out.payload_hash = envelope.payload_hash;
      if (decision.bound_actor_id !== undefined) out.bound_actor_id = decision.bound_actor_id;
      if (decision.audit_id !== undefined) out.audit_id = decision.audit_id;
      return out;
    }
    if (decision.decision === "hold") {
      if (decision.approval_request_id !== undefined) this.holds.set(decision.approval_request_id, issued);
      const out: AdapterResult = { outcome: "HOLD", reasons: decision.reasons, display };
      if (decision.approval_request_id !== undefined) out.approval_request_id = decision.approval_request_id;
      if (decision.audit_id !== undefined) out.audit_id = decision.audit_id;
      return out;
    }
    const out: AdapterResult = { outcome: "DENY", reasons: decision.reasons };
    if (decision.audit_id !== undefined) out.audit_id = decision.audit_id;
    return out;
  }

  /**
   * Wait on an AtlaSent HOLD this adapter issued. The only thing that resolves
   * it is the AtlaSent approval flow. If the OpenShell policy generation moved
   * since the HOLD was issued, the HOLD is not inherited: the adapter evaluates
   * the same envelope afresh (which may HOLD again).
   */
  async resolveHold(
    approvalRequestId: string,
    rawSandbox: unknown,
    opts: { max_wait_ms: number; poll_interval_ms?: number },
  ): Promise<AdapterResult> {
    const sb = parseSandboxContext(rawSandbox);
    if (!sb.ok) return { outcome: "DENY", reasons: [sb.reason] };
    const held = this.holds.get(approvalRequestId);
    if (!held) {
      return { outcome: "DENY", reasons: [`Unknown HOLD ${approvalRequestId}: this adapter did not issue it.`] };
    }
    if (held.sandbox_id !== sb.sandbox.sandbox_id) {
      return {
        outcome: "DENY",
        reasons: [`HOLD ${approvalRequestId} was issued to a different sandbox_id; refusing to claim it from this one.`],
      };
    }
    this.holds.delete(approvalRequestId);
    if (policyGenerationChanged(held.policy_generation, sb.sandbox.policy_generation)) {
      return this.evaluateParsed(held.envelope, sb.sandbox);
    }
    let result: AwaitApprovalResult;
    try {
      result = await this.awaitApprovalFn({ approval_request_id: approvalRequestId, ...opts });
    } catch (err) {
      return { outcome: "DENY", reasons: [`AtlaSent approval wait failed: ${errMessage(err)}`] };
    }
    if (result.outcome !== "approved") {
      if (result.outcome === "timeout") this.holds.set(approvalRequestId, held);
      return { outcome: "DENY", reasons: result.reasons.length ? result.reasons : [`Approval ${result.outcome}.`] };
    }
    this.permits.set(result.permit_token, { ...held, policy_generation: sb.sandbox.policy_generation });
    return { outcome: "PERMIT", permit_token: result.permit_token, display: displayLabels(sb.sandbox) };
  }

  /**
   * Immediately before the external effect: the presenting sandbox must be the
   * one the permit was evaluated for, the envelope must be unchanged, and the
   * runtime must verify (consume) the permit. A permit obtained under an older
   * OpenShell policy generation is not used; evaluate again.
   */
  async verifyBeforeExecute(
    permitToken: string,
    rawEnvelope: unknown,
    rawSandbox: unknown,
    opts: { payload_hash?: string } = {},
  ): Promise<{ execute: true; verify: VerifyResult } | { execute: false; reasons: string[]; reevaluate?: true }> {
    const sb = parseSandboxContext(rawSandbox);
    if (!sb.ok) return { execute: false, reasons: [sb.reason] };
    const env = parseActionEnvelope(rawEnvelope);
    if (!env.ok) return { execute: false, reasons: [env.reason] };
    const issued = this.permits.get(permitToken);
    if (!issued) return { execute: false, reasons: ["Unknown permit: this adapter did not issue it."] };
    if (issued.sandbox_id !== sb.sandbox.sandbox_id) {
      return { execute: false, reasons: ["Permit was evaluated for a different sandbox_id."] };
    }
    if (issued.digest !== envelopeDigest(env.envelope)) {
      return { execute: false, reasons: ["Action changed since evaluation; evaluate again."] };
    }
    if (policyGenerationChanged(issued.policy_generation, sb.sandbox.policy_generation)) {
      this.permits.delete(permitToken);
      return {
        execute: false,
        reevaluate: true,
        reasons: ["OpenShell policy generation changed since this permit was issued; evaluate again."],
      };
    }
    this.permits.delete(permitToken);
    const ctx = toActionContext(env.envelope, sb.sandbox);
    if (opts.payload_hash !== undefined) ctx.payload_hash = opts.payload_hash;
    let verify: VerifyResult;
    try {
      verify = await this.verifyFn(permitToken, ctx);
    } catch (err) {
      return { execute: false, reasons: [`AtlaSent verify failed: ${errMessage(err)}`] };
    }
    if (!verify.valid) return { execute: false, reasons: verify.reasons ?? [`Permit ${verify.outcome}.`] };
    return { execute: true, verify };
  }
}

function displayLabels(sandbox: OpenShellSandboxContext): DisplayLabels {
  const d: DisplayLabels = { sandbox_id: sandbox.sandbox_id };
  if (sandbox.sandbox_name !== undefined) d.sandbox_name = sandbox.sandbox_name;
  if (sandbox.workspace !== undefined) d.workspace = sandbox.workspace;
  return d;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── 4. OpenShell version + startup policy-generation probe ──────────────────

/**
 * Releases with a known enforcement-reliability defect that disqualifies a
 * passing run from counting as acceptance evidence. A version NOT listed here
 * is "unverified", not "ready": readiness comes from a recorded pass of the
 * live startup probe below, never from a version string.
 */
const ISSUE_3994 =
  "NVIDIA/OpenShell#3994: the first settings poll after startup can report a spurious provider-env change, " +
  "advance the policy generation and drop in-flight requests about 10s after startup. Fixed on main by " +
  "NVIDIA/OpenShell#4122 (ec49209, 2026-10-02), after this release was cut.";

export const OPENSHELL_KNOWN_AFFECTED: Readonly<Record<string, string>> = {
  "0.1.2": ISSUE_3994,
  // Prereleases cut before ec49209 (pre.3 is 6e865df3, 2026-10-02 11:51Z).
  "0.1.3-pre.1": ISSUE_3994,
  "0.1.3-pre.2": ISSUE_3994,
  "0.1.3-pre.3": ISSUE_3994,
};

/**
 * Releases confirmed (by commit ancestry, not by changelog) to contain the
 * #3994 fix, NVIDIA/OpenShell#4122 (ec49209). Still "unverified": containing the
 * fix is not the same as passing the live startup probe on it.
 */
export const OPENSHELL_FIX_CONFIRMED_IN: Readonly<Record<string, string>> = {
  "0.1.3-pre.4":
    "Contains the NVIDIA/OpenShell#3994 fix (ec49209 is an ancestor of e7fdd6be, cut 2026-10-05). " +
    "Production readiness still requires a recorded startup-probe pass on it.",
};

export function assessOpenShellVersion(
  version: string,
): { status: "known_affected"; reason: string } | { status: "unverified"; reason: string } {
  const v = version.trim().replace(/^v/, "");
  const affected = OPENSHELL_KNOWN_AFFECTED[v];
  if (affected) return { status: "known_affected", reason: affected };
  const fixed = OPENSHELL_FIX_CONFIRMED_IN[v];
  if (fixed) return { status: "unverified", reason: fixed };
  return {
    status: "unverified",
    reason: "Not a known-affected release. Production readiness still requires a recorded startup-probe pass.",
  };
}

export type ProbeAttempt =
  | { ok: true; policy_generation?: string | number }
  | { ok: false; kind: "dropped" | "denied" | "error"; detail?: string; policy_generation?: string | number };

export interface StartupProbeOptions {
  /** Send one AtlaSent-governed request through the sandbox. */
  send: () => Promise<ProbeAttempt>;
  /** Total window measured from sandbox start. Default 20s (the bug fires ~10s). */
  duration_ms?: number;
  interval_ms?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface StartupProbeReport {
  passed: boolean;
  attempts: number;
  failures: Array<{ at_ms: number; kind: string; detail?: string }>;
  /** Generation transitions observed, with the time they were first seen. */
  generation_changes: Array<{ at_ms: number; from: string; to: string }>;
}

/**
 * Drive requests continuously across the sandbox's first seconds. Passes only
 * if every attempt succeeded. A generation change by itself is reported but is
 * not a failure; a dropped or denied request is. Zero attempts is a failure
 * (a probe that sent nothing has proved nothing).
 */
export async function runStartupGenerationProbe(opts: StartupProbeOptions): Promise<StartupProbeReport> {
  const duration = opts.duration_ms ?? 20_000;
  const interval = opts.interval_ms ?? 500;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  const report: StartupProbeReport = { passed: false, attempts: 0, failures: [], generation_changes: [] };
  let lastGen: string | undefined;
  while (now() - start < duration) {
    const at = now() - start;
    let res: ProbeAttempt;
    try {
      res = await opts.send();
    } catch (err) {
      res = { ok: false, kind: "error", detail: errMessage(err) };
    }
    report.attempts += 1;
    if (res.policy_generation !== undefined) {
      const g = String(res.policy_generation);
      if (lastGen !== undefined && g !== lastGen) report.generation_changes.push({ at_ms: at, from: lastGen, to: g });
      lastGen = g;
    }
    if (!res.ok) {
      const f: { at_ms: number; kind: string; detail?: string } = { at_ms: at, kind: res.kind };
      if (res.detail !== undefined) f.detail = res.detail;
      report.failures.push(f);
    }
    await sleep(interval);
  }
  report.passed = report.attempts > 0 && report.failures.length === 0;
  return report;
}
