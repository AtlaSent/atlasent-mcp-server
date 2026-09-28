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
2. **One approval, one command.** A permit is single-use and bound to the
   SHA-256 of the full command text. If the agent changes the command, it gets
   a new request and not the old permit.
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
                               │             execution_payload_hash = sha256(command))
                               ▼
                           decision = hold ──▶ approval_request (runtime)
                               │                       │
   deny + "waiting for        ◀┘                       ▼
   approval <id>, re-run                     Console /approval-queue
   the same command after"                   + Slack/phone notification
                                                       │
                                        person: Approve once │ Deny with note
                                                       ▼
Claude Code re-runs the SAME command ─▶ guard finds pending <id> for this hash
                               │  GET status ─▶ approved
                               │  POST /v1/approvals/<id>/claim-permit
                               │  POST /v1-verify-permit (presents payload hash)
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
keyed by command hash. When the same command is run again, the hook makes one
fast status check. Nothing is cached as "approved". The runtime's permit is
the only proof.

Open question: should the hook also offer a small MCP tool
(`atlasent_await_approval` already exists in this repo), so the agent can
wait in one call instead of retrying? That's better for agents but adds
setup. The retry path works without it.

## What goes to the runtime

`POST /v1-evaluate`, `action_type: "agent.tool.invoke"`:

| Field | Value |
|---|---|
| `execution_payload_hash` (top level, bare 64-hex) | `sha256(full command text)`, per the AC-5 rules in `CLAUDE.md` |
| `context.tool` | `Bash`, `mcp__…`, etc. |
| `context.rule` | the guard rule id, e.g. `deploy.release` |
| `context.command_preview` | the command with secrets redacted, max 2 KB |
| `context.repo` | git remote URL if there is one; otherwise a hash of the cwd |
| `context.session_mode` | `unattended` |
| `resource_id` / `context.target_id` | the rule id plus repo (see "Target binding" in `CLAUDE.md`) |

**Founder decision:** the redacted preview is allowed by default in connected mode, with a per-repo/configuration opt-out that sends only the bound hash and non-sensitive metadata. Raw command text is never sent.

**Redaction happens before sending and is tested:** bearer tokens, `ask_*`,
`sk-*`, AWS keys, `PGPASSWORD=`, URL userinfo, and `--password`/`-p` values.
If redaction fails, the hook denies and sends nothing. The local audit log
keeps storing only the hash.

Open question: `agent.tool.invoke` is the right general class. Should
`deploy.release` instead map to `production.deploy`? That type is a mandatory
change-control type and needs a `change_plan` plus a verified actor, which a
laptop command usually can't supply. The first version uses
`agent.tool.invoke` for every rule.

## What the person can do in the console

The console already has the queue: `/approval-queue` (`ApprovalQueueV2Page`)
reads `approval_requests` from `v1-approvals`, the system of record. The first
version adds nothing to authorization. It adds **display** for this request
type:

- **What:** the rule, the redacted command, the tool, the repo, and the agent
  session.
- **Why it's held:** "Unattended agent run; guard rule `deploy.release`".
- **Actions:**
  - **Approve once** — mints a single-use permit bound to this command's hash.
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
sign-up (`utm_source=agent-hooks`) and saves a key restricted to
`evaluate:write` + `verify:execute` in `~/.atlasent/credentials` (`0600`).

## Tests the change must ship with

- A network error, timeout, 5xx, malformed body or unknown decision leads to
  deny, and nothing is written to `pending.json`.
- A changed command after approval gets a new request, and the old permit is
  not used.
- A second run of the same command after one successful allow is denied
  (single use).
- A redaction fixture for each secret shape, plus "redaction throws" leading
  to deny with nothing sent.
- With no key configured, the output is byte-identical to today (regression
  pin).
- The deny-with-note text reaches the agent.
- With the key missing, the nudge appears once per session and never in
  attended mode.

## Open decisions (founder)

1. The retry path only, or also recommend the MCP wait tool?
2. `agent.tool.invoke` for every rule in the first version (recommended), or
   map deploys to `production.deploy`?
3. ~~Is sending a redacted command preview acceptable for the free/individual
   tier, or should it be opt-in per repo?~~ **Decided 2026-09-28:** on by
   default in connected mode, with a per-repo opt-out (see "What goes to the
   runtime").
4. Is Slack the only notification channel in the first version, or is phone
   push needed before launch?
5. Where does the "Deny with a note" text live on the approval record: an
   existing field, or an additive column in `atlasent-api`?

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
