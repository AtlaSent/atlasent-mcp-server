#!/usr/bin/env node
/**
 * The 90-second human-in-the-loop demo (AI Action Protection, design partner
 * program):
 *
 *   1 ATTEMPT  an agent asks to change a config file in a real GitHub repo
 *   2 HOLD     AtlaSent holds it; nothing changes
 *   3 BOUND    a changed version of the action cannot use the approval
 *   4 APPROVE  a person approves it in the AtlaSent console
 *   5 EXECUTE  the permit is verified at the boundary; exactly one write
 *   6 RECORD   the effect is re-read; ai_action_proof.v1 is printed
 *
 * LIVE (default). Spawns the built server (dist/index.js) over stdio, exactly
 * as an MCP host would, and calls `atlasent_governed_file_change`. Needs:
 *
 *   ATLASENT_API_KEY                 an AGENT-BOUND key (Settings -> Connect an AI agent)
 *   ATLASENT_BASE_URL                the runtime, e.g. https://<ref>.supabase.co/functions/v1
 *   ATLASENT_ENVIRONMENT             required, e.g. staging (no default: the demo never assumes production)
 *   ATLASENT_AI_ACTION_GITHUB_REPO   owner/repo the agent may change (a demo repo)
 *   ATLASENT_AI_ACTION_GITHUB_BRANCH the branch it may change
 *   ATLASENT_AI_ACTION_GITHUB_TOKEN  a token that can write ONLY that repo
 *   ATLASENT_AI_ACTION_PATH_PREFIX   optional; the demo file goes under it
 *   DEMO_APPROVAL_WAIT_SECONDS       optional, default 600
 *   DEMO_SERVER_LOGS=1               optional; show the server's JSON logs on stderr
 *
 * The org's agent.tool.invoke policy must require human approval. If it allows
 * the change outright, the demo reports FAIL rather than skipping the hold.
 *
 * SIMULATED (`--simulate`). In-memory runtime, repository and approver, for
 * rehearsal only. Every line is prefixed [SIMULATED]; no network call is made.
 *
 * PREFLIGHT (`--preflight`). Read-only setup check before presenting: env,
 * GitHub repository and branch (GET only), the built server's tools/list, and
 * one read of the org's pending approvals (needs approvals:read). Creates no
 * request, approval, permit or commit. See examples/hitl-demo/preflight.mjs.
 *
 *   npm run build && npm run demo:hitl -- --preflight  # setup check, ten minutes before
 *   npm run build && npm run demo:hitl                 # live
 *   npm run build && npm run demo:hitl -- --simulate   # rehearsal
 *
 * Presenter run sheet: docs/DEMO_90_SECONDS.md.
 *
 * Exit code 0 only when every stage was observed. Writes nothing except the
 * one demo file in the configured repository, and a JSON evidence file in the
 * working directory (permit recorded as sha256 only).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runHitlDemo } from "./hitl-demo/core.mjs";
import { createSimulatedBackends } from "./hitl-demo/simulated-backends.mjs";
import { runPreflight } from "./hitl-demo/preflight.mjs";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "..", "dist");
const simulate = process.argv.includes("--simulate");
const preflight = process.argv.includes("--preflight");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

/** Reads the file at the branch head straight from GitHub's contents API, independently of the tool. */
function headReader({ owner, repo, branch, token }) {
  return async (path) => {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "atlasent-hitl-demo" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub read ${res.status}`);
    const j = await res.json();
    if (j.type !== "file" || j.encoding !== "base64") throw new Error("GitHub read returned something other than a base64 file");
    return Buffer.from(j.content, "base64").toString("utf8");
  };
}

function die(msg) {
  console.error(msg);
  process.exit(2);
}

async function preflightMain() {
  if (simulate) die("--preflight checks a live setup; it cannot be combined with --simulate.");
  if (!existsSync(resolve(DIST, "index.js"))) die("dist/index.js not found. Run npm run build first.");
  const { functionRegionHeaders } = await import(resolve(DIST, "functionRegion.js"));
  const listToolNames = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(DIST, "index.js")],
      env: { ...process.env, ATLASENT_MODE: "remote" },
      stderr: "ignore",
    });
    const c = new Client({ name: "atlasent-demo-preflight", version: "1.0.0" });
    await c.connect(transport);
    try {
      return (await c.listTools()).tools.map((t) => t.name);
    } finally {
      await c.close();
    }
  };
  const { ok } = await runPreflight({
    env: process.env,
    fetch: globalThis.fetch,
    listToolNames,
    fileExists: (p) => existsSync(p),
    runtimeHeaders: (base) => functionRegionHeaders(base),
  });
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (preflight) return preflightMain();
  let client;
  let target;
  let sim;
  let close = async () => {};

  if (simulate) {
    target = { owner: "simulated-org", repo: "simulated-repo", branch: "main", token: "simulated" };
    sim = createSimulatedBackends(target);
    sim.install();
    // The in-process server logs JSON lines to stderr; keep the rehearsal readable unless asked.
    if (process.env.DEMO_SERVER_LOGS !== "1") process.stderr.write = () => true;
    Object.assign(process.env, {
      ATLASENT_MODE: "remote",
      ATLASENT_API_KEY: "ask_test_simulated",
      ATLASENT_BASE_URL: sim.baseUrl,
      ATLASENT_ENVIRONMENT: "staging",
      ATLASENT_AI_ACTION_GITHUB_REPO: `${target.owner}/${target.repo}`,
      ATLASENT_AI_ACTION_GITHUB_BRANCH: target.branch,
      ATLASENT_AI_ACTION_GITHUB_TOKEN: target.token,
    });
    delete process.env.ATLASENT_AI_ACTION_PATH_PREFIX;
    delete process.env.ATLASENT_AI_ACTION_RUNTIME_EFFECT;
    const { createServer } = await import(resolve(DIST, "server.js"));
    const server = createServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "atlasent-hitl-demo", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
    close = async () => { await client.close(); sim.restore(); };
  } else {
    const need = ["ATLASENT_API_KEY", "ATLASENT_BASE_URL", "ATLASENT_ENVIRONMENT", "ATLASENT_AI_ACTION_GITHUB_REPO", "ATLASENT_AI_ACTION_GITHUB_BRANCH", "ATLASENT_AI_ACTION_GITHUB_TOKEN"];
    const missing = need.filter((k) => !process.env[k]?.trim());
    if (missing.length) die(`Live demo needs: ${missing.join(", ")}. For an offline rehearsal run with --simulate.`);
    const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(process.env.ATLASENT_AI_ACTION_GITHUB_REPO.trim());
    if (!m) die("ATLASENT_AI_ACTION_GITHUB_REPO must be owner/repo");
    target = { owner: m[1], repo: m[2], branch: process.env.ATLASENT_AI_ACTION_GITHUB_BRANCH.trim(), token: process.env.ATLASENT_AI_ACTION_GITHUB_TOKEN.trim() };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(DIST, "index.js")],
      // remote mode is forced: local mode never changes a real system, and a demo must not quietly fall back to it.
      env: { ...process.env, ATLASENT_MODE: "remote" },
      stderr: process.env.DEMO_SERVER_LOGS === "1" ? "inherit" : "ignore",
    });
    client = new Client({ name: "atlasent-hitl-demo", version: "1.0.0" });
    await client.connect(transport);
    close = () => client.close();
  }

  const prefix = (process.env.ATLASENT_AI_ACTION_PATH_PREFIX ?? "").trim();
  const path = `${prefix}atlasent-demo/payments-feature-flags-${stamp}.json`;
  const content = '{\n  "instant_payouts": true\n}\n';
  const runtime = simulate ? "simulated runtime" : new URL(process.env.ATLASENT_BASE_URL).host;
  const hdr = `${simulate ? "[SIMULATED] " : ""}AtlaSent: hold -> approve -> execute -> record | runtime ${runtime} | env ${process.env.ATLASENT_ENVIRONMENT} | repo ${target.owner}/${target.repo}@${target.branch}`;
  console.log(hdr);

  const result = await runHitlDemo({
    client,
    readHead: headReader(target),
    path,
    content,
    message: `AI agent: enable instant_payouts (AtlaSent demo ${stamp})`,
    simulated: simulate,
    approvalWaitSeconds: Number(process.env.DEMO_APPROVAL_WAIT_SECONDS ?? 600),
    pollSeconds: simulate ? 1 : 20,
    onHold: simulate ? (id) => sim.decide(id) : undefined,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  await close();

  const evidence = {
    simulated: simulate,
    runtime,
    environment: process.env.ATLASENT_ENVIRONMENT,
    repository: `${target.owner}/${target.repo}`,
    branch: target.branch,
    path,
    finished_at: new Date().toISOString(),
    ...result,
  };
  const file = `hitl-demo-evidence-${simulate ? "SIMULATED-" : ""}${stamp}.json`;
  writeFileSync(file, JSON.stringify(evidence, (k, v) => (k === "permit_token" ? undefined : v), 2));
  console.log(`${simulate ? "[SIMULATED] " : ""}Evidence: ${file}`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
