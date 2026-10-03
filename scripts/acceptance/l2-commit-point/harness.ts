/**
 * L2 commit-point acceptance harness for Protection Catalog binding profile
 * BP-000009 ("MCP-compatible agent host tool-call gate", agent.tool.invoke).
 *
 * L2 = deterministic SIMULATED execution THROUGH THE BINDING'S OWN CODE PATH.
 * Everything between the agent and the provider is the shipped code:
 *
 *   MCP client --(InMemoryTransport)--> McpServer
 *     -> atlasent_governed_file_change      (src/aiActionTools.ts)
 *     -> requestAuthorization / authorize   (src/governedAction.ts, src/engine.ts:
 *                                            identity mint, provenance seal, evaluate)
 *     -> awaitApproval / claim              (src/engine.ts, HOLD path)
 *     -> executeGoverned                    (verify at the boundary, execute once,
 *                                            observe the effect, emit proof)
 *     -> githubFileAdapter                  (src/githubFileAdapter.ts)
 *
 * Two things are simulated, and only these two:
 *   - the AtlaSent runtime: a local HTTP server (real sockets, the engine's real
 *     fetch client, no global fetch patching) speaking the v1 wire: it mints an
 *     agent identity, seals provenance with the runtime's action-hash algorithm,
 *     decides by a scripted policy, issues HMAC-signed, expiring, single-use
 *     permits bound to (action_type, actor, target, environment, hash), and
 *     refuses at verify with the runtime's own error codes;
 *   - the provider: an in-process GitHub contents API behind the adapter's
 *     `fetchImpl` seam, counting every mutation call.
 *
 * What this proves: the binding presents the right material facts, verifies
 * immediately before the consequential effect, never reaches the provider
 * without a verified permit, and keeps execution/effect evidence separate from
 * authorization. What it does NOT prove: the real runtime's semantics, a real
 * provider, or any customer environment. That is L3+ and the G1-G5 gates.
 */
import { createHash, createHmac } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { authorize, awaitApproval, getMode, verify } from "../../../src/engine.js";
import { registerAiActionTools, GOVERNED_FILE_CHANGE_TOOL } from "../../../src/aiActionTools.js";
import {
  CircuitBreaker,
  actionDigest,
  canonicalJson,
  executeGoverned,
  requestAuthorization,
  sha256Hex,
  type AiActionProof,
  type ExecutionAdapter,
  type GovernedActionSpec,
} from "../../../src/governedAction.js";
import { githubFileAdapter, githubFileChangeSpec, type GithubFileChange } from "../../../src/githubFileAdapter.js";
import type { ActionContext, Decision, VerifyResult } from "../../../src/decision.js";

export const BINDING_PROFILE = "BP-000009";
export const ACTION_TYPE = "agent.tool.invoke";
export const AGENT = "agent:11111111-1111-4111-8111-111111111111";
const TENANT = "org-l2-sim";
const OWNER = "AtlaSent-Reference", REPO = "l2-simulated", BRANCH = "l2-commit-point";
const PATH = "config/feature-flags.json";
const OTHER_PATH = "config/other.json";
export const TARGET = `github:${OWNER}/${REPO}@${BRANCH}:${PATH}`;
const ENVIRONMENT = "staging";
const ORIGINAL = '{"checkout_v2":false}\n';
const NEW = '{"checkout_v2":true}\n';
const TAMPERED = '{"checkout_v2":true,"debug":true}\n';
const PERMIT_KEY = "l2-simulated-runtime-signing-key";
const PERMIT_TTL_S = 300;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// Ordered event log shared by the simulated runtime and provider
// ---------------------------------------------------------------------------
export interface Event { seq: number; kind: string; detail?: Record<string, unknown> }
class EventLog {
  events: Event[] = [];
  push(kind: string, detail?: Record<string, unknown>) { this.events.push({ seq: this.events.length + 1, kind, ...(detail && { detail }) }); }
  count(kind: string) { return this.events.filter((e) => e.kind === kind).length; }
}

