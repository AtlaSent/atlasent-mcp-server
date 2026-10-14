# Hosted API binding and identity: history (payload, target, claim, change plan, provenance, verify)

> Moved verbatim from `CLAUDE.md` on 2026-10-14 (no relative links needed rebasing; paths in code spans are repo-root-relative, as they were in `CLAUDE.md`). Historical record: dated narrative, superseded text included. `CLAUDE.md` states the current truth; where they differ, `CLAUDE.md` wins.

## API contracts subsections (originally in CLAUDE.md's "API contracts" section)

### Execution payload binding (AC-5) — presenting at verify is not enough

`PAYLOAD_MISMATCH` fires only when the permit was BOUND to a digest at evaluate.
Two properties are load-bearing, and getting either wrong disables the check
silently, with no error anywhere:

1. **Bare 64-char hex — no `sha256:` prefix.** `v1-evaluate` binds
   `execution_hash_expected` only when the value matches `/^[0-9a-f]{64}$/i`
   (case-insensitive, normalized to lowercase before binding). A non-matching
   value is **dropped, not rejected** on the ordinary-action path; the four
   mandatory-change-control action types and any class declaring
   `material_execution_fields` deny it outright instead.
2. **Top level of the evaluate body as `execution_payload_hash`, never inside
   `context`.** The handler destructures it from `body`, alongside `context`.

**Corrected 2026-09-13, same day, by a Copilot review on atlasent-api#3355 —
an earlier version of this section said the permit mints UNBOUND, leaving
`PAYLOAD_MISMATCH` structurally unreachable so "the altered call executes."
That was wrong, in the direction that overstates the risk.** `v1-evaluate`
persists its own `proofPayloadHash` (a hash of the whole request body) as
`execution_evaluations.payload_hash`, and `v1-verify-permit` adopts THAT as
`boundPayloadHash` (`handler.ts` ~L1612) whenever the signed token carries no
`execution_hash_expected`. The permit is bound — just to the server's hash
instead of yours. Three outcomes, none of which is the check you think you
enabled:

- **You present your own digest at verify** -> compared against a hash of the
  whole evaluate request body, which it can never equal -> a *deterministic*
  `PAYLOAD_MISMATCH` on every call, altered payload or not. Fail-closed, and
  useless: it cannot distinguish tampering from normal operation.
- **You present nothing, production permit** -> `PAYLOAD_HASH_REQUIRED`.
- **You present nothing, non-production** -> verification passes with no
  payload check at all. This is the genuinely unchecked case.

`payload_hash_supplied_unbound` fires only when nothing is bound, which on the
ordinary path essentially never happens. The real defect is that your digest
never constrains execution — not that a disabled check lets tampering through.
`atlasent-action/src/executionPayloadHash.ts` had already named both halves
("there is no way for the client to detect the failure at evaluate time", and
the resulting "deterministic `PAYLOAD_MISMATCH` on every verify, every time");
the original wording here quoted the first and missed the second.

As of atlasent-api#3355, `v1-evaluate` answers this directly: its response
carries `execution_payload_hash_accepted` whenever a permit was issued and the
request supplied a digest — including one nested under `context`, which is
never a binding but is reported `false` rather than omitted. Check it.

**This was live here until 2026-09-13.** `authorizeRemote` accepted
`ctx.payload_hash` and presented it at verify but never sent
`execution_payload_hash` at evaluate, so every permit it minted was bound to the
server's own request hash rather than to the arguments, and the digest it
presented could never match it. `ActionContext.payload_hash` even
documented "Bind it at evaluate via `execution_payload_hash`" — no code did.
The unit test asserted a placeholder digest (`"sha256:args-A"`) was forwarded
verbatim, and passed green over a value the runtime can never bind.

