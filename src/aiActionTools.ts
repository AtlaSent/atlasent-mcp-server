/**
 * AI Action Protection reference tool: `atlasent_governed_file_change`.
 *
 * MCP is the EXECUTION ADAPTER here, not the authority. This tool's name,
 * description and annotations are guidance to the agent. What stops an
 * unauthorized change is the code below: nothing reaches GitHub unless the
 * AtlaSent runtime issued a permit for exactly this change and verified it at
 * this boundary. Installing this server authorizes nothing; the org's
 * agent.tool.invoke policy (and its approvals) decides every call.
 *
 * Registered only when ATLASENT_AI_ACTION_GITHUB_REPO names the one repository
 * this server may change, so an install never gains write access by default.
 *
 *   ATLASENT_AI_ACTION_GITHUB_REPO    owner/repo              (required)
 *   ATLASENT_AI_ACTION_GITHUB_BRANCH  branch the agent writes (required; never defaulted)
 *   ATLASENT_AI_ACTION_GITHUB_TOKEN   token for that repo only (required; never read from GITHUB_TOKEN)
 *   ATLASENT_AI_ACTION_PATH_PREFIX    optional path prefix the agent is confined to
 *   ATLASENT_AI_ACTION_BREAKER_FILE   optional file persisting circuit-breaker trips
 *   ATLASENT_AI_ACTION_STOP_FILE      optional operator stop file (present = stop)
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authorize, awaitApproval, getMode, verify } from "./engine.js";
import {
  CircuitBreaker,
  executeGoverned,
  requestAuthorization,
  sealedActionHash,
  sha256Hex,
  type AiActionProof,
  type GovernedActionSpec,
} from "./governedAction.js";
import type { SealedBinding } from "./decision.js";
import { githubFileAdapter, githubFileChangeSpec, type GithubFileChange } from "./githubFileAdapter.js";

export const GOVERNED_FILE_CHANGE_TOOL = "atlasent_governed_file_change";

export interface AiActionConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  pathPrefix?: string;
  breakerFile?: string;
  stopFile?: string;
}

export function aiActionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AiActionConfig | null {
  const repo = env.ATLASENT_AI_ACTION_GITHUB_REPO?.trim();
  const branch = env.ATLASENT_AI_ACTION_GITHUB_BRANCH?.trim();
  const token = env.ATLASENT_AI_ACTION_GITHUB_TOKEN?.trim();
  if (!repo || !branch || !token) return null;
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(repo);
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2],
    branch,
    token,
    ...(env.ATLASENT_AI_ACTION_PATH_PREFIX?.trim() && { pathPrefix: env.ATLASENT_AI_ACTION_PATH_PREFIX.trim() }),
    ...(env.ATLASENT_AI_ACTION_BREAKER_FILE?.trim() && { breakerFile: env.ATLASENT_AI_ACTION_BREAKER_FILE.trim() }),
    ...(env.ATLASENT_AI_ACTION_STOP_FILE?.trim() && { stopFile: env.ATLASENT_AI_ACTION_STOP_FILE.trim() }),
  };
}

/** A held request this process evaluated: the exact spec and binding it was held for. */
interface HeldAction {
  spec: GovernedActionSpec;
  content: string;
  actorId: string;
  sealedBinding?: SealedBinding;
  audit_id?: string;
}

const MAX_HELD = 256;

type Reply = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const reply = (payload: Record<string, unknown>, isError = false): Reply => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  ...(isError && { isError: true }),
});

