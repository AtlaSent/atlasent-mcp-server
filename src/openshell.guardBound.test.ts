/**
 * Guard-bound workload mode (opt-in). OpenShell's Docker driver gives the
 * workload no sandbox ID, so the adapter cannot send one. In "guard" mode it
 * sends NO workload and the AtlaSent workload guard (`fill_absent_workload`)
 * adds the gateway-verified one. These tests pin what the adapter side may
 * and may not do: it never invents an ID, never sends a label as one, and a
 * real ID still wins and is still checked.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ActionContext, Decision } from "./decision.js";
import { authorize } from "./engine.js";
import {
  GUARD_BOUND_SANDBOX_ID,
  GUARD_BOUND_UNATTESTED,
  OpenShellAuthorityAdapter,
  parseSandboxContext,
  toActionContext,
  workloadBinding,
} from "./openshell.js";
import { EXIT, runGoverned } from "./openshellRun.js";
import { main, workloadBindingModeFrom } from "./openshellCli.js";

const ENVELOPE = { action_type: "data.export", actor_id: "agent:42", environment: "production", target_id: "warehouse" };

// What the runtime returns when the guard's attestation verified.
const ATTESTED_ALLOW: Decision = { decision: "allow", permit_token: "pt_1", workload_attested: true };

function adapter(mode: "adapter" | "guard", decision: Decision = ATTESTED_ALLOW) {
  const evaluated: ActionContext[] = [];
  const verified: ActionContext[] = [];
  const a = new OpenShellAuthorityAdapter({
    workloadBinding: mode,
    authorize: async (ctx) => {
      evaluated.push(ctx);
      return decision;
    },
    verify: async (_t, ctx) => {
      verified.push(ctx);
      return { outcome: "verified", valid: true };
    },
  });
  return { a, evaluated, verified };
}

describe("guard-bound workload mode", () => {
  it("default mode still refuses a context with no sandbox_id (positive control)", async () => {
    const { a, evaluated } = adapter("adapter");
    const r = await a.evaluate(ENVELOPE, { sandbox_name: "payments-agent" });
    assert.equal(r.outcome, "DENY");
    assert.equal(evaluated.length, 0);
  });

  it("guard mode sends no workload, and never a label in its place", async () => {
    const { a, evaluated } = adapter("guard");
    const r = await a.evaluate(ENVELOPE, { sandbox_name: "payments-agent", workspace: "team-a" });
    assert.equal(r.outcome, "PERMIT");
    assert.equal(evaluated.length, 1);
    assert.equal(evaluated[0].workload, undefined, "the guard adds the verified workload; the adapter adds nothing");
    assert.equal(JSON.stringify(evaluated[0]).includes(GUARD_BOUND_SANDBOX_ID), false, "the placeholder never leaves the process");
  });

  it("guard mode verifies with no workload too, so the guard fills verify as well", async () => {
    const { a, verified } = adapter("guard");
    const p = await a.evaluate(ENVELOPE, {});
    assert.equal(p.outcome, "PERMIT");
    const v = await a.verifyBeforeExecute((p as { permit_token: string }).permit_token, ENVELOPE, {});
    assert.equal(v.execute, true);
    assert.equal(verified[0].workload, undefined);
  });

  it("a real sandbox_id in guard mode is used and checked as usual", async () => {
    const { a, evaluated } = adapter("guard");
    await a.evaluate(ENVELOPE, { sandbox_id: "sbx_1" });
    assert.equal(evaluated[0].workload?.id, "sbx_1");
    const v = await a.verifyBeforeExecute("pt_1", ENVELOPE, {});
    assert.equal(v.execute, false, "a permit evaluated for a real sandbox does not verify guard-bound");
  });

  it("a permit evaluated guard-bound does not verify under a real sandbox_id", async () => {
    const { a, verified } = adapter("guard");
    await a.evaluate(ENVELOPE, {});
    const v = await a.verifyBeforeExecute("pt_1", ENVELOPE, { sandbox_id: "sbx_other" });
    assert.equal(v.execute, false);
    assert.equal(verified.length, 0);
  });

  it("guard mode still refuses a malformed id, a missing context and a non-object", () => {
    for (const raw of [undefined, null, [], "sbx_1", { sandbox_id: "sbx 1" }, { sandbox_id: 42 }]) {
      assert.equal(parseSandboxContext(raw, { mode: "guard" }).ok, false, JSON.stringify(raw));
    }
    assert.equal(parseSandboxContext({ sandbox_id: "   " }, { mode: "guard" }).ok, true, "blank counts as absent");
  });

  it("the placeholder can never be a real sandbox_id", () => {
    assert.equal(parseSandboxContext({ sandbox_id: GUARD_BOUND_SANDBOX_ID }).ok, false);
    assert.equal(parseSandboxContext({ sandbox_id: GUARD_BOUND_SANDBOX_ID }, { mode: "guard" }).ok, false);
    assert.equal(workloadBinding({ sandbox_id: GUARD_BOUND_SANDBOX_ID }), undefined);
    assert.equal(toActionContext(ENVELOPE, { sandbox_id: GUARD_BOUND_SANDBOX_ID }).workload, undefined);
  });

  it("a policy-generation change still forces a fresh evaluation in guard mode", async () => {
    const { a, verified } = adapter("guard");
    await a.evaluate(ENVELOPE, { policy_generation: 1 });
    const v = await a.verifyBeforeExecute("pt_1", ENVELOPE, { policy_generation: 2 });
    assert.equal(v.execute, false);
    assert.equal(verified.length, 0);
  });

  it("runGoverned executes once in guard mode, after verify", async () => {
    const { a } = adapter("guard");
    const spawned: string[][] = [];
    const r = await runGoverned(
      {
        adapter: a,
        sandbox: () => ({}),
        spawn: async (argv) => {
          spawned.push(argv);
          return { started: true, code: 0, signal: null, timed_out: false };
        },
      },
      { envelope: ENVELOPE, argv: ["deploy.sh"] },
    );
    assert.equal(r.outcome, "EXECUTED");
    assert.deepEqual(spawned, [["deploy.sh"]]);
  });
});

describe("ATLASENT_OPENSHELL_WORKLOAD_BINDING", () => {
  it("defaults to adapter and accepts only adapter or guard", () => {
    assert.equal(workloadBindingModeFrom({}), "adapter");
    assert.equal(workloadBindingModeFrom({ ATLASENT_OPENSHELL_WORKLOAD_BINDING: "adapter" }), "adapter");
    assert.equal(workloadBindingModeFrom({ ATLASENT_OPENSHELL_WORKLOAD_BINDING: "guard" }), "guard");
    for (const bad of ["Guard", "gaurd", "true", "none"]) {
      assert.equal(typeof workloadBindingModeFrom({ ATLASENT_OPENSHELL_WORKLOAD_BINDING: bad }), "object", bad);
    }
  });

  it("an unknown value is a usage error before anything runs", async () => {
    const realWrite = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    process.stderr.write = ((c: string) => (lines.push(String(c)), true)) as typeof process.stderr.write;
    try {
      const code = await main(["check"], { ATLASENT_OPENSHELL_WORKLOAD_BINDING: "gaurd" });
      assert.equal(code, EXIT.USAGE);
      const guardCheck = await main(["check"], { ATLASENT_OPENSHELL_WORKLOAD_BINDING: "guard" });
      assert.equal(guardCheck, 0, "check passes with no sandbox_id in guard mode");
      const plainCheck = await main(["check"], {});
      assert.equal(plainCheck, EXIT.USAGE, "and still refuses without one by default");
    } finally {
      process.stderr.write = realWrite;
    }
    assert.ok(lines.some((l) => l.includes('"workload_binding":"guard"')));
  });
});

describe("guard-bound mode requires the runtime to report workload_attested", () => {
  it("an allow without workload_attested is refused, and its permit is never usable", async () => {
    const { a, verified } = adapter("guard", { decision: "allow", permit_token: "pt_unbound" });
    const r = await a.evaluate(ENVELOPE, {});
    assert.equal(r.outcome, "DENY");
    assert.deepEqual((r as { reasons: string[] }).reasons, [GUARD_BOUND_UNATTESTED]);
    const v = await a.verifyBeforeExecute("pt_unbound", ENVELOPE, {});
    assert.equal(v.execute, false, "the unattested permit was never recorded");
    assert.equal(verified.length, 0);
  });

  it("a hold without workload_attested is refused instead of waited on", async () => {
    let waited = 0;
    const a = new OpenShellAuthorityAdapter({
      workloadBinding: "guard",
      authorize: async () => ({ decision: "hold", reasons: ["approval"], approval_request_id: "apr_1" }),
      awaitApproval: async () => {
        waited++;
        return { outcome: "approved", permit_token: "pt", approval_request_id: "apr_1" };
      },
    });
    const r = await a.evaluate(ENVELOPE, {});
    assert.equal(r.outcome, "DENY");
    const resolved = await a.resolveHold("apr_1", {}, { max_wait_ms: 1000 });
    assert.equal(resolved.outcome, "DENY", "no HOLD was recorded to resolve");
    assert.equal(waited, 0);
  });

  it("an attested hold is held as usual", async () => {
    const a = new OpenShellAuthorityAdapter({
      workloadBinding: "guard",
      authorize: async () => ({ decision: "hold", reasons: ["approval"], approval_request_id: "apr_1", workload_attested: true }),
    });
    assert.equal((await a.evaluate(ENVELOPE, {})).outcome, "HOLD");
  });

  it("the requirement applies only when guard-bound: a real sandbox_id needs no attestation", async () => {
    const { a } = adapter("guard", { decision: "allow", permit_token: "pt_1" });
    assert.equal((await a.evaluate(ENVELOPE, { sandbox_id: "sbx_1" })).outcome, "PERMIT");
    const { a: plain } = adapter("adapter", { decision: "allow", permit_token: "pt_2" });
    assert.equal((await plain.evaluate(ENVELOPE, { sandbox_id: "sbx_1" })).outcome, "PERMIT", "default mode is unchanged");
  });

  it("a deny passes through as a deny", async () => {
    const { a } = adapter("guard", { decision: "deny", reasons: ["no"] });
    const r = await a.evaluate(ENVELOPE, {});
    assert.equal(r.outcome, "DENY");
    assert.deepEqual((r as { reasons: string[] }).reasons, ["no"]);
  });
});

describe("engine: workload_attested is carried only when the runtime says exactly true", () => {
  const env = { ATLASENT_MODE: "remote", ATLASENT_API_KEY: "ask_test_x", ATLASENT_BASE_URL: "https://rt.example/functions/v1" };
  async function evaluateWith(reply: Record<string, unknown>): Promise<Decision> {
    const saved = { ...process.env };
    const realFetch = globalThis.fetch;
    Object.assign(process.env, env);
    globalThis.fetch = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      const body = path.endsWith("/v1-evaluate") ? reply : { error: "not_found" };
      return new Response(JSON.stringify(body), { status: path.endsWith("/v1-evaluate") ? 200 : 404 });
    }) as typeof fetch;
    try {
      return await authorize({ action_type: "data.export", actor_id: "agent:42", environment: "production" });
    } finally {
      globalThis.fetch = realFetch;
      process.env = saved;
    }
  }

  it("true is carried on allow and on hold", async () => {
    const allow = await evaluateWith({ decision: "allow", permit_token: "pt", workload_attested: true });
    assert.equal(allow.decision, "allow");
    assert.equal((allow as { workload_attested?: true }).workload_attested, true);
    const hold = await evaluateWith({ decision: "hold", approval_request_id: "apr", workload_attested: true });
    assert.equal((hold as { workload_attested?: true }).workload_attested, true);
  });

  it("anything other than literal true is not an attestation", async () => {
    for (const v of ["true", 1, {}, null, false]) {
      const d = await evaluateWith({ decision: "allow", permit_token: "pt", workload_attested: v });
      assert.equal("workload_attested" in d, false, JSON.stringify(v));
    }
    const absent = await evaluateWith({ decision: "allow", permit_token: "pt" });
    assert.equal("workload_attested" in absent, false);
  });
});
