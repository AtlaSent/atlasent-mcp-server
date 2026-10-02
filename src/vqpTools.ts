/**
 * VQP tools — Delta VQP Phase 3 re-derivation audit.
 *
 *   atlasent_vqp_generate      — score a bundle, store snapshot + prompt_hash (mutating)
 *   atlasent_vqp_verify        — re-derive prompt, check hash, detect score drift (mutating)
 *   atlasent_vqp_audit_summary — SOC 2 CC7.2 VQP audit summary report (read-only)
 *   atlasent_vqp_drift_events  — score drift investigation list (read-only)
 *
 * generate and verify call Supabase edge functions directly using
 * ATLASENT_SUPABASE_URL + ATLASENT_SUPABASE_SERVICE_ROLE_KEY.
 * audit_summary and drift_events use the standard ATLASENT_API_KEY REST API.
 *
 * BUG FIX (response-shape mismatch, same class as the v2Tools.ts escalate
 * fix): `toolResult()` (decision.ts) only sets `isError` when the payload
 * carries a top-level `decision`, `valid`, or `error` field. The real
 * `v1-verify-vqp` success response (200/201) carries none of those — its
 * tamper signal is `hash_match: false` and its drift signal is
 * `verdict_changed: true` (see atlasent-api
 * supabase/functions/v1-verify-vqp/index.ts). So a tampered snapshot
 * (`hash_match: false`) — the exact condition this tool's own description
 * says it "detects" — was silently returned as an ordinary successful
 * result (`isError` unset), indistinguishable from a clean verification.
 * checkVqpIntegrity() below promotes `hash_match: false` to an explicit
 * error result so a host gating on `isError` actually sees it.
 * Untested before this fix (no dedicated vqpTools.test.ts existed at all —
 * the only prior reference to these four tool names was a tools/list
 * membership check in server.test.ts), which is how this went unnoticed.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolResult } from "./decision.js";
import { functionRegionHeaders } from "./functionRegion.js";

const MAX_FIELD_LEN = 256;
const VQP_TIMEOUT_MS = 30_000;

function toolError(e: unknown) {
  return toolResult({ error: e instanceof Error ? e.message : String(e) });
}

function logAudit(toolName: string): void {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "mcp.request",
      transport: "mcp-tool",
      tool_name: toolName,
    }) + "\n",
  );
}

function isReadOnly(): boolean {
  return (
    process.env.ATLASENT_MCP_READONLY === "1" ||
    process.env.ATLASENT_MCP_READONLY === "true"
  );
}

// See the file header "BUG FIX" note. Promotes the documented tamper
// signal in a v1-verify-vqp response (`hash_match: false`) to an explicit
// MCP error result, since it is not a `decision`/`valid`/`error` field
// toolResult() would otherwise recognize as a failure.
//
// `verdict_changed: true` on its own (hash intact, AI re-run scored
// differently) is deliberately NOT promoted here — the field is already
// visible to the caller in the ordinary successful payload, and a fresh AI
// call scoring a few points differently is expected model variance, not
// evidence of tampering. Only a broken hash chain is a hard failure.
function checkVqpIntegrity(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const obj = result as Record<string, unknown>;
  if (obj.hash_match !== false) return null;
  return {
    ...obj,
    error: "hash_mismatch",
    message:
      "VQP prompt_hash mismatch — the re-derived prompt does not match the " +
      "stored snapshot. Treat as tampering or undetected bundle drift; do " +
      "not rely on this snapshot as compliance evidence until investigated.",
  };
}

// ── Supabase edge function client (service-role) ─────────────────────────────────

function supabaseBaseUrl(): string {
  return (process.env.ATLASENT_SUPABASE_URL ?? "").replace(/\/+$/, "");
}

function serviceRoleKey(): string {
  return process.env.ATLASENT_SUPABASE_SERVICE_ROLE_KEY ?? "";
}

async function postSupabase<T>(path: string, body: unknown): Promise<T> {
  const base = supabaseBaseUrl();
  if (!base) throw new Error("ATLASENT_SUPABASE_URL is not set");
  const key = serviceRoleKey();
  if (!key) throw new Error("ATLASENT_SUPABASE_SERVICE_ROLE_KEY is not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VQP_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
        ...functionRegionHeaders(base),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json();
    if (!res.ok) {
      const msg =
        typeof (json as { message?: string }).message === "string"
          ? (json as { message: string }).message
          : `VQP edge function error: HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── Standard API GET helper (for read-only report tools) ───────────────────────

function apiBaseUrl(): string {
  return (process.env.ATLASENT_BASE_URL ?? "https://api.atlasent.io").replace(/\/+$/, "");
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = process.env.ATLASENT_API_KEY;
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return { ...headers, ...functionRegionHeaders(apiBaseUrl()) };
}

async function getApi<T>(
  path: string,
  params?: Record<string, string | undefined>,
): Promise<T> {
  let url = `${apiBaseUrl()}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
      .join("&");
    if (qs) url += `?${qs}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: apiHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Tool registration ──────────────────────────────────────────────────────────────────

export function registerVqpTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // atlasent_vqp_generate (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isReadOnly()) {
    server.registerTool(
      "atlasent_vqp_generate",
      {
        title: "AtlaSent — VQP Generate Snapshot",
        description:
          "Score a constraint bundle against the 6 VQP criteria " +
          "(access_control CC6.1, audit_coverage CC7.2, escalation_paths CC7.4, " +
          "deny_specificity CC8.1, hold_conditions CC6.3, override_governance CC5.2). " +
          "Stores a tamper-evident snapshot with a SHA-256 prompt_hash in vqp_snapshots. " +
          "Verdicts: qualified (≥85, no fails), conditionally_qualified (≥60), not_qualified. " +
          "Requires ATLASENT_SUPABASE_URL and ATLASENT_SUPABASE_SERVICE_ROLE_KEY.",
        inputSchema: z.object({
          bundle_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Constraint bundle ID to score."),
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID that owns the bundle."),
          vqp_context: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Additional context embedded in the VQP prompt for this snapshot."),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        logAudit("atlasent_vqp_generate");
        try {
          const result = await postSupabase("/functions/v1/v1-generate-vqp", {
            bundle_id: args.bundle_id,
            org_id: args.org_id,
            ...(args.vqp_context !== undefined ? { vqp_context: args.vqp_context } : {}),
          });
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_vqp_verify (mutating — disabled in READONLY mode)
  // -------------------------------------------------------------------------
  if (!isReadOnly()) {
    server.registerTool(
      "atlasent_vqp_verify",
      {
        title: "AtlaSent — VQP Verify Snapshot",
        description:
          "Re-derive the VQP prompt from current bundle data and verify it matches " +
          "the stored SHA-256 prompt_hash. Detects tampering (hash_match: false) and " +
          "optionally re-runs the AI model to detect score drift (score_delta, verdict_changed). " +
          "Writes a vqp_audit_log row for SOC 2 CC7.2 / 21 CFR Part 11 evidence. " +
          "Requires ATLASENT_SUPABASE_URL and ATLASENT_SUPABASE_SERVICE_ROLE_KEY.",
        inputSchema: z.object({
          snapshot_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Snapshot ID from atlasent_vqp_generate or a stored vqp_snapshots row."),
          rerun: z
            .boolean()
            .optional()
            .describe(
              "Re-call the AI model with the re-derived prompt to detect score drift. " +
              "Populates rerun_score, rerun_verdict, score_delta. Slower (10–20 s AI call).",
            ),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        logAudit("atlasent_vqp_verify");
        try {
          const result = await postSupabase("/functions/v1/v1-verify-vqp", {
            snapshot_id: args.snapshot_id,
            ...(args.rerun !== undefined ? { rerun: args.rerun } : {}),
          });
          // BUG FIX: surface hash_match: false as an explicit error — see
          // checkVqpIntegrity() and the file-header note above.
          const integrityResult = checkVqpIntegrity(result);
          if (integrityResult) return toolResult(integrityResult);
          return toolResult(result as Record<string, unknown>);
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // atlasent_vqp_audit_summary (read-only)
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_vqp_audit_summary",
    {
      title: "AtlaSent — VQP Audit Summary",
      description:
        "Retrieve a summary of VQP audit activity — hash match rates, drift event counts, " +
        "and verdict changes — from the BCCAE compliance report. " +
        "Use for SOC 2 evidence collection and monitoring dashboards.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        from: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 start of the reporting window."),
        to: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 end of the reporting window."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      logAudit("atlasent_vqp_audit_summary");
      try {
        const result = await getApi("/v1/bccae-reports/vqp-audit-summary", {
          org_id: args.org_id,
          from: args.from,
          to: args.to,
        });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_vqp_drift_events (read-only)
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_vqp_drift_events",
    {
      title: "AtlaSent — VQP Drift Events",
      description:
        "List VQP snapshots where the re-run AI score drifted by ≥10 points or the " +
        "verdict changed (e.g. qualified → not_qualified). " +
        "Use for compliance investigation and QA-VQP-002 § 7 deviation reporting.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        from: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 start of the reporting window."),
        to: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("ISO-8601 end of the reporting window."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max events to return (default 20, max 100)."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      logAudit("atlasent_vqp_drift_events");
      try {
        const result = await getApi("/v1/bccae-reports/vqp-drift-events", {
          org_id: args.org_id,
          from: args.from,
          to: args.to,
          limit: args.limit !== undefined ? String(args.limit) : undefined,
        });
        return toolResult(result as Record<string, unknown>);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
