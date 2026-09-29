/**
 * The agent.tool.invoke gate presents what the runtime requires
 * (atlasent-docs ADR CROSS-063, atlasent-api #3785):
 *
 *  - a verified agent identity, minted for exactly agent.tool.invoke in the
 *    request's environment (the platform template's admission floor);
 *  - sealed source provenance for the SAME request_id, context and
 *    resource_id that evaluate receives (the global overlay for agent.*);
 *  - at verify, the digest and actor the runtime bound the permit to.
 *
 * Every failure to obtain either leaves the evaluate to the runtime, which
 * refuses it: nothing here allows locally.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, _resetRateLimitForTests } from "./server.js";
import { _resetPendingChangeRequestsForTests } from "./engine.js";

type Reply = { status: number; body: unknown };
type Route = (path: string, body: Record<string, unknown> | undefined) => Reply;

let originalFetch: typeof globalThis.fetch;
const sent: Array<{ path: string; body: Record<string, unknown> | undefined }> = [];

function route(fn: Route): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    sent.push({ path, body });
    const r = fn(path, body);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
const posts = (p: string) => sent.filter((s) => s.path === p);

const EVAL = "/functions/v1/v1-evaluate";
const VERIFY = "/functions/v1/v1-verify-permit";
const MINT = "/functions/v1/v1-agent-actor-identity";
const SEAL = "/functions/v1/v1-source-provenance-seal";
const BRIEF = "/functions/v1/v1-change-brief";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTION_HASH = "c".repeat(64);
const SEALED = { version: "source_provenance.v1", signature: "sig" };

function assertionFor(action_type: string, environment: string) {
  return {
    version: "actor_identity.v1",
    subject: { principal_id: "agent:a1", principal_kind: "agent", role: "agent" },
    binding: { action_type, tenant_id: "org-1", environment },
    signature: "ab".repeat(64),
  };
}

/** A runtime that mints, seals, and answers the gate with `gateReply`. */
function runtime(gateReply: Record<string, unknown>, over: Partial<Record<string, Reply>> = {}): void {
  route((p, body) => {
    if (over[p]) return over[p]!;
    if (p === MINT) return { status: 200, body: { assertion: assertionFor(String(body!.action_type), String(body!.environment)) } };
    if (p === SEAL) return { status: 200, body: { source_provenance: SEALED, action_hash: ACTION_HASH, request_id: body!.request_id } };
    if (p === BRIEF) return { status: 404, body: { error: "not_found" } };
    if (p === EVAL && body?.action_type === "agent.tool.invoke") return { status: 200, body: gateReply };
    if (p === EVAL) return { status: 200, body: { decision: "deny", deny_code: "NO_TEMPLATE_MATCH", deny_reason: "stop here" } };
    if (p === VERIFY) return { status: 200, body: { valid: true, outcome: "allow" } };
    return { status: 500, body: {} };
  });
}

async function deploy(): Promise<Record<string, unknown>> {
  const server = createServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(c), server.connect(s)]);
  const result = await client.callTool({
    name: "deploy_service",
    arguments: {
      service_name: "checkout",
      environment: "staging",
      actor_id: "svc:reported",
      change_plan: { operation: "deploy", revision: "aaa111" },
    },
  });
  return JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<string, unknown>;
}

const gateEval = () => posts(EVAL).find((x) => x.body!.action_type === "agent.tool.invoke")!.body!;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent.length = 0;
  process.env.ATLASENT_MODE = "remote";
  process.env.ATLASENT_API_KEY = "test-key";
  process.env.ATLASENT_BASE_URL = "https://api.test/functions/v1";
  _resetRateLimitForTests();
  _resetPendingChangeRequestsForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ATLASENT_MODE;
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_BASE_URL;
});

