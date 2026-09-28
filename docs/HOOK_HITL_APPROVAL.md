# Design: the guard waits for a person in the console

Status: **PROPOSED** (2026-09-28). Nothing here is built yet.

## The problem

`atlasent-guard` (`packages/agent-hooks`) asks before destructive or shipping
commands. When Claude Code runs unattended (`bypassPermissions` or `dontAsk`),
nobody can answer, so every "ask" becomes a **deny**. That is correct and must
stay the default. But the person then comes back to a stopped agent, and
nothing they can do from anywhere else will unblock it.

This design lets that person, or whoever holds authority over the action,
**do something about it in the console**. They see the exact command, approve
it once or deny it with a note, and the agent carries on or changes course.
This is the natural upgrade point from the free local guard to a connected
account. The limit is one the user just ran into, and connecting removes it.

## Principles

1. **Fail closed.** A network error, timeout, malformed response, unknown
   decision or missing permit leads to deny, exactly as today. Nothing in this
   design can turn a local deny into an allow unless the runtime has established the approval/authority required by the governing policy.
2. **One approval, one action.** A permit is single-use and bound to the
   SHA-256 of the whole proposed action: the tool name and its complete input
   (see "The exact action being approved"). If the agent changes anything, it
   gets a new request and not the old permit.
3. **Evaluation happens on the runtime, not the laptop.** The hook asks
   `v1-evaluate`. It never decides "approved" from local state.
4. **Opt-in and local by default.** With no key configured, the guard behaves
   exactly as it does today, with no network calls.
5. **The approver sees what they are approving,** with secrets redacted before
   anything leaves the laptop.

## Flow

```
Claude Code ──PreToolUse──▶ guard (hook, 10 s timeout)
                               │  rule = ask, session unattended, key configured
                               ▼
                         POST /v1-evaluate  (agent.tool.invoke,
                               │             execution_payload_hash = sha256(action),
                               │             verified agent actor identity)
                               ▼
                           decision = hold ──▶ approval_request (runtime)
                               │                       │
   deny + "waiting for        ◀┘                       ▼
   approval <id>, re-run                     Console /approval-queue
   the same command after"                   + Slack/phone notification
                                                       │
                                        person: Approve once │ Deny with note
                                                       ▼
Claude Code re-runs the SAME action ─▶ guard finds pending <id> for this hash
                               │  GET status ─▶ approved
                               │  POST /v1/approvals/<id>/claim-permit
                               │  POST /v1-verify-permit (presents payload hash
                               │                          + target_id)
                               ▼
                         verified ─▶ allow, once.
                         denied  ─▶ deny, with the approver's note as the reason
```

### Why "deny, then re-run" rather than holding the hook open

The plugin's hook timeout is 10 seconds (`hooks/hooks.json`), and a human
approval takes minutes. Blocking would fail in every case, and raising the
timeout would freeze the agent's whole turn. Instead, the hook denies straight
away with a reason Claude reads:

> Held for approval (`apr_…`). A person has been asked in Atlasent. Do not
> retry with a different command. Wait, then run exactly the same command
> again.

The pending request is stored in `~/.atlasent/pending.json` (mode `0600`),
keyed by the action hash (defined below). When the same command is run again, the hook makes one
fast status check. Nothing is cached as "approved". The runtime's permit is
the only proof.

Whether to also point agents at the MCP wait tool (`atlasent_await_approval`)
is decision 1 below.

## What goes to the runtime

`POST /v1-evaluate`, `action_type: "agent.tool.invoke"`:

### The exact action being approved

Guarded calls are not all shell commands. MCP tools, `Write` and `Edit` carry
a tool name and structured input. The hook therefore binds the **whole
proposed action**, not a command string:

```
action = canonical_json({ "tool_name": <tool_name>, "tool_input": <tool_input> })
digest = sha256(action)   // bare lowercase hex
```

