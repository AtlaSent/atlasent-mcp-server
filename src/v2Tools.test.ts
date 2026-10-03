import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { CANON_ACT_CATALOG } from "./canonCatalog.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function parseResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

async function setup() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "v2-test", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client };
}

let originalFetch: typeof globalThis.fetch;

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
});

// ---------------------------------------------------------------------------
// tools/list — confirms v2 tools are registered
// ---------------------------------------------------------------------------

describe("tools/list includes v2 tools", () => {
  it("registers atlasent_evaluate_many, atlasent_evaluate_stream, atlasent_query", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    assert.ok(names.has("atlasent_evaluate_many"));
    assert.ok(names.has("atlasent_evaluate_stream"));
    assert.ok(names.has("atlasent_query"));
  });
});

// ---------------------------------------------------------------------------
// atlasent_evaluate_many
// ---------------------------------------------------------------------------

describe("atlasent_evaluate_many", () => {
  it("returns canonical batch shape on success", async () => {
    globalThis.fetch = mock.fn(async () =>
      jsonResponse({
        batch_id: "11111111-1111-4111-8111-111111111111",
        items: [{ decision: "allow", permit_token: "pt_a" }],
        partial: false,
      }),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_many",
      arguments: {
        items: [{ action: "production.deploy", agent: "agent-1" }],
      },
    });
    const data = parseResult(result);
    assert.equal(data.batch_id, "11111111-1111-4111-8111-111111111111");
    assert.equal((data.items as unknown[]).length, 1);
    assert.equal(data.partial, false);
    assert.equal(result.isError, undefined);
  });

  it("surfaces 404 as feature_not_enabled with v2_batch flag", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "not_found", message: "Not found", status: 404 }, 404));
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_many",
      arguments: { items: [{ action: "production.deploy", agent: "agent-1" }] },
    });
    const data = parseResult(result);
    assert.equal(data.error, "feature_not_enabled");
    assert.equal(data.flag, "v2_batch");
    assert.equal(result.isError, true);
  });

  it("rejects > 100 items at the tool layer", async () => {
    const { client } = await setup();
    const items = Array.from({ length: 101 }, () => ({
      action: "production.deploy",
      agent: "a",
    }));
    const result = await client.callTool({
      name: "atlasent_evaluate_many",
      arguments: { items },
    });
    assert.equal(result.isError, true);
  });

  it("rejects malformed batch_id (not a UUID)", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_many",
      arguments: {
        items: [{ action: "production.deploy", agent: "a" }],
        batch_id: "not-a-uuid",
      },
    });
    assert.equal(result.isError, true);
  });

  it("surfaces an escalate item as a distinct error (C.MCP1)", async () => {
    // Regression test: checkEscalate() previously only looked for a
    // top-level `decision` field, which the real batch response never has —
    // decisions live per-item inside items[]. This must now be caught.
    globalThis.fetch = mock.fn(async () =>
      jsonResponse({
        batch_id: "11111111-1111-4111-8111-111111111111",
        items: [
          { decision: "allow", permit_token: "pt_a" },
          { decision: "escalate", reasons: ["needs human review"] },
        ],
        partial: false,
      }),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_many",
      arguments: {
        items: [
          { action: "production.deploy", agent: "agent-1" },
          { action: "payment.wire_transfer", agent: "agent-1" },
        ],
      },
    });
    const data = parseResult(result);
    assert.equal(result.isError, true);
    assert.equal(data.error, "escalate");
    assert.deepEqual(data.escalated_indices, [1]);
    // The non-escalated item's decision must not be lost.
    assert.equal((data.items as Array<Record<string, unknown>>)[0].decision, "allow");
  });

  it("does not flag escalate when no item escalates", async () => {
    globalThis.fetch = mock.fn(async () =>
      jsonResponse({
        batch_id: "22222222-2222-4222-8222-222222222222",
        items: [
          { decision: "allow", permit_token: "pt_a" },
          { decision: "deny", reasons: ["no approval"] },
        ],
        partial: false,
      }),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_many",
      arguments: {
        items: [
          { action: "production.deploy", agent: "agent-1" },
          { action: "data.delete", agent: "agent-1" },
        ],
      },
    });
    const data = parseResult(result);
    assert.equal(result.isError, undefined);
    assert.equal(data.error, undefined);
  });

  it("forwards optional context per item", async () => {
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return jsonResponse({
        batch_id: "11111111-1111-4111-8111-111111111111",
        items: [{ decision: "allow", permit_token: "pt_a" }],
        partial: false,
      });
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_evaluate_many",
      arguments: {
        items: [
          {
            action: "production.deploy",
            agent: "agent-1",
            context: { environment: "prod" },
          },
        ],
      },
    });
    const body = captured[0].body as Record<string, unknown>;
    const items = body.items as Array<Record<string, unknown>>;
    // Exact wire item: the runtime's BatchItem reads action_type / actor_id.
    assert.deepEqual(items, [
      { action_type: "production.deploy", actor_id: "agent-1", context: { environment: "prod" } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// atlasent_evaluate_stream
// ---------------------------------------------------------------------------

describe("atlasent_evaluate_stream", () => {
  it("buffers SSE and returns the complete batch", async () => {
    const sse =
      `event: decision\ndata: ${JSON.stringify({ decision: "allow", permit_token: "p1" })}\n\n` +
      `event: complete\ndata: ${JSON.stringify({ batch_id: "55555555-5555-4555-8555-555555555555", partial: false })}\n\n`;
    globalThis.fetch = mock.fn(async () => sseResponse(sse));
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_stream",
      arguments: { items: [{ action: "production.deploy", agent: "agent-1" }] },
    });
    const data = parseResult(result);
    assert.equal(data.batch_id, "55555555-5555-4555-8555-555555555555");
    assert.equal((data.items as unknown[]).length, 1);
    assert.equal(data.partial, false);
  });

  it("surfaces per-item error frames and marks partial=true", async () => {
    const sse =
      `event: error\ndata: ${JSON.stringify({ code: "UPSTREAM_TIMEOUT" })}\n\n` +
      `event: decision\ndata: ${JSON.stringify({ decision: "allow" })}\n\n` +
      `event: complete\ndata: ${JSON.stringify({ batch_id: "66666666-6666-4666-8666-666666666666", partial: true })}\n\n`;
    globalThis.fetch = mock.fn(async () => sseResponse(sse));
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_stream",
      arguments: {
        items: [
          { action: "test.a", agent: "x" },
          { action: "test.b", agent: "x" },
        ],
      },
    });
    const data = parseResult(result);
    assert.equal(data.partial, true);
    const items = data.items as Array<Record<string, unknown>>;
    assert.ok("error" in items[0]);
  });

  it("surfaces an escalate item as a distinct error (C.MCP1)", async () => {
    const sse =
      `event: decision\ndata: ${JSON.stringify({ decision: "allow", permit_token: "p1" })}\n\n` +
      `event: decision\ndata: ${JSON.stringify({ decision: "escalate", reasons: ["needs human review"] })}\n\n` +
      `event: complete\ndata: ${JSON.stringify({ batch_id: "77777777-7777-4777-8777-777777777777", partial: false })}\n\n`;
    globalThis.fetch = mock.fn(async () => sseResponse(sse));
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_stream",
      arguments: {
        items: [
          { action: "production.deploy", agent: "agent-1" },
          { action: "payment.wire_transfer", agent: "agent-1" },
        ],
      },
    });
    const data = parseResult(result);
    assert.equal(result.isError, true);
    assert.equal(data.error, "escalate");
    assert.deepEqual(data.escalated_indices, [1]);
  });

  it("surfaces 404 as feature_not_enabled with v2_streaming flag", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "not_found", message: "Not found", status: 404 }, 404));
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate_stream",
      arguments: { items: [{ action: "production.deploy", agent: "a" }] },
    });
    const data = parseResult(result);
    assert.equal(data.error, "feature_not_enabled");
    assert.equal(data.flag, "v2_streaming");
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// atlasent_query
// ---------------------------------------------------------------------------

