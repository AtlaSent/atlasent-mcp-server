#!/usr/bin/env node
/**
 * atlasent-change-sample — what a SOX change-management sample would find in
 * one repository's merged pull requests, as a report a person can open and
 * forward (a controller, an auditor, an engineering lead).
 *
 *   npx -y -p @atlasent/mcp-server@latest atlasent-change-sample <owner>/<repo>
 *       [--days 90] [--base <branch>] [--out <dir>] [--fail-on-findings]
 *
 * Reads merged pull requests, their reviews and the check runs on each merged
 * commit through GitHub's REST API with YOUR token (GH_TOKEN, GITHUB_TOKEN, or
 * `gh auth token`). It calls GitHub only: nothing is sent to AtlaSent, and the
 * token is never printed or written. Writes three files to --out (default:
 * the current directory):
 *
 *   atlasent-change-sample.html   self-contained, no external resources
 *   atlasent-change-sample.md     the same report as Markdown
 *   atlasent-change-sample.json   machine-readable (format change_sample.v1)
 *
 * Exit codes: 0 report written, 1 report written and --fail-on-findings found
 * changes that would fail, 2 no token or the repository could not be read,
 * 3 report written but INCOMPLETE (some reads failed; named in all outputs),
 * 64 usage. 3 takes precedence over 1.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  AUDITOR_QUESTION, FAILING, VERDICT_LABEL, buildReport, collect, renderMarkdown,
  type ChangeSampleReport, type Get,
} from "./changeSample.js";
import { esc, isEntryPoint } from "./exposureScanCli.js";
import { VERSION } from "./version.js";

export const EXIT = { OK: 0, FINDINGS: 1, CANNOT_READ: 2, INCOMPLETE: 3, USAGE: 64 } as const;

export interface CliArgs {
  repo: string;
  days: number;
  base?: string;
  out: string;
  failOnFindings: boolean;
}

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,255}$/;

export function parseArgs(argv: string[]): CliArgs | { error: string } | { help: true } {
  let repo: string | undefined;
  let days = 90;
  let base: string | undefined;
  let out = ".";
  let failOnFindings = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      return v === undefined || v.startsWith("--") ? undefined : v;
    };
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--fail-on-findings") failOnFindings = true;
    else if (a === "--days") {
      const v = next();
      const n = Number(v);
      if (!v || !Number.isInteger(n) || n < 1 || n > 366) return { error: "--days needs a whole number from 1 to 366" };
      days = n;
    } else if (a === "--base") {
      const v = next();
      if (!v || !BRANCH_RE.test(v)) return { error: "--base needs a branch name" };
      base = v;
    } else if (a === "--out") {
      const v = next();
      if (!v) return { error: "--out needs a directory" };
      out = v;
    } else if (a.startsWith("--")) return { error: `unknown option ${a}` };
    else if (repo === undefined) repo = a;
    else return { error: `unexpected argument ${a}` };
  }
  if (!repo) return { error: "name the repository as <owner>/<repo>" };
  if (!REPO_RE.test(repo)) return { error: `"${repo}" is not <owner>/<repo>` };
  return { repo, days, ...(base ? { base } : {}), out, failOnFindings };
}

/** The caller's GitHub token, from the environment or the GitHub CLI. Never logged. */
export function findToken(env: NodeJS.ProcessEnv = process.env, ghToken: () => string = () => execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })): string | undefined {
  const fromEnv = (env.GH_TOKEN || env.GITHUB_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const t = ghToken().trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

export function githubGet(token: string, apiBase = "https://api.github.com", fetchImpl: typeof fetch = fetch): Get {
  const root = apiBase.replace(/\/+$/, "");
  return async (path) => {
    try {
      const res = await fetchImpl(`${root}/${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": `atlasent-change-sample/${VERSION}`,
        },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, json };
    } catch {
      return { status: 0, json: null };
    }
  };
}

export function renderHtml(r: ChangeSampleReport): string {
  const s = r.summary;
  const tone = !r.complete ? "bad" : s.merged === 0 ? "warn" : s.would_fail > 0 ? "bad" : "ok";
  const failing = r.pulls.filter((p) => FAILING.includes(p.verdict));
  const unknown = r.pulls.filter((p) => p.verdict === "unknown");
  const stat = (n: number, label: string, t: string) => `<div class="stat ${t}"><div class="n">${n}</div><div class="l">${esc(label)}</div></div>`;
  const reasonRows = FAILING.filter((v) => s.by_verdict[v] > 0)
    .map((v) => `<tr><td>${esc(VERDICT_LABEL[v])}</td><td class="num">${s.by_verdict[v]}</td><td class="muted">${esc(AUDITOR_QUESTION[v] ?? "")}</td></tr>`)
    .join("");
  const row = (p: (typeof r.pulls)[number]) =>
    `<tr><td><a href="${esc(p.url)}">#${esc(p.number)}</a></td><td>${esc(p.title)}<div class="muted">${esc(p.detail)}</div></td><td class="muted">${esc(p.merged_at.slice(0, 10))}</td></tr>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Change sample · ${esc(r.repository)}</title>
<style>
:root{--brand:#176f68;--deep:#173c38;--ink:#14201f;--muted:#5b6b69;--line:#d9e3e1;--bg:#f5f8f7;--card:#fff;--bad:#b42318;--warn:#8a5a00;--ok:#146c43}
@media (prefers-color-scheme:dark){:root{--ink:#e6efed;--muted:#9fb3b0;--line:#2b3b39;--bg:#0f1716;--card:#16211f;--bad:#ff8a80;--warn:#f5c26b;--ok:#7fd8a6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{background:var(--deep);color:#fff;padding:28px 16px}.wrap{max-width:880px;margin:0 auto;padding:0 16px}header .wrap{padding:0}
.eyebrow{text-transform:uppercase;font-size:12px;letter-spacing:.12em;opacity:.8}h1{font-size:26px;margin:6px 0 4px;word-break:break-word}header p{margin:0;opacity:.85}
main{padding:24px 0 40px}section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:16px 0}h2{font-size:18px;margin:0 0 12px}
.headline{font-size:20px;font-weight:650;border-left:5px solid var(--bad);padding-left:12px}.headline.ok{border-color:var(--ok)}.headline.warn{border-color:var(--warn)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-top:16px}.stat{border:1px solid var(--line);border-radius:10px;padding:12px}
.stat .n{font-size:26px;font-weight:700}.stat .l{color:var(--muted);font-size:13px}.stat.bad .n{color:var(--bad)}.stat.warn .n{color:var(--warn)}.stat.ok .n{color:var(--ok)}
table{width:100%;border-collapse:collapse}td{border-top:1px solid var(--line);padding:8px 6px;vertical-align:top;font-size:14px}.num{text-align:right;font-weight:600}
.muted{color:var(--muted);font-size:13px}a{color:var(--brand)}ul{padding-left:20px}footer{color:var(--muted);font-size:12px;text-align:center;padding:0 16px 32px}
@media print{body{background:#fff}section{break-inside:avoid}}
</style>
</head>
<body>
<header><div class="wrap">
  <div class="eyebrow">AtlaSent · Change sample</div>
  <h1>${esc(r.repository)}</h1>
  <p>Generated ${esc(r.generated_at.slice(0, 16).replace("T", " "))} UTC · branch ${esc(r.base)} · last ${r.window_days} days · read from GitHub with your own login; nothing was sent to AtlaSent</p>
</div></header>
<main class="wrap">
${!r.complete ? `<section><p class="headline bad">INCOMPLETE SCAN: ${r.errors.length} read${r.errors.length === 1 ? "" : "s"} failed. The counts below cover only what could be read.</p><ul>${r.errors.map((e) => `<li>${esc(e.what)}: ${esc(e.error)}</li>`).join("")}</ul><p class="muted">Run the command again before relying on this result.</p></section>` : ""}
<section>
  <p class="headline ${tone}">${esc(r.headline)}</p>
  <div class="stats">
    ${stat(s.would_fail, "Would fail a sample", "bad")}
    ${stat(s.unknown, "Could not be determined", "warn")}
    ${stat(s.passed, "Approved by someone else, on the merged code", "ok")}
  </div>
  ${reasonRows ? `<table style="margin-top:16px">${reasonRows}</table>` : ""}
  <p class="muted" style="margin-top:14px">An auditor testing change management samples changes and asks whether each was approved, by someone other than its author, on the exact code that shipped. "Could not be determined" is never counted as a failure.</p>
</section>
${failing.length ? `<section><h2>Changes that would fail</h2><p class="muted">Each links to the pull request on GitHub, so anyone can check it.</p><table>${failing.map(row).join("")}</table></section>` : ""}
${unknown.length ? `<section><h2>Could not be determined</h2><table>${unknown.map(row).join("")}</table></section>` : ""}
<section>
  <h2>What this does not cover</h2>
  <p>It reads one repository's merged pull requests, reviews and checks. It cannot see:</p>
  <ul>${r.not_checked.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
  <p class="muted">It is not a compliance assessment or certification.</p>
</section>
<section>
  <h2>Next steps</h2>
  <p>Fix the process behind each failing change, then run this again. For a written assessment of one workflow, with prioritized fixes and a straight answer on whether AtlaSent fits, see the <a href="https://www.atlasent.io/production-change-audit?utm_source=change-sample&amp;utm_medium=cli">Production Change Control Audit</a>. You can attach this report to its intake, or keep it to yourself.</p>
</section>
</main>
<footer>AtlaSent · atlasent-change-sample ${esc(VERSION)} · report format change_sample.v1</footer>
</body>
</html>
`;
}

const USAGE = `atlasent-change-sample — what a change-management sample would find in one repository

  atlasent-change-sample <owner>/<repo> [--days 90] [--base <branch>] [--out <dir>] [--fail-on-findings]

Reads merged pull requests, reviews and checks from GitHub with your own token
(GH_TOKEN, GITHUB_TOKEN, or \`gh auth token\`). Calls GitHub only; nothing is
sent to AtlaSent. Writes atlasent-change-sample.{html,md,json} to --out
(default: the current directory).
`;

export interface MainDeps {
  env?: NodeJS.ProcessEnv;
  token?: () => string | undefined;
  get?: Get;
  now?: Date;
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const args = parseArgs(argv);
  if ("help" in args) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  if ("error" in args) {
    process.stderr.write(`${args.error}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  const env = deps.env ?? process.env;
  let get = deps.get;
  if (!get) {
    const token = (deps.token ?? (() => findToken(env)))();
    if (!token) {
      process.stderr.write("No GitHub token. Set GH_TOKEN, or sign in with `gh auth login`. The token is used only to read from GitHub.\n");
      return EXIT.CANNOT_READ;
    }
    get = githubGet(token, env.GITHUB_API_URL || "https://api.github.com");
  }
  const now = deps.now ?? new Date();
  const info = await get(`repos/${args.repo}`);
  const repoJson = info.json as { default_branch?: string; full_name?: string } | null;
  if (info.status !== 200 || !repoJson?.default_branch) {
    process.stderr.write(
      `Cannot read ${args.repo} (HTTP ${info.status || "network error"}). Check the name, and that your token can read this repository.\n`,
    );
    return EXIT.CANNOT_READ;
  }
  const base = args.base ?? repoJson.default_branch;
  const repo = repoJson.full_name ?? args.repo;
  const collected = await collect(get, repo, base, args.days, now);
  const report = buildReport(repo, base, args.days, collected, now);

  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });
  const files = {
    html: join(out, "atlasent-change-sample.html"),
    md: join(out, "atlasent-change-sample.md"),
    json: join(out, "atlasent-change-sample.json"),
  };
  writeFileSync(files.html, renderHtml(report));
  writeFileSync(files.md, renderMarkdown(report) + "\n");
  writeFileSync(files.json, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`${report.headline}\nReport: ${files.html}\n`);
  if (!report.complete) {
    process.stderr.write(`INCOMPLETE SCAN: ${report.errors.length} read(s) failed:\n` + report.errors.map((e) => `  ${e.what}: ${e.error}\n`).join(""));
    return EXIT.INCOMPLETE;
  }
  return args.failOnFindings && report.summary.would_fail > 0 ? EXIT.FINDINGS : EXIT.OK;
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { process.stderr.write(`atlasent-change-sample failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = EXIT.CANNOT_READ; },
  );
}
