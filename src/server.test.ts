import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, _resetRateLimitForTests } from "./server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EVAL_ARGS = {
  action_type: "production.deploy",
  actor_id: "user-1",
  environment: "production",
};

function mockFetch(response: object, status = 200) {
  const fn = async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  return mock.fn(fn);
}

function parseResult(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

async function setup() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, server };
}

function forceLocalMode(): void {
  process.env.ATLASENT_MODE = "local";
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_ANON_KEY;
  delete process.env.ATLASENT_BASE_URL;
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

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _resetRateLimitForTests();
  delete process.env.ATLASENT_MCP_RATE_LIMIT;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearMode();
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe("tools/list", () => {
  it("exposes evaluate, verify_permit, deploy_service, all write tools, v2 tools, and compliance tools", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "atlasent_atlas_lookup",
      "atlasent_await_approval",
      "atlasent_check_permit",
          "atlasent_create_evidence_export",
      "atlasent_create_policy",
      "atlasent_create_scim_user",
      "atlasent_create_webhook",
      "atlasent_delete_policy",
      "atlasent_delete_scim_user",
      "atlasent_delete_webhook",
      "atlasent_evaluate",
      "atlasent_evaluate_many",
      "atlasent_evaluate_stream",
      "atlasent_explain_authority",
      "atlasent_get_decision",
      "atlasent_get_evidence_export",
      "atlasent_get_permit",
      "atlasent_get_policy",
      "atlasent_get_scim_user",
      "atlasent_get_siem_config",
      "atlasent_integrity_audit",
      "atlasent_list_audit_events",
      "atlasent_list_evidence_exports",
      "atlasent_list_permits",
      "atlasent_list_policies",
      "atlasent_list_scim_groups",
      "atlasent_list_scim_users",
      "atlasent_lookup_action",
      "atlasent_patch_scim_user",
      "atlasent_permit",
      "atlasent_query",
      "atlasent_record_execution_evaluation",
          "atlasent_revoke_permit",
      "atlasent_test_siem_delivery",
      "atlasent_update_policy",
      "atlasent_upsert_siem_config",
      "atlasent_verify_permit",
      "atlasent_vqp_audit_summary",
      "atlasent_vqp_drift_events",
      "atlasent_vqp_generate",
      "atlasent_vqp_verify",
      "deploy_service",
      "evaluate",
      "verify_permit",
    ]);
  });

  it("deploy_service requires service_name, environment, actor_id", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const deploy = tools.find((t) => t.name === "deploy_service")!;
    const required = (deploy.inputSchema as { required?: string[] }).required ?? [];
    for (const f of ["service_name", "environment", "actor_id"]) {
      assert.ok(required.includes(f), `missing required field: ${f}`);
    }
  });
});

// ---------------------------------------------------------------------------
// atlasent_atlas_lookup — Knowledge Atlas (read-only, no network)
// ---------------------------------------------------------------------------

describe("atlasent_atlas_lookup", () => {
  it("lists every concept when called with no arguments", async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: "atlasent_atlas_lookup", arguments: {} });
    const body = parseResult(result);
    assert.equal(body.found, true);
    assert.ok((body.result_count as number) >= 17, "expected the full concept index");
    const ids = (body.concepts as Array<{ id: string }>).map((c) => c.id);
    for (const id of ["permit", "policy", "gate", "audit-chain", "caller", "trust-root"]) {
      assert.ok(ids.includes(id), `index missing concept: ${id}`);
    }
  });

  it("returns a concept with resolved relationships for an exact id", async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: "atlasent_atlas_lookup", arguments: { id: "permit" } });
    const body = parseResult(result);
    assert.equal(body.found, true);
    assert.equal(body.result_count, 1);
    const c = (body.concepts as Array<Record<string, unknown>>)[0];
    assert.equal(c.id, "permit");
    assert.match(String(c.source_of_truth), /canon\/010/);
    // relationships are resolved to { id, term } / surfaces, not bare ids
    const usedBy = c.used_by as Array<{ id: string; term: string }>;
    assert.ok(usedBy.some((u) => u.id === "verification" && typeof u.term === "string"));
    assert.ok((c.realized_by as unknown[]).length > 0, "permit should be realized by surfaces");
  });

  it("substring query matches across term/definition", async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: "atlasent_atlas_lookup", arguments: { query: "audit" } });
    const body = parseResult(result);
    assert.equal(body.found, true);
    const ids = (body.concepts as Array<{ id: string }>).map((c) => c.id);
    assert.ok(ids.includes("audit-chain"), "query 'audit' should match audit-chain");
  });

  it("reports found=false for an unknown id", async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: "atlasent_atlas_lookup", arguments: { id: "does-not-exist" } });
    const body = parseResult(result);
    assert.equal(body.found, false);
    assert.equal(body.result_count, 0);
  });
});

// ---------------------------------------------------------------------------
// evaluate — local mode
// ---------------------------------------------------------------------------

describe("evaluate (local mode)", () => {
  it("allows staging actions by default", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "evaluate",
      arguments: { ...EVAL_ARGS, environment: "staging" },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.ok((data.permit_token as string).startsWith("pt_local_"));
    assert.equal(result.isError, undefined);
  });

  it("denies production actions with no approvals", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.ok(Array.isArray(data.reasons), "reasons must be an array");
    assert.ok((data.reasons as string[]).some((r) => r.toLowerCase().includes("approval")));
    assert.equal(result.isError, true);
  });

  it("allows production actions with approvals", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "evaluate",
      arguments: { ...EVAL_ARGS, approvals: ["ticket-42"] },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.equal(result.isError, undefined);
  });

  it("holds destructive actions without a change_window", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "evaluate",
      arguments: {
        action_type: "delete_table",
        actor_id: "user-1",
        environment: "staging",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "hold");
    assert.ok((data.hold_id as string).startsWith("hold_local_"));
    assert.equal(result.isError, true);
  });

  it("allows destructive actions with a change_window", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "evaluate",
      arguments: {
        action_type: "delete_table",
        actor_id: "user-1",
        environment: "staging",
        change_window: "2025-01-15T02:00:00Z/PT4H",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
  });
});

// ---------------------------------------------------------------------------
// evaluate — remote mode
// ---------------------------------------------------------------------------

