/**
 * OpenShell security regressions, 2026-10-10.
 *
 * NVIDIA/OpenShell#4359's security review found three ways streaming
 * middleware could let bytes through that a verdict should have stopped: a
 * request completing before the final middleware verdict, a response delivered
 * after policy revocation, and incomplete request metadata passed between
 * middleware stages. AtlaSent does not adopt that interface (it is unreleased),
 * but the same three properties must hold for the AtlaSent execution boundary:
 *
 *  A. Nothing consequential starts before the FINAL AtlaSent permit verdict.
 *     An evaluate ALLOW is not the final verdict; verify (and consume) is. A
 *     HOLD, a pending verify, a hung verify and a verify that throws are all
 *     "no verdict yet", and none of them may run the command.
 *  B. A revocation between evaluate and execute stops delivery: a runtime
 *     revocation at verify, an OpenShell policy-generation change, and an
 *     already-consumed permit each prevent the command running on that permit.
 *  C. The binding presented at verify is complete: the same sandbox, the same
 *     envelope, the same payload hash. A stage cannot drop a field and still
 *     pass.
 *
 * Each test drives runGoverned (the one-process evaluate → verify → execute
 * path) or the adapter directly, with an event log, so ordering is asserted
 * rather than inferred from a final count.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ActionContext, Decision, VerifyResult } from "./decision.js";
import type { AwaitApprovalParams, AwaitApprovalResult } from "./engine.js";
import { OpenShellAuthorityAdapter, assessOpenShellVersion, OPENSHELL_OPEN_ADVISORIES } from "./openshell.js";
import { EXIT, runGoverned, type SpawnOutcome } from "./openshellRun.js";
import { checkAtlasentTransport } from "./openshellCli.js";

const SANDBOX = { sandbox_id: "sbx_01J9ZK", sandbox_name: "payments-agent", policy_generation: 3 };
const ENVELOPE = {
  action_type: "data.export",
  actor_id: "agent:42",
  environment: "production",
  target_id: "warehouse",
  payload_hash: "a".repeat(64),
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
/** Let every queued microtask and timer-free continuation run. */
const settle = () => new Promise<void>((r) => setImmediate(r));

const OK_SPAWN: SpawnOutcome = { started: true, code: 0, signal: null, timed_out: false };

function harness(opts: {
  decisions: Decision[];
  verify?: (token: string, ctx: ActionContext) => Promise<VerifyResult>;
  awaitApproval?: (p: AwaitApprovalParams) => Promise<AwaitApprovalResult>;
  sandbox?: () => unknown;
}) {
  const log: string[] = [];
  const verified: Array<{ token: string; ctx: ActionContext }> = [];
  let i = 0;
  const adapter = new OpenShellAuthorityAdapter({
    authorize: async () => {
      log.push("evaluate");
      return opts.decisions[Math.min(i++, opts.decisions.length - 1)];
    },
    verify: async (token, ctx) => {
      log.push("verify:start");
      verified.push({ token, ctx });
      const r = await (opts.verify ?? (async () => ({ outcome: "verified", valid: true }) as VerifyResult))(token, ctx);
      log.push(`verify:${r.valid ? "valid" : "invalid"}`);
      return r;
    },
    awaitApproval: async (p) => {
      log.push("hold:wait");
      const r = await (opts.awaitApproval ??
        (async () => ({ outcome: "approved", permit_token: "pt_approved", approval_request_id: p.approval_request_id })))(p);
      log.push(`hold:${r.outcome}`);
      return r;
    },
  });
  const deps = {
    adapter,
    sandbox: opts.sandbox ?? (() => SANDBOX as unknown),
    spawn: async (argv: string[]) => {
      log.push(`spawn:${argv.join(" ")}`);
      return OK_SPAWN;
    },
  };
  return { adapter, deps, log, verified };
}