describe("atlasent_query", () => {
  it("returns { data } on success", async () => {
    globalThis.fetch = mock.fn(async () =>
      jsonResponse({
        data: { recentEvaluations: [{ id: "e1" }, { id: "e2" }] },
      }),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_query",
      arguments: {
        query: "{ recentEvaluations(limit: 5) { id } }",
      },
    });
    const data = parseResult(result);
    const payload = data.data as Record<string, unknown>;
    assert.equal((payload.recentEvaluations as unknown[]).length, 2);
    assert.equal(result.isError, undefined);
  });

  it("surfaces 404 as feature_not_enabled with v2_graphql flag", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "not_found", message: "Not found", status: 404 }, 404));
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_query",
      arguments: { query: "{ activeBundle { id } }" },
    });
    const data = parseResult(result);
    assert.equal(data.error, "feature_not_enabled");
    assert.equal(data.flag, "v2_graphql");
    assert.equal(result.isError, true);
  });

  it("rejects empty query at tool layer", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_query",
      arguments: { query: "" },
    });
    assert.equal(result.isError, true);
  });

  it("forwards variables", async () => {
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return jsonResponse({ data: { recentEvaluations: [] } });
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_query",
      arguments: {
        query: "query Q($n: Int!) { recentEvaluations(limit: $n) { id } }",
        variables: { n: 7 },
      },
    });
    const body = captured[0].body as Record<string, unknown>;
    assert.deepEqual(body.variables, { n: 7 });
  });
});

