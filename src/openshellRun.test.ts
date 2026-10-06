import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActionContext, Decision, VerifyResult } from "./decision.js";
import type { AwaitApprovalParams, AwaitApprovalResult, CircuitTripReport, CircuitTripRecord } from "./engine.js";
import { verify } from "./engine.js";
import { CircuitBreaker } from "./governedAction.js";
import { OpenShellAuthorityAdapter } from "./openshell.js";
import { EXIT, runGoverned, sandboxContextFrom, type SpawnOutcome } from "./openshellRun.js";
import { parseArgs } from "./openshellCli.js";

const SANDBOX = { sandbox_id: "sbx_01J9ZK", sandbox_name: "payments-agent", workspace: "team-a", policy_generation: 3 };
const ENVELOPE = { action_type: "data.export", actor_id: "agent:42", environment: "production", target_id: "warehouse" };

function harness(decisions: Decision[], opts: { verify?: VerifyResult; spawn?: SpawnOutcome; approval?: AwaitApprovalResult } = {}) {
  const calls = { authorize: 0, verify: [] as ActionContext[], spawn: [] as string[][], trips: [] as CircuitTripReport[] };
  let i = 0;
  const adapter = new OpenShellAuthorityAdapter({
    authorize: async () => decisions[Math.min(i++, decisions.length - 1)],
    verify: async (_t: string, ctx: ActionContext) => {
      calls.verify.push(ctx);
      return opts.verify ?? { outcome: "verified", valid: true };
    },
    awaitApproval: async (p: AwaitApprovalParams) =>
      opts.approval ?? { outcome: "approved", permit_token: "pt_approved", approval_request_id: p.approval_request_id },
  });
  calls.authorize = 0;
  const deps = {
    adapter,
    sandbox: () => SANDBOX as unknown,
    spawn: async (argv: string[]) => {
      calls.spawn.push(argv);
      return opts.spawn ?? { started: true as const, code: 0, signal: null, timed_out: false };
    },
    reportTrip: async (r: CircuitTripReport): Promise<CircuitTripRecord> => {
      calls.trips.push(r);
      return { recorded: true, trip_id: "trip_1" };
    },
  };
  return { deps, calls, count: () => i };
}

