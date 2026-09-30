/**
 * AI Action Protection reference scenario, offline (atlasent-docs CROSS-064).
 *
 * Drives the REAL MCP tool `atlasent_governed_file_change` through the REAL
 * engine (identity mint, provenance seal, evaluate, approvals, claim, verify)
 * against two in-memory fakes reached through `fetch`:
 *   - a runtime that mints, seals, decides by a scripted org policy, issues
 *     single-use permits bound to (actor, target, environment, hash), and
 *     refuses at verify when the agent has been stopped;
 *   - a GitHub repository with real contents-API semantics (blob shas,
 *     optimistic base-sha writes, reads by ref and by commit).
 *
 * What this proves: the executor composes the runtime's answers fail-closed,
 * and nothing reaches the repository without a permit verified at the
 * boundary for exactly that change. What it does NOT prove: the runtime's own
 * semantics. Those are proven against the live runtime by
 * scripts/acceptance/ai-action-reference/run.mjs.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { authorize, awaitApproval, getMode, verify } from "./engine.js";
import { registerAiActionTools, GOVERNED_FILE_CHANGE_TOOL, aiActionConfigFromEnv } from "./aiActionTools.js";
import {
  CircuitBreaker,
  actionDigest,
  canonicalJson,
  executeGoverned,
  requestAuthorization,
  sealedActionHash,
  sha256Hex,
  type ExecutionAdapter,
  type GovernedActionSpec,
} from "./governedAction.js";
import { githubFileChangeSpec } from "./githubFileAdapter.js";
import type { AllowDecision } from "./decision.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const AGENT = "agent:11111111-1111-4111-8111-111111111111";
const OWNER = "AtlaSent-Reference", REPO = "pilot-deploy-gate", BRANCH = "ai-action-reference";
const PATH = "config/feature-flags.json";
const TARGET = `github:${OWNER}/${REPO}@${BRANCH}:${PATH}`;

// ---------------------------------------------------------------------------
// Fake GitHub (contents API)
// ---------------------------------------------------------------------------
interface Repo {
  head: Map<string, { sha: string; content: string }>;
  commits: Map<string, Map<string, { sha: string; content: string }>>;
  puts: number;
  failNextPut?: number;
  lieOnRead?: boolean;
}
function newRepo(initial: Record<string, string>): Repo {
  const head = new Map<string, { sha: string; content: string }>();
  for (const [p, c] of Object.entries(initial)) head.set(p, { sha: sha("blob" + c).slice(0, 40), content: c });
  return { head, commits: new Map(), puts: 0 };
}
function githubRoute(repo: Repo, url: URL, init?: RequestInit): Response | null {
  if (url.host !== "api.github.com") return null;
  const m = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(url.pathname);
  if (!m) return new Response("{}", { status: 404 });
  const path = decodeURIComponent(m[1]);
  if ((init?.method ?? "GET") === "GET") {
    const ref = url.searchParams.get("ref") ?? BRANCH;
    const tree = ref === BRANCH ? repo.head : repo.commits.get(ref);
    const f = tree?.get(path);
    if (!f) return new Response("{}", { status: 404 });
    const content = repo.lieOnRead ? "stale" : f.content;
    return Response.json({ type: "file", sha: f.sha, encoding: "base64", content: Buffer.from(content).toString("base64") });
  }
  // PUT
  if (repo.failNextPut) {
    const s = repo.failNextPut; repo.failNextPut = undefined;
    return new Response("upstream error", { status: s });
  }
  const body = JSON.parse(String(init!.body)) as { content: string; sha?: string; branch: string };
  const cur = repo.head.get(path);
  if ((cur?.sha ?? undefined) !== body.sha) return new Response(JSON.stringify({ message: "sha does not match" }), { status: 409 });
  const content = Buffer.from(body.content, "base64").toString("utf8");
  const blob = sha("blob" + content).slice(0, 40);
  repo.head.set(path, { sha: blob, content });
  repo.puts++;
  const commit = sha(`commit${repo.puts}${content}`).slice(0, 40);
  repo.commits.set(commit, new Map(repo.head));
  return Response.json({ commit: { sha: commit, html_url: `https://github.com/x/commit/${commit}` }, content: { sha: blob } });
}

// ---------------------------------------------------------------------------
// Fake runtime
// ---------------------------------------------------------------------------
type Policy = "allow" | "hold";
interface Permit { actor: string; target: string; environment: string; hash: string; used: boolean }
interface Runtime {
  policy: Policy;
  agentBound: boolean;
  agentActive: boolean;
  seals: Array<Record<string, unknown>>;
  evaluations: Array<Record<string, unknown>>;
  permits: Map<string, Permit>;
  approvals: Map<string, { status: string; binding: Omit<Permit, "used">; claimed: boolean }>;
  verifies: Array<Record<string, unknown>>;
  n: number;
}
function newRuntime(policy: Policy): Runtime {
  return { policy, agentBound: true, agentActive: true, seals: [], evaluations: [], permits: new Map(), approvals: new Map(), verifies: [], n: 0 };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Same algorithm as atlasent-api computeSourceProvenanceActionHash. */
