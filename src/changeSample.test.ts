import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildReport, checksState, collect, judge, renderMarkdown, standingApprovals,
  type Get, type PullInput, type Review,
} from "./changeSample.js";
import { EXIT, findToken, githubGet, main, parseArgs, renderHtml } from "./changeSampleCli.js";

const HEAD = "c".repeat(40);
const OLD = "a".repeat(40);
const ok = [{ name: "ci", status: "completed", conclusion: "success" }];

const rv = (login: string, state: string, commit = HEAD, at = "2026-10-01T10:00:00Z", type = "User"): Review => ({
  user: { login, type }, state, commit_id: commit, submitted_at: at,
});

function pr(over: Partial<PullInput> = {}): PullInput {
  return {
    number: 1, title: "Change", url: "https://github.com/o/r/pull/1", author: "alice",
    merged_at: "2026-10-02T00:00:00Z", merged_by: "bob", head_sha: HEAD,
    reviews: [rv("bob", "APPROVED")], checks: ok, ...over,
  };
}

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const o = process.stdout.write, e = process.stderr.write;
  process.stdout.write = (() => true) as typeof o;
  process.stderr.write = (() => true) as typeof e;
  return fn().finally(() => { process.stdout.write = o; process.stderr.write = e; });
}

describe("change sample: verdicts", () => {
  it("passes an independent approval on the merged commit", () => {
    assert.equal(judge(pr()).verdict, "pass");
  });

  it("no reviews at all is no human approval", () => {
    assert.equal(judge(pr({ reviews: [] })).verdict, "no_human_approval");
  });

  it("a bot's approval is not a human approval", () => {
    assert.equal(judge(pr({ reviews: [rv("dependabot[bot]", "APPROVED"), rv("ci-bot", "APPROVED", HEAD, undefined, "Bot")] })).verdict, "no_human_approval");
  });

  it("an approval only by the author fails, case-insensitively", () => {
    assert.equal(judge(pr({ author: "Alice", reviews: [rv("alice", "APPROVED")] })).verdict, "author_only_approval");
  });

  it("an approval on an earlier commit, not re-approved, fails and names both commits", () => {
    const r = judge(pr({ reviews: [rv("bob", "APPROVED", OLD)] }));
    assert.equal(r.verdict, "approved_earlier_commit");
    assert.match(r.detail, /aaaaaaa.*ccccccc/);
  });

  it("a later re-approval on the merged commit passes", () => {
    assert.equal(judge(pr({ reviews: [rv("bob", "APPROVED", OLD, "2026-10-01T10:00:00Z"), rv("bob", "APPROVED", HEAD, "2026-10-01T12:00:00Z")] })).verdict, "pass");
  });

  it("changes requested after an approval cancels it", () => {
    assert.equal(judge(pr({ reviews: [rv("bob", "APPROVED", HEAD, "2026-10-01T10:00:00Z"), rv("bob", "CHANGES_REQUESTED", HEAD, "2026-10-01T11:00:00Z")] })).verdict, "no_human_approval");
  });

  it("a dismissed review is not an approval", () => {
    assert.equal(judge(pr({ reviews: [rv("bob", "DISMISSED")] })).verdict, "no_human_approval");
  });

  it("a comment after an approval does not cancel it", () => {
    assert.equal(judge(pr({ reviews: [rv("bob", "APPROVED", HEAD, "2026-10-01T10:00:00Z"), rv("bob", "COMMENTED", HEAD, "2026-10-01T11:00:00Z")] })).verdict, "pass");
  });

  it("failed checks on the merged commit fail an otherwise approved change", () => {
    assert.equal(judge(pr({ checks: [{ name: "ci", status: "completed", conclusion: "failure" }] })).verdict, "checks_failed");
  });

  it("unreadable reviews are unknown, never a failure", () => {
    assert.equal(judge(pr({ reviews: null })).verdict, "unknown");
  });

  it("no checks configured does not fail an approved change", () => {
    assert.equal(judge(pr({ checks: [] })).verdict, "pass");
  });

  it("checks still running or unreadable make an approved change unknown, never a pass", () => {
    assert.equal(judge(pr({ checks: null })).verdict, "unknown");
    assert.equal(judge(pr({ checks: [{ name: "ci", status: "in_progress", conclusion: null }] })).verdict, "unknown");
  });

  it("a deleted author account is unknown: independence cannot be established", () => {
    const r = judge(pr({ author: null }));
    assert.equal(r.verdict, "unknown");
    assert.equal(r.author, "(deleted account)");
  });

  it("checks states", () => {
    assert.equal(checksState([]), "none");
    assert.equal(checksState(null), "unreadable");
    assert.equal(checksState([{ name: "x", status: "in_progress", conclusion: null }]), "unreadable");
    assert.equal(checksState([{ name: "x", status: "completed", conclusion: "skipped" }]), "passed");
  });

  it("standing approvals keep each reviewer's latest decision only", () => {
    const s = standingApprovals([rv("bob", "APPROVED", OLD, "2026-10-01T09:00:00Z"), rv("carol", "APPROVED"), rv("bob", "CHANGES_REQUESTED", HEAD, "2026-10-01T12:00:00Z")]);
    assert.deepEqual(s.map((r) => r.user!.login), ["carol"]);
  });
});

