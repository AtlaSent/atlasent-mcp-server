/**
 * IMPL-026B founder decision 5, MCP side (2026-09-25): reduce approval
 * friction without widening authority.
 *
 *  - Auto Change Brief: a mandatory-change-control evaluate first records the
 *    exact change_plan in a Change Brief and sends its id + the same plan.
 *  - The claim presents the SAME plan, so a mismatch means a genuine change.
 *  - On change_plan_mismatch: ONE linked re-request (supersedes_approval_id)
 *    and keep waiting — or, on request, claim the approved plan instead.
 *  - Never loop; suspicious / revoked / policy-off / any error → no permit.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  authorize,
  awaitApproval,
  evaluateAction,
  normalizeChangePlan,
  _resetPendingChangeRequestsForTests,
  type AwaitApprovalParams,
} from "./engine.js";
import { createServer, _resetRateLimitForTests } from "./server.js";

type Reply = { status: number; body: unknown } | "throw";
type Route = (method: string, path: string, body: Record<string, unknown> | undefined) => Reply;

let originalFetch: typeof globalThis.fetch;
const sent: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];

function route(fn: Route): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url)).pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    sent.push({ method, path, body });
    const r = fn(method, path, body);
    if (r === "throw") throw new Error("network down");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const EVAL = "/functions/v1/v1-evaluate";
const BRIEF = "/functions/v1/v1-change-brief";
const MINT = "/functions/v1/v1-agent-actor-identity";
const claimPath = (id: string) => `/v1/approvals/${id}/claim-permit`;
const statusPath = (id: string) => `/v1/approvals/${id}`;

const P1 = { operation: "deploy", revision: "aaa111" };
const P2 = { operation: "deploy", revision: "bbb222" };
const AWAITING = { status: "approved_awaiting_claim", action_type: "production.deploy", environment: "production" };
const ASSERTION = {
  version: "actor_identity.v1",
  subject: { principal_id: "agent:x", principal_kind: "agent", role: "agent" },
  binding: { action_type: "production.deploy", tenant_id: "org-1", environment: "production" },
  signature: "ab".repeat(64),
};
const FAST: Omit<AwaitApprovalParams, "approval_request_id"> = { max_wait_ms: 2_000, poll_interval_ms: 5 };

function mismatch(extra: Record<string, unknown> = {}) {
  return {
    status: 409,
    body: {
      error: "change_plan_mismatch",
      message: "The presented change_plan differs",
      status: 409,
      approval_id: "apr_1",
      recorded_change_plan_hash: "h-recorded",
      presented_change_plan_hash: "h-presented",
      diff: [{ field: "revision", recorded: "aaa111", presented: "bbb222" }],
      variance_class: "same_scope",
      material_variance_class: "same_scope",
      mismatch_count: 1,
      revoke_threshold: 3,
      reconciliation: { prior_approval_id: "apr_1", approval_linking: { supported: true, field: "supersedes_approval_id" } },
      ...extra,
    },
  };
}

const posts = (path: string) => sent.filter((s) => s.method === "POST" && s.path === path);

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

/** Evaluate production.deploy with P1 → hold apr_1 (brief cb_1). Registers the plan. */
async function holdWithPlan(): Promise<void> {
  route((m, p) => {
    if (p === BRIEF) return { status: 200, body: { change_brief_id: "cb_1" } };
    if (p === EVAL) return { status: 200, body: { decision: "hold", approval_request_id: "apr_1", deny_reason: "needs a person" } };
    return { status: 500, body: {} };
  });
  const d = await authorize({
    action_type: "production.deploy",
    actor_id: "svc:bot",
    environment: "production",
    target_id: "checkout",
    target_system: "kubernetes",
    change_plan: P1,
  });
  assert.equal(d.decision, "hold");
  sent.length = 0;
}

// ---------------------------------------------------------------------------
// Auto Change Brief at evaluate
// ---------------------------------------------------------------------------