const sealHash = (b: Record<string, any>) => sha(canonicalJson({
  version: "source_provenance_action.v1", tenant_id: "org-1", actor_id: AGENT, action_type: b.action_type,
  environment: b.context.environment, resource_id: b.resource_id ?? null, context: b.context,
}));

function runtimeRoute(rt: Runtime, url: URL, init?: RequestInit): Response | null {
  if (url.host !== "runtime.test") return null;
  const p = url.pathname.replace("/functions/v1", "");
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  if (p === "/v1-agent-actor-identity") {
    if (!rt.agentBound) return json(403, { error: "key_not_agent_bound" });
    if (!rt.agentActive) return json(403, { error: "agent_not_active" });
    return json(200, { assertion: { version: "actor_identity.v1", subject: { principal_id: AGENT, principal_kind: "agent", role: "agent" }, binding: { action_type: body.action_type, tenant_id: "org-1", environment: body.environment }, signature: "sig" } });
  }
  if (p === "/v1-source-provenance-seal") {
    if (!rt.agentBound) return json(403, { error: "agent_binding_required" });
    rt.seals.push(body);
    return json(200, { source_provenance: { version: "source_provenance.v1", signature: "s" }, action_hash: sealHash(body) });
  }
  if (p === "/v1-evaluate") {
    rt.evaluations.push(body);
    const id = body.actor_identity as { subject?: { principal_id?: string } } | undefined;
    if (!id || id.subject?.principal_id !== body.actor_id) {
      return json(200, { decision: "deny", deny_code: "ACTOR_UNVERIFIED", deny_reason: "verified agent identity required", request_id: `ev-${++rt.n}` });
    }
    if (!body.source_provenance) return json(200, { decision: "deny", deny_code: "ASSERTION_UNVERIFIED", deny_reason: "sealed provenance required" });
    const sealed = rt.seals.find((s) => s.request_id === body.request_id);
    if (!sealed || canonicalJson(sealed.context) !== canonicalJson(body.context) || sealed.resource_id !== body.resource_id) {
      return json(200, { decision: "deny", deny_code: "ASSERTION_UNVERIFIED", deny_reason: "provenance does not match this request" });
    }
    const hash = sealHash(sealed);
    const binding = { actor: String(body.actor_id), target: String(body.resource_id), environment: String((body.context as Record<string, unknown>).environment), hash };
    const request_id = `ev-${++rt.n}`;
    if (rt.policy === "hold") {
      const aid = `apr-${rt.n}`;
      rt.approvals.set(aid, { status: "pending", binding, claimed: false });
      return json(200, { decision: "escalate", approval_request_id: aid, deny_reason: "human approval required", request_id, source_provenance: {} });
    }
    const token = `pt.v4.${rt.n}`;
    rt.permits.set(token, { ...binding, used: false });
    return json(200, { decision: "allow", permit_token: token, request_id, source_provenance: {} });
  }
  const ap = /^\/v1-approvals\/([^/]+)(\/claim-permit)?$/.exec(p);
  if (ap) {
    const a = rt.approvals.get(ap[1]);
    if (!a) return json(404, { error: "not_found" });
    if (!ap[2]) return json(200, { id: ap[1], status: a.status, action_type: "agent.tool.invoke", environment: a.binding.environment });
    if (a.claimed) return json(409, { error: "already_claimed" });
    if (a.status !== "approved_awaiting_claim") return json(409, { error: "not_approved" });
    if (!rt.agentActive) return json(403, { error: "agent_not_active" });
    a.claimed = true;
    const token = `pt.v4.claim.${ap[1]}`;
    rt.permits.set(token, { ...a.binding, used: false });
    return json(200, { claimed: true, permit_token: token });
  }
  if (p === "/v1-verify-permit") {
    rt.verifies.push(body);
    const permit = rt.permits.get(String(body.permit_token));
    const deny = (code: string) => json(200, { valid: false, outcome: "deny", verify_error_code: code });
    if (!permit) return deny("PERMIT_NOT_FOUND");
    if (permit.used) return deny("PERMIT_ALREADY_USED");
    if (!rt.agentActive) return deny("AUTHORIZATION_STATE_CHANGED");
    if (body.actor_id !== permit.actor) return deny("ACTOR_MISMATCH");
    if (body.target_id !== permit.target) return deny("PERMIT_BINDING_MISMATCH");
    if (body.environment !== permit.environment) return deny("ENVIRONMENT_MISMATCH");
    if (body.payload_hash !== permit.hash) return deny("PAYLOAD_MISMATCH");
    permit.used = true;
    return json(200, { valid: true, outcome: "allow" });
  }
  return json(500, { error: `unrouted ${p}` });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let originalFetch: typeof globalThis.fetch;
let repo: Repo;
let rt: Runtime;
let dir: string;
const ENV_KEYS = ["ATLASENT_MODE", "ATLASENT_API_KEY", "ATLASENT_BASE_URL", "ATLASENT_ENVIRONMENT", "ATLASENT_CIRCUIT_BREAKER_STOP"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ATLASENT_MODE = "remote";
  process.env.ATLASENT_API_KEY = "ask_test_agentbound";
  process.env.ATLASENT_BASE_URL = "https://runtime.test/functions/v1";
  process.env.ATLASENT_ENVIRONMENT = "staging";
  delete process.env.ATLASENT_CIRCUIT_BREAKER_STOP;
  repo = newRepo({ [PATH]: '{"checkout_v2":false}\n' });
  rt = newRuntime("hold");
  dir = mkdtempSync(join(tmpdir(), "ai-action-"));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    return githubRoute(repo, url, init) ?? runtimeRoute(rt, url, init) ?? new Response("{}", { status: 599 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  rmSync(dir, { recursive: true, force: true });
});

async function connect(extra: { stopFile?: string } = {}) {
  const server = new McpServer({ name: "t", version: "1" });
  const { breaker } = registerAiActionTools(server, {
    owner: OWNER, repo: REPO, branch: BRANCH, token: "ghs_test", pathPrefix: "config/",
    breakerFile: join(dir, "breaker.json"), ...(extra.stopFile && { stopFile: extra.stopFile }),
  }, () => true, { authorize, verify, getMode, awaitApproval });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(c), server.connect(s)]);
  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: GOVERNED_FILE_CHANGE_TOOL, arguments: args });
    return JSON.parse((r.content as Array<{ text: string }>)[0].text) as Record<string, any>;
  };
  return { call, breaker };
}

