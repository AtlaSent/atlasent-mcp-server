# D2 — HITL hook staging acceptance (2026-09-29/30) — PASSED on staging

Status: **passed on runtime staging.** Every case below ran against the live
staging runtime with the real hook. Production was not touched, and nothing here
is a production claim. IMPL-026B claim-time reevaluation is on for staging only,
by founder decision (2026-09-29, scoped acceptance recorded in atlasent-api's
IMPL-026B ADR).

Replay: [`scripts/acceptance/d2-hitl-staging/`](../../scripts/acceptance/d2-hitl-staging/)
(`run.mjs A|B|C|D|all`). Secrets come from a local file and are never
committed. The trace redacts tokens, signatures and keys to a short sha256.

## Setup

- Runtime **staging** only (`lwnqpmnxpeyhpxvastku`). The driver refuses any
  other base URL.
- Hook: `packages/agent-hooks` with this branch's call-budget fix, driven
  in-process through `decide()` with Claude Code's PreToolUse payload
  (`permission_mode: bypassPermissions`, so the ask is unattended).
  `hooks.json`: `{"connected":{"environment":"staging"}}`.
- Tenant: a synthetic acceptance org on staging, containing:
  - one `agent.tool.invoke` class: `requires_human_approval`,
    `requires_verified_actor`, no independent approval (founder decision:
    self-approval OK);
  - one registered agent with a recorded owner and a bound key
    (`evaluate:write`, `verify:execute`, `approvals:read`);
  - one approver (`org_members.role = approver`);
  - a staging-only test IdP issuer (actor, identity and approval trust roots)
    for `qa_reviewer`.
- Action: `Bash` `git push --force origin d2-acceptance-*` (rule
  `git.force-push`, effect ask).

## Flow proven

1. The agent's unattended ask goes out: identity is minted, source provenance
   is sealed for this exact action, and evaluate returns `escalate` with an
   approval request. The hook denies now, with the approval id.
2. Re-running before a decision returns "still waiting".
3. The approver resolves with a JWT, an IdP-signed `identity_assertion.v1`
   (resolver authority, role `qa_reviewer`), and a signed `approval_artifact.v1`.
   Both are bound to the approval's own snapshot: approval id, tenant, action
   type, target and action hash. The approval goes to `approved_awaiting_claim`.
4. The same exact action re-run claims with the agent's own `actor_identity.v1`.
   The claim-time reevaluation verifies the artifact and returns `allow`, and a
   permit is minted.
5. The hook verifies that permit at its boundary, bound to the sealed action
   hash, target, environment and agent. The result is `allow`, and the permit is
   consumed exactly once.

## Results

| Case | Claim | Result |
|---|---|---|
| A | Unattended ask is held (denied now) with an approval id | PASS |
| A | Re-running before a decision says "still waiting" | PASS |
| A | Approver resolves (JWT + resolver assertion + approval artifact) | PASS |
| A | Same exact action is allowed on a claimed, verified permit | PASS |
| A | Running it again is a new request (single use, no reuse) | PASS |
| B | A changed command is held separately and not allowed by the original's approval | PASS |
| C | Approver denies with a note; `resolution_note` persists | PASS |
| C | Agent is denied with the note verbatim and told not to retry unchanged | PASS |
| D | A second claim of the same approval yields no second permit | PASS |
| D | Permit refused for a different target (`PERMIT_BINDING_MISMATCH`) | PASS |
| D | Permit refused for a different payload hash (`PAYLOAD_MISMATCH`) | PASS |
| D | Permit verifies once; a replay gets `PERMIT_ALREADY_USED` | PASS |

Every failure seen on the way was fail-closed: nothing executed without a
verified permit.

## Defects found and fixed during the run

| # | Defect | Fix |
|---|---|---|
| 1 | The idempotent replay of a held evaluate lost `approval_request_id`, orphaning a real approval after a client timeout. It also replayed an envelope-promoted hold as `allow`, and raced the approval insert | atlasent-api#3790 (merged, deployed to staging) |
| 2 | The idempotent replay omitted admitted `source_provenance`, so a retrying hook bound verify to the digest instead of the sealed hash (fails closed) | atlasent-api#3802 (open) |
| 3 | The hook's 6 s per-call cap aborted a ~7 s claim-time reevaluation after the permit was minted, burning the approval | This PR: evaluate and claim-permit get 15 s, overall budget 25 s |
| 4 | Verified-actor classes can't mint at resolve time (`ACTOR_UNVERIFIED`) | IMPL-026B claim-time reevaluation, accepted for staging only (founder, 2026-09-29) and set by a declared `deploy-staging.yml` step |
| 5 | Fixture: the agent had no recorded owner, so the sealer refused (`agent_owner_required`, correct) | Owner recorded on the staging fixture |
| 6 | Staging function deploy exited non-zero on a Supabase CLI telemetry timeout after upload, then rolled back | No code change; a later deploy succeeded |

## Observed, not defects

- **Behavioural risk envelope escalated a claim** (`RISK_ENVELOPE_ESCALATE`)
  during a burst of back-to-back acceptance runs. The runtime refused the claim
  and minted nothing. Re-run after the burst, it passed. This is the runtime
  working as designed.
- Several staging approvals from debugging runs are left pending, or approved
  but unclaimable. They expire on their own and grant nothing.

## Not claimed

- **Production.** IMPL-026B stays PROPOSED for production; runbook step 9 needs
  its own founder decision. D6 (production default policy) is not approved.
- **The plugin install.** It stays local only. Connected mode is the unpublished
  npm CLI path.
- Items 2 and 3 above are verified in unit tests and on staging with the hook
  fix. Item 2's runtime fix is not yet merged or deployed. This run passed
  without needing a replay, so it does not exercise that path live.
