/**
 * The words and numbers every rendering of the Exposure Review shares: status
 * and category labels, the headline, the environment breakdown, and the
 * ranked causes. The HTML, Markdown and CSV renderers all read them from here,
 * so two outputs of one scan can never disagree (they did: the HTML once
 * folded two statuses into one card the Markdown kept apart).
 */

import type { EvidenceGapReport, Finding, GapStatus } from "./evidenceGap.js";
import type { Cause, Environment, PriorityLabel, TriggerKind } from "./findingContext.js";

export type Tone = "bad" | "warn" | "ok";

/** Every status, in the order every output lists them. */
export const STATUS_ORDER: readonly GapStatus[] = ["ungoverned", "weak", "gated", "gated_upstream", "bound"];

export const STATUS_LABEL: Record<GapStatus, string> = {
  ungoverned: "No gate",
  weak: "Gate cannot stop it",
  gated: "Gated, not bound",
  gated_upstream: "Gated in an earlier job",
  bound: "Gated and bound",
};

export const STATUS_TONE: Record<GapStatus, Tone> = {
  ungoverned: "bad",
  weak: "bad",
  gated: "warn",
  gated_upstream: "warn",
  bound: "ok",
};

export const CATEGORY_LABEL: Record<Finding["category"], string> = {
  deploy: "Deploy",
  publish: "Package or image publish",
  migrate: "Database migration",
  infrastructure: "Infrastructure change",
  unknown: "Command built at run time",
};

export const ENVIRONMENT_LABEL: Record<Environment, string> = {
  production: "Production",
  non_production: "Staging or test",
  unknown: "Environment not determined",
};

export const TRIGGER_LABEL: Record<TriggerKind, string> = {
  automatic: "Runs automatically",
  external: "Started by an API call",
  called: "Called by another workflow",
  manual: "Started by hand",
  unknown: "Trigger not determined",
};

export const PRIORITY_LABEL: Record<PriorityLabel, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const PRIORITY_TONE: Record<PriorityLabel, Tone> = { critical: "bad", high: "bad", medium: "warn", low: "ok" };

export function isGap(f: Finding): boolean {
  return f.status === "ungoverned" || f.status === "weak";
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The one-sentence result. Production first; an undetermined environment is
 * never reported as if it were staging.
 */
export function headline(report: EvidenceGapReport): { text: string; tone: Tone } {
  const s = report.summary;
  if (report.findings.length === 0) {
    return {
      text: `No deploy, publish, migration or infrastructure steps were recognized in ${plural(s.workflows_scanned, "workflow file")}.`,
      tone: "warn",
    };
  }
  if (s.gaps === 0) {
    return {
      text: `All ${plural(s.consequential_steps, "step")} that can change a real system ${s.consequential_steps === 1 ? "has" : "have"} a gate in front.`,
      tone: "ok",
    };
  }
  const g = s.gaps_by_environment;
  if (g.production > 0) {
    return {
      text: `${plural(g.production, "step that changes", "steps that change")} production can run with no approval that could stop ${g.production === 1 ? "it" : "them"}.`,
      tone: "bad",
    };
  }
  if (g.unknown > 0) {
    return {
      text: `${plural(g.unknown, "step")} can run with no approval that could stop ${g.unknown === 1 ? "it" : "them"}, and this review could not tell whether ${g.unknown === 1 ? "it changes" : "they change"} production.`,
      tone: "bad",
    };
  }
  return {
    text: `No production step can run ungated. ${plural(g.non_production, "staging or test step")} can.`,
    tone: "warn",
  };
}

/** "Of the 16 ungated steps: 5 production, 4 staging or test, 7 environment not determined." */
export function environmentBreakdown(report: EvidenceGapReport): string | null {
  const s = report.summary;
  if (s.gaps === 0) return null;
  const g = s.gaps_by_environment;
  const parts = [
    g.production ? `${g.production} production` : null,
    g.non_production ? `${g.non_production} staging or test` : null,
    g.unknown ? `${g.unknown} environment not determined` : null,
  ].filter(Boolean);
  return `Of the ${plural(s.gaps, "ungated step")} out of ${s.consequential_steps} that can change a real system: ${parts.join(", ")}.`;
}

/** "Fixing 4 causes closes all 16." Only when grouping actually saves work. */
export function causeLeverage(report: EvidenceGapReport): string | null {
  const s = report.summary;
  if (s.gaps === 0 || s.causes >= s.gaps) return null;
  return `These ${plural(s.gaps, "gap")} come from ${plural(s.causes, "cause")}: fixing ${s.causes === 1 ? "it closes" : "them closes"} all ${s.gaps}.`;
}

export function causeFindings(report: EvidenceGapReport, c: Cause): Finding[] {
  return c.findings.map((i) => report.findings[i]);
}

/** "5 steps, 3 in production" */
export function causeReach(c: Cause): string {
  const n = c.findings.length;
  const p = c.environments.production;
  return `${plural(n, "step")}${p > 0 ? (p === n ? (n === 1 ? ", in production" : ", all in production") : `, ${p} in production`) : ""}`;
}

/** Gap findings in rank order: by their cause's order, then within the cause. */
export function rankedGaps(report: EvidenceGapReport): Finding[] {
  return report.causes.flatMap((c) => causeFindings(report, c));
}

export function where(f: Finding): string {
  return `${f.workflow}${f.line ? `:${f.line}` : ""}`;
}

export function contextLine(f: Finding): string {
  const parts = [
    CATEGORY_LABEL[f.category],
    ENVIRONMENT_LABEL[f.environment.value],
    TRIGGER_LABEL[f.trigger.kind] + (f.trigger.kind === "automatic" ? ` (${automaticEvents(f).join(", ")})` : ""),
  ];
  if (f.secrets.length) parts.push(plural(f.secrets.length, "secret"));
  return parts.join(" · ");
}

function automaticEvents(f: Finding): string[] {
  const manualish = new Set(["workflow_dispatch", "workflow_call", "repository_dispatch"]);
  return f.trigger.events.filter((e) => !manualish.has(e));
}

export function possibleNote(f: Finding): string {
  return f.category === "unknown"
    ? "The command is chosen at run time, so what it runs is not known."
    : "A script is called and its contents were not read.";
}