describe("auto Change Brief for mandatory-change-control actions", () => {
  it("creates the brief FIRST with exactly the plan, then evaluates with its id and the same top-level plan", async () => {
    route((_m, p) => {
      if (p === BRIEF) return { status: 200, body: { change_brief_id: "cb_1" } };
      if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
      if (p === EVAL) return { status: 200, body: { decision: "allow", permit_token: "pt.v4.ok" } };
      return { status: 500, body: {} };
    });
    const d = await authorize({
      action_type: "production.deploy",
      actor_id: "svc:bot",
      environment: "production",
      target_id: "checkout",
      change_plan: { operation: " deploy ", revision: "aaa111", artifact_ref: "" },
    });
    assert.equal(d.decision, "allow");
    assert.deepEqual(sent.map((s) => s.path), [BRIEF, MINT, EVAL], "brief, then the actor identity, then evaluate");
    const brief = sent[0].body!;
    assert.deepEqual(brief.execution_change_plan, P1, "normalised plan, nothing invented");
    assert.equal(brief.action_type, "production.deploy");
    assert.equal(brief.target_id, "checkout");
    assert.equal(brief.environment, "production");
    assert.equal(brief.actor_id, "svc:bot");
    assert.equal(brief.target_system, "unspecified");
    assert.match(String(brief.canonical_plan_digest), /^sha256:[0-9a-f]{64}$/);
    const ev = sent[2].body!;
    assert.deepEqual(ev.actor_identity, ASSERTION, "the minted agent identity rides the evaluate");
    assert.equal(ev.change_brief_id, "cb_1");
    assert.deepEqual(ev.change_plan, brief.execution_change_plan, "evaluate plan === brief plan");
    assert.equal(ev.resource_id, "checkout", "brief target_id matches the evaluate resource_id");
  });

  it("atlasent_evaluate's path (evaluateAction) does the same, taking environment from context", async () => {
    route((_m, p) => (p === BRIEF ? { status: 200, body: { change_brief_id: "cb_9" } } : { status: 200, body: { decision: "hold", approval_request_id: "apr_7" } }));
    const r = await evaluateAction({
      action_type: "infrastructure.change",
      actor_id: "svc:tf",
      target_id: "vpc-1",
      context: { environment: "production" },
      change_plan: { operation: "apply", artifact_ref: "plan-42" },
    });
    assert.equal(r.decision, "hold");
    assert.deepEqual(sent.map((s) => s.path), [BRIEF, MINT, EVAL]);
    assert.equal(sent[1].body!.environment, "production", "identity minted for the context environment");
    assert.equal(sent[2].body!.change_brief_id, "cb_9");
    assert.deepEqual(sent[2].body!.change_plan, { operation: "apply", artifact_ref: "plan-42" });
  });

  for (const status of [404, 403]) {
    it(`brief HTTP ${status} → evaluates without a brief and says so in notes`, async () => {
      route((_m, p) => (p === BRIEF ? { status, body: { error: "x" } } : { status: 200, body: { decision: "allow", permit_token: "pt" } }));
      const d = await authorize({ action_type: "production.deploy", actor_id: "a", environment: "production", target_id: "t", change_plan: P1 });
      assert.equal(d.decision, "allow");
      assert.equal("change_brief_id" in posts(EVAL)[0].body!, false);
      assert.deepEqual(posts(EVAL)[0].body!.change_plan, P1, "the plan is still sent");
      assert.match((d as { notes?: string[] }).notes!.join(" "), new RegExp(`HTTP ${status}`));
    });
  }

  const briefFailures: Array<[string, Reply]> = [
    ["HTTP 500", { status: 500, body: { error: "brief_unavailable" } }],
    ["HTTP 401", { status: 401, body: {} }],
    ["a network error", "throw"],
    ["a 200 with no change_brief_id", { status: 200, body: {} }],
  ];
  for (const [label, reply] of briefFailures) {
    it(`brief ${label} → fails closed: deny, and nothing is evaluated`, async () => {
      route((_m, p) => (p === BRIEF ? reply : { status: 200, body: { decision: "allow", permit_token: "pt.should-not" } }));
      const d = await authorize({ action_type: "production.deploy", actor_id: "a", environment: "production", target_id: "t", change_plan: P1 });
      assert.equal(d.decision, "deny");
      assert.equal(posts(EVAL).length, 0);
    });
  }

  it("an invalid plan is refused at the client boundary (deny, no request)", async () => {
    route(() => ({ status: 200, body: { decision: "allow", permit_token: "pt" } }));
    const d = await authorize({ action_type: "production.deploy", actor_id: "a", environment: "production", change_plan: { operation: "deploy" } });
    assert.equal(d.decision, "deny");
    assert.equal(sent.length, 0);
    assert.throws(() => normalizeChangePlan({ operation: "x", revision: "y", extra: 1 }), /not part of a plan/);
  });

  it("no brief when the binding fields are unknown (e.g. no target): note, still evaluates with the plan", async () => {
    route(() => ({ status: 200, body: { decision: "allow", permit_token: "pt" } }));
    const d = await authorize({ action_type: "production.deploy", actor_id: "a", environment: "production", change_plan: P1 });
    assert.equal(d.decision, "allow");
    assert.equal(posts(BRIEF).length, 0);
    assert.match((d as { notes?: string[] }).notes![0], /target_id not known/);
  });

  it("non-mandatory actions never create a brief, and no plan means a byte-identical request", async () => {
    route(() => ({ status: 200, body: { decision: "allow", permit_token: "pt" } }));
    await authorize({ action_type: "agent.tool.invoke", actor_id: "a", environment: "production", target_id: "t", change_plan: P1 });
    await authorize({ action_type: "production.deploy", actor_id: "a", environment: "production", target_id: "t" });
    assert.equal(posts(BRIEF).length, 0);
    assert.equal("change_plan" in posts(EVAL)[1].body!, false);
    assert.equal("change_brief_id" in posts(EVAL)[1].body!, false);
  });
});

