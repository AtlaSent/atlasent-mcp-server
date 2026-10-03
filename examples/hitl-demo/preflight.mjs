/**
 * Read-only preflight for the 90-second demo (examples/hitl-demo.mjs --preflight).
 *
 * Run it ten minutes before presenting. It answers "will the live run get past
 * setup?" without creating anything:
 *
 *   - no evaluate, no approval request, no permit, no claim, no GitHub write;
 *   - GitHub: GET the repository and the branch;
 *   - runtime: GET /v1-approvals?status=pending (a list read that needs
 *     approvals:read, the scope the claim step needs). Only the count is shown.
 *
 * What it CANNOT see, and says so: whether the key is bound to an agent,
 * whether it holds evaluate:write and verify:execute, whether the org's
 * agent.tool.invoke policy requires a person, and whether the approver can sign
 * in. Those are only observable by running the demo. A PASS here is not a
 * claim that the live run will succeed.
 *
 * Every check reports PASS, WARN, FAIL or SKIP. ok is true only when nothing
 * FAILed. The key and the GitHub token are never printed.
 */

export const TOOL = "atlasent_governed_file_change";

export const REQUIRED_ENV = [
  "ATLASENT_API_KEY",
  "ATLASENT_BASE_URL",
  "ATLASENT_ENVIRONMENT",
  "ATLASENT_AI_ACTION_GITHUB_REPO",
  "ATLASENT_AI_ACTION_GITHUB_BRANCH",
  "ATLASENT_AI_ACTION_GITHUB_TOKEN",
];

/** Things the preflight cannot observe without creating a real request. Printed on every run. */
export const NOT_CHECKED = [
  "the key is bound to a registered agent (console: Settings -> Connect an AI agent)",
  "the key holds evaluate:write and verify:execute",
  "the org's agent.tool.invoke policy requires a person (if it allows outright, the live run FAILs at ATTEMPT)",
  "the approver can sign in to the console and approve (Approvals queue)",
  "a fine-grained GitHub token's own Contents: write permission (GitHub reports the account's access, not the token's)",
];

const enc = (s) => encodeURIComponent(s);

/**
 * @param {object} o
 * @param {Record<string, string | undefined>} o.env
 * @param {typeof fetch} o.fetch
 * @param {() => Promise<string[]>} [o.listToolNames]  names from the built server's tools/list; omitted = SKIP
 * @param {(path: string) => boolean} [o.fileExists]
 * @param {(baseUrl: string) => Record<string, string>} [o.runtimeHeaders]  extra headers (region pin)
 * @param {(line: string) => void} [o.print]
 */
