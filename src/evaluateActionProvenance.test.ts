/**
 * The standalone evaluate path (evaluateAction, behind atlasent_evaluate)
 * prepares agent.* exactly like authorizeRemote (atlasent-docs ADR CROSS-063,
 * atlasent-api #3785): verified agent identity, the key's agent as actor_id,
 * then sealed source provenance LAST over the exact request_id (bare UUID),
 * context and resource_id that evaluate receives. Without the seal the
 * runtime's incident-defense overlay refuses every agent.* evaluate.
 *
 * Non-agent actions must send byte-identical requests to before.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, _resetRateLimitForTests } from "./server.js";
import { evaluateAction, _resetPendingChangeRequestsForTests } from "./engine.js";

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
const DIGEST = "d".repeat(64);
const SEALED = { version: "source_provenance.v1", signature: "sig" };

function assertionFor(action_type: string, environment: string) {
  return {
    version: "actor_identity.v1",
    subject: { principal_id: "agent:a1", principal_kind: "agent", role: "agent" },
    binding: { action_type, tenant_id: "org-1", environment },
    signature: "ab".repeat(64),
  };
}

/** A runtime that mints, seals, and answers evaluate with `evalReply`. */
function runtime(evalReply: Record<string, unknown>, over: Partial<Record<string, Reply>> = {}): void {
  route((p, body) => {
    if (over[p]) return over[p]!;
    if (p === MINT) return { status: 200, body: { assertion: assertionFor(String(body!.action_type), String(body!.environment)) } };
    if (p === SEAL) return { status: 200, body: { source_provenance: SEALED, action_hash: ACTION_HASH, request_id: body!.request_id } };
    if (p === BRIEF) return { status: 404, body: { error: "not_found" } };
    if (p === EVAL) return { status: 200, body: evalReply };
    if (p === VERIFY) return { status: 200, body: { valid: true, outcome: "allow" } };
    return { status: 500, body: {} };
  });
}

async function client(): Promise<Client> {
  const server = createServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  const cl = new Client({ name: "t", version: "1" });
  await Promise.all([cl.connect(c), server.connect(s)]);
  return cl;
}

async function call(cl: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await cl.callTool({ name, arguments: args });
  return JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<string, unknown>;
}

const AGENT_ARGS = {
  actor_id: "svc:reported",
  action_type: "agent.tool.invoke",
  context: { environment: "staging", tool: "search" },
  target_id: "search",
  execution_payload_hash: DIGEST,
};

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