// ---------------------------------------------------------------------------
// Simulated provider: GitHub contents API (blob shas, optimistic base-sha writes)
// ---------------------------------------------------------------------------
interface Blob { sha: string; content: string }
export class SimProvider {
  head = new Map<string, Blob>();
  commits = new Map<string, Map<string, Blob>>();
  mutations = 0;
  failNextWrite?: number;
  dropNextWrite = false;
  constructor(private log: EventLog, initial: Record<string, string>) {
    for (const [p, c] of Object.entries(initial)) this.head.set(p, { sha: sha("blob" + c).slice(0, 40), content: c });
  }
  content(path = PATH) { return this.head.get(path)?.content; }
  /**
   * Out-of-band change to provider state (another writer, a revert). Logged, so
   * the adjacency rule can see a state change between verify and mutation.
   */
  setContent(path: string, c: string) {
    this.log.push("provider.state_change", { path });
    this.head.set(path, { sha: sha("blob" + c).slice(0, 40), content: c });
  }
  readonly fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const m = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(url.pathname);
    if (url.host !== "api.github.com" || !m) return new Response("{}", { status: 404 });
    const path = decodeURIComponent(m[1]);
    const method = init?.method ?? "GET";
    if (method === "GET") {
      const ref = url.searchParams.get("ref") ?? BRANCH;
      this.log.push("provider.read", { path, ref });
      const f = (ref === BRANCH ? this.head : this.commits.get(ref))?.get(path);
      if (!f) return new Response("{}", { status: 404 });
      return Response.json({ type: "file", sha: f.sha, encoding: "base64", content: Buffer.from(f.content).toString("base64") });
    }
    // Every non-GET is a mutation attempt, counted whether or not it lands.
    this.mutations++;
    this.log.push("provider.mutation", { path, method });
    if (this.failNextWrite) {
      const s = this.failNextWrite; this.failNextWrite = undefined;
      return new Response("upstream error", { status: s });
    }
    const body = JSON.parse(String(init!.body)) as { content: string; sha?: string };
    const cur = this.head.get(path);
    if (cur?.sha !== body.sha) return new Response(JSON.stringify({ message: "sha does not match" }), { status: 409 });
    const content = Buffer.from(body.content, "base64").toString("utf8");
    const blob = sha("blob" + content).slice(0, 40);
    const commit = sha(`commit${this.mutations}${content}`).slice(0, 40);
    if (this.dropNextWrite) {
      // Provider acknowledges but the write does not land.
      this.dropNextWrite = false;
      return Response.json({ commit: { sha: commit }, content: { sha: blob } });
    }
    this.head.set(path, { sha: blob, content });
    this.commits.set(commit, new Map(this.head));
    return Response.json({ commit: { sha: commit }, content: { sha: blob } });
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Simulated runtime (real HTTP)
// ---------------------------------------------------------------------------
export type Policy = "allow" | "deny" | "hold";
interface Binding { action_type: string; actor: string; target: string; environment: string; hash: string }
interface PermitRow extends Binding { token: string; exp: number; used: boolean }

export interface RuntimeMutations {
  /** Mutant: verify does not consume the permit (replay becomes possible). */
  noConsume?: boolean;
  /** Counts each time the mutation actually took effect. */
  applied?: { count: number };
}

export class SimRuntime {
  policy: Policy = "allow";
  seals: Array<Record<string, unknown>> = [];
  evaluations: Array<Record<string, unknown>> = [];
  verifies: Array<Record<string, unknown>> = [];
  permits = new Map<string, PermitRow>();
  approvals = new Map<string, { status: string; binding: Binding; claimed: boolean }>();
  private n = 0;
  private server = createHttpServer((req, res) => void this.handle(req, res));
  baseUrl = "";
  constructor(private log: EventLog, private now: () => number, private mut: RuntimeMutations = {}) {}

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/functions/v1`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  approve(id: string) { const a = this.approvals.get(id); if (a) a.status = "approved_awaiting_claim"; }

  /** Same algorithm as atlasent-api computeSourceProvenanceActionHash. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON in a test/acceptance harness
  static sealHash(b: Record<string, any>): string {
    return sha(canonicalJson({
      version: "source_provenance_action.v1", tenant_id: TENANT, actor_id: AGENT, action_type: b.action_type,
      environment: b.context.environment, resource_id: b.resource_id ?? null, context: b.context,
    }));
  }

  private sign(row: Omit<PermitRow, "token" | "used">): string {
    const payload = Buffer.from(canonicalJson(row)).toString("base64url");
    return `pt.sim.${payload}.${createHmac("sha256", PERMIT_KEY).update(payload).digest("base64url")}`;
  }
  private issue(b: Binding): string {
    const exp = Math.floor(this.now() / 1000) + PERMIT_TTL_S;
    const token = this.sign({ ...b, exp });
    this.permits.set(token, { ...b, token, exp, used: false });
    this.log.push("runtime.permit_issued", { exp });
    return token;
  }
  private signatureValid(token: string): boolean {
    const m = /^pt\.sim\.([^.]+)\.([^.]+)$/.exec(token);
    return !!m && createHmac("sha256", PERMIT_KEY).update(m[1]).digest("base64url") === m[2];
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON in a test/acceptance harness
    const body = raw ? (JSON.parse(raw) as Record<string, any>) : {};
    const reply = (status: number, j: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
    const p = (req.url ?? "").split("?")[0].replace("/functions/v1", "");
    if (req.headers.authorization !== "Bearer ask_test_l2_agentbound") return reply(401, { error: "invalid_api_key" });

    if (p === "/v1-agent-actor-identity") {
      this.log.push("runtime.identity_mint", { action_type: body.action_type });
      return reply(200, { assertion: { version: "actor_identity.v1", subject: { principal_id: AGENT, principal_kind: "agent", role: "agent" }, binding: { action_type: body.action_type, tenant_id: TENANT, environment: body.environment }, signature: "sim" } });
    }
    if (p === "/v1-source-provenance-seal") {
      this.seals.push(body);
      this.log.push("runtime.seal");
      return reply(200, { source_provenance: { version: "source_provenance.v1", signature: "sim" }, action_hash: SimRuntime.sealHash(body), request_id: body.request_id });
    }
    if (p === "/v1-evaluate") {
      this.evaluations.push(body);
      this.log.push("runtime.evaluate", { policy: this.policy });
      const request_id = `ev-${++this.n}`;
      if (body.actor_identity?.subject?.principal_id !== body.actor_id) return reply(200, { decision: "deny", deny_code: "ACTOR_UNVERIFIED", deny_reason: "verified agent identity required", request_id });
      const sealed = this.seals.find((s) => s.request_id === body.request_id);
      if (!body.source_provenance || !sealed || canonicalJson(sealed.context) !== canonicalJson(body.context) || sealed.resource_id !== body.resource_id) {
        return reply(200, { decision: "deny", deny_code: "ASSERTION_UNVERIFIED", deny_reason: "provenance does not match this request", request_id });
      }
      const binding: Binding = { action_type: body.action_type, actor: body.actor_id, target: body.resource_id, environment: body.context.environment, hash: SimRuntime.sealHash(sealed) };
      if (this.policy === "deny") return reply(200, { decision: "deny", deny_code: "POLICY_DENY", deny_reason: "org policy denies this tool call", request_id });
      if (this.policy === "hold") {
        const aid = `apr-${this.n}`;
        this.approvals.set(aid, { status: "pending", binding, claimed: false });
        return reply(200, { decision: "escalate", approval_request_id: aid, deny_reason: "human approval required", request_id, source_provenance: {} });
      }
      return reply(200, { decision: "allow", permit_token: this.issue(binding), request_id, source_provenance: {} });
    }
    const ap = /^\/v1-approvals\/([^/]+)(\/claim-permit)?$/.exec(p);
    if (ap) {
      const a = this.approvals.get(ap[1]);
      if (!a) return reply(404, { error: "not_found" });
      if (!ap[2]) { this.log.push("runtime.approval_poll", { status: a.status }); return reply(200, { id: ap[1], status: a.status, action_type: ACTION_TYPE, environment: a.binding.environment }); }
      this.log.push("runtime.approval_claim");
      if (a.claimed) return reply(409, { error: "already_claimed" });
      if (a.status !== "approved_awaiting_claim") return reply(409, { error: "not_approved" });
      if (body.actor_identity?.subject?.principal_id !== a.binding.actor) return reply(403, { error: "actor_identity_required" });
      a.claimed = true;
      return reply(200, { claimed: true, permit_token: this.issue(a.binding) });
    }
    if (p === "/v1-verify-permit") {
      this.verifies.push(body);
      const deny = (code: string) => { this.log.push("runtime.verify", { valid: false, code }); return reply(200, { valid: false, outcome: "deny", verify_error_code: code }); };
      const token = String(body.permit_token);
      if (!this.signatureValid(token)) return deny("INVALID_SIGNATURE");
      const permit = this.permits.get(token);
      if (!permit) return deny("PERMIT_NOT_FOUND");
      if (permit.exp * 1000 <= this.now()) return deny("PERMIT_EXPIRED");
      if (permit.used) return deny("PERMIT_ALREADY_USED");
      if (body.action_type !== permit.action_type) return deny("ACTION_TYPE_MISMATCH");
      if (body.actor_id !== permit.actor) return deny("ACTOR_MISMATCH");
      if (body.target_id !== permit.target) return deny("PERMIT_BINDING_MISMATCH");
      if (body.environment !== permit.environment) return deny("ENVIRONMENT_MISMATCH");
      if (body.payload_hash === undefined && permit.environment === "production") return deny("PAYLOAD_HASH_REQUIRED");
      if (body.payload_hash !== undefined && body.payload_hash !== permit.hash) return deny("PAYLOAD_MISMATCH");
      // Check-and-consume in one synchronous step: atomic in this process.
      if (this.mut.noConsume) { if (this.mut.applied) this.mut.applied.count++; } else permit.used = true;
      this.log.push("runtime.verify", { valid: true });
      return reply(200, { valid: true, outcome: "allow" });
    }
    return reply(500, { error: `unrouted ${p}` });
  }
}

// ---------------------------------------------------------------------------
// Mutants: each MUST make the suite report a failure
// ---------------------------------------------------------------------------
type AuthorizeFn = (ctx: ActionContext) => Promise<Decision>;
type VerifyFn = (token: string, ctx: ActionContext) => Promise<VerifyResult>;
export interface Mutant {
  name: string;
  /** What the mutant breaks, in the binding or in the harness's power to see it. */
  description: string;
  authorize?: (real: AuthorizeFn) => AuthorizeFn;
  verify?: (real: VerifyFn) => VerifyFn;
  runtime?: RuntimeMutations;
  adapter?: (real: ExecutionAdapter, env: { provider: SimProvider }) => ExecutionAdapter;
  /** Set by the mutant's code when it actually ran, so a pass is never vacuous. */
  applied: { count: number };
}

export function mutants(): Mutant[] {
  const mk = (m: Omit<Mutant, "applied">): Mutant => ({ ...m, applied: { count: 0 } });
  const list: Mutant[] = [];
  const verifyBypassed = mk({
    name: "verify_bypassed",
    description: "the executor treats every permit as verified without asking the runtime",
  });
  verifyBypassed.verify = () => async () => { verifyBypassed.applied.count++; return { valid: true, outcome: "verified" }; };
  list.push(verifyBypassed);

  const payloadUnbound = mk({
    name: "payload_binding_removed",
    description: "the payload digest is neither bound at evaluate nor presented at verify",
  });
  payloadUnbound.authorize = (real) => async (ctx) => {
    payloadUnbound.applied.count++;
    const { payload_hash: _drop, ...rest } = ctx;
    return real(rest as ActionContext);
  };
  payloadUnbound.verify = (real) => async (token, ctx) => {
    payloadUnbound.applied.count++;
    const { payload_hash: _drop, ...rest } = ctx;
    return real(token, rest as ActionContext);
  };
  list.push(payloadUnbound);

  const replay = mk({ name: "replay_possible", description: "verify never consumes the permit" });
  replay.runtime = { noConsume: true, applied: replay.applied };
  list.push(replay);

  const denyReaches = mk({
    name: "deny_reaches_provider",
    description: "a runtime deny is coerced to allow and the unverifiable permit is accepted",
  });
  denyReaches.authorize = (real) => async (ctx) => {
    const d = await real(ctx);
    if (d.decision !== "deny") return d;
    denyReaches.applied.count++;
    return { decision: "allow", permit_token: "pt.forged" } as Decision;
  };
  denyReaches.verify = (real) => async (token, ctx) => {
    if (token !== "pt.forged") return real(token, ctx);
    denyReaches.applied.count++;
    return { valid: true, outcome: "verified" };
  };
  list.push(denyReaches);

  const inferred = mk({
    name: "execution_inferred_from_authorization",
    description: "the adapter reports the effect established from the write acknowledgement (or a swallowed write error) instead of re-reading the provider",
  });
  inferred.adapter = (real) => ({
    ...real,
    async execute(spec) {
      try { return await real.execute(spec); } catch { inferred.applied.count++; return { commit_sha: "assumed", blob_sha: "assumed" }; }
    },
    async observeEffect(spec) {
      inferred.applied.count++;
      return { established: true, expected: `sha256:${spec.arguments.content_sha256}`, observed: `sha256:${spec.arguments.content_sha256}` };
    },
  });
  list.push(inferred);

  // Hostile regressions for the adjacency rule (atlasent#794). Both leave every
  // other check green: the read changes nothing, and the state change touches
  // a different file, so the provider's own base-sha precondition still passes.
  // Only a rule that demands verify IMMEDIATELY before the mutation sees them.
  const readBetween = mk({
    name: "provider_read_between_verify_and_mutation",
    description: "the executor reads the provider after the permit is verified and before the governed write",
  });
  readBetween.adapter = (real) => ({
    ...real,
    async execute(spec) {
      readBetween.applied.count++;
      await real.readState(spec);
      return real.execute(spec);
    },
  });
  list.push(readBetween);

  const changeBetween = mk({
    name: "provider_state_change_between_verify_and_mutation",
    description: "provider state changes after the permit is verified and before the governed write",
  });
  changeBetween.adapter = (real, env) => ({
    ...real,
    async execute(spec) {
      changeBetween.applied.count++;
      env.provider.setContent(OTHER_PATH, TAMPERED);
      return real.execute(spec);
    },
  });
  list.push(changeBetween);
  return list;
}

// ---------------------------------------------------------------------------
// Commit-point adjacency (atlasent#794)
// ---------------------------------------------------------------------------
/**
 * Every governed provider mutation must be IMMEDIATELY preceded, in the single
 * ordered log shared by runtime and provider, by a successful runtime.verify.
 * Nothing may sit between them: no provider read, no provider state change, no
 * other runtime call, no second mutation reusing the same verify.
 *
 * This replaces the rule the 2026-09-30 record used ("the last RUNTIME call
 * before the mutation is runtime.verify"), which ignored provider events and so
 * passed a provider read or state change between verify and write.
 */
export function adjacencyViolations(events: Event[]): string[] {
  const out: string[] = [];
  events.forEach((e, i) => {
    if (e.kind !== "provider.mutation") return;
    const prev = events[i - 1];
    if (!prev) out.push(`mutation #${e.seq} has no preceding event`);
    else if (prev.kind !== "runtime.verify") out.push(`mutation #${e.seq} is preceded by ${prev.kind}, not runtime.verify`);
    else if (prev.detail?.valid !== true) out.push(`mutation #${e.seq} follows a failed runtime.verify`);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
export interface Check { id: string; requirement: string; passed: boolean; detail: string }
export interface ScenarioOutcome { scenario: string; outcome: string; verify_codes: string[]; provider_mutations: number; verifies: number; permits_issued: number }
export interface SuiteResult {
  checks: Check[];
  outcomes: ScenarioOutcome[];
  failures: Check[];
  /** Every scenario's ordered runtime+provider event log (for adjacency analysis). */
  sequences: Array<{ scenario: string; events: Event[] }>;
}

interface Ctx {
  log: EventLog;
  rt: SimRuntime;
  provider: SimProvider;
  authorize: AuthorizeFn;
  verify: VerifyFn;
  mutant?: Mutant;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON in a test/acceptance harness
  call: (args: Record<string, unknown>) => Promise<Record<string, any>>;
  close: () => Promise<void>;
}

const FIXED_NOW = Date.parse("2026-09-30T12:00:00Z");
const ENV_KEYS = ["ATLASENT_MODE", "ATLASENT_API_KEY", "ATLASENT_BASE_URL", "ATLASENT_ENVIRONMENT", "ATLASENT_CIRCUIT_BREAKER_STOP", "ATLASENT_ANON_KEY"];

async function setup(mutant: Mutant | undefined, policy: Policy, logs?: Array<{ scenario: string; log: EventLog }>, scenario = ""): Promise<Ctx> {
  const log = new EventLog();
  logs?.push({ scenario, log });
  const now = () => FIXED_NOW;
  const rt = new SimRuntime(log, now, mutant?.runtime);
  await rt.start();
  rt.policy = policy;
  const provider = new SimProvider(log, { [PATH]: ORIGINAL, [OTHER_PATH]: ORIGINAL });
  process.env.ATLASENT_MODE = "remote";
  process.env.ATLASENT_API_KEY = "ask_test_l2_agentbound";
  process.env.ATLASENT_BASE_URL = rt.baseUrl;
  process.env.ATLASENT_ENVIRONMENT = ENVIRONMENT;
  delete process.env.ATLASENT_CIRCUIT_BREAKER_STOP;
  delete process.env.ATLASENT_ANON_KEY;
  const a = mutant?.authorize ? mutant.authorize(authorize) : authorize;
  const v = mutant?.verify ? mutant.verify(verify) : verify;
  const server = new McpServer({ name: "l2-harness", version: "1" });
  registerAiActionTools(server, { owner: OWNER, repo: REPO, branch: BRANCH, token: "ghs_l2_sim", pathPrefix: "config/" }, () => true, {
    authorize: a, verify: v, getMode, awaitApproval, fetchImpl: provider.fetch, now: () => new Date(FIXED_NOW),
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "l2-agent-host", version: "1" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return {
    log, rt, provider, authorize: a, verify: v, mutant,
    call: async (args) => {
      const r = await client.callTool({ name: GOVERNED_FILE_CHANGE_TOOL, arguments: args });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON in a test/acceptance harness
      return JSON.parse((r.content as Array<{ text: string }>)[0].text) as Record<string, any>;
    },
    close: async () => { await client.close(); await rt.stop(); },
  };
}

const change = (content: string, path = PATH): GithubFileChange => ({ owner: OWNER, repo: REPO, branch: BRANCH, path, content, message: "Enable checkout_v2 (AI agent)" });
const toolArgs = (content: string) => ({ path: PATH, content, message: "Enable checkout_v2 (AI agent)" });

/** Commit-point level: the same executeGoverned + githubFileAdapter the tool uses, with the adapter injectable for mutants. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON in a test/acceptance harness
async function executeAt(ctx: Ctx, spec: GovernedActionSpec, content: string, permit: string, sealedBinding: any, decision: { decision: string }): Promise<AiActionProof> {
  const target: GithubFileChange = { owner: OWNER, repo: REPO, branch: BRANCH, path: String(spec.arguments.path), content, message: String(spec.arguments.message) };
  const realAdapter = githubFileAdapter(target, content, { token: "ghs_l2_sim", fetchImpl: ctx.provider.fetch });
  const adapter = ctx.mutant?.adapter ? ctx.mutant.adapter(realAdapter, { provider: ctx.provider }) : realAdapter;
  return executeGoverned({
    spec, actorId: AGENT, permitToken: permit, sealedBinding, decision, adapter,
    breaker: new CircuitBreaker({ now: () => new Date(FIXED_NOW) }), verify: ctx.verify, now: () => new Date(FIXED_NOW),
    argumentsCheck: () => (sha256Hex(content) === spec.arguments.content_sha256 ? null : "content does not match the authorized content_sha256"),
  });
}

/** Authorize a spec through the real engine; returns the decision and the spec. */
async function authorizeSpec(ctx: Ctx, content: string, path = PATH) {
  const base = ctx.provider.head.get(path);
  const spec = githubFileChangeSpec(change(content, path), base ? `blob:${base.sha}` : "absent", ENVIRONMENT);
  const auth = await requestAuthorization(spec, AGENT, { authorize: ctx.authorize, verify: ctx.verify, getMode });
  return { spec, decision: auth.decision };
}

export async function runL2Suite(mutant?: Mutant): Promise<SuiteResult> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const checks: Check[] = [];
  const outcomes: ScenarioOutcome[] = [];
  const sequences: Array<{ scenario: string; log: EventLog }> = [];
  const check = (id: string, requirement: string, passed: boolean, detail: string) => checks.push({ id, requirement, passed, detail });
  const record = (ctx: Ctx, scenario: string, outcome: string) => outcomes.push({
    scenario, outcome,
    verify_codes: ctx.log.events.filter((e) => e.kind === "runtime.verify").map((e) => String(e.detail?.code ?? "ok")),
    provider_mutations: ctx.provider.mutations,
    verifies: ctx.rt.verifies.length,
    permits_issued: ctx.log.count("runtime.permit_issued"),
  });
  const guard = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { check(`${name}.no_exception`, "harness", false, `scenario threw: ${e instanceof Error ? e.message : String(e)}`); }
  };

  try {
    // S1 ALLOW through the MCP tool --------------------------------------
    await guard("S1", async () => {
      const ctx = await setup(mutant, "allow", sequences, "S1_allow");
      try {
        const r = await ctx.call(toolArgs(NEW));
        const expectedSpec = githubFileChangeSpec(change(NEW), `blob:${sha("blob" + ORIGINAL).slice(0, 40)}`, ENVIRONMENT);
        const digest = actionDigest(expectedSpec);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON in a test/acceptance harness
        const ev: Record<string, any> = ctx.rt.evaluations[0] ?? {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON in a test/acceptance harness
        const seal: Record<string, any> = ctx.rt.seals[0] ?? {};
        check("R1.exact_request", "exact actor/action/resource/context request",
          ev.action_type === ACTION_TYPE && ev.actor_id === AGENT && ev.resource_id === TARGET &&
          ev.context?.environment === ENVIRONMENT && ev.context?.tool === "github.contents.put" &&
          ev.context?.target_id === TARGET && typeof ev.request_id === "string" && ev.request_id === seal.request_id,
          `action_type=${ev.action_type} actor=${ev.actor_id} resource_id=${ev.resource_id} env=${ev.context?.environment} tool=${ev.context?.tool}`);
        const permit = [...ctx.rt.permits.values()][0];
        check("R2.payload_bound_at_evaluate", "payload hash bound during evaluation",
          ev.execution_payload_hash === digest && ev.context?.action_digest === digest && !!permit && permit.hash === SimRuntime.sealHash(seal) && seal.context?.action_digest === digest,
          `execution_payload_hash=${ev.execution_payload_hash} context.action_digest=${ev.context?.action_digest} expected=${digest}`);
        check("R3.target_environment_bound", "environment/target binding",
          !!permit && permit.target === TARGET && permit.environment === ENVIRONMENT && permit.actor === AGENT,
          `permit target=${permit?.target} environment=${permit?.environment} actor=${permit?.actor}`);
        check("R4.bounded_signed_permit", "ALLOW produces a bounded signed permit",
          !!permit && /^pt\.sim\./.test(permit.token) && permit.exp === Math.floor(FIXED_NOW / 1000) + PERMIT_TTL_S,
          `permit exp=${permit?.exp} (TTL ${PERMIT_TTL_S}s), HMAC-signed`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON in a test/acceptance harness
        const vb: Record<string, any> = ctx.rt.verifies[0] ?? {};
        check("R5.same_facts_at_verify", "binding presents the same material facts at verification",
          ctx.rt.verifies.length === 1 && vb.permit_token === permit?.token && vb.action_type === ACTION_TYPE && vb.actor_id === permit?.actor &&
          vb.target_id === permit?.target && vb.environment === permit?.environment && vb.payload_hash === permit?.hash,
          `verify presented target=${vb.target_id} env=${vb.environment} payload_hash=${vb.payload_hash === permit?.hash ? "== bound" : vb.payload_hash}`);
        const kinds = ctx.log.events.map((e) => e.kind);
        const adj = adjacencyViolations(ctx.log.events);
        check("R6.verify_immediately_before_effect", "permit verifies immediately before the consequential effect (no event of any kind in between)",
          ctx.provider.mutations === 1 && adj.length === 0,
          `sequence: ${kinds.join(" > ")}${adj.length ? `; violations: ${adj.join("; ")}` : ""}`);
        check("R7.single_use_consumed", "permit atomically consumed / single-use",
          !!permit && permit.used === true, `permit.used=${permit?.used}`);
        const proof = r.proof as AiActionProof | undefined;
        check("R13.execution_effect_separate", "execution and effect evidence separate from authorization",
          r.outcome === "executed" && !!proof && proof.decision.decision === "allow" && proof.permit.verified === true &&
          !!proof.execution && "receipt" in proof.execution && proof.effect?.established === true &&
          ctx.provider.content() === NEW && ctx.provider.mutations === 1,
          `outcome=${r.outcome} provider_mutations=${ctx.provider.mutations} provider_content_matches=${ctx.provider.content() === NEW}`);
        record(ctx, "S1_allow", String(r.outcome));
      } finally { await ctx.close(); }
    });

    // S2 REPLAY of a consumed permit at the commit point -------------------
    await guard("S2", async () => {
      const ctx = await setup(mutant, "allow", sequences, "S2_replay");
      try {
        const { spec, decision } = await authorizeSpec(ctx, NEW);
        if (decision.decision !== "allow") throw new Error(`expected allow, got ${decision.decision}`);
        const first = await executeAt(ctx, spec, NEW, decision.permit_token, decision.sealed_binding, decision);
        // Someone reverts the file, so the replayed action's base matches again
        // and the refusal must come from the runtime's single-use check.
        ctx.provider.setContent(PATH, ORIGINAL);
        const before = ctx.provider.mutations;
        const replay = await executeAt(ctx, spec, NEW, decision.permit_token, decision.sealed_binding, decision);
        check("R8.replay_refused", "replay is refused",
          first.outcome === "executed" && replay.outcome === "refused_verify" && replay.permit.verify_error_code === "PERMIT_ALREADY_USED" &&
          ctx.provider.mutations === before && ctx.provider.content() === ORIGINAL,
          `first=${first.outcome} replay=${replay.outcome}/${replay.permit.verify_error_code ?? "-"} provider_mutations_during_replay=${ctx.provider.mutations - before}`);
        record(ctx, "S2_replay", replay.outcome);
      } finally { await ctx.close(); }
    });

    // S3-S5 CHANGED payload / target / environment at the commit point -----
    const tamper = async (scenario: string, id: string, requirement: string, code: string, mutate: (spec: GovernedActionSpec) => { spec: GovernedActionSpec; content: string }) => {
      await guard(scenario, async () => {
        const ctx = await setup(mutant, "allow", sequences, `${scenario}`);
        try {
          const { spec, decision } = await authorizeSpec(ctx, NEW);
          if (decision.decision !== "allow") throw new Error(`expected allow, got ${decision.decision}`);
          const t = mutate(spec);
          const p = await executeAt(ctx, t.spec, t.content, decision.permit_token, decision.sealed_binding, decision);
          const permit = ctx.rt.permits.get(decision.permit_token);
          check(id, requirement,
            p.outcome === "refused_verify" && p.permit.verify_error_code === code && ctx.provider.mutations === 0 && permit?.used === false,
            `outcome=${p.outcome} code=${p.permit.verify_error_code ?? "-"} (expected ${code}) provider_mutations=${ctx.provider.mutations} permit_used=${permit?.used}`);
          record(ctx, scenario, p.outcome);
        } finally { await ctx.close(); }
      });
    };
    await tamper("S3_changed_payload", "R9.changed_payload_refused", "changed payload is refused", "PAYLOAD_MISMATCH", (spec) => ({
      spec: { ...spec, arguments: { ...spec.arguments, content_sha256: sha256Hex(TAMPERED) } }, content: TAMPERED,
    }));
    await tamper("S4_changed_target", "R10a.changed_target_refused", "changed target is refused", "PERMIT_BINDING_MISMATCH", (spec) => {
      const other = githubFileChangeSpec(change(NEW, OTHER_PATH), spec.arguments.base_state as string, ENVIRONMENT);
      return { spec: other, content: NEW };
    });
    await tamper("S5_changed_environment", "R10b.changed_environment_refused", "changed environment is refused", "ENVIRONMENT_MISMATCH", (spec) => ({
      spec: { ...spec, environment: "production" }, content: NEW,
    }));

    // S6 DENY through the MCP tool -----------------------------------------
    await guard("S6", async () => {
      const ctx = await setup(mutant, "deny", sequences, "S6_deny");
      try {
        const r = await ctx.call(toolArgs(NEW));
        check("R11.deny_zero_provider_mutations", "DENY causes zero simulated provider mutation calls",
          r.outcome === "refused" && ctx.provider.mutations === 0 && ctx.provider.content() === ORIGINAL && ctx.log.count("runtime.permit_issued") === 0,
          `outcome=${r.outcome} deny_code=${r.deny_code ?? "-"} provider_mutations=${ctx.provider.mutations} permits_issued=${ctx.log.count("runtime.permit_issued")}`);
        record(ctx, "S6_deny", String(r.outcome));
      } finally { await ctx.close(); }
    });

    // S7 HOLD through the MCP tool, then proper resolution -----------------
    await guard("S7", async () => {
      const ctx = await setup(mutant, "hold", sequences, "S7_hold");
      try {
        const held = await ctx.call(toolArgs(NEW));
        const aid = String(held.approval_request_id ?? "");
        const still = await ctx.call({ ...toolArgs(NEW), approval_request_id: aid, max_wait_seconds: 0 });
        const pendingOk = held.outcome === "held" && !!aid && still.outcome === "held" && ctx.provider.mutations === 0 && ctx.rt.verifies.length === 0;
        ctx.rt.approve(aid);
        const altered = await ctx.call({ ...toolArgs(TAMPERED), approval_request_id: aid, max_wait_seconds: 0 });
        const alteredOk = altered.outcome === "refused" && ctx.provider.mutations === 0;
        const done = await ctx.call({ ...toolArgs(NEW), approval_request_id: aid, max_wait_seconds: 1 });
        check("R12.hold_zero_until_resolved", "HOLD causes zero provider mutation calls until properly resolved",
          pendingOk && alteredOk && done.outcome === "executed" && ctx.provider.mutations === 1 && ctx.provider.content() === NEW && ctx.rt.verifies.length === 1,
          `held=${held.outcome} pending_rerun=${still.outcome} altered_after_approval=${altered.outcome} resolved=${done.outcome} provider_mutations=${ctx.provider.mutations}`);
        record(ctx, "S7_hold", String(done.outcome));
      } finally { await ctx.close(); }
    });

    // S8 authorization does not imply execution ----------------------------
    await guard("S8", async () => {
      for (const failure of ["write_error", "write_dropped"] as const) {
        const ctx = await setup(mutant, "allow", sequences, `S8_${failure}`);
        try {
          const { spec, decision } = await authorizeSpec(ctx, NEW);
          if (decision.decision !== "allow") throw new Error(`expected allow, got ${decision.decision}`);
          if (failure === "write_error") ctx.provider.failNextWrite = 502; else ctx.provider.dropNextWrite = true;
          const p = await executeAt(ctx, spec, NEW, decision.permit_token, decision.sealed_binding, decision);
          const expected = failure === "write_error" ? "outcome_unknown" : "effect_not_established";
          check(`R13b.not_inferred_${failure}`, "execution is never inferred from authorization",
            p.permit.verified === true && p.outcome === expected && p.effect?.established !== true && ctx.provider.content() === ORIGINAL,
            `permit.verified=${p.permit.verified} outcome=${p.outcome} (expected ${expected}) provider_content_unchanged=${ctx.provider.content() === ORIGINAL}`);
          record(ctx, `S8_${failure}`, p.outcome);
        } finally { await ctx.close(); }
      }
    });
    // R6b: adjacency across EVERY scenario, including the commit-point-level
    // ones that run executeGoverned directly (where adapter mutants apply).
    const violations = sequences.flatMap(({ scenario, log }) => adjacencyViolations(log.events).map((v) => `${scenario}: ${v}`));
    const mutationsSeen = sequences.reduce((n, { log }) => n + log.count("provider.mutation"), 0);
    check("R6b.verify_adjacent_every_mutation", "every governed provider mutation in every scenario is immediately preceded by a successful runtime.verify",
      mutationsSeen > 0 && violations.length === 0,
      `provider mutations=${mutationsSeen} across ${sequences.length} scenario runs; violations=${violations.length ? violations.join(" | ") : "none"}`);
  } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return { checks, outcomes, failures: checks.filter((c) => !c.passed), sequences: sequences.map(({ scenario, log }) => ({ scenario, events: log.events })) };
}

/** R14: the full suite twice; the outcome vector must be identical and every check green both times. */
export async function runDeterministic(): Promise<{ runs: SuiteResult[]; check: Check }> {
  const a = await runL2Suite();
  const b = await runL2Suite();
  const same = canonicalJson(a.outcomes) === canonicalJson(b.outcomes) && canonicalJson(a.checks.map((c) => [c.id, c.passed])) === canonicalJson(b.checks.map((c) => [c.id, c.passed]));
  return {
    runs: [a, b],
    check: { id: "R14.deterministic_rerun", requirement: "deterministic rerun produces the expected outcomes", passed: same && a.failures.length === 0 && b.failures.length === 0, detail: `outcome vectors identical=${same}; failures run1=${a.failures.length} run2=${b.failures.length}` },
  };
}