describe("evaluate (remote mode)", () => {
  it("returns decision and permit_token on API success", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "allow",
      permit_token: "pt_xyz",
      request_id: "req_1",
      expires_at: "2026-01-01T01:00:00Z",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.equal(data.permit_token, "pt_xyz");
    assert.equal(data.audit_id, "req_1");
  });

  it("surfaces envelope_hash on allow when the API returns one", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "allow",
      permit_token: "pt_envelope_1",
      request_id: "req_env_1",
      envelope_hash: "sha256:a1b2c3d4e5f6",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.equal(data.envelope_hash, "sha256:a1b2c3d4e5f6");
  });

  it("surfaces envelope_hash on hold when the API returns one", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "escalate",
      denial: { reasons: ["needs witness"], code: "REQUIRES_WITNESS" },
      request_id: "req_env_hold",
      envelope_hash: "sha256:deadbeef",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "hold");
    assert.equal(data.envelope_hash, "sha256:deadbeef");
  });

  it("omits envelope_hash when the API does not return one", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "allow",
      permit_token: "pt_no_env",
      request_id: "req_no_env",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.equal(data.envelope_hash, undefined);
  });

  it("normalizes escalate to hold", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "escalate",
      denial: { reasons: ["needs SRE review"], code: "REQUIRES_OVERRIDE" },
      request_id: "req_2",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "hold");
    assert.ok(Array.isArray(data.reasons));
    assert.equal((data.reasons as string[])[0], "needs SRE review");
    assert.equal(data.audit_id, "req_2");
    assert.equal(result.isError, true);
  });

  it("surfaces deny_code and flags INSUFFICIENT_APPROVALS for human routing", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "deny",
      denial: { reasons: ["a human must approve this action class"], code: "INSUFFICIENT_APPROVALS" },
      request_id: "req_hil",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.equal(data.deny_code, "INSUFFICIENT_APPROVALS");
    assert.equal(data.requires_human_approval, true);
    // Fail-closed is preserved — a deny is still an error envelope.
    assert.equal(result.isError, true);
  });

  it("surfaces deny_code without the human-approval flag for other codes", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "deny",
      denial: { reasons: ["outside change window"], code: "OUTSIDE_CHANGE_WINDOW" },
      request_id: "req_ccw",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.deny_code, "OUTSIDE_CHANGE_WINDOW");
    assert.equal(data.requires_human_approval, undefined);
  });

  // CD-4 (atlasent-api CANONICAL_EVALUATE_CONTRACT.md compat-debt ledger):
  // the deployed v1-evaluate/handler.ts sets top-level deny_code/deny_reason
  // on the vast majority of its deny paths (56 call sites) -- the nested
  // `denial` object above is reserved for a single, narrower caller-denial
  // case. Every test above this point only ever mocked the nested shape, so
  // this exact gap shipped invisibly. These two prove the real, common shape
  // is read correctly.
  it("surfaces deny_code from the TOP-LEVEL field (the common real handler shape)", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "deny",
      deny_code: "INSUFFICIENT_APPROVALS",
      deny_reason: "a human must approve this action class",
      request_id: "req_hil_top",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.equal(data.deny_code, "INSUFFICIENT_APPROVALS");
    assert.equal(data.requires_human_approval, true);
    assert.equal((data.reasons as string[])[0], "a human must approve this action class");
    assert.equal(result.isError, true);
  });

  it("surfaces deny_code from the top-level field on hold/escalate too", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      decision: "escalate",
      deny_code: "REQUIRES_WITNESS",
      deny_reason: "needs witness",
      request_id: "req_hold_top",
    });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "hold");
    assert.equal(data.deny_code, "REQUIRES_WITNESS");
    assert.equal((data.reasons as string[])[0], "needs witness");
  });

  it("sends flat handler.ts body and correct auth headers", async () => {
    forceRemoteMode();
    process.env.ATLASENT_ANON_KEY = "test-anon";
    const fetcher = mockFetch({ decision: "allow", permit_token: "pt_1" });
    globalThis.fetch = fetcher;
    const { client } = await setup();
    await client.callTool({
      name: "evaluate",
      arguments: { ...EVAL_ARGS, approvals: ["t-1"], change_window: "win-1" },
    });

    const init = fetcher.mock.calls[0].arguments[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer test-key");
    assert.equal(headers["x-anon-key"], "test-anon");
    assert.ok(headers["User-Agent"].startsWith("@atlasent/mcp-server/"));

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    assert.equal(body.action_type, "production.deploy");
    assert.equal(body.actor_id, "user-1");
    assert.deepEqual(body.context, {
      environment: "production",
      approvals: ["t-1"],
      change_window: "win-1",
    });
    // state_snapshot must be a top-level field (not inside context).
    assert.deepEqual(body.state_snapshot, { source: "atlasent-mcp", complete: true });
    // No top-level `environment` — handler.ts derives it from the API key.
    assert.equal(body.environment, undefined);
  });

  it("denies on HTTP 500 (fail-closed)", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "internal" }, 500);
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.equal(result.isError, true);
  });

  it("denies on network error (fail-closed)", async () => {
    forceRemoteMode();
    const fn = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    globalThis.fetch = mock.fn(fn);
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.ok((data.reasons as string[])[0].includes("ECONNREFUSED"));
  });

  it("denies when remote allows but returns no permit_token", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ decision: "allow" });
    const { client } = await setup();
    const result = await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.ok((data.reasons as string[])[0].includes("permit_token"));
  });
});

// ---------------------------------------------------------------------------
// verify_permit
// ---------------------------------------------------------------------------

describe("verify_permit (local mode)", () => {
  it("verifies a fresh local permit", async () => {
    forceLocalMode();
    const { client } = await setup();

    // Get a permit via evaluate
    const authzResult = await client.callTool({
      name: "evaluate",
      arguments: { ...EVAL_ARGS, approvals: ["ok"] },
    });
    const authz = parseResult(authzResult);
    assert.equal(authz.decision, "allow");

    // Verify it
    const verifyResult = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: authz.permit_token as string },
    });
    const verified = parseResult(verifyResult);
    assert.equal(verified.outcome, "verified");
    assert.equal(verified.valid, true);
  });

  it("rejects a malformed local permit as invalid", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "garbage_token" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "invalid");
    assert.equal(data.valid, false);
    assert.equal(result.isError, true);
  });

  it("rejects a replay of an already-verified local permit", async () => {
    forceLocalMode();
    const { client } = await setup();

    const authzResult = await client.callTool({
      name: "evaluate",
      arguments: { ...EVAL_ARGS, approvals: ["ok"] },
    });
    const authz = parseResult(authzResult);
    assert.equal(authz.decision, "allow");
    const token = authz.permit_token as string;

    const first = parseResult(
      await client.callTool({
        name: "verify_permit",
        arguments: { ...EVAL_ARGS, permit_token: token },
      }),
    );
    assert.equal(first.outcome, "verified");
    assert.equal(first.valid, true);

    const second = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: token },
    });
    const replay = parseResult(second);
    assert.equal(replay.outcome, "invalid");
    assert.equal(replay.valid, false);
    assert.ok(Array.isArray(replay.reasons));
    assert.match(String((replay.reasons as string[])[0] ?? ""), /already used/i);
  });
});

// A real SHA-256 digest: 64 lowercase hex characters, the only form
// v1-evaluate binds into the signed permit.
const HEX64_A = "a".repeat(64);

