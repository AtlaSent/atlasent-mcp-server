/**
 * SIMULATED backends for `npm run demo:hitl -- --simulate`.
 *
 * An in-memory AtlaSent runtime and an in-memory GitHub repository, reached
 * through a replaced `globalThis.fetch`. They exist so the demo can be
 * rehearsed offline and so its fail-closed stages can be tested. They prove
 * nothing about the real runtime. Every line the demo prints in this mode is
 * prefixed [SIMULATED].
 *
 * Same shapes as the fakes in src/governedAction.test.ts (identity mint,
 * provenance seal, evaluate -> escalate + approval, claim, single-use permits
 * bound to actor/target/environment/hash, GitHub contents API with optimistic
 * base-sha writes).
 */
import { createHash } from "node:crypto";

export const SIM_RUNTIME_HOST = "runtime.simulated.invalid";
export const SIM_BASE_URL = `https://${SIM_RUNTIME_HOST}/functions/v1`;
const AGENT = "agent:00000000-0000-4000-8000-000000000001";
const TENANT = "org-simulated";

const sha = (s) => createHash("sha256").update(s).digest("hex");
function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * @param {{ owner: string, repo: string, branch: string }} target
 * @param {{ policy?: "hold" | "allow", decide?: "approve" | "reject" | "never" }} [opts]
 */
export function createSimulatedBackends(target, opts = {}) {
  const state = {
    policy: opts.policy ?? "hold",
    decide: opts.decide ?? "approve",
    /** test knob: GitHub reads after a write return stale bytes */
    lieOnRead: false,
    head: new Map(),
    commits: new Map(),
    puts: 0,
    seals: [],
    permits: new Map(),
    approvals: new Map(),
    verifies: [],
    n: 0,
  };
  const sealHash = (b) => sha(canonicalJson({
    version: "source_provenance_action.v1", tenant_id: TENANT, actor_id: AGENT, action_type: b.action_type,
    environment: b.context.environment, resource_id: b.resource_id ?? null, context: b.context,
  }));

  function github(url, init) {
    if (url.host !== "api.github.com") return null;
    const m = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(url.pathname);
    if (!m) return json(404, {});
    const path = decodeURIComponent(m[1]);
    if ((init?.method ?? "GET") === "GET") {
      const ref = url.searchParams.get("ref") ?? target.branch;
      const tree = ref === target.branch ? state.head : state.commits.get(ref);
      const f = tree?.get(path);
      if (!f) return json(404, {});
      const content = state.lieOnRead && state.puts > 0 ? "stale\n" : f.content;
      return json(200, { type: "file", sha: f.sha, encoding: "base64", content: Buffer.from(content).toString("base64") });
    }
    const body = JSON.parse(String(init.body));
    const cur = state.head.get(path);
    if ((cur?.sha ?? undefined) !== body.sha) return json(409, { message: "sha does not match" });
    const content = Buffer.from(body.content, "base64").toString("utf8");
    const blob = sha("blob" + content).slice(0, 40);
    state.head.set(path, { sha: blob, content });
    state.puts++;
    const commit = sha(`commit${state.puts}${content}`).slice(0, 40);
    state.commits.set(commit, new Map(state.head));
    return json(201, { commit: { sha: commit, html_url: `https://simulated.invalid/commit/${commit}` }, content: { sha: blob } });
  }

  function runtime(url, init) {
    if (url.host !== SIM_RUNTIME_HOST) return null;
    const p = url.pathname.replace("/functions/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (p === "/v1-agent-actor-identity") {
      return json(200, { assertion: { version: "actor_identity.v1", subject: { principal_id: AGENT, principal_kind: "agent", role: "agent" }, binding: { action_type: body.action_type, tenant_id: TENANT, environment: body.environment }, signature: "simulated" } });
    }
    if (p === "/v1-source-provenance-seal") {
      state.seals.push(body);
      return json(200, { source_provenance: { version: "source_provenance.v1", signature: "simulated" }, action_hash: sealHash(body) });
    }
    if (p === "/v1-evaluate") {
      const sealed = state.seals.find((s) => s.request_id === body.request_id);
      if (!body.actor_identity || body.actor_identity.subject?.principal_id !== body.actor_id) {
        return json(200, { decision: "deny", deny_code: "ACTOR_UNVERIFIED", deny_reason: "verified agent identity required" });
      }
      if (!sealed || canonicalJson(sealed.context) !== canonicalJson(body.context)) {
        return json(200, { decision: "deny", deny_code: "ASSERTION_UNVERIFIED", deny_reason: "sealed provenance required" });
      }
      const binding = { actor: body.actor_id, target: body.resource_id, environment: body.context.environment, hash: sealHash(sealed) };
      const request_id = `sim-eval-${++state.n}`;
      if (state.policy === "hold") {
        const id = `sim-apr-${state.n}`;
        state.approvals.set(id, { status: "pending", binding, claimed: false });
        return json(200, { decision: "escalate", approval_request_id: id, deny_reason: "human approval required (simulated policy)", request_id, source_provenance: {} });
      }
      const token = `pt.simulated.${state.n}`;
      state.permits.set(token, { ...binding, used: false });
      return json(200, { decision: "allow", permit_token: token, request_id, source_provenance: {} });
    }
    const ap = /^\/v1-approvals\/([^/]+)(\/claim-permit)?$/.exec(p);
    if (ap) {
      const a = state.approvals.get(decodeURIComponent(ap[1]));
      if (!a) return json(404, { error: "not_found" });
      if (!ap[2]) return json(200, { id: ap[1], status: a.status, action_type: "agent.tool.invoke", environment: a.binding.environment });
      if (a.claimed || a.status !== "approved_awaiting_claim") return json(409, { error: "not_claimable" });
      a.claimed = true;
      const token = `pt.simulated.claim.${ap[1]}`;
      state.permits.set(token, { ...a.binding, used: false });
      return json(200, { claimed: true, permit_token: token });
    }
    if (p === "/v1-agent-circuit-trips") return json(404, { error: "not_found" });
    if (p === "/v1-verify-permit") {
      state.verifies.push(body);
      const permit = state.permits.get(body.permit_token);
      const deny = (code) => json(200, { valid: false, outcome: "deny", verify_error_code: code });
      if (!permit) return deny("PERMIT_NOT_FOUND");
      if (permit.used) return deny("PERMIT_ALREADY_USED");
      if (body.actor_id !== permit.actor) return deny("ACTOR_MISMATCH");
      if (body.target_id !== permit.target) return deny("PERMIT_BINDING_MISMATCH");
      if (body.environment !== permit.environment) return deny("ENVIRONMENT_MISMATCH");
      if (body.payload_hash !== permit.hash) return deny("PAYLOAD_MISMATCH");
      permit.used = true;
      return json(200, { valid: true, outcome: "allow" });
    }
    return json(500, { error: `simulated runtime has no route ${p}` });
  }

  let original;
  return {
    state,
    baseUrl: SIM_BASE_URL,
    install() {
      original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const r = github(url, init) ?? runtime(url, init);
        if (!r) throw new Error(`SIMULATED mode refuses a real network call to ${url.host}`);
        return r;
      };
    },
    restore() { if (original) globalThis.fetch = original; },
    /** The simulated approver: the decision a person would make in the console. */
    decide(approvalRequestId) {
      const a = state.approvals.get(approvalRequestId);
      if (!a || state.decide === "never") return;
      a.status = state.decide === "approve" ? "approved_awaiting_claim" : "rejected";
    },
    headContent(path) {
      return state.head.get(path)?.content ?? null;
    },
  };
}
