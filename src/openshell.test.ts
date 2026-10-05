import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { ActionContext, Decision, VerifyResult } from "./decision.js";
import type { AwaitApprovalParams, AwaitApprovalResult } from "./engine.js";
import { authorize } from "./engine.js";
import {
  OpenShellAuthorityAdapter,
  assessOpenShellVersion,
  parseActionEnvelope,
  parseSandboxContext,
  policyGenerationChanged,
  runStartupGenerationProbe,
  toActionContext,
  type ProbeAttempt,
} from "./openshell.js";

const SANDBOX = { sandbox_id: "sbx_01J9ZK", sandbox_name: "payments-agent", workspace: "team-a", policy_generation: 3 };
const ENVELOPE = {
  action_type: "production.deploy",
  actor_id: "agent:42",
  environment: "production",
  target_id: "api-service",
  change_plan: { operation: "deploy", revision: "abc123" },
};

function fakeDeps(decisions: Decision[]) {
  const calls: { authorize: ActionContext[]; verify: Array<{ token: string; ctx: ActionContext }>; await: AwaitApprovalParams[] } = {
    authorize: [],
    verify: [],
    await: [],
  };
  let i = 0;
  return {
    calls,
    deps: {
      authorize: async (ctx: ActionContext): Promise<Decision> => {
        calls.authorize.push(ctx);
        const d = decisions[Math.min(i, decisions.length - 1)];
        i += 1;
        return d;
      },
      verify: async (token: string, ctx: ActionContext): Promise<VerifyResult> => {
        calls.verify.push({ token, ctx });
        return { outcome: "verified", valid: true };
      },
      awaitApproval: async (p: AwaitApprovalParams): Promise<AwaitApprovalResult> => {
        calls.await.push(p);
        return { outcome: "approved", permit_token: "pt_from_approval", approval_request_id: p.approval_request_id };
      },
    },
  };
}

describe("OpenShell sandbox identity", () => {
  it("refuses a missing or blank sandbox_id and never falls back to the name", () => {
    for (const raw of [undefined, {}, { sandbox_id: "" }, { sandbox_id: "   " }, { sandbox_name: "payments-agent", workspace: "w" }]) {
      const r = parseSandboxContext(raw);
      assert.equal(r.ok, false, JSON.stringify(raw));
    }
  });

  it("refuses a malformed sandbox_id", () => {
    for (const id of [" sbx", "sbx 1", "sbx\n1", "x".repeat(257)]) {
      assert.equal(parseSandboxContext({ sandbox_id: id }).ok, false, JSON.stringify(id));
    }
  });

  it("keeps labels as nested display evidence, never as the identity", () => {
    const r = parseSandboxContext({ ...SANDBOX, sandbox_name: " payments\u0000-agent ", workspace: "" });
    assert.ok(r.ok);
    const ctx = toActionContext(ENVELOPE, r.sandbox);
    assert.deepEqual(ctx.workload, {
      kind: "openshell_sandbox",
      id: "sbx_01J9ZK",
      labels: { sandbox_name: "payments-agent" },
    });
    assert.equal(ctx.actor_id, "agent:42");
  });

  it("two sandboxes sharing a name are still distinct identities", () => {
    const a = parseSandboxContext({ sandbox_id: "sbx_a", sandbox_name: "dup" });
    const b = parseSandboxContext({ sandbox_id: "sbx_b", sandbox_name: "dup" });
    assert.ok(a.ok && b.ok);
    assert.notEqual(toActionContext(ENVELOPE, a.sandbox).workload?.id, toActionContext(ENVELOPE, b.sandbox).workload?.id);
  });
});

describe("OpenShell approvals never satisfy an AtlaSent HOLD", () => {
  it("refuses an envelope carrying a Policy Advisor approval, naming the field", () => {
    for (const field of ["approvals", "policy_advisor_approval", "openshell_approval", "proposal_id"]) {
      const r = parseActionEnvelope({ ...ENVELOPE, [field]: ["ok"] });
      assert.equal(r.ok, false);
      assert.match((r as { reason: string }).reason, new RegExp(field));
      assert.match((r as { reason: string }).reason, /reachability only/);
    }
  });

  it("refuses unknown fields rather than forwarding them", () => {
    assert.equal(parseActionEnvelope({ ...ENVELOPE, approved_reachability: true }).ok, false);
  });

  it("never sets context.approvals, so nothing OpenShell-derived reaches the evaluator as an approval", async () => {
    const { deps, calls } = fakeDeps([{ decision: "hold", reasons: ["needs approval"], approval_request_id: "apr_1" }]);
    const adapter = new OpenShellAuthorityAdapter(deps);
    const res = await adapter.evaluate(ENVELOPE, SANDBOX);
    assert.equal(res.outcome, "HOLD");
    assert.equal(calls.authorize[0].approvals, undefined);
  });

  it("an OpenShell-approved envelope is DENY, and the evaluator is never called", async () => {
    const { deps, calls } = fakeDeps([{ decision: "allow", permit_token: "pt_x" }]);
    const adapter = new OpenShellAuthorityAdapter(deps);
    const res = await adapter.evaluate({ ...ENVELOPE, policy_advisor_approval: { id: "pa_1" } }, SANDBOX);
    assert.equal(res.outcome, "DENY");
    assert.equal(calls.authorize.length, 0);
  });

  it("a HOLD resolves only through the AtlaSent approval wait", async () => {
    const { deps, calls } = fakeDeps([{ decision: "hold", reasons: ["needs approval"], approval_request_id: "apr_1" }]);
    const adapter = new OpenShellAuthorityAdapter(deps);
    await adapter.evaluate(ENVELOPE, SANDBOX);
    const res = await adapter.resolveHold("apr_1", SANDBOX, { max_wait_ms: 10 });
    assert.equal(res.outcome, "PERMIT");
    assert.equal(calls.await.length, 1);
    assert.equal(calls.await[0].approval_request_id, "apr_1");
  });
});