describe("verify_permit (remote mode)", () => {
  it("maps server allow → verified", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ valid: true, outcome: "allow", decision: "allow" });
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "verified");
    assert.equal(data.valid, true);
  });

  it("maps PERMIT_EXPIRED → expired", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      valid: false,
      outcome: "deny",
      verify_error_code: "PERMIT_EXPIRED",
      reasons: ["Permit expired at 2026-01-01T00:15:00Z"],
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "expired");
    assert.equal(data.valid, false);
    assert.equal(result.isError, true);
  });

  it("maps PERMIT_ALREADY_USED → invalid", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      valid: false,
      outcome: "deny",
      verify_error_code: "PERMIT_ALREADY_USED",
      reasons: ["This permit token has already been consumed"],
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "invalid");
    assert.equal(data.valid, false);
  });

  it("maps RATE_LIMITED → error", async () => {
    forceRemoteMode();
    // Server returns 200 here because the verify handler emits its own
    // body for rate-limited responses (status 429 with JSON body).
    // Using mockFetch at status 200 simulates the JSON body parse path.
    globalThis.fetch = mockFetch({
      valid: false,
      outcome: "deny",
      verify_error_code: "RATE_LIMITED",
      reasons: ["Too many requests"],
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "error");
    assert.equal(data.valid, false);
  });

  it("falls through to invalid on unknown verify_error_code", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      valid: false,
      outcome: "deny",
      verify_error_code: "SOMETHING_NEW",
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "invalid");
    assert.equal(data.valid, false);
  });

  it("returns error outcome on network failure", async () => {
    forceRemoteMode();
    const fn = async (): Promise<Response> => {
      throw new Error("ETIMEDOUT");
    };
    globalThis.fetch = mock.fn(fn);
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc" },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "error");
    assert.equal(data.valid, false);
    assert.equal(result.isError, true);
  });

  it("presents the full binding set (environment + payload_hash + target_id) to /v1-verify-permit", async () => {
    forceRemoteMode();
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = mock.fn(
      async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        capturedUrl = String(url);
        capturedBody = JSON.parse((init?.body as string) ?? "{}");
        return new Response(JSON.stringify({ valid: true, outcome: "allow" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    const { client } = await setup();
    await client.callTool({
      name: "verify_permit",
      arguments: {
        ...EVAL_ARGS,
        permit_token: "pt_abc",
        target_id: "service:hello",
        payload_hash: `sha256:${HEX64_A}`,
      },
    });
    assert.ok(capturedUrl.includes("/v1-verify-permit"));
    assert.equal(capturedBody.permit_token, "pt_abc");
    assert.equal(capturedBody.action_type, "production.deploy");
    assert.equal(capturedBody.actor_id, "user-1");
    // environment must be presented so ENVIRONMENT_MISMATCH can fire (acceptance AC-6)
    assert.equal(capturedBody.environment, "production");
    // payload_hash must be presented so PAYLOAD_MISMATCH can fire (acceptance AC-5),
    // normalized to the bare 64-hex form the runtime binds. This assertion
    // previously used the placeholder "sha256:args-A" and asserted it was
    // forwarded verbatim — a digest the runtime can never bind, so the test
    // was green over a shape that disabled the very check it names.
    assert.equal(capturedBody.payload_hash, HEX64_A);
    assert.equal(capturedBody.target_id, "service:hello");
  });

  it("rejects a malformed payload_hash instead of sending one the runtime will drop", async () => {
    // Fail-closed at every layer. v1-evaluate DROPS a digest that does not match
    // /^[0-9a-f]{64}$/ rather than rejecting it, and binds the permit to its own
    // hash of the whole request instead. The caller's digest then never
    // constrains execution (presenting it at verify is a deterministic
    // PAYLOAD_MISMATCH), so refuse at the client boundary instead.
    forceRemoteMode();
    let called = false;
    globalThis.fetch = mock.fn(async (): Promise<Response> => {
      called = true;
      return new Response(JSON.stringify({ valid: true, outcome: "allow" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "verify_permit",
      arguments: { ...EVAL_ARGS, permit_token: "pt_abc", payload_hash: "sha256:args-A" },
    });
    const data = parseResult(result);
    assert.equal(data.valid, false);
    assert.equal(called, false, "no verify request may be sent for a malformed digest");
  });
});

// ---------------------------------------------------------------------------
// deploy_service — authorization-before-execution proof
// ---------------------------------------------------------------------------

describe("deploy_service (authorization-gated)", () => {
  it("blocks the deploy when policy denies (production, no approvals)", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "deploy_service",
      arguments: {
        service_name: "billing-api",
        environment: "production",
        actor_id: "agent-7",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.equal(data.result, undefined, "deploy must NOT execute when denied");
    assert.equal(result.isError, true);
  });

  it("holds the deploy when policy holds (destructive w/o window)", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "deploy_service",
      arguments: {
        service_name: "delete-old-records",
        environment: "staging",
        actor_id: "agent-7",
      },
    });
    const data = parseResult(result);
    // action_type is "production.deploy" in this tool, so destructive rule doesn't fire.
    // This one should allow.
    assert.equal(data.decision, "allow");
  });

  it("executes the deploy when policy allows", async () => {
    // With the two-layer gate, both agentToolGate (agent.tool.invoke)
    // and the deploy-specific gate (production.deploy) must allow. Staging passes
    // both gates unconditionally in local mode, verifying the full execute path.
    // (The production-with-approvals path is covered by the regression test below.)
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "deploy_service",
      arguments: {
        service_name: "billing-api",
        environment: "staging",
        actor_id: "agent-7",
        approvals: ["ticket-42"],
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.ok(data.permit_token, "must return a permit_token");
    const res = data.result as Record<string, unknown>;
    assert.equal(res.status, "deployed");
    assert.equal(res.service, "billing-api");
    assert.equal(res.environment, "staging");
  });

  it("executes production deploys WITH approvals (agent gate forwards approvals)", async () => {
    // Regression guard. Before the agent gate forwarded approvals, a production
    // deploy WITH approvals was still denied at the agent.tool.invoke
    // gate (which never received them), so no production action could ever pass
    // the two-layer gate. The same approvals must now satisfy both layers.
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "deploy_service",
      arguments: {
        service_name: "billing-api",
        environment: "production",
        actor_id: "agent-7",
        approvals: ["ticket-42"],
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow", "production deploy with approvals must pass both gates");
    assert.ok(data.permit_token, "must return a permit_token");
    const res = data.result as Record<string, unknown>;
    assert.equal(res.status, "deployed");
    assert.equal(res.environment, "production");
  });

  it("blocks a production deploy WITHOUT approvals at the agent gate (fail-closed preserved)", async () => {
    // The complement of the regression guard: forwarding approvals must not
    // weaken fail-closed. A production deploy with no approvals still denies.
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "deploy_service",
      arguments: {
        service_name: "billing-api",
        environment: "production",
        actor_id: "agent-7",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "deny", "production deploy without approvals must fail closed");
    assert.equal(data.result, undefined, "deploy must NOT execute when denied");
  });

  it("executes staging deploys without approvals", async () => {
    forceLocalMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "deploy_service",
      arguments: {
        service_name: "billing-api",
        environment: "staging",
        actor_id: "agent-7",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "allow");
    assert.ok(data.result);
  });

  it("blocks on remote fail-closed (verification failure)", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "internal" }, 500);
    const { client } = await setup();
    const result = await client.callTool({
      name: "deploy_service",
      arguments: {
        service_name: "billing-api",
        environment: "staging",
        actor_id: "agent-7",
      },
    });
    const data = parseResult(result);
    assert.equal(data.decision, "deny");
    assert.equal(data.result, undefined);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("rate limiting (per-tool token bucket)", () => {
  it("denies the burst that exceeds ATLASENT_MCP_RATE_LIMIT", async () => {
    forceLocalMode();
    process.env.ATLASENT_MCP_RATE_LIMIT = "2";
    _resetRateLimitForTests();
    const { client } = await setup();

    const args = { ...EVAL_ARGS, approvals: ["x"] };
    const r1 = parseResult(await client.callTool({ name: "evaluate", arguments: args }));
    const r2 = parseResult(await client.callTool({ name: "evaluate", arguments: args }));
    const r3 = parseResult(await client.callTool({ name: "evaluate", arguments: args }));

    assert.equal(r1.decision, "allow");
    assert.equal(r2.decision, "allow");
    // Third call (within the same minute) trips the limiter.
    assert.equal(r3.decision, "deny");
    assert.ok(Array.isArray(r3.reasons));
    assert.match(String((r3.reasons as string[])[0] ?? ""), /rate limit/i);
  });
});

// ---------------------------------------------------------------------------
// Policy + permit write tools (remote-only)
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

function captureFetch(response: object, status = 200) {
  const captured: CapturedRequest[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    captured.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: parsedBody,
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fn: mock.fn(fn), captured };
}

describe("atlasent_create_policy", () => {
  it("POSTs the policy body to /v1/policies and returns the row", async () => {
    forceRemoteMode();
    const created = { id: "pol_123", policy_id: "deploy-gate", status: "draft" };
    const { fn, captured } = captureFetch(created);
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_create_policy",
      arguments: {
        org_id: "org_1",
        policy_id: "deploy-gate",
        title: "Deployment production gate",
        policy_type: "access_control",
        rules: [{ when: "env=production", require: "approvals>=2" }],
      },
    });
    const data = parseResult(result);
    assert.equal(data.id, "pol_123");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "POST");
    assert.match(captured[0].url, /\/v1\/policies$/);
    const body = captured[0].body as Record<string, unknown>;
    assert.equal(body.org_id, "org_1");
    assert.equal(body.policy_id, "deploy-gate");
    assert.equal(body.policy_type, "access_control");
    assert.deepEqual(body.rules, [{ when: "env=production", require: "approvals>=2" }]);
  });

  it("surfaces 401 as an isError result", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_create_policy",
      arguments: {
        org_id: "org_1",
        policy_id: "x",
        title: "x",
        policy_type: "x",
        rules: [{ a: 1 }],
      },
    });
    assert.equal(result.isError, true);
    assert.match(String(parseResult(result).error), /Authentication failed/i);
  });
});

