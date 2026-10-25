/**
 * OpenShell activation gate (#279).
 *
 * Answers one question: may an AtlaSent/OpenShell path move from watch-only to
 * blocking? It never activates anything. The result's `posture` is always
 * "watch_only"; `eligible_for_blocking: true` only means every precondition
 * below was shown, and moving to blocking stays a separate, explicit decision.
 *
 * Every check fails closed: a field that is missing, malformed or unknown is a
 * failed check, never a pass. The preconditions, each a separate check so an
 * operator sees exactly what is missing:
 *
 *  1. version            A released (non-prerelease) OpenShell with a recorded
 *                        startup-probe pass (assessOpenShellVersion). Unreleased
 *                        or draft OpenShell middleware APIs never qualify.
 *  2. guard_registered   The AtlaSent workload guard is registered in gateway
 *                        config, authenticated (not allow_insecure_transport).
 *  3. guard_request_binding
 *                        The registered service inspects the REQUEST before
 *                        credentials are injected. A response-only (or
 *                        WebSocket-only) service cannot be reported as request
 *                        enforcement: by the time a response is inspected the
 *                        external service has already acted.
 *  4. guard_capabilities The guard requires only the released buffered
 *                        contract. A required experimental capability (e.g.
 *                        NVIDIA/OpenShell#4359's http-session) is refused.
 *  5. policy_attachment  Sandbox policy attaches the guard to the pinned
 *                        AtlaSent host by exact name, and does not exclude it.
 *  6. fail_closed        That attachment is `on_error: fail_closed` (OpenShell's
 *                        default). `fail_open` skips a failed guard.
 *  7. current_supervisor_binding
 *                        The CURRENT supervisor policy generation proved the
 *                        binding: a probe request on that generation was seen
 *                        by the guard and the runtime reported
 *                        workload_attested. OpenShell keeps a sandbox's previous
 *                        middleware setup when a new one fails validation, so a
 *                        config file saying the guard is attached is not proof
 *                        the running supervisor uses it; a proof from an older
 *                        generation or another sandbox does not carry over.
 *  8. failure_probe      On that same generation, a request with the guard
 *                        unavailable was refused with `middleware_failed` and
 *                        nothing executed. A fail-closed setting never shown to
 *                        refuse is a claim, not a control.
 */

import { assessOpenShellVersion, type OpenShellAdvisory, type OpenShellAssessment } from "./openshell.js";

/** The workload guard's identity, as its Describe answers (packages/openshell-workload-guard/server.mjs). */
export const GUARD_SERVICE_NAME = "atlasent-workload-guard";
export const GUARD_IMPLEMENTATION_NAME = "atlasent/openshell-workload-guard";
/** The released buffered middleware contract (OpenShell extension protocol 1.0). */
export const RELEASED_MIDDLEWARE_CONTRACT = "openshell.supervisor-middleware.contract";

/**
 * Released, non-prerelease OpenShell versions on the 0.1 line, read from the
 * NVIDIA/OpenShell tags on 2026-10-25. The vendored
 * packages/openshell-workload-guard/proto/supervisor_middleware.proto matches
 * v0.1.5's proto apart from one comment. A version must ALSO have a recorded
 * startup-probe pass (OPENSHELL_PROBE_PASSED) to qualify; being listed here is
 * necessary, not sufficient. Add a version only once its tag is published.
 */
export const OPENSHELL_RELEASED_STABLE: readonly string[] = ["0.1.0", "0.1.1", "0.1.2", "0.1.3", "0.1.4", "0.1.5"];

