# AI Action Protection: the MCP execution adapter

Status: reference implementation, 2026-09-30. Product contract:
atlasent-docs `architecture/ai-action-protection/AI_ACTION_PROTECTION.md`.
Decision: atlasent-docs `architecture/adr/CROSS-064` (PROPOSED).

**Not generally production-ready.** This is the design-partner reference. It
is not a production claim until the acceptance criteria (DP-1 to DP-12 in the
product contract) have been demonstrated on production.

## What this server is in AI Action Protection

MCP is an **execution adapter**. It is the place where an agent's request
becomes a real change, so it is where the permit is verified and the effect is
observed. It is **not** where authority comes from.

| Guidance (never enforcement) | Enforcement |
|---|---|
| Tool names, descriptions, annotations (`destructiveHint`, ...) | The runtime's `agent.tool.invoke` decision for this org |
| `serverInstructions()` telling the agent to evaluate first | A permit bound to agent, target, environment and the action digest |
| The agent choosing to call `atlasent_evaluate` | `v1-verify-permit` at this boundary, immediately before the write |
| Installing this server, or the reference tool appearing in `tools/list` | Org policy + approvals; installing authorizes nothing |

A prompt can persuade an agent. It cannot produce a permit.

## `atlasent_governed_file_change`

The reference tool. An agent changes one file in one GitHub repository. It is
registered only when an operator sets all of:

```
ATLASENT_AI_ACTION_GITHUB_REPO=owner/repo        # the one repo it may change
ATLASENT_AI_ACTION_GITHUB_BRANCH=<branch>        # never defaulted
ATLASENT_AI_ACTION_GITHUB_TOKEN=<token>          # never read from GITHUB_TOKEN
ATLASENT_AI_ACTION_PATH_PREFIX=config/           # optional confinement
ATLASENT_AI_ACTION_BREAKER_FILE=~/.atlasent/breaker.json   # optional: trips survive restarts
ATLASENT_AI_ACTION_STOP_FILE=/etc/atlasent/STOP  # optional: operator stop
```

Flow (`src/aiActionTools.ts` → `src/governedAction.ts` → `src/githubFileAdapter.ts`):

1. It reads the file's current blob. The action is
   `{tool: github.contents.put, target: github:owner/repo@branch:path, arguments: {base_state, content_sha256, message, ...}}`.
   Its digest is `sha256(JCS(action))`.
2. `engine.authorize` sends `agent.tool.invoke`. The agent identity is minted
   from the agent-bound key. The digest is placed in `context.action_digest`,
   which the runtime seals. The runtime evaluates the org's policy.
3. The runtime returns `allow`, `deny` or `hold`. On a hold, the tool returns
   `approval_request_id` and changes nothing. After a person approves in
   AtlaSent, the agent calls the tool again with the **same** change and the
   id. A different change is refused and the approval is not spent.
4. At the boundary, in this order:
   - circuit breaker;
   - content bytes match `content_sha256`;
   - the target is unchanged since authorization;
   - `v1-verify-permit` with a hash **recomputed from the action about to run**.

   It never replays the hash from the decision, so a changed action fails
   `PAYLOAD_MISMATCH` at the runtime.
5. It performs one `PUT`, using GitHub's own optimistic `sha`.
6. Effect: it re-reads the file at the new commit and at the branch head.
   `established` means both are exactly the authorized bytes.
7. It returns `ai_action_proof.v1`: agent, action and digest, decision (and
   approval), permit verification, execution receipt, effect and circuit
   state, plus `proof_sha256` over the record. The runtime's own evaluation and
   `verification_events` rows are the authoritative record. This is the
   adapter's view of them.

Local mode never changes a real system (`RUNTIME_REQUIRED`).

## Runtime-established effect (CROSS-064 G4, opt-in)

By default the adapter decides whether the write took effect by re-reading
GitHub itself. That is the adapter's own observation. With
`ATLASENT_AI_ACTION_RUNTIME_EFFECT=true` the runtime decides instead, from
GitHub's signed push webhooks:

1. The action names its exact effect, `expected_effect`
   (`github_contents_write.v1`: repository, branch, path, the blob it replaces
   and the blob it writes). It is part of the action digest and of the
   evaluated, sealed context.
2. At the boundary the permit is consumed by
   `/v1-consequential-operations/consume-and-admit`, which also opens a
   consequential operation for the action.
3. After the write, the server calls `/establish-effect` and waits briefly for
   the push event to arrive. The outcome depends on the runtime's verdict:
   - `established`: the outcome is `executed`.
   - `superseded` (a later change to the same file landed first) or
     `mismatch`: the outcome is `effect_not_established`, the circuit trips
     (E3), and a new authorization is needed.
   - No verdict yet: the outcome is `effect_pending`. The effect is **not
     established**, even if the adapter's own read matched. The operation
     stays open for a later establishment.

Requirements:
- The key must hold `consequential_operations:write` (Tier 2) as well as
  `verify:execute`.
- The repository must be enrolled with the org's GitHub App, so its push
  webhooks reach the runtime.

The server refuses to start the tool if the flag is on but it cannot call the
runtime. The runtime-side enforcement flag
(`ATLASENT_ENFORCE_EFFECT_ESTABLISHMENT`) is separate and stays off until
staging proves the path.

## Circuit breaker (execution-boundary half)

`CircuitBreaker` in `src/governedAction.ts`. It can only stop an action. It
never authorizes one, never overrides a runtime refusal, and is not a policy
engine.

| Condition | Where | Effect |
|---|---|---|
| E1 target changed since authorization | before verify | refused; the permit is not spent |
| E2 execution outcome unknown (error or timeout) | after execute | trips `agent:` and `target:` scopes |
| E3 effect not established | after the effect read | trips |
| E4 operator stop (`ATLASENT_AI_ACTION_STOP_FILE`, `ATLASENT_CIRCUIT_BREAKER_STOP=1`) | before verify | refused |

A trip is sticky, persists across restarts when a state file is set, and is
reset only by a named person through `CircuitBreaker.reset(scope, by)`. No MCP
tool can reset it: an agent must not be able to clear its own stop. The
runtime half (B1 to B8: an agent no longer active, bindings, provenance,
approvals, expiry, replay, runtime unavailable) is enforced by the runtime and
is listed in the product contract.

### Runtime record of a trip (CROSS-064 G3)

When E2 or E3 trips, the adapter also reports it to `POST /v1-agent-circuit-trips`
(`engine.recordCircuitTrip`). The runtime records it for the calling key's own
bound agent, never an agent named in the request. While that trip is unreset,
`v1-verify-permit` refuses the agent's permits, so every other adapter instance
stops too, and the console can show it. Only a person in an owner or admin
session can reset it; no API key can, including the one that recorded it.

- The agent-bound key needs the `agent_circuit:write` scope. Without it, or on
  a runtime without the endpoint, the proof's `circuit.runtime_record` says
  `recorded: false` with the reason. The local trip still stops this adapter.
- The runtime trip covers the whole agent; the target is kept as evidence.
- This needs atlasent-api migration `20261360000000` and function
  `v1-agent-circuit-trips` on the runtime you target.

## Proof it works

- Offline: `src/governedAction.test.ts`. It runs the real tool and the real
  engine against an in-memory runtime and an in-memory GitHub. It covers the
  untrusted agent, the hold, a changed action (refused locally and at verify),
  the exact action with its effect, replay (at the approval and at verify),
  local mode, path confinement, B1, E1 to E4, and recording a trip in the
  runtime (a second adapter instance with a clear local breaker is then refused
  at verify). Mutation-checked: removing
  the breaker, the target check, the recomputed hash, or the sealed
  `action_digest` each fails the suite.
- Live: `scripts/acceptance/ai-action-reference/run.mjs`. It runs on runtime
  staging and a real GitHub branch, and needs a person to approve in the
  console. **Not yet run.** The session that built it could not reach the
  staging runtime. Record the result in `docs/acceptance/` when it runs.