// ---------------------------------------------------------------------------
// Claim presents the same plan; mismatch → one linked re-request
// ---------------------------------------------------------------------------

describe("awaitApproval — plan presented at claim", () => {
  it("presents the SAME plan the server evaluated; no mismatch, permit, approved_plan", async () => {
    await holdWithPlan();
    route((m, p) => {
      if (m === "GET") return { status: 200, body: AWAITING };
      if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
      return { status: 200, body: { claimed: true, permit_token: "pt.v4.same" } };
    });
    const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1" });
    assert.equal(r.outcome, "approved");
    assert.deepEqual(posts(claimPath("apr_1"))[0].body!.change_plan, P1);
    assert.deepEqual(r.outcome === "approved" && r.approved_plan, P1);
    assert.equal(posts(EVAL).length, 0);
  });
});

describe("awaitApproval — change_plan_mismatch", () => {
  /** apr_1 mismatches; re-request → hold apr_2; apr_2's claim succeeds. */
  function rerequestHappyRoutes(overrides: { apr2Claim?: () => Reply; evaluate?: () => Reply; brief?: () => Reply } = {}) {
    route((m, p) => {
      if (m === "GET" && p === statusPath("apr_1")) return { status: 200, body: AWAITING };
      if (m === "GET" && p === statusPath("apr_2")) return { status: 200, body: AWAITING };
      if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
      if (p === claimPath("apr_1")) return mismatch();
      if (p === BRIEF) return overrides.brief?.() ?? { status: 200, body: { change_brief_id: "cb_2" } };
      if (p === EVAL) {
        return overrides.evaluate?.() ?? {
          status: 200,
          body: {
            decision: "hold",
            approval_request_id: "apr_2",
            supersedes_approval: { approval_id: "apr_1", accepted: true, variance_class: "same_scope" },
          },
        };
      }
      if (p === claimPath("apr_2")) return overrides.apr2Claim?.() ?? { status: 200, body: { claimed: true, permit_token: "pt.v4.new" } };
      return { status: 500, body: {} };
    });
  }

  it("files exactly ONE linked re-request with a new brief, waits on the new approval, returns its permit", async () => {
    await holdWithPlan();
    rerequestHappyRoutes();
    const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2 });
    assert.equal(r.outcome, "approved");
    assert.ok(r.outcome === "approved");
    assert.equal(r.permit_token, "pt.v4.new");
    assert.equal(r.approval_request_id, "apr_2");
    assert.equal(r.original_approval_request_id, "apr_1");
    assert.deepEqual(r.approved_plan, P2);
    assert.deepEqual(r.plan_mismatch?.from, P1, "recorded plan rebuilt from the diff");
    assert.deepEqual(r.plan_mismatch?.to, P2);
    assert.match(r.progression!.join(" | "), /plan changed from deploy, revision aaa111 to deploy, revision bbb222 → re-request sent \(approval apr_2\) → waiting/);

    const evals = posts(EVAL);
    assert.equal(evals.length, 1, "exactly one re-request");
    const ev = evals[0].body!;
    assert.equal(ev.supersedes_approval_id, "apr_1");
    assert.equal(ev.change_brief_id, "cb_2");
    assert.deepEqual(ev.change_plan, P2);
    assert.equal(ev.action_type, "production.deploy");
    assert.equal(ev.actor_id, "svc:bot");
    assert.equal(ev.resource_id, "checkout", "same request otherwise");
    const briefs = posts(BRIEF);
    assert.equal(briefs.length, 1);
    assert.deepEqual(briefs[0].body!.execution_change_plan, P2, "the new brief records the presented plan");
    assert.deepEqual(briefs[0].body!.execution_change_plan, ev.change_plan);
    assert.ok(sent.indexOf(briefs[0]) < sent.indexOf(evals[0]), "brief before evaluate");
    assert.deepEqual(posts(claimPath("apr_2"))[0].body!.change_plan, P2, "the new approval is claimed with the new plan");
  });

  it("a second mismatch stops: no second re-request, no permit", async () => {
    await holdWithPlan();
    rerequestHappyRoutes({ apr2Claim: () => mismatch({ approval_id: "apr_2" }) });
    const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2 });
    assert.equal(r.outcome, "not_approved");
    assert.equal("permit_token" in r, false);
    assert.equal(posts(EVAL).length, 1, "no second re-request");
    assert.match(r.outcome === "not_approved" ? r.reasons[0] : "", /Only one automatic re-request/);
  });

  it("repeated 409 mismatches terminate promptly (no loop until the deadline)", async () => {
    await holdWithPlan();
    route((m, p) => {
      if (m === "GET") return { status: 200, body: AWAITING };
      if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
      if (p === BRIEF) return { status: 200, body: { change_brief_id: "cb_n" } };
      if (p === EVAL) return { status: 200, body: { decision: "hold", approval_request_id: `apr_${posts(EVAL).length + 1}` } };
      return mismatch();
    });
    const started = Date.now();
    const r = await awaitApproval({ ...FAST, max_wait_ms: 10_000, approval_request_id: "apr_1", change_plan: P2 });
    assert.equal(r.outcome, "not_approved");
    assert.ok(Date.now() - started < 2_000, "returned well before the deadline");
    assert.equal(posts(EVAL).length, 1);
    assert.ok(sent.filter((s) => s.path.endsWith("/claim-permit")).length <= 2);
  });

  const stops: Array<[string, Reply]> = [
    ["the approval was revoked (suspicious)", {
      status: 409,
      body: { ...mismatch().body, error: "approval_revoked_suspicious_plan_variance", variance_class: "suspicious", approval_status: "revoked" },
    }],
    ["only the error code says revoked", {
      status: 409,
      body: { ...mismatch().body, error: "approval_revoked_suspicious_plan_variance" },
    }],
    ["the variance is classed suspicious", mismatch({ variance_class: "suspicious" })],
    ["the 409 reports approval_status revoked", mismatch({ approval_status: "revoked" })],
  ];
  for (const [label, reply] of stops) {
    it(`stops without re-requesting when ${label}`, async () => {
      await holdWithPlan();
      route((m, p) => {
        if (m === "GET") return { status: 200, body: AWAITING };
        if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
        if (p === claimPath("apr_1")) return reply;
        return { status: 200, body: { decision: "allow", permit_token: "pt.should-not" } };
      });
      const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2 });
      assert.equal(r.outcome, "not_approved");
      assert.equal("permit_token" in r, false);
      assert.equal(posts(EVAL).length, 0);
      assert.equal(posts(BRIEF).length, 0);
      assert.ok(r.outcome === "not_approved" && r.plan_mismatch?.diff, "the diff is returned");
      assert.match(r.outcome === "not_approved" ? r.reasons[0] : "", /REVOKED/);
    });
  }

  for (const where of ["409 body", "approval row"] as const) {
    it(`auto_rerequest_on_mismatch=false (${where}) stops with guidance`, async () => {
      await holdWithPlan();
      route((m, p) => {
        if (m === "GET") return { status: 200, body: { ...AWAITING, ...(where === "approval row" && { auto_rerequest_on_mismatch: false }) } };
        if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
        if (p === claimPath("apr_1")) return mismatch(where === "409 body" ? { auto_rerequest_on_mismatch: false } : {});
        return { status: 200, body: { decision: "allow", permit_token: "pt.should-not" } };
      });
      const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2 });
      assert.equal(r.outcome, "not_approved");
      assert.equal(posts(EVAL).length, 0);
      const reason = r.outcome === "not_approved" ? r.reasons[0] : "";
      assert.match(reason, /auto_rerequest_on_mismatch=false/);
      assert.match(reason, /use_approved/);
      assert.match(reason, /supersedes_approval_id=apr_1/);
    });
  }

  it("auto_change_brief=false → the re-request is sent without a brief", async () => {
    await holdWithPlan();
    route((m, p) => {
      if (m === "GET") return { status: 200, body: { ...AWAITING, auto_change_brief: false } };
      if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
      if (p === claimPath("apr_1")) return mismatch();
      if (p === EVAL) return { status: 200, body: { decision: "hold", approval_request_id: "apr_2" } };
      if (p === claimPath("apr_2")) return { status: 200, body: { claimed: true, permit_token: "pt.v4.nobrief" } };
      return { status: 500, body: {} };
    });
    const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2 });
    assert.equal(r.outcome, "approved");
    assert.equal(posts(BRIEF).length, 0);
    assert.equal("change_brief_id" in posts(EVAL)[0].body!, false);
    assert.equal(posts(EVAL)[0].body!.supersedes_approval_id, "apr_1");
  });

  it("a brief failure on the re-request fails closed (no evaluate, no permit)", async () => {
    await holdWithPlan();
    rerequestHappyRoutes({ brief: () => ({ status: 500, body: { error: "brief_unavailable" } }) });
    const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2 });
    assert.equal(r.outcome, "not_approved");
    assert.equal(posts(EVAL).length, 0);
  });

  it("a brief 403 on the re-request proceeds without a brief, with a note", async () => {
    await holdWithPlan();
    rerequestHappyRoutes({ brief: () => ({ status: 403, body: {} }) });
    const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2 });
    assert.equal(r.outcome, "approved");
    assert.equal("change_brief_id" in posts(EVAL)[0].body!, false);
    assert.match(r.notes!.join(" "), /change_brief:read/);
  });

  it("the re-request allowed directly → permit for the new plan, no further claim", async () => {
    await holdWithPlan();
    rerequestHappyRoutes({ evaluate: () => ({ status: 200, body: { decision: "allow", permit_token: "pt.v4.direct" } }) });
    const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2 });
    assert.equal(r.outcome, "approved");
    assert.ok(r.outcome === "approved");
    assert.equal(r.permit_token, "pt.v4.direct");
    assert.deepEqual(r.approved_plan, P2);
    assert.equal(posts(claimPath("apr_2")).length, 0);
  });

  const reevalFailures: Array<[string, Reply]> = [
    ["denies", { status: 200, body: { decision: "deny", deny_code: "POLICY" } }],
    ["errors (500)", { status: 500, body: {} }],
    ["is unreachable", "throw"],
    ["allows with no permit", { status: 200, body: { decision: "allow" } }],
    ["holds with no approval id", { status: 200, body: { decision: "hold" } }],
  ];
  for (const [label, reply] of reevalFailures) {
    it(`the re-request ${label} → no permit`, async () => {
      await holdWithPlan();
      rerequestHappyRoutes({ evaluate: () => reply });
      const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2 });
      assert.equal(r.outcome, "not_approved");
      assert.equal("permit_token" in r, false);
      assert.equal(posts(EVAL).length, 1);
    });
  }

  it("an unaccepted supersedes link is reported but the new approval is still awaited", async () => {
    await holdWithPlan();
    rerequestHappyRoutes({
      evaluate: () => ({ status: 200, body: { decision: "hold", approval_request_id: "apr_2", supersedes_approval: { approval_id: null, accepted: false, reason: "different actor" } } }),
    });
    const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2 });
    assert.equal(r.outcome, "approved");
    assert.match(r.notes!.join(" "), /not linked to approval apr_1: different actor/);
  });

  it("a request this server did not evaluate cannot be re-requested: stop with guidance", async () => {
    route((m, p) => {
      if (m === "GET") return { status: 200, body: AWAITING };
      if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
      if (p === claimPath("apr_x")) return mismatch({ approval_id: "apr_x" });
      return { status: 200, body: { decision: "allow", permit_token: "pt.should-not" } };
    });
    const r = await awaitApproval({ ...FAST, approval_request_id: "apr_x", change_plan: P2 });
    assert.equal(r.outcome, "not_approved");
    assert.equal(posts(EVAL).length, 0);
    assert.match(r.outcome === "not_approved" ? r.reasons[0] : "", /did not evaluate the original/);
  });
});