const OP_HTTP_REQUEST = "SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_REQUEST";
const PHASE_PRE_CREDENTIALS = "SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS";
// Numeric forms of the same enum values (proto/supervisor_middleware.proto).
const OP_NUMERIC: Record<number, string> = {
  1: OP_HTTP_REQUEST,
  2: "SUPERVISOR_MIDDLEWARE_OPERATION_WEBSOCKET_MESSAGE",
  3: "SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_RESPONSE",
};
const PHASE_NUMERIC: Record<number, string> = { 1: PHASE_PRE_CREDENTIALS, 2: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_RETURN" };

export type ActivationCheckId =
  | "manifest"
  | "version"
  | "guard_registered"
  | "guard_request_binding"
  | "guard_capabilities"
  | "policy_attachment"
  | "fail_closed"
  | "current_supervisor_binding"
  | "failure_probe";

export interface ActivationCheck {
  id: ActivationCheckId;
  ok: boolean;
  detail: string;
}

export interface ActivationReport {
  gate: "openshell_activation";
  /** True only when every check passed. Never an activation by itself. */
  eligible_for_blocking: boolean;
  /** Always watch_only: this gate never moves a path to blocking. */
  posture: "watch_only";
  checks: ActivationCheck[];
  openshell_assessment: OpenShellAssessment | null;
  advisories: readonly OpenShellAdvisory[];
  note: string;
}

const NOTE =
  "This gate never activates blocking. eligible_for_blocking means every precondition was shown; moving a path " +
  "from watch-only to blocking is a separate, explicit decision (#279 stop rule).";

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return undefined;
  return v as string[];
}

function generation(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return str(v);
}

/** Exact released semver, no prerelease or build suffix. */
function isReleasedStable(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version) && OPENSHELL_RELEASED_STABLE.includes(version);
}

function enumName(v: unknown, numeric: Record<number, string>): string | undefined {
  if (typeof v === "number") return numeric[v];
  return str(v);
}

/**
 * Could `pattern` (an OpenShell endpoint host pattern) match `host`? Used for
 * EXCLUDE, so it errs towards yes: any wildcard whose literal suffix the host
 * ends with counts as a match.
 */
function mayMatch(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (p === host) return true;
  if (!p.includes("*")) return false;
  const suffix = p.slice(p.lastIndexOf("*") + 1);
  return host.endsWith(suffix);
}

/**
 * Evaluate the activation manifest. Its shape mirrors what an operator can
 * read (docs/OPENSHELL_AUTHORITY_ADAPTER.md, "Activation gate"):
 *
 *   openshell_version     the running OpenShell release
 *   guard_registration    the registration name the guard runs under
 *   atlasent_host         the AtlaSent API host the guard pins (destination.host)
 *   gateway_middleware    [[openshell.supervisor.middleware]] entries (gateway TOML)
 *   guard_describe        the registered service's Describe answer
 *   network_middlewares   the sandbox policy's network_middlewares map
 *   supervisor            { sandbox_id, policy_generation } of the RUNNING supervisor
 *   binding_proof         { sandbox_id, policy_generation, guard_observed, workload_attested }
 *   failure_probe         { sandbox_id, policy_generation, error, executed }
 */
