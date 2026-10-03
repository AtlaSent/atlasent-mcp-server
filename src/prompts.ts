/**
 * MCP Prompts (issue #163): ready-made templates a user can pick in their
 * host to drive the authorize-before-execute flow.
 *
 * A prompt only GUIDES the agent. It enforces nothing: an agent can ignore
 * it, and a prompt is not a non-bypassable Gate. The enforcement point is
 * the AtlaSent decision plus permit verification at the execution boundary
 * (e.g. `deploy_service`, or your own tool that calls `verify_permit`
 * immediately before its side effect). Every prompt text below says so, so
 * that nobody reads a prompt as a control.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const PROMPT_NAMES = ["gate-action", "explain-decision", "find-action-type"] as const;

/** Prompt argument values are bounded so a pasted blob cannot balloon the message. */
const MAX_ARG_LEN = 2_000;
const MAX_DECISION_LEN = 20_000;

const NOT_A_GATE =
  "This prompt is guidance, not enforcement. It does not stop anything by itself; " +
  "the action is protected only where a permit is verified immediately before it runs.";

function userMessage(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

export function gateActionText(action: string, environment?: string): string {
  const env = environment?.trim()
    ? `in the \`${environment.trim()}\` environment`
    : "in the environment it targets (ask me if you are not sure which one)";
  return [
    `Before you do this, gate it with AtlaSent: ${action.trim()} ${env}.`,
    "",
    "Follow these steps in order. Stop at the first step that fails, and do not perform the action.",
    "",
    "1. Resolve the action type. Call `atlasent_lookup_action` with `query` set to a plain-language " +
      "description of the action. Use the returned slug only when `retrieval.confidence` is `confident`. " +
      "If it is `ambiguous`, show me the candidates and ask which one applies. If it is `none`, stop: " +
      "never invent an action type.",
    "2. Evaluate. Call `evaluate` with that `action_type`, the `actor_id` you act as, the `environment`, " +
      "and a `target_id` naming exactly what will change. For change-controlled actions " +
      "(e.g. `production.deploy`) also pass a `change_plan`; if you do not know the revision or " +
      "artifact, ask me rather than making one up.",
    "3. Gate on the decision. Proceed only if `decision` is `allow`. On `deny`, stop and report the " +
      "reasons. On `hold`, stop: the action is waiting for a human approval, so report the approval " +
      "request and do not retry around it. Treat an error, a timeout, or any other answer as `deny`.",
    "4. Verify the permit immediately before acting. Call `verify_permit` with the `permit_token` from " +
      "step 2 and the SAME `action_type`, `actor_id`, `environment` and `target_id`. Proceed only if " +
      "`valid` is `true`. Expired, invalid, replayed, mismatched, or error outcomes block the action.",
    "5. Only then perform the action, exactly as evaluated: same target, same change. If anything about " +
      "it changed after step 2, start again from step 2.",
    "",
    "Afterwards, tell me the decision, the permit outcome, and any evaluation or audit id the tools returned.",
    "",
    NOT_A_GATE,
  ].join("\n");
}

export function explainDecisionText(decision: string): string {
  return [
    "Explain this AtlaSent decision to me in plain language.",
    "",
    "```json",
    decision.trim(),
    "```",
    "",
    "Cover:",
    "- What was decided (`allow`, `deny`, or `hold`) and for which action, actor, environment and target.",
    "- Why, using only the reasons, deny codes, and policy details present in the decision. " +
      "Do not guess at policy that is not shown; say what is missing instead.",
    "- What would change the outcome (for example an approval, a change window, a different " +
      "environment, or a matching target), stated as possibilities, not promises.",
    "- For `hold`: who or what it is waiting on, and that the action must not run until it resolves.",
    "",
    "Do not suggest ways to bypass the decision, retry under a different action type, or perform the " +
      "action anyway. A `deny` or `hold` means the action must not run. Treat a decision that does not " +
      "parse, or has an unknown value, as `deny`.",
  ].join("\n");
}

export function findActionTypeText(description: string): string {
  return [
    `Find the AtlaSent Canon action type for this: ${description.trim()}`,
    "",
    "Call `atlasent_lookup_action` with `query` set to that description, then handle " +
      "`retrieval.confidence`:",
    "- `confident`: report `actions[0]` (its slug, what it covers, and its gate flags).",
    "- `ambiguous`: list `retrieval.candidates` with a one-line difference for each, and ask me which " +
      "applies. Do not pick one for me.",
    "- `none`: say the Canon has no matching action and pass on the tool's `hint`. Do not invent a slug " +
      "or reuse a near miss.",
    "",
    "Words like emergency, urgent or weekend are policy context, not a different action. " +
      "Looking up an action type authorizes nothing.",
  ].join("\n");
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "gate-action",
    {
      title: "Gate this action before running it",
      description:
        "Guides the agent through AtlaSent before a consequential action: look up the Canon action " +
        "type, evaluate, proceed only on allow, and verify the permit immediately before acting. " +
        "Guidance only: it enforces nothing by itself.",
      argsSchema: {
        action: z
          .string()
          .min(1)
          .max(MAX_ARG_LEN)
          .describe("The action you are about to take, in plain language (e.g. \"deploy api-service to production\")."),
        environment: z
          .string()
          .max(MAX_ARG_LEN)
          .optional()
          .describe("Target environment (e.g. production, staging). Optional."),
      },
    },
    ({ action, environment }) => userMessage(gateActionText(action, environment)),
  );

  server.registerPrompt(
    "explain-decision",
    {
      title: "Explain an AtlaSent decision",
      description:
        "Explains in plain language why an action was allowed, denied or held, and what could change " +
        "the outcome, using only what the decision contains.",
      argsSchema: {
        decision: z
          .string()
          .min(1)
          .max(MAX_DECISION_LEN)
          .describe("The decision JSON returned by evaluate / atlasent_evaluate."),
      },
    },
    ({ decision }) => userMessage(explainDecisionText(decision)),
  );

  server.registerPrompt(
    "find-action-type",
    {
      title: "Find the Canon action type",
      description:
        "Maps a plain-language description to a Canon action type with atlasent_lookup_action, " +
        "handling confident, ambiguous and none results without inventing a slug.",
      argsSchema: {
        description: z
          .string()
          .min(1)
          .max(MAX_ARG_LEN)
          .describe("What the action does, in plain language."),
      },
    },
    ({ description }) => userMessage(findActionTypeText(description)),
  );
}