describe("awaitApproval — on_plan_mismatch: use_approved", () => {
  it("claims again WITHOUT change_plan and returns the approved (recorded) plan", async () => {
    await holdWithPlan();
    route((m, p, body) => {
      if (m === "GET") return { status: 200, body: AWAITING };
      if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
      if (p === claimPath("apr_1")) {
        return body && "change_plan" in body ? mismatch() : { status: 200, body: { claimed: true, permit_token: "pt.v4.recorded" } };
      }
      return { status: 500, body: {} };
    });
    const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2, on_plan_mismatch: "use_approved" });
    assert.equal(r.outcome, "approved");
    assert.ok(r.outcome === "approved");
    assert.equal(r.permit_token, "pt.v4.recorded");
    assert.deepEqual(r.approved_plan, P1, "the agent is told to run the APPROVED plan");
    const claims = posts(claimPath("apr_1"));
    assert.equal(claims.length, 2);
    assert.deepEqual(claims[0].body!.change_plan, P2);
    assert.equal("change_plan" in claims[1].body!, false, "second claim omits the plan");
    assert.ok("actor_identity" in claims[1].body!);
    assert.equal(posts(EVAL).length, 0, "no re-request");
    assert.match(r.progression!.join(" "), /using the approved plan \(deploy, revision aaa111\)/);
  });

  it("does not claim on the agent's behalf when the approved plan cannot be determined", async () => {
    await holdWithPlan();
    route((m, p) => {
      if (m === "GET") return { status: 200, body: AWAITING };
      if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
      return mismatch({ diff: "garbled" });
    });
    const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2, on_plan_mismatch: "use_approved" });
    assert.equal(r.outcome, "not_approved");
    assert.equal(posts(claimPath("apr_1")).length, 1);
  });

  it("still stops on a revoked approval", async () => {
    await holdWithPlan();
    route((m, p) => {
      if (m === "GET") return { status: 200, body: AWAITING };
      if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
      return { status: 409, body: { ...mismatch().body, error: "approval_revoked_suspicious_plan_variance", variance_class: "suspicious" } };
    });
    const r = await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2, on_plan_mismatch: "use_approved" });
    assert.equal(r.outcome, "not_approved");
    assert.equal(posts(claimPath("apr_1")).length, 1);
  });
});

