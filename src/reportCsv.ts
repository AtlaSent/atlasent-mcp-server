/**
 * The Exposure Review as CSV: one row per recognized step, ungated steps
 * first in rank order, for a spreadsheet, a ticket import or a GRC tool.
 *
 * Every text cell came from a workflow file and is untrusted. RFC 4180 quoting
 * keeps it in its cell, and a cell that a spreadsheet would read as a formula
 * (starting with = + - @, a tab or a carriage return) gets a leading
 * apostrophe so it is shown as text and never evaluated (CSV injection).
 */

import type { EvidenceGapReport, Finding } from "./evidenceGap.js";
import {
  CATEGORY_LABEL,
  ENVIRONMENT_LABEL,
  PRIORITY_LABEL,
  STATUS_LABEL,
  TRIGGER_LABEL,
  isGap,
  rankedGaps,
} from "./reportModel.js";

export const CSV_COLUMNS = [
  "rank",
  "priority",
  "priority_score",
  "status",
  "category",
  "environment",
  "environment_source",
  "trigger",
  "trigger_events",
  "secret_count",
  "secrets",
  "workflow",
  "line",
  "job",
  "step",
  "confidence",
  "cause",
  "cause_steps",
  "reason",
  "fix_once",
  "fix_change",
  "fix_condition",
  "fix_adds_gate_step",
  "priority_factors",
] as const;

const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: neutralized if a spreadsheet would run it, quoted if needed. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let t = v;
  if (FORMULA_START.test(t)) t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function renderCsv(report: EvidenceGapReport): string {
  const causeById = new Map(report.causes.map((c) => [c.id, c]));
  const gaps = rankedGaps(report);
  const others = report.findings.filter((f) => !isGap(f));
  const row = (f: Finding, rank: number | null): string => {
    const c = f.cause ? causeById.get(f.cause) : undefined;
    const cells: Array<string | number | null> = [
      rank,
      PRIORITY_LABEL[f.priority.label],
      f.priority.score,
      STATUS_LABEL[f.status],
      CATEGORY_LABEL[f.category],
      ENVIRONMENT_LABEL[f.environment.value],
      f.environment.source,
      TRIGGER_LABEL[f.trigger.kind],
      f.trigger.events.join(" "),
      f.secrets.length,
      f.secrets.join(" "),
      f.workflow,
      f.line || null,
      f.job,
      f.step,
      f.confidence,
      c?.title ?? null,
      c ? c.findings.length : null,
      f.reason,
      c?.fix_once ?? null,
      f.fix?.change && f.fix.change !== c?.fix_once ? f.fix.change : null,
      f.fix?.bind_if ?? null,
      f.fix ? (f.fix.gate_step ? "yes" : "no") : null,
      f.priority.factors.join("; "),
    ];
    return cells.map(csvCell).join(",");
  };
  const lines = [
    CSV_COLUMNS.join(","),
    ...gaps.map((f, i) => row(f, i + 1)),
    ...others.map((f) => row(f, null)),
  ];
  // CRLF per RFC 4180; a UTF-8 BOM so Excel reads non-ASCII step names correctly.
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
