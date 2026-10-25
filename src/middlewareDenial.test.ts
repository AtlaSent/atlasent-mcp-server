// Issue #263: an OpenShell workload-guard refusal (403 middleware_denied) must
// not be reported as "your key lacks the required scope". Wording only: the
// outcome, exit code and fail-closed behaviour are unchanged.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { authorize } from "./engine.js";
import { OpenShellAuthorityAdapter } from "./openshell.js";
import { EXIT, runGoverned } from "./openshellRun.js";
import { evaluateBatch, V2HttpError } from "./v2Client.js";
import { middlewareDenialMessage, parseMiddlewareDenial } from "./middlewareDenial.js";

const SCOPE_MSG = "Permission denied — your key lacks the required scope";
const GUARD_BODY = JSON.stringify({ error: "middleware_denied", reason_code: "workload_mismatch" });
// What OpenShell 0.1.5 returns when the guard is down, times out or answers
// invalidly under on_error = "fail_closed" (relay.rs at v0.1.5).
const FAILED_BODY = JSON.stringify({
  error: "middleware_failed",
  detail: "Request could not be processed by configured middleware",
});
const SANDBOX = { sandbox_id: "sbx_01J9ZK", sandbox_name: "payments-agent", workspace: "team-a", policy_generation: 3 };
const ENVELOPE = { action_type: "data.export", actor_id: "agent:42", environment: "production", target_id: "warehouse" };

describe("parseMiddlewareDenial", () => {
  it("matches OpenShell's canonical denial and keeps a valid reason_code", () => {
    assert.deepEqual(parseMiddlewareDenial(403, GUARD_BODY), { reason_code: "workload_mismatch" });
    assert.deepEqual(parseMiddlewareDenial(403, JSON.stringify({ error: "middleware_denied" })), { reason_code: null });
  });

  it("drops a reason_code not in OpenShell's format rather than echoing it", () => {
    for (const bad of ["Workload_Mismatch", "1abc", "a".repeat(65), "x y", 7]) {
      assert.deepEqual(parseMiddlewareDenial(403, JSON.stringify({ error: "middleware_denied", reason_code: bad })), { reason_code: null });
    }
  });

  it("does not match other 403s, other statuses, or loose mentions", () => {
    assert.equal(parseMiddlewareDenial(403, JSON.stringify({ error: "insufficient_scope", message: "Missing permission: evaluate:write" })), null);
    assert.equal(parseMiddlewareDenial(403, "middleware_denied"), null);
    assert.equal(parseMiddlewareDenial(403, JSON.stringify({ message: "middleware_denied" })), null);
    assert.equal(parseMiddlewareDenial(403, JSON.stringify(["middleware_denied"])), null);
    assert.equal(parseMiddlewareDenial(403, ""), null);
    assert.equal(parseMiddlewareDenial(401, GUARD_BODY), null);
    assert.equal(parseMiddlewareDenial(500, GUARD_BODY), null);
  });

  it("matches OpenShell's middleware_failed (guard down / timeout) as a failure, not a denial (#279)", () => {
    assert.deepEqual(parseMiddlewareDenial(403, FAILED_BODY), { reason_code: null, failed: true });
    assert.equal(parseMiddlewareDenial(502, FAILED_BODY), null);
    assert.equal(parseMiddlewareDenial(403, JSON.stringify({ error: "middleware_failure" })), null);
    const m = middlewareDenialMessage({ reason_code: null, failed: true });
    assert.match(m, /middleware_failed/);
    assert.match(m, /could not complete its check/);
    assert.match(m, /Nothing was authorized/);
    assert.doesNotMatch(m, /lacks the required scope/);
    // A denial is still worded as a denial.
    assert.doesNotMatch(middlewareDenialMessage({ reason_code: null }), /middleware_failed/);
  });

  it("message gives the code, does not blame key scopes, and does not claim which middleware refused", () => {
    const m = middlewareDenialMessage({ reason_code: "workload_mismatch" });
    assert.match(m, /supervisor middleware/);
    assert.match(m, /workload_mismatch/);
    assert.match(m, /different sandbox/);
    assert.match(m, /does not say which middleware refused/);
    assert.doesNotMatch(m, /^Refused by the OpenShell workload guard/);
    assert.doesNotMatch(m, /lacks the required scope/);
    // No code, or a code the guard does not use: generic, and no workload-guard attribution at all.
    for (const d of [{ reason_code: null }, { reason_code: "rate_limited" }]) {
      const g = middlewareDenialMessage(d);
      assert.match(g, /supervisor middleware/);
      assert.doesNotMatch(g, /workload guard/);
    }
    assert.match(middlewareDenialMessage({ reason_code: null }), /no reason_code/);
  });
});

