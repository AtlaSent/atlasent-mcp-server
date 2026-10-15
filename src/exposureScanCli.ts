#!/usr/bin/env node
/**
 * atlasent-exposure-scan — the free Authorization Exposure Review, as one
 * command against a real checkout, producing a report a person can open and
 * forward (a CISO, an auditor, an engineering lead).
 *
 *   npx -y -p @atlasent/mcp-server@latest atlasent-exposure-scan [repo-dir]
 *       [--out <dir>] [--fail-on-gaps]
 *
 * Reads <repo-dir>/.github/workflows/*.yml|*.yaml, runs the same offline
 * analysis as atlasent_exposure_review (analyzeWorkflows +
 * renderExposureReview), and writes three files to --out (default: cwd):
 *
 *   atlasent-exposure-review.html   self-contained, no external resources
 *   atlasent-exposure-review.md     the same review as Markdown
 *   atlasent-exposure-review.json   the machine-readable evidence-gap report
 *
 * Offline and read-only: no network call, no API key, nothing leaves the
 * machine. The report states its own scope (these files only), exactly as the
 * MCP tool does; it is never an assessment of the reader's whole posture.
 *
 * Exit codes: 0 report written, 1 report written and --fail-on-gaps found
 * gaps, 2 no workflow files found, 3 report written but the scan is
 * INCOMPLETE (a workflow file could not be listed, read or parsed; the files
 * are named in all three outputs), 64 usage. 3 takes precedence over 1.
 *
 * Completeness (#261): every *.yml/*.yaml under .github/workflows is read.
 * There is no file-count cap. A file that cannot be read is never skipped
 * quietly: the scan keeps every other finding and ends non-zero.
 */

import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { analyzeWorkflows, type EvidenceGapReport, type Finding, type WorkflowInput } from "./evidenceGap.js";
import { HELP_NOTE, REVIEW_SIGN_UP_URL, helpUrl, renderExposureReview } from "./exposureReview.js";
import { VERSION } from "./version.js";

export const EXIT = { OK: 0, GAPS: 1, NO_WORKFLOWS: 2, INCOMPLETE: 3, USAGE: 64 } as const;
const MAX_FILE_BYTES = 256 * 1024;

export interface CliArgs {
  dir: string;
  out: string;
  failOnGaps: boolean;
}

export function parseArgs(argv: string[]): CliArgs | { error: string } | { help: true } {
  let dir: string | undefined;
  let out: string | undefined;
  let failOnGaps = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--fail-on-gaps") failOnGaps = true;
    else if (a === "--out") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: "--out needs a directory" };
      out = v;
    } else if (a.startsWith("--")) return { error: `unknown option ${a}` };
    else if (dir === undefined) dir = a;
    else return { error: `unexpected argument ${a}` };
  }
  return { dir: dir ?? ".", out: out ?? ".", failOnGaps };
}

export interface ScanError {
  path: string;
  error: string;
}

export interface Collected {
  inputs: WorkflowInput[];
  /** Workflow files found, whether or not they could be read. */
  discovered: number;
  /** Files (or the directory) that could not be listed or read. */
  errors: ScanError[];
}

function errText(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return code && !msg.startsWith(code) ? `${code}: ${msg}` : msg;
}

/**
 * Every workflow file under <dir>/.github/workflows, sorted. Exhaustive: no
 * count cap. A file that cannot be stat'ed or read, or is over the size
 * limit, is an error, never a silent skip.
 */
