// #279: the OpenShell activation gate. Every check must be shown to refuse the
// defect it targets, and a fully-proven manifest must pass (positive control),
// or a failing gate proves nothing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "./openshellCli.js";
import { EXIT } from "./openshellRun.js";

import {
  assessOpenShellActivation,
  OPENSHELL_RELEASED_STABLE,
  type ActivationCheckId,
  type ActivationReport,
} from "./openshellActivation.js";
import type { OpenShellAssessment } from "./openshell.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON in a test/acceptance harness
type Manifest = Record<string, any>;

const PASSED = (): OpenShellAssessment => ({ status: "probe_passed", reason: "test fixture", advisories: [] });

/**
 * The workload guard's Describe answer (packages/openshell-workload-guard/
 * server.mjs). The guard's own suite pins these bindings and capabilities
 * (test/guard.node.mjs, "Describe"); the guard's gRPC deps are not installed at
 * the repo root, so the answer is copied here rather than imported.
 */
function guardDescribe(): Record<string, unknown> {
  return {
    name: "atlasent-workload-guard",
    service_version: "0.0.0",
    bindings: [
      {
        operation: "SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_REQUEST",
        phase: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS",
        max_payload_bytes: 262144,
      },
    ],
    expected_audience: "urn:atlasent:openshell:workload-guard",
    extension: {
      protocol_version: { major: 1, minor: 0 },
      implementation_name: "atlasent/openshell-workload-guard",
      implementation_version: "0.0.0",
      supported_capabilities: ["openshell.supervisor-middleware.contract"],
      required_capabilities: ["openshell.supervisor-middleware.contract"],
    },
  };
}

function ready(): Record<string, unknown> {
  return {
    openshell_version: "0.1.5",
    atlasent_host: "api.atlasent.io",
    guard_registration: "atlasent-workload-guard",
    gateway_middleware: [
      { name: "atlasent-workload-guard", grpc_endpoint: "https://host.openshell.internal:50061", max_payload_bytes: 262144 },
    ],
    guard_describe: guardDescribe(),
    network_middlewares: {
      "atlasent-guard": {
        middleware: "atlasent-workload-guard",
        endpoints: { include: ["api.atlasent.io"] },
        on_error: "fail_closed",
      },
    },
    supervisor: { sandbox_id: "sbx_01J9ZK", policy_generation: 7 },
    binding_proof: { sandbox_id: "sbx_01J9ZK", policy_generation: 7, guard_observed: true, workload_attested: true },
    failure_probe: { sandbox_id: "sbx_01J9ZK", policy_generation: 7, error: "middleware_failed", executed: false },
  };
}

function failed(r: ActivationReport): ActivationCheckId[] {
  return r.checks.filter((c) => !c.ok).map((c) => c.id);
}

/**
 * Apply `mutate` to a fully-proven manifest; exactly the named check(s) must
 * fail and the gate must refuse. A list names a check plus the checks that
 * cannot pass without it (no covering attachment ⇒ nothing to call fail_closed).
 */
function refuses(id: ActivationCheckId | ActivationCheckId[], mutate: (m: Manifest) => void): ActivationReport {
  const ids = Array.isArray(id) ? id : [id];
  const m = ready() as Manifest;
  mutate(m);
  const r = assessOpenShellActivation(m, { assess: PASSED });
  assert.equal(r.eligible_for_blocking, false, `expected ${ids.join(", ")} to refuse`);
  assert.deepEqual(failed(r), ids);
  assert.equal(r.posture, "watch_only");
  return r;
}