`normalizePayloadHash` (`src/engine.ts`) is now the single entry point: it
strips a `sha256:` prefix, lowercases, and **throws** on anything that is not a
64-hex digest. Throwing is the fail-closed choice — sending a value the runtime
will quietly discard is strictly worse than refusing at the client boundary.
`atlasent-llm-integrations` carried the mirror-image form of this defect (it
bound at evaluate, in `context`, prefixed) and was fixed the same day.

### Target binding — the same hole, one field over

`target_id` presented at verify does nothing on its own, for exactly the reason
the payload digest did nothing: `v1-verify-permit` compares it against a value
it reads back from the EVALUATE call, and its guard is
present-and-bound-and-differ ("an omitted or unbound target never denies").
With nothing bound at evaluate the comparison is skipped and a permit minted
for target A redeems while presenting target B.

Three consumers read the bound side, so `applyTargetBinding` populates all three
from one value:

| Placement | Read by |
|---|---|
| `resource_id` (TOP-LEVEL) | the permit's `target_id` column |
| `context.target_id` | `firstBindingMismatch`'s expected value |
| `context.target = { id }` | the `permits` insert |

**This was live here until 2026-09-13.** `authorizeRemote` presented `target_id`
at verify and never bound it, and `ActionContext.target_id` documented the
opposite: "Presented at the verify boundary so a permit bound to one target
cannot verify against another." No permit was ever bound to a target.

Two callers were silently unbound as a result, both now fixed:

- **`deploy_service`** never told the runtime WHICH service it was deploying.
  `service_name` reached the logs and the returned result and nothing else, so
  the permit authorized "a production deploy by this actor in this environment"
  and one permit covered a deploy of any service.
- **`agentToolGate`** never bound the tool being invoked. `tool_name` rides in
  context for audit and is NOT one of the runtime's binding fields
  (`target`/`target_id`/`ref`/`workflow_id`/`run_id`/`commit_sha`), so a permit
  minted to invoke one tool verified for any other.

The binding is additive: a caller that supplies no target sends a
byte-identical request to before, pinned by a test.

### Approval claim with the agent's own identity (IMPL-026B, 2026-09-25)

When `atlasent_await_approval` polls a row in `approved_awaiting_claim`, the
permit does not exist yet. The runtime mints it only on a claim that presents
the action actor's `actor_identity.v1`. `awaitApproval` calls
`mintAgentActorIdentity(action_type, environment)`, which POSTs to
`/v1-agent-actor-identity` with the usual headers and a 10 s timeout. The
action type and environment come from the approval row, never from the agent.
The runtime signs `agent:<agent_identity_id>` with role `agent` only for an API
key bound to a registered agent (CROSS-056). The server then claims with
`{ actor_identity }`.

- A failed mint (refusal, 5xx, network, malformed or mismatched assertion)
  means no claim and no permit.
- A 404 from the mint means an older runtime. The server claims with `{}` and
  adds a `notes` entry; the runtime decides.
- A plain `approved` row is claimed with `{}` exactly as before, and no mint
  happens.
- A 409 `claim_in_progress` re-polls, and the next attempt mints a fresh
  identity.

### Change plans, auto Change Brief, plan-mismatch recovery (IMPL-026B decision 5, 2026-09-25)

For the four mandatory-change-control action types, every evaluate path here
(`deploy_service`, `evaluate`, `atlasent_evaluate`; `agentToolGate` evaluates
`agent.tool.invoke` and is unaffected) takes a `change_plan`.
`attachChangeControl` (`src/engine.ts`) creates a brief with
`POST /v1-change-brief` whose `execution_change_plan` is exactly that plan. It
then sends `change_plan` and `change_brief_id` top-level to `/v1-evaluate`, and
remembers the plan per held `approval_request_id` (in process memory, capped
at 256). The claim presents that same plan, so the runtime answers 409
`change_plan_mismatch` only on a real change.

- Brief 404 or 403, or an unknown actor_id, target_id or environment (the
  brief must match the evaluate request on these): no brief, a `notes` entry,
  and the evaluation goes ahead. Any other brief failure throws, so there is
  no evaluation and no permit.
