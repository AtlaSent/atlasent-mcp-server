import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, _resetRateLimitForTests } from "./server.js";

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
}

function forceRemoteMode(): void {
  process.env.ATLASENT_MODE = "remote";
  process.env.ATLASENT_API_KEY = "test-key";
  process.env.ATLASENT_BASE_URL = "https://api.test";
}

function clearMode(): void {
  delete process.env.ATLASENT_MODE;
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_ANON_KEY;
  delete process.env.ATLASENT_BASE_URL;
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseResult(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

async function setup() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "verify-before-execute-test", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, server };
}

const DEPLOY_ARGS = {
  service_name: "billing-api",
  environment: "staging",
  actor_id: "agent-7",
  change_plan: { operation: "deploy", revision: "abc123" },
};

// production.deploy is mandatory change control: the server also creates a
// Change Brief and mints an agent actor identity before evaluating. Those are
// answered 404 here (older runtime) so the call sequence under test is only
// evaluate / verify.
function isChangeControlSideCall(url: string): boolean {
  return url.includes("/v1-change-brief") || url.includes("/v1-agent-actor-identity") ||
    url.includes("/v1-source-provenance-seal");
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _resetRateLimitForTests();
  forceRemoteMode();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearMode();
});

describe("deploy_service verify-before-execute boundary", () => {
  it("verifies both positive authorization permits before producing a deploy result", async () => {
    const calls: CapturedCall[] = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (isChangeControlSideCall(url)) return jsonResponse({ error: "not_found" }, 404);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });

      switch (calls.length) {
        case 1:
          return jsonResponse({ decision: "allow", permit_token: "pt_agent", request_id: "req_agent" });
        case 2:
          return jsonResponse({ valid: true, outcome: "allow" });
        case 3:
          return jsonResponse({ decision: "allow", permit_token: "pt_deploy", request_id: "req_deploy" });
        case 4:
          return jsonResponse({ valid: true, outcome: "allow" });
        default:
          throw new Error(`unexpected request ${calls.length}: ${url}`);
      }
    };

    const { client } = await setup();
    const result = await client.callTool({ name: "deploy_service", arguments: DEPLOY_ARGS });
    const data = parseResult(result);

    assert.equal(data.decision, "allow");
    assert.equal((data.verification as Record<string, unknown>).valid, true);
    assert.equal((data.result as Record<string, unknown>).status, "deployed");
    assert.deepEqual(
      calls.map((c) => new URL(c.url).pathname),
      ["/v1-evaluate", "/v1-verify-permit", "/v1-evaluate", "/v1-verify-permit"],
      "both authorization layers must be verified before the protected result exists",
    );
    assert.equal(calls[0].body.action_type, "agent.tool.invoke");
    assert.equal(calls[1].body.action_type, "agent.tool.invoke");
    assert.equal(calls[2].body.action_type, "production.deploy");
    assert.equal(calls[3].body.action_type, "production.deploy");
  });

  it("blocks before action-specific authorization when the agent-tool permit cannot verify", async () => {
    const calls: CapturedCall[] = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (isChangeControlSideCall(url)) return jsonResponse({ error: "not_found" }, 404);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });

      if (calls.length === 1) {
        return jsonResponse({ decision: "allow", permit_token: "pt_agent", request_id: "req_agent" });
      }
      if (calls.length === 2) {
        return jsonResponse({
          valid: false,
          outcome: "deny",
          verify_error_code: "PERMIT_ALREADY_USED",
          reasons: ["agent-tool permit cannot be verified"],
        });
      }
      throw new Error(`unexpected post-verification request: ${url}`);
    };

    const { client } = await setup();
    const result = await client.callTool({ name: "deploy_service", arguments: DEPLOY_ARGS });
    const data = parseResult(result);

    assert.equal(data.decision, "deny");
    assert.equal(data.result, undefined, "native deploy result must not exist after outer verification failure");
    assert.equal(calls.length, 2, "action-specific authorize must never run after outer Gate failure");
    assert.equal(result.isError, true);
  });

  it("blocks the native deploy when the production.deploy permit cannot verify", async () => {
    const calls: CapturedCall[] = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (isChangeControlSideCall(url)) return jsonResponse({ error: "not_found" }, 404);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });

      switch (calls.length) {
        case 1:
          return jsonResponse({ decision: "allow", permit_token: "pt_agent", request_id: "req_agent" });
        case 2:
          return jsonResponse({ valid: true, outcome: "allow" });
        case 3:
          return jsonResponse({ decision: "allow", permit_token: "pt_deploy", request_id: "req_deploy" });
        case 4:
          return jsonResponse({
            valid: false,
            outcome: "deny",
            verify_error_code: "PERMIT_BINDING_MISMATCH",
            reasons: ["deployment permit binding mismatch"],
          });
        default:
          throw new Error(`unexpected request ${calls.length}: ${url}`);
      }
    };

    const { client } = await setup();
    const result = await client.callTool({ name: "deploy_service", arguments: DEPLOY_ARGS });
    const data = parseResult(result);

    assert.equal(data.decision, "deny");
    assert.equal(data.result, undefined, "native deploy result must not exist after action-specific verification failure");
    assert.equal((data.verification as Record<string, unknown>).valid, false);
    assert.deepEqual(
      calls.map((c) => new URL(c.url).pathname),
      ["/v1-evaluate", "/v1-verify-permit", "/v1-evaluate", "/v1-verify-permit"],
    );
    assert.equal(result.isError, true);
  });
});
