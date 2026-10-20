/**
 * Change sample: what a SOX change-management sample would find in one
 * repository's merged pull requests.
 *
 * An auditor samples production changes and asks, for each one: was it
 * approved before it went live, by someone other than its author, and was the
 * approved code the code that merged? This module answers that from GitHub's
 * own records, one verdict per merged pull request.
 *
 * Rules that make the result safe to show an auditor:
 *  - Every verdict cites the pull request it came from.
 *  - Missing data is UNKNOWN, never a failure. A pull request whose reviews or
 *    checks could not be read is counted as unknown, and the scan as a whole
 *    is INCOMPLETE.
 *  - A bot's approval is not a human approval. A reviewer's later
 *    "changes requested" or dismissal cancels their earlier approval.
 *
 * Network: GitHub's REST API only, through the caller's `get`, with the
 * caller's own token. Nothing is sent to AtlaSent.
 */

export type Verdict =
  | "pass"
  | "no_human_approval"
  | "author_only_approval"
  | "approved_earlier_commit"
  | "checks_failed"
  | "unknown";

export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: "Approved by someone else, on the code that merged",
  no_human_approval: "Merged with no human approval",
  author_only_approval: "Approved only by its own author",
  approved_earlier_commit: "Approved on an earlier commit; code changed before merge, not re-approved",
  checks_failed: "Checks failed on the code that merged",
  unknown: "Could not be determined",
};

/** What an auditor would ask about each failing verdict. */
export const AUDITOR_QUESTION: Partial<Record<Verdict, string>> = {
  no_human_approval: "Who authorized this change?",
  author_only_approval: "Where is the independent review?",
  approved_earlier_commit: "Was the shipped code ever approved?",
  checks_failed: "Was the shipped code tested?",
};

export const FAILING: Verdict[] = ["no_human_approval", "author_only_approval", "approved_earlier_commit", "checks_failed"];

export interface Review {
  user: { login: string; type?: string } | null;
  state: string;
  commit_id?: string | null;
  submitted_at?: string | null;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PullInput {
  number: number;
  title: string;
  url: string;
  author: string;
  merged_at: string;
  merged_by: string | null;
  head_sha: string;
  /** null = could not be read. */
  reviews: Review[] | null;
  /** null = could not be read. [] = none ran. */
  checks: CheckRun[] | null;
}

export interface PullResult {
  number: number;
  title: string;
  url: string;
  author: string;
  merged_at: string;
  merged_by: string | null;
  verdict: Verdict;
  detail: string;
  human_approvers: string[];
  independent_approvers: string[];
  approved_head: boolean;
  checks: "passed" | "failed" | "none" | "unreadable";
}

function isBot(user: Review["user"]): boolean {
  if (!user) return true;
  return user.type === "Bot" || /\[bot\]$/i.test(user.login);
}

/**
 * Each human reviewer's standing review: their latest APPROVED,
 * CHANGES_REQUESTED or DISMISSED review. COMMENTED reviews do not change
 * standing. Returns only reviewers whose standing review is APPROVED.
 */
export function standingApprovals(reviews: Review[]): Review[] {
  const latest = new Map<string, { r: Review; i: number }>();
  reviews.forEach((r, i) => {
    if (isBot(r.user)) return;
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) return;
    const login = r.user!.login.toLowerCase();
    const prev = latest.get(login);
    const t = Date.parse(r.submitted_at ?? "");
    const pt = prev ? Date.parse(prev.r.submitted_at ?? "") : NaN;
    // Later submission wins; with no usable time, later in GitHub's order wins.
    if (!prev || (Number.isFinite(t) && Number.isFinite(pt) ? t >= pt : i > prev.i)) latest.set(login, { r, i });
  });
  return [...latest.values()].map((v) => v.r).filter((r) => r.state === "APPROVED");
}

export function checksState(checks: CheckRun[] | null): PullResult["checks"] {
  if (checks === null) return "unreadable";
  const done = checks.filter((c) => c.status === "completed");
  if (checks.length === 0) return "none";
  const bad = ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"];
  if (done.some((c) => c.conclusion !== null && bad.includes(c.conclusion))) return "failed";
  if (done.length < checks.length) return "unreadable";
  return "passed";
}