describe("A. nothing consequential runs before the final AtlaSent verdict", () => {
  it("positive control: the command starts only after verify has returned valid", async () => {
    const h = harness({ decisions: [{ decision: "allow", permit_token: "pt_1" }] });
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(r.outcome, "EXECUTED");
    assert.deepEqual(h.log, ["evaluate", "verify:start", "verify:valid", "spawn:deploy.sh"]);
  });

  it("an ALLOW whose verify is still pending has not executed, and an invalid verify never does", async () => {
    const v = deferred<VerifyResult>();
    const h = harness({ decisions: [{ decision: "allow", permit_token: "pt_1" }], verify: () => v.promise });
    const run = runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    await settle();
    assert.deepEqual(h.log, ["evaluate", "verify:start"], "nothing may start while the final verdict is pending");
    v.resolve({ outcome: "invalid", valid: false, reasons: ["PERMIT_REVOKED"], verify_error_code: "PERMIT_REVOKED" });
    const r = await run;
    assert.equal(r.exit_code, EXIT.DENY);
    assert.equal(h.log.some((e) => e.startsWith("spawn")), false);
  });

  it("an ALLOW whose verify is pending executes only once verify resolves valid", async () => {
    const v = deferred<VerifyResult>();
    const h = harness({ decisions: [{ decision: "allow", permit_token: "pt_1" }], verify: () => v.promise });
    const run = runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    await settle();
    await settle();
    assert.equal(h.log.some((e) => e.startsWith("spawn")), false);
    v.resolve({ outcome: "verified", valid: true });
    assert.equal((await run).outcome, "EXECUTED");
    assert.ok(h.log.indexOf("verify:valid") < h.log.indexOf("spawn:deploy.sh"));
  });

  it("a verify that throws or hangs is no verdict: nothing executes", async () => {
    const thrown = harness({
      decisions: [{ decision: "allow", permit_token: "pt_1" }],
      verify: async () => {
        throw new Error("socket hang up");
      },
    });
    const r = await runGoverned(thrown.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(r.exit_code, EXIT.DENY);
    assert.equal(thrown.log.some((e) => e.startsWith("spawn")), false);

    const hung = harness({ decisions: [{ decision: "allow", permit_token: "pt_1" }], verify: () => new Promise(() => {}) });
    void runGoverned(hung.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    for (let k = 0; k < 5; k++) await settle();
    assert.equal(hung.log.some((e) => e.startsWith("spawn")), false, "a hung verify must hold execution, not time it in");
  });

  it("an engine verify that reports valid:false for any outcome never executes", async () => {
    for (const outcome of ["expired", "invalid", "error"] as const) {
      const h = harness({
        decisions: [{ decision: "allow", permit_token: "pt_1" }],
        verify: async () => ({ outcome, valid: false }),
      });
      const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
      assert.equal(r.exit_code, EXIT.DENY, outcome);
      assert.equal(h.log.some((e) => e.startsWith("spawn")), false, outcome);
    }
  });

  it("a HOLD still waiting on AtlaSent approval has not executed; a denied approval never does", async () => {
    const approval = deferred<AwaitApprovalResult>();
    const h = harness({
      decisions: [{ decision: "hold", reasons: ["needs approval"], approval_request_id: "apr_1" }],
      awaitApproval: () => approval.promise,
    });
    const run = runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"], wait_ms: 60_000 });
    await settle();
    assert.deepEqual(h.log, ["evaluate", "hold:wait"]);
    approval.resolve({ outcome: "not_approved", approval_request_id: "apr_1", status: "rejected", reasons: ["rejected"] });
    const r = await run;
    assert.equal(r.exit_code, EXIT.DENY);
    assert.equal(h.log.some((e) => e.startsWith("verify") || e.startsWith("spawn")), false);
  });

  it("an approved HOLD is still verified before it executes: approval is not the final verdict", async () => {
    const h = harness({
      decisions: [{ decision: "hold", reasons: ["needs approval"], approval_request_id: "apr_1" }],
      verify: async () => ({ outcome: "invalid", valid: false, reasons: ["PERMIT_REVOKED"] }),
    });
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"], wait_ms: 60_000 });
    assert.equal(r.exit_code, EXIT.DENY);
    assert.deepEqual(h.log, ["evaluate", "hold:wait", "hold:approved", "verify:start", "verify:invalid"]);
  });
});

describe("B. revocation stops delivery", () => {
  it("a runtime revocation reported at verify stops the command", async () => {
    const h = harness({
      decisions: [{ decision: "allow", permit_token: "pt_1" }],
      verify: async () => ({ outcome: "invalid", valid: false, verify_error_code: "PERMIT_REVOKED", reasons: ["permit revoked"] }),
    });
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(r.exit_code, EXIT.DENY);
    assert.deepEqual(r.reasons, ["permit revoked"]);
    assert.equal(h.log.some((e) => e.startsWith("spawn")), false);
  });

  it("an OpenShell policy change between evaluate and verify drops the permit; a fresh DENY means nothing runs", async () => {
    let gen = 3;
    const h = harness({
      decisions: [{ decision: "allow", permit_token: "pt_old" }, { decision: "deny", reasons: ["revoked by policy"] }],
      sandbox: () => ({ ...SANDBOX, policy_generation: gen }),
    });
    const origEvaluate = h.adapter.evaluate.bind(h.adapter);
    h.adapter.evaluate = async (env, sb) => {
      const out = await origEvaluate(env, sb);
      gen += 1; // the policy moves after every evaluate, before verify
      return out;
    };
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(r.exit_code, EXIT.DENY);
    assert.equal(h.verified.length, 0, "the stale permit is never presented to the runtime");
    assert.equal(h.log.some((e) => e.startsWith("spawn")), false);
    assert.deepEqual(h.log, ["evaluate", "evaluate"]);
  });

  it("a policy change during the HOLD wait means the approved permit is not used", async () => {
    let gen = 3;
    const h = harness({
      decisions: [{ decision: "hold", reasons: ["approval"], approval_request_id: "apr_1" }, { decision: "deny", reasons: ["policy revoked"] }],
      sandbox: () => ({ ...SANDBOX, policy_generation: gen }),
      awaitApproval: async (p) => {
        gen = 4; // revoked while a person was approving
        return { outcome: "approved", permit_token: "pt_approved", approval_request_id: p.approval_request_id };
      },
    });
    const r = await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"], wait_ms: 60_000 });
    assert.equal(r.exit_code, EXIT.DENY);
    assert.equal(h.verified.some((v) => v.token === "pt_approved"), false);
    assert.equal(h.log.some((e) => e.startsWith("spawn")), false);
  });

  it("a consumed permit cannot deliver a second time, and a dropped one cannot be replayed", async () => {
    const h = harness({ decisions: [{ decision: "allow", permit_token: "pt_1" }] });
    const p = await h.adapter.evaluate(ENVELOPE, SANDBOX);
    assert.equal(p.outcome, "PERMIT");
    const first = await h.adapter.verifyBeforeExecute("pt_1", ENVELOPE, SANDBOX);
    assert.equal(first.execute, true);
    const second = await h.adapter.verifyBeforeExecute("pt_1", ENVELOPE, SANDBOX);
    assert.equal(second.execute, false);
    assert.equal(h.verified.length, 1, "the replay never reached the runtime");

    const h2 = harness({ decisions: [{ decision: "allow", permit_token: "pt_2" }] });
    await h2.adapter.evaluate(ENVELOPE, SANDBOX);
    const stale = await h2.adapter.verifyBeforeExecute("pt_2", ENVELOPE, { ...SANDBOX, policy_generation: 4 });
    assert.equal(stale.execute, false);
    const replay = await h2.adapter.verifyBeforeExecute("pt_2", ENVELOPE, SANDBOX);
    assert.equal(replay.execute, false, "returning to the old generation does not revive a dropped permit");
    assert.equal(h2.verified.length, 0);
  });
});

describe("C. the binding presented at verify is complete", () => {
  it("presents the evaluated sandbox, action, target and payload hash at verify", async () => {
    const h = harness({ decisions: [{ decision: "allow", permit_token: "pt_1", bound_payload_hash: "b".repeat(64) }] });
    await runGoverned(h.deps, { envelope: ENVELOPE, argv: ["deploy.sh"] });
    assert.equal(h.verified.length, 1);
    const ctx = h.verified[0].ctx;
    assert.equal(ctx.workload?.id, SANDBOX.sandbox_id);
    assert.equal(ctx.action_type, ENVELOPE.action_type);
    assert.equal(ctx.actor_id, ENVELOPE.actor_id);
    assert.equal(ctx.target_id, ENVELOPE.target_id);
    assert.equal(ctx.payload_hash, "b".repeat(64), "the runtime-bound hash, not a dropped one");
  });

  it("a stage that drops a field from the envelope fails the digest check before verify", async () => {
    const h = harness({ decisions: [{ decision: "allow", permit_token: "pt_1" }] });
    await h.adapter.evaluate(ENVELOPE, SANDBOX);
    const { target_id: _drop, ...partial } = ENVELOPE;
    const v = await h.adapter.verifyBeforeExecute("pt_1", partial, SANDBOX);
    assert.equal(v.execute, false);
    assert.equal(h.verified.length, 0);
  });

  it("a sandbox context missing its id at verify is refused, never filled from the evaluate side", async () => {
    const h = harness({ decisions: [{ decision: "allow", permit_token: "pt_1" }] });
    await h.adapter.evaluate(ENVELOPE, SANDBOX);
    const v = await h.adapter.verifyBeforeExecute("pt_1", ENVELOPE, { sandbox_name: SANDBOX.sandbox_name, policy_generation: 3 });
    assert.equal(v.execute, false);
    assert.equal(h.verified.length, 0);
  });
});

describe("transport identity at the CLI (NVIDIA/OpenShell#4397)", () => {
  it("accepts https and loopback http only", () => {
    assert.equal(checkAtlasentTransport({}), undefined, "the default base URL is https");
    assert.equal(checkAtlasentTransport({ ATLASENT_BASE_URL: "https://x.supabase.co/functions/v1" }), undefined);
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      assert.equal(checkAtlasentTransport({ ATLASENT_BASE_URL: `http://${host}:54321/functions/v1` }), undefined, host);
    }
  });

  it("refuses plaintext to a remote host, a WebSocket scheme and an unparseable URL", () => {
    for (const url of [
      "http://api.atlasent.io/functions/v1",
      "http://localhost.attacker.example/functions/v1",
      "ws://api.atlasent.io/functions/v1",
      "wss://api.atlasent.io/functions/v1",
      "not a url",
      "https://",
    ]) {
      assert.match(checkAtlasentTransport({ ATLASENT_BASE_URL: url }) ?? "", /ATLASENT_BASE_URL/, url);
    }
  });

  it("a refused transport runs nothing and makes no AtlaSent call", async () => {
    const { main } = await import("./openshellCli.js");
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response("{}");
    }) as typeof fetch;
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await main(["run", "--envelope", "/dev/null", "--", "true"], {
        ATLASENT_MODE: "remote",
        ATLASENT_API_KEY: "ask_test_x",
        ATLASENT_BASE_URL: "http://api.atlasent.io/functions/v1",
        OPENSHELL_SANDBOX_ID: "sbx_1",
      });
      assert.equal(code, EXIT.DENY);
      assert.equal(fetched, 0);
    } finally {
      process.stderr.write = realWrite;
      globalThis.fetch = realFetch;
    }
  });
});

describe("open OpenShell advisories ride on every assessment", () => {
  it("names #4397 and #4359 and does not change the qualification status", () => {
    const ids = OPENSHELL_OPEN_ADVISORIES.map((a) => a.id);
    assert.deepEqual(ids, ["NVIDIA/OpenShell#4397", "NVIDIA/OpenShell#4359"]);
    const pre4 = assessOpenShellVersion("v0.1.3-pre.4");
    assert.equal(pre4.status, "probe_passed", "qualification of v0.1.3 continues");
    assert.deepEqual(pre4.advisories.map((a) => a.id), ids);
    assert.equal(assessOpenShellVersion("0.1.2").advisories.length, 2);
  });
});