`canonical_json` is RFC 8785 (JCS): keys sorted at every depth, no
whitespace. `tool_name` and `tool_input` are exactly what Claude Code puts in
the PreToolUse payload. For `Bash` this is `{command, description?, …}`; for
an MCP tool it is the tool's full argument object; for `Write` it includes the
file path and full content. Two actions that differ in any argument get
different digests. The pending store, the retry match and the permit binding
all use this one digest. The preview is derived from the same object.

`POST /v1-evaluate`, `action_type: "agent.tool.invoke"`:

| Field | Value |
|---|---|
| `execution_payload_hash` (top level, bare 64-hex) | `digest` above, per the AC-5 rules in `CLAUDE.md` |
| `actor_identity` (top level) | the agent's verified identity, minted through `/v1-agent-actor-identity` (see below) |
| `context.tool` | `tool_name`, e.g. `Bash` or `mcp__…`. Required input for this class |
| `context.environment` | from connected config (`~/.atlasent/hooks.json` → `connected.environment`, overridable per repo). Required input for this class. If it isn't set, the hook denies locally and sends nothing |
| `context.rule` | the guard rule id, e.g. `deploy.release` |
| `context.action_preview` | `action` with secrets redacted, max 2 KB (omitted under the per-repo opt-out) |
| `context.repo` | git remote URL if there is one; otherwise a hash of the cwd |
| `context.session_mode` | `unattended` |
| `resource_id` (top level) | `target_id` = `<rule id>@<repo>` |
| `context.target_id` | the same `target_id` |
| `context.target` | `{ "id": target_id }` |

All three target placements are required, because each is read by a
different runtime check (see "Target binding" in `CLAUDE.md`). At
`/v1-verify-permit` the hook presents the same `target_id` together with
`payload_hash = digest`. Leaving out either one skips that check.

**Verified actor.** `agent.tool.invoke` has `requires_verified_actor: true`.
A self-declared `actor_id` is not enough, so the hook mints the agent's own
`actor_identity.v1` through `/v1-agent-actor-identity`, as
`mintAgentActorIdentity` in `src/engine.ts` already does. That endpoint signs
only for an API key bound to a registered agent (CROSS-056), so
`atlasent-hooks connect` must register the local agent and issue a key bound
to it. If minting fails, the hook denies and does not evaluate.

**Founder decision:** the redacted preview is allowed by default in connected mode, with a per-repo/configuration opt-out that sends only the bound hash and non-sensitive metadata. Raw command text is never sent.

**Redaction happens before sending and is tested:** bearer tokens, `ask_*`,
`sk-*`, AWS keys, `PGPASSWORD=`, URL userinfo, and `--password`/`-p` values.
If redaction fails, the hook denies and sends nothing. The local audit log
keeps storing only the hash.

Why `agent.tool.invoke` rather than `production.deploy` for deploys (decision
2 below): `production.deploy` is a mandatory change-control type and needs a
`change_plan`, which a laptop command usually can't supply.

## What the person can do in the console

The console already has the queue: `/approval-queue` (`ApprovalQueueV2Page`)
reads `approval_requests` from `v1-approvals`, the system of record. The first
version adds nothing to authorization. It adds **display** for this request
type:

- **What:** the rule, the redacted command, the tool, the repo, and the agent
  session.