describe("atlasent_evaluate (evaluateAction): agent.* sealed provenance", () => {
  it("seals exactly the request_id, context and resource_id it sends, after the identity, and attaches it", async () => {
    runtime({ decision: "deny", deny_code: "NO_TEMPLATE_MATCH", deny_reason: "x" });
    await call(await client(), "atlasent_evaluate", AGENT_ARGS);
    assert.deepEqual(sent.map((s) => s.path), [MINT, SEAL, EVAL], "identity, then seal, then evaluate");
    const seal = posts(SEAL)[0].body!;
    const ev = posts(EVAL)[0].body!;
    assert.match(String(ev.request_id), UUID, "the sealer accepts only a bare UUID request_id");
    assert.equal(seal.request_id, ev.request_id);
    assert.equal(seal.action_type, "agent.tool.invoke");
    assert.deepEqual(seal.context, ev.context);
    assert.equal(seal.resource_id, ev.resource_id);
    assert.equal(ev.resource_id, "search");
    assert.deepEqual(ev.source_provenance, SEALED);
    assert.equal(ev.actor_id, "agent:a1", "the key's verified agent replaces the reported actor");
    assert.equal((ev.actor_identity as Record<string, unknown>).version, "actor_identity.v1");
    // The sealed hash covers context, not the top-level digest: the digest
    // rides inside the sealed context, as on authorizeRemote's path.
    assert.equal((ev.context as Record<string, unknown>).action_digest, DIGEST);
    assert.equal(ev.execution_payload_hash, DIGEST);
  });

  it("seals after change control too: the plan is in the body before the seal, and nothing changes after it", async () => {
    runtime({ decision: "deny", deny_code: "NO_TEMPLATE_MATCH", deny_reason: "x" });
    await evaluateAction({
      action_type: "agent.tool.invoke",
      actor_id: "svc:reported",
      context: { environment: "staging", tool: "search" },
      target_id: "search",
      change_plan: { operation: "invoke", revision: "abc" },
    });
    const ev = posts(EVAL)[0].body!;
    assert.deepEqual(ev.change_plan, { operation: "invoke", revision: "abc" });
    assert.deepEqual(posts(SEAL)[0].body!.context, ev.context);
    assert.deepEqual(sent.map((s) => s.path), [MINT, SEAL, EVAL]);
  });

  it("returns what verify_permit must present, and a verify with it carries the sealed hash and the agent", async () => {
    runtime({ decision: "allow", permit_token: "pt.1", source_provenance: { admitted: true } });
    const cl = await client();
    const out = await call(cl, "atlasent_evaluate", AGENT_ARGS);
    assert.equal(out.decision, "allow");
    assert.equal(out.bound_payload_hash, ACTION_HASH);
    assert.equal(out.bound_actor_id, "agent:a1");
    await call(cl, "verify_permit", {
      permit_token: "pt.1",
      action_type: "agent.tool.invoke",
      actor_id: out.bound_actor_id,
      environment: "staging",
      target_id: "search",
      payload_hash: out.bound_payload_hash,
    });
    const v = posts(VERIFY)[0].body!;
    assert.equal(v.payload_hash, ACTION_HASH);
    assert.equal(v.actor_id, "agent:a1");
    assert.equal(v.target_id, "search");
  });

  it("does not claim a provenance binding the runtime did not admit", async () => {
    runtime({ decision: "allow", permit_token: "pt.1" });
    const out = await call(await client(), "atlasent_evaluate", AGENT_ARGS);
    assert.equal(out.bound_payload_hash, undefined);
  });

  it("a failed seal adds a note and the evaluate still goes out, without provenance; the runtime decides", async () => {
    runtime(
      { decision: "deny", deny_code: "ASSERTION_UNVERIFIED", deny_reason: "source provenance required" },
      { [SEAL]: { status: 403, body: { error: "agent_binding_required" } } },
    );
    const out = await call(await client(), "atlasent_evaluate", AGENT_ARGS);
    assert.equal(posts(EVAL).length, 1, "the request still goes out");
    assert.equal(posts(EVAL)[0].body!.source_provenance, undefined);
    assert.equal(out.decision, "deny");
    assert.equal(out.deny_code, "ASSERTION_UNVERIFIED");
    assert.ok((out.notes as string[]).some((n) => n.includes("agent_binding_required")));
  });

  it("each call seals a new request_id", async () => {
    runtime({ decision: "deny", deny_code: "NO_TEMPLATE_MATCH", deny_reason: "x" });
    const cl = await client();
    await call(cl, "atlasent_evaluate", AGENT_ARGS);
    await call(cl, "atlasent_evaluate", AGENT_ARGS);
    const ids = posts(SEAL).map((s) => s.body!.request_id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });
});

describe("atlasent_evaluate (evaluateAction): non-agent actions are unchanged", () => {
  it("sends a byte-identical body: no request_id, no seal, no mint, caller context untouched", async () => {
    const reply = { decision: "allow", permit_token: "pt.2" };
    runtime(reply);
    const context = { environment: "production", table: "users" };
    const out = await evaluateAction({
      actor_id: "svc:bot",
      action_type: "data.delete",
      context,
      target_id: "users",
      execution_payload_hash: DIGEST,
    });
    assert.deepEqual(sent.map((s) => s.path), [EVAL], "one evaluate, nothing else");
    assert.equal(
      JSON.stringify(posts(EVAL)[0].body),
      JSON.stringify({
        action_type: "data.delete",
        actor_id: "svc:bot",
        resource_id: "users",
        context: { environment: "production", table: "users", target_id: "users", target: { id: "users" } },
        state_snapshot: { source: "atlasent-mcp", complete: true },
        execution_payload_hash: DIGEST,
      }),
    );
    assert.deepEqual(context, { environment: "production", table: "users" }, "the caller's context is not mutated");
    assert.deepEqual(out, reply, "the raw response is returned as-is");
  });
});