describe("atlasent-openshell run", () => {
  it("ALLOW → verify → executes exactly once and passes the exit code through", async () => {
    const h = harness([{ decision: "allow", permit_token: "pt_1" }], { spawn: { started: true, code: 3, signal: null, timed_out: false } });
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(r.outcome, "EXECUTED");
    assert.equal(r.exit_code, 3);
    assert.deepEqual(h.calls.spawn, [["deploy.sh"]]);
    assert.equal(h.calls.verify.length, 1);
    assert.equal(h.calls.verify[0].workload?.id, "sbx_01J9ZK");
    assert.equal(h.calls.trips.length, 0, "a known non-zero exit is not a trip");
  });

  it("DENY never executes", async () => {
    const h = harness([{ decision: "deny", reasons: ["no"] }]);
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(r.exit_code, EXIT.DENY);
    assert.equal(h.calls.spawn.length, 0);
  });

  it("a failed verify never executes", async () => {
    const h = harness([{ decision: "allow", permit_token: "pt_1" }], {
      verify: { outcome: "invalid", valid: false, reasons: ["PERMIT_BINDING_MISMATCH"] },
    });
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(r.exit_code, EXIT.DENY);
    assert.equal(h.calls.spawn.length, 0);
  });

  it("HOLD without --wait-ms returns HOLD and never executes", async () => {
    const h = harness([{ decision: "hold", reasons: ["approval"], approval_request_id: "apr_1" }]);
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(r.exit_code, EXIT.HOLD_UNRESOLVED);
    assert.equal(r.display?.sandbox_name, "payments-agent", "approval UI labels are carried");
    assert.equal(h.calls.spawn.length, 0);
  });

  it("HOLD resolved through AtlaSent approval then executes", async () => {
    const h = harness([{ decision: "hold", reasons: ["approval"], approval_request_id: "apr_1" }]);
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"], wait_ms: 10 });
    assert.equal(r.outcome, "EXECUTED");
    assert.equal(h.calls.spawn.length, 1);
  });

  it("an OpenShell Policy Advisor approval in the envelope is refused before anything runs", async () => {
    const h = harness([{ decision: "allow", permit_token: "pt_1" }]);
    const r = await runGoverned(h.deps, { envelope: { ...ENVELOPE, policy_advisor_approval: { id: "pa_1" } }, argv: ["x"] });
    assert.equal(r.exit_code, EXIT.DENY);
    assert.equal(h.count(), 0);
    assert.equal(h.calls.spawn.length, 0);
  });

  it("a generation change between evaluate and verify re-evaluates instead of executing on the old permit", async () => {
    const h = harness([
      { decision: "allow", permit_token: "pt_gen3" },
      { decision: "allow", permit_token: "pt_gen4" },
    ]);
    let reads = 0;
    // evaluate reads gen 3; verify sees gen 4; from then on gen 4.
    h.deps.sandbox = () => ({ ...SANDBOX, policy_generation: reads++ === 0 ? 3 : 4 });
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(r.outcome, "EXECUTED");
    assert.equal(h.count(), 2);
    assert.equal(h.calls.verify.length, 1, "only the fresh permit is verified");
    assert.equal(h.calls.spawn.length, 1);
  });

  it("a generation that never settles is DENY after the bounded re-evaluations", async () => {
    const h = harness([{ decision: "allow", permit_token: "pt" }]);
    let g = 0;
    h.deps.sandbox = () => ({ ...SANDBOX, policy_generation: g++ });
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"], max_reevaluations: 2 });
    assert.equal(r.exit_code, EXIT.DENY);
    assert.equal(h.calls.spawn.length, 0);
  });

  it("killed by a signal → OUTCOME_UNKNOWN, E2 reported to the runtime and the local breaker trips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osh-"));
    const breaker = new CircuitBreaker({ stateFile: join(dir, "breaker.json") });
    const h = harness([{ decision: "allow", permit_token: "pt_1" }], {
      spawn: { started: true, code: null, signal: "SIGKILL", timed_out: false },
    });
    const r = await runGoverned({ ...h.deps, breaker }, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(r.outcome, "OUTCOME_UNKNOWN");
    assert.equal(r.exit_code, EXIT.OUTCOME_UNKNOWN);
    assert.equal(h.calls.trips.length, 1);
    assert.equal(h.calls.trips[0].condition, "E2");
    assert.equal(h.calls.trips[0].target, "warehouse");
    assert.equal((h.calls.trips[0].evidence as Record<string, unknown>).sandbox_id, "sbx_01J9ZK");
    assert.deepEqual(r.trip, { local: true, runtime: { recorded: true, trip_id: "trip_1" } });

    // The next run is stopped by the local breaker before evaluate.
    const h2 = harness([{ decision: "allow", permit_token: "pt_2" }]);
    const r2 = await runGoverned({ ...h2.deps, breaker }, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(r2.exit_code, EXIT.DENY);
    assert.equal(h2.count(), 0);
  });

  it("a timeout is also E2", async () => {
    const h = harness([{ decision: "allow", permit_token: "pt_1" }], {
      spawn: { started: true, code: null, signal: "SIGTERM", timed_out: true },
    });
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"], timeout_ms: 5 });
    assert.equal(r.outcome, "OUTCOME_UNKNOWN");
    assert.match(r.reasons[0], /timed out/);
  });

  it("a command that could not start is not a trip (nothing ran)", async () => {
    const h = harness([{ decision: "allow", permit_token: "pt_1" }], { spawn: { started: false, error: "ENOENT" } });
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["nope"] });
    assert.equal(r.exit_code, EXIT.NOT_EXECUTED);
    assert.equal(h.calls.trips.length, 0);
  });

  it("a trip report that throws is recorded as not-recorded, never as success", async () => {
    const h = harness([{ decision: "allow", permit_token: "pt_1" }], {
      spawn: { started: true, code: null, signal: "SIGKILL", timed_out: false },
    });
    h.deps.reportTrip = async () => {
      throw new Error("network down");
    };
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(r.trip?.runtime?.recorded, false);
  });

  it("missing sandbox_id → DENY, nothing runs", async () => {
    const h = harness([{ decision: "allow", permit_token: "pt_1" }]);
    h.deps.sandbox = () => ({ sandbox_name: "payments-agent" });
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(r.exit_code, EXIT.DENY);
    assert.equal(h.calls.spawn.length, 0);
  });
});

