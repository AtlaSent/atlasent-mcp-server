/**
 * examples/hitl-demo/preflight.mjs: the read-only setup check run before the
 * 90-second demo. These tests pin that it (a) never sends anything but GETs,
 * (b) FAILs on each setup defect that would stop the live run, (c) never
 * prints the key or token, and (d) always states what it could not check.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error -- plain ESM example module, no type declarations
import { runPreflight, TOOL, NOT_CHECKED } from "../examples/hitl-demo/preflight.mjs";

const KEY = "ask_test_SECRETkeyvalue123";
const GH = "github_pat_SECRETtoken456";
const ENV = {
  ATLASENT_API_KEY: KEY,
  ATLASENT_BASE_URL: "https://lwnqpmnxpeyhpxvastku.supabase.co/functions/v1",
  ATLASENT_ENVIRONMENT: "staging",
  ATLASENT_AI_ACTION_GITHUB_REPO: "demo-org/demo-repo",
  ATLASENT_AI_ACTION_GITHUB_BRANCH: "demo",
  ATLASENT_AI_ACTION_GITHUB_TOKEN: GH,
};

type Route = { status: number; body?: unknown; headers?: Record<string, string> };
type Over = { repo?: Route; branch?: Route; approvals?: Route; throwOn?: string };

function fakeFetch(over: Over = {}) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const routes = {
    repo: over.repo ?? { status: 200, body: { permissions: { push: true } } },
    branch: over.branch ?? { status: 200, body: { name: "demo", protected: false } },
    approvals: over.approvals ?? { status: 200, body: { approvals: [] } },
  };
  const fn = async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} });
    if (over.throwOn && url.includes(over.throwOn)) throw new Error("network down");
    const r = url.includes("/v1-approvals") ? routes.approvals : url.includes("/branches/") ? routes.branch : url.startsWith("https://api.github.com/repos/") ? routes.repo : { status: 599 };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  };
  return { fn, calls };
}

async function run(opts: { env?: Record<string, string | undefined>; over?: Over; tools?: string[] | Error; fileExists?: (p: string) => boolean } = {}) {
  const f = fakeFetch(opts.over);
  const lines: string[] = [];
  const tools = opts.tools ?? [TOOL, "atlasent_evaluate"];
  const result = await runPreflight({
    env: opts.env ?? ENV,
    fetch: f.fn,
    listToolNames: async () => { if (tools instanceof Error) throw tools; return tools; },
    fileExists: opts.fileExists ?? (() => false),
    runtimeHeaders: () => ({ "x-region": "us-west-1" }),
    print: (l: string) => lines.push(l),
  });
  const status = (id: string) => result.checks.find((c: { id: string }) => c.id === id)?.status;
  return { result, lines, calls: f.calls, status };
}

describe("demo preflight", () => {
  it("passes a good setup using only GETs, and states what it could not check", async () => {
    const { result, lines, calls, status } = await run();
    assert.equal(result.ok, true);
    for (const id of ["env", "base_url", "environment", "api_key", "operator_stop", "github_repo", "github_branch", "tool", "runtime_key", "pending_queue"]) {
      assert.equal(status(id), "PASS", id);
    }
    assert.ok(calls.length === 3 && calls.every((c) => c.method === "GET"), "only three GETs");
    const rt = calls.find((c) => c.url.includes("/v1-approvals"))!;
    assert.equal(rt.url, "https://lwnqpmnxpeyhpxvastku.supabase.co/functions/v1/v1-approvals?status=pending");
    assert.equal(rt.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(rt.headers["x-region"], "us-west-1");
    for (const n of NOT_CHECKED) assert.ok(lines.some((l) => l.includes(n)), n);
    assert.ok(lines.at(-1)!.startsWith("PREFLIGHT OK"));
  });

  it("never prints the API key or the GitHub token", async () => {
    for (const over of [{}, { approvals: { status: 401 } }, { repo: { status: 401 } }] as Over[]) {
      const { lines } = await run({ over });
      const all = lines.join("\n");
      assert.ok(!all.includes(KEY) && !all.includes("SECRETkeyvalue"), "key leaked");
      assert.ok(!all.includes(GH) && !all.includes("SECRETtoken"), "token leaked");
    }
  });

  it("FAILs on missing variables and makes no network call it cannot make", async () => {
    const { result, calls, status, lines } = await run({ env: {} });
    assert.equal(result.ok, false);
    assert.equal(status("env"), "FAIL");
    assert.equal(status("github_repo"), "SKIP");
    assert.equal(status("runtime_key"), "SKIP");
    assert.equal(calls.length, 0);
    assert.ok(lines.at(-1)!.startsWith("PREFLIGHT FAIL"));
  });

  const fails: Array<[string, string, Parameters<typeof run>[0]]> = [
    ["http base url", "base_url", { env: { ...ENV, ATLASENT_BASE_URL: "http://x.supabase.co/functions/v1" } }],
    ["base url without /functions/v1", "base_url", { env: { ...ENV, ATLASENT_BASE_URL: "https://x.supabase.co" } }],
    ["not an AtlaSent key", "api_key", { env: { ...ENV, ATLASENT_API_KEY: "sk_live_x" } }],
    ["operator stop env", "operator_stop", { env: { ...ENV, ATLASENT_CIRCUIT_BREAKER_STOP: "1" } }],
    ["operator stop file", "operator_stop", { env: { ...ENV, ATLASENT_AI_ACTION_STOP_FILE: "/stop" }, fileExists: (p) => p === "/stop" }],
    ["bad repo format", "github_repo", { env: { ...ENV, ATLASENT_AI_ACTION_GITHUB_REPO: "just-a-name" } }],
    ["GitHub token rejected", "github_repo", { over: { repo: { status: 401 } } }],
    ["repo not visible", "github_repo", { over: { repo: { status: 404 } } }],
    ["no write access", "github_repo", { over: { repo: { status: 200, body: { permissions: { push: false } } } } }],
    ["GitHub unreachable", "github_repo", { over: { throwOn: "api.github.com" } }],
    ["branch missing", "github_branch", { over: { branch: { status: 404 } } }],
    ["tool not registered", "tool", { tools: ["atlasent_evaluate"] }],
    ["server did not start", "tool", { tools: new Error("spawn failed") }],
    ["runtime rejects key", "runtime_key", { over: { approvals: { status: 401 } } }],
    ["key lacks approvals:read", "runtime_key", { over: { approvals: { status: 403 } } }],
    ["runtime 5xx", "runtime_key", { over: { approvals: { status: 503 } } }],
    ["runtime odd shape", "runtime_key", { over: { approvals: { status: 200, body: { rows: [] } } } }],
    ["runtime unreachable", "runtime_key", { over: { throwOn: "/v1-approvals" } }],
  ];
  for (const [name, id, opts] of fails) {
    it(`FAILs: ${name}`, async () => {
      const { result, status } = await run(opts);
      assert.equal(status(id), "FAIL");
      assert.equal(result.ok, false);
    });
  }

  it("names the missing approvals:read scope on a 403, not a generic error", async () => {
    const { result } = await run({ over: { approvals: { status: 403 } } });
    const c = result.checks.find((x: { id: string }) => x.id === "runtime_key");
    assert.match(c.detail, /approvals:read/);
  });

  const warns: Array<[string, string, Parameters<typeof run>[0]]> = [
    ["production environment", "environment", { env: { ...ENV, ATLASENT_ENVIRONMENT: "production", ATLASENT_API_KEY: "ask_live_x" } }],
    ["live key on staging", "api_key", { env: { ...ENV, ATLASENT_API_KEY: "ask_live_x" } }],
    ["runtime-established effect on", "runtime_effect", { env: { ...ENV, ATLASENT_AI_ACTION_RUNTIME_EFFECT: "true" } }],
    ["classic repo-scoped token", "github_token", { over: { repo: { status: 200, body: { permissions: { push: true } }, headers: { "x-oauth-scopes": "repo, workflow" } } } }],
    ["protected branch", "github_branch", { over: { branch: { status: 200, body: { protected: true } } } }],
    ["pending approvals already queued", "pending_queue", { over: { approvals: { status: 200, body: { approvals: [{ id: "a" }, { id: "b" }] } } } }],
  ];
  for (const [name, id, opts] of warns) {
    it(`WARNs but stays ok: ${name}`, async () => {
      const { result, status } = await run(opts);
      assert.equal(status(id), "WARN");
      assert.equal(result.ok, true);
    });
  }
});