describe("403 wording through the remote engine and the openshell run CLI", () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  let respond: () => Response;
  beforeEach(() => {
    process.env.ATLASENT_MODE = "remote";
    process.env.ATLASENT_API_KEY = "ask_test_dummy";
    process.env.ATLASENT_BASE_URL = "https://example.invalid/functions/v1";
    globalThis.fetch = (async () => respond()) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env = { ...saved };
  });

  async function run() {
    let spawned = 0;
    const r = await runGoverned(
      {
        adapter: new OpenShellAuthorityAdapter(),
        sandbox: () => SANDBOX as unknown,
        spawn: async () => {
          spawned++;
          return { started: true as const, code: 0, signal: null, timed_out: false };
        },
        reportTrip: async () => ({ recorded: true, trip_id: "t" }),
      },
      { envelope: ENVELOPE, argv: ["deploy.sh"] },
    );
    return { r, spawned };
  }

  it("workload-guard 403 → guard wording, same DENY / exit code, nothing executes", async () => {
    respond = () => new Response(GUARD_BODY, { status: 403 });
    const { r, spawned } = await run();
    assert.equal(r.outcome, "DENY");
    assert.equal(r.exit_code, EXIT.DENY);
    assert.equal(spawned, 0);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0], /supervisor middleware/);
    assert.match(r.reasons[0], /workload_mismatch/);
    assert.doesNotMatch(r.reasons[0], /lacks the required scope/);
  });

  it("guard unavailable (403 middleware_failed) → DENY, no permit, nothing executes, not scope wording (#279)", async () => {
    respond = () => new Response(FAILED_BODY, { status: 403 });
    const { r, spawned } = await run();
    assert.equal(r.outcome, "DENY");
    assert.equal(r.exit_code, EXIT.DENY);
    assert.equal(spawned, 0);
    assert.match(r.reasons[0], /middleware_failed/);
    assert.doesNotMatch(r.reasons[0], /lacks the required scope/);
    const d = await authorize({ action_type: "data.export", actor_id: "agent:42", environment: "production" });
    assert.equal(d.decision, "deny");
    assert.equal(d.permit_token, undefined);
  });

  it("guard transport error or timeout before any response → DENY, nothing executes (#279)", async () => {
    for (const err of [new TypeError("fetch failed"), Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })]) {
      respond = () => {
        throw err;
      };
      const { r, spawned } = await run();
      assert.equal(r.outcome, "DENY");
      assert.equal(r.exit_code, EXIT.DENY);
      assert.equal(spawned, 0);
    }
  });

  it("plain scope 403 keeps today's wording, same DENY / exit code", async () => {
    respond = () => new Response(JSON.stringify({ error: "forbidden", message: "Missing permission: evaluate:write" }), { status: 403 });
    const { r, spawned } = await run();
    assert.equal(r.outcome, "DENY");
    assert.equal(r.exit_code, EXIT.DENY);
    assert.equal(spawned, 0);
    assert.deepEqual(r.reasons, [SCOPE_MSG]);
  });

  it("authorize() still fails closed to deny on a guard 403", async () => {
    respond = () => new Response(GUARD_BODY, { status: 403 });
    const d = await authorize({ action_type: "data.export", actor_id: "agent:42", environment: "production" });
    assert.equal(d.decision, "deny");
    assert.equal(d.permit_token, undefined);
  });

  it("v2 client: guard 403 is still a V2HttpError(403), with guard wording; scope 403 unchanged", async () => {
    respond = () => new Response(GUARD_BODY, { status: 403 });
    await assert.rejects(
      evaluateBatch({ items: [{ action_type: "data.export", actor_id: "agent:42", context: {} }] } as never),
      (e: unknown) => e instanceof V2HttpError && e.status === 403 && /workload_mismatch/.test(e.message) && !/lacks the required scope/.test(e.message),
    );
    respond = () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    await assert.rejects(
      evaluateBatch({ items: [{ action_type: "data.export", actor_id: "agent:42", context: {} }] } as never),
      (e: unknown) => e instanceof V2HttpError && e.status === 403 && e.message === SCOPE_MSG,
    );
  });
});