describe("atlasent_update_policy", () => {
  it("PATCHes /v1/policies/:id with only the supplied fields", async () => {
    forceRemoteMode();
    const updated = { id: "pol_123", policy_id: "deploy-gate", status: "enforce" };
    const { fn, captured } = captureFetch(updated);
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_update_policy",
      arguments: {
        policy_id: "deploy-gate",
        org_id: "org_1",
        status: "enforce",
        priority: 50,
      },
    });
    const data = parseResult(result);
    assert.equal(data.status, "enforce");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "PATCH");
    assert.match(captured[0].url, /\/v1\/policies\/deploy-gate$/);
    const body = captured[0].body as Record<string, unknown>;
    assert.equal(body.org_id, "org_1");
    assert.equal(body.status, "enforce");
    assert.equal(body.priority, 50);
    // Fields the caller did not supply must not appear in the PATCH body.
    assert.equal(body.title, undefined);
    assert.equal(body.rules, undefined);
    assert.equal(body.policy_id, undefined);
  });
});

describe("atlasent_revoke_permit", () => {
  it("POSTs to /v1/permits/:permitToken/revoke with org and reasons", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch({
      id: "permit_42",
      status: "revoked",
      revoked_at: "2026-05-08T00:00:00Z",
    });
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_revoke_permit",
      arguments: {
        permitToken: "permit_42",
        org_id: "org_1",
        reasons: ["compromised actor"],
      },
    });
    const data = parseResult(result);
    assert.equal(data.status, "revoked");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "POST");
    assert.match(captured[0].url, /\/v1\/permits\/permit_42\/revoke$/);
    const body = captured[0].body as Record<string, unknown>;
    assert.equal(body.org_id, "org_1");
    assert.deepEqual(body.reasons, ["compromised actor"]);
  });

  it("omits reasons from the body when not supplied", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch({ id: "permit_42", status: "revoked" });
    globalThis.fetch = fn;
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_revoke_permit",
      arguments: { permitToken: "permit_42", org_id: "org_1" },
    });
    const body = captured[0].body as Record<string, unknown>;
    assert.equal("reasons" in body, false);
  });
});

describe("atlasent_list_permits", () => {
  it("GETs /v1/permits with the supplied filters in the query string", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch({
      permits: [{ id: "permit_1", status: "issued" }],
      total: 1,
      next_cursor: null,
    });
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_list_permits",
      arguments: {
        org_id: "org_1",
        status: "issued",
        actor_id: "agent-7",
        limit: 25,
      },
    });
    const data = parseResult(result);
    assert.equal((data.permits as unknown[]).length, 1);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "GET");
    const u = new URL(captured[0].url);
    assert.equal(u.pathname, "/v1/permits");
    assert.equal(u.searchParams.get("org_id"), "org_1");
    assert.equal(u.searchParams.get("status"), "issued");
    assert.equal(u.searchParams.get("actor_id"), "agent-7");
    assert.equal(u.searchParams.get("limit"), "25");
    // Unsupplied filters must not leak into the query string.
    assert.equal(u.searchParams.has("action_type"), false);
    assert.equal(u.searchParams.has("cursor"), false);
  });

  it("surfaces 429 as an isError rate-limited result", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "rate limited" }, 429);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_list_permits",
      arguments: { org_id: "org_1" },
    });
    assert.equal(result.isError, true);
    assert.match(String(parseResult(result).error), /Rate limited/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_get_permit / atlasent_check_permit / atlasent_get_decision
// ---------------------------------------------------------------------------

const SECRET_PERMIT = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "issued",
  decision_id: "22222222-2222-4222-8222-222222222222",
  token: "pt.v4.SECRET-BEARER",
  signature: "SECRET-SIG",
};

function assertNoPermitSecrets(value: unknown, where: string) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes("SECRET-BEARER"), `${where} leaked the permit token: ${text}`);
  assert.ok(!text.includes("SECRET-SIG"), `${where} leaked the permit signature: ${text}`);
  assert.ok(!/"token"\s*:/.test(text), `${where} carries a token field: ${text}`);
  assert.ok(!/"signature"\s*:/.test(text), `${where} carries a signature field: ${text}`);
}

describe("atlasent_get_permit", () => {
  it("GETs /v1/permits/:id and strips token and signature even if the backend returns them", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch(SECRET_PERMIT);
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_get_permit",
      arguments: { permit_id: SECRET_PERMIT.id },
    });
    assert.equal(result.isError, undefined);
    const data = parseResult(result);
    assert.equal(data.id, SECRET_PERMIT.id);
    assert.equal(data.decision_id, SECRET_PERMIT.decision_id);
    assertNoPermitSecrets(data, "atlasent_get_permit");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "GET");
    assert.equal(new URL(captured[0].url).pathname, `/v1/permits/${SECRET_PERMIT.id}`);
  });

  it("URL-encodes the permit id so it cannot address another path", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch({ id: "x" });
    globalThis.fetch = fn;
    const { client } = await setup();
    await client.callTool({ name: "atlasent_get_permit", arguments: { permit_id: "../revoke" } });
    assert.equal(new URL(captured[0].url).pathname, "/v1/permits/..%2Frevoke");
  });

  it("surfaces a 404 as an isError result", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "not_found", message: "Permit not found" }, 404);
    const { client } = await setup();
    const result = await client.callTool({ name: "atlasent_get_permit", arguments: { permit_id: "nope" } });
    assert.equal(result.isError, true);
    assert.match(String(parseResult(result).error), /Permit not found/);
  });
});

describe("atlasent_check_permit", () => {
  it("GETs /v1/permits/:id/valid and returns the runtime's { valid, status }", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch({ valid: false, status: "revoked", revoked_at: "2026-09-24T00:00:00Z" });
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_check_permit",
      arguments: { permit_id: SECRET_PERMIT.id },
    });
    const data = parseResult(result);
    assert.equal(data.valid, false);
    assert.equal(data.status, "revoked");
    assert.equal(captured[0].method, "GET");
    assert.equal(new URL(captured[0].url).pathname, `/v1/permits/${SECRET_PERMIT.id}/valid`);
  });
});

describe("atlasent_get_decision", () => {
  it("GETs /v1/execution-evaluations/:id without include when include_trace is unset", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch({ evaluation: { id: SECRET_PERMIT.decision_id, decision: "allow" } });
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_get_decision",
      arguments: { evaluation_id: SECRET_PERMIT.decision_id },
    });
    const data = parseResult(result);
    assert.equal((data.evaluation as Record<string, unknown>).decision, "allow");
    const u = new URL(captured[0].url);
    assert.equal(u.pathname, `/v1/execution-evaluations/${SECRET_PERMIT.decision_id}`);
    assert.equal(u.searchParams.has("include"), false);
  });

  it("passes include=trace when include_trace is true", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch({ evaluation: { id: "e" }, trace: { approvals: [], permit_uses: [], webhooks: [] } });
    globalThis.fetch = fn;
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_get_decision",
      arguments: { evaluation_id: "e", include_trace: true },
    });
    assert.equal(new URL(captured[0].url).searchParams.get("include"), "trace");
  });
});