export function assessOpenShellActivation(
  raw: unknown,
  deps: { assess?: (version: string) => OpenShellAssessment } = {},
): ActivationReport {
  const assess = deps.assess ?? assessOpenShellVersion;
  const checks: ActivationCheck[] = [];
  const add = (id: ActivationCheckId, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  const report = (assessment: OpenShellAssessment | null): ActivationReport => ({
    gate: "openshell_activation",
    eligible_for_blocking: checks.length > 0 && checks.every((c) => c.ok),
    posture: "watch_only",
    checks,
    openshell_assessment: assessment,
    advisories: assessment?.advisories ?? [],
    note: NOTE,
  });

  if (!isRec(raw)) {
    add("manifest", false, "Activation manifest missing or not a JSON object.");
    return report(null);
  }
  const m = raw;

  // 1. version
  const version = str(m.openshell_version)?.replace(/^v/, "");
  let assessment: OpenShellAssessment | null = null;
  if (version === undefined) {
    add("version", false, "openshell_version not provided.");
  } else {
    assessment = assess(version);
    if (!isReleasedStable(version)) {
      add("version", false, `OpenShell ${version} is not a released stable version; prereleases and draft APIs never qualify.`);
    } else if (assessment.status !== "probe_passed") {
      add("version", false, `OpenShell ${version}: ${assessment.status}. ${assessment.reason}`);
    } else {
      add("version", true, `OpenShell ${version}: released, startup probe passed.`);
    }
  }

  // 2. guard_registered
  const registrations = Array.isArray(m.gateway_middleware) ? m.gateway_middleware.filter(isRec) : [];
  const describe = isRec(m.guard_describe) ? m.guard_describe : undefined;
  const policy = isRec(m.network_middlewares) ? m.network_middlewares : undefined;
  const guardEntries = policy
    ? Object.entries(policy).filter((e): e is [string, Rec] => isRec(e[1]))
    : [];
  // The registration the policy attaches the guard through: the one whose name
  // a policy entry uses and whose service answers as the AtlaSent guard.
  const describeIsGuard =
    describe !== undefined &&
    str(describe.name) === GUARD_SERVICE_NAME &&
    isRec(describe.extension) &&
    str(describe.extension.implementation_name) === GUARD_IMPLEMENTATION_NAME;
  const wantedName = str(m.guard_registration);
  const registration = wantedName ? registrations.find((r) => str(r.name) === wantedName) : undefined;
  const registeredName = registration && !wantedName!.startsWith("openshell/") ? wantedName : undefined;
  if (wantedName === undefined) {
    add("guard_registered", false, "guard_registration (the registration name the guard runs under) not provided.");
  } else if (wantedName.startsWith("openshell/")) {
    add("guard_registered", false, `${wantedName} is a reserved built-in name, not the AtlaSent guard.`);
  } else if (registrations.length === 0) {
    add("guard_registered", false, "No [[openshell.supervisor.middleware]] registration provided: the AtlaSent guard is not registered.");
  } else if (!describeIsGuard) {
    add(
      "guard_registered",
      false,
      `guard_describe does not identify the AtlaSent workload guard (name ${GUARD_SERVICE_NAME}, implementation ${GUARD_IMPLEMENTATION_NAME}).`,
    );
  } else if (registration === undefined) {
    add("guard_registered", false, `No [[openshell.supervisor.middleware]] registration named ${wantedName}.`);
  } else if (registration.allow_insecure_transport === true) {
    add("guard_registered", false, `Registration ${registeredName} sets allow_insecure_transport: calls to the guard are unauthenticated.`);
  } else if (str(registration.grpc_endpoint) === undefined) {
    add("guard_registered", false, `Registration ${registeredName} has no grpc_endpoint.`);
  } else {
    add("guard_registered", true, `AtlaSent workload guard registered as ${registeredName}.`);
  }

  // 3. guard_request_binding
  const bindings = describe && Array.isArray(describe.bindings) ? describe.bindings.filter(isRec) : [];
  const ops = bindings.map((b) => ({
    op: enumName(b.operation, OP_NUMERIC),
    phase: enumName(b.phase, PHASE_NUMERIC),
  }));
  const hasRequestBinding = ops.some((o) => o.op === OP_HTTP_REQUEST && o.phase === PHASE_PRE_CREDENTIALS);
  if (describe === undefined) {
    add("guard_request_binding", false, "guard_describe not provided: the service's request-inspection capability is unknown.");
  } else if (hasRequestBinding) {
    add("guard_request_binding", true, "Guard inspects HTTP requests before credentials are injected.");
  } else if (ops.length > 0) {
    add(
      "guard_request_binding",
      false,
      `Guard advertises only ${ops.map((o) => `${o.op ?? "unknown"}/${o.phase ?? "unknown"}`).join(", ")}: no pre-credentials ` +
        "HTTP request binding. Response-only or incomplete inspection cannot be reported as request enforcement; the " +
        "external service has already acted when a response is inspected.",
    );
  } else {
    add("guard_request_binding", false, "Guard advertises no bindings.");
  }

  // 4. guard_capabilities
  const ext = describe && isRec(describe.extension) ? describe.extension : undefined;
  const supported = ext ? strList(ext.supported_capabilities) : undefined;
  const required = ext ? strList(ext.required_capabilities) : undefined;
  if (supported === undefined || required === undefined) {
    add("guard_capabilities", false, "Guard capabilities not provided or malformed.");
  } else if (!supported.includes(RELEASED_MIDDLEWARE_CONTRACT)) {
    add("guard_capabilities", false, `Guard does not support ${RELEASED_MIDDLEWARE_CONTRACT}.`);
  } else {
    const extra = required.filter((c) => c !== RELEASED_MIDDLEWARE_CONTRACT);
    if (extra.length > 0) {
      add(
        "guard_capabilities",
        false,
        `Guard requires capabilities beyond the released contract (${extra.join(", ")}); experimental OpenShell ` +
          "binding APIs stay behind compatibility code until released.",
      );
    } else {
      add("guard_capabilities", true, "Guard requires only the released buffered middleware contract.");
    }
  }

  // 5. policy_attachment and 6. fail_closed
  const host = str(m.atlasent_host)?.toLowerCase();
  const attached = registeredName ? guardEntries.filter(([, e]) => str(e.middleware) === registeredName) : [];
  const covering = attached.filter(([, e]) => {
    const ep = isRec(e.endpoints) ? e.endpoints : undefined;
    const include = ep ? strList(ep.include) : undefined;
    const exclude = ep && ep.exclude !== undefined ? strList(ep.exclude) : [];
    if (!host || include === undefined || exclude === undefined) return false;
    return include.some((p) => p.trim().toLowerCase() === host) && !exclude.some((p) => mayMatch(p, host));
  });
  if (host === undefined) {
    add("policy_attachment", false, "atlasent_host not provided: cannot show the guard covers the AtlaSent API.");
  } else if (policy === undefined) {
    add("policy_attachment", false, "network_middlewares not provided: the guard is not attached to any route.");
  } else if (registeredName === undefined || attached.length === 0) {
    add("policy_attachment", false, "No network_middlewares entry attaches the registered guard: a provider path without the guard is not ready.");
  } else if (covering.length === 0) {
    add(
      "policy_attachment",
      false,
      `No guard entry includes ${host} by exact name without excluding it. Wildcard-only coverage is not accepted as proof.`,
    );
  } else {
    add("policy_attachment", true, `Guard attached to ${host} by ${covering.map(([k]) => k).join(", ")}.`);
  }
  if (covering.length === 0) {
    add("fail_closed", false, "No covering guard attachment to check.");
  } else {
    const open = covering.filter(([, e]) => e.on_error !== undefined && e.on_error !== "fail_closed");
    if (open.length > 0) {
      add(
        "fail_closed",
        false,
        `Guard attachment ${open.map(([k, e]) => `${k} (on_error: ${String(e.on_error)})`).join(", ")} is not fail_closed: ` +
          "a failed guard would be skipped and the request sent.",
      );
    } else {
      add("fail_closed", true, "Guard attachment is fail_closed.");
    }
  }

  // 7. current_supervisor_binding and 8. failure_probe
  const sup = isRec(m.supervisor) ? m.supervisor : undefined;
  const currentGen = sup ? generation(sup.policy_generation) : undefined;
  const currentSandbox = sup ? str(sup.sandbox_id) : undefined;
  const sameSupervisor = (p: Rec): string | undefined => {
    if (currentGen === undefined || currentSandbox === undefined) {
      return "supervisor.sandbox_id and supervisor.policy_generation of the running supervisor are required.";
    }
    const g = generation(p.policy_generation);
    if (g === undefined) return "proof carries no policy_generation.";
    if (g !== currentGen) {
      return `proof is from policy generation ${g}, the running supervisor is on ${currentGen}: an old supervisor or config cannot stand in for the current one.`;
    }
    if (str(p.sandbox_id) !== currentSandbox) return "proof is from a different sandbox_id.";
    return undefined;
  };

  const proof = isRec(m.binding_proof) ? m.binding_proof : undefined;
  if (proof === undefined) {
    add("current_supervisor_binding", false, "binding_proof not provided: blocking is not established until the current supervisor proves the guard binding.");
  } else {
    const problem = sameSupervisor(proof);
    if (problem) add("current_supervisor_binding", false, problem);
    else if (proof.guard_observed !== true) add("current_supervisor_binding", false, "The guard did not observe the probe request.");
    else if (proof.workload_attested !== true) add("current_supervisor_binding", false, "The runtime did not report workload_attested for the probe request.");
    else add("current_supervisor_binding", true, `Guard binding proven on policy generation ${currentGen}.`);
  }

  const fp = isRec(m.failure_probe) ? m.failure_probe : undefined;
  if (fp === undefined) {
    add("failure_probe", false, "failure_probe not provided: fail-closed behaviour with the guard unavailable has not been shown.");
  } else {
    const problem = sameSupervisor(fp);
    if (problem) add("failure_probe", false, problem);
    else if (fp.error !== "middleware_failed") add("failure_probe", false, `Guard-unavailable request was not refused with middleware_failed (got ${JSON.stringify(fp.error ?? null)}).`);
    else if (fp.executed !== false) add("failure_probe", false, "Guard-unavailable probe does not record that nothing executed.");
    else add("failure_probe", true, "Guard unavailable: request refused with middleware_failed, nothing executed.");
  }

  return report(assessment);
}