export async function runPreflight(o) {
  const env = o.env;
  const print = o.print ?? ((l) => console.log(l));
  const checks = [];
  const add = (id, status, detail) => {
    checks.push({ id, status, detail });
    print(`  ${status.padEnd(4)}  ${id.padEnd(20)} ${detail}`);
  };
  const v = (k) => (env[k] ?? "").trim();

  print("AtlaSent demo preflight (read-only: creates no request, approval, permit or commit)");

  // 1. Environment variables.
  const missing = REQUIRED_ENV.filter((k) => !v(k));
  if (missing.length) add("env", "FAIL", `missing: ${missing.join(", ")}`);
  else add("env", "PASS", "all required variables set");

  // 2. Runtime URL.
  let base = null;
  if (v("ATLASENT_BASE_URL")) {
    try {
      const u = new URL(v("ATLASENT_BASE_URL"));
      if (u.protocol !== "https:") add("base_url", "FAIL", `must be https (got ${u.protocol})`);
      else if (!/\/functions\/v1\/?$/.test(u.pathname)) add("base_url", "FAIL", `must end in /functions/v1 (got ${u.pathname})`);
      else {
        base = u.toString().replace(/\/+$/, "");
        add("base_url", "PASS", u.host);
      }
    } catch {
      add("base_url", "FAIL", "not a URL");
    }
  } else add("base_url", "SKIP", "not set");

  // 3. Environment name and key kind.
  const environment = v("ATLASENT_ENVIRONMENT");
  const key = v("ATLASENT_API_KEY");
  if (environment === "production") {
    add("environment", "WARN", "production: the console approval panel for agent holds has only been shown end to end on staging. Rehearse there first.");
  } else if (environment) add("environment", "PASS", environment);
  else add("environment", "SKIP", "not set");
  if (key) {
    const m = /^ask_(test|live)_/.exec(key);
    if (!m) add("api_key", "FAIL", "not an AtlaSent API key (expected ask_test_... or ask_live_...)");
    else if (m[1] === "live" && environment && environment !== "production") add("api_key", "WARN", `ask_live_ key with environment ${environment}`);
    else if (m[1] === "test" && environment === "production") add("api_key", "WARN", "ask_test_ key with environment production");
    else add("api_key", "PASS", `ask_${m[1]}_ key (value not shown)`);
  } else add("api_key", "SKIP", "not set");

  // 4. Things that would refuse or change the run before it starts.
  if (env.ATLASENT_CIRCUIT_BREAKER_STOP === "1") add("operator_stop", "FAIL", "ATLASENT_CIRCUIT_BREAKER_STOP=1: every change is refused");
  else if (v("ATLASENT_AI_ACTION_STOP_FILE") && o.fileExists?.(v("ATLASENT_AI_ACTION_STOP_FILE"))) {
    add("operator_stop", "FAIL", `stop file present (${v("ATLASENT_AI_ACTION_STOP_FILE")}): every change is refused`);
  } else add("operator_stop", "PASS", "no operator stop");
  if (v("ATLASENT_AI_ACTION_RUNTIME_EFFECT") === "true") {
    add("runtime_effect", "WARN", "runtime-established effect is on: needs consequential_operations:write and a GitHub App-enrolled repo; the run may end effect_pending");
  }

  // 5. GitHub: the repository is reachable and writable with this token; the branch exists.
  const repoM = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(v("ATLASENT_AI_ACTION_GITHUB_REPO"));
  const branch = v("ATLASENT_AI_ACTION_GITHUB_BRANCH");
  const ghToken = v("ATLASENT_AI_ACTION_GITHUB_TOKEN");
  if (v("ATLASENT_AI_ACTION_GITHUB_REPO") && !repoM) add("github_repo", "FAIL", "ATLASENT_AI_ACTION_GITHUB_REPO must be owner/repo");
  else if (!repoM || !ghToken) add("github_repo", "SKIP", "repository or token not set");
  else {
    const ghHeaders = { Accept: "application/vnd.github+json", Authorization: `Bearer ${ghToken}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "atlasent-demo-preflight" };
    const repoPath = `https://api.github.com/repos/${enc(repoM[1])}/${enc(repoM[2])}`;
    let repoOk = false;
    try {
      const res = await o.fetch(repoPath, { headers: ghHeaders, signal: AbortSignal.timeout(15_000) });
      if (res.status === 401) add("github_repo", "FAIL", "token rejected (401)");
      else if (res.status === 404) add("github_repo", "FAIL", "repository not found, or the token cannot see it (404)");
      else if (!res.ok) add("github_repo", "FAIL", `GitHub answered ${res.status}`);
      else {
        const j = await res.json();
        if (j?.permissions?.push !== true) add("github_repo", "FAIL", "this token's account cannot write the repository (permissions.push is not true)");
        else {
          repoOk = true;
          add("github_repo", "PASS", `${repoM[1]}/${repoM[2]} visible; the account has write access`);
        }
        // A classic token's scopes are in this header. "repo" lets it write every repository the user can.
        const scopes = (res.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (scopes.includes("repo") || scopes.includes("public_repo")) {
          add("github_token", "WARN", `classic token with scope ${scopes.includes("repo") ? "repo" : "public_repo"}: it can write other repositories too. Use a fine-grained token limited to the demo repository (Contents: read and write)`);
        }
      }
    } catch (e) {
      add("github_repo", "FAIL", `GitHub unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!repoOk || !branch) add("github_branch", "SKIP", repoOk ? "branch not set" : "repository check did not pass");
    else {
      try {
        const res = await o.fetch(`${repoPath}/branches/${enc(branch)}`, { headers: ghHeaders, signal: AbortSignal.timeout(15_000) });
        if (res.status === 404) add("github_branch", "FAIL", `branch ${branch} does not exist`);
        else if (!res.ok) add("github_branch", "FAIL", `GitHub answered ${res.status}`);
        else {
          const j = await res.json();
          if (j?.protected === true) add("github_branch", "WARN", `${branch} is protected: a direct contents write may be rejected. Use an unprotected demo branch`);
          else add("github_branch", "PASS", `${branch} exists`);
        }
      } catch (e) {
        add("github_branch", "FAIL", `GitHub unreachable: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 6. The built server registers the tool with this configuration.
  if (!o.listToolNames) add("tool", "SKIP", "server not started");
  else {
    try {
      const names = await o.listToolNames();
      if (names.includes(TOOL)) add("tool", "PASS", `${TOOL} registered`);
      else add("tool", "FAIL", `${TOOL} is not registered by the built server (run npm run build; check the ATLASENT_AI_ACTION_GITHUB_* variables)`);
    } catch (e) {
      add("tool", "FAIL", `server did not start: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 7. Runtime: the key authenticates and can read approvals (what the claim step needs).
  if (!base || !key || !/^ask_(test|live)_/.test(key)) add("runtime_key", "SKIP", "runtime URL or key not usable");
  else {
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
      "User-Agent": "atlasent-demo-preflight",
      ...(v("ATLASENT_ANON_KEY") ? { "x-anon-key": v("ATLASENT_ANON_KEY") } : {}),
      ...(o.runtimeHeaders ? o.runtimeHeaders(base) : {}),
    };
    try {
      const res = await o.fetch(`${base}/v1-approvals?status=pending`, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
      if (res.status === 401) add("runtime_key", "FAIL", "the runtime rejected the key (401)");
      else if (res.status === 403) add("runtime_key", "FAIL", "the key lacks approvals:read (403): the claim after approval would be refused");
      else if (!res.ok) add("runtime_key", "FAIL", `the runtime answered ${res.status}`);
      else {
        let n = null;
        try {
          const j = await res.json();
          if (Array.isArray(j?.approvals)) n = j.approvals.length;
        } catch { /* fall through */ }
        if (n === null) add("runtime_key", "FAIL", "unexpected response shape from /v1-approvals");
        else {
          add("runtime_key", "PASS", "key accepted; approvals:read present");
          if (n > 0) add("pending_queue", "WARN", `${n} pending approval(s) already in the org's queue: approve only the id the demo prints`);
          else add("pending_queue", "PASS", "no pending approvals in the queue");
        }
      }
    } catch (e) {
      add("runtime_key", "FAIL", `runtime unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  print("");
  print("  Not checked (only a live run shows these):");
  for (const n of NOT_CHECKED) print(`    - ${n}`);
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const warned = checks.filter((c) => c.status === "WARN").length;
  print("");
  print(failed ? `PREFLIGHT FAIL: ${failed} failed, ${warned} warning(s). Fix these before presenting.` : `PREFLIGHT OK: ${warned} warning(s). This is a setup check, not a demo run.`);
  return { ok: failed === 0, checks };
}