describe("atlasent_list_permits secret redaction", () => {
  it("strips token and signature from every listed permit", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ permits: [SECRET_PERMIT, { ...SECRET_PERMIT, id: "p2" }], total: 2, next_cursor: null });
    const { client } = await setup();
    const result = await client.callTool({ name: "atlasent_list_permits", arguments: { org_id: "org_1" } });
    const data = parseResult(result);
    assert.equal((data.permits as unknown[]).length, 2);
    assertNoPermitSecrets(data, "atlasent_list_permits");
  });
});

// ---------------------------------------------------------------------------
// atlasent_explain_authority — read-only OAG-1 authority-lineage explanation
// ---------------------------------------------------------------------------

describe("atlasent_explain_authority", () => {
  it("GETs /v1-authority-intelligence/explain-authority with all params in the query string", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch({
      organization_id: "11111111-1111-4111-8111-111111111111",
      principal_id: "22222222-2222-4222-8222-222222222222",
      requested_scope: "production:deployment.production.approve",
      resource_id: "svc-42",
      authority_found: true,
      paths: [{ mechanism: "role_capability", matched: true, edges: [] }],
      unresolved: [],
    });
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_explain_authority",
      arguments: {
        principal_id: "22222222-2222-4222-8222-222222222222",
        requested_scope: "production:deployment.production.approve",
        resource_id: "svc-42",
      },
    });
    const data = parseResult(result);
    assert.equal(data.authority_found, true);
    assert.equal((data.paths as unknown[]).length, 1);
    assert.equal(result.isError, undefined);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "GET");
    const u = new URL(captured[0].url);
    // Hyphenated (edge-function-name) form — the real handler strips
    // `/v1-authority-intelligence/` as a literal prefix; the slash form
    // never matches and 404s. This was a real bug: the test previously
    // pinned the wrong (slash) path as expected.
    assert.equal(u.pathname, "/v1-authority-intelligence/explain-authority");
    assert.equal(u.searchParams.get("principal_id"), "22222222-2222-4222-8222-222222222222");
    assert.equal(
      u.searchParams.get("requested_scope"),
      "production:deployment.production.approve",
    );
    assert.equal(u.searchParams.get("resource_id"), "svc-42");
  });

  it("omits resource_id from the query string when not supplied", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch({
      organization_id: "11111111-1111-4111-8111-111111111111",
      principal_id: "22222222-2222-4222-8222-222222222222",
      requested_scope: "production:deployment.production.approve",
      resource_id: null,
      authority_found: false,
      paths: [],
      unresolved: [{ finding_type: "no_matching_grant" }],
    });
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_explain_authority",
      arguments: {
        principal_id: "22222222-2222-4222-8222-222222222222",
        requested_scope: "production:deployment.production.approve",
      },
    });
    const data = parseResult(result);
    assert.equal(data.authority_found, false);
    assert.equal((data.unresolved as unknown[]).length, 1);
    const u = new URL(captured[0].url);
    assert.equal(u.searchParams.has("resource_id"), false);
  });

  it("surfaces a non-2xx response as an isError result", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "forbidden" }, 403);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_explain_authority",
      arguments: {
        principal_id: "22222222-2222-4222-8222-222222222222",
        requested_scope: "production:deployment.production.approve",
      },
    });
    assert.equal(result.isError, true);
    assert.match(String(parseResult(result).error), /Permission denied/i);
  });

  it("rejects a missing/empty requested_scope at the tool layer", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_explain_authority",
      arguments: {
        principal_id: "22222222-2222-4222-8222-222222222222",
        requested_scope: "",
      },
    });
    assert.equal(result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// atlasent_integrity_audit — read-only authority-graph integrity audit
// ---------------------------------------------------------------------------

const INTEGRITY_REPORT = {
  schema_version: "1.0.0",
  query: "integrity-audit",
  organization_id: "11111111-1111-4111-8111-111111111111",
  evaluated_at: "2026-08-22T00:00:00.000Z",
  produced_by: ["authority_intelligence_integrity_audit_v1", "authority_integrity.ts"],
  summary: { audited_scope: { decision_window_days: 90 }, findings_total: 3 },
  findings: [
    {
      finding_type: "grant_without_role",
      classification: "defect",
      severity: "high",
      subject_id: "22222222-2222-4222-8222-222222222222",
      source_table: "authority_grants",
      source_id: "g-1",
      related_source_ids: ["r-1"],
      effective_at: "2026-08-01T00:00:00.000Z",
      evidence_posture: "observed",
      reason: "grant references a role that no longer exists",
    },
    {
      finding_type: "expired_delegation",
      classification: "non_exercisable",
      severity: "info",
      subject_id: "33333333-3333-4333-8333-333333333333",
      source_table: "authority_delegations",
      source_id: "d-1",
      related_source_ids: [],
      effective_at: "2026-01-01T00:00:00.000Z",
      evidence_posture: "observed",
      reason: "delegation expired as configured",
    },
    {
      finding_type: "scope_coverage_indeterminate",
      classification: "unresolved",
      severity: "medium",
      subject_id: null,
      source_table: null,
      source_id: null,
      related_source_ids: [],
      effective_at: null,
      evidence_posture: "derived",
      reason: "scope could not be canonicalized",
    },
  ],
  nodes: [{ id: "n-1", kind: "principal" }],
  edges: [{ from: "n-1", to: "n-2", kind: "delegation" }],
};

describe("atlasent_integrity_audit", () => {
  it("GETs /v1-authority-intelligence/integrity-audit with decision_window_days when supplied", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch(INTEGRITY_REPORT);
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_integrity_audit",
      arguments: { decision_window_days: 90 },
    });
    assert.equal(result.isError, undefined);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "GET");
    const u = new URL(captured[0].url);
    // The sub-route form is load-bearing: the edge function routes by
    // stripping `^/v1-authority-intelligence/?`, so `/v1/authority-intelligence/...`
    // would fall through to its 404.
    assert.equal(u.pathname, "/v1-authority-intelligence/integrity-audit");
    assert.equal(u.searchParams.get("decision_window_days"), "90");
  });

  it("omits decision_window_days entirely when the caller does not supply it", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch(INTEGRITY_REPORT);
    globalThis.fetch = fn;
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_integrity_audit",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    const u = new URL(captured[0].url);
    // No client-side default is invented — the server owns the window.
    assert.equal(u.searchParams.has("decision_window_days"), false);
  });

  it("passes the report through faithfully and synthesizes no pass/fail verdict", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch(INTEGRITY_REPORT);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_integrity_audit",
      arguments: {},
    });
    const data = parseResult(result);
    // A report carrying `defect` and `unresolved` findings is NOT an error
    // envelope — the tool reports, it does not judge.
    assert.equal(result.isError, undefined);
    assert.deepEqual(data, INTEGRITY_REPORT);
    // The three-way classification survives intact.
    const classifications = (data.findings as Array<{ classification: string }>).map(
      (f) => f.classification,
    );
    assert.deepEqual(classifications, ["defect", "non_exercisable", "unresolved"]);
    // No synthesized health verdict of any kind was added.
    for (const key of ["healthy", "status", "passed", "ok", "verdict", "decision", "valid"]) {
      assert.equal(Object.hasOwn(data, key), false, `must not synthesize "${key}"`);
    }
  });

  it("surfaces a failed audit as an isError result rather than an empty report", async () => {
    forceRemoteMode();
    // The server refuses a partial report when augmentation fails, so that
    // unevaluated checks can never read as passing ones.
    globalThis.fetch = mockFetch(
      {
        code: "augmentation_failed",
        message: "integrity audit could not complete its scope, delegation and snapshot analyses",
      },
      500,
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_integrity_audit",
      arguments: {},
    });
    assert.equal(result.isError, true);
    const data = parseResult(result);
    assert.match(String(data.error), /could not complete/i);
    // Fail closed: no report shape is fabricated on the failure path.
    assert.equal(Object.hasOwn(data, "findings"), false);
  });

  it("surfaces a 403 (missing authority_intelligence:read scope) as an isError result", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ code: "forbidden", message: "forbidden" }, 403);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_integrity_audit",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(String(parseResult(result).error), /Permission denied/i);
  });

  it("rejects an out-of-range decision_window_days at the tool layer", async () => {
    forceRemoteMode();
    const { fn, captured } = captureFetch(INTEGRITY_REPORT);
    globalThis.fetch = fn;
    const { client } = await setup();
    for (const bad of [0, 3651, 1.5]) {
      const result = await client.callTool({
        name: "atlasent_integrity_audit",
        arguments: { decision_window_days: bad },
      });
      assert.equal(result.isError, true, `decision_window_days=${bad} must be rejected`);
    }
    // Rejected at the schema boundary — no request ever reached the API.
    assert.equal(captured.length, 0);
  });
});

