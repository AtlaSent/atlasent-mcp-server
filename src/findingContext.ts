/**
 * What a finding can touch, and how urgent it is: the target environment, what
 * starts the workflow, which secrets the step can read, a priority built from
 * those, and the root cause a gap shares with other gaps.
 *
 * Everything here is read from the workflow file and nothing else. Each value
 * carries the text it was derived from (`source`, `factors`) so a reader can
 * check it, and anything that cannot be read from the file is "unknown", never
 * a guess in the reassuring direction: an undetermined environment ranks above
 * staging, not below it.
 */

import type { Category } from "./evidenceGap.js";

// The YAML subset parser's value shape (evidenceGap.ts), restated structurally
// so this module stays free of a runtime import cycle.
type YValue = string | YValue[] | { [k: string]: YValue };
type YMap = { [k: string]: YValue };

export type Environment = "production" | "non_production" | "unknown";

export interface EnvironmentInfo {
  value: Environment;
  /** Where the value came from, e.g. `job environment "production"`. */
  source: string;
}

export type TriggerKind = "automatic" | "external" | "called" | "manual" | "unknown";

export interface TriggerInfo {
  kind: TriggerKind;
  /** The workflow's `on:` events. */
  events: string[];
  /** Set when a job or step condition narrowed the workflow's triggers. */
  narrowed_by?: string;
}

export type PriorityLabel = "critical" | "high" | "medium" | "low";

export interface Priority {
  label: PriorityLabel;
  /** 0–100. Higher means fix sooner. */
  score: number;
  /** Why, in the order they were weighed. */
  factors: string[];
}

export type CauseKind =
  | "no_gate"
  | "gate_skippable"
  | "gate_advisory"
  | "gate_issues_only"
  | "runs_after_failure"
  | "upstream_gate_weak"
  | "upstream_after_failure";

export interface Cause {
  id: string;
  kind: CauseKind;
  title: string;
  detail: string;
  workflow: string;
  job: string;
  /** The gate step at fault, when one exists. */
  gate?: { job: string; step?: string; line?: number };
  /** One change that closes every finding of this cause, when there is one. */
  fix_once?: string;
  /** Indexes into the report's `findings`, highest priority first. */
  findings: number[];
  /** The highest priority among them. */
  priority: Priority;
  environments: Record<Environment, number>;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const PRE_PROD = /(?:^|[^a-z0-9])pre-?prod(?:uction)?(?:$|[^a-z0-9])/i;
const PROD = /(?:^|[^a-z0-9])(?:prod|production|prd|live)(?:$|[^a-z0-9])/i;
const NON_PROD =
  /(?:^|[^a-z0-9])(?:stag|stage|staging|uat|qa|dev|develop|development|test|testing|sandbox|preview|canary|nonprod|non-prod)(?:$|[^a-z0-9])/i;

/** production / non_production from a name, or null when the name says neither. */
export function classifyName(text: string): Environment | null {
  if (PRE_PROD.test(text)) return "non_production";
  if (PROD.test(text)) return "production";
  if (NON_PROD.test(text)) return "non_production";
  return null;
}

function envName(v: YValue | undefined): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as YMap).name === "string") {
    return ((v as YMap).name as string).trim() || null;
  }
  return null;
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * The environment a step changes, from the most to the least specific place
 * that names it: the job's GitHub `environment:`, the step's `with.environment`,
 * the job id and `name:`, the step name, then the workflow file name. A job or
 * step environment chosen at run time (`${{ ... }}`) stops the search: the
 * names around it do not decide where it goes.
 */
