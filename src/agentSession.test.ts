/**
 * CROSS-056 §2b: every evaluate call reports which app and which chat/session
 * it came from (labelled "reported" server-side, never authority), and the
 * AI model no longer has to name itself — with an agent API key the runtime
 * derives the agent and its owner from the key.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sanitizeAgentSession } from "./engine.js";
import { createServer, _resetRateLimitForTests } from "./server.js";

let originalFetch: typeof globalThis.fetch;
const bodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  bodies.length = 0;
  process.env.ATLASENT_MODE = "remote";
  process.env.ATLASENT_API_KEY = "test-key";
  process.env.ATLASENT_BASE_URL = "https://api.test/functions/v1";
  _resetRateLimitForTests();
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ decision: "deny", deny_reason: "test" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ["ATLASENT_MODE", "ATLASENT_API_KEY", "ATLASENT_BASE_URL", "ATLASENT_SESSION_ID", "ATLASENT_RUN_ID"]) {
    delete process.env[k];
  }
});

async function client(name = "claude-code") {
  const server = createServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  const cl = new Client({ name, version: "1.0.0" });
  await Promise.all([cl.connect(c), server.connect(s)]);
  return cl;
}

describe("sanitizeAgentSession", () => {
  it("keeps only non-empty known string fields, trimmed and capped at 200", () => {
    assert.deepEqual(
      sanitizeAgentSession({ host: "  cursor ", session_id: "x".repeat(300), run_id: "" }),
      { host: "cursor", session_id: "x".repeat(200) },
    );
    assert.equal(sanitizeAgentSession({ host: "  " }), undefined);
    assert.equal(sanitizeAgentSession(undefined), undefined);
  });
});

describe("atlasent_evaluate reports the session and lets the key identify the agent", () => {
  it("sends the host app and the host's session id, top-level (never inside context)", async () => {
    process.env.ATLASENT_SESSION_ID = "chat-123";
    process.env.ATLASENT_RUN_ID = "run-9";
    await (await client("claude-code")).callTool({
      name: "atlasent_evaluate",
      arguments: { action_type: "data.delete", context: { environment: "production" } },
    });
    const body = bodies[0];
    assert.deepEqual(body.agent_session, { host: "claude-code", session_id: "chat-123", run_id: "run-9" });
    assert.equal("agent_session" in (body.context as object), false);
  });

  it("omits actor_id when the model leaves it empty, so the runtime derives it from the key", async () => {
    await (await client()).callTool({ name: "atlasent_evaluate", arguments: { action_type: "data.delete" } });
    assert.equal("actor_id" in bodies[0], false);
  });

  it("still forwards an explicit actor_id for non-agent keys", async () => {
    await (await client()).callTool({
      name: "atlasent_evaluate",
      arguments: { action_type: "data.delete", actor_id: "service:deploy-bot" },
    });
    assert.equal(bodies[0].actor_id, "service:deploy-bot");
  });

  it("falls back to a generated, clearly-labelled per-process id when the host gives none", async () => {
    await (await client()).callTool({ name: "atlasent_evaluate", arguments: { action_type: "data.delete" } });
    const session = bodies[0].agent_session as { session_id: string };
    assert.match(session.session_id, /^mcp-process-[0-9a-f-]{36}$/);
  });
});

describe("protected tools report the session too", () => {
  it("deploy_service's agent gate carries agent_session", async () => {
    process.env.ATLASENT_SESSION_ID = "chat-7";
    await (await client("cursor")).callTool({
      name: "deploy_service",
      arguments: {
        service_name: "api",
        actor_id: "agent:a1",
        environment: "staging",
        change_plan: { operation: "deploy", revision: "abc123" },
      },
    });
    assert.ok(bodies.length >= 1);
    assert.deepEqual(bodies[0].agent_session, { host: "cursor", session_id: "chat-7" });
  });
});
