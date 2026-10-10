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
import {
  GUARD_BOUND_SANDBOX_ID,
  OpenShellAuthorityAdapter,
  parseSandboxContext,
  toActionContext,
  workloadBinding,
} from "./openshell.js";
import { EXIT, runGoverned } from "./openshellRun.js";
import { main, workloadBindingModeFrom } from "./openshellCli.js";

const ENVELOPE = { action_type: "data.export", actor_id: "agent:42", environment: "production", target_id: "warehouse" };

function adapter(mode: "adapter" | "guard", decision: Decision = { decision: "allow", permit_token: "pt_1" }) {
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