export function environmentOf(job: YMap, jobId: string, step: YMap, workflowPath: string): EnvironmentInfo {
  const jobEnv = envName(job.environment);
  if (jobEnv !== null) {
    if (jobEnv.includes("${{")) return { value: "unknown", source: "the job's environment is chosen at run time" };
    const c = classifyName(jobEnv);
    if (c) return { value: c, source: `job environment "${jobEnv}"` };
  }
  const w = step.with && typeof step.with === "object" && !Array.isArray(step.with) ? (step.with as YMap) : {};
  // Same rule for the step's own `with.environment`: chosen at run time, it can
  // be production whatever the job or file is called.
  if (typeof w.environment === "string" && w.environment.includes("${{")) {
    return { value: "unknown", source: "the step's environment input is chosen at run time" };
  }
  const candidates: Array<[string | null, string]> = [
    [typeof w.environment === "string" ? w.environment : null, "step input environment"],
    [jobId, "job"],
    [typeof job.name === "string" ? job.name : null, "job name"],
    [typeof step.name === "string" ? step.name : null, "step name"],
    [fileName(workflowPath), "workflow file"],
  ];
  for (const [text, where] of candidates) {
    if (!text) continue;
    const c = classifyName(text);
    if (c) return { value: c, source: `${where} "${text}"` };
  }
  return { value: "unknown", source: "nothing in the workflow names the environment" };
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

// The only events that are not "something happened, so it runs": started by
// hand, by an API call, or by another workflow. Every other `on:` event is
// event-driven and counts as automatic, including ones not listed anywhere
// here (`workflow_job`, `image_version`, events GitHub adds later): an
// unrecognized trigger ranks as automatic, never below it.
const NON_AUTOMATIC_EVENTS = new Set(["workflow_dispatch", "repository_dispatch", "workflow_call"]);

function isAutomaticEvent(e: string): boolean {
  return !NON_AUTOMATIC_EVENTS.has(e);
}

const DISPATCH_EQ = /^(?:github\.event_name\s*==\s*(['"])workflow_dispatch\1|(['"])workflow_dispatch\2\s*==\s*github\.event_name)$/;

function stripOuterParens(t: string): string {
  let s = t.trim();
  for (;;) {
    if (!(s.startsWith("(") && s.endsWith(")"))) return s;
    // Only strip a pair that encloses the whole expression.
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
      if (depth === 0 && i < s.length - 1) return s;
    }
    s = s.slice(1, -1).trim();
  }
}

/**
 * Splits an expression on a top-level operator (`&&` or `||`), ignoring any
 * inside parentheses or quoted strings.
 */
function splitTopLevel(expr: string, op: "&&" | "||"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(start, i));
      start = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

/** True when `expr` can only be true if `github.event_name == 'workflow_dispatch'`. */
function exprRequiresDispatch(expr: string): boolean {
  const e = stripOuterParens(expr);
  // `&&` binds tighter than `||`, so a top-level `||` is the outermost
  // operator: the condition requires dispatch only if every branch does.
  // `dispatch && x || push` can run on push; `dispatch && a || dispatch && b`
  // cannot.
  const branches = splitTopLevel(e, "||");
  if (branches.length > 1) return branches.every(exprRequiresDispatch);
  const conjuncts = splitTopLevel(e, "&&").map(stripOuterParens);
  if (conjuncts.length === 1) {
    // Anchored: a negation (`!x`, `!(x)`) never matches, whatever it wraps.
    return DISPATCH_EQ.test(conjuncts[0]);
  }
  // One required, positive conjunct is enough; negations in the others
  // (`... && !inputs.skip`) only narrow it further.
  return conjuncts.some(exprRequiresDispatch);
}

/**
 * True only when the condition REQUIRES `github.event_name ==
 * 'workflow_dispatch'`: the comparison is a positive conjunct of the
 * condition (through any grouping parentheses), with no `||` alternative at
 * its level and no `!` applied to it. `!(github.event_name ==
 * 'workflow_dispatch')` mentions the event but excludes it, so it does not
 * narrow; `github.event_name == 'workflow_dispatch' && !inputs.skip` does.
 */
function requiresDispatch(cond: string): boolean {
  let c = cond.trim();
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(c);
  if (m) c = m[1];
  return exprRequiresDispatch(c);
}

/**
 * What starts this step, from the workflow's `on:`. A job or step condition
 * that requires `github.event_name == 'workflow_dispatch'` narrows it to manual;
 * no other condition is evaluated.
 */
export function triggerOf(events: string[], jobIf: string, stepIf: string): TriggerInfo {
  const base = { events: [...events] };
  for (const [cond, where] of [[jobIf, "job"], [stepIf, "step"]] as const) {
    if (requiresDispatch(cond)) {
      return { kind: "manual", ...base, narrowed_by: `the ${where} runs only on workflow_dispatch` };
    }
  }
  if (events.some(isAutomaticEvent)) return { kind: "automatic", ...base };
  if (events.includes("repository_dispatch")) return { kind: "external", ...base };
  if (events.includes("workflow_call")) return { kind: "called", ...base };
  if (events.includes("workflow_dispatch")) return { kind: "manual", ...base };
  return { kind: "unknown", ...base };
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

// `secrets.NAME` and the fixed bracket form `secrets['NAME']` / `secrets["NAME"]`.
const SECRET_REF = /\bsecrets(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*\])/g;

function collectStrings(v: YValue | undefined, out: string[]): void {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectStrings(x, out));
}

/**
 * Names of the secrets this step can read: those it references itself, plus
 * the job's and the workflow's `env:`. Names only; a workflow file never holds
 * the values.
 */
export function secretsOf(step: YMap, job: YMap, doc: YMap): string[] {
  const texts: string[] = [];
  collectStrings(step, texts);
  collectStrings(job.env, texts);
  collectStrings(doc.env, texts);
  const names = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(SECRET_REF)) names.add(m[1] ?? m[3]);
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

const CATEGORY_WEIGHT: Record<Category, [number, string]> = {
  infrastructure: [40, "Infrastructure change"],
  migrate: [40, "Database migration"],
  deploy: [30, "Deploy"],
  publish: [25, "Package or image publish"],
  unknown: [15, "Command chosen at run time"],
};

const TRIGGER_WEIGHT: Record<TriggerKind, number> = { automatic: 20, external: 10, called: 10, unknown: 10, manual: 0 };

function triggerFactor(t: TriggerInfo): string {
  switch (t.kind) {
    case "automatic":
      return `runs automatically (${t.events.filter(isAutomaticEvent).join(", ")})`;
    case "external":
      return "can be started by an API call (repository_dispatch)";
    case "called":
      return "runs when another workflow calls it";
    case "manual":
      return t.narrowed_by ? `started by hand only (${t.narrowed_by})` : "started by hand only (workflow_dispatch)";
    default:
      return "trigger not determined";
  }
}

/**
 * How soon to fix it: what kind of change, where it lands, whether anyone has
 * to start it, and whether it holds credentials. An undetermined environment
 * weighs half of production, never zero.
 */
export function priorityOf(
  category: Category,
  env: EnvironmentInfo,
  trigger: TriggerInfo,
  secrets: string[],
  confidence: "certain" | "possible",
): Priority {
  const [cw, clabel] = CATEGORY_WEIGHT[category];
  let score = cw;
  const factors = [clabel];
  if (env.value === "production") {
    score += 30;
    factors.push("targets production");
  } else if (env.value === "unknown") {
    score += 15;
    factors.push("environment not determined");
  } else {
    factors.push("staging or test");
  }
  score += TRIGGER_WEIGHT[trigger.kind];
  factors.push(triggerFactor(trigger));
  if (secrets.length > 0) {
    score += 10;
    factors.push(`can read ${secrets.length} secret${secrets.length === 1 ? "" : "s"}`);
  }
  if (confidence === "possible") {
    score -= 5;
    factors.push("possible match: the script it calls was not read");
  }
  score = Math.max(0, Math.min(100, score));
  const label: PriorityLabel = score >= 85 ? "critical" : score >= 65 ? "high" : score >= 45 ? "medium" : "low";
  return { label, score, factors };
}

/** Higher score first; ties keep a stable, readable order. */
export function comparePriority(a: Priority, b: Priority): number {
  return b.score - a.score;
}
