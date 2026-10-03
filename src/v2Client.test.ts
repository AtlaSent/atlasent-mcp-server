import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBatch,
  evaluateStream,
  graphqlQuery,
  FeatureNotEnabledError,
  V2HttpError,
  isFlagDisabledResponse,
} from "./v2Client.js";

const ITEM = { action: "production.deploy", agent: "agent-1" };

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

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.ATLASENT_API_KEY = "test-key";
  process.env.ATLASENT_BASE_URL = "https://api.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_BASE_URL;
  delete process.env.ATLASENT_ANON_KEY;
});

// ---------------------------------------------------------------------------
// evaluateBatch — POST /v1-evaluate-batch
// ---------------------------------------------------------------------------

describe("evaluateBatch", () => {
  it("POSTs items and batch_id, returns the canonical shape", async () => {
    const captured: { url: string; init: RequestInit }[] = [];
    const fn = async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        batch_id: "11111111-1111-4111-8111-111111111111",
        items: [{ decision: "allow", permit_token: "pt_1" }],
        partial: false,
      });
    };
    globalThis.fetch = mock.fn(fn);

    const out = await evaluateBatch({
      items: [ITEM],
      batch_id: "11111111-1111-4111-8111-111111111111",
    });

    assert.equal(out.batch_id, "11111111-1111-4111-8111-111111111111");
    assert.equal(out.partial, false);
    assert.equal(out.items.length, 1);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, "https://api.test/v1-evaluate-batch");
    const headers = captured[0].init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer test-key");
    const body = JSON.parse(captured[0].init.body as string) as Record<string, unknown>;
    assert.equal(body.batch_id, "11111111-1111-4111-8111-111111111111");
    assert.equal((body.items as unknown[]).length, 1);
  });

  it("throws FeatureNotEnabledError on 404 (closed-by-default)", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "not_found", message: "Not found", status: 404 }, 404));
    await assert.rejects(
      () => evaluateBatch({ items: [ITEM] }),
      (e: unknown) => {
        assert.ok(e instanceof FeatureNotEnabledError);
        assert.equal((e as FeatureNotEnabledError).flag, "v2_batch");
        return true;
      },
    );
  });

  it("rejects empty items array client-side", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({}));
    await assert.rejects(() => evaluateBatch({ items: [] }), /non-empty/);
  });

  it("rejects more than 100 items client-side", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({}));
    const items = Array.from({ length: 101 }, () => ITEM);
    await assert.rejects(() => evaluateBatch({ items }), /exceeds max 100/);
  });

  it("surfaces 401 as V2HttpError with helpful message", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
    await assert.rejects(
      () => evaluateBatch({ items: [ITEM] }),
      (e: unknown) => {
        assert.ok(e instanceof V2HttpError);
        assert.equal((e as V2HttpError).status, 401);
        assert.match((e as Error).message, /Authentication failed/i);
        return true;
      },
    );
  });

  it("surfaces 429 as V2HttpError", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "rate limited" }, 429));
    await assert.rejects(
      () => evaluateBatch({ items: [ITEM] }),
      (e: unknown) => e instanceof V2HttpError && (e as V2HttpError).status === 429,
    );
  });
});

// ---------------------------------------------------------------------------
// evaluateStream — POST /v1-evaluate-stream
// ---------------------------------------------------------------------------