export interface AiActionDeps {
  authorize: typeof authorize;
  verify: typeof verify;
  getMode: typeof getMode;
  awaitApproval: typeof awaitApproval;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

export function registerAiActionTools(
  server: McpServer,
  config: AiActionConfig,
  rateLimitOk: (tool: string) => boolean,
  deps: AiActionDeps = { authorize, verify, getMode, awaitApproval },
): { breaker: CircuitBreaker } {
  const breaker = new CircuitBreaker({ stateFile: config.breakerFile, stopFile: config.stopFile, now: deps.now });
  const held = new Map<string, HeldAction>();
  const log = (event: string, data: Record<string, unknown>) =>
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n");

  const adapterFor = (change: GithubFileChange) =>
    githubFileAdapter(change, change.content, { token: config.token, fetchImpl: deps.fetchImpl });

  async function run(action: HeldAction, decision: { decision: string; audit_id?: string; approval_request_id?: string }, permit: string): Promise<AiActionProof> {
    const change: GithubFileChange = {
      owner: config.owner, repo: config.repo, branch: config.branch,
      path: String(action.spec.arguments.path), content: action.content, message: String(action.spec.arguments.message),
    };
    return executeGoverned({
      spec: action.spec,
      actorId: action.actorId,
      permitToken: permit,
      ...(action.sealedBinding && { sealedBinding: action.sealedBinding }),
      decision,
      adapter: adapterFor(change),
      breaker,
      verify: deps.verify,
      now: deps.now,
      argumentsCheck: () =>
        sha256Hex(action.content) === action.spec.arguments.content_sha256 ? null : "content does not match the authorized content_sha256",
    });
  }

  server.registerTool(
    GOVERNED_FILE_CHANGE_TOOL,
    {
      title: "AtlaSent — Governed file change (AI Action Protection)",
      description:
        `Change one file in ${config.owner}/${config.repo} on branch ${config.branch}, under AtlaSent AI Action Protection. ` +
        "The change runs only if the AtlaSent runtime authorizes exactly this change for your agent identity and verifies " +
        "the permit immediately before the write. If the result is `held`, a person must approve it in AtlaSent; call this " +
        "tool again with the same path, content and message plus `approval_request_id`. Changing anything after approval " +
        "requires a new approval. This description is guidance only: the runtime decides.",
      inputSchema: z.object({
        path: z.string().min(1).max(512).describe("Repository path of the file to create or replace."),
        content: z.string().max(256 * 1024).describe("Complete new file content (UTF-8)."),
        message: z.string().min(1).max(512).describe("Commit message."),
        actor_id: z.string().max(256).optional().describe("Reported only. With an agent-bound key AtlaSent uses the key's verified agent."),
        approval_request_id: z.string().max(128).optional().describe("Set when re-running a held change after a person approved it."),
        max_wait_seconds: z.number().int().min(0).max(300).optional().describe("How long to wait for the approval when approval_request_id is set (default 30)."),
      }),
      annotations: {
        title: "AtlaSent — Governed file change",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (!rateLimitOk(GOVERNED_FILE_CHANGE_TOOL)) return reply({ outcome: "refused", reason: "MCP tool rate limit exceeded" }, true);
      if (config.pathPrefix && !args.path.startsWith(config.pathPrefix)) {
        return reply({ outcome: "refused", reason: `this server may only change files under '${config.pathPrefix}'` }, true);
      }
      if (args.path.split("/").some((seg) => seg === ".." || seg === "")) {
        return reply({ outcome: "refused", reason: "path must be a plain repository path" }, true);
      }
      const change: GithubFileChange = {
        owner: config.owner, repo: config.repo, branch: config.branch, path: args.path, content: args.content, message: args.message,
      };

      // Re-run of a held change: the approved permit covers exactly the action
      // this process evaluated; anything else is a new request.
      if (args.approval_request_id) {
        const h = held.get(args.approval_request_id);
        if (!h) {
          return reply({
            outcome: "refused",
            reason: "this server did not evaluate that approval, so it cannot bind its permit to a change. Run the change again without approval_request_id.",
          }, true);
        }
        const same = h.spec.arguments.path === args.path && h.content === args.content && h.spec.arguments.message === args.message;
        if (!same) {
          return reply({
            outcome: "refused",
            reason: "the change differs from the one that was approved. The approval does not cover it; run it again without approval_request_id to ask for a new approval.",
            approved: { path: h.spec.arguments.path, content_sha256: h.spec.arguments.content_sha256, message: h.spec.arguments.message },
          }, true);
        }
        const waited = await deps.awaitApproval({
          approval_request_id: args.approval_request_id,
          max_wait_ms: (args.max_wait_seconds ?? 30) * 1000,
        });
        if (waited.outcome !== "approved") {
          if (waited.outcome === "not_approved") held.delete(args.approval_request_id);
          log("ai_action.not_approved", { approval_request_id: args.approval_request_id, outcome: waited.outcome });
          return reply({ outcome: waited.outcome === "timeout" ? "held" : "refused", approval_request_id: args.approval_request_id, reasons: waited.reasons }, waited.outcome !== "timeout");
        }
        held.delete(args.approval_request_id);
        const proof = await run(h, { decision: "allow", ...(h.audit_id && { audit_id: h.audit_id }), approval_request_id: args.approval_request_id }, waited.permit_token);
        log("ai_action.executed", { outcome: proof.outcome, proof_sha256: proof.proof_sha256 });
        return reply({ outcome: proof.outcome, proof }, proof.outcome !== "executed");
      }

      // New request: authorize exactly this change against the file's current state.
      let baseState: string;
      try {
        baseState = (await adapterFor(change).readState(githubFileChangeSpec(change, "absent", ""))).digest;
      } catch (e) {
        return reply({ outcome: "refused", reason: `could not read the target's current state: ${e instanceof Error ? e.message : String(e)}` }, true);
      }
      const environment = process.env.ATLASENT_ENVIRONMENT?.trim() || "production";
      const spec = githubFileChangeSpec(change, baseState, environment);
      const actorId = args.actor_id ?? "agent:unspecified";
      const auth = await requestAuthorization(spec, actorId, deps);
      const d = auth.decision;
      log("ai_action.decision", { decision: d.decision, target: spec.target_id, digest: auth.digest });

      // When the runtime admitted sealed provenance, its bound hash must be the
      // one we recompute for this action; otherwise we would present something
      // at verify that we cannot tie to the change we run. Refuse (fail closed).
      if ((d.decision === "allow" || d.decision === "hold") && d.bound_payload_hash !== undefined) {
        if (!d.sealed_binding || sealedActionHash(d.sealed_binding, spec) !== d.bound_payload_hash) {
          return reply({
            outcome: "refused",
            reason: "the runtime sealed a different action than this change, so its permit cannot be tied to it. Nothing was changed.",
            target_id: spec.target_id,
          }, true);
        }
      }

      if (d.decision === "hold") {
        if (d.approval_request_id) {
          if (held.size >= MAX_HELD) held.delete(held.keys().next().value as string);
          held.set(d.approval_request_id, {
            spec, content: args.content, actorId: d.bound_actor_id ?? actorId,
            ...(d.sealed_binding && { sealedBinding: d.sealed_binding }),
            ...(d.audit_id && { audit_id: d.audit_id }),
          });
        }
        return reply({
          outcome: "held",
          ...(d.approval_request_id && { approval_request_id: d.approval_request_id }),
          reasons: d.reasons,
          next: "A person must approve this in AtlaSent. Then call this tool again with the same path, content and message and this approval_request_id. Nothing was changed.",
          action_digest: auth.digest,
          target_id: spec.target_id,
        });
      }
      if (d.decision !== "allow") {
        return reply({ outcome: "refused", decision: d.decision, ...(d.deny_code && { deny_code: d.deny_code }), reasons: d.reasons, target_id: spec.target_id }, true);
      }
      const proof = await run(
        { spec, content: args.content, actorId: d.bound_actor_id ?? actorId, ...(d.sealed_binding && { sealedBinding: d.sealed_binding }), ...(d.audit_id && { audit_id: d.audit_id }) },
        { decision: "allow", ...(d.audit_id && { audit_id: d.audit_id }), ...(d.envelope_hash && { envelope_hash: d.envelope_hash }) },
        d.permit_token,
      );
      log("ai_action.executed", { outcome: proof.outcome, proof_sha256: proof.proof_sha256 });
      return reply({ outcome: proof.outcome, proof }, proof.outcome !== "executed");
    },
  );
  return { breaker };
}