// ---------------------------------------------------------------------------
// atlasent_permit — issue a permit token
// ---------------------------------------------------------------------------

describe("atlasent_permit", () => {
  it("happy path: returns permit object from API", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      permit_token: "pt_issued_abc",
      expires_at: "2026-01-01T01:00:00Z",
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_permit",
      arguments: {
        subject: "user:alice",
        action: "production.deploy",
        resource: "env:prod",
        org_id: "org_abc",
      },
    });
    const data = parseResult(result);
    assert.equal(data.permit_token, "pt_issued_abc");
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_permit",
      arguments: {
        subject: "user:alice",
        action: "production.deploy",
        resource: "env:prod",
        org_id: "org_abc",
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: missing required subject field", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_permit",
      arguments: {
        action: "production.deploy",
        resource: "env:prod",
        org_id: "org_abc",
      },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /subject/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_verify_permit (v1)
// ---------------------------------------------------------------------------

describe("atlasent_verify_permit (v1)", () => {
  it("happy path: returns valid verification from API", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ valid: true, outcome: "allow" });
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_verify_permit",
      arguments: {
        permit_token: "pt_abc123",
        org_id: "org_abc",
      },
    });
    const data = parseResult(result);
    assert.equal(data.valid, true);
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_verify_permit",
      arguments: {
        permit_token: "pt_abc123",
        org_id: "org_abc",
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: missing permit_token", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_verify_permit",
      arguments: { org_id: "org_abc" },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /permit_token/i);
  });
});

// ---------------------------------------------------------------------------
// REST base URL resolution — the generic "/v1/<resource>" family (openapi.yaml:
// /v1/policies, /v1/permits, /v1/audit/events, etc.) is served at the AtlaSent
// gateway/API domain root, NOT under the Supabase "/functions/v1" invocation
// base used by dash-form paths like /v1-evaluate. Confirmed against
// atlasent-api's documented curl examples (docs/runbooks/PILOT_TROUBLESHOOTING.md,
// docs/runbooks/PILOT_CUSTOMER_ACTIVATION.md: `curl https://api.atlasent.io/v1/audit/events`)
// and atlasent-control-plane's gateway (gateway/src/plugin.ts upstreamUrlFor),
// which proxies "/v1/*" verbatim with no path rewriting. When an operator
// configures ATLASENT_BASE_URL exactly as README recommends
// (".../functions/v1"), every slash-form REST call must strip that suffix;
// dash-form calls must keep it unchanged.
// ---------------------------------------------------------------------------

describe("REST base URL resolution (functions/v1 stripping)", () => {
  it("strips /functions/v1 for slash-form /v1/<resource> calls", async () => {
    forceRemoteMode();
    process.env.ATLASENT_BASE_URL = "https://api.atlasent.io/functions/v1";
    const fetcher = mockFetch({ valid: true, outcome: "allow" });
    globalThis.fetch = fetcher;
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_verify_permit",
      arguments: { permit_token: "pt_abc123", org_id: "org_abc" },
    });
    const url = fetcher.mock.calls[0].arguments[0] as string;
    assert.equal(url, "https://api.atlasent.io/v1/permits/verify");
  });

  it("keeps /functions/v1 for dash-form /v1-evaluate calls", async () => {
    forceRemoteMode();
    process.env.ATLASENT_BASE_URL = "https://api.atlasent.io/functions/v1";
    const fetcher = mockFetch({ decision: "allow", permit_token: "pt_1" });
    globalThis.fetch = fetcher;
    const { client } = await setup();
    await client.callTool({ name: "evaluate", arguments: EVAL_ARGS });
    const url = fetcher.mock.calls[0].arguments[0] as string;
    assert.equal(url, "https://api.atlasent.io/functions/v1/v1-evaluate");
  });

  it("passes a gateway-root ATLASENT_BASE_URL through unchanged for slash-form calls", async () => {
    forceRemoteMode();
    process.env.ATLASENT_BASE_URL = "https://api.test";
    const fetcher = mockFetch({ valid: true, outcome: "allow" });
    globalThis.fetch = fetcher;
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_verify_permit",
      arguments: { permit_token: "pt_abc123", org_id: "org_abc" },
    });
    const url = fetcher.mock.calls[0].arguments[0] as string;
    assert.equal(url, "https://api.test/v1/permits/verify");
  });
});

// ---------------------------------------------------------------------------
// No MCP tool can approve an action
// ---------------------------------------------------------------------------

