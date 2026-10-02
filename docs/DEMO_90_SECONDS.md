# The 90-second demo: hold → approve → execute → recorded effect

Presenter run sheet for `examples/hitl-demo.mjs`. It shows one uninterrupted
sequence (reply playbook §5.2):

> an agent attempts a change → AtlaSent holds it → a person approves → **that exact
> change** is permitted → it executes once → the effect is re-read and recorded

The demo drives the real `atlasent_governed_file_change` tool over stdio, the same
way an MCP host does. On approval the tool waits and claims the permit through the
same path as `atlasent_await_approval`. Every id the demo prints came from the
runtime or from GitHub. Nothing is constructed locally.

**Status, 2026-10-02.** The code, the simulated rehearsal and the read-only
preflight are tested offline. **A live run has not been recorded yet.** Until one
is in `docs/acceptance/`, run it privately once before showing it to anyone. AI
Action Protection is a design partner program. Say that out loud.

## What to say (honesty lines)

- "This is a real AtlaSent runtime and a real GitHub repository. The approval is
  made by a person in the console, now."
- "The agent can't approve its own request. The approval covers this exact change:
  a different change is refused."
- "The effect line is the server re-reading GitHub at the commit and at the branch
  head. That's the adapter's observation; the runtime's evaluation and
  verification records are the authoritative record."
- Never say "GA", "out of the box", or "court-ready". If you rehearse with
  `--simulate`, every line says `[SIMULATED]`. Never present that output as live.

## Prerequisites (one-time setup)

Today the live path runs on **runtime staging** (`lwnqpmnxpeyhpxvastku`). The
pieces it needs were proven there (HITL D2/D3, `docs/HOOK_HITL_APPROVAL.md`).
Production needs founder decisions first; see "Founder actions" below.

### The org

Use one demo org. The staging "HITL D2 acceptance" org already has every item
below. For the Sandbox org, each item must be added first.

| Item | Why the demo needs it | How to check |
|---|---|---|
| A registered agent and an `ask_test_` key **bound to it** | The agent identity is minted from the key. An unbound key can't mint it, and the evaluation is denied | Console: Settings → Connect an AI agent |
| Key scopes `evaluate:write`, `verify:execute`, `approvals:read` | Evaluate (the hold), verify (the boundary), and the status poll + claim | Preflight checks `approvals:read`; the other two show only in a live run |
| An `agent.tool.invoke` class with `requires_human_approval: true` (the HITL variant, `docs/HITL_D5_DECISION_PACKET.md` §2) and an active bundle that allows a well-formed call | Without it the call is **allowed with no person** (Quick Start's starter policy) or **denied** (`policy_bundle_missing`). The demo FAILs at ATTEMPT in both cases. It never skips the hold | Only a live run shows it |
| A trusted issuer row for the agent-key mint (actor root) | `requires_verified_actor`; otherwise `ACTOR_UNVERIFIED` | Only a live run shows it |
| An approver who can sign in to the console | The person who clicks Approve. Approval goes through the org's IdP (D3) | Sign in before the call |

Optional: `agent_circuit:write`, so a circuit trip is recorded in the runtime too.

### The GitHub repository

- A **dedicated demo repository** and an **unprotected branch** (e.g. `demo`).
  Each run adds one new file, `atlasent-demo/payments-feature-flags-<timestamp>.json`.
- A **fine-grained token** limited to that one repository: Contents read and write,
  Metadata read. The preflight warns about a classic `repo` token, because it can
  write every repository you can.

## Environment

```bash
export ATLASENT_API_KEY=ask_test_...          # the agent-bound key
export ATLASENT_BASE_URL=https://lwnqpmnxpeyhpxvastku.supabase.co/functions/v1
export ATLASENT_ENVIRONMENT=staging           # required; never defaulted
export ATLASENT_AI_ACTION_GITHUB_REPO=<owner>/<demo-repo>
export ATLASENT_AI_ACTION_GITHUB_BRANCH=demo
export ATLASENT_AI_ACTION_GITHUB_TOKEN=github_pat_...
# optional
export ATLASENT_AI_ACTION_PATH_PREFIX=        # confine writes to a folder, e.g. config/
export DEMO_APPROVAL_WAIT_SECONDS=600         # how long stage 4 waits for the person
export DEMO_SERVER_LOGS=1                     # show the server's JSON logs on stderr
```

Leave `ATLASENT_AI_ACTION_RUNTIME_EFFECT` unset. With it on, the effect is
decided from GitHub push webhooks, which needs `consequential_operations:write`
and an enrolled GitHub App. The run can then end `effect_pending`.

## Run sheet

**T-10 min: preflight (read-only).**

```bash
npm run build
npm run demo:hitl:preflight
```

It makes three GETs and creates nothing:
- the repository;
- the branch;
- the org's pending approvals (`GET /v1-approvals?status=pending`, so the key is
  accepted and holds `approvals:read`).