export function judge(p: PullInput): PullResult {
  const base = {
    number: p.number, title: p.title, url: p.url, author: p.author,
    merged_at: p.merged_at, merged_by: p.merged_by,
  };
  const checks = checksState(p.checks);
  if (p.reviews === null) {
    return { ...base, verdict: "unknown", detail: "Reviews could not be read.", human_approvers: [], independent_approvers: [], approved_head: false, checks };
  }
  const approvals = standingApprovals(p.reviews);
  const human = [...new Set(approvals.map((r) => r.user!.login))];
  const author = p.author.toLowerCase();
  const indep = approvals.filter((r) => r.user!.login.toLowerCase() !== author);
  const indepLogins = [...new Set(indep.map((r) => r.user!.login))];
  const onHead = indep.some((r) => r.commit_id === p.head_sha);
  const out = (verdict: Verdict, detail: string): PullResult => ({
    ...base, verdict, detail, human_approvers: human, independent_approvers: indepLogins, approved_head: onHead, checks,
  });
  if (human.length === 0) return out("no_human_approval", "No standing human approval when it merged.");
  if (indep.length === 0) return out("author_only_approval", `Only its author (${p.author}) approved it.`);
  if (!onHead) {
    const shas = [...new Set(indep.map((r) => (r.commit_id ?? "").slice(0, 7)).filter(Boolean))];
    return out(
      "approved_earlier_commit",
      `Approved on ${shas.join(", ") || "an earlier commit"}; merged as ${p.head_sha.slice(0, 7)} with no approval on that commit.`,
    );
  }
  if (checks === "failed") return out("checks_failed", "At least one check failed on the merged commit.");
  return out("pass", `Approved by ${indepLogins.join(", ")} on ${p.head_sha.slice(0, 7)}, the code that merged.`);
}

// ---------------------------------------------------------------------------
// Collection from GitHub
// ---------------------------------------------------------------------------

export interface GetResult { status: number; json: unknown }
export type Get = (path: string) => Promise<GetResult>;

export interface ScanError { what: string; error: string }

export interface Collected {
  pulls: PullInput[];
  errors: ScanError[];
  /** True when the window may hold more merged pull requests than were read. */
  truncated: boolean;
}

const PAGE = 100;
export const MAX_PULLS = 1000;

async function pages<T>(get: Get, path: string, max = 20): Promise<{ items: T[]; error?: string }> {
  const items: T[] = [];
  for (let page = 1; page <= max; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await get(`${path}${sep}per_page=${PAGE}&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.json)) return { items, error: `HTTP ${r.status} on ${path}` };
    items.push(...(r.json as T[]));
    if ((r.json as T[]).length < PAGE) return { items };
  }
  return { items, error: `more than ${max} pages on ${path}; not all were read` };
}

interface ApiPull {
  number: number; title: string; html_url: string; merged_at: string | null; updated_at: string;
  user: { login: string } | null; head: { sha: string }; merge_commit_sha?: string | null;
}

/**
 * Merged pull requests into `base` within `days`, with their reviews and the
 * check runs on each pull request's head commit. Every read that fails is
 * recorded in `errors` and leaves that pull request's field null.
 */
export async function collect(get: Get, repo: string, base: string, days: number, now: Date): Promise<Collected> {
  const since = now.getTime() - days * 86_400_000;
  const errors: ScanError[] = [];
  const merged: ApiPull[] = [];
  let truncated = false;
  // Sorted by updated time, newest first: a pull request merged in the window
  // was updated at or after its merge, so paging stops once updates fall
  // before the window.
  for (let page = 1; ; page++) {
    const r = await get(`repos/${repo}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=${PAGE}&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.json)) {
      errors.push({ what: "pull request list", error: `HTTP ${r.status}` });
      break;
    }
    const batch = r.json as ApiPull[];
    for (const p of batch) if (p.merged_at && Date.parse(p.merged_at) >= since) merged.push(p);
    const oldest = batch.length ? Date.parse(batch[batch.length - 1].updated_at) : 0;
    if (batch.length < PAGE || oldest < since) break;
    if (merged.length >= MAX_PULLS) { truncated = true; break; }
  }
  const pulls: PullInput[] = [];
  for (const p of merged.slice(0, MAX_PULLS)) {
    const rv = await pages<Review>(get, `repos/${repo}/pulls/${p.number}/reviews`);
    if (rv.error) errors.push({ what: `#${p.number} reviews`, error: rv.error });
    let checks: CheckRun[] | null = null;
    const cr = await get(`repos/${repo}/commits/${p.head.sha}/check-runs?per_page=${PAGE}`);
    const body = cr.json as { total_count?: number; check_runs?: CheckRun[] } | null;
    if (cr.status === 200 && body && Array.isArray(body.check_runs)) {
      if ((body.total_count ?? 0) > body.check_runs.length) errors.push({ what: `#${p.number} checks`, error: `more than ${PAGE} check runs; not all were read` });
      else checks = body.check_runs;
    } else {
      errors.push({ what: `#${p.number} checks`, error: `HTTP ${cr.status}` });
    }
    const full = await get(`repos/${repo}/pulls/${p.number}`);
    const mergedBy = full.status === 200 ? ((full.json as { merged_by?: { login: string } | null }).merged_by?.login ?? null) : null;
    pulls.push({
      number: p.number,
      title: p.title,
      url: p.html_url,
      author: p.user?.login ?? "(unknown)",
      merged_at: p.merged_at!,
      merged_by: mergedBy,
      head_sha: p.head.sha,
      reviews: rv.error ? null : rv.items,
      checks,
    });
  }
  return { pulls, errors, truncated };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ChangeSampleReport {
  format: "change_sample.v1";
  repository: string;
  base: string;
  window_days: number;
  generated_at: string;
  complete: boolean;
  summary: {
    merged: number;
    would_fail: number;
    unknown: number;
    passed: number;
    by_verdict: Record<Verdict, number>;
  };
  headline: string;
  pulls: PullResult[];
  errors: ScanError[];
  not_checked: string[];
}

