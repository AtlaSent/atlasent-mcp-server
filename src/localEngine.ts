/**
 * Local policy engine — used when no hosted AtlaSent backend is configured.
 *
 * This is intentionally small: a few deterministic rules that mirror the kind
 * of decisions the hosted engine will make. It lets developers run the MCP
 * server, drive the full evaluate → act → verify flow, and see allow / deny /
 * hold outcomes without any network credentials.
 *
 * NOT FAIL-CLOSED, AND NOT PROTECTION. This header said "Rules (fail-closed
 * defaults)" until 2026-09-25 while rule 3 below was an unconditional allow —
 * an action type this engine does not recognise is ALLOWED. That is the
 * opposite of fail-closed, and "fail-closed is absolute" is stated as a
 * non-negotiable invariant across every other AtlaSent repo, so the claim was
 * wrong in the direction that matters. The behaviour is deliberate and is not
 * being changed: this engine exists so a developer can see allow / deny / hold
 * without credentials, and a deny-by-default demo would demonstrate nothing.
 * What was wrong was calling it something it isn't.
 *
 * If you want real local enforcement, that is a different package:
 * @atlasent/mcp-gate is a stdio proxy whose policy starts at
 * `{"default":"deny","rules":[]}` and blocks every tool call until an operator
 * writes a rule. Local rules there are operator configuration — still not
 * organizational permits. See the authority ladder in the repo root README.
 *
 * Rules (demo engine; terminal rule is allow):
 *   0. canonical action class recognition (AC-001–AC-020)  ← runs first
 *   1. production action + no approvals     → deny
 *   2. destructive action + no change window → hold
 *   3. otherwise                              → allow  ← includes unrecognised
 *                                                 action types
 *
 * The canonical action class layer (step 0) intercepts Sign, Certify, Grant,
 * Revoke, Suspend, Resume with deny; Override, Release, Export, Import,
 * Transfer (non-prod), Publish with hold; Approve, Create, Escalate with
 * allow; and falls through to the existing production/destructive heuristics
 * for Deploy, Execute, Modify, Delete, Destroy, and unrecognised action types.
 */

import { randomUUID } from "node:crypto";

import type { ActionContext, Decision, VerifyResult } from "./decision.js";
import { upgradeHint } from "./upgrade.js";

const DESTRUCTIVE_KEYWORDS = ["delete", "drop", "destroy", "truncate", "rm", "purge", "wipe"];
const PERMIT_TTL_MS = 5 * 60 * 1000;

// In-memory single-use tracking. Local mode is single-process, so a
// Set is sufficient — production parity for "permits are consumed on
// verify" lives in the hosted backend. Without this, the same local
// token verified twice would both succeed, hiding replay bugs that
// only surface in remote mode.
const CONSUMED_TOKENS = new Set<string>();

// Cap the consumed-tokens set to bound memory in long-running dev
// sessions. Any entry older than this is no longer reachable as a
// valid permit anyway (PERMIT_TTL_MS is shorter), so dropping it on
// overflow doesn't change correctness.
const CONSUMED_CAP = 10_000;

function rememberConsumed(token: string): void {
  if (CONSUMED_TOKENS.size >= CONSUMED_CAP) {
    // Drop the oldest insertion order entry — Set preserves it.
    const first = CONSUMED_TOKENS.values().next().value;
    if (first) CONSUMED_TOKENS.delete(first);
  }
  CONSUMED_TOKENS.add(token);
}