export function collectWorkflows(dir: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): Collected {
  const wfDir = join(dir, ".github", "workflows");
  let names: string[];
  try {
    names = readdirSync(wfDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { inputs: [], discovered: 0, errors: [] };
    return { inputs: [], discovered: 0, errors: [{ path: ".github/workflows", error: `cannot list directory: ${errText(e)}` }] };
  }
  const inputs: WorkflowInput[] = [];
  const errors: ScanError[] = [];
  let discovered = 0;
  for (const name of names.filter((n) => /\.ya?ml$/i.test(n)).sort()) {
    const path = `.github/workflows/${name}`;
    const full = join(wfDir, name);
    let st;
    try {
      st = statSync(full);
    } catch (e) {
      // A broken symlink, for example: a workflow that was not read.
      discovered++;
      errors.push({ path, error: `cannot read: ${errText(e)}` });
      continue;
    }
    if (st.isDirectory()) continue;
    discovered++;
    if (!st.isFile()) {
      errors.push({ path, error: "not a regular file; not read" });
      continue;
    }
    if (st.size > MAX_FILE_BYTES) {
      errors.push({ path, error: `larger than ${MAX_FILE_BYTES / 1024} KB; not read` });
      continue;
    }
    try {
      inputs.push({ path, content: read(full) });
    } catch (e) {
      errors.push({ path, error: `cannot read: ${errText(e)}` });
    }
  }
  return { inputs, discovered, errors };
}

// ---------------------------------------------------------------------------
// HTML. Every value that came from a workflow file is untrusted: escape all of
// it. The page loads nothing external (no fonts, images or scripts), so it
// opens offline and in locked-down mail viewers.
// ---------------------------------------------------------------------------

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STATUS: Record<Finding["status"], { label: string; tone: "bad" | "warn" | "ok" }> = {
  ungoverned: { label: "No gate", tone: "bad" },
  weak: { label: "Gate cannot stop it", tone: "bad" },
  gated: { label: "Gated, not bound", tone: "warn" },
  gated_upstream: { label: "Gated in an earlier job", tone: "warn" },
  bound: { label: "Gated and bound", tone: "ok" },
};

const CATEGORY: Record<Finding["category"], string> = {
  deploy: "Production deploy",
  publish: "Package or image publish",
  migrate: "Database migration",
  infrastructure: "Infrastructure change",
  unknown: "Command built at run time",
};

export interface HtmlMeta {
  target: string;
  generatedAt: string;
  /** Present when the scan is incomplete: the files that were not covered. */
  incomplete?: ScanError[];
}

function where(f: Finding): string {
  return `<code>${esc(f.workflow)}${f.line ? `:${esc(f.line)}` : ""}</code> · job <code>${esc(f.job)}</code> · step “${esc(f.step)}”`;
}

export function renderHtml(report: EvidenceGapReport, meta: HtmlMeta): string {
  const s = report.summary;
  const gaps = report.findings.filter((f) => f.status === "ungoverned" || f.status === "weak");
  const covered = report.findings.filter((f) => f.status !== "ungoverned" && f.status !== "weak");

  const headline =
    report.findings.length === 0
      ? `No production-changing steps were recognized in ${s.workflows_scanned} workflow file${s.workflows_scanned === 1 ? "" : "s"}.`
      : s.gaps > 0
        ? `${s.gaps} of ${s.consequential_steps} production-changing step${s.consequential_steps === 1 ? "" : "s"} can run with no approval that could stop ${s.gaps === 1 ? "it" : "them"}.`
        : `All ${s.consequential_steps} production-changing step${s.consequential_steps === 1 ? " has" : "s have"} a gate in front.`;
  const incomplete = meta.incomplete ?? [];
  const headTone = incomplete.length > 0 ? "bad" : report.findings.length === 0 ? "warn" : s.gaps > 0 ? "bad" : "ok";

  const stat = (n: number, label: string, tone: string) =>
    `<div class="stat ${tone}"><div class="n">${n}</div><div class="l">${esc(label)}</div></div>`;

  const gapCards = gaps
    .map((f, i) => {
      const fx = f.fix;
      return `<article class="finding">
  <div class="fhead"><span class="pill bad">${esc(STATUS[f.status].label)}</span><h3>${i + 1}. ${esc(CATEGORY[f.category])}</h3></div>
  <p class="where">${where(f)}</p>
  <p><strong>Why it matters:</strong> ${esc(f.reason)}</p>
  ${f.confidence === "possible" ? `<p class="muted">Confidence: possible. ${esc(possibleNote(f))}</p>` : ""}
  ${fx?.gate_step ? `<p><strong>Fix: add this step before it</strong></p><pre>${esc(fx.gate_step.trimEnd())}</pre>` : ""}
  ${fx?.bind_if ? `<p><strong>Then give the step this condition:</strong> <code>${esc(fx.bind_if)}</code></p>` : ""}
  ${fx?.change ? `<p><strong>Change:</strong> ${esc(fx.change)}</p>` : ""}
  ${fx?.job_permissions ? `<p><strong>Job permissions:</strong> <code>${esc(fx.job_permissions)}</code></p>` : ""}
  ${fx?.note ? `<p class="muted">${esc(fx.note)}</p>` : ""}
</article>`;
    })
    .join("\n");

  const coveredRows = covered
    .map(
      (f) =>
        `<tr><td><span class="pill ${STATUS[f.status].tone}">${esc(STATUS[f.status].label)}</span></td><td>${esc(CATEGORY[f.category])}</td><td>${where(f)}</td></tr>`,
    )
    .join("\n");

  const unreadable = report.parse_errors.map((e) => `${e.workflow}${e.line ? ` line ${e.line}` : ""}: ${e.error}`);

  const offerHelp = s.gaps > 0 || report.findings.length === 0;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorization Exposure Review · ${esc(meta.target)}</title>
<style>
:root{--brand:#176f68;--deep:#173c38;--ink:#14201f;--muted:#5b6b69;--line:#d9e3e1;--bg:#f5f8f7;--card:#fff;--bad:#b42318;--badbg:#fdecea;--warn:#8a5a00;--warnbg:#fff4dc;--ok:#146c43;--okbg:#e5f5ec}
@media (prefers-color-scheme:dark){:root{--ink:#e6efed;--muted:#9fb3b0;--line:#2b3b39;--bg:#0f1716;--card:#16211f;--badbg:#3a1714;--bad:#ff8a80;--warnbg:#3a2c0d;--warn:#f5c26b;--okbg:#10301f;--ok:#7fd8a6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.bar{height:6px;background:var(--brand)}header{background:var(--deep);color:#fff;padding:28px 16px}
.wrap{max-width:880px;margin:0 auto;padding:0 16px}header .wrap{padding:0}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.02em}.tile{width:28px;height:28px;border-radius:7px;background:var(--brand);display:inline-flex;align-items:center;justify-content:center;font-size:15px}
.eyebrow{text-transform:uppercase;font-size:12px;letter-spacing:.12em;opacity:.8;margin-top:18px}
h1{font-size:28px;line-height:1.2;margin:6px 0 4px}header p{margin:0;opacity:.85}
main{padding:24px 0 40px}section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:16px 0}
h2{font-size:18px;margin:0 0 12px}h3{font-size:16px;margin:0}
.headline{font-size:20px;font-weight:650;border-left:5px solid var(--bad);padding-left:12px}.headline.ok{border-color:var(--ok)}.headline.warn{border-color:var(--warn)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-top:16px}
.stat{border:1px solid var(--line);border-radius:10px;padding:12px}.stat .n{font-size:26px;font-weight:700}.stat .l{color:var(--muted);font-size:13px}
.stat.bad .n{color:var(--bad)}.stat.warn .n{color:var(--warn)}.stat.ok .n{color:var(--ok)}
.finding{border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}.fhead{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;white-space:nowrap}
.pill.bad{background:var(--badbg);color:var(--bad)}.pill.warn{background:var(--warnbg);color:var(--warn)}.pill.ok{background:var(--okbg);color:var(--ok)}
.where{color:var(--muted);font-size:13px;word-break:break-word}code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-word}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
table{width:100%;border-collapse:collapse}td{border-top:1px solid var(--line);padding:8px 6px;vertical-align:top;font-size:14px}
.muted{color:var(--muted)}ul{padding-left:20px}a{color:var(--brand)}
.cta{display:inline-block;background:var(--brand);color:#fff;text-decoration:none;font-weight:600;border-radius:8px;padding:10px 16px;margin:6px 8px 6px 0}
footer{color:var(--muted);font-size:12px;text-align:center;padding:0 16px 32px}
@media print{body{background:#fff}section{break-inside:avoid}.cta{border:1px solid var(--brand)}}
</style>
</head>
<body>
<div class="bar"></div>
<header><div class="wrap">
  <div class="brand"><span class="tile">A</span>AtlaSent</div>
  <div class="eyebrow">Authorization Exposure Review</div>
  <h1>${esc(meta.target)}</h1>
  <p>Generated ${esc(meta.generatedAt)} · ${s.workflows_scanned} workflow file${s.workflows_scanned === 1 ? "" : "s"} read · offline, nothing was sent anywhere</p>
</div></header>
<main class="wrap">
${
  incomplete.length
    ? `<section><p class="headline bad">INCOMPLETE SCAN: ${incomplete.length} workflow file${incomplete.length === 1 ? "" : "s"} could not be read. This review does not cover the whole repository.</p><ul>${incomplete.map((e) => `<li><code>${esc(e.path)}</code>: ${esc(e.error)}</li>`).join("")}</ul><p class="muted">Every other file was still analyzed below. Fix these files and run the scan again before relying on the result.</p></section>`
    : ""
}
<section>
  <p class="headline ${headTone}">${esc(headline)}</p>
  <div class="stats">
    ${stat(s.by_status.ungoverned, "No gate", "bad")}
    ${stat(s.by_status.weak, "Gate cannot stop it", "bad")}
    ${stat(s.by_status.gated + s.by_status.gated_upstream, "Gated, not bound", "warn")}
    ${stat(s.by_status.bound, "Gated and bound", "ok")}
  </div>
  <p class="muted" style="margin-top:14px">A <strong>production-changing step</strong> is a deploy, publish, database migration or infrastructure apply in your CI. <strong>Gated and bound</strong> means it runs only after an authorization check that can stop it, and only on the exact change that was approved.</p>
</section>
${
  gaps.length
    ? `<section><h2>What to fix</h2><p class="muted">Each item is a step that can change a real system today with nothing able to stop it. The fix is shown for each one.</p>${gapCards}</section>`
    : ""
}
${covered.length ? `<section><h2>Already gated</h2><table>${coveredRows}</table></section>` : ""}
${
  unreadable.length
    ? `<section><h2>Not read</h2><ul>${unreadable.map((u) => `<li><code>${esc(u)}</code></li>`).join("")}</ul><p class="muted">No conclusion is drawn about these files.</p></section>`
    : ""
}
<section>
  <h2>What this review covers, and what it does not</h2>
  <p>It covers the CI workflow files in this repository only. It is <strong>not</strong> an assessment of your organization's authorization posture. It cannot see:</p>
  <ul>${report.not_checked.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
</section>
<section>
  <h2>Next steps</h2>
  ${
    s.gaps > 0
      ? `<p><strong>Fix it yourself.</strong> Create a free AtlaSent account and API key, add it as the <code>ATLASENT_API_KEY</code> repository secret, make each change above, then run this scan again.</p>
  <a class="cta" href="${esc(REVIEW_SIGN_UP_URL)}">Create a free account</a>`
      : `<p><strong>Keep it that way.</strong> Run this scan again whenever a workflow changes, or add it to CI with <code>--fail-on-gaps</code>.</p>`
  }
  ${
    offerHelp
      ? `<p style="margin-top:14px"><strong>Want help?</strong> An independent implementation advisor can <a href="${esc(helpUrl("explain", s.gaps))}">walk you through these findings</a> or <a href="${esc(helpUrl("rollout", s.gaps))}">roll the gates out with you</a>.</p><p class="muted">${esc(HELP_NOTE)}</p>`
      : ""
  }
</section>
</main>
<footer>AtlaSent · execution-time authorization · atlasent-exposure-scan ${esc(VERSION)} · report format exposure_review.v1</footer>
</body>
</html>
`;
}

const USAGE = `atlasent-exposure-scan — free Authorization Exposure Review (offline)

  atlasent-exposure-scan [repo-dir] [--out <dir>] [--fail-on-gaps]

Reads <repo-dir>/.github/workflows and writes atlasent-exposure-review.{html,md,json}
to --out (default: the current directory). No network call, no API key.
`;

function possibleNote(f: Finding): string {
  return f.category === "unknown"
    ? "The command is chosen at run time, so what it runs is not known."
    : "A script is called and its contents were not read.";
}

export function main(argv: string[], now: Date = new Date()): number {
  const args = parseArgs(argv);
  if ("help" in args) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  if ("error" in args) {
    process.stderr.write(`${args.error}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  const dir = resolve(args.dir);
  const collected = collectWorkflows(dir);
  const { inputs } = collected;
  if (inputs.length === 0 && collected.errors.length === 0) {
    process.stderr.write(
      `No workflow files found in ${join(dir, ".github", "workflows")}. Run this from a repository checkout, or pass its path.\n`,
    );
    return EXIT.NO_WORKFLOWS;
  }

  const report = analyzeWorkflows(inputs);
  // Files that could not be read join the files that could not be parsed:
  // either way the scan did not cover them, and the result must say so.
  for (const e of collected.errors) report.parse_errors.push({ workflow: e.path, line: 0, error: e.error });
  report.summary.workflows_unreadable = report.parse_errors.length;
  const incomplete: ScanError[] = report.parse_errors.map((e) => ({
    path: e.workflow,
    error: `${e.line ? `line ${e.line}: ` : ""}${e.error}`,
  }));
  const scan = {
    complete: incomplete.length === 0,
    files_discovered: collected.discovered,
    files_read: inputs.length,
    files_analyzed: report.summary.workflows_scanned,
    errors: incomplete,
  };
  if (!scan.complete) {
    report.next_step =
      `INCOMPLETE SCAN: ${incomplete.length} workflow file${incomplete.length === 1 ? "" : "s"} could not be read ` +
      `(${incomplete.map((e) => e.path).join(", ")}). Every other file was analyzed; no conclusion is drawn about ` +
      "the repository as a whole until these are fixed and the scan is run again.";
  }
  const review = renderExposureReview(report, scan.complete ? undefined : { incomplete });
  const html = renderHtml(report, {
    target: basename(dir),
    generatedAt: now.toISOString().replace("T", " ").slice(0, 16) + " UTC",
    ...(scan.complete ? {} : { incomplete }),
  });

  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });
  const files = {
    html: join(out, "atlasent-exposure-review.html"),
    md: join(out, "atlasent-exposure-review.md"),
    json: join(out, "atlasent-exposure-review.json"),
  };
  writeFileSync(files.html, html);
  writeFileSync(files.md, review.markdown + "\n");
  writeFileSync(files.json, JSON.stringify({ ...report, scan }, null, 2) + "\n");

  const s = report.summary;
  process.stdout.write(
    `${s.workflows_scanned} workflow files, ${s.consequential_steps} production-changing steps, ${s.gaps} with no gate that can stop them.\n` +
      `Report: ${files.html}\n`,
  );
  if (!scan.complete) {
    process.stderr.write(
      `INCOMPLETE SCAN: ${incomplete.length} workflow file(s) could not be read:\n` +
        incomplete.map((e) => `  ${e.path}: ${e.error}\n`).join(""),
    );
    return EXIT.INCOMPLETE;
  }
  return args.failOnGaps && s.gaps > 0 ? EXIT.GAPS : EXIT.OK;
}

/**
 * True when `argv1` is this module. npm and npx start a bin through a link
 * (node_modules/.bin/atlasent-exposure-scan -> ../@atlasent/mcp-server/dist/
 * exposureScanCli.js), so argv[1] is the link while import.meta.url is the
 * resolved file. Comparing them unresolved made 2.19.0 exit 0 having done
 * nothing. Resolve the link first.
 */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