- **Why it's held:** "Unattended agent run; guard rule `deploy.release`".
- **Actions:**
  - **Approve once** — mints a single-use permit bound to this action's digest.
  - **Deny with a note** — the note becomes the deny reason the agent reads
    on its next retry (for example, "use `--dry-run` first" or "not on
    Friday"). This is how a person *relieves the problem* without approving
    it: the agent gets a direction, not just a wall.
- **Notification:** a new hold notifies the approver through Slack
  (`v1-slack-approval` exists) and, later, mobile push. Approving from the
  notification is the phone path.

Out of scope for the first version, and governed separately if built:
**"allow this rule in this repo for 1 hour."** That is a policy change, not an
approval, and it has to go through the policy path with its own authority
check. A one-click standing grant from a notification is how permission
fatigue becomes the incident.

## Who may approve

- **Individual account:** the developer may approve their own agent's request
  from the console or phone. Approving from their own laptop is the free "ask".
  Approving from elsewhere is the connected value.
- **Team:** the org can set `requires_independent_approval` on the
  `agent.tool.invoke` class, so the approver must be a different person from
  the developer whose key raised the request. That enforcement already exists
  in `v1-evaluate`. This is the team tier's reason to exist.

## The upgrade moment

When the guard denies because the session is unattended and **no key is
configured**, the deny reason includes one line, once per session:

> To have this wait for approval from your phone instead of stopping,
> connect Atlasent: `atlasent-hooks connect`.

The line never appears in an attended "ask" prompt, and
`ATLASENT_HOOKS_NUDGE=off` turns it off. `atlasent-hooks connect` opens
sign-up (`utm_source=agent-hooks`), registers the local agent, and saves a
key bound to that agent in `~/.atlasent/credentials` (`0600`). The key's scopes
are exactly what the flow uses: `evaluate:write` (the hold),
`approvals:read` (status poll and `claim-permit`; without it every retry
returns 403, as `awaitApproval` in `src/engine.ts` already reports), and
`verify:execute` (the boundary check).

## Tests the change must ship with

- A network error, timeout, 5xx, malformed body or unknown decision leads to
  deny, and nothing is written to `pending.json`.
- A changed action after approval gets a new request, and the old permit is
  not used. This covers a changed `Bash` command, a changed MCP argument, and a
  changed `Write` content with the same path.
- Digest stability: the same `tool_input` with its keys in a different order
  produces the same digest.
- Missing `connected.environment`, or a failed actor-identity mint, leads to a
  local deny with nothing evaluated.
- Evaluate carries all three target placements, and verify presents the same
  `target_id` and `payload_hash`. Assert this on the wire body, not on a
  helper's arguments.
- A second run of the same command after one successful allow is denied
  (single use).
- A redaction fixture for each secret shape, plus "redaction throws" leading
  to deny with nothing sent.
- With no key configured **and the nudge not shown** (`ATLASENT_HOOKS_NUDGE=off`,
  or already shown this session, or an attended session), the output is
  byte-identical to today (regression pin). When the nudge is shown, the
  decision and every field other than the reason text are identical to today,
  and the reason is today's reason plus exactly the nudge line.
- The deny-with-note text reaches the agent.
- With the key missing, the nudge appears once per session and never in
  attended mode.

## Decisions

Decided items are recorded as decided. Open items carry the default this
document is written against, so no slice has to guess. A slice must not start
on an open item's default without the founder confirming it.

1. **Open. Default: the retry path only.** Recommending the MCP wait tool
   (`atlasent_await_approval`) comes later.
2. **Open. Default: `agent.tool.invoke` for every rule.** Mapping deploys to
   `production.deploy` is out of scope for the first version.
3. ~~Is sending a redacted command preview acceptable for the free/individual
   tier, or should it be opt-in per repo?~~ **Decided 2026-09-28:** on by
   default in connected mode, with a per-repo opt-out (see "What goes to the
   runtime").
4. **Open. Default: Slack only in the first version** (as in "What the
   person can do"). Phone push comes later.
5. **Open. No default.** Does the deny note live in an existing field on the
   approval record, or an additive column in `atlasent-api`? Slice 2 is
   blocked on this.

## Slices

1. **Hook, connected mode** (this repo): evaluate, pending store, re-run
   claim/verify, redaction, `connect`, nudge, tests. Needs a staging key and
   an `agent.tool.invoke` bundle that holds for `context.session_mode ==
   "unattended"`.
2. **Console display** (`atlasent-console`): the request-type panel and the
   Deny-with-a-note wiring on `/approval-queue`.
3. **Notification** (`atlasent-api` / console): Slack on a new hold for this
   type.
4. **Policy seed:** an `agent.tool.invoke` template for new accounts that
   holds unattended guard requests. Written live, with explicit go-ahead.