// ---------------------------------------------------------------------------
// Per-item action type validation (follow-up to #229)
//
// atlasent-api v1-evaluate-batch and v1-evaluate-stream hand every item
// verbatim to the canonical v1-evaluate handleEvaluate, which rejects any
// action type outside ACTION_TYPE_RE with 400 invalid_action_type. So these
// tools validate each item with the same pattern, and a single bad item fails
// the whole call before anything is sent.
// ---------------------------------------------------------------------------

const BAD_ACTIONS = [
  "production/deploy",
  "a/b",
  "/",
  "Production.Deploy",
  "github:production.deploy",
  "production-deploy.run",
  "production deploy",
  "deploy",
  ".deploy",
  "production.",
  "production..deploy",
  "1production.deploy",
  "production.deploy\n",
  "production.d\u0435ploy", // Cyrillic е
];

for (const tool of ["atlasent_evaluate_many", "atlasent_evaluate_stream"] as const) {
  describe(`${tool} per-item action validation`, () => {
    it("refuses every out-of-pattern action, with fetch never called", async () => {
      const { client } = await setup();
      for (const bad of BAD_ACTIONS) {
        const fetchMock = mock.fn(async () =>
          jsonResponse({ batch_id: "x", items: [{ decision: "allow" }], partial: false }),
        );
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
        const result = await client.callTool({
          name: tool,
          arguments: { items: [{ action: bad, agent: "agent-1" }] },
        }).then(
          (r) => r,
          (e: unknown) => ({ isError: true, content: [{ type: "text", text: String(e) }] }),
        );
        assert.equal(result.isError, true, `should refuse ${JSON.stringify(bad)}`);
        assert.match(JSON.stringify(result.content), /must be canonical/);
        assert.equal(fetchMock.mock.callCount(), 0, `fetch called for ${JSON.stringify(bad)}`);
      }
    });

    it("one bad item among valid ones fails the whole call before any fetch", async () => {
      const fetchMock = mock.fn(async () =>
        jsonResponse({ batch_id: "x", items: [], partial: false }),
      );
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      const { client } = await setup();
      const result = await client.callTool({
        name: tool,
        arguments: {
          items: [
            { action: "production.deploy", agent: "agent-1" },
            { action: "access.grant", agent: "agent-1" },
            { action: "production/deploy", agent: "agent-1" },
            { action: "data.delete", agent: "agent-1" },
          ],
        },
      }).then(
        (r) => r,
        (e: unknown) => ({ isError: true, content: [{ type: "text", text: String(e) }] }),
      );
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /must be canonical/);
      assert.equal(fetchMock.mock.callCount(), 0);
    });

    it("accepts every Canon slug and forwards them unchanged", async () => {
      assert.ok(CANON_ACT_CATALOG.length > 0, "empty catalog would make this vacuous");
      const slugs = CANON_ACT_CATALOG.map((c) => c.slug);
      // The endpoints cap a call at 100 items.
      for (let i = 0; i < slugs.length; i += 100) {
        const chunk = slugs.slice(i, i + 100);
        const sent: string[] = [];
        globalThis.fetch = mock.fn(async (_url: unknown, init?: RequestInit) => {
          const body = JSON.parse((init?.body as string) ?? "{}") as {
            items: Array<{ action_type: string }>;
          };
          sent.push(...body.items.map((it) => it.action_type));
          if (tool === "atlasent_evaluate_stream") {
            return sseResponse('event: complete\ndata: {"batch_id":"x","partial":false}\n\n');
          }
          return jsonResponse({ batch_id: "x", items: [], partial: false });
        }) as unknown as typeof globalThis.fetch;
        const { client } = await setup();
        const result = await client.callTool({
          name: tool,
          arguments: { items: chunk.map((action) => ({ action, agent: "agent-1" })) },
        });
        assert.doesNotMatch(JSON.stringify(result.content), /must be canonical/);
        assert.deepEqual(sent, chunk);
      }
    });
  });
}
