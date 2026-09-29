/**
 * atlasent_await_approval (CROSS-056): waits for a PERSON's decision on a
 * held action and claims the permit on approval. It can never approve, and
 * every outcome other than a genuinely claimed permit is "no permit".
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { awaitApproval, authorize, mintAgentActorIdentity } from "./engine.js";
import { createServer, _resetRateLimitForTests } from "./server.js";

type Route = (method: string, path: string) => { status: number; body: unknown } | "throw";

let originalFetch: typeof globalThis.fetch;
const calls: string[] = [];
const sent: Array<{ method: string; path: string; body: unknown; headers: Record<string, string>; signal: unknown }> = [];

function route(fn: Route): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url)).pathname;
    calls.push(`${method} ${path}`);
    sent.push({
      method,
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal,
    });
    const r = fn(method, path);
    if (r === "throw") throw new Error("network down");
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const FAST = { approval_request_id: "apr_1", max_wait_ms: 2_000, poll_interval_ms: 5 };

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls.length = 0;
  sent.length = 0;
  process.env.ATLASENT_MODE = "remote";
  process.env.ATLASENT_API_KEY = "test-key";
  process.env.ATLASENT_BASE_URL = "https://api.test/functions/v1";
  _resetRateLimitForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ATLASENT_MODE;
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_BASE_URL;
});

describe("awaitApproval", () => {
  it("returns the claimed permit once a person approves (after pending polls)", async () => {
    let polls = 0;
    route((m, p) => {
      if (m === "GET" && p === "/functions/v1/v1-approvals/apr_1") {
        polls += 1;
        return { status: 200, body: { status: polls < 3 ? "pending" : "approved" } };
      }
      if (m === "POST" && p === "/functions/v1/v1-approvals/apr_1/claim-permit") {
        return { status: 200, body: { claimed: true, permit_token: "pt.v4.abc" } };
      }
      return { status: 500, body: {} };
    });
    const r = await awaitApproval(FAST);
    assert.deepEqual(r, { outcome: "approved", permit_token: "pt.v4.abc", approval_request_id: "apr_1" });
    // REST family is served at the gateway root, not under /functions/v1.
    assert.ok(calls.includes("GET /functions/v1/v1-approvals/apr_1"));
    assert.equal(calls.filter((c) => c.startsWith("POST")).length, 1, "claims exactly once");
  });

  const noPermitCases: Array<[string, Route]> = [
    ["the person rejected it", (m) => (m === "GET" ? { status: 200, body: { status: "denied" } } : { status: 500, body: {} })],
    ["the request expired", (m) => (m === "GET" ? { status: 200, body: { status: "expired" } } : { status: 500, body: {} })],
    ["approved but the claim was already taken", (m) =>
      m === "GET" ? { status: 200, body: { status: "approved" } } : { status: 200, body: { claimed: false } }],
    ["approved but the claim says claimed:false (even if a token is present)", (m) =>
      m === "GET"
        ? { status: 200, body: { status: "approved" } }
        : { status: 200, body: { claimed: false, permit_token: "pt.v4.stale" } }],
    ["approved but the claim returned no token", (m) =>
      m === "GET" ? { status: 200, body: { status: "approved" } } : { status: 200, body: { claimed: true } }],
    ["approved but the claim errored", (m) =>
      m === "GET" ? { status: 200, body: { status: "approved" } } : { status: 500, body: {} }],
    ["the key lacks approvals:read", () => ({ status: 403, body: {} })],
    ["the request does not exist", () => ({ status: 404, body: {} })],
  ];
  for (const [label, fn] of noPermitCases) {
    it(`gives no permit when ${label}`, async () => {
      route(fn);
      const r = await awaitApproval(FAST);
      assert.equal(r.outcome, "not_approved");
      assert.equal("permit_token" in r, false);
    });
  }

  it("times out with no permit when nobody decides, surviving network blips", async () => {
    let n = 0;
    route(() => (++n % 2 === 0 ? "throw" : { status: 200, body: { status: "pending" } }));
    const r = await awaitApproval({ ...FAST, max_wait_ms: 60 });
    assert.equal(r.outcome, "timeout");
    assert.equal("permit_token" in r, false);
  });
});

describe("hold results carry approval_request_id", () => {
  it("authorize() keeps it so a host can wait on it", async () => {
    route((_m, p) =>
      p === "/functions/v1/v1-evaluate"
        ? { status: 200, body: { decision: "hold", deny_reason: "needs a person", approval_request_id: "apr_9" } }
        : { status: 500, body: {} },
    );
    const d = await authorize({ action_type: "data.delete", actor_id: "agent:claude", environment: "production" });
    assert.equal(d.decision, "hold");
    assert.equal(d.decision === "hold" && d.approval_request_id, "apr_9");
  });
});

describe("atlasent_await_approval tool", () => {
  async function client() {
    const server = createServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const cl = new Client({ name: "t", version: "1" });
    await Promise.all([cl.connect(c), server.connect(s)]);
    return cl;
  }

  it("has no input that could approve or decide", async () => {
    const { tools } = await (await client()).listTools();
    const t = tools.find((x) => x.name === "atlasent_await_approval");
    assert.ok(t, "tool registered");
    const props = Object.keys((t!.inputSchema as { properties?: object }).properties ?? {}).sort();
    // change_plan is only a declaration (the runtime executes the APPROVED
    // plan) and on_plan_mismatch picks between two non-approving recoveries.
    assert.deepEqual(props, ["approval_request_id", "change_plan", "max_wait_seconds", "on_plan_mismatch"]);
    const mode = (t!.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.on_plan_mismatch;
    assert.deepEqual(mode.enum, ["rerequest", "use_approved"]);
  });

  it("never approves in local mode", async () => {
    process.env.ATLASENT_MODE = "local";
    const res = await (await client()).callTool({
      name: "atlasent_await_approval",
      arguments: { approval_request_id: "apr_1", max_wait_seconds: 5 },
    });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    assert.equal(body.outcome, "not_approved");
    assert.equal("permit_token" in body, false);
  });
});

// ---------------------------------------------------------------------------
// IMPL-026B: claim with the key-bound agent's own actor_identity
// ---------------------------------------------------------------------------

const MINT = "/functions/v1/v1-agent-actor-identity";
const CLAIM = "/functions/v1/v1-approvals/apr_1/claim-permit";
const AWAITING = {
  status: "approved_awaiting_claim",
  action_type: "production.deploy",
  environment: "production",
};
function assertionFor(action_type = "production.deploy", environment = "production") {
  return {
    version: "actor_identity.v1",
    subject: { principal_id: "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", principal_kind: "agent", role: "agent" },
    binding: { action_type, tenant_id: "org-1", environment },
    issuer: { type: "oidc", issuer_id: "atlasent-agent-key-issuer", kid: "k1" },
    issued_at: "2026-09-25T00:00:00Z",
    expires_at: "2026-09-25T00:05:00Z",
    signature: "ab".repeat(64),
  };
}

describe("awaitApproval — approved_awaiting_claim (IMPL-026B)", () => {
  it("mints a fresh agent identity for the held action and claims with { actor_identity }", async () => {
    const a = assertionFor();
    route((m, p) => {
      if (m === "GET" && p === "/functions/v1/v1-approvals/apr_1") return { status: 200, body: AWAITING };
      if (m === "POST" && p === MINT) return { status: 200, body: { kind: "actor_identity.v1", assertion: a } };
      if (m === "POST" && p === CLAIM) return { status: 200, body: { claimed: true, permit_token: "pt.v4.agent" } };
      return { status: 500, body: {} };
    });
    const r = await awaitApproval(FAST);
    assert.deepEqual(r, { outcome: "approved", permit_token: "pt.v4.agent", approval_request_id: "apr_1" });
    const mint = sent.find((x) => x.path === MINT)!;
    // Only the binding coordinates, taken from the server's approval row.
    assert.deepEqual(mint.body, { action_type: "production.deploy", environment: "production" });
    assert.equal(mint.headers.Authorization, "Bearer test-key");
    assert.ok(mint.signal instanceof AbortSignal, "mint carries the request timeout signal");
    const claim = sent.find((x) => x.path === CLAIM)!;
    assert.deepEqual(claim.body, { actor_identity: a });
    assert.ok(calls.indexOf(`POST ${MINT}`) < calls.indexOf(`POST ${CLAIM}`), "mint precedes claim");
  });

  const mintFailures: Array<[string, { status: number; body: unknown } | "throw"]> = [
    ["the key is not bound to an agent (403)", { status: 403, body: { error: "agent_binding_required" } }],
    ["the binding could not be resolved (503)", { status: 503, body: { error: "agent_binding_unresolved" } }],
    ["the agent is not active (403)", { status: 403, body: { error: "agent_not_active" } }],
    ["the mint is unreachable", "throw"],
    ["the response is not an agent assertion", { status: 200, body: { assertion: { ...assertionFor(), subject: { principal_kind: "human" } } } }],
    ["the assertion is for a different action", { status: 200, body: { assertion: assertionFor("data.delete") } }],
    ["the assertion is for a different environment", { status: 200, body: { assertion: assertionFor("production.deploy", "staging") } }],
  ];
  for (const [label, mintResp] of mintFailures) {
    it(`does not claim when ${label}`, async () => {
      route((m, p) => {
        if (m === "GET") return { status: 200, body: AWAITING };
        if (p === MINT) return mintResp;
        return { status: 200, body: { claimed: true, permit_token: "pt.v4.should-not-be-claimed" } };
      });
      const r = await awaitApproval(FAST);
      assert.equal(r.outcome, "not_approved");
      assert.equal("permit_token" in r, false);
      assert.equal(calls.includes(`POST ${CLAIM}`), false, "no claim without an identity");
      assert.match((r as { reasons: string[] }).reasons[0], /agent identity could not be obtained/);
    });
  }

  it("falls back to claiming with {} on a runtime without the mint endpoint (404), and says so", async () => {
    route((m, p) => {
      if (m === "GET") return { status: 200, body: AWAITING };
      if (p === MINT) return { status: 404, body: {} };
      if (p === CLAIM) return { status: 400, body: { error: "actor_identity_required" } };
      return { status: 500, body: {} };
    });
    const r = await awaitApproval(FAST);
    assert.equal(r.outcome, "not_approved");
    assert.deepEqual(sent.find((x) => x.path === CLAIM)!.body, {});
    const reasons = (r as { reasons: string[] }).reasons.join(" ");
    assert.match(reasons, /actor_identity_required/);
    assert.match(reasons, /Claimed without an agent identity/);
  });

  it("the 404 fallback still returns a permit the runtime genuinely granted, with a note", async () => {
    route((m, p) => {
      if (m === "GET") return { status: 200, body: AWAITING };
      if (p === MINT) return { status: 404, body: {} };
      return { status: 200, body: { claimed: true, permit_token: "pt.v4.old" } };
    });
    const r = await awaitApproval(FAST);
    assert.equal(r.outcome, "approved");
    assert.ok(r.outcome === "approved" && r.notes && /without an agent identity/.test(r.notes[0]));
  });

  it("a plain 'approved' row is claimed exactly as before: no mint, empty body", async () => {
    route((m, p) => {
      if (m === "GET") return { status: 200, body: { status: "approved", action_type: "x", environment: "production" } };
      if (p === CLAIM) return { status: 200, body: { claimed: true, permit_token: "pt.v4.legacy" } };
      return { status: 500, body: {} };
    });
    const r = await awaitApproval(FAST);
    assert.equal(r.outcome, "approved");
    assert.equal(calls.includes(`POST ${MINT}`), false);
    assert.deepEqual(sent.find((x) => x.path === CLAIM)!.body, {});
  });

  it("claim_in_progress (409) re-polls and claims again with a FRESH identity", async () => {
    let claims = 0;
    let mints = 0;
    route((m, p) => {
      if (m === "GET") return { status: 200, body: AWAITING };
      if (p === MINT) {
        mints += 1;
        return { status: 200, body: { assertion: { ...assertionFor(), nonce: `n${mints}` } } };
      }
      claims += 1;
      return claims === 1
        ? { status: 409, body: { error: "claim_in_progress" } }
        : { status: 200, body: { claimed: true, permit_token: "pt.v4.second" } };
    });
    const r = await awaitApproval(FAST);
    assert.equal(r.outcome, "approved");
    assert.equal(mints, 2);
    const bodies = sent.filter((x) => x.path === CLAIM).map((x) => (x.body as { actor_identity: { nonce: string } }).actor_identity.nonce);
    assert.deepEqual(bodies, ["n1", "n2"]);
  });

  it("a claim-time deny passes through re_evaluation_decision and the deny code, no permit", async () => {
    route((m, p) => {
      if (m === "GET") return { status: 200, body: AWAITING };
      if (p === MINT) return { status: 200, body: { assertion: assertionFor() } };
      return { status: 200, body: { claimed: false, permit_token: null, re_evaluation_decision: "deny", deny_code: "ACTOR_UNVERIFIED" } };
    });
    const r = await awaitApproval(FAST);
    assert.equal(r.outcome, "not_approved");
    assert.equal("permit_token" in r, false);
    assert.equal((r as { re_evaluation_decision?: string }).re_evaluation_decision, "deny");
    assert.match((r as { reasons: string[] }).reasons[0], /ACTOR_UNVERIFIED/);
  });

  it("an awaiting row with no action_type is not claimed", async () => {
    route((m) => (m === "GET" ? { status: 200, body: { status: "approved_awaiting_claim" } } : { status: 200, body: { claimed: true, permit_token: "x" } }));
    const r = await awaitApproval(FAST);
    assert.equal(r.outcome, "not_approved");
    assert.equal(calls.some((c) => c.startsWith("POST")), false);
  });

  it("a null environment on the row binds the environmentless '' coordinate", async () => {
    route((m, p) => {
      if (m === "GET") return { status: 200, body: { ...AWAITING, environment: null } };
      if (p === MINT) return { status: 200, body: { assertion: assertionFor("production.deploy", "") } };
      return { status: 200, body: { claimed: true, permit_token: "pt.v4.env" } };
    });
    const r = await awaitApproval(FAST);
    assert.equal(r.outcome, "approved");
    assert.deepEqual(sent.find((x) => x.path === MINT)!.body, { action_type: "production.deploy", environment: "" });
  });
});

describe("mintAgentActorIdentity", () => {
  it("sends only action_type + environment and returns the assertion", async () => {
    const a = assertionFor();
    route(() => ({ status: 200, body: { assertion: a } }));
    const r = await mintAgentActorIdentity("production.deploy", "production");
    assert.deepEqual(r, { ok: true, actor_identity: a });
    assert.deepEqual(sent[0].body, { action_type: "production.deploy", environment: "production" });
    assert.equal(sent[0].path, MINT);
  });
  it("404 is 'unsupported', distinct from a refusal", async () => {
    route(() => ({ status: 404, body: {} }));
    const r = await mintAgentActorIdentity("x", "production");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.unsupported, true);
    route(() => ({ status: 403, body: { error: "agent_binding_required" } }));
    const r2 = await mintAgentActorIdentity("x", "production");
    assert.deepEqual(r2, { ok: false, unsupported: false, reason: "agent_binding_required" });
  });
});