describe("sandbox context source", () => {
  it("reads OPENSHELL_SANDBOX_* env", () => {
    const read = sandboxContextFrom({ OPENSHELL_SANDBOX_ID: "sbx_a", OPENSHELL_POLICY_GENERATION: "7" }, () => "");
    assert.deepEqual(read(), { sandbox_id: "sbx_a", policy_generation: "7" });
  });

  it("uses OpenShell's own OPENSHELL_SANDBOX_ID and never treats its OPENSHELL_SANDBOX marker as the name", () => {
    // What a workload process inside an OpenShell sandbox actually sees.
    const read = sandboxContextFrom({ OPENSHELL_SANDBOX_ID: "0f3c-sbx", OPENSHELL_SANDBOX: "1" }, () => "");
    assert.deepEqual(read(), { sandbox_id: "0f3c-sbx" });
  });

  it("re-reads the context file on every call, and an unreadable file yields no sandbox", () => {
    let content = JSON.stringify({ sandbox_id: "sbx_a", policy_generation: 1 });
    const read = sandboxContextFrom({ ATLASENT_OPENSHELL_SANDBOX_CONTEXT_FILE: "/f", OPENSHELL_SANDBOX_ID: "ignored" }, () => content);
    assert.deepEqual(read(), { sandbox_id: "sbx_a", policy_generation: 1 });
    content = JSON.stringify({ sandbox_id: "sbx_a", policy_generation: 2 });
    assert.deepEqual(read(), { sandbox_id: "sbx_a", policy_generation: 2 });
    content = "{not json";
    assert.equal(read(), undefined);
  });
});

describe("CLI argument parsing", () => {
  it("splits flags from the command after --", () => {
    assert.deepEqual(parseArgs(["run", "--envelope", "-", "--wait-ms", "100", "--", "deploy.sh", "--force"]), {
      command: "run",
      flags: { envelope: "-", "wait-ms": "100" },
      argv: ["deploy.sh", "--force"],
    });
  });

  it("rejects unknown commands, stray args and value-less flags", () => {
    assert.ok("error" in parseArgs(["exec"]));
    assert.ok("error" in parseArgs(["run", "deploy.sh"]));
    assert.ok("error" in parseArgs(["run", "--envelope", "--", "x"]));
  });
});

describe("verify presents the workload binding to the runtime", () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  let bodies: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    bodies = [];
    process.env.ATLASENT_MODE = "remote";
    process.env.ATLASENT_API_KEY = "ask_test_dummy";
    process.env.ATLASENT_BASE_URL = "https://example.invalid/functions/v1";
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ valid: true, outcome: "allow" }), { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env = { ...saved };
  });

  it("sends kind + id, never the labels", async () => {
    await verify("pt_1", {
      action_type: "data.export",
      actor_id: "agent:42",
      environment: "production",
      workload: { kind: "openshell_sandbox", id: "sbx_01J9ZK", labels: { sandbox_name: "payments-agent" } },
    });
    assert.deepEqual(bodies[0].workload, { kind: "openshell_sandbox", id: "sbx_01J9ZK" });
  });

  it("sends no workload when none was bound (additive)", async () => {
    await verify("pt_1", { action_type: "data.export", actor_id: "agent:42", environment: "production" });
    assert.equal("workload" in bodies[0], false);
  });
});