describe("agent.tool.invoke gate: identity and sealed provenance", () => {
  it("mints the agent's identity for agent.tool.invoke in the request's environment, with no change plan", async () => {
    runtime({ decision: "deny", deny_code: "NO_TEMPLATE_MATCH", deny_reason: "x" });
    await deploy();
    const mint = posts(MINT).find((m) => m.body!.action_type === "agent.tool.invoke");
    assert.ok(mint, "the gate must mint an identity");
    assert.equal(mint!.body!.environment, "staging");
    const body = gateEval();
    assert.equal((body.actor_identity as Record<string, unknown>).version, "actor_identity.v1");
    assert.equal(body.change_plan, undefined, "the gate itself carries no plan");
  });

  it("sends the identity's own agent as actor_id (a different one is refused 403 by the runtime)", async () => {
    runtime({ decision: "deny", deny_code: "NO_TEMPLATE_MATCH", deny_reason: "x" });
    await deploy();
    assert.equal(gateEval().actor_id, "agent:a1");
  });

  it("seals exactly the request_id, context and resource_id that evaluate receives, then attaches it", async () => {
    runtime({ decision: "deny", deny_code: "NO_TEMPLATE_MATCH", deny_reason: "x" });
    await deploy();
    const seal = posts(SEAL);
    assert.equal(seal.length, 1, "one seal per gate evaluate");
    const body = gateEval();
    assert.match(String(body.request_id), UUID, "the sealer accepts only a UUID request_id");
    assert.equal(seal[0].body!.request_id, body.request_id);
    assert.equal(seal[0].body!.action_type, "agent.tool.invoke");
    assert.deepEqual(seal[0].body!.context, body.context);
    assert.equal(seal[0].body!.resource_id, body.resource_id);
    assert.equal(seal[0].body!.resource_id, "deploy_service");
    assert.deepEqual(body.source_provenance, SEALED);
    // The seal runs after the body is complete: nothing sealed may change afterwards.
    assert.ok(sent.indexOf(seal[0]) < sent.indexOf(posts(EVAL)[0]));
  });

  it("verifies the permit against the sealed action hash and the agent actor the runtime bound it to", async () => {
    runtime({ decision: "allow", permit_token: "pt.gate", source_provenance: { admitted: true } });
    await deploy();
    const v = posts(VERIFY).find((x) => x.body!.action_type === "agent.tool.invoke");
    assert.ok(v, "the gate permit must be verified");
    assert.equal(v!.body!.payload_hash, ACTION_HASH);
    assert.equal(v!.body!.actor_id, "agent:a1");
    assert.equal(v!.body!.target_id, "deploy_service");
  });

  it("does not claim a provenance binding the runtime did not admit", async () => {
    runtime({ decision: "allow", permit_token: "pt.gate" }); // no source_provenance in the answer
    await deploy();
    const v = posts(VERIFY).find((x) => x.body!.action_type === "agent.tool.invoke");
    assert.equal(v!.body!.payload_hash, undefined);
  });

  it("a refused seal is not worked around: evaluate goes out WITHOUT provenance and the runtime's refusal stands", async () => {
    runtime(
      { decision: "deny", deny_code: "ASSERTION_UNVERIFIED", deny_reason: "source provenance required" },
      { [SEAL]: { status: 403, body: { error: "agent_binding_required" } } },
    );
    const out = await deploy();
    assert.equal(out.decision, "deny");
    assert.equal(out.deny_code, "ASSERTION_UNVERIFIED");
    assert.equal(gateEval().source_provenance, undefined);
    assert.ok((out.notes as string[]).some((n) => n.includes("agent_binding_required")));
    assert.equal(posts(EVAL).filter((x) => x.body!.action_type === "production.deploy").length, 0, "no deploy is asked");
    assert.equal(posts(VERIFY).length, 0);
  });

  it("a refused mint is not worked around: no identity is sent and the runtime decides", async () => {
    runtime(
      { decision: "deny", deny_code: "ACTOR_UNVERIFIED", deny_reason: "verified actor required" },
      { [MINT]: { status: 403, body: { error: "agent_binding_required" } } },
    );
    const out = await deploy();
    assert.equal(out.decision, "deny");
    assert.equal(out.deny_code, "ACTOR_UNVERIFIED");
    assert.equal(gateEval().actor_identity, undefined);
    assert.equal(gateEval().actor_id, "svc:reported", "no verified agent, so nothing replaces the reported actor");
  });

  it("an assertion bound to another action is discarded rather than presented", async () => {
    runtime(
      { decision: "deny", deny_code: "ACTOR_UNVERIFIED", deny_reason: "x" },
      { [MINT]: { status: 200, body: { assertion: assertionFor("production.deploy", "staging") } } },
    );
    await deploy();
    assert.equal(gateEval().actor_identity, undefined);
  });

  it("each call seals a new request_id: a sealed request is never replayed", async () => {
    runtime({ decision: "deny", deny_code: "NO_TEMPLATE_MATCH", deny_reason: "x" });
    await deploy();
    await deploy();
    const ids = posts(SEAL).map((s) => s.body!.request_id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });
});