describe("change sample: report", () => {
  const now = new Date("2026-10-20T00:00:00Z");

  it("counts failures, unknowns and passes; unknown is not a failure", () => {
    const r = buildReport("o/r", "main", 90, {
      pulls: [pr({ number: 1 }), pr({ number: 2, reviews: [] }), pr({ number: 3, reviews: null })],
      errors: [], truncated: false,
    }, now);
    assert.equal(r.summary.merged, 3);
    assert.equal(r.summary.would_fail, 1);
    assert.equal(r.summary.unknown, 1);
    assert.equal(r.summary.passed, 1);
    assert.equal(r.headline, "1 of 3 merged changes would fail a change-management sample.");
    assert.equal(r.complete, true);
  });

  it("any read error or truncation makes the report incomplete", () => {
    assert.equal(buildReport("o/r", "main", 90, { pulls: [], errors: [{ what: "x", error: "HTTP 500" }], truncated: false }, now).complete, false);
    const t = buildReport("o/r", "main", 90, { pulls: [], errors: [], truncated: true }, now);
    assert.equal(t.complete, false);
    assert.match(t.errors[0].error, /only the newest/);
  });

  it("markdown links every failing change and states what it cannot see", () => {
    const md = renderMarkdown(buildReport("o/r", "main", 90, { pulls: [pr({ reviews: [] })], errors: [], truncated: false }, now));
    assert.match(md, /\[#1\]\(https:\/\/github\.com\/o\/r\/pull\/1\)/);
    assert.match(md, /Approvals given outside GitHub/);
    assert.match(md, /not a compliance assessment/);
  });

  it("html escapes untrusted titles and loads nothing external", () => {
    const html = renderHtml(buildReport("o/r", "main", 90, { pulls: [pr({ title: "<script>x</script>", reviews: [] })], errors: [], truncated: false }, now));
    assert.ok(!html.includes("<script>x"));
    assert.ok(html.includes("&lt;script&gt;x"));
    assert.ok(!/<script|<link|src=/i.test(html));
  });
});

/** A fake GitHub API from a route table. Unlisted paths are 404. */
function fakeGet(routes: Record<string, unknown>, status: Record<string, number> = {}): Get {
  return async (path) => {
    const key = path.replace(/[?&]per_page=\d+/, "").replace(/[?&]page=\d+/, "");
    for (const [k, v] of Object.entries(routes)) {
      if (key === k || key.startsWith(k + "?") || key.startsWith(k + "&")) {
        if (status[k]) return { status: status[k], json: null };
        const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
        return { status: 200, json: Array.isArray(v) && page > 1 ? [] : v };
      }
    }
    return { status: 404, json: null };
  };
}

const apiPull = (n: number, merged: string | null, updated = merged ?? "2026-10-10T00:00:00Z") => ({
  number: n, title: `PR ${n}`, html_url: `https://github.com/o/r/pull/${n}`, merged_at: merged, updated_at: updated,
  user: { login: "alice" }, head: { sha: HEAD },
});

describe("change sample: collection", () => {
  const now = new Date("2026-10-20T00:00:00Z");

  it("a pull request whose author account is gone is collected with a null author", async () => {
    const get = fakeGet({
      "repos/o/r/pulls": [{ ...apiPull(1, "2026-10-10T00:00:00Z"), user: null }],
      "repos/o/r/pulls/1/reviews": [rv("bob", "APPROVED")],
      [`repos/o/r/commits/${HEAD}/check-runs`]: { total_count: 1, check_runs: ok },
      "repos/o/r/pulls/1": {},
    });
    const c = await collect(get, "o/r", "main", 90, now);
    assert.equal(c.pulls[0].author, null);
    assert.equal(judge(c.pulls[0]).verdict, "unknown");
  });

  it("keeps merged pull requests in the window and drops closed-unmerged and old ones", async () => {
    const get = fakeGet({
      "repos/o/r/pulls": [apiPull(1, "2026-10-10T00:00:00Z"), apiPull(2, null), apiPull(3, "2026-01-01T00:00:00Z", "2026-10-09T00:00:00Z")],
      "repos/o/r/pulls/1/reviews": [rv("bob", "APPROVED")],
      [`repos/o/r/commits/${HEAD}/check-runs`]: { total_count: 1, check_runs: ok },
      "repos/o/r/pulls/1": { merged_by: { login: "bob" } },
    });
    const c = await collect(get, "o/r", "main", 90, now);
    assert.deepEqual(c.pulls.map((p) => p.number), [1]);
    assert.equal(c.errors.length, 0);
    assert.equal(c.pulls[0].merged_by, "bob");
  });

  it("a failed review read is recorded and leaves that pull request unknown", async () => {
    const get = fakeGet({
      "repos/o/r/pulls": [apiPull(1, "2026-10-10T00:00:00Z")],
      "repos/o/r/pulls/1/reviews": [],
      [`repos/o/r/commits/${HEAD}/check-runs`]: { total_count: 0, check_runs: [] },
      "repos/o/r/pulls/1": {},
    }, { "repos/o/r/pulls/1/reviews": 403 });
    const c = await collect(get, "o/r", "main", 90, now);
    assert.equal(c.errors.length, 1);
    assert.equal(c.pulls[0].reviews, null);
    assert.equal(judge(c.pulls[0]).verdict, "unknown");
  });

  it("a failed list read is an error, never an empty clean result", async () => {
    const c = await collect(fakeGet({ "repos/o/r/pulls": [] }, { "repos/o/r/pulls": 502 }), "o/r", "main", 90, now);
    assert.equal(c.errors.length, 1);
    assert.equal(buildReport("o/r", "main", 90, c, now).complete, false);
  });
});

describe("atlasent-change-sample cli", () => {
  it("parses args with safe defaults and refusals", () => {
    assert.deepEqual(parseArgs(["o/r"]), { repo: "o/r", days: 90, out: ".", failOnFindings: false });
    assert.deepEqual(parseArgs(["o/r", "--days", "30", "--base", "release/1", "--out", "x", "--fail-on-findings"]), { repo: "o/r", days: 30, base: "release/1", out: "x", failOnFindings: true });
    for (const bad of [[], ["notarepo"], ["o/r", "--days", "0"], ["o/r", "--days", "x"], ["o/r", "--base"], ["o/r", "--bogus"], ["o/r", "o/s"]]) {
      assert.ok("error" in parseArgs(bad), JSON.stringify(bad));
    }
  });

  it("finds a token from the environment first, then gh, and never invents one", () => {
    assert.equal(findToken({ GH_TOKEN: " t1 " }, () => "t2"), "t1");
    assert.equal(findToken({}, () => "t2\n"), "t2");
    assert.equal(findToken({}, () => { throw new Error("no gh"); }), undefined);
  });

  it("calls only the GitHub API base it was given, with the token as a bearer header, and survives network errors", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/boom")) throw new Error("ECONNRESET secret-token");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const get = githubGet("secret-token", "https://api.github.com/", fakeFetch);
    assert.deepEqual(await get("repos/o/r"), { status: 200, json: { ok: true } });
    assert.deepEqual(await get("boom"), { status: 0, json: null });
    assert.equal(seen[0].url, "https://api.github.com/repos/o/r");
    assert.equal(seen[0].auth, "Bearer secret-token");
  });

  it("with no token, exits 2 and writes nothing", async () => {
    const out = mkdtempSync(join(tmpdir(), "cs-"));
    const code = await quiet(() => main(["o/r", "--out", out], { token: () => undefined }));
    assert.equal(code, EXIT.CANNOT_READ);
  });

  it("an unreadable repository exits 2", async () => {
    const code = await quiet(() => main(["o/r"], { get: fakeGet({}) }));
    assert.equal(code, EXIT.CANNOT_READ);
  });

  it("writes all three reports; --fail-on-findings exits 1 on a failing change; incomplete exits 3", async () => {
    const routes = {
      "repos/o/r": { default_branch: "main", full_name: "o/r" },
      "repos/o/r/pulls": [apiPull(1, "2026-10-10T00:00:00Z")],
      "repos/o/r/pulls/1/reviews": [],
      [`repos/o/r/commits/${HEAD}/check-runs`]: { total_count: 0, check_runs: [] },
      "repos/o/r/pulls/1": {},
    };
    const now = new Date("2026-10-20T00:00:00Z");
    const out = mkdtempSync(join(tmpdir(), "cs-"));
    assert.equal(await quiet(() => main(["o/r", "--out", out], { get: fakeGet(routes), now })), EXIT.OK);
    const json = JSON.parse(readFileSync(join(out, "atlasent-change-sample.json"), "utf8"));
    assert.equal(json.format, "change_sample.v1");
    assert.equal(json.summary.would_fail, 1);
    assert.match(readFileSync(join(out, "atlasent-change-sample.md"), "utf8"), /1 of 1 merged change would fail/);
    assert.match(readFileSync(join(out, "atlasent-change-sample.html"), "utf8"), /nothing was sent to AtlaSent/);
    assert.equal(await quiet(() => main(["o/r", "--out", out, "--fail-on-findings"], { get: fakeGet(routes), now })), EXIT.FINDINGS);
    assert.equal(await quiet(() => main(["o/r", "--out", out, "--fail-on-findings"], { get: fakeGet(routes, { "repos/o/r/pulls/1/reviews": 500 }), now })), EXIT.INCOMPLETE);
  });
});
