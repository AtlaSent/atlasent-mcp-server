# D2 — HITL hook staging acceptance (2026-09-29) — INTERIM, NOT PASSED

Status: **blocked on a founder decision.** Hold and deny work end to end. The
approve-then-execute path cannot mint a permit on staging until IMPL-026B is
accepted and `APPROVAL_CLAIM_TIME_REEVAL` is turned on there. See "Blocker".

## Setup

- Runtime **staging** only (`lwnqpmnxpeyhpxvastku`). Nothing touched production.
- Hook: `packages/agent-hooks` 0.2.6 from `main`, driven in-process through
  `decide()` with Claude Code's PreToolUse payload (`permission_mode:
  bypassPermissions`, so the ask is unattended). `hooks.json`:
  `{"connected":{"environment":"staging"}}`.
- Tenant: a synthetic acceptance org on staging. It holds one
  `agent.tool.invoke` class (`requires_human_approval`, `requires_verified_actor`,
  no independent approval, per the founder decision), one registered agent with a
  bound key (`evaluate:write`, `verify:execute`, `approvals:read`), one approver
  (`org_members.role = approver`), and a staging-only test IdP issuer for
  `qa_reviewer` resolver assertions.
- Action under test: `Bash` `git push --force origin d2-acceptance-*` (rule
  `git.force-push`, effect ask).

## Results

| Case | Claim | Result |
|---|---|---|
| A | Unattended ask is held (denied now) with an approval id | PASS |
| A | Re-running before a decision says "still waiting" | PASS |
| A | Approver resolves with a JWT plus an IdP-signed `identity_assertion.v1` bound to the approval's own snapshot | PASS |
| A | Same exact action is then allowed on a claimed, verified permit | **BLOCKED** (see Blocker) |
| C | Approver denies with a note; `resolution_note` persists | PASS |
| C | Agent is denied with the approver's note verbatim, told not to retry unchanged | PASS |
| B, D | Changed action gets no reuse; token-level negatives (second claim, wrong target, wrong payload hash, replay) | NOT RUN (need a minted permit) |

Every failure along the way was fail-closed: nothing executed without a verified
permit.

## Defects found and their state

1. **Idempotent replay lost the approval id** (atlasent-api#3790, open). The
   first evaluate after a deploy outlived the hook's 6 s call budget. The honest
   retry with the same `request_id` replayed `escalate` without
   `approval_request_id`, so a real pending approval was orphaned and the hook
   (correctly) blocked it as unrecorded. The fix returns the id on a hold or
   escalate replay.
2. **Fixture: agent had no recorded owner.** The sealer refused with
   `agent_owner_required`. That is correct behaviour, and the fixture was fixed
   by recording the acceptance approver as owner.
3. **Deploy flake:** a staging function deploy exited non-zero on a Supabase CLI
   telemetry timeout after a successful upload, then rolled back. A later deploy
   of `main` succeeded. No code change.

## Blocker

This class requires a verified actor. At resolve time only the approver is
present, so the resolve-time reevaluation denies `ACTOR_UNVERIFIED` and no permit
is minted (observed: approval approved, `re_evaluation_decision = deny`, claim
returns `claimed:false`). The designed path is IMPL-026B: resolve moves to
`approved_awaiting_claim`, and the reevaluation runs at claim with the agent's
own `actor_identity.v1`. The hook already sends that at claim. It is behind
`APPROVAL_CLAIM_TIME_REEVAL`, and the ADR (status PROPOSED) says not to turn it
on in any environment until it is ACCEPTED.

Not done, deliberately: turning the flag on, or dropping `requires_verified_actor`
on the class (that would trust a client-supplied actor).

Needed to finish D2: founder acceptance of IMPL-026B (at least for staging), then
`APPROVAL_CLAIM_TIME_REEVAL=true` on runtime staging, then cases A, B and D re-run.