// An agent must never approve (or file approvals for) its own held action:
// approval is a human decision made in the AtlaSent console. The removed
// create/resolve tools called an endpoint that does not exist and took an
// agent-supplied resolver_id -- repaired, they would have been an agent
// self-approval surface.
describe("approval tools", () => {
  it("exposes no tool that creates, resolves or approves an approval request", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    // atlasent_await_approval is the one allowed name: it only WAITS for a
    // person's decision and has no decision input (pinned in
    // awaitApproval.test.ts).
    for (const t of tools) {
      if (t.name === "atlasent_await_approval") continue;
      assert.doesNotMatch(t.name, /approv|resolve/i, `unexpected approval tool: ${t.name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// atlasent_delete_policy
// ---------------------------------------------------------------------------

describe("atlasent_delete_policy", () => {
  it("happy path: returns empty body on successful delete", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({});
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_delete_policy",
      arguments: {
        policy_id: "pol_abc",
        org_id: "org_abc",
      },
    });
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_delete_policy",
      arguments: {
        policy_id: "pol_abc",
        org_id: "org_abc",
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: missing org_id", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_delete_policy",
      arguments: { policy_id: "pol_abc" },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /org_id/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_record_execution_evaluation
// ---------------------------------------------------------------------------

describe("atlasent_record_execution_evaluation", () => {
  it("happy path: returns recorded evaluation", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      execution_id: "exec_abc",
      outcome: "success",
      recorded_at: "2026-01-01T00:00:00Z",
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_record_execution_evaluation",
      arguments: {
        evaluation_id: "eval_abc",
        org_id: "org_abc",
        outcome: "success",
        executed_at: "2026-01-01T00:00:00Z",
      },
    });
    const data = parseResult(result);
    assert.equal(data.outcome, "success");
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_record_execution_evaluation",
      arguments: {
        evaluation_id: "eval_abc",
        org_id: "org_abc",
        outcome: "failure",
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: invalid outcome value", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_record_execution_evaluation",
      arguments: {
        evaluation_id: "eval_abc",
        org_id: "org_abc",
        outcome: "partial",
      },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /outcome/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_create_webhook
// ---------------------------------------------------------------------------

describe("atlasent_create_webhook", () => {
  it("happy path: returns webhook_id", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({
      webhook_id: "wh_abc123",
      url: "https://example.com/hooks/atlasent",
      events: ["evaluation.deny"],
      secret: "whsec_xxxxx",
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_create_webhook",
      arguments: {
        org_id: "org_abc",
        url: "https://example.com/hooks/atlasent",
        events: ["evaluation.deny", "approval.requested"],
      },
    });
    const data = parseResult(result);
    assert.equal(data.webhook_id, "wh_abc123");
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_create_webhook",
      arguments: {
        org_id: "org_abc",
        url: "https://example.com/hooks/atlasent",
        events: ["evaluation.deny"],
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: missing events array", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_create_webhook",
      arguments: {
        org_id: "org_abc",
        url: "https://example.com/hooks/atlasent",
      },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /events/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_delete_webhook
// ---------------------------------------------------------------------------

describe("atlasent_delete_webhook", () => {
  it("happy path: returns empty body on successful delete", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({});
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_delete_webhook",
      arguments: {
        webhook_id: "wh_abc123",
        org_id: "org_abc",
      },
    });
    assert.equal(result.isError, undefined);
  });

  it("error path: 401 surfaces as isError", async () => {
    forceRemoteMode();
    globalThis.fetch = mockFetch({ error: "unauthorized" }, 401);
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_delete_webhook",
      arguments: {
        webhook_id: "wh_abc123",
        org_id: "org_abc",
      },
    });
    const data = parseResult(result);
    assert.ok(data.error, "should have error field");
    assert.equal(result.isError, true);
  });

  it("input validation: missing webhook_id", async () => {
    forceRemoteMode();
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_delete_webhook",
      arguments: { org_id: "org_abc" },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /webhook_id/i);
  });
});

// ---------------------------------------------------------------------------
// atlasent_evaluate — explain flag and risk_envelope
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// atlasent_evaluate — execution payload binding (AC-5)
//
// The binding must be TOP-LEVEL and plain 64-char lowercase hex. v1-evaluate
// destructures `execution_payload_hash` from `body` (never from `context`) and
// binds it into the signed permit only when it matches /^[0-9a-f]{64}$/ — a
// non-matching value is DROPPED, not rejected, and the permit is bound to the
// server's own hash of the whole request instead — so the caller's digest never
// constrains execution, and presenting it at verify fails deterministically.
// ---------------------------------------------------------------------------

describe("atlasent_evaluate execution payload binding", () => {
  it("sends execution_payload_hash top-level, normalized to bare 64-hex", async () => {
    forceRemoteMode();
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return new Response(JSON.stringify({ decision: "allow", permit_token: "pt_bind_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "agent.tool.invoke",
        // deliberately prefixed and uppercase — both are normalized away
        execution_payload_hash: `sha256:${"A".repeat(64)}`,
      },
    });
    const body = captured[0].body as Record<string, unknown>;
    assert.equal(body.execution_payload_hash, "a".repeat(64));
    const ctx = (body.context ?? {}) as Record<string, unknown>;
    assert.equal(ctx.execution_payload_hash, undefined, "must not be nested under context");
  });

  it("refuses a malformed digest rather than sending one the runtime will drop", async () => {
    forceRemoteMode();
    let called = false;
    globalThis.fetch = mock.fn(async () => {
      called = true;
      return new Response(JSON.stringify({ decision: "allow", permit_token: "pt_bind_2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "agent.tool.invoke",
        execution_payload_hash: "not-a-digest",
      },
    });
    assert.equal(result.isError, true);
    assert.equal(called, false, "no evaluate request may be sent for a malformed digest");
    // The error must state the real consequence (the digest never constrains
    // execution), not the superseded "mints an UNBOUND permit" claim.
    const text = JSON.stringify(result.content);
    assert.match(text, /never constrain execution/);
    assert.doesNotMatch(text, /UNBOUND/);
  });
});

// ---------------------------------------------------------------------------
// Target binding — presenting target_id at verify is not enough
//
// v1-verify-permit compares a presented target against a value it reads back
// from the EVALUATE call: firstBindingMismatch reads target/target_id out of the
// stored request_context, and the legacy permits-row path reads the target_id
// column (populated from top-level resource_id / context.target.id). Its guard
// is present-and-bound-and-differ, so with nothing bound at evaluate the
// comparison is skipped entirely and a permit minted for target A redeems while
// presenting target B.
// ---------------------------------------------------------------------------

describe("target binding", () => {
  it("binds the target in every shape the runtime reads it from", async () => {
    forceRemoteMode();
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return new Response(JSON.stringify({ decision: "allow", permit_token: "pt_t1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "production.deploy",
        target_id: "api-service",
      },
    });
    const body = captured[0].body as Record<string, unknown>;
    const ctx = (body.context ?? {}) as Record<string, unknown>;
    // top-level: drives the permit's target_id column
    assert.equal(body.resource_id, "api-service");
    // context.target_id: firstBindingMismatch's expected value
    assert.equal(ctx.target_id, "api-service");
    // context.target.id: the permits-row insert reads this shape
    assert.deepEqual(ctx.target, { id: "api-service" });
  });

  it("preserves caller target metadata while replacing the authoritative id", async () => {
    forceRemoteMode();
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return new Response(JSON.stringify({ decision: "allow", permit_token: "pt_t_meta" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "production.deploy",
        target_id: "api-service",
        context: { target: { kind: "service", region: "us-east-1", id: "stale" } },
      },
    });
    const body = captured[0].body as Record<string, unknown>;
    const ctx = body.context as Record<string, unknown>;
    assert.deepEqual(ctx.target, { kind: "service", region: "us-east-1", id: "api-service" });
  });

  it("sends a byte-identical request when no target is supplied", async () => {
    // The binding is additive. A caller that never set a target must not start
    // sending resource_id or an invented context.
    forceRemoteMode();
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return new Response(JSON.stringify({ decision: "allow", permit_token: "pt_t2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_evaluate",
      arguments: { actor_id: "user:alice", action_type: "production.deploy" },
    });
    const body = captured[0].body as Record<string, unknown>;
    assert.equal(body.resource_id, undefined);
    assert.equal(body.context, undefined);
  });

  it("deploy_service tells the runtime WHICH service it is deploying", async () => {
    // Without this the permit authorizes "a production deploy by this actor in
    // this environment" and never names the service, so one permit covers a
    // deploy of any of them.
    forceRemoteMode();
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      bodies.push({ url: String(url), ...JSON.parse((init?.body as string) ?? "{}") });
      return new Response(
        JSON.stringify({ decision: "allow", permit_token: "pt_d1", valid: true, outcome: "allow" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const { client } = await setup();
    await client.callTool({
      name: "deploy_service",
      arguments: { actor_id: "user-1", service_name: "billing-service", environment: "production" },
    });

    // deploy_service makes TWO evaluate calls: the outer agent.tool.invoke gate
    // first, then production.deploy. Select by action_type, not by order.
    const evals = bodies.filter((b) => String(b.url).includes("/v1-evaluate"));
    const deployEval = evals.find((b) => b.action_type === "production.deploy");
    const gateEval = evals.find((b) => b.action_type === "agent.tool.invoke");
    const verifies = bodies.filter((b) => String(b.url).includes("/v1-verify-permit"));
    assert.ok(deployEval, "a production.deploy evaluate must have been made");
    assert.ok(gateEval, "the outer agent.tool.invoke gate must have been evaluated");

    // The deploy names the service it is deploying.
    const ctx = (deployEval!.context ?? {}) as Record<string, unknown>;
    assert.equal(deployEval!.resource_id, "billing-service");
    assert.equal(ctx.target_id, "billing-service");
    // ...and the SAME target is presented at verify, so the two can be compared.
    assert.ok(
      verifies.some((v) => v.target_id === "billing-service"),
      "the deploy's verify must present the service as target_id",
    );

    // The outer gate names the tool it is authorizing, for the same reason.
    const gateCtx = (gateEval!.context ?? {}) as Record<string, unknown>;
    assert.equal(gateEval!.resource_id, "deploy_service");
    assert.equal(gateCtx.target_id, "deploy_service");
    // agent.tool.invoke declares required_context_inputs ['tool','environment'];
    // `tool_name` alone is not read, so without `tool` the gate always denies.
    assert.equal(gateCtx.tool, "deploy_service");
    assert.equal(gateCtx.environment, "production");
  });
});

describe("atlasent_evaluate explain + risk_envelope", () => {
  it("forwards explain=true to the API request body", async () => {
    forceRemoteMode();
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return new Response(
        JSON.stringify({ decision: "allow", permitToken: "pt_explain_1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "production.deploy",
        explain: true,
      },
    });
    const body = captured[0].body as Record<string, unknown>;
    assert.equal(body.explain, true);
  });

  it("does not include explain in the API body when omitted", async () => {
    forceRemoteMode();
    const captured: { body: unknown }[] = [];
    globalThis.fetch = mock.fn(async (_url, init) => {
      captured.push({ body: JSON.parse((init?.body as string) ?? "{}") });
      return new Response(
        JSON.stringify({ decision: "allow", permitToken: "pt_no_explain" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const { client } = await setup();
    await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "production.deploy",
      },
    });
    const body = captured[0].body as Record<string, unknown>;
    assert.equal("explain" in body, false);
  });

  it("includes risk_envelope in the response when the API returns one", async () => {
    forceRemoteMode();
    const riskEnvelope = {
      weighted_score: 0.72,
      engine_decision: "allow",
      envelope_decision: "allow",
      promoted: false,
      hard_blocks: [],
      factors: {
        time_of_day: { score: 0.3, weight: 0.5, contribution: 0.15 },
        approval_count: { score: 1.0, weight: 0.5, contribution: 0.5 },
      },
    };
    globalThis.fetch = mock.fn(async () =>
      new Response(
        JSON.stringify({
          decision: "allow",
          permitToken: "pt_risk_1",
          risk_envelope: riskEnvelope,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "production.deploy",
        explain: true,
      },
    });
    const data = parseResult(result);
    const envelope = data.risk_envelope as Record<string, unknown>;
    assert.ok(envelope, "risk_envelope must be present");
    assert.equal(envelope.weighted_score, 0.72);
    assert.equal(envelope.engine_decision, "allow");
    assert.equal(envelope.envelope_decision, "allow");
    assert.equal(envelope.promoted, false);
    assert.deepEqual(envelope.hard_blocks, []);
    const factors = envelope.factors as Record<string, unknown>;
    assert.ok(factors, "factors must be present");
    assert.deepEqual(factors.time_of_day, { score: 0.3, weight: 0.5, contribution: 0.15 });
    assert.deepEqual(factors.approval_count, { score: 1.0, weight: 0.5, contribution: 0.5 });
  });

  it("omits risk_envelope from the response when the API does not return one", async () => {
    forceRemoteMode();
    globalThis.fetch = mock.fn(async () =>
      new Response(
        JSON.stringify({ decision: "allow", permitToken: "pt_no_risk" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "production.deploy",
      },
    });
    const data = parseResult(result);
    assert.equal(data.risk_envelope, undefined);
  });

  it("includes risk_envelope without factors when explain is not set", async () => {
    forceRemoteMode();
    const riskEnvelope = {
      weighted_score: 0.45,
      engine_decision: "allow",
      envelope_decision: "allow",
      promoted: false,
      hard_blocks: [],
    };
    globalThis.fetch = mock.fn(async () =>
      new Response(
        JSON.stringify({
          decision: "allow",
          permitToken: "pt_risk_no_factors",
          risk_envelope: riskEnvelope,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_evaluate",
      arguments: {
        actor_id: "user:alice",
        action_type: "production.deploy",
      },
    });
    const data = parseResult(result);
    const envelope = data.risk_envelope as Record<string, unknown>;
    assert.ok(envelope, "risk_envelope must be present");
    assert.equal(envelope.weighted_score, 0.45);
    assert.equal(envelope.factors, undefined);
  });
});

// ---------------------------------------------------------------------------
// atlasent_lookup_action — Canon-native lookup (canon_id + graph relationships)
// ---------------------------------------------------------------------------

describe("atlasent_lookup_action (Canon-native)", () => {
  it("lists the full Canon when called with no arguments", async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: "atlasent_lookup_action", arguments: {} });
    const body = parseResult(result);
    assert.equal(body.found, true);
    assert.ok((body.result_count as number) >= 29, "expected the full 29+ action Canon");
  });

  it("returns canon_id and graph relationships for an exact slug", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_lookup_action",
      arguments: { slug: "production.deploy" },
    });
    const body = parseResult(result);
    assert.equal(body.found, true);
    const action = (body.actions as Array<Record<string, unknown>>)[0];
    assert.match(String(action.canon_id), /^CANON-\d{6}$/);
    const rel = action.relationships as {
      requires: string[];
      produces: string[];
      pattern: string;
    };
    assert.ok(rel, "expected knowledge-graph relationships");
    assert.equal(rel.pattern, "four-eyes");
    assert.ok(rel.requires.includes("approval"), "deploy requires approval");
    assert.ok(rel.produces.includes("permit"), "deploy produces a permit");
  });

  it("surfaces the flagship agent action added in the catalog expansion", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_lookup_action",
      arguments: { slug: "agent.tool.invoke" },
    });
    const body = parseResult(result);
    assert.equal(body.found, true);
    const action = (body.actions as Array<Record<string, unknown>>)[0];
    const rel = action.relationships as { assertions: string[] };
    assert.ok(rel.assertions.includes("identity"), "agent.tool.invoke requires identity assertion");
  });

  it("resolves a plain-language query to a Canon entry with a confident retrieval verdict", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_lookup_action",
      arguments: { query: "deploy the api service to prod" },
    });
    const body = parseResult(result);
    assert.equal(body.found, true);
    assert.equal(result.isError, undefined, "a successful lookup is not an error");
    const retrieval = body.retrieval as { mode: string; confidence: string; candidates: Array<{ slug: string }> };
    assert.equal(retrieval.mode, "ranked");
    assert.equal(retrieval.confidence, "confident");
    assert.equal(retrieval.candidates[0].slug, "production.deploy");
    const first = (body.actions as Array<Record<string, unknown>>)[0];
    assert.equal(first.slug, "production.deploy");
    assert.match(String(first.canon_id), /^CANON-\d{6}$/);
    assert.ok(first.relationships, "ranked results are enriched with graph relationships like slug results");
  });

  it("returns found:false with the intake hint, never an invented slug, for a non-Canon request", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: "atlasent_lookup_action",
      arguments: { query: "provision a brand new saas tenant with billing" },
    });
    const body = parseResult(result);
    const retrieval = body.retrieval as { confidence: string; candidates: Array<{ slug: string }> };
    // Either the Canon has nothing (none) or it is not sure (ambiguous) —
    // but it must never report `confident` for an action the Canon lacks.
    assert.notEqual(retrieval.confidence, "confident", JSON.stringify(body));
    if (retrieval.confidence === "none") {
      assert.equal(body.found, false);
      assert.deepEqual(body.actions, []);
      assert.match(String(body.hint), /LIFECYCLE\.md/, "no-match hint points at the Canon intake pipeline");
    }
    for (const c of retrieval.candidates) {
      assert.doesNotMatch(c.slug, /tenant\.provision/, "the tool must not synthesize a slug");
    }
  });
});

// ---------------------------------------------------------------------------
// serverInfo version — must track package.json (registries display it)
// ---------------------------------------------------------------------------

describe("serverInfo version", () => {
  it("reports the package.json version, not a stale literal", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const { client } = await setup();
    assert.equal(client.getServerVersion()?.version, pkg.version);
  });
});
