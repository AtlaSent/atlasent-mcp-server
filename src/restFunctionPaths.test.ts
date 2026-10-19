// Pins the exact URL every REST-style tool requests against the hosted API.
//
// On 2026-10-19, unauthenticated probes showed https://api.atlasent.io serves
// edge functions only under /functions/v1/<function-name>: the slash-form
// /v1/<resource> paths at the domain root answered 404 "requested path is
// invalid". The tools below were moved to the function-name form because
// their atlasent-api handler routes that deployed shape. The tools pinned in
// the "still slash-form" block were NOT moved: their handler misreads the
// deployed shape, has no route, or needs a different request shape. Moving
// one of them needs a handler fix first, not just an edit here.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, _resetRateLimitForTests } from "./server.js";

const HOSTED = "https://api.atlasent.io/functions/v1";
const PERMIT_ID = "11111111-1111-4111-8111-111111111111";
const EVAL_ID = "22222222-2222-4222-8222-222222222222";

interface Captured {
  url: string;
  method: string;
}

let captured: Captured[] = [];
let originalFetch: typeof globalThis.fetch;

function captureFetch(response: object = {}, status = 200): typeof globalThis.fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), method: init?.method ?? "GET" });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

async function call(name: string, args: Record<string, unknown>) {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client.callTool({ name, arguments: args });
}

function onlyRequest(): Captured {
  assert.equal(captured.length, 1, `expected exactly one request, got ${JSON.stringify(captured)}`);
  return captured[0];
}

beforeEach(() => {
  _resetRateLimitForTests();
  captured = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = captureFetch();
  process.env.ATLASENT_MODE = "remote";
  process.env.ATLASENT_API_KEY = "test-key";
  process.env.ATLASENT_BASE_URL = HOSTED;
  delete process.env.ATLASENT_MCP_READONLY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ATLASENT_MODE;
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_BASE_URL;
});