// ---------------------------------------------------------------------------
// End to end through the MCP tools
// ---------------------------------------------------------------------------

describe("deploy_service → atlasent_await_approval (tools)", () => {
  it("hold with an auto brief, then a plan change reported as one progression", async () => {
    route((m, p, body) => {
      if (p === EVAL && body?.action_type === "agent.tool.invoke") return { status: 200, body: { decision: "allow", permit_token: "pt.gate" } };
      if (p === "/functions/v1/v1-verify-permit") return { status: 200, body: { valid: true, outcome: "allow" } };
      if (p === BRIEF) return { status: 200, body: { change_brief_id: posts(BRIEF).length === 1 ? "cb_1" : "cb_2" } };
      if (p === EVAL && body?.supersedes_approval_id) return { status: 200, body: { decision: "hold", approval_request_id: "apr_2" } };
      if (p === EVAL) return { status: 200, body: { decision: "hold", approval_request_id: "apr_1" } };
      if (m === "GET") return { status: 200, body: AWAITING };
      if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
      if (p === claimPath("apr_1")) return mismatch();
      if (p === claimPath("apr_2")) return { status: 200, body: { claimed: true, permit_token: "pt.v4.tool" } };
      return { status: 500, body: {} };
    });
    const server = createServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c), server.connect(s)]);

    const held = await client.callTool({
      name: "deploy_service",
      arguments: { service_name: "checkout", environment: "production", actor_id: "svc:bot", change_plan: P1 },
    });
    const h = JSON.parse((held.content as Array<{ text: string }>)[0].text);
    assert.equal(h.decision, "hold");
    assert.equal(h.approval_request_id, "apr_1");
    const deployEval = posts(EVAL).find((x) => x.body!.action_type === "production.deploy")!;
    assert.equal(deployEval.body!.change_brief_id, "cb_1");
    assert.deepEqual(deployEval.body!.change_plan, P1);

    const res = await client.callTool({
      name: "atlasent_await_approval",
      arguments: { approval_request_id: "apr_1", max_wait_seconds: 5, change_plan: P2 },
    });
    const out = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    assert.equal(out.outcome, "approved");
    assert.equal(out.approval_request_id, "apr_2");
    assert.match(out.summary, /plan changed from deploy, revision aaa111 to deploy, revision bbb222 → re-request sent \(approval apr_2\) → waiting → approved/);
    assert.match(out.next_step, /atlasent_verify_permit/);
  });
});

