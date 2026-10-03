/**
 * examples/hitl-demo: the 90-second hold -> approve -> execute -> record demo.
 *
 * Drives the demo's core against the REAL tool and engine, with the SIMULATED
 * backends that `--simulate` uses. Proves the demo only reports a stage it
 * observed: every failure stops it with ok=false and no DONE line, and nothing
 * reaches the repository unless a person approved.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { authorize, awaitApproval, getMode, verify } from "./engine.js";
import { registerAiActionTools } from "./aiActionTools.js";
// @ts-expect-error -- plain ESM example module, no type declarations
import { runHitlDemo } from "../examples/hitl-demo/core.mjs";
// @ts-expect-error -- plain ESM example module, no type declarations
import { createSimulatedBackends } from "../examples/hitl-demo/simulated-backends.mjs";

const TARGET = { owner: "simulated-org", repo: "simulated-repo", branch: "main" };
const PATH = "atlasent-demo/flags.json";
const CONTENT = '{\n  "instant_payouts": true\n}\n';
const ENV_KEYS = ["ATLASENT_MODE", "ATLASENT_API_KEY", "ATLASENT_BASE_URL", "ATLASENT_ENVIRONMENT"];
const saved: Record<string, string | undefined> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON in a test/acceptance harness
let sim: any;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  sim = createSimulatedBackends(TARGET);
  sim.install();
  process.env.ATLASENT_MODE = "remote";
  process.env.ATLASENT_API_KEY = "ask_test_simulated";
  process.env.ATLASENT_BASE_URL = sim.baseUrl;
  process.env.ATLASENT_ENVIRONMENT = "staging";
});
afterEach(() => {
  sim.restore();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

async function run(opts: { register?: boolean; approvalWaitSeconds?: number; pollSeconds?: number } = {}) {
  const server = new McpServer({ name: "t", version: "1" });
  if (opts.register !== false) {
    registerAiActionTools(server, { ...TARGET, token: "simulated" }, () => true, { authorize, verify, getMode, awaitApproval });
  } else {
    server.registerTool("some_other_tool", { description: "x" }, async () => ({ content: [{ type: "text", text: "{}" }] }));
  }
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(c), server.connect(s)]);
  const lines: string[] = [];
  let t = 0;
  const result = await runHitlDemo({
    client,
    readHead: async (p: string) => sim.headContent(p),
    path: PATH,
    content: CONTENT,
    message: "AI agent: enable instant_payouts",
    simulated: true,
    approvalWaitSeconds: opts.approvalWaitSeconds ?? 60,
    pollSeconds: opts.pollSeconds ?? 1,
    onHold: (id: string) => sim.decide(id),
    print: (l: string) => lines.push(l),
    clock: () => (t += 1000),
  });
  await client.close();
  return { result, lines, out: lines.join("\n") };
}

describe("hitl demo (examples/hitl-demo)", () => {
  it("shows hold -> approve -> exactly that change executes once -> effect recorded, with real ids", async () => {
    const { result, out } = await run();
    assert.equal(result.ok, true, out);
    assert.match(result.ids.approval_request_id, /^sim-apr-/);
    assert.equal(result.proof.decision.approval_request_id, result.ids.approval_request_id);
    assert.equal(result.proof.permit.verified, true);
    assert.equal(result.proof.effect.established, true);
    assert.equal(sim.state.puts, 1, "exactly one write");
    assert.equal(sim.headContent(PATH), CONTENT);
    for (const n of [1, 2, 3, 4, 5, 6]) assert.match(out, new RegExp(`STAGE ${n} \\|`));
    assert.match(out, /DONE:/);
    assert.ok(out.includes(result.ids.commit_sha) && out.includes(result.proof.proof_sha256));
    assert.ok(!out.includes("pt.simulated"), "the permit token itself is never printed");
  });

  it("labels every line SIMULATED in simulated mode", async () => {
    const { lines } = await run();
    assert.ok(lines.length > 10);
    for (const l of lines) assert.ok(l.startsWith("[SIMULATED]"), `unlabelled line: ${l}`);
  });

  it("fails at ATTEMPT when the policy allows with no person (and says the change was written)", async () => {
    sim.state.policy = "allow";
    const { result, out } = await run();
    assert.equal(result.ok, false);
    assert.equal(result.failed_stage, "attempt");
    assert.match(result.reason, /ALLOWED this change with no person/);
    assert.doesNotMatch(out, /DONE:|STAGE 2/);
  });

  it("fails at APPROVE when the person rejects; nothing is written", async () => {
    sim.state.decide = "reject";
    const { result, out } = await run();
    assert.equal(result.ok, false);
    assert.equal(result.failed_stage, "approve");
    assert.match(result.reason, /not approved/);
    assert.equal(sim.state.puts, 0);
    assert.doesNotMatch(out, /STAGE 5|DONE:/);
  });

  it("fails at APPROVE when nobody decides in time; nothing is written", async () => {
    sim.state.decide = "never";
    const { result } = await run({ approvalWaitSeconds: 5, pollSeconds: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.failed_stage, "approve");
    assert.match(result.reason, /no decision within 5s/);
    assert.equal(sim.state.puts, 0);
  });

  it("fails at RECORD when the effect cannot be re-read as the approved bytes", async () => {
    sim.state.lieOnRead = true;
    const { result, out } = await run();
    assert.equal(result.ok, false);
    assert.equal(result.failed_stage, "record");
    assert.match(result.reason, /effect not established/);
    assert.doesNotMatch(out, /DONE:/);
  });

  it("fails at setup when the governed tool is not registered", async () => {
    const { result } = await run({ register: false });
    assert.equal(result.ok, false);
    assert.equal(result.failed_stage, "setup");
  });
});
