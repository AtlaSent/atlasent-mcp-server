# HITL D5 — default `agent.tool.invoke` policy for connected accounts

**Status:** prepared and proven on staging, 2026-10-01. **Production: nothing
written.** This packet asks for the D6 decision. D6 stays not approved until the
founder says otherwise.

Scripts: `atlasent-api` `scripts/hitl-default/seed-agent-tool-invoke-hitl.sql`
and `rollback-agent-tool-invoke-hitl.sql` (staging only; both refuse to run
without `-v confirm=lwnqpmnxpeyhpxvastku`).

## 1. What a new connected account gets today

The research for this packet found that the default is already shipping, and it
is the opposite of Principle 1.

| How the account connects | What `agent.tool.invoke` becomes | Result for an unattended guarded action |
|---|---|---|
| Quick Start → **Create agent and key** (`QuickStartOnboarding.tsx` `onAgentConnected` → `provisionStarterPolicy(AGENT_TOOL_INVOKE_STARTER_POLICY)`) | org row copied from the platform template (`requires_human_approval: false`) + bundle `{"templates":[{"decision":"allow","when":{"all":[]}}]}` | **allowed, no human** (shown live on staging, step 1 below) |
| Settings → **Connect an AI agent** (`Settings.tsx`, no `onConnected`) | no class, no bundle | denied `policy_bundle_missing` (fail closed, but the hook can never hold) |

Neither path gives the connected HITL flow its point: a person deciding.

## 2. The proposed default (exact)

**Class** — the org's `agent.tool.invoke` row. This is the CROSS-063 platform
template plus one change.

| Field | Platform template (today) | Proposed default |
|---|---|---|
| `requires_human_approval` | false | **true** |
| `requires_verified_actor` | true | true (the agent's minted `actor_identity.v1`) |
| `required_assertion_classes` | `{}` (identity, risk deferred) | `{}` |
| `requires_independent_approval` | false | **false for an individual account, true for a team** (chosen at seed time, see §4) |
| `required_context_inputs` | `{tool, environment}` | same |
| `enforcement_mode` / `fail_mode` | enforced / closed | same |
| `required_authorization_mode` | evaluate_and_verify | same |
| `metadata.hitl_default` | — | records the decision, the Canon deviation and a rollback snapshot |

**Bundle** — the sole active version:

```json
{"templates":[{"decision":"allow","name":"hitl_agent_tool_invoke",
  "when":{"all":[
    {"field":"context.tool","exists":true},
    {"field":"context.tool","neq":""},
    {"field":"context.environment","exists":true}]}}]}
```

**Why it holds instead of hard-denying.** `agent.tool.invoke` is on the
lifecycle-escalate allowlist (`atlasent-api`
`_shared/lifecycle-escalate-classes.ts`, founder decision 2026-09-29). With
`requires_human_approval: true`, a missing approval becomes `escalate` plus an
approval-queue item, and a verified, bound approval lifts it to `allow` once.
The bundle only lets a well-formed call (a non-empty tool, an environment) reach
that point. A malformed one matches no template and is denied.

**Canon deviation (IMPL-029), recorded in three places.**
- On the row: `metadata.hitl_default.canon_deviation`.
- In the runtime: `LIFECYCLE_ESCALATE_CANON_DEVIATIONS["agent.tool.invoke"]`.
- In this packet.

ACT-0029 has `requires_human_approval: false` and requires identity and risk
assertions. The variant requires a human and defers both assertions per
CROSS-063. The human approval stands in for the risk assertion.

## 3. What it covers

The flag is class-wide. Every `agent.tool.invoke` evaluation in the org needs a
person:

| Caller | When it evaluates | Effect of the default |
|---|---|---|
| agent-hooks, connected | only an unattended guarded action (an attended one is a local prompt) | held for a person: **the intended behavior** |
| MCP server `agentToolGate` | every gated MCP tool call | each call held for a person |
| MCP server governed action (CROSS-064) | each AI Action Protection write | held for a person |

For an account that uses only the hooks, this is exactly "a human approves
unattended guarded actions". For an account that also uses the MCP gate, it is
stricter than that. It never loosens anything.

## 4. Who may approve

- **Individual (`requires_independent_approval: false`):** the owner may approve
  their own agent's action. Proven live in D3 (Approve once and Deny with note,
  through the console and Okta).