export const NOT_CHECKED = [
  "Approvals given outside GitHub (tickets, chat, email, a change-advisory board).",
  "Changes that reached production without a pull request: direct pushes, hotfixes from a laptop, console changes, other repositories.",
  "Whether the merged code was what was actually deployed, and when.",
  "Branch-protection settings and who can bypass them. They live in repository settings this command does not read.",
  "Whether a reviewer was authorized to approve under your policy. GitHub records who approved, not whether they were allowed to.",
  "Whether your auditor will accept this as evidence. That is their judgment.",
];

export function buildReport(repo: string, base: string, days: number, c: Collected, now: Date): ChangeSampleReport {
  const pulls = c.pulls.map(judge).sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at));
  const by = Object.fromEntries((Object.keys(VERDICT_LABEL) as Verdict[]).map((v) => [v, 0])) as Record<Verdict, number>;
  for (const p of pulls) by[p.verdict]++;
  const wouldFail = FAILING.reduce((n, v) => n + by[v], 0);
  const complete = c.errors.length === 0 && !c.truncated;
  const n = pulls.length;
  const headline =
    n === 0
      ? `No pull requests were merged into ${base} in the last ${days} days.`
      : `${wouldFail} of ${n} merged change${n === 1 ? "" : "s"} would fail a change-management sample.`;
  const errors = [...c.errors];
  if (c.truncated) errors.push({ what: "pull request list", error: `more than ${MAX_PULLS} merged pull requests in the window; only the newest ${MAX_PULLS} were read` });
  return {
    format: "change_sample.v1",
    repository: repo,
    base,
    window_days: days,
    generated_at: now.toISOString(),
    complete,
    summary: { merged: n, would_fail: wouldFail, unknown: by.unknown, passed: by.pass, by_verdict: by },
    headline,
    pulls,
    errors,
    not_checked: NOT_CHECKED,
  };
}

export function renderMarkdown(r: ChangeSampleReport): string {
  const lines: string[] = [];
  lines.push(`# Change sample: ${r.repository}`, "");
  lines.push(`Generated ${r.generated_at.slice(0, 16).replace("T", " ")} UTC · branch \`${r.base}\` · last ${r.window_days} days · read from GitHub with your own login; nothing was sent to AtlaSent.`, "");
  if (!r.complete) {
    lines.push(`**INCOMPLETE SCAN.** ${r.errors.length} read${r.errors.length === 1 ? "" : "s"} failed. The counts below cover only what could be read; do not rely on them until the scan is run again.`, "");
    for (const e of r.errors) lines.push(`- ${e.what}: ${e.error}`);
    lines.push("");
  }
  lines.push(`## ${r.headline}`, "");
  if (r.summary.merged > 0) {
    lines.push("| Why | Count | What an auditor would ask |", "|---|---|---|");
    for (const v of FAILING) if (r.summary.by_verdict[v]) lines.push(`| ${VERDICT_LABEL[v]} | ${r.summary.by_verdict[v]} | ${AUDITOR_QUESTION[v]} |`);
    lines.push(`| ${VERDICT_LABEL.unknown} (not counted as failures) | ${r.summary.unknown} | |`);
    lines.push(`| ${VERDICT_LABEL.pass} | ${r.summary.passed} | |`, "");
  }
  const failing = r.pulls.filter((p) => FAILING.includes(p.verdict));
  if (failing.length) {
    lines.push("## Changes that would fail", "");
    for (const p of failing) lines.push(`- [#${p.number}](${p.url}) ${p.title.replace(/[[\]]/g, "")} (${p.merged_at.slice(0, 10)}): ${VERDICT_LABEL[p.verdict]}. ${p.detail}`);
    lines.push("");
  }
  const unknown = r.pulls.filter((p) => p.verdict === "unknown");
  if (unknown.length) {
    lines.push("## Could not be determined", "");
    for (const p of unknown) lines.push(`- [#${p.number}](${p.url}): ${p.detail}`);
    lines.push("");
  }
  lines.push("## What this does not cover", "", "This reads one repository's merged pull requests, reviews and checks. It cannot see:", "");
  for (const n of r.not_checked) lines.push(`- ${n}`);
  lines.push("", "It is not a compliance assessment or certification.");
  return lines.join("\n");
}