describe("OpenShell policy changes force a fresh AtlaSent evaluation", () => {
  it("compares generations conservatively", () => {
    assert.equal(policyGenerationChanged(3, 3), false);
    assert.equal(policyGenerationChanged(3, "3"), false);
    assert.equal(policyGenerationChanged(3, 4), true);
    assert.equal(policyGenerationChanged(3, undefined), true);
    assert.equal(policyGenerationChanged(undefined, 3), true);
    assert.equal(policyGenerationChanged(undefined, undefined), false);
  });

  it("a HOLD from an older generation is re-evaluated, not claimed", async () => {
    const { deps, calls } = fakeDeps([
      { decision: "hold", reasons: ["needs approval"], approval_request_id: "apr_1" },
      { decision: "hold", reasons: ["needs approval"], approval_request_id: "apr_2" },
    ]);
    const adapter = new OpenShellAuthorityAdapter(deps);
    await adapter.evaluate(ENVELOPE, SANDBOX);
    const res = await adapter.resolveHold("apr_1", { ...SANDBOX, policy_generation: 4 }, { max_wait_ms: 10 });
    assert.equal(calls.await.length, 0, "the old approval must not be claimed");
    assert.equal(calls.authorize.length, 2);
    assert.equal(res.outcome, "HOLD");
    assert.equal((res as { approval_request_id?: string }).approval_request_id, "apr_2");
  });

  it("an unconsumed permit from an older generation is not used; the caller is told to re-evaluate", async () => {
    const { deps, calls } = fakeDeps([{ decision: "allow", permit_token: "pt_1" }]);
    const adapter = new OpenShellAuthorityAdapter(deps);
    await adapter.evaluate(ENVELOPE, SANDBOX);
    const v = await adapter.verifyBeforeExecute("pt_1", ENVELOPE, { ...SANDBOX, policy_generation: 4 });
    assert.equal(v.execute, false);
    assert.equal((v as { reevaluate?: true }).reevaluate, true);
    assert.equal(calls.verify.length, 0);
  });

  it("a spurious startup bump (OpenShell 0.1.2) costs one re-evaluation and never an inherited allow", async () => {
    // Generation advances with nothing else changed, as in NVIDIA/OpenShell#3994.
    const { deps, calls } = fakeDeps([
      { decision: "allow", permit_token: "pt_gen3" },
      { decision: "allow", permit_token: "pt_gen4" },
    ]);
    const adapter = new OpenShellAuthorityAdapter(deps);
    await adapter.evaluate(ENVELOPE, SANDBOX);
    const bumped = { ...SANDBOX, policy_generation: 4 };
    const first = await adapter.verifyBeforeExecute("pt_gen3", ENVELOPE, bumped);
    assert.equal(first.execute, false);
    const again = await adapter.evaluate(ENVELOPE, bumped);
    assert.equal(again.outcome, "PERMIT");
    const second = await adapter.verifyBeforeExecute("pt_gen4", ENVELOPE, bumped);
    assert.equal(second.execute, true);
    assert.equal(calls.authorize.length, 2);
    assert.deepEqual(calls.verify.map((c) => c.token), ["pt_gen4"]);
  });
});