describe("OpenShell activation gate (#279)", () => {
  it("positive control: a fully-proven manifest is eligible, and still watch-only", () => {
    const r = assessOpenShellActivation(ready(), { assess: PASSED });
    assert.deepEqual(failed(r), []);
    assert.equal(r.eligible_for_blocking, true);
    assert.equal(r.posture, "watch_only");
    assert.match(r.note, /never activates blocking/);
  });

  it("today: real OpenShell 0.1.5 has no recorded startup-probe pass, so nothing is eligible", () => {
    const r = assessOpenShellActivation(ready());
    assert.equal(r.eligible_for_blocking, false);
    assert.deepEqual(failed(r), ["version"]);
    assert.ok(OPENSHELL_RELEASED_STABLE.includes("0.1.5"));
  });

  it("an empty or non-object manifest is refused, never eligible", () => {
    for (const bad of [undefined, null, [], "x", 3]) {
      const r = assessOpenShellActivation(bad, { assess: PASSED });
      assert.equal(r.eligible_for_blocking, false);
    }
    const r = assessOpenShellActivation({}, { assess: PASSED });
    assert.equal(r.eligible_for_blocking, false);
    assert.ok(r.checks.every((c) => !c.ok), "every check fails on an empty manifest");
  });

  describe("version: released releases only", () => {
    it("a prerelease never qualifies, even with a probe pass", () => {
      refuses("version", (m) => (m.openshell_version = "0.1.6-pre.4"));
      refuses("version", (m) => (m.openshell_version = "0.1.3-pre.4"));
      refuses("version", (m) => (m.openshell_version = "0.2.0"));
    });
    it("a released version without a probe pass does not qualify", () => {
      const m = ready();
      const r = assessOpenShellActivation(m, {
        assess: () => ({ status: "unverified", reason: "no recorded pass", advisories: [] }),
      });
      assert.deepEqual(failed(r), ["version"]);
    });
  });

  describe("missing required AtlaSent request-inspection middleware", () => {
    it("no registration at all", () => {
      refuses(["guard_registered", "policy_attachment", "fail_closed"], (m) => (m.gateway_middleware = []));
    });
    it("the named registration is absent, or is a built-in", () => {
      refuses(["guard_registered", "policy_attachment", "fail_closed"], (m) => (m.gateway_middleware[0].name = "other"));
      const m = ready() as Manifest;
      m.guard_registration = "openshell/regex";
      assert.equal(assessOpenShellActivation(m, { assess: PASSED }).eligible_for_blocking, false);
    });
    it("a registered service that is not the AtlaSent guard", () => {
      refuses("guard_registered", (m) => (m.guard_describe.name = "content-guard"));
    });
    it("an unauthenticated (insecure transport) registration", () => {
      refuses("guard_registered", (m) => (m.gateway_middleware[0].allow_insecure_transport = true));
    });
    it("a provider path with no guard attached", () => {
      refuses(["policy_attachment", "fail_closed"], (m) => (m.network_middlewares = { regex: { middleware: "openshell/regex", endpoints: { include: ["api.atlasent.io"] } } }));
    });
    it("the guard attached to other hosts only, or excluded from the AtlaSent host", () => {
      refuses(["policy_attachment", "fail_closed"], (m) => (m.network_middlewares["atlasent-guard"].endpoints.include = ["api.example.com"]));
      refuses(["policy_attachment", "fail_closed"], (m) => (m.network_middlewares["atlasent-guard"].endpoints.exclude = ["*.atlasent.io"]));
      refuses(["policy_attachment", "fail_closed"], (m) => (m.network_middlewares["atlasent-guard"].endpoints.include = ["*.atlasent.io"]));
    });
  });

  describe("response-only or incomplete middleware capability", () => {
    it("response-only bindings cannot be reported as request enforcement", () => {
      const r = refuses("guard_request_binding", (m) => {
        m.guard_describe.bindings = [
          { operation: "SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_RESPONSE", phase: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_RETURN" },
        ];
      });
      assert.match(r.checks.find((c) => c.id === "guard_request_binding")!.detail, /cannot be reported as request enforcement/);
    });
    it("WebSocket-only, wrong phase, numeric response enum and no bindings are all refused", () => {
      refuses("guard_request_binding", (m) => (m.guard_describe.bindings = [{ operation: 2, phase: 1 }]));
      refuses("guard_request_binding", (m) => (m.guard_describe.bindings = [{ operation: 1, phase: 2 }]));
      refuses("guard_request_binding", (m) => (m.guard_describe.bindings = [{ operation: 3, phase: 1 }]));
      refuses("guard_request_binding", (m) => (m.guard_describe.bindings = []));
    });
    it("the numeric form of the request binding is accepted", () => {
      const m = ready() as Manifest;
      m.guard_describe.bindings = [{ operation: 1, phase: 1 }];
      assert.equal(assessOpenShellActivation(m, { assess: PASSED }).eligible_for_blocking, true);
    });
    it("a required experimental capability (http-session) is refused", () => {
      refuses("guard_capabilities", (m) =>
        m.guard_describe.extension.required_capabilities.push("openshell.supervisor-middleware.http-session"),
      );
      refuses("guard_capabilities", (m) => (m.guard_describe.extension.supported_capabilities = []));
    });
  });

  describe("guard unavailable / timeout / transport error", () => {
    it("fail_open is refused; omitted on_error is OpenShell's fail_closed default", () => {
      refuses("fail_closed", (m) => (m.network_middlewares["atlasent-guard"].on_error = "fail_open"));
      const m = ready() as Manifest;
      delete m.network_middlewares["atlasent-guard"].on_error;
      assert.equal(assessOpenShellActivation(m, { assess: PASSED }).eligible_for_blocking, true);
    });
    it("a fail-closed setting never shown to refuse is not enough", () => {
      refuses("failure_probe", (m) => delete m.failure_probe);
      refuses("failure_probe", (m) => (m.failure_probe.error = "middleware_denied"));
      refuses("failure_probe", (m) => (m.failure_probe.executed = true));
      refuses("failure_probe", (m) => delete m.failure_probe.executed);
    });
  });

  describe("supervisor/config handoff and stale generation", () => {
    it("no proof from the running supervisor: blocking not established", () => {
      refuses("current_supervisor_binding", (m) => delete m.binding_proof);
    });
    it("a proof from an older generation does not carry over", () => {
      const r = refuses("current_supervisor_binding", (m) => (m.binding_proof.policy_generation = 6));
      assert.match(r.checks.find((c) => c.id === "current_supervisor_binding")!.detail, /old supervisor or config/);
      refuses("failure_probe", (m) => (m.failure_probe.policy_generation = 6));
    });
    it("a proof from another sandbox does not carry over", () => {
      refuses("current_supervisor_binding", (m) => (m.binding_proof.sandbox_id = "sbx_OTHER"));
    });
    it("an unknown current generation is not comparable, so nothing is proven", () => {
      const m = ready() as Manifest;
      delete m.supervisor.policy_generation;
      const r = assessOpenShellActivation(m, { assess: PASSED });
      assert.deepEqual(failed(r), ["current_supervisor_binding", "failure_probe"]);
    });
    it("the guard must have seen the probe, and the runtime must have attested the workload", () => {
      refuses("current_supervisor_binding", (m) => (m.binding_proof.guard_observed = false));
      refuses("current_supervisor_binding", (m) => (m.binding_proof.workload_attested = "true"));
    });
  });
});

describe("atlasent-openshell activation-check", () => {
  async function cli(args: string[]): Promise<{ code: number; out: string }> {
    const write = process.stderr.write.bind(process.stderr);
    let out = "";
    process.stderr.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      return { code: await main(args, {}), out };
    } finally {
      process.stderr.write = write;
    }
  }

  it("exits 78 and reports watch_only for today's real 0.1.5 manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osh-activation-"));
    const file = join(dir, "manifest.json");
    writeFileSync(file, JSON.stringify(ready()));
    const { code, out } = await cli(["activation-check", "--manifest", file]);
    assert.equal(code, EXIT.NOT_ELIGIBLE);
    const report = JSON.parse(out.trim().split("\n").pop()!);
    assert.equal(report.eligible_for_blocking, false);
    assert.equal(report.posture, "watch_only");
  });

  it("a missing or unreadable manifest is a usage error, never eligible", async () => {
    assert.equal((await cli(["activation-check"])).code, EXIT.USAGE);
    assert.equal((await cli(["activation-check", "--manifest", "/nonexistent/manifest.json"])).code, EXIT.USAGE);
  });
});
