/**
 * Tools that only a self-hosted `/v1/*` gateway serves (founder decision
 * 2026-10-19: agents should only see tools that work).
 *
 * Every tool named in GATEWAY_ONLY_TOOLS calls a slash-form `/v1/<resource>`
 * path at the domain root (see the "Two path families" note in engine.ts, and
 * vqpTools.ts's getApi). AtlaSent's hosted runtime does not serve that shape:
 * on api.atlasent.io those requests 404, so the tool can only ever return an
 * error. Showing it to an agent there advertises a capability that does not
 * exist. A self-hosted deployment that runs its own `/v1/*` gateway can still
 * use them, so they are hidden, not deleted.
 *
 * Registered when, read at registration time (createServer()):
 *   1. ATLASENT_MCP_ENABLE_GATEWAY_TOOLS is "1" or "true" (explicit opt-in), or
 *   2. the server is in remote mode AND ATLASENT_BASE_URL is set to a URL whose
 *      host is not one of HOSTED_RUNTIME_HOSTS (a self-hosted runtime).
 * Otherwise hidden. In particular they are hidden when ATLASENT_BASE_URL is
 * unset or blank (the hosted default), unparseable, or a hosted host, and in
 * local mode. Local mode is included on purpose: these tools never touch the
 * local engine. Each makes only a remote call, which in local mode goes to the
 * hosted default (and 404s) or to a base URL with no API key, so none of them
 * works there either. The flag still registers them for someone who wants it.
 *
 * Hiding changes what tools/list shows and nothing else. authorize(), verify()
 * and the `evaluate` / `verify_permit` / `atlasent_evaluate` / deploy tools
 * are not in this set and are untouched; a hidden tool that a client calls
 * anyway gets the MCP "tool not found" error, i.e. nothing runs.
 */

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HOSTED_RUNTIME_HOSTS } from "./functionRegion.js";
import { requestedMode } from "./engine.js";

export const GATEWAY_TOOLS_ENV = "ATLASENT_MCP_ENABLE_GATEWAY_TOOLS";

/** Tools whose only backend is a `/v1/*` gateway the hosted API does not serve. */
export const GATEWAY_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Policies: v1-policies has no GET-by-id, create, update or delete route.
  "atlasent_get_policy",
  "atlasent_create_policy",
  "atlasent_update_policy",
  "atlasent_delete_policy",
  // Permits. atlasent_get_permit / atlasent_check_permit can move to
  // `/v1-permits/<id>` (and leave this set) once atlasent-api#4522 is in
  // PRODUCTION: the handler deployed before it reads `/v1-permits/<id>` as the
  // list route. It is on atlasent-api main, not prod, as of 2026-10-19.
  "atlasent_get_permit",
  "atlasent_check_permit",
  "atlasent_revoke_permit",
  "atlasent_permit", // POST /v1/permits/issue
  "atlasent_verify_permit", // POST /v1/permits/verify; the canonical verifier is `verify_permit`
  // Decisions and execution evidence.
  "atlasent_get_decision",
  "atlasent_record_execution_evaluation",
  // Webhooks: v1-webhooks dispatches on a body `action` with a different shape.
  "atlasent_create_webhook",
  "atlasent_delete_webhook",
  // SCIM: runtime SCIM functions take a SCIM bearer token, not an API key.
  "atlasent_list_scim_users",
  "atlasent_get_scim_user",
  "atlasent_create_scim_user",
  "atlasent_patch_scim_user",
  "atlasent_delete_scim_user",
  "atlasent_list_scim_groups",
  // SIEM: no runtime function serves siem-config or siem-exports/test.
  "atlasent_get_siem_config",
  "atlasent_upsert_siem_config",
  "atlasent_test_siem_delivery",
  // Evidence exports: list and create (get works at /v1-evidence-exports/<id>).
  "atlasent_list_evidence_exports",
  "atlasent_create_evidence_export",
  // VQP reports: GET /v1/bccae-reports/vqp-* at the base URL.
  "atlasent_vqp_audit_summary",
  "atlasent_vqp_drift_events",
]);

function flagSet(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** True when `url` names AtlaSent's hosted runtime, or cannot be parsed. */
function targetsHostedRuntime(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true; // not a usable self-hosted URL: treat as the hosted default
  }
  return HOSTED_RUNTIME_HOSTS.has(host.replace(/\.$/, ""));
}

/** Whether the gateway-only tools should be registered for this environment. */
export function gatewayToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (flagSet(env[GATEWAY_TOOLS_ENV])) return true;
  if (requestedMode(env) !== "remote") return false;
  const base = env.ATLASENT_BASE_URL?.trim();
  if (!base) return false; // unset or blank: the hosted default
  return !targetsHostedRuntime(base);
}

/**
 * Make `server` drop every gateway-only tool as it is registered, unless the
 * environment enables them. One choke point for server.ts, complianceTools.ts
 * and vqpTools.ts, so a call site cannot forget the check. Returns the names
 * that will be hidden (empty when enabled), for the startup log.
 */
export function applyGatewayToolGate(
  server: McpServer,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (gatewayToolsEnabled(env)) return [];
  const register = server.registerTool.bind(server) as (
    name: string,
    ...rest: unknown[]
  ) => RegisteredTool;
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    const tool = register(name, ...rest);
    if (GATEWAY_ONLY_TOOLS.has(name)) tool.remove();
    return tool;
  }) as McpServer["registerTool"];
  return [...GATEWAY_ONLY_TOOLS].sort();
}