// ---------------------------------------------------------------------------
// Verified actor identity at evaluate (mandatory change control)
// ---------------------------------------------------------------------------
//
// atlasent-api requiresActorIdentityAtEvaluate() forces the verified-actor gate
// on for production.deploy & co. Without an assertion the runtime denies
// ACTOR_UNVERIFIED before any rule runs, so an approval hold is unreachable.

describe("verified actor identity at evaluate", () => {
  it("an agent-bound key's minted identity is attached, bound to this action and environment", async () => {
    route((_m, p) => {
      if (p === BRIEF) return { status: 200, body: { change_brief_id: "cb_1" } };
      if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
      if (p === EVAL) return { status: 200, body: { decision: "hold", approval_request_id: "apr_1" } };
      return { status: 500, body: {} };
    });
    const d = await authorize({ action_type: "production.deploy", environment: "production", target_id: "checkout", change_plan: P1 });
    assert.equal(d.decision, "hold");
    assert.deepEqual(posts(MINT)[0].body, { action_type: "production.deploy", environment: "production" });
    assert.deepEqual(posts(EVAL)[0].body!.actor_identity, ASSERTION);
    const notes = (d as { notes?: string[] }).notes ?? [];
    assert.equal(notes.some((n) => /actor identity/.test(n)), false, "no identity note when minting worked");
  });

  it("a key that cannot mint (not agent-bound) still evaluates, without an identity, and says why", async () => {
    route((_m, p) => {
      if (p === BRIEF) return { status: 200, body: { change_brief_id: "cb_1" } };
      if (p === MINT) return { status: 403, body: { error: "agent_binding_required" } };
      if (p === EVAL) return { status: 200, body: { decision: "deny", deny_code: "ACTOR_UNVERIFIED", deny_reason: "no assertion" } };
      return { status: 500, body: {} };
    });
    const d = await evaluateAction({
      action_type: "production.deploy",
      actor_id: "deploy-bot",
      context: { environment: "production" },
      change_plan: P1,
    });
    assert.equal(d.decision, "deny", "the runtime decides; the client never upgrades anything");
    assert.equal("actor_identity" in posts(EVAL)[0].body!, false);
    assert.match(String((d.notes as string[]).join(" ")), /agent_binding_required.*agent-bound/);
  });

  it("does not mint an identity for an action outside mandatory change control", async () => {
    route((_m, p) => (p === EVAL ? { status: 200, body: { decision: "allow", permit_token: "pt" } } : { status: 500, body: {} }));
    await authorize({ action_type: "data.export", actor_id: "a", environment: "production" });
    assert.equal(posts(MINT).length, 0);
  });

  it("does not mint when no change_plan was given (the plan gate denies first)", async () => {
    route((_m, p) => (p === EVAL ? { status: 200, body: { decision: "deny", deny_code: "EXECUTION_PAYLOAD_HASH_REQUIRED" } } : { status: 500, body: {} }));
    await authorize({ action_type: "production.deploy", actor_id: "a", environment: "production" });
    assert.equal(posts(MINT).length, 0);
  });
});