describe("OpenShell execution boundary", () => {
  it("refuses a permit presented from a different sandbox_id, even with the same name", async () => {
    const { deps, calls } = fakeDeps([{ decision: "allow", permit_token: "pt_1" }]);
    const adapter = new OpenShellAuthorityAdapter(deps);
    await adapter.evaluate(ENVELOPE, SANDBOX);
    const v = await adapter.verifyBeforeExecute("pt_1", ENVELOPE, { ...SANDBOX, sandbox_id: "sbx_other" });
    assert.equal(v.execute, false);
    assert.equal(calls.verify.length, 0);
  });

  it("refuses a HOLD claim from a different sandbox_id", async () => {
    const { deps, calls } = fakeDeps([{ decision: "hold", reasons: ["r"], approval_request_id: "apr_1" }]);
    const adapter = new OpenShellAuthorityAdapter(deps);
    await adapter.evaluate(ENVELOPE, SANDBOX);
    const res = await adapter.resolveHold("apr_1", { ...SANDBOX, sandbox_id: "sbx_other" }, { max_wait_ms: 10 });
    assert.equal(res.outcome, "DENY");
    assert.equal(calls.await.length, 0);
  });

  it("refuses a changed action", async () => {
    const { deps } = fakeDeps([{ decision: "allow", permit_token: "pt_1" }]);
    const adapter = new OpenShellAuthorityAdapter(deps);
    await adapter.evaluate(ENVELOPE, SANDBOX);
    const v = await adapter.verifyBeforeExecute("pt_1", { ...ENVELOPE, target_id: "billing-service" }, SANDBOX);
    assert.equal(v.execute, false);
  });

  it("is single-use on the adapter side", async () => {
    const { deps } = fakeDeps([{ decision: "allow", permit_token: "pt_1" }]);
    const adapter = new OpenShellAuthorityAdapter(deps);
    await adapter.evaluate(ENVELOPE, SANDBOX);
    assert.equal((await adapter.verifyBeforeExecute("pt_1", ENVELOPE, SANDBOX)).execute, true);
    assert.equal((await adapter.verifyBeforeExecute("pt_1", ENVELOPE, SANDBOX)).execute, false);
  });

  it("fails closed when the evaluator throws", async () => {
    const adapter = new OpenShellAuthorityAdapter({
      authorize: async () => {
        throw new Error("boom");
      },
    });
    const res = await adapter.evaluate(ENVELOPE, SANDBOX);
    assert.equal(res.outcome, "DENY");
  });
});

describe("workload binding reaches /v1-evaluate", () => {
  const saved = { ...process.env };
  let bodies: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    bodies = [];
    process.env.ATLASENT_MODE = "remote";
    process.env.ATLASENT_API_KEY = "ask_test_dummy";
    process.env.ATLASENT_BASE_URL = "https://example.invalid/functions/v1";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1-evaluate")) {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ decision: "deny", deny_code: "TEST", reasons: ["test"] }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env = { ...saved };
  });

  it("sends context.workload with the sandbox_id and nested labels", async () => {
    const r = parseSandboxContext(SANDBOX);
    assert.ok(r.ok);
    await authorize(toActionContext({ action_type: "data.export", actor_id: "agent:42", environment: "test" }, r.sandbox));
    assert.equal(bodies.length, 1);
    const ctx = bodies[0].context as Record<string, unknown>;
    assert.deepEqual(ctx.workload, {
      kind: "openshell_sandbox",
      id: "sbx_01J9ZK",
      labels: { sandbox_name: "payments-agent", workspace: "team-a" },
    });
    assert.equal(ctx.approvals, undefined);
  });
});

describe("OpenShell version + startup policy-generation probe", () => {
  it("flags 0.1.2 as known-affected and never calls any version ready", () => {
    assert.equal(assessOpenShellVersion("v0.1.2").status, "known_affected");
    assert.equal(assessOpenShellVersion("0.1.3").status, "unverified");
  });

  function fakeClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it("positive control: reproduces the 0.1.2 failure (drop ~10s after start) and FAILS", async () => {
    const clock = fakeClock();
    const send = async (): Promise<ProbeAttempt> => {
      const at = clock.now();
      if (at < 10_000) return { ok: true, policy_generation: 1 };
      if (at === 10_000) return { ok: false, kind: "dropped", detail: "Remote end closed connection without response", policy_generation: 2 };
      return { ok: true, policy_generation: 2 };
    };
    const report = await runStartupGenerationProbe({ send, ...clock });
    assert.equal(report.passed, false);
    assert.deepEqual(report.failures.map((f) => [f.at_ms, f.kind]), [[10_000, "dropped"]]);
    assert.deepEqual(report.generation_changes, [{ at_ms: 10_000, from: "1", to: "2" }]);
  });

  it("passes when every request across the window succeeds", async () => {
    const clock = fakeClock();
    const report = await runStartupGenerationProbe({ send: async () => ({ ok: true, policy_generation: 1 }), ...clock });
    assert.equal(report.passed, true);
    assert.equal(report.attempts, 40);
  });

  it("a thrown send is a failure, and zero attempts is never a pass", async () => {
    const clock = fakeClock();
    const thrown = await runStartupGenerationProbe({
      send: async () => {
        throw new Error("ECONNRESET");
      },
      duration_ms: 1000,
      ...clock,
    });
    assert.equal(thrown.passed, false);
    const empty = await runStartupGenerationProbe({ send: async () => ({ ok: true }), duration_ms: 0, ...fakeClock() });
    assert.equal(empty.passed, false);
  });
});