function shortId(prefix: string): string {
  // randomUUID is CSPRNG-backed; the timestamp prefix is kept so
  // verifyLocal can still TTL-check based on issue time without a
  // separate side-table.
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function isDestructive(action: string): boolean {
  const a = action.toLowerCase();
  return DESTRUCTIVE_KEYWORDS.some((k) => a.includes(k));
}

// ---------------------------------------------------------------------------
// Authorization Intelligence Library — 20 canonical action classes
// ---------------------------------------------------------------------------

/**
 * Converts a simple glob pattern (only `*` wildcard supported) into a RegExp.
 * A `*` matches any sequence of characters including dots and underscores, so
 * `*.sign*` compiles to `^.*\.sign.*$` — it requires a literal dot before the
 * keyword and therefore does NOT match bare prefixes like "design" that merely
 * contain the keyword as a substring without a preceding segment separator.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export type ActionClass =
  | "AC-001"
  | "AC-002"
  | "AC-003"
  | "AC-004"
  | "AC-005"
  | "AC-006"
  | "AC-007"
  | "AC-008"
  | "AC-009"
  | "AC-010"
  | "AC-011"
  | "AC-012"
  | "AC-013"
  | "AC-014"
  | "AC-015"
  | "AC-016"
  | "AC-017"
  | "AC-018"
  | "AC-019"
  | "AC-020";

const CLASS_LABELS: Record<ActionClass, string> = {
  "AC-001": "Deploy",
  "AC-002": "Release",
  "AC-003": "Approve",
  "AC-004": "Execute",
  "AC-005": "Modify",
  "AC-006": "Export",
  "AC-007": "Import",
  "AC-008": "Delete",
  "AC-009": "Grant",
  "AC-010": "Revoke",
  "AC-011": "Override",
  "AC-012": "Transfer",
  "AC-013": "Publish",
  "AC-014": "Sign",
  "AC-015": "Create",
  "AC-016": "Destroy",
  "AC-017": "Suspend",
  "AC-018": "Resume",
  "AC-019": "Escalate",
  "AC-020": "Certify",
};

// Glob patterns for each library class.
// AC-020 is listed before AC-002 so that `manufacturing.batch_record.release`
// (an explicit AC-020 pattern that contains the word "release") is correctly
// resolved as Certify rather than falling into AC-002's *.release* glob.
const ACTION_CLASS_PATTERNS: Array<{ id: ActionClass; patterns: string[] }> = [
  // AC-020 Certify — highest standard; listed first to win over *.release* overlap
  {
    id: "AC-020",
    patterns: [
      "compliance.certify",
      "*.certify*",
      "manufacturing.batch_record.release",
      "financial.close",
      "reconciliation.certify",
    ],
  },
  // AC-001 Deploy
  { id: "AC-001", patterns: ["production.deploy", "*.deploy*", "deploy.*"] },
  // AC-002 Release
  { id: "AC-002", patterns: ["*.release*", "release.*", "artifact.release"] },
  // AC-003 Approve
  { id: "AC-003", patterns: ["*.approve*", "workflow.approve"] },
  // AC-004 Execute
  { id: "AC-004", patterns: ["*.execute*", "command.execute", "agent.tool_call"] },
  // AC-005 Modify
  { id: "AC-005", patterns: ["*.modify*", "data.modify"] },
  // AC-006 Export
  { id: "AC-006", patterns: ["data.export", "*.export*"] },
  // AC-007 Import
  { id: "AC-007", patterns: ["data.import", "*.import*"] },
  // AC-008 Delete
  { id: "AC-008", patterns: ["*.delete*", "data.delete"] },
  // AC-009 Grant
  { id: "AC-009", patterns: ["access.grant", "access.elevate", "*.grant*"] },
  // AC-010 Revoke
  { id: "AC-010", patterns: ["access.revoke", "*.revoke*"] },
  // AC-011 Override
  { id: "AC-011", patterns: ["control.override", "*.override*"] },
  // AC-012 Transfer
  { id: "AC-012", patterns: ["financial.transfer", "*.transfer*"] },
  // AC-013 Publish
  { id: "AC-013", patterns: ["content.publish", "*.publish*"] },
  // AC-014 Sign
  { id: "AC-014", patterns: ["identity.sign", "*.sign*", "clinical.signature.*"] },
  // AC-015 Create
  { id: "AC-015", patterns: ["resource.create", "*.create*"] },
  // AC-016 Destroy
  { id: "AC-016", patterns: ["resource.destroy", "*.destroy*"] },
  // AC-017 Suspend
  { id: "AC-017", patterns: ["service.suspend", "*.suspend*"] },
  // AC-018 Resume
  { id: "AC-018", patterns: ["service.resume", "*.resume*"] },
  // AC-019 Escalate
  { id: "AC-019", patterns: ["workflow.escalate", "*.escalate*"] },
];

// Precompile the regexes for performance — done once at module load.
const COMPILED_MATCHERS: Array<{ id: ActionClass; regexes: RegExp[] }> =
  ACTION_CLASS_PATTERNS.map(({ id, patterns }) => ({
    id,
    regexes: patterns.map(globToRegex),
  }));

/**
 * Identifies which Authorization Intelligence Library class (AC-001–AC-020)
 * an `action_type` belongs to, or returns `null` if none matches.
 *
 * Matching is case-insensitive and uses first-match semantics. The class
 * order is arranged to handle known overlaps (e.g. AC-020 precedes AC-002).
 */
export function detectActionClass(action_type: string): ActionClass | null {
  const a = action_type.toLowerCase();
  for (const { id, regexes } of COMPILED_MATCHERS) {
    if (regexes.some((r) => r.test(a))) return id;
  }
  return null;
}

/**
 * Returns a canonical local-mode Decision for a recognized library class,
 * or `null` when the existing production / destructive heuristics should
 * handle the action instead.
 *
 * Classes that return null (fall through to existing logic):
 *   AC-001 Deploy    — existing: production + no approvals → deny
 *   AC-004 Execute   — existing rules apply
 *   AC-005 Modify    — existing rules apply
 *   AC-008 Delete    — existing: destructive keyword → hold
 *   AC-016 Destroy   — existing: destructive keyword → hold
 */
function classBasedDecision(
  ctx: ActionContext,
  cls: ActionClass,
  audit_id: string,
): Decision | null {
  const label = CLASS_LABELS[cls];
  const classTag = `[${cls} ${label}]`;
  const hasApproval = (ctx.approvals?.length ?? 0) > 0;
  const isProd = ctx.environment === "production";

  switch (cls) {
    // -----------------------------------------------------------------------
    // Fall-through classes — delegate to existing production/destructive logic
    // -----------------------------------------------------------------------
    case "AC-001": // Deploy — production + no-approval deny already handles this
    case "AC-004": // Execute — existing rules apply
    case "AC-005": // Modify  — existing rules apply
    case "AC-008": // Delete  — destructive keyword hold already handles this
    case "AC-016": // Destroy — destructive keyword hold already handles this
      return null;

    // -----------------------------------------------------------------------
    // Allow — these actions are permitted without further conditions
    // -----------------------------------------------------------------------
    case "AC-003": // Approve — the approval flow itself is never blocked
      return {
        decision: "allow",
        permit_token: shortId("pt_local"),
        conditions: [
          `Action class ${classTag}: Approval actions are always permitted to flow.`,
        ],
        audit_id,
      };

    case "AC-015": // Create — lowest-risk class
      return {
        decision: "allow",
        permit_token: shortId("pt_local"),
        conditions: [
          `Action class ${classTag}: Create is the lowest-risk class. Proceeding.`,
        ],
        audit_id,
      };

    case "AC-019": // Escalate — creates the review path; not itself blocked
      return {
        decision: "allow",
        permit_token: shortId("pt_local"),
        conditions: [
          `Action class ${classTag}: Escalation creates the review path and is not itself blocked.`,
        ],
        audit_id,
      };

    // -----------------------------------------------------------------------
    // Hold — requires out-of-band review before proceeding
    // -----------------------------------------------------------------------
    case "AC-002": // Release — requires a scheduled change window
      return {
        decision: "hold",
        hold_id: shortId("hold_local"),
        reasons: [
          `Action class ${classTag}: Release requires a scheduled change_window. Awaiting human review.`,
        ],
        audit_id,
      };

    case "AC-006": // Export — requires justification context
      return {
        decision: "hold",
        hold_id: shortId("hold_local"),
        reasons: [
          `Action class ${classTag}: Export requires justification context. Awaiting human review.`,
        ],
        audit_id,
      };

    case "AC-007": // Import — requires a verified artifact
      return {
        decision: "hold",
        hold_id: shortId("hold_local"),
        reasons: [
          `Action class ${classTag}: Import requires a verified artifact. Awaiting human review.`,
        ],
        audit_id,
      };

    case "AC-011": // Override — bypasses enforcement controls; requires review
      return {
        decision: "hold",
        hold_id: shortId("hold_local"),
        reasons: [
          `Action class ${classTag}: Control override bypasses enforcement controls. Awaiting human review.`,
        ],
        audit_id,
      };

    case "AC-013": // Publish — requires a prior signature
      return {
        decision: "hold",
        hold_id: shortId("hold_local"),
        reasons: [
          `Action class ${classTag}: Content publish requires a prior signature. Awaiting human review.`,
        ],
        audit_id,
      };

    // -----------------------------------------------------------------------
    // Conditional: deny in production, hold elsewhere (AC-012 Transfer)
    // -----------------------------------------------------------------------
    case "AC-012": // Transfer — deny in production without approval; hold elsewhere
      if (isProd && !hasApproval) {
        return {
          decision: "deny",
          reasons: [
            `Action class ${classTag}: Financial transfer in production requires at least one approval. Add an approval to the 'approvals' list and retry.`,
          ],
          audit_id,
        };
      }
      return {
        decision: "hold",
        hold_id: shortId("hold_local"),
        reasons: [
          `Action class ${classTag}: Financial transfer requires approval. Awaiting human review.`,
        ],
        audit_id,
      };

    // -----------------------------------------------------------------------
    // Deny — these actions cannot self-authorize in local mode
    // -----------------------------------------------------------------------
    case "AC-009": // Grant — access grant requires an explicit approval
      return {
        decision: "deny",
        reasons: [
          `Action class ${classTag}: Access grant requires approval. Add an approval to the 'approvals' list and retry.`,
        ],
        audit_id,
      };

    case "AC-010": // Revoke — mirrors the grant requirement
      return {
        decision: "deny",
        reasons: [
          `Action class ${classTag}: Access revoke requires approval — mirrors the grant requirement. Add an approval to the 'approvals' list and retry.`,
        ],
        audit_id,
      };

    case "AC-014": // Sign — requires verified actor identity; self-authorization not permitted
      return {
        decision: "deny",
        reasons: [
          `Action class ${classTag}: Signature requires verified actor identity. The actor cannot self-authorize a signing action.`,
        ],
        audit_id,
      };

    case "AC-017": // Suspend — affects availability; requires approval
      return {
        decision: "deny",
        reasons: [
          `Action class ${classTag}: Service suspension affects availability and requires approval. Add an approval to the 'approvals' list and retry.`,
        ],
        audit_id,
      };

    case "AC-018": // Resume — requires verification before restoring
      return {
        decision: "deny",
        reasons: [
          `Action class ${classTag}: Service resume requires verification before restoring. Add an approval to the 'approvals' list and retry.`,
        ],
        audit_id,
      };

    case "AC-020": // Certify — requires qualified authority; highest authorization standard
      return {
        decision: "deny",
        reasons: [
          `Action class ${classTag}: Certification requires qualified authority. This is the highest authorization standard.`,
        ],
        audit_id,
      };
  }
}

export function authorizeLocal(ctx: ActionContext): Decision {
  const audit_id = shortId("aud_local");
  const hasApproval = (ctx.approvals?.length ?? 0) > 0;
  const hasWindow = !!ctx.change_window;
  const isProd = ctx.environment === "production";

  // Step 0: canonical action class recognition (AC-001–AC-020).
  // classBasedDecision() returns null for classes that defer to the existing
  // production / destructive heuristics in steps 1 and 2 below.
  const cls = detectActionClass(ctx.action_type);
  if (cls !== null) {
    const classDec = classBasedDecision(ctx, cls, audit_id);
    if (classDec !== null) return classDec;
  }

  // Step 1: production action + no approvals → deny
  if (isProd && !hasApproval) {
    return {
      decision: "deny",
      reasons: [
        `Production action '${ctx.action_type}' requires at least one approval. Add an approval to the 'approvals' list and retry.`,
      ],
      audit_id,
    };
  }

  // Step 2: destructive action + no change window → hold
  if (isDestructive(ctx.action_type) && !hasWindow) {
    return {
      decision: "hold",
      reasons: [
        `Destructive action '${ctx.action_type}' requires a scheduled change_window. Awaiting human review.`,
      ],
      hold_id: shortId("hold_local"),
      audit_id,
    };
  }

  // Step 3: allow — the terminal rule, reached by anything steps 0-2 did not
  // classify, INCLUDING action types this engine has never heard of. Says so
  // in `conditions` so a caller reading the decision sees the same thing the
  // header says: this is a demo default, not a judgement that the action is
  // safe. A caller that wants deny-by-default wants @atlasent/mcp-gate.
  return {
    decision: "allow",
    permit_token: shortId("pt_local"),
    conditions: [
      "Local demo engine: no rule matched, and the terminal rule is allow. " +
        "This is not a finding that the action is safe, and local permits are " +
        "unsigned. For deny-by-default local enforcement use @atlasent/mcp-gate; " +
        "for an organizational permit, use remote mode. " +
        upgradeHint("agent"),
    ],
    audit_id,
  };
}

/**
 * Verify a locally-issued permit token.
 * Local tokens encode a base36 timestamp — we use that to check TTL.
 * Tokens are single-use: a successful verify marks the token consumed,
 * so a second verify of the same token returns `invalid` (mirrors the
 * hosted backend's PERMIT_ALREADY_USED behaviour).
 */
export function verifyLocal(token: string, _ctx: ActionContext): VerifyResult {
  const audit_id = shortId("aud_local");

  if (!token.startsWith("pt_local_")) {
    return { outcome: "invalid", valid: false, reasons: ["Token is not a local-mode permit"], audit_id };
  }

  const parts = token.split("_");
  if (parts.length < 4) {
    return { outcome: "invalid", valid: false, reasons: ["Malformed local permit token"], audit_id };
  }

  const issuedAt = parseInt(parts[2], 36);
  if (Number.isNaN(issuedAt)) {
    return { outcome: "invalid", valid: false, reasons: ["Unparseable timestamp in local permit"], audit_id };
  }

  if (Date.now() - issuedAt > PERMIT_TTL_MS) {
    return {
      outcome: "expired",
      valid: false,
      reasons: [`Local permit expired (TTL ${PERMIT_TTL_MS / 1000}s)`],
      audit_id,
    };
  }

  if (CONSUMED_TOKENS.has(token)) {
    return {
      outcome: "invalid",
      valid: false,
      reasons: ["Local permit already used"],
      audit_id,
    };
  }

  rememberConsumed(token);
  return { outcome: "verified", valid: true, audit_id };
}

// Test-only hook so the unit suite can guarantee a clean slate between
// cases. Not exported from the package (no entry in dist's barrel).
export function _resetLocalEngineForTests(): void {
  CONSUMED_TOKENS.clear();
}
