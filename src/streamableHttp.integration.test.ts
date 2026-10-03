/**
 * Streamable HTTP transport — end-to-end integration.
 *
 * Boots the actual Streamable HTTP MCP server against a stubbed upstream
 * AtlaSent API and connects with the canonical MCP client. Verifies:
 *
 *   1. The server starts and binds a port.
 *   2. A client speaking Streamable HTTP can initialize a session,
 *      list tools, and call a v2 tool whose response round-trips
 *      through the transport.
 *   3. The closed-by-default 404 path also round-trips.
 *   4. Bearer auth is enforced when ATLASENT_MCP_HTTP_BEARER is set.
 *
 * No real network calls — fetch is mocked at the test process boundary.
 */

import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startStreamableHttp, type StreamableHttpHandle } from "./streamableHttp.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

let handle: StreamableHttpHandle | undefined;
let originalFetch: typeof globalThis.fetch;
// Save fetch BEFORE any mocking so we can route MCP-host traffic to the
// real implementation while still mocking the upstream AtlaSent fetch
// inside the server process (same process — they share globalThis).
const realFetch = globalThis.fetch.bind(globalThis);

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.ATLASENT_MODE = "remote";
  process.env.ATLASENT_API_KEY = "test-key";
  process.env.ATLASENT_BASE_URL = "https://api.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ATLASENT_MODE;
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_BASE_URL;
  delete process.env.ATLASENT_MCP_HTTP_BEARER;
});

after(async () => {
  if (handle) await handle.close();
});

/**
 * Install a fetch shim that:
 *   - forwards localhost:<port>/mcp traffic to the real fetch
 *     (so the MCP client → MCP server hop actually happens)
 *   - routes everything else (i.e. the AtlaSent upstream) to `upstream`
 */
function installSplitFetch(
  upstream: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  const shim = async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (u.includes("127.0.0.1") || u.includes("localhost")) {
      return realFetch(url as RequestInfo, init);
    }
    return upstream(u, init);
  };
  globalThis.fetch = mock.fn(shim);
}

describe("Streamable HTTP transport — end-to-end", () => {
  before(async () => {
    // Pick an ephemeral port; the OS will choose one.
    handle = await startStreamableHttp({ port: 0, host: "127.0.0.1", path: "/mcp" });
  });

  it("lists tools over Streamable HTTP", async () => {
    installSplitFetch(() => jsonResponse({ error: "should not be called" }, 500));
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle!.port}/mcp`),
    );
    const client = new Client({ name: "shttp-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((t) => t.name));
      assert.ok(names.has("atlasent_evaluate_many"));
      assert.ok(names.has("atlasent_evaluate_stream"));
      assert.ok(names.has("atlasent_query"));
      assert.ok(names.has("evaluate"), "v1 tools must still be registered");
    } finally {
      await transport.close();
    }
  });

  it("calls atlasent_evaluate_many round-trip and parses the canonical shape", async () => {
    installSplitFetch((url) => {
      if (url === "https://api.test/v1-evaluate-batch") {
        return jsonResponse({
          batch_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          items: [{ decision: "allow", permit_token: "pt_remote" }],
          partial: false,
        });
      }
      return jsonResponse({ error: "unexpected upstream call" }, 500);
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle!.port}/mcp`),
    );
    const client = new Client({ name: "shttp-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "atlasent_evaluate_many",
        arguments: { items: [{ action: "production.deploy", agent: "agent-1" }] },
      });
      const data = parseToolResult(result);
      assert.equal(data.batch_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      const items = data.items as Array<Record<string, unknown>>;
      assert.equal(items[0].decision, "allow");
      assert.equal(items[0].permit_token, "pt_remote");
    } finally {
      await transport.close();
    }
  });

  it("surfaces upstream 404 as feature_not_enabled over the transport", async () => {
    installSplitFetch((url) => {
      if (url === "https://api.test/v1-graphql") {
        return jsonResponse({ error: "not_found", message: "Not found", status: 404 }, 404);
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle!.port}/mcp`),
    );
    const client = new Client({ name: "shttp-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "atlasent_query",
        arguments: { query: "{ activeBundle { id } }" },
      });
      const data = parseToolResult(result);
      assert.equal(data.error, "feature_not_enabled");
      assert.equal(data.flag, "v2_graphql");
      assert.equal(result.isError, true);
    } finally {
      await transport.close();
    }
  });
});

describe("Streamable HTTP transport — bearer auth", () => {
  let authHandle: StreamableHttpHandle | undefined;

  before(async () => {
    process.env.ATLASENT_MCP_HTTP_BEARER = "secret-bearer-123";
    authHandle = await startStreamableHttp({
      port: 0,
      host: "127.0.0.1",
      path: "/mcp",
    });
  });

  after(async () => {
    if (authHandle) await authHandle.close();
    delete process.env.ATLASENT_MCP_HTTP_BEARER;
  });

  it("rejects requests without the configured bearer", async () => {
    // Use raw fetch — initializing a Client would hang on the 401.
    const res = await realFetch(`http://127.0.0.1:${authHandle!.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      }),
    });
    assert.equal(res.status, 401);
  });

  it("accepts requests with the correct bearer", async () => {
    installSplitFetch(() => jsonResponse({ error: "unused" }, 500));
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${authHandle!.port}/mcp`),
      {
        requestInit: {
          headers: { Authorization: "Bearer secret-bearer-123" },
        },
      },
    );
    const client = new Client({ name: "shttp-auth-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.length > 0);
    } finally {
      await transport.close();
    }
  });
});