const NEW = '{"checkout_v2":true}\n';
const change = { path: PATH, content: NEW, message: "Enable checkout_v2 (AI agent)" };
const fileNow = () => repo.head.get(PATH)!.content;
const approve = (id: string) => { rt.approvals.get(id)!.status = "approved_awaiting_claim"; };

// ---------------------------------------------------------------------------
describe("AI Action Protection reference scenario (governed file change)", () => {
  it("an unknown / untrusted agent is refused and nothing changes", async () => {
    rt.agentBound = false;
    const { call } = await connect();
    const r = await call(change);
    assert.equal(r.outcome, "refused");
    assert.equal(r.deny_code, "ACTOR_UNVERIFIED");
    assert.equal(repo.puts, 0);
    assert.equal(fileNow(), '{"checkout_v2":false}\n');
  });

  it("missing organizational approval holds the action; it does not execute while pending", async () => {
    const { call } = await connect();
    const r = await call(change);
    assert.equal(r.outcome, "held");
    assert.match(r.approval_request_id, /^apr-/);
    assert.equal(r.target_id, TARGET);
    const again = await call({ ...change, approval_request_id: r.approval_request_id, max_wait_seconds: 0 });
    assert.equal(again.outcome, "held");
    assert.equal(repo.puts, 0);
    assert.equal(rt.verifies.length, 0, "no permit exists, so nothing is verified");
  });

  it("the sealed context binds the exact change (action_digest) and the real target", async () => {
    const { call } = await connect();
    await call(change);
    const seal = rt.seals[0] as { context: Record<string, unknown>; resource_id: string };
    const spec = githubFileChangeSpec({ owner: OWNER, repo: REPO, branch: BRANCH, ...change }, `blob:${repo.head.get(PATH)!.sha}`, "staging");
    assert.equal(seal.context.action_digest, actionDigest(spec));
    assert.equal(seal.resource_id, TARGET);
    assert.equal(seal.context.tool, "github.contents.put");
  });

  it("a changed action cannot use the approval of the original", async () => {
    const { call } = await connect();
    const r = await call(change);
    approve(r.approval_request_id);
    const changed = await call({ ...change, content: '{"checkout_v2":true,"admin":true}\n', approval_request_id: r.approval_request_id });
    assert.equal(changed.outcome, "refused");
    assert.match(changed.reason, /differs from the one that was approved/);
    assert.equal(rt.approvals.get(r.approval_request_id)!.claimed, false, "the approval is not spent on a mismatch");
    assert.equal(repo.puts, 0);
  });

  it("a changed action presented at verify fails PAYLOAD_MISMATCH and does not execute", async () => {
    rt.policy = "allow";
    const base = `blob:${repo.head.get(PATH)!.sha}`;
    const spec = githubFileChangeSpec({ owner: OWNER, repo: REPO, branch: BRANCH, ...change }, base, "staging");
    const d = await requestAuthorization(spec, "x", { authorize, verify, getMode });
    assert.equal(d.decision.decision, "allow");
    const allow = d.decision as AllowDecision;
    assert.ok(allow.sealed_binding, "admitted provenance reports what was sealed");
    assert.equal(sealedActionHash(allow.sealed_binding!, spec), allow.bound_payload_hash, "reconstruction matches the runtime's seal");
    const altered: GovernedActionSpec = { ...spec, arguments: { ...spec.arguments, content_sha256: sha256Hex("something else") } };
    const adapter = memAdapter(base);
    const proof = await executeGoverned({
      spec: altered, actorId: allow.bound_actor_id!, permitToken: allow.permit_token, sealedBinding: allow.sealed_binding,
      decision: allow, adapter, breaker: new CircuitBreaker(), verify,
    });
    assert.equal(proof.outcome, "refused_verify");
    assert.equal(proof.permit.verify_error_code, "PAYLOAD_MISMATCH");
    assert.equal(adapter.executed, 0);
  });

  it("the exact approved action executes once, the effect is established, and proof names agent + action + decision + execution + effect", async () => {
    const { call } = await connect();
    const r = await call(change);
    approve(r.approval_request_id);
    const done = await call({ ...change, approval_request_id: r.approval_request_id });
    assert.equal(done.outcome, "executed", JSON.stringify(done));
    assert.equal(repo.puts, 1);
    assert.equal(fileNow(), NEW);
    const proof = done.proof;
    assert.equal(proof.version, "ai_action_proof.v1");
    assert.equal(proof.agent.actor_id, AGENT);
    assert.equal(proof.action.action_type, "agent.tool.invoke");
    assert.equal(proof.action.target_id, TARGET);
    assert.equal(proof.decision.approval_request_id, r.approval_request_id);
    assert.equal(proof.decision.binding, "sealed_provenance");
    assert.equal(proof.permit.verified, true);
    assert.match(proof.execution.receipt.commit_sha, /^[0-9a-f]{40}$/);
    assert.equal(proof.effect.established, true);
    assert.equal(proof.effect.expected, `sha256:${sha(NEW)}`);
    const { proof_sha256, ...rest } = proof;
    assert.equal(proof_sha256, sha256Hex(canonicalJson(rest)), "proof digest covers the whole record");
    // Verify presented exactly the binding the permit carries.
    const v = rt.verifies.at(-1)!;
    assert.equal(v.actor_id, AGENT);
    assert.equal(v.target_id, TARGET);
  });

  it("replay: an executed approval cannot be run again", async () => {
    const { call } = await connect();
    const r = await call(change);
    approve(r.approval_request_id);
    const first = await call({ ...change, approval_request_id: r.approval_request_id });
    assert.equal(first.outcome, "executed");
    const second = await call({ ...change, approval_request_id: r.approval_request_id });
    assert.equal(second.outcome, "refused");
    assert.equal(repo.puts, 1);
  });

  it("replay: a consumed permit does not verify again and nothing executes twice", async () => {
    rt.policy = "allow";
    const base = `blob:${repo.head.get(PATH)!.sha}`;
    const spec = githubFileChangeSpec({ owner: OWNER, repo: REPO, branch: BRANCH, ...change }, base, "staging");
    const allow = (await requestAuthorization(spec, "x", { authorize, verify, getMode })).decision as AllowDecision;
    const adapter = memAdapter(base);
    const run = () => executeGoverned({
      spec, actorId: allow.bound_actor_id!, permitToken: allow.permit_token, sealedBinding: allow.sealed_binding,
      decision: allow, adapter, breaker: new CircuitBreaker(), verify,
    });
    assert.equal((await run()).outcome, "executed");
    const replay = await run();
    assert.equal(replay.outcome, "refused_verify");
    assert.equal(replay.permit.verify_error_code, "PERMIT_ALREADY_USED");
    assert.equal(adapter.executed, 1);
  });

  it("local mode never changes a real system", async () => {
    process.env.ATLASENT_MODE = "local";
    const { call } = await connect();
    const r = await call(change);
    assert.equal(r.outcome, "refused");
    assert.equal(r.deny_code, "RUNTIME_REQUIRED");
    assert.equal(repo.puts, 0);
  });

  it("paths outside the configured prefix are refused before any runtime call", async () => {
    const { call } = await connect();
    const r = await call({ ...change, path: ".github/workflows/deploy.yml" });
    assert.equal(r.outcome, "refused");
    assert.equal(rt.evaluations.length, 0);
  });
});

