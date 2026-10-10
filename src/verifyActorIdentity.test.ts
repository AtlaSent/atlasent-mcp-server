/**
 * Commit-point principal proof at verify (atlasent-api#3915).
 *
 * v1-verify-permit requires a verified actor_identity.v1 bound to the permit's
 * actor when the action class is classified `verified_actor`. This client
 * cannot see that mode, so for the action types it already mints an identity
 * for at evaluate (agent.* and the four change-control types) it mints a fresh
 * one at verify too. The runtime ignores a presented identity in every other
 * mode, and a failed mint never blocks the verify: the runtime decides.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { verify } from "./engine.js";

type Reply = { status: number; body: unknown };

let originalFetch: typeof globalThis.fetch;
const sent: Array<{ path: string; body: Record<string, unknown> | undefined }> = [];

const VERIFY = "/functions/v1/v1-verify-permit";
const MINT = "/functions/v1/v1-agent-actor-identity";

function assertionFor(action_type: string, environment: string) {
  return {
    version: "actor_identity.v1",
    subject: { principal_id: "agent:a1", principal_kind: "agent", role: "agent" },
    binding: { action_type, tenant_id: "org-1", environment },
    signature: "ab".repeat(64),
  };
}

function runtime(mint?: Reply): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    sent.push({ path, body });
    let r: Reply;
    if (path === MINT) {
      r = mint ?? { status: 200, body: { assertion: assertionFor(String(body!.action_type), String(body!.environment)) } };
    } else if (path === VERIFY) {
      r = { status: 200, body: { valid: true, outcome: "allow" } };
    } else {
      r = { status: 500, body: {} };
    }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
const posts = (p: string) => sent.filter((s) => s.path === p);

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent.length = 0;
  process.env.ATLASENT_MODE = "remote";
  process.env.ATLASENT_API_KEY = "test-key";
  process.env.ATLASENT_BASE_URL = "https://api.test/functions/v1";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ATLASENT_MODE;
  delete process.env.ATLASENT_API_KEY;
  delete process.env.ATLASENT_BASE_URL;
});

describe("verify presents the actor's identity at the commit point", () => {
  for (const action_type of ["production.deploy", "infrastructure.change", "agent.tool.invoke"]) {
    it(`${action_type}: mints for exactly this action and environment and presents it`, async () => {
      runtime();
      const result = await verify("pt.v4.tok", { action_type, actor_id: "agent:a1", environment: "staging" });
      assert.equal(result.valid, true);
      assert.deepEqual(posts(MINT).map((m) => m.body), [{ action_type, environment: "staging" }]);
      const body = posts(VERIFY)[0].body!;
      assert.deepEqual(body.actor_identity, assertionFor(action_type, "staging"));
      assert.equal(body.actor_id, "agent:a1");
      assert.equal(result.notes, undefined);
    });
  }

  it("an ordinary action mints nothing and sends no identity", async () => {
    runtime();
    await verify("pt.v4.tok", { action_type: "invoice.approve", actor_id: "u:1", environment: "production" });
    assert.equal(posts(MINT).length, 0);
    assert.equal("actor_identity" in posts(VERIFY)[0].body!, false);
  });

  for (const [label, reply] of [
    ["a refused mint (403)", { status: 403, body: { error: "agent_binding_required" } }],
    ["an older runtime (404)", { status: 404, body: { error: "not_found" } }],
    ["a malformed assertion", { status: 200, body: { assertion: { version: "actor_identity.v1" } } }],
  ] as const) {
    it(`${label}: the verify still goes out without an identity, with a note`, async () => {
      runtime(reply);
      const result = await verify("pt.v4.tok", {
        action_type: "production.deploy",
        actor_id: "svc:deployer",
        environment: "production",
      });
      assert.equal(posts(VERIFY).length, 1);
      assert.equal("actor_identity" in posts(VERIFY)[0].body!, false);
      assert.equal(result.notes?.length, 1);
      assert.match(result.notes![0], /No actor identity was presented at verify/);
    });
  }
});