- **Team (`true`):** the CO-6 gate in `v1-evaluate` requires an approver
  different from the requester.
  - **Not proven live on staging.** It is covered only by `v1-evaluate`'s
    existing tests.
- **The team choice must be made at seed time.** The variant sits below the
  Canon floor, because the assertions are deferred. A below-floor row is frozen
  to API edits: `validatePatchNoWeakening` checks the whole merged row
  (`scripts/audit-safeguard-floor.mjs`, CROSS-048 §11). So an org cannot later
  flip independence, or anything else, from the console.

## 5. Rollback

`rollback-agent-tool-invoke-hitl.sql` restores exactly the class flags and
active rules recorded in `metadata.hitl_default.previous`.
- Bundles are immutable, so it republishes the old rules as a new version and
  never edits or deletes a row.
- If the seed created the class, rollback sets it `inactive` and archives its
  bundle.
- **Holds raised before a rollback stay pending.** They still need a person, and
  nothing is approved by the rollback. The packet does not propose withdrawing
  them automatically.

## 6. Staging evidence (runtime staging, org `edd340bf…`, 2026-10-01)

All runs used the real hook (`decide()` from `packages/agent-hooks`) for an
unattended `git push --force`. No command was executed.

| Step | Policy | Hook result |
|---|---|---|
| 1. Baseline | today's Quick Start default (bundle v2: unconditional allow, `requires_human_approval: false`) | **`allow`**, no human |
| — | seed refused without `confirm` | `hitl-default: staging only; pass -v confirm=…` |
| 2. Seed (verbatim script) | HITL default (bundle v3) | **held**: approval `f1ab45d7…`; retry: "Still waiting for a person to decide" |
| 3. Rollback (verbatim script) | restored v2 flags, v2 rules republished as v4 | new action **`allow`**; `f1ab45d7…` still pending |
| 4. Re-seed, twice | HITL default (v5) | second run published nothing (max version 5, one active); snapshot kept (v4, no human) |

Step 4 ran the script's logic as a temporary function, without its confirmation
guard. Steps 2 and 3 ran the files verbatim. D3 already proved the approve and
deny halves through the console.

## 7. Decisions for D6

1. **Approve this default for new connected accounts?** That means the class and
   bundle in §2, individual by default.
2. **Scope (§3):** accept class-wide, which also holds MCP-gate and governed
   calls? The alternative is to scope the hold to `context.session_mode =
   'unattended'`. That needs a rule-level approval path that nobody has built or
   proven yet.
3. **Which provisioning path** (nothing is wired yet):
   - **A (recommended):** a runtime seed run server-side when an agent is
     connected (`mint_agent_key`), only when the org has no `agent.tool.invoke`
     class. Both connect paths then get the same default, and an existing,
     governed policy is never overwritten.
   - **B:** change Quick Start's `AGENT_TOOL_INVOKE_STARTER_POLICY` and the
     class flag. This leaves the Settings path without a policy.
   - **C (not recommended):** change the platform template. That changes every
     org that ever gets the class, not only connected accounts.
4. **Floor exception:** the variant is a declared below-floor row. A production
   seed should be registered in `scripts/safeguard-floor-exceptions.json`, as the
   platform template is. A raw SQL seed is invisible to the floor guard, which
   scans `.ts` only.
5. **Team accounts (§4):** how an account is marked as a team at connect time,
   since the setting cannot be changed afterwards through the API.
6. **Existing accounts:** this packet proposes **no change** to orgs that already
   have an `agent.tool.invoke` class, including those on the allow-everything
   Quick Start default. Moving them is a policy change and must go through the
   governed policy-change path, one org at a time.

**Not included in any D6 approval of this packet:** production writes to
existing orgs, the rule-scoped alternative in (2), and phone push.