describe("Circuit breaker (CROSS-064)", () => {
  it("B1: agent stopped after approval -> the runtime refuses the permit at verify; nothing executes", async () => {
    rt.policy = "allow";
    const { call } = await connect();
    const origVerifyRoute = rt;
    // Stop the agent between evaluate and verify: flip it when the first write is about to be verified.
    const f = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/v1-verify-permit")) origVerifyRoute.agentActive = false;
      return f(input, init);
    }) as typeof fetch;
    const r = await call(change);
    assert.equal(r.outcome, "refused_verify");
    assert.equal(r.proof.permit.verify_error_code, "AUTHORIZATION_STATE_CHANGED");
    assert.equal(repo.puts, 0);
  });

  it("E1: target changed after authorization -> refused before verify, permit not spent", async () => {
    const { call } = await connect();
    const r = await call(change);
    approve(r.approval_request_id);
    repo.head.set(PATH, { sha: "f".repeat(40), content: "someone else changed it\n" });
    const done = await call({ ...change, approval_request_id: r.approval_request_id });
    assert.equal(done.outcome, "refused_target_changed");
    assert.equal(done.proof.permit.verified, false);
    assert.equal(rt.verifies.length, 0, "the permit was not spent");
    assert.equal(repo.puts, 0);
  });

  it("E2: execution outcome unknown -> breaker trips; the agent's next action is refused before verify", async () => {
    rt.policy = "allow";
    const { call, breaker } = await connect();
    repo.failNextPut = 502;
    const r = await call(change);
    assert.equal(r.outcome, "outcome_unknown");
    assert.ok(breaker.list().some((t) => t.scope === `agent:${AGENT}` && t.reason === "execution_outcome_unknown"));
    const verifiesBefore = rt.verifies.length;
    const next = await call({ ...change, path: "config/other.json", content: "{}\n" });
    assert.equal(next.outcome, "refused_circuit_open");
    assert.equal(rt.verifies.length, verifiesBefore, "a stopped agent does not spend permits");
  });

  it("E3: effect not established -> outcome effect_not_established and breaker trips", async () => {
    rt.policy = "allow";
    const { call, breaker } = await connect();
    const orig = globalThis.fetch;
    let wrote = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await orig(input, init);
      if (init?.method === "PUT") { wrote = true; repo.lieOnRead = true; }
      return res;
    }) as typeof fetch;
    const r = await call(change);
    assert.ok(wrote);
    assert.equal(r.outcome, "effect_not_established");
    assert.equal(r.proof.effect.established, false);
    assert.ok(breaker.list().some((t) => t.reason === "effect_not_established"));
  });

  it("E4: operator stop file -> refused before verify", async () => {
    rt.policy = "allow";
    const stop = join(dir, "STOP");
    writeFileSync(stop, "incident 42");
    const { call } = await connect({ stopFile: stop });
    const r = await call(change);
    assert.equal(r.outcome, "refused_circuit_open");
    assert.equal(rt.verifies.length, 0);
    assert.equal(repo.puts, 0);
  });

  it("trips persist across restarts and only a named person can reset them", () => {
    const file = join(dir, "b.json");
    const a = new CircuitBreaker({ stateFile: file });
    a.trip(["agent:x"], "effect_not_established", "boom");
    const b = new CircuitBreaker({ stateFile: file });
    assert.ok(b.check(["agent:x"]));
    assert.throws(() => b.reset("agent:x", " "));
    assert.equal(b.reset("agent:x", "betty"), true);
    assert.equal(new CircuitBreaker({ stateFile: file }).check(["agent:x"]), null);
  });

  it("no MCP tool can reset the breaker", async () => {
    const { call: _ } = await connect();
    const server = new McpServer({ name: "t", version: "1" });
    registerAiActionTools(server, { owner: OWNER, repo: REPO, branch: BRANCH, token: "t" }, () => true);
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c), server.connect(s)]);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), [GOVERNED_FILE_CHANGE_TOOL]);
  });
});

