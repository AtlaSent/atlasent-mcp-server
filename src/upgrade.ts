/**
 * How a local-mode user gets to the hosted product.
 *
 * One place for the sign-up link and the wording, because until 2.15 the only
 * pointer lived on stderr — which most MCP hosts hide from both the person and
 * the agent. The same text now reaches the agent through the server's
 * `instructions` and through the local engine's decision `conditions`.
 */

const SIGNUP_BASE = "https://console.atlasent.io/auth/sign-up";

/** Sign-up URL tagged with where the link was shown (for attribution only). */
export function signupUrl(medium: "cli" | "agent" | "readme"): string {
  return `${SIGNUP_BASE}?utm_source=mcp&utm_medium=${medium}`;
}

/** One sentence an agent can relay verbatim to the person it works for. */
export function upgradeHint(medium: "cli" | "agent"): string {
  return (
    "To get real, signed permits from your organization's policy, create a free " +
    `AtlaSent account (${signupUrl(medium)}), choose "Connect an AI agent", and add ` +
    "the ATLASENT_API_KEY it gives you to this MCP server's config; that key alone " +
    "switches the server to remote mode."
  );
}

/**
 * Server-level `instructions` sent to the MCP host at initialize. Hosts that
 * support it put this in the agent's context, so it must stay short and true
 * in both modes.
 */
export function serverInstructions(): string {
  return [
    "AtlaSent decides whether a consequential action (a production deploy, a data " +
      "export, a secret rotation) is authorized before it runs.",
    "Before such an action, call atlasent_evaluate (or evaluate). Only proceed on " +
      "decision=allow, and verify the permit with atlasent_verify_permit immediately " +
      "before acting. On deny, stop and tell the person why. On hold, the action is " +
      "waiting for a person to approve it: use atlasent_await_approval, do not retry " +
      "or work around it.",
    "If no ATLASENT_API_KEY is configured the server runs a local demo engine whose " +
      "permits are unsigned and whose default is allow; it is not protection. " +
      upgradeHint("agent"),
  ].join("\n\n");
}