describe("deploy_service without a change_plan (remote)", () => {
  it("refuses with an actionable reason before any runtime call", async () => {
    route(() => ({ status: 500, body: {} }));
    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const res = await client.callTool({
      name: "deploy_service",
      arguments: { service_name: "checkout", environment: "production", actor_id: "agent:a1" },
    });
    const out = JSON.parse((res.content as Array<{ text: string }>)[0].text) as { decision: string; reasons: string[] };
    assert.equal(out.decision, "deny");
    assert.match(out.reasons[0], /change_plan.*operation.*revision/);
    assert.match(out.reasons[0], /do not invent one/);
    assert.equal(sent.length, 0, "no evaluate, no agent gate, nothing executed");
  });
});

// ---------------------------------------------------------------------------
// Attempt correlation: the tool gate and the action it guards share request_id
// ---------------------------------------------------------------------------
//
// atlasent-console's Quick Start shows the agent's deploy attempt by reading
// these ids back from the decision log. Without them it could only match on
// actor + time, which picked up the agent's unrelated traffic.

describe("deploy_service request correlation", () => {
  const ATTEMPT = /^mcp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  async function deployOnce(client: Client): Promise<{ gate: string; action: string }> {
    const before = posts(EVAL).length;
    await client.callTool({
      name: "deploy_service",
      arguments: { service_name: "checkout", environment: "production", actor_id: "svc:bot", change_plan: P1 },
    });
    const evals = posts(EVAL).slice(before);
    const gate = evals.find((x) => x.body!.action_type === "agent.tool.invoke")!.body!.request_id as string;
    const action = evals.find((x) => x.body!.action_type === "production.deploy")!.body!.request_id as string;
    return { gate, action };
  }

  it("sends one attempt id on the gate and on the deploy, and a new one per call", async () => {
    route((_m, p, body) => {
      if (p === EVAL && body?.action_type === "agent.tool.invoke") return { status: 200, body: { decision: "allow", permit_token: "pt.gate" } };
      if (p === "/functions/v1/v1-verify-permit") return { status: 200, body: { valid: true, outcome: "allow" } };
      if (p === BRIEF) return { status: 200, body: { change_brief_id: "cb_1" } };
      if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
      if (p === EVAL) return { status: 200, body: { decision: "hold", approval_request_id: "apr_1" } };
      return { status: 500, body: {} };
    });
    const server = createServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c), server.connect(s)]);

    const first = await deployOnce(client);
    const gateMatch = /^(.+)\.tool-gate$/.exec(first.gate);
    const actionMatch = /^(.+)\.action$/.exec(first.action);
    assert.ok(gateMatch && actionMatch, `unexpected ids ${first.gate} / ${first.action}`);
    assert.match(gateMatch![1], ATTEMPT);
    assert.equal(gateMatch![1], actionMatch![1], "the gate and the deploy it guards share one attempt");

    const second = await deployOnce(client);
    assert.notEqual(second.action, first.action, "a new call is a new attempt, never an idempotent replay");
  });

  it("a gate refusal still carries the attempt id, and no deploy is asked", async () => {
    route((_m, p) =>
      p === EVAL ? { status: 200, body: { decision: "deny", deny_code: "NO_TEMPLATE_MATCH", deny_reason: "no" } } : { status: 500, body: {} },
    );
    const server = createServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c), server.connect(s)]);
    await client.callTool({
      name: "deploy_service",
      arguments: { service_name: "checkout", environment: "production", actor_id: "svc:bot", change_plan: P1 },
    });
    const evals = posts(EVAL);
    assert.equal(evals.length, 1);
    assert.match(String(evals[0].body!.request_id), /^mcp-.+\.tool-gate$/);
  });

  it("a linked re-request gets a NEW request_id under the same attempt (reuse would replay the hold)", async () => {
    await holdWithPlan();
    // holdWithPlan evaluates without an attempt; give the remembered body one.
    const d = await authorize({
      action_type: "production.deploy",
      actor_id: "svc:bot",
      environment: "production",
      target_id: "checkout",
      change_plan: P1,
      request_id: "mcp-11111111-2222-4333-8444-555555555555.action",
    });
    assert.equal(d.decision, "hold");
    sent.length = 0;
    route((m, p) => {
      if (m === "GET") return { status: 200, body: AWAITING };
      if (p === MINT) return { status: 200, body: { assertion: ASSERTION } };
      if (p === claimPath("apr_1")) return mismatch();
      if (p === BRIEF) return { status: 200, body: { change_brief_id: "cb_2" } };
      if (p === EVAL) return { status: 200, body: { decision: "hold", approval_request_id: "apr_2" } };
      if (p === claimPath("apr_2")) return { status: 200, body: { claimed: true, permit_token: "pt.v4.new" } };
      return { status: 500, body: {} };
    });
    await awaitApproval({ ...FAST, approval_request_id: "apr_1", change_plan: P2 });
    const reId = String(posts(EVAL)[0].body!.request_id);
    assert.match(reId, /^mcp-11111111-2222-4333-8444-555555555555\.action\.rerequest-[0-9a-f]{8}$/);
  });
});
