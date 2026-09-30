# Design: the guard waits for a person in the console

> **Status (2026-09-29): not available in the plugin.** The `atlasent-guard` plugin is
> local only from 0.2.5: no key setting, no credential read, nothing sent. A live run
> against the runtime found two runtime blockers: `v1-agent-actor-identity` is
> staging-only, and an active global incident defense denies every `agent.*` action
> that lacks signed upstream source provenance (`ASSERTION_UNVERIFIED`), which this
> design does not produce. The approval never becomes reachable. The npm CLI path
> keeps the code. Offer it in the plugin again only after a live end-to-end run
> through hold, approve, claim and verify.

> **Update (2026-09-29, later).** The trusted sealer now exists in atlasent-api
> (`v1-source-provenance-seal`, staging only; see that repo's
> `docs/runbooks/SOURCE_PROVENANCE_SEALER.md`). The hook calls it before evaluate with
> the exact context and target, forwards the seal unchanged, and verifies the permit
> against the provenance action hash, which it recomputes from the current action. An
> approved claim continues the original request's admission on the runtime side. None
> of this is proven live yet: the status above stands until the D2 staging run passes.

Status: **ACCEPTED** (2026-09-28; decisions below). Slice 1 (the hook) is
implemented in `packages/agent-hooks/connected.mjs`. **It is not usable and not
commercially ready.**

> **Correction (2026-09-29).** An earlier version of this status implied connected
> mode only lacked a staging run. That was wrong. The first staging run showed that
> every `agent.tool.invoke` evaluation, on staging and production, is subject to the
> global incident-defense (METR) controls in `atlasent-api` migration
> `20261264000000`, which require a trusted `source_provenance.v1` envelope at
> `correlated` assurance or better, plus a stable `request_id`. AtlaSent had no
> component that mints that envelope, so connected mode could never reach a hold. The
> controls stay exactly as they are; the fix is a trusted server-side sealer
> (atlasent-api), which the hook will call before evaluating. Connected mode is
> commercially ready only after the live staging proof below passes, including its
> negative cases.
>
> Staging run so far: the console's connect-an-agent flow issues a correctly bound
> key; the agent identity mints and verifies (`actor_identity.verified: true`) once
> its issuer is trusted; the hook failed closed, with a readable reason, at every
> failure (network policy, untrusted issuer, wrong key, missing provenance).

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

> Held for approval (`apr_…`). A person has been asked in AtlaSent. Do not
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
> connect AtlaSent: `atlasent-hooks connect`.

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

All five were decided by the founder on 2026-09-28.

**Principle 1, clarified.** AtlaSent governs authority. The hook does not
hard-code "a human must always approve"; the governing policy decides what
authority is enough for a given `agent.tool.invoke`. The **default policy
seeded for new connected accounts** requires a human approval for unattended
guarded actions. An organization can adopt a different policy only through the
governed policy-change path. The hook never silently turns "unattended" into
autonomous authority.

1. **Both.** Re-running exactly the same action is the universal fallback. When
   `atlasent_await_approval` is available, the agent is told to use it to wait
   efficiently. The wait tool is convenience only; it grants nothing.
2. **`agent.tool.invoke` for the generic first release.** A laptop command is
   not mapped to `production.deploy` just because it deploys. Use
   `production.deploy` only when the caller can truthfully satisfy its Canon
   requirements: actor identity, target, change plan, safeguards and the other
   required bindings.
3. **Redacted preview on by default in connected mode**, with a repo/config
   opt-out that sends only the hash and non-sensitive metadata. Raw secrets are
   never sent, and the binding covers structured tool inputs, not only shell
   strings.
4. **Slack plus the console for V1.** Phone push comes later, and when added it
   must go through the same runtime authority path, not a separate approval
   mechanism.