- On a mismatch, `awaitApproval` files at most ONE linked re-request per call:
  the same evaluate body, the presented plan, a new brief, and
  `supersedes_approval_id`. It then waits on the new approval id. A second
  mismatch, a revoked or suspicious approval, `auto_rerequest_on_mismatch:
  false`, or a request this process did not evaluate stops the wait with no
  permit and returns the diff. Absent runtime flags default to true.
- `on_plan_mismatch: "use_approved"` claims again without `change_plan` and
  returns the approved plan, rebuilt from the runtime's diff, as
  `approved_plan`. If the diff cannot be read, nothing is claimed.
- Tests: `src/planMismatch.test.ts`.

### Verified actor identity at EVALUATE for change-controlled actions (2026-09-27)

The runtime's verified-actor gate covers the same four action types at
evaluate, not only at claim (`atlasent-api`
`_shared/actor-identity-gate-scope.ts`, `requiresActorIdentityAtEvaluate`). An
evaluate with a plan and no `actor_identity` is denied `ACTOR_UNVERIFIED` before
any rule runs, so the approval hold never appears. `attachAgentActorIdentity`
(`src/engine.ts`) mints the agent's own assertion through
`/v1-agent-actor-identity` and attaches it to every evaluate path that sends a
`change_plan`: `authorizeRemote`, `evaluateAction` and the linked re-request.
It runs after `attachChangeControl`, so the remembered re-request body never
holds a short-lived assertion. A key that cannot mint gets a note and the
evaluate still goes out. The runtime decides.

`deploy_service` refuses in remote mode, before any call, when `change_plan` is
missing. The reason tells the agent to ask for the revision rather than invent
one. Tests: `src/planMismatch.test.ts`.

### The agent.tool.invoke gate: identity + sealed provenance (CROSS-063, 2026-09-29)

The runtime's `agent.tool.invoke` platform template requires a verified agent
identity (admission floor, atlasent-docs CROSS-063). Separately, the global
incident-defense overlay requires `source_provenance.v1` that the runtime
sealed itself for every `agent.*` action (atlasent-api #3785). In
`authorizeRemote`:

1. `attachAgentActorIdentity` mints for every `agent.*` action, plan or no
   plan. It sends the identity's own `agent:<id>` as `actor_id`, because the
   runtime refuses a different one with 403.
2. `attachSourceProvenance` runs **last** and seals exactly `request_id`,
   `context` and `resource_id` as they will be sent. The sealer accepts only
   a UUID request_id, so the gate uses the attempt's bare UUID. The deploy
   keeps `mcp-<uuid>.action`, and the console pairs the two forms.
3. On an allow with admitted provenance, the permit is bound to the sealed
   `action_hash`. `agentToolGate` presents that hash, plus `bound_actor_id`,
   at verify.

A failed mint or seal adds a note and the evaluate still goes out; the
runtime refuses it. Tests: `src/agentToolGate.test.ts`.

### Verified actor identity at VERIFY (atlasent-api#3915, 2026-10-10)

`v1-verify-permit` requires an `actor_identity.v1` bound to the **permit's**
actor when the action class's server-owned `execution_principal_binding` is
`verified_actor` (`ACTOR_IDENTITY_REQUIRED` / `ACTOR_IDENTITY_INVALID`). In every
other mode a presented identity is ignored. `verifyRemote` therefore calls
`attachVerifyActorIdentity`, which mints a fresh assertion for the same action
types `attachAgentActorIdentity` covers at evaluate (`agent.*` and the four
change-control types) and attaches it. It never reuses the evaluate assertion,
which may have expired. A failed mint (403, an older runtime's 404, a malformed
assertion) leaves the verify unchanged and returns a `notes` entry; the runtime
decides. Tests: `src/verifyActorIdentity.test.ts`.