describe("REST-style tools routed to deployed function names", () => {
  it("atlasent_list_policies -> GET {base}/v1-policies/ (trailing slash kept)", async () => {
    const res = await call("atlasent_list_policies", { org_id: "org_1", status: "active" });
    assert.equal(res.isError, undefined);
    const r = onlyRequest();
    assert.equal(r.method, "GET");
    const u = new URL(r.url);
    assert.equal(`${u.origin}${u.pathname}`, `${HOSTED}/v1-policies/`);
    assert.equal(u.searchParams.get("status"), "active");
  });

  it("atlasent_list_permits -> GET {base}/v1-permits", async () => {
    const res = await call("atlasent_list_permits", { org_id: "org_1", status: "issued", limit: 5 });
    assert.equal(res.isError, undefined);
    const r = onlyRequest();
    assert.equal(r.method, "GET");
    const u = new URL(r.url);
    assert.equal(`${u.origin}${u.pathname}`, `${HOSTED}/v1-permits`);
    assert.equal(u.searchParams.get("status"), "issued");
    assert.equal(u.searchParams.get("limit"), "5");
  });

  it("atlasent_list_audit_events -> GET {base}/v1-audit/events with from/to/limit", async () => {
    const res = await call("atlasent_list_audit_events", {
      org_id: "org_1",
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-02T00:00:00Z",
      limit: 10,
    });
    assert.equal(res.isError, undefined);
    const r = onlyRequest();
    assert.equal(r.method, "GET");
    const u = new URL(r.url);
    assert.equal(`${u.origin}${u.pathname}`, `${HOSTED}/v1-audit/events`);
    assert.equal(u.searchParams.get("from"), "2026-10-01T00:00:00Z");
    assert.equal(u.searchParams.get("to"), "2026-10-02T00:00:00Z");
    assert.equal(u.searchParams.get("limit"), "10");
    assert.equal(u.searchParams.has("evaluation_id"), false);
  });

  it("atlasent_list_audit_events refuses evaluation_id before any request (no unfiltered answer)", async () => {
    const res = await call("atlasent_list_audit_events", { org_id: "org_1", evaluation_id: EVAL_ID });
    assert.equal(res.isError, true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    assert.match(text, /evaluation_id is not a filter/);
    assert.equal(captured.length, 0, "no request may go out");
  });

  it("atlasent_get_evidence_export -> GET {base}/v1-evidence-exports/{id}", async () => {
    const res = await call("atlasent_get_evidence_export", { org_id: "org_1", export_id: "exp 1" });
    assert.equal(res.isError, undefined);
    const r = onlyRequest();
    assert.equal(r.method, "GET");
    assert.equal(r.url, `${HOSTED}/v1-evidence-exports/exp%201`);
  });

  it("uses the hosted default when ATLASENT_BASE_URL is unset", async () => {
    delete process.env.ATLASENT_BASE_URL;
    await call("atlasent_list_permits", { org_id: "org_1" });
    const u = new URL(onlyRequest().url);
    assert.equal(`${u.origin}${u.pathname}`, `${HOSTED}/v1-permits`);
  });

  it("an HTTP error from a routed function is an error result, not data", async () => {
    globalThis.fetch = captureFetch({ error: "not_found" }, 404);
    const res = await call("atlasent_list_permits", { org_id: "org_1" });
    assert.equal(res.isError, true);
  });
});

describe("REST-style tools still on slash-form (blocked on atlasent-api)", () => {
  // Pinned so nobody moves one to the function-name form without its handler
  // routing that shape. See the call sites in src/engine.ts for each reason.
  // These tools are hidden against the hosted runtime (src/gatewayTools.ts),
  // so the explicit opt-in registers them here to pin the URL they request.
  beforeEach(() => {
    process.env.ATLASENT_MCP_ENABLE_GATEWAY_TOOLS = "1";
  });
  afterEach(() => {
    delete process.env.ATLASENT_MCP_ENABLE_GATEWAY_TOOLS;
  });

  it("atlasent_get_permit stays at {root}/v1/permits/{id} until atlasent-api#4522 is in production", async () => {
    await call("atlasent_get_permit", { permit_id: PERMIT_ID });
    assert.equal(onlyRequest().url, `https://api.atlasent.io/v1/permits/${PERMIT_ID}`);
  });

  it("atlasent_check_permit stays at {root}/v1/permits/{id}/valid", async () => {
    await call("atlasent_check_permit", { permit_id: PERMIT_ID });
    assert.equal(onlyRequest().url, `https://api.atlasent.io/v1/permits/${PERMIT_ID}/valid`);
  });

  it("atlasent_get_decision stays at {root}/v1/execution-evaluations/{id}", async () => {
    await call("atlasent_get_decision", { evaluation_id: EVAL_ID });
    assert.equal(onlyRequest().url, `https://api.atlasent.io/v1/execution-evaluations/${EVAL_ID}`);
  });

  it("atlasent_list_evidence_exports stays at {root}/v1/orgs/{org}/evidence-exports", async () => {
    await call("atlasent_list_evidence_exports", { org_id: "org_1" });
    assert.equal(onlyRequest().url, "https://api.atlasent.io/v1/orgs/org_1/evidence-exports");
  });
});

describe("gateway-only tools against the hosted runtime (no opt-in)", () => {
  it("are not registered, so calling one runs nothing and requests nothing", async () => {
    for (const [name, args] of [
      ["atlasent_get_permit", { permit_id: PERMIT_ID }],
      ["atlasent_get_decision", { evaluation_id: EVAL_ID }],
      ["atlasent_list_evidence_exports", { org_id: "org_1" }],
    ] as const) {
      const res = await call(name, args).catch((e: unknown) => ({ isError: true, thrown: e }));
      assert.equal(res.isError, true, `${name} must not succeed when hidden`);
    }
    assert.equal(captured.length, 0, "a hidden tool must not reach the network");
  });
});
