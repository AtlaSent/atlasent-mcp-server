# @atlasent/mcp-server

MCP server that enforces authorize-before-execute for any MCP-compatible AI agent.

It is the developer entry point to AtlaSent **AI Action Protection**, which Enterprise teams adopt through a [design partner program](https://www.atlasent.io/ai-actions).

[![npm version](https://img.shields.io/npm/v/@atlasent/mcp-server.svg)](https://www.npmjs.com/package/@atlasent/mcp-server)
[![CI](https://github.com/Atlasent/atlasent-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Atlasent/atlasent-mcp-server/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Glama MCP server](https://glama.ai/mcp/servers/Atlasent/atlasent-mcp-server/badge)](https://glama.ai/mcp/servers/Atlasent/atlasent-mcp-server)

**AtlaSent is security and organizational authority infrastructure for consequential actions by people, software, and AI.**

This MCP server brings it to AI agents (Claude, Cursor, Windsurf, any MCP host). Before an agent's tool call changes a real system (a production deploy, a data export, an access grant), the agent asks AtlaSent first. With an API key (remote mode):

1. **Connect it** to your agent with a few lines of config.
2. **Risky actions wait** for a person to approve them. Everything else runs as normal.
3. **Every decision gets a signed record**, including who approved it when the decision relied on an approval.

Try it in 60 seconds with no account: `npx -y @atlasent/mcp-server` (local mode, a demo that protects nothing).

**Local blocking is free.** To actually block on your own machine without an account, use [MCP Gate](./packages/mcp-gate) or the [Claude Code agent guard](./packages/agent-hooks). Both are part of the free Community plan. Hosted decisions, shared policies and approvals for a team are on the [AtlaSent plans](https://www.atlasent.io/pricing).

### For engineers

AtlaSent performs **execution-time authorization**: determine whether a specific consequential Action is authorized now, issue a bounded Permit on `allow`, verify that Permit at the execution Gate, and only then allow the governed native effect.

> **A plausible request is not organizational authority.**

This MCP server exposes AtlaSent authorization primitives to Model Context Protocol hosts and includes a protected deployment demo that proves the ordering end to end.

## Which authority decided?

This repository ships **two packages**, and one of them has two modes. All three block
tool calls. Only one of the three is evidence, and the difference is not a feature list —
it is *who said yes*.

| Surface | Who decided | What it is |
|---|---|---|
| `@atlasent/mcp-server` **local mode** | a built-in heuristic | **nothing** — a credential-free demo. Its terminal rule is `allow`, including for action types it does not recognise. Never rely on it as protection. |
| [`@atlasent/mcp-gate`](./packages/mcp-gate) + `policy.json` | **you**, in advance, in a file you can edit | **operator configuration.** Starts at `{"default":"deny","rules":[]}` and blocks everything until you write a rule. Runs with no account and no network. |
| `@atlasent/mcp-gate` **cloud mode** | **your organization**, at execution time | an **organizational permit** — single-use, bound to that call, verifiable afterwards. |

A rule you can silently edit is configuration. A permit your organization issued, that was
consumed once and can be produced later, is authority. Both stop the call; only the second
answers *"who authorized this?"* — which is the question that arrives after an incident,
not before one.

The gate says which one decided, on every decision: `no_matching_rule` is your local
policy, `cloud_permit_consumed` is an organizational permit. **These reason strings are
deliberately not normalised into a generic "blocked."** Do not collapse them.

The two packages point in opposite directions, which is why they are separate:
`mcp-server` exposes AtlaSent *as* MCP tools an agent calls to ask for authorization;
`mcp-gate` sits *in front of* someone else's MCP server and intercepts.

## The invariant

For an enforced protected path:

```text
Action proposed
  → current organizational Authority + Policy + Context evaluated
  → Decision
      deny / hold / escalate → STOP
      allow → bounded Permit
  → Permit Verification at the execution Gate
      invalid / expired / replayed / mismatched / error → STOP
      verified → native effect may execute
  → execution/native-effect Evidence recorded where the integration supplies it
```

**Evaluation is not execution. A positive Decision is not the Gate. Permit Verification happens before the protected side effect.**

## Quickstart: 60 seconds, no account

You don't need an AtlaSent account or API key to try this server. With no credentials set, it runs in **local mode**: an in-process rules engine that works offline.

Add this to your MCP host config (Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, and others; per-host file locations are [below](#claude-desktop)):

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": { "ATLASENT_MODE": "local" }
    }
  }
}
```

Then ask your agent to *"deploy billing-api to production"*. The built-in rules deny it because it has no approvals. Ask again with an approval and it's allowed, and the server verifies the permit before the simulated deploy runs.

Built-in local rules (`src/localEngine.ts`):

| Situation | Decision |
|---|---|
| Production action with no approvals | `deny` |
| Destructive action (`delete`, `drop`, `purge`, ...) outside a change window | `hold` |
| Sign / certify / grant / revoke / suspend / resume actions | `deny` |
| Override / release / export / import / publish actions | `hold` |
| Anything that passes the rules | `allow` → single-use permit, 5-minute TTL |

Local permits are **unsigned**, so local mode is for development, CI, and trying things out. It's not a production enforcement boundary. The server refuses to fall back to local mode under `NODE_ENV=production`. When you're ready for signed permits, audit evidence, and your organization's own policies, switch to [remote mode](#local-vs-remote-mode) — [get an API key](#get-an-api-key).

### Run from source

```bash
git clone https://github.com/Atlasent/atlasent-mcp-server.git
cd atlasent-mcp-server
npm install
npm run build
npm run demo      # blocked deploy → approved + verified deploy → replay refused, fully offline
```

### Run with Docker

```bash
docker build -t atlasent-mcp .
docker run -i --rm atlasent-mcp                                          # local mode, stdio
docker run -i --rm -e ATLASENT_API_KEY -e ATLASENT_BASE_URL atlasent-mcp  # remote mode
```

## Claude Code plugin: stop agents destroying production

[`packages/agent-hooks`](./packages/agent-hooks) is a Claude Code plugin. Destructive
and shipping commands wait for a person: `DROP TABLE`, `terraform destroy`, volume
deletes, `git push --force`, production deploys. With nobody to ask, they are refused.
Everything else runs as normal. Local, no account.

```text
/plugin marketplace add Atlasent/atlasent-mcp-server
/plugin install atlasent-guard@atlasent
```

"Someone at the keyboard said yes" is where it stops. The rest of this repository is
the organizational version: an approver your organization named, and a permit you can
prove afterwards.

## Canon-backed Actions

AtlaSent does not treat every ad-hoc tool string as a new governed Action Type.

Use the **Protected Action Canon** for stable Action identity. Two important examples are:

```text
production.deploy
agent.tool.invoke
```

For a generic AI tool invocation, use `agent.tool.invoke` as the public Canon-backed Action Type and carry tool-specific facts—tool name, target, environment, arguments/payload digest, resource state, and other required context—in the authorization context or binding fields supported by the selected integration path.

Use the read-only `atlasent_lookup_action` tool to discover Canon-backed Action Types instead of inventing a parallel taxonomy.

## Authority is not Approval

Keep the concepts separate:

- **Authority** — standing, scoped organizational right to cause a class of change.
- **Authorization** — per-request determination whether this exact Action may proceed now.
- **Policy** — versioned conditions applied to the determination.
- **Approval** — verified input that may satisfy a Policy condition; not standing Authority and not the final Authorization result.
- **Decision** — `allow | deny | hold | escalate` at the platform boundary.
- **Permit** — bounded positive-Authorization artifact.
- **Verification** — execution-boundary check of the Permit and applicable bindings.
- **Execution / native effect** — what the underlying tool or system actually does.
- **Evidence / Proof** — durable evidence of the authorization and, where observed, the effect/result.

A human Approval, favorable risk signal, policy match, deployment ticket, or workflow status does not by itself become organizational Authority.

## Protected-tool demo

`deploy_service` is intentionally small. It demonstrates a two-layer protected path:

```text
agent requests deploy_service
  → authorize internal agent-tool compatibility gate
  → verify outer Permit
  → authorize production.deploy
  → verify production.deploy Permit
  → simulated deployment effect
```

The internal outer gate uses the Canon-backed `agent.tool.invoke` Action (`CANON-000026` / `ACT-0029`) — the same public identifier documented throughout the AtlaSent ecosystem as the canonical generic AI-agent tool invocation. It previously used a legacy, uncatalogued identity, `model.agent.execute_tool`, which had no corresponding `action_classes` provisioning path in the runtime (no seed/migration anywhere creates a row with that slug) — so against a real, unmodified Atlasent org the outer gate could only ever return `NO_ACTION_CLASS` deny, regardless of the tool-specific inner gate's own decision. Migrating the outer gate onto `agent.tool.invoke` gives it the runtime's real "AI Agent Safeguard" provisioning path, which already exists for exactly this purpose. See Atlasent/atlasent-mcp-server#121 for the full investigation and decision record.

If either Decision is non-allow **or either Permit fails Verification**, no deployment result is produced.

The protected-tool response includes the action-specific Verification result alongside the simulated native result:

```json
{
  "decision": "allow",
  "permit_token": "...",
  "verification": {
    "outcome": "verified",
    "valid": true
  },
  "result": {
    "status": "deployed",
    "service": "billing-api"
  }
}
```

The returned Permit has already been consumed by the execution-boundary Verification. Verifying it again should be treated as a replay, not as a step required after deployment.

## Human-in-the-loop demo: hold, approve, execute, record

`examples/hitl-demo.mjs` shows one uninterrupted sequence against a hosted runtime and a real GitHub repository, using [`atlasent_governed_file_change`](docs/AI_ACTION_PROTECTION.md) (AI Action Protection, a design partner program):

| Stage | What you see |
|---|---|
| 1 ATTEMPT | The agent asks to change a config file |
| 2 HOLD | The runtime holds it and returns an `approval_request_id`. The file is re-read and is unchanged |
| 3 BOUND | The same request with different content is refused, so the approval covers only this change |
| 4 APPROVE | A person approves the request in the AtlaSent console (Approvals) |
| 5 EXECUTE | The permit is verified at the boundary, then exactly one write is made, and the commit sha is printed |
| 6 RECORD | The tool re-reads the effect at the commit and at the branch head, the demo re-reads it again, and the `ai_action_proof.v1` hash is printed |

The key must be agent-bound (console: Settings → Connect an AI agent). Use a dedicated demo repository.

```bash
npm run build
ATLASENT_API_KEY=ask_test_... \
ATLASENT_BASE_URL=https://<ref>.supabase.co/functions/v1 \
ATLASENT_ENVIRONMENT=staging \
ATLASENT_AI_ACTION_GITHUB_REPO=owner/demo-repo \
ATLASENT_AI_ACTION_GITHUB_BRANCH=main \
ATLASENT_AI_ACTION_GITHUB_TOKEN=<token that can write only that repo> \
npm run demo:hitl
```

The demo prints only what the tool returned or the repository showed. If a stage doesn't happen, the demo stops with `FAIL at <stage>` and exits 1. For example, if the org's `agent.tool.invoke` policy allows the change with no person involved, the demo fails at ATTEMPT rather than skipping the hold. The org's policy must require human approval. It writes `hitl-demo-evidence-<ts>.json`, and the permit appears in it only as a sha256.

Before presenting, run `npm run demo:hitl:preflight`. It's a read-only setup check: it makes GET requests only and creates no request, approval, permit or commit. The presenter run sheet, with prerequisites, console clicks and expected output, is [`docs/DEMO_90_SECONDS.md`](docs/DEMO_90_SECONDS.md).

`npm run demo:hitl -- --simulate` rehearses the same stages offline with an in-memory runtime, repository and approver. Every line it prints starts with `[SIMULATED]`, and it refuses any real network call. Don't present a simulated run as a live one.

## Self-gating agent pattern

For an agent or MCP host that owns its own native tool boundary, the safe pattern is:

```ts
const decision = await evaluate({
  action_type: "agent.tool.invoke",
  actor_id: "agent:research-bot",
  environment: "production",
});

if (decision.decision !== "allow") {
  throw new Error("Action is not authorized");
}

const verification = await verify_permit({
  permit_token: decision.permit_token,
  action_type: "agent.tool.invoke",
  actor_id: "agent:research-bot",
  environment: "production",
  // Present target_id / payload_hash when the selected authorization path
  // binds those fields.
});

if (!verification.valid) {
  throw new Error("Permit did not verify");
}

// Only now may the protected native effect occur.
const result = await runProtectedTool();
```

A wrapper, decorator, prompt, or MCP tool definition is not automatically a non-bypassable Gate. The enforcement claim belongs to the actual topology: the native effect must be unreachable through the claimed protected path unless required Authorization and Permit Verification succeeded.

## Core tools

### `evaluate`

Simple local/remote authorization helper for MCP hosts.

```text
Input:  { action_type, actor_id, environment, approvals?, change_window?, target_id?, change_plan?, target_system? }
Output: { decision: "allow" | "deny" | "hold", permit_token?, notes?, ... }
```

On `allow`, **do not execute yet**. Present the Permit to `verify_permit` at the execution boundary first.

### `verify_permit`

Execution-boundary verification helper.

```text
Input: {
  permit_token,
  action_type,
  actor_id,
  environment,
  approvals?,
  change_window?,
  target_id?,
  payload_hash?
}
Output: { outcome: "verified" | "expired" | "invalid" | "error", valid, ... }
```

Proceed only when `valid === true`. Successful Verification consumes a single-use Permit where that contract applies.

### `deploy_service`

Protected deployment demonstration. It performs the necessary Authorization and Verification internally before producing its simulated deployment result.

### `atlasent_evaluate` / `atlasent_verify_permit`

Hosted V1 API-facing tools. Use the richer remote evaluation path when you need additional context beyond the small `evaluate` demo envelope. Verification remains an execution-boundary operation.

### `atlasent_lookup_action`

Read-only Canon lookup for Action Types, gate flags, authorization patterns, evidence requirements, and graph relationships.

```text
Input:  { slug? }    // exact Canon slug, e.g. "production.deploy"
        { query? }   // plain language, e.g. "deploy the api service to prod"
        {}           // list the full Canon
Output: { found, result_count, actions[], retrieval? }
```

`query` is resolved by a deterministic, fully offline ranker over the vendored Canon (no embeddings service, no network — `src/actionRetrieval.ts`). The response carries a `retrieval` block:

| `retrieval.confidence` | Meaning |
|---|---|
| `confident` | One Canon entry clearly matches. `actions[0]` is it. Safe to act on. |
| `ambiguous` | Two or more entries are close, or the request only partly matched. Read `retrieval.candidates` and pick, or rephrase. |
| `none` | The Canon has no action matching this description. `found` is `false`, `actions` is empty, and `hint` points at the Canon intake pipeline. |

The tool never invents an action type: every candidate is a Canon entry by reference, and a request the Canon cannot answer comes back as `none` rather than a plausible-looking slug. Context words such as *emergency*, *weekend*, or *urgent* are treated as policy context, not as evidence of a different action — "emergency deploy to production" still resolves to `production.deploy`, per `LIFECYCLE.md`'s classification principle.

### `atlasent_atlas_lookup`

Read-only lookup of canonical AtlaSent concepts such as Authority, Policy, Decision, Permit, Verification, Evidence, Gate, and Trust Root.

### `atlasent_evidence_gap_report`

"Where are my deploys ungoverned?" Pass the text of your `.github/workflows/*.yml` files and get back every step that changes a real system (deploys, package and image publishes, database migrations, `terraform`/`pulumi` applies), each with a status:

| `status` | Meaning |
|---|---|
| `bound` | A gate runs earlier in the job, and the step runs only `if: steps.<gate>.outputs.verified == 'true'`. |
| `gated` | A gate runs earlier in the job; a deny fails the job before the step. |
| `gated_upstream` | The gate is in a job this job `needs:`. Nothing re-verifies the permit where the step runs. |
| `weak` | A gate exists but cannot stop the step: `continue-on-error`, its own `if:` (a `skip_gate` input, for example), or `mode: evaluate-only` with nothing consuming the permit. |
| `ungoverned` | No gate at all. |

```text
Input:  { workflows: [{ path, content }], gate_actions? }
Output: { summary, findings[], triggers, parse_errors[], not_checked[], next_step, setup? }
```

Every gap (`ungoverned` or `weak`) carries a `fix`: the `atlasent-action` step to insert before it (with the action type that fits: `production.deploy`, `package.release` or `infrastructure.change`), the exact `if:` that binds the step to the gate's verified permit, and any change the existing gate needs (drop `continue-on-error`, drop a `skip_gate` condition, add `id-token: write`). When there are gaps, `setup` gives the sign-up link for the API key the gate needs. Apply the fix and run the report again: the step shows as `bound`.

Works in local mode: no API key, no network, nothing executed. `gate_actions` names your own gate wrappers (a composite action, say); they are reported as custom gates whose internals were not inspected. The report always lists what it cannot see (repository settings, deploys outside CI, the inside of `./deploy.sh`), and a file it cannot parse is listed in `parse_errors`, never skipped. A clean report is not proof that nothing is ungoverned.

### `atlasent_integrity_audit`

Read-only audit of the organization's Authority graph for internal inconsistency. Hosted mode only; the organization is derived server-side from the API key.

```text
Input:  { decision_window_days? }   // 1-3650; omit to let the server choose
Output: the integrity report, verbatim
```

**This is not a pass/fail health check, and the tool adds no verdict of its own.** Each finding carries a three-way `classification`:

| `classification` | How to read it |
|---|---|
| `defect` | A genuine inconsistency in the Authority graph. |
| `non_exercisable` | Frequently the **correct, healthy** state — e.g. an expired grant that is supposed to be expired. Not a failure. |
| `unresolved` | The proposition **could not be verified**. Never treat it as clean; "could not check" and "checked and found nothing" are different facts. |

Read `summary.audited_scope` before concluding anything from an empty `findings` list — a short decision window is not an absence of findings. If the audit cannot complete, the server refuses rather than returning a partial report, and this tool surfaces that as an error rather than an empty report.

### `atlasent_get_permit` / `atlasent_check_permit` / `atlasent_get_decision`

Read-only lookups of a single record. Hosted mode only.

```text
atlasent_get_permit    { permit_id }                     -> the permit record (status, actor, action, times, decision_id)
atlasent_check_permit  { permit_id }                     -> { valid, status: active|revoked|consumed|expired, revoked_at? }
atlasent_get_decision  { evaluation_id, include_trace? } -> { evaluation, trace?: { approvals, permit_uses, webhooks } }
```

`atlasent_check_permit` reads status without consuming the permit. Use it before a deferred action to catch a revocation, but it is **not** authorization: execute only after `atlasent_verify_permit`. `atlasent_get_decision` requires the `audit:read` scope; a permit's `decision_id` is the id to pass.

Permit tools never return the permit's `token` (its bearer credential) or `signature`. Anything a tool returns lands in the agent's context and transcript, so both fields are stripped client-side as well as by the API.

The server also exposes policy, permit, approval, evidence, compliance, and VQP tools. Use MCP `tools/list` for the exact tool inventory supported by the installed version.

## Approval workflow

Approval can be required, but resolving an Approval is not equivalent to executing the protected Action.

```text
Approval / Assertion collected
  → current Authorization / reevaluation path
  → Decision
  → Permit on allow
  → Verification
  → native effect
```

Approvals are made by a person in the AtlaSent console, never by an agent: this server deliberately has no tool that creates or resolves an approval. When an action is held for a person, the result carries an `approval_request_id`; call `atlasent_await_approval` with it to wait while the person decides in the console. On approval it returns a permit that must still pass `atlasent_verify_permit`; a rejection, expiry or timeout returns no permit and the action does not run. (Remote mode only; local mode never approves.) The protected Action must still satisfy the current authorization path and execution-boundary Verification before proceeding.

**Change plans and plan changes.** `production.deploy`, `infrastructure.change`, `production.rollback` and `secret.configuration.change` need a `change_plan` (`{ operation, revision?, artifact_ref? }`, with a revision and/or artifact ref). Pass it to `deploy_service`, `evaluate` or `atlasent_evaluate`. The server first creates a Change Brief recording exactly that plan, then evaluates with the brief id and the same plan. When the key cannot create briefs (HTTP 403) or the runtime has none (HTTP 404), the server evaluates with the plan alone and adds a `notes` entry. Any other brief failure blocks the evaluation. On claim, the server presents the same plan again, so a mismatch means the plan really changed. If your plan changed while you waited, pass the new plan to `atlasent_await_approval` as `change_plan`. By default the server files **one** linked re-request for the new plan (`supersedes_approval_id` set to the old approval), then waits for a person to decide it. The result shows the steps in `summary`, for example "plan changed from X to Y → re-request sent (approval …) → waiting → approved". With `on_plan_mismatch: "use_approved"`, the server claims the approved plan and returns it as `approved_plan`; run exactly that plan. A second mismatch, a revoked or suspicious approval, or an organization policy with `auto_rerequest_on_mismatch: false` stops the wait with no permit. The result includes the diff and what to do next.

For action classes that require a verified actor, the runtime resolves the approval to `approved_awaiting_claim` and mints the permit only when the claim presents the actor's identity. The server then asks the runtime for a short-lived `actor_identity.v1` for its own agent (`POST /v1-agent-actor-identity`, available only to an API key bound to a registered agent). The action type and environment come from the approval record, and the server claims with `{ actor_identity }`. If that identity cannot be obtained, nothing is claimed and no permit is returned. On a runtime without that endpoint (HTTP 404), the server claims with an empty body as before and adds a note to the result.

## Which agent, whose agent, which chat

Every evaluate call reports **which app** it came from (the MCP client's name,
e.g. `claude-code` or `cursor`) and **which chat or session** as
`agent_session`. AtlaSent stores this labelled *reported by the agent host*:
useful for tracing an action back to the conversation that caused it, never
used to decide anything.

- Session id: the Streamable HTTP session, else `ATLASENT_SESSION_ID` if your
  host sets it, else a per-process id prefixed `mcp-process-`.
- Optional `ATLASENT_RUN_ID` for a run or job id.
- With an **agent API key**, leave `actor_id` empty: AtlaSent identifies the
  agent and the person it acts for from the key itself, so the model never
  names itself.

## Execution evidence

`atlasent_record_execution_evaluation` records an observed execution outcome after the native effect. That evidence function does **not** replace pre-execution Permit Verification.

Keep these statements distinct:

- an `allow` Decision proves a positive authorization determination was made;
- a verified Permit proves the bounded authorization artifact passed its Gate checks at that point in time;
- execution/native-effect evidence is what supports a claim that the underlying action actually occurred.

## Local vs remote mode

| Mode | Purpose |
|---|---|
| `local` | Zero-config: offline in-process rules engine, unsigned permits. Development, demos, CI. |
| `remote` | Calls the configured AtlaSent hosted/runtime API. |

### Get an API key

1. Create a free account at
   **[console.atlasent.io/auth/sign-up](https://console.atlasent.io/auth/sign-up?utm_source=mcp&utm_medium=readme)**.
2. Choose **Connect an AI agent** (also under **Settings → API Keys**). Name the
   agent, pick your app (Claude Code, Claude Desktop, Cursor, Windsurf, …) and
   the console gives you a key plus the exact command or JSON to paste.
3. Paste it into your MCP host config. `ATLASENT_API_KEY` on its own switches the
   server to remote mode; `ATLASENT_BASE_URL` is optional and defaults to the
   hosted API.
4. Ask your agent to try something consequential (for example, "deploy the api
   service to production"). The console shows the decision, and anything that
   needs approval waits in the approval queue until someone approves it.

Remote mode gives you what local mode cannot: Ed25519-signed, single-use permits,
your organization's own policies, and a tamper-evident audit trail.

Remote example:

```bash
ATLASENT_API_KEY=ask_live_xxx \
ATLASENT_BASE_URL=https://api.atlasent.io/functions/v1 \
ATLASENT_MCP_READONLY=1 \
npx @atlasent/mcp-server
```

`ATLASENT_BASE_URL` defaults to `https://api.atlasent.io/functions/v1` — this is the
correct base for the core `evaluate` / `verify_permit` / `atlasent_evaluate` path and
for other dash-form direct endpoints (`/v1-evaluate`, `/v1-verify-permit`,
`/v1-authority-intelligence/...`). The generic REST tools (policies, permits, audit
events, webhooks, SCIM, SIEM, evidence exports, approval requests) are served at the
gateway/API domain root under slash-form paths (`/v1/policies`, `/v1/permits`, ...);
the server automatically strips the `/functions/v1` suffix for those calls, so a
single `ATLASENT_BASE_URL` value works for both families — no separate configuration
needed.

`ATLASENT_FUNCTION_REGION` controls where the runtime's edge functions execute.
Unset, calls to the hosted runtime run in `us-west-1`, next to its database. A
self-hosted base URL is left to Supabase's nearest-region default. Set it to a
region id to pin elsewhere, or to `auto` to disable pinning. Execution next to
the database matters: evaluate makes dozens of sequential database round trips.

## Read-only mode for live demos

Set:

```bash
ATLASENT_MCP_READONLY=1
```

to prevent registration of mutating administrative tools during a live-API demo. Read-only mode does not turn the server into a universal security boundary; it reduces the exposed mutation surface. The protected execution path still depends on the Authorization and Verification topology described above.

## Fail-closed behavior

For a path that is configured to require AtlaSent Authorization and Permit Verification, treat these as block conditions:

- non-allow Decision;
- missing required Permit;
- authentication/API failure;
- invalid, expired, revoked, replayed, or binding-mismatched Permit;
- Verification error;
- missing required execution binding.

Shadow/advisory evaluation is useful for observation, but it is not the same as enforced execution protection.

## Claude Desktop

Add to `claude_desktop_config.json`. A ready-made file with remote, local, and HTTP variants is in [`examples/claude_desktop_config.json`](./examples/claude_desktop_config.json).

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": {
        "ATLASENT_MODE": "remote",
        "ATLASENT_API_KEY": "ask_live_xxxxxxxxxxxxxxxx",
        "ATLASENT_BASE_URL": "https://api.atlasent.io/functions/v1",
        "ATLASENT_MCP_READONLY": "1"
      }
    }
  }
}
```

## Claude Code

Add the server with `claude mcp add`. It runs over stdio. Everything after `--` is the command Claude Code starts:

```bash
claude mcp add atlasent -e ATLASENT_MODE=local -- npx -y @atlasent/mcp-server
```

Run `claude mcp list` to check it connects, or `/mcp` inside a Claude Code session to see its tools.

**Scope.** `--scope` (`-s`) controls where the entry is stored:

| Scope | Stored in | Use it for |
|---|---|---|
| `local` (default) | your user config, for the current project only | trying it out |
| `project` | `.mcp.json` at the repo root, checked in | sharing the server with everyone who works on the repo. Claude Code asks each person to approve a project server before it starts. |
| `user` | your user config, for every project | using it everywhere you run Claude Code |

```bash
claude mcp add atlasent --scope project -e ATLASENT_MODE=local -- npx -y @atlasent/mcp-server
```

writes this `.mcp.json`:

```json
{
  "mcpServers": {
    "atlasent": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": { "ATLASENT_MODE": "local" }
    }
  }
}
```

Don't commit an API key in a project-scope `.mcp.json`. For remote mode, use `local` or `user` scope.

**Remote mode.** Set `ATLASENT_API_KEY`. A key on its own switches the server to remote mode, and `ATLASENT_BASE_URL` defaults to `https://api.atlasent.io/functions/v1`. `ATLASENT_MODE=remote` makes the choice explicit, and `ATLASENT_MODE=local` forces local mode even when a key is set. See [Local vs remote mode](#local-vs-remote-mode).

```bash
claude mcp add atlasent --scope user \
  -e ATLASENT_MODE=remote \
  -e ATLASENT_API_KEY=ask_live_xxxxxxxxxxxxxxxx \
  -e ATLASENT_BASE_URL=https://api.atlasent.io/functions/v1 \
  -- npx -y @atlasent/mcp-server
```

To switch modes, remove the entry with `claude mcp remove atlasent` and add it again.

## Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global). A local-mode file you can copy as-is, no account needed: [`examples/cursor_mcp.json`](./examples/cursor_mcp.json).

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": {
        "ATLASENT_MODE": "remote",
        "ATLASENT_API_KEY": "ask_live_xxxxxxxxxxxxxxxx",
        "ATLASENT_BASE_URL": "https://api.atlasent.io/functions/v1",
        "ATLASENT_MCP_READONLY": "1"
      }
    }
  }
}
```

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`. A local-mode file you can copy as-is, no account needed: [`examples/windsurf_mcp_config.json`](./examples/windsurf_mcp_config.json).

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": {
        "ATLASENT_MODE": "remote",
        "ATLASENT_API_KEY": "ask_live_xxxxxxxxxxxxxxxx",
        "ATLASENT_BASE_URL": "https://api.atlasent.io/functions/v1",
        "ATLASENT_MCP_READONLY": "1"
      }
    }
  }
}
```

## VS Code

Add to `.vscode/mcp.json` in your workspace. VS Code's top-level key is `servers`, not `mcpServers`. A local-mode file you can copy as-is, no account needed: [`examples/vscode_mcp.json`](./examples/vscode_mcp.json).

```json
{
  "servers": {
    "atlasent": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": { "ATLASENT_MODE": "local" }
    }
  }
}
```

For remote mode, replace the `env` block with the one shown in the [Cursor](#cursor) section.

## Other MCP clients

The same server can be configured in any other MCP-compatible host using its normal MCP server configuration mechanism (`command: npx`, `args: ["-y", "@atlasent/mcp-server"]`, and the same `env` block shown above).

This server is also listed on [Glama](https://glama.ai/mcp/servers/Atlasent/atlasent-mcp-server) (built from this repo's [`Dockerfile`](./Dockerfile); listing ownership in [`glama.json`](./glama.json)) and on the [official MCP Registry](https://registry.modelcontextprotocol.io) (`io.github.Atlasent/mcp-server`, manifest at [`server.json`](./server.json)), so a registry-aware host can discover and install it without a hand-written config block. `npm run bundle` builds an MCPB bundle of the same server for hosts that install from one. Where it is and isn't listed: [`docs/DISTRIBUTION.md`](./docs/DISTRIBUTION.md).

## Development

```bash
npm install
npm run typecheck
npm test          # offline: no network, no API key
npm run build
npm run demo
```

`npm test` runs entirely offline. Local-mode tests touch no network, and remote-mode tests mock `fetch`. It includes regression tests proving that the protected deployment demo produces no native result when either the outer agent-tool Permit or the action-specific deployment Permit fails Verification.

Prefer a ready-made environment? Open the repo in a [dev container](./.devcontainer/devcontainer.json) (VS Code, or GitHub Codespaces), and it installs and builds on create.

## Community

- **Questions and ideas:** [GitHub Discussions](https://github.com/Atlasent/atlasent-mcp-server/discussions)
- **Bugs and small features:** [open an issue](https://github.com/Atlasent/atlasent-mcp-server/issues/new/choose)
- **Bigger changes** (new tools, wire-shape or fail-closed behavior): start with an [RFC issue](https://github.com/Atlasent/atlasent-mcp-server/issues/new?template=rfc.md)
- **Want to contribute?** Read [CONTRIBUTING.md](./CONTRIBUTING.md) and look for [`good first issue`](https://github.com/Atlasent/atlasent-mcp-server/labels/good%20first%20issue)
- **Security reports:** email security@atlasent.io. See [SECURITY.md](./SECURITY.md). Please don't open a public issue.

Everyone taking part is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

Do not place API keys, signing material, customer secrets, or production credentials in source control. Limit authorization context to facts required by the selected policy and bindings.

Security-sensitive integrations must place the actual side effect **after** the required Authorization and Verification checks in control flow. Logging a Decision and then executing anyway is not enforcement.

## Related public components

- [`atlasent-sdk`](https://github.com/Atlasent/atlasent-sdk) — language SDKs
- [`atlasent-action`](https://github.com/Atlasent/atlasent-action) — GitHub Actions integration
- [`atlasent-verify`](https://github.com/Atlasent/atlasent-verify) — offline evidence verifier
- [`atlasent-keys`](https://github.com/Atlasent/atlasent-keys) — public verification material

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).