describe("configuration", () => {
  it("is not registered unless repo, branch and a dedicated token are all set", () => {
    assert.equal(aiActionConfigFromEnv({}), null);
    assert.equal(aiActionConfigFromEnv({ ATLASENT_AI_ACTION_GITHUB_REPO: "a/b", ATLASENT_AI_ACTION_GITHUB_BRANCH: "x", GITHUB_TOKEN: "t" }), null);
    assert.equal(aiActionConfigFromEnv({ ATLASENT_AI_ACTION_GITHUB_REPO: "not a repo", ATLASENT_AI_ACTION_GITHUB_BRANCH: "x", ATLASENT_AI_ACTION_GITHUB_TOKEN: "t" }), null);
    assert.deepEqual(aiActionConfigFromEnv({ ATLASENT_AI_ACTION_GITHUB_REPO: "a/b", ATLASENT_AI_ACTION_GITHUB_BRANCH: "x", ATLASENT_AI_ACTION_GITHUB_TOKEN: "t" }), { owner: "a", repo: "b", branch: "x", token: "t" });
  });
});

/** An adapter that records executions and never touches a network. */
function memAdapter(base = "absent"): ExecutionAdapter & { executed: number } {
  return {
    system: "mem",
    executed: 0,
    readState: async () => ({ digest: base }),
    authorizedBaseState: (s) => String(s.arguments.base_state),
    async execute() { this.executed++; return { ok: true }; },
    observeEffect: async () => ({ established: true, expected: "x", observed: "x" }),
  };
}