5. **Inspect the approval schema first.** Reuse an existing canonical
   denial/reason field only if its semantics, immutability/audit behaviour and
   API exposure are right. Otherwise add one bounded, additive field to the
   canonical approval record. Do not overload an unrelated field and do not
   create a separate notes store. The note is guidance and evidence; it never
   grants authority. (The hook reads the note from the approval record
   defensively and shows it to the agent; slice 2 fixes which field it is.)

### The class configuration (founder decision, 2026-09-28)

Found while verifying the runtime contracts: the Canon-seeded
`agent.tool.invoke` class (`seed_ai_agent_safeguard`, ACT-0029) requires
`identity` and `risk` assertions from a trusted issuer, and `v1-evaluate`
denies `ASSERTION_UNVERIFIED` **before policy runs**. So that class can never
produce a hold for the hook: the hook can mint the agent's verified actor
identity but not a risk assertion.

Decided: the connected default uses an **HITL variant** of `agent.tool.invoke`:

| Flag | Canon (ACT-0029) | HITL variant |
|---|---|---|
| `requires_verified_actor` | true | **true** (the agent's minted `actor_identity.v1`) |
| `required_assertion_classes` | `identity`, `risk` | **none** |
| `requires_human_approval` | false | **true** |
| `required_context_inputs` | `tool`, `environment` | same |
| `enforcement_mode` / `fail_mode` | enforced / closed | same |

The human approval stands in for the risk assertion on this path. **This is a
declared deviation from the Canon gate flags** (Canon identity is not Canon
conformance, IMPL-029) and must be recorded as such wherever the variant is
seeded. It is provisioned on staging for the proof only; the production default
seed comes back to the founder for explicit approval before any write.

### What the implementation also settled

- **Environment is the user's choice only.** A repository config cannot set
  `connected.environment`, so an agent that can write to the repo cannot route
  its actions to a laxer environment's policy. A repository may turn the
  preview off (stricter), never on.
- **Hook timeout raised to 30 s** in `hooks/hooks.json`, with an internal 25 s
  budget: 15 s for the two calls that run a full evaluation (evaluate and
  claim-permit) and 6 s for every other call. A claim-time reevaluation took
  about 7 s on staging, and a 6 s cap lost a permit the runtime had minted.
  An evaluation call never takes the last 4 s, which are kept for verify, and
  a claim does not start unless the run has time for the mint, the claim and
  the verify. When time is short the hook keeps the approval for the next run
  instead of spending it. The hook must answer before Claude Code gives up on
  it, so it always finishes with a decision rather than being cut off.
- **After a verified permit the hook steps aside** (no explicit allow): Claude
  Code's own permission settings still apply, as for every other allow.
- **The guard asks before the agent edits** `~/.atlasent/credentials.json` or
  `pending.json`. A tampered pending pointer can at worst consume another
  approval's permit, which then fails `PAYLOAD_MISMATCH`; it cannot allow.

## Delivery plan: stages, deliverables, exit criteria

Founder decision sequence (2026-09-28). Each stage starts only when the
previous one has met its exit criteria. Approving one stage does not approve
the next. D6–D8 are not approved. Production Change and customer acceptance
work takes priority over this plan wherever the two conflict.

**Stop conditions (binding).** Stop and return to the founder if a stage would
need any of the following:
- a breaking `/v1` or permit/canonical-form change;
- weaker fail-closed behaviour, or weaker `production.deploy` requirements;
- trusting a client-supplied actor, environment or target without verifying it;
- a redacted preview used as the binding;
- a second approval plane, standing grants, or a wait tool that grants anything;
- a new production secret, a broader credential scope, or a production DB or
  policy write;
- approval APIs that cannot enforce the binding;
- a security defect.

| Stage | Status | Concrete deliverable | Exit criteria (all must hold) |
|---|---|---|---|
| **D1** Hook, connected mode | **Source-complete** (`cc308c6`). The runtime blockers A1, A3 and A4 below are fixed and merged | `packages/agent-hooks/connected.mjs` + `redact.mjs` + `jcs.mjs`, `atlasent-hooks connect`, 52 tests | ✅ 52/52 hook tests pass, mutation-checked. ✅ Every error, timeout or malformed answer denies, and the no-key path is byte-identical. ✅ Wire bodies are asserted: all 3 target placements plus a top-level digest at evaluate, and target, digest, environment and agent at verify. ⛔ The runtime has to carry the digest through the approval (A1 below). Until it does, D1 cannot reach "allow once" against a real runtime. |
| **D2** Staging acceptance | **Passed on staging (2026-09-30).** All 12 claims in [`docs/acceptance/HITL_HOOK_STAGING_2026-09-29.md`](acceptance/HITL_HOOK_STAGING_2026-09-29.md) pass; replay in `scripts/acceptance/d2-hitl-staging/`. Needed IMPL-026B on for staging only (founder, 2026-09-29) and fixes atlasent-api#3790 (merged) and #3802 (open, replay path) | One recorded acceptance run on staging runtime `lwnqpmnxpeyhpxvastku`: `docs/acceptance/HITL_HOOK_STAGING_<date>.md` plus a script that replays it | Using a real connected staging identity: (a) an unattended guarded action returns HOLD, a legitimate console approval follows, the permit is bound to the exact action, and exactly one verified execution happens. (b) A changed action cannot reuse the permit: changed command, MCP argument and Write content each get a new approval. (c) Every negative case in the founder list is observed live: wrong agent, target or environment; insufficient approval; expired approval or permit; consumed permit; replay; a different session or key claiming; malformed or timed-out runtime; redaction failure; mismatched hash. Each one denies. (d) The record lists the decision id, approval id, evaluation → re-evaluation → permit lineage, actor, target, environment, action hash and verify/consume evidence, and **no secrets**. (e) The approval satisfied the class's human-approval gate at claim time. |
| **D3** Console `/approval-queue` panel | **Merged (2026-09-30); one exit criterion still open** (the console-side staging run). [Atlasent/atlasent-console#2603](https://github.com/Atlasent/atlasent-console/pull/2603). One deviation from the exit criteria: the buttons do not call `v1-approvals` resolve directly. They start the approval identity broker from the signed-in session, and the broker calls the same resolve through the existing console bridge, adding the IdP resolver assertion and a signed `approval_artifact.v1`. The runtime needs both for this verified-actor class, and the queue alone cannot produce them. There is still no console-side decision state. Correction: a console staging project does exist (`atlasent-console-staging-v2`, `pvmnefndvqsjoydxhqhg`); the PR description said otherwise. Status of the two open items: (1) the console-side round trip (queue → IdP sign-in → resolve → the agent claims) has not been run end to end on console staging-v2, and the deny note reaching the agent has been shown only through the runtime in D2; (2) ~~the broker-path deviation needs founder acceptance~~ **accepted by the founder, 2026-09-30**: the buttons start the approval identity broker, which resolves through the same `v1-approvals` endpoint with the IdP resolver assertion and signed approval artifact | `atlasent-console` request-type panel for `agent.tool.invoke` holds. It shows the agent, represented org, rule/action, redacted preview, repo/target, environment, hold reason and authority required, with **Approve once** and **Deny with note** | Both buttons call `v1-approvals` resolve and nothing else: no console-side decision state (runtime-authority guard green). The deny note reaches the agent on its next retry, shown end to end on staging. The note field has been decided (A2 below). Orphan-component, permission-gating and lint-baseline guards are green. |
| **D4** Slack notification | **Passed on staging (2026-09-30), out of sequence:** D3 had not met its exit criteria when D4 ran, so this does not open D5. [Atlasent/atlasent-api#3807](https://github.com/Atlasent/atlasent-api/pull/3807) (merged). The escalate path, which an `agent.tool.invoke` hold takes, now stores the redacted `approval_subject` and sends the org channel the target, why, redacted preview and a link to the console approval queue; the hold path gains the preview. Every caller-influenced field is defanged (no bare URL, `www.` host or `[label](url)` can become a link), Slack blocks are `verbatim`, and the preview sits in a code span. The message has no buttons or actions, so it cannot approve anything; tests assert this for Slack and Teams. Live: staging runtime read the channel row from console staging-v2 (200, console prod untouched) for approval `d300143b…` at 03:25Z, and one message arrived in the test Slack channel (confirmed by the founder). The webhook URL lives only in console staging's `org_notification_channels`. Open: approval email found no recipients (`no_recipients_resolvable`) because the test org has no `email_addresses`; outside D4 | A new eligible hold notifies the org's Slack, deep-linked to the D3 approval. The existing `notifyOrgChatChannels` hold path is extended only if it lacks what the approver needs | On staging, a hold posts one message with the approval link and the redacted preview, and no secrets. A Slack message cannot approve anything: if interactive, it calls the same `v1-approvals` resolve with the same authority checks, proven by a test where a Slack user without authority is refused. |
| **D5** Default policy, prepared | Blocked until D3 meets its exit criteria (D4 passed out of sequence) | Exact proposed `agent.tool.invoke` HITL-variant class + bundle for new connected accounts. It covers the actions and contexts affected, the human-approval requirement, self-approval posture, individual vs team, independent approval, and rollback | Seeded on **staging only**. A staging run shows that unattended guarded actions HOLD and need a human, and that the rollback works. The deviation from the Canon gate flags (IMPL-029) is recorded. A decision packet goes to the founder. **Stop.** |
| D6 Production seed | **Not approved** | — | Explicit founder approval of the D5 packet. |
| D7 Mobile push | Deferred | — | Must use the same runtime approval path. |
| D8 Standing/time-bounded grants | Deferred | — | Needs its own authority design. |

**First concrete deliverable:** the D2 staging acceptance record. It is the one
artifact that proves the whole claim ("an unattended action waits for a person
and runs once, exactly as approved"), and every later stage builds on it.

### A1 — Runtime blocker found in D1 contract re-verification (stop condition 14)

Re-reading `atlasent-api` before D2 showed that **an approval dropped the
exact-action binding**. Three facts combine:
- The hold's `approval_requests` row stored no digest.
- `_shared/approval_reevaluation.ts` rebuilt the evaluate request without the
  top-level `execution_payload_hash`.
- `execution_evaluations.execution_hash_expected` is persisted only when a
  permit is issued, and a hold issues none.

As a result, the permit a person approved was bound to the re-evaluation's own
request hash, not to the action. When the hook verifies that exact action, the
answer is `PAYLOAD_MISMATCH` every time. This fails closed, so nothing
unauthorized can run. But "allow once" is unreachable, and the approval API was
not enforcing the binding the design relies on.

Proposed fix (atlasent-api branch `claude/serene-archimedes-0vhdev`, not merged,
not deployed). It is additive, needs no migration, and leaves `/v1` and the
permit format unchanged:
1. `v1-evaluate` writes the accepted caller digest (ordinary-action branch only)
   and the target onto the hold/escalate `approval_requests` row, using the
   existing `execution_payload_hash`/`target_id` columns (`20261229000001`).
   It does not set `execution_binding_version`.
2. `buildApprovalReevaluationPlan` re-presents the digest at the top level.
   A malformed recorded digest fails closed.
3. Both the resolve-time and claim-time call sites pass it through. Mandatory
   change-control types are excluded, because their binding is re-derived from
   the recorded `change_plan`. A failed read at claim refuses the claim.

Tests: 4 composed tests (real `handleApprovals` + `handleEvaluate`) and 2
hold-insert tests. Five mutations were tried, one per piece of the fix, and all
five are killed. The v1-evaluate, v1-approvals and reevaluation suites pass
1256/1256.

Behaviour change: for any existing caller that passed a digest and then
claimed through an approval, the claimed permit is now bound to that digest.
Before, it was bound to the server's hash and could never match. This moves
only toward stricter, correct binding.

### Status of A1 (2026-09-29)

**Merged** as atlasent-api#3780 with founder approval, and deployed to staging.

### A3 — `requires_human_approval` hard-denied instead of queueing (fixed)

For every class outside the lifecycle-escalate allowlist, a missing human
approval denied with `INSUFFICIENT_APPROVALS` and created **no**
`approval_requests` row. Nothing reached the approver. A rule-based `hold` was
no substitute, because re-evaluating it after approval yields `hold` again.

Founder decision (2026-09-29): add `agent.tool.invoke` to the allowlist with
`independentApprovalRequired: false`, so the owner may approve their own
agent's action; teams use `requires_independent_approval`. It is recorded as a
declared Canon deviation (ACT-0029 is `allow`), in
`LIFECYCLE_ESCALATE_CANON_DEVIATIONS`. Canon-conformant orgs are unchanged.
Merged in atlasent-api#3781.

### A4 — an agent's hold lost its approval row (fixed)

`approval_requests.requestor_id` is a UUID column on the clean chain and on
staging. The hold insert wrote `actor_id` (`agent:<uuid>`) there, got 22P02,
and failed silently, so no `approval_request_id` came back. The insert now
retries once with a NULL requester, only on 22P02. Merged in atlasent-api#3781.

### D2 staging state (2026-09-29)

All of this lives on runtime staging `lwnqpmnxpeyhpxvastku`, on one dedicated
acceptance org named "HITL D2 acceptance (staging)". Credentials are held
outside the repository.

- **Approver:** an email-password account with `organization_users` role
  `approver`.
- **Agent:** a registered `agent_identities` row, plus an `ask_test_` key bound
  to it with `evaluate:write`, `verify:execute` and `approvals:read`.
- **Class:** the HITL variant of `agent.tool.invoke` (verified actor, human
  approval, no assertion classes, enforced, fail-closed), with an allow bundle
  on `context.tool` and `context.environment`.
- **Stand-in IdP (founder-approved):** an org-scoped `identity` and `approval`
  issuer, an Ed25519 key held outside the repository, with role `qa_reviewer`.
  In production this is the org's own OIDC IdP, reached through the console's
  `/approve` page.
- **Actor root:** an org-scoped row trusting the staging agent-key mint (kid
  `agent-actor-ed25519-2026-09-28`). The mint was configured on staging, but
  global `ACTOR_TRUSTED_ISSUERS` did not include it; evaluate answered
  `ACTOR_UNVERIFIED`. The row was inserted directly because
  `provision_org_trusted_issuer` was broken on staging at the time (fixed later
  in atlasent-api#3784).
- **Next:** run the hook against staging for the happy path, the changed-action
  case and the negative cases, then write the acceptance record.

### A2 — Deny note field (decision 5, inspected)

`approval_requests.reason` is exposed on `GET /v1/approvals/:id`, and resolve
writes the approver's `body.reason` into it. **It does not fit as-is.** The
escalate path writes the *escalation* reason into the same column at creation,
and resolve then overwrites it, with `null` when no note is given. So the column
means "why this was requested" or "what the approver said" depending on when
you read it, and the request reason is lost in place. That fails the
immutability test.

**Implemented** (founder-approved 2026-09-29, atlasent-api#3781). It is written by an explicit signal, not inferred from `reason`, and it is audited. The original proposal read: one bounded additive column on the canonical record,
`approval_requests.resolution_note text` (≤ 2000 chars, CHECK on length),
written once at resolve by the same UPDATE, never updated after (write-once
trigger), exposed on GET, and included in the `approval.resolved` audit payload.
`reason` keeps its current meaning. The hook already reads `resolution_note`
before `reason`. This needs a runtime migration. A staging apply is inside D3.
A production apply needs its own go-ahead.

