import { describe, it } from "node:test";
import assert from "node:assert/strict";

// @ts-expect-error plain .mjs example module, no type declarations
import { ACTION_TYPE, payloadDigest, refundPayload, runRefundAgent, toolCallTimeoutMs } from "../examples/refund-agent/core.mjs";
// @ts-expect-error plain .mjs example module, no type declarations
import { createSimulatedTools } from "../examples/refund-agent/simulated.mjs";

type Refund = Record<string, unknown>;
type Result = { refund_id: string; outcome: string; decision?: string; reason?: string; permit_sha256?: string };

const small: Refund = { refund_id: "RF-1", customer_ref: "c1", charge_ref: "ch1", amount: 40, currency: "USD", original_payment_method: true };
const large: Refund = { refund_id: "RF-2", customer_ref: "c2", charge_ref: "ch2", amount: 2400, currency: "USD", original_payment_method: true };
const diverted: Refund = { refund_id: "RF-3", customer_ref: "c3", charge_ref: "ch3", amount: 5000, currency: "USD", original_payment_method: false, destination: "new_bank_account" };

async function run(refunds: Refund[], sim = createSimulatedTools()) {
  const results: Result[] = await runRefundAgent({ refunds, tools: sim.tools, processor: sim.processor, actorId: "service:refund-agent", environment: "staging" });
  return { results, sim };
}

describe("refund agent demo", () => {
  it("issues a small refund once, after allow and a valid permit", async () => {
    const { results, sim } = await run([small]);
    assert.equal(results[0].outcome, "issued");
    assert.equal(results[0].decision, "allow");
    assert.equal(sim.state.issued.length, 1);
    assert.deepEqual(sim.state.issued[0], refundPayload(small));
    assert.match(results[0].permit_sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(results).includes("sim_permit_"), "the permit itself is never recorded");
  });

  it("a large refund waits for a person; approved, it is issued once", async () => {
    const { results, sim } = await run([large]);
    assert.equal(results[0].decision, "escalate");
    assert.equal(results[0].outcome, "issued");
    assert.equal(sim.state.issued.length, 1);
  });

  it("a rejected refund is never issued", async () => {
    const { results, sim } = await run([diverted]);
    assert.equal(results[0].outcome, "not_issued");
    assert.equal(sim.state.issued.length, 0);
  });

  it("asks for exactly this refund: Canon action, bound digest, no approval claim", async () => {
    const { sim } = await run([small]);
    const req = sim.state.evaluations[0];
    assert.equal(req.action_type, ACTION_TYPE);
    assert.equal(req.action_type, "finance.payment.authorize");
    assert.equal(req.target_id, "RF-1");
    assert.equal(req.execution_payload_hash, payloadDigest(small));
    assert.equal(req.context.payment_kind, "refund");
    assert.ok(!("approvals" in req.context) && !("distinct_approver" in req.context), "the agent never claims approvals");
  });

  it("a missing amount is denied and nothing is issued", async () => {
    const { results, sim } = await run([{ ...small, amount: undefined }]);
    assert.equal(results[0].decision, "deny");
    assert.equal(results[0].outcome, "not_issued");
    assert.equal(sim.state.issued.length, 0);
  });

  it("fails closed when verification is not valid, when the digest was not bound, or on any error", async () => {
    const cases: Array<(t: ReturnType<typeof createSimulatedTools>["tools"]) => void> = [
      (t) => { t.verify = async () => ({ valid: false, outcome: "expired" }); },
      (t) => { const e = t.evaluate; t.evaluate = async (r: unknown) => ({ ...(await e(r)), execution_payload_hash_accepted: false }); },
      (t) => { t.verify = async () => { throw new Error("network down"); }; },
      (t) => { t.awaitApproval = async () => ({ outcome: "timed_out" }); },
      (t) => { t.evaluate = async () => ({ decision: "allow" }); }, // allow with no permit
    ];
    for (const [i, mutate] of cases.entries()) {
      const sim = createSimulatedTools();
      mutate(sim.tools);
      const { results } = await run([i === 3 ? large : small], sim);
      assert.equal(results[0].outcome, "not_issued", `case ${i}`);
      assert.equal(sim.state.issued.length, 0, `case ${i}`);
    }
  });

  it("a different refund cannot use another refund's permit", async () => {
    const sim = createSimulatedTools();
    const { results } = await run([small], sim);
    assert.equal(results[0].outcome, "issued");
    // Replaying RF-1's (now used) permit, or presenting it for another refund, is refused.
    const token = [...sim.state.permits.keys()][0];
    assert.equal((await sim.tools.verify({ permit_token: token, target_id: "RF-1", payload_hash: payloadDigest(small) })).valid, false);
  });

  it("works the bundled queue: two issued straight away, one after approval, one rejected", async () => {
    const { readFileSync } = await import("node:fs");
    const queue = JSON.parse(readFileSync(new URL("../examples/refund-agent/refunds.json", import.meta.url), "utf8"));
    const { results } = await run(queue);
    assert.deepEqual(results.map((r) => [r.decision, r.outcome]), [
      ["allow", "issued"],
      ["allow", "issued"],
      ["escalate", "issued"],
      ["escalate", "not_issued"],
    ]);
  });

  it("documents every scope the live run needs, approvals:read included", async () => {
    // The escalation path polls GET /v1-approvals/:id and claims the permit;
    // both need approvals:read, so a key without it can never finish RF-1003.
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync(new URL("../docs/REFUND_AGENT_DEMO.md", import.meta.url), "utf8");
    const script = readFileSync(new URL("../examples/refund-agent-demo.mjs", import.meta.url), "utf8");
    for (const scope of ["evaluate:write", "verify:execute", "approvals:read"]) {
      assert.ok(doc.includes(scope), `docs/REFUND_AGENT_DEMO.md names ${scope}`);
      assert.ok(script.includes(scope), `examples/refund-agent-demo.mjs names ${scope}`);
    }
  });

  it("gives the approval wait an MCP timeout longer than the wait itself", async () => {
    // The MCP client SDK's default request timeout is 60 s; a 600 s wait must not inherit it.
    assert.ok(toolCallTimeoutMs("atlasent_await_approval", { max_wait_seconds: 600 }) > 600_000);
    assert.ok(toolCallTimeoutMs("atlasent_await_approval", {}) > 120_000, "server default wait is 120 s");
    assert.equal(toolCallTimeoutMs("atlasent_await_approval", { max_wait_seconds: 5 }), 60_000);
    assert.equal(toolCallTimeoutMs("atlasent_evaluate", { max_wait_seconds: 600 }), 60_000);
    // The live script passes it on every call.
    const { readFileSync } = await import("node:fs");
    const script = readFileSync(new URL("../examples/refund-agent-demo.mjs", import.meta.url), "utf8");
    assert.match(script, /callTool\(\{ name, arguments: args \}, undefined, \{ timeout: toolCallTimeoutMs\(name, args\) \}\)/);
  });
});