It also starts the built server and confirms the tool is registered. Every line is
`PASS`, `WARN`, `FAIL` or `SKIP`, and it exits 1 on any `FAIL`. It always prints
what it **could not** check: agent binding, `evaluate:write`/`verify:execute`,
whether the policy holds, and whether the approver can sign in. `PREFLIGHT OK` is
a setup check, not a demo run. If it reports pending approvals already in the
queue, approve only the id the demo prints.

**T-5 min:** sign in to the console as the approver. Open **Approvals**
(`/approval-queue`) in a second window.

**T-0: run.**

```bash
npm run demo:hitl
```

| Time | Stage | On screen | You say / do |
|---|---|---|---|
| ~0s | header | `AtlaSent: hold -> approve -> execute -> record \| runtime <host> \| env staging \| repo <owner>/<repo>@demo` | "An AI agent wants to turn on instant payouts in a config file." |
| ~2s | 1 ATTEMPT | `STAGE 1 \| ATTEMPT` | "It asks to make the change." |
| ~3s | 2 HOLD | `decision hold`, `approval_request_id <uuid>`, `action_digest <hex>`, `target github:<owner>/<repo>@demo:<path>`, `file unchanged yes`, then `>>> Approve <uuid> in the AtlaSent console (Approvals).` | "AtlaSent held it. Nothing changed: we re-read the file." |
| ~4s | 3 BOUND | `changed content refused before any runtime call`, `approved content_sha256 <hex>`, `file unchanged yes` | "If the agent changes even one byte, the approval doesn't cover it." |
| ~5–60s | 4 APPROVE | `still pending +Ns` every 20s until you act | **Console:** Approvals → the row whose id matches the printed `approval_request_id` → check agent, target (repo/path), environment and preview → **Approve once** → complete the IdP sign-in if asked. Then: "A person approved this exact change." |
| +1–3s | 4 (cont.) | `approved <uuid>`, `permit (sha256 only) <hex>` | "The runtime minted one single-use permit for it." |
| +1s | 5 EXECUTE | `verify outcome …`, `verified_at …`, `commit <sha>`, `commit url https://github.com/...` | "The permit was verified at the boundary, right before the one write." Open the commit URL. |
| +2s | 6 RECORD | `effect (adapter) established: at commit matches, at branch head matches`, `effect (demo re-read) branch head holds exactly the approved bytes`, `audit_id`, `proof ai_action_proof.v1`, `proof_sha256 <hex>` | "The effect was re-read and recorded." |
| end | DONE | `DONE: held -> approved -> exactly that change executed once -> effect recorded.` and `Evidence: hitl-demo-evidence-<ts>.json` | |

Without the approval wait, the stages take about 10 seconds. The 90 seconds is
mostly the approver's click and the talk track.

## When it stops

Each stage that isn't observed prints `FAIL at <stage>: <reason>` and exits 1.
Nothing after that stage is printed. Don't narrate past a FAIL.

| FAIL at | Usual cause | Fix |
|---|---|---|
| `setup` | Tool not registered | The three `ATLASENT_AI_ACTION_GITHUB_*` variables; `npm run build` |
| `attempt` … "ALLOWED this change with no person" | The org's policy allows `agent.tool.invoke` outright (Quick Start's starter policy). **The file was written** | Seed the HITL class. Don't present this run |
| `attempt` … `deny_code=…` | Denied: `policy_bundle_missing`, `ACTOR_UNVERIFIED`, a key not bound to an agent, a missing scope | Fix the org setup in the table above |
| `approve` … "no decision within" | Nobody approved in time | Approve sooner, or raise `DEMO_APPROVAL_WAIT_SECONDS` |
| `approve` … "not approved" | The person denied it, or the approval expired. Nothing was changed | This is a valid outcome. You can show it as the deny path |
| `execute` | Permit not verified, or no receipt (branch protection, token can't write) | Read `verify_error_code`; check the branch and token |
| `record` | The effect wasn't established | Say "written, effect not confirmed", never "verified" |

## After the run

- `hitl-demo-evidence-<ts>.json` is in the working directory. The permit appears in
  it only as a sha256. File it under `docs/acceptance/` for the first live run.
- The demo file stays in the repository. Delete old ones in the demo repo now and
  then.

## Rehearsal without a runtime

```bash
npm run build && npm run demo:hitl -- --simulate
```

This uses an in-memory runtime, repository and approver. Every line starts with
`[SIMULATED]`, and it makes no network call. It's for learning the timing only.

## Founder actions before the first live demo

1. Choose the demo org: the staging HITL acceptance org (ready now), or the Sandbox
   org (needs the HITL `agent.tool.invoke` class, the bundle, the agent, the bound
   key and the actor root).
2. Create the demo repository, the branch and the fine-grained token.
3. Run the preflight, then one private live run. File the evidence under
   `docs/acceptance/`.
4. For production: D6 (the HITL default on prod), the agent-key mint on runtime
   prod, and `v1-authority-approvals` deployed to console prod are all open
   decisions. Until they're made, demo on staging and say so.