describe("evaluateStream", () => {
  it("buffers SSE frames and returns the complete batch in input order", async () => {
    const sse =
      `event: decision\ndata: ${JSON.stringify({ decision: "allow", permit_token: "p1" })}\n\n` +
      `event: decision\ndata: ${JSON.stringify({ decision: "deny", reason: "no approval" })}\n\n` +
      `event: complete\ndata: ${JSON.stringify({ batch_id: "22222222-2222-4222-8222-222222222222", partial: false })}\n\n`;
    globalThis.fetch = mock.fn(async () => sseResponse(sse));

    const out = await evaluateStream({ items: [ITEM, ITEM] });
    assert.equal(out.batch_id, "22222222-2222-4222-8222-222222222222");
    assert.equal(out.partial, false);
    assert.equal(out.items.length, 2);
    const first = out.items[0] as Record<string, unknown>;
    const second = out.items[1] as Record<string, unknown>;
    assert.equal(first.decision, "allow");
    assert.equal(second.decision, "deny");
  });

  it("marks the batch partial and continues when an item emits event:error", async () => {
    const sse =
      `event: decision\ndata: ${JSON.stringify({ decision: "allow" })}\n\n` +
      `event: error\ndata: ${JSON.stringify({ code: "UPSTREAM_TIMEOUT" })}\n\n` +
      `event: decision\ndata: ${JSON.stringify({ decision: "allow" })}\n\n` +
      `event: complete\ndata: ${JSON.stringify({ batch_id: "33333333-3333-4333-8333-333333333333", partial: true })}\n\n`;
    globalThis.fetch = mock.fn(async () => sseResponse(sse));

    const out = await evaluateStream({ items: [ITEM, ITEM, ITEM] });
    assert.equal(out.partial, true);
    assert.equal(out.items.length, 3);
    const errItem = out.items[1] as Record<string, unknown>;
    assert.ok("error" in errItem, "second item should be an error frame");
  });

  it("returns FeatureNotEnabledError on 404", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "not_found", message: "Not found", status: 404 }, 404));
    await assert.rejects(
      () => evaluateStream({ items: [ITEM] }),
      (e: unknown) =>
        e instanceof FeatureNotEnabledError &&
        (e as FeatureNotEnabledError).flag === "v2_streaming",
    );
  });

  it("handles SSE frames arriving across chunk boundaries", async () => {
    // Split the SSE body across two stream chunks at an arbitrary byte
    // boundary inside a frame to exercise the buffered parser.
    const part1 = `event: decision\ndata: {"decisi`;
    const part2 =
      `on": "allow"}\n\n` +
      `event: complete\ndata: ${JSON.stringify({ batch_id: "44444444-4444-4444-8444-444444444444", partial: false })}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(part1));
        controller.enqueue(new TextEncoder().encode(part2));
        controller.close();
      },
    });
    const res = new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    globalThis.fetch = mock.fn(async () => res);

    const out = await evaluateStream({ items: [ITEM] });
    assert.equal(out.items.length, 1);
    assert.equal((out.items[0] as Record<string, unknown>).decision, "allow");
  });
});

// ---------------------------------------------------------------------------
// graphqlQuery — POST /v1-graphql
// ---------------------------------------------------------------------------

describe("graphqlQuery", () => {
  it("POSTs query + variables to /v1-graphql and returns { data }", async () => {
    const captured: { url: string; init: RequestInit }[] = [];
    const fn = async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        data: { recentEvaluations: [{ id: "e1" }] },
      });
    };
    globalThis.fetch = mock.fn(fn);

    const out = await graphqlQuery({
      query: "query Recent($limit: Int!) { recentEvaluations(limit: $limit) { id } }",
      variables: { limit: 10 },
    });
    assert.ok(out.data);
    assert.equal(captured[0].url, "https://api.test/v1-graphql");
    const body = JSON.parse(captured[0].init.body as string) as Record<string, unknown>;
    assert.equal(typeof body.query, "string");
    assert.deepEqual(body.variables, { limit: 10 });
  });

  it("returns FeatureNotEnabledError on 404", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: "not_found", message: "Not found", status: 404 }, 404));
    await assert.rejects(
      () => graphqlQuery({ query: "{ activeBundle { id } }" }),
      (e: unknown) =>
        e instanceof FeatureNotEnabledError &&
        (e as FeatureNotEnabledError).flag === "v2_graphql",
    );
  });

  it("rejects empty query client-side", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({}));
    await assert.rejects(() => graphqlQuery({ query: "" }), /non-empty/);
  });
});

// ---------------------------------------------------------------------------
// Wire contract with atlasent-api (v1-evaluate-batch / v1-evaluate-stream /
// v1-graphql on origin/main): exact URL, exact item shape, and which 404
// means "tenant flag off".
// ---------------------------------------------------------------------------

type Captured = { url: string; body: Record<string, unknown> };

function capture(respond: () => Response): Captured[] {
  const captured: Captured[] = [];
  globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse((init?.body as string) ?? "{}") });
    return respond();
  }) as unknown as typeof globalThis.fetch;
  return captured;
}

const BATCH_OK = () => jsonResponse({ batch_id: "x", items: [], partial: false });
const STREAM_OK = () => sseResponse('event: complete\ndata: {"batch_id":"x","partial":false}\n\n');
const GRAPHQL_OK = () => jsonResponse({ data: {} });

const WIRE_ITEMS_IN = [
  { action: "production.deploy", agent: "agent-1", context: { environment: "prod" } },
  { action: "data.delete", agent: "service:cleanup" },
];
// Byte-exact expectation: action_type/actor_id, nothing else renamed or added,
// and no `context` key when the caller gave none.
const WIRE_ITEMS_OUT = [
  { action_type: "production.deploy", actor_id: "agent-1", context: { environment: "prod" } },
  { action_type: "data.delete", actor_id: "service:cleanup" },
];

describe("wire contract", () => {
  it("evaluateBatch sends items as { action_type, actor_id, context? } to /v1-evaluate-batch", async () => {
    const c = capture(BATCH_OK);
    await evaluateBatch({ items: WIRE_ITEMS_IN, batch_id: "11111111-1111-4111-8111-111111111111" });
    assert.equal(c[0].url, "https://api.test/v1-evaluate-batch");
    assert.deepEqual(c[0].body, {
      items: WIRE_ITEMS_OUT,
      batch_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("evaluateStream sends items as { action_type, actor_id, context? } to /v1-evaluate-stream", async () => {
    const c = capture(STREAM_OK);
    await evaluateStream({ items: WIRE_ITEMS_IN });
    assert.equal(c[0].url, "https://api.test/v1-evaluate-stream");
    assert.deepEqual(c[0].body, { items: WIRE_ITEMS_OUT });
  });

  it("graphqlQuery posts to /v1-graphql", async () => {
    const c = capture(GRAPHQL_OK);
    await graphqlQuery({ query: "{ x }" });
    assert.equal(c[0].url, "https://api.test/v1-graphql");
    assert.deepEqual(c[0].body, { query: "{ x }" });
  });

  it("with ATLASENT_BASE_URL unset, all three use the hosted /functions/v1 base", async () => {
    delete process.env.ATLASENT_BASE_URL;
    const c1 = capture(BATCH_OK);
    await evaluateBatch({ items: [ITEM] });
    const c2 = capture(STREAM_OK);
    await evaluateStream({ items: [ITEM] });
    const c3 = capture(GRAPHQL_OK);
    await graphqlQuery({ query: "{ x }" });
    assert.deepEqual(
      [c1[0].url, c2[0].url, c3[0].url],
      [
        "https://api.atlasent.io/functions/v1/v1-evaluate-batch",
        "https://api.atlasent.io/functions/v1/v1-evaluate-stream",
        "https://api.atlasent.io/functions/v1/v1-graphql",
      ],
    );
  });

  it("a trailing slash on ATLASENT_BASE_URL does not double up", async () => {
    process.env.ATLASENT_BASE_URL = "https://ref.supabase.co/functions/v1/";
    const c = capture(BATCH_OK);
    await evaluateBatch({ items: [ITEM] });
    assert.equal(c[0].url, "https://ref.supabase.co/functions/v1/v1-evaluate-batch");
  });
});

describe("404 classification", () => {
  // What each handler returns when its tenant flag is off: errorResponse(
  // "not_found", "Not found", 404). The batch handler also mirrors
  // error_code/reason.
  const FLAG_OFF_BODIES = [
    { error: "not_found", message: "Not found", status: 404 },
    { error: "not_found", message: "Not found", status: 404, error_code: "not_found", reason: "Not found" },
  ];
  // 404s that are NOT the flag gate: the Supabase gateway's unknown-function
  // answer, an HTML page, an empty body, a different error code.
  const OTHER_404_BODIES = [
    JSON.stringify({ code: "NOT_FOUND", message: "Requested function was not found" }),
    "<html>Not Found</html>",
    "",
    JSON.stringify({ error: "not_enabled" }),
    JSON.stringify({ message: "not_found" }),
    JSON.stringify(["not_found"]),
  ];

  it("isFlagDisabledResponse accepts only the handlers' flag-off envelope", () => {
    for (const b of FLAG_OFF_BODIES) assert.equal(isFlagDisabledResponse(404, JSON.stringify(b)), true);
    for (const b of OTHER_404_BODIES) assert.equal(isFlagDisabledResponse(404, b), false, b);
    assert.equal(isFlagDisabledResponse(400, JSON.stringify(FLAG_OFF_BODIES[0])), false);
  });

  const CALLS: Array<[string, "v2_batch" | "v2_streaming" | "v2_graphql", () => Promise<unknown>]> = [
    ["evaluateBatch", "v2_batch", () => evaluateBatch({ items: [ITEM] })],
    ["evaluateStream", "v2_streaming", () => evaluateStream({ items: [ITEM] })],
    ["graphqlQuery", "v2_graphql", () => graphqlQuery({ query: "{ x }" })],
  ];

  for (const [name, flag, call] of CALLS) {
    it(`${name}: flag-off 404 is FeatureNotEnabledError(${flag})`, async () => {
      for (const b of FLAG_OFF_BODIES) {
        globalThis.fetch = mock.fn(async () => jsonResponse(b, 404)) as unknown as typeof globalThis.fetch;
        await assert.rejects(call, (e: unknown) =>
          e instanceof FeatureNotEnabledError && (e as FeatureNotEnabledError).flag === flag,
        );
      }
    });

    it(`${name}: any other 404 is a V2HttpError, not feature_not_enabled`, async () => {
      for (const b of OTHER_404_BODIES) {
        globalThis.fetch = mock.fn(async () => new Response(b, { status: 404 })) as unknown as typeof globalThis.fetch;
        await assert.rejects(call, (e: unknown) => {
          assert.ok(!(e instanceof FeatureNotEnabledError), `${name} misread ${JSON.stringify(b)} as flag-off`);
          assert.ok(e instanceof V2HttpError);
          assert.equal((e as V2HttpError).status, 404);
          assert.match((e as Error).message, /endpoint not found/);
          return true;
        });
      }
    });
  }
});
