# Design: an organization-wide denial budget for agents

Status: **PROPOSED** (2026-10-18). Not built. Item 4 of #274 asks for this design before any implementation. Five decisions at the end are the founder's.

## The problem

An agent refused by AtlaSent can try the same effect by another route: a different tool, a different destination, a different credential. Each attempt is a new request, and each one is denied on its own merits. But nothing stops the agent from making the next attempt, and the next.

`@atlasent/mcp-gate` 0.1.x has a local `denialBudget` (#277). It stops one gate session after N blocked calls. It does not see:

- a second gate, or a restarted one;
- a different MCP host, SDK or adapter calling the runtime directly;
- calls the cloud authorizer denied through another integration of the same agent.

Only the runtime sees every evaluation for an agent, so only the runtime can count them honestly.

## What already exists, and is reused unchanged

| Piece | Where | What it does |
|---|---|---|
| Key-bound agent | `api_keys.agent_identity_id`, `execution_evaluations.key_agent_identity_id` (CROSS-056) | Every evaluation from an agent-bound key carries the agent, taken from the key, never from the request body |
| Circuit trip | `agent_circuit_trips`, `v1-agent-circuit-trips` (CROSS-064 G3, atlasent-api#3811) | Append-only record. While unreset, `v1-verify-permit` refuses that agent's permits (fail-closed on an unreadable answer) |
| Reset | `agent_circuit_trip_resets` | Only a signed-in owner/admin person, with a reason, append-only. No API key can reset, including the one that tripped it |
| Local stop | `CircuitBreaker` (`src/governedAction.ts`), mcp-gate `denialBudget` | Stops one process; unchanged |

The design adds **one trip condition and one counter**. It adds no engine, no action taxonomy, and no path that can grant anything.

## Proposal

### 1. The runtime counts; the agent host does not

A denial is counted when the runtime records a `deny` evaluation for a key-bound agent. The counter is written in the same transaction as the evaluation row: a trigger on `execution_evaluations` insert, or one SQL function called by `v1-evaluate` after the audit write. A trigger is preferred, because no code path that writes an evaluation can skip it.

Because the agent comes from the key and the count comes from the runtime's own record, the agent cannot under-report, and two gates cannot each see half.

### 2. What counts

| Outcome | Counts? | Why |
|---|---|---|
| `deny` on a policy decision | Yes | The agent asked for something it may not do |
| `hold` / `escalate` | **No** | Waiting for a person is not misbehaviour (#274: "held work avoids consuming attempts") |
| A later approval or a denied approval | No | That is a person's decision, not an attempt |
| Infrastructure failure (timeout, signer error, malformed request) | **Decision D3** | The agent may not be at fault |
| Verify refused (replay, mismatch, expired) | Decision D3 | Same question |

### 3. What is one bucket (the "alias" question)

The correlation key is **(org, agent identity, scope)**, and it holds no arguments, destinations or credentials. Scope is decision D2:

- **Per agent (proposed default).** Every denial counts, whatever the tool. This is the strictest option and needs no equivalence table, so it cannot be dodged by finding a tool name the table lacks.
- **Per protected effect.** Denials are grouped by the Canon action class (`action_type`) the request named. This is narrower, but an agent that moves to a *different* action class to reach the same effect escapes it. It would need the existing authority-surface equivalence (`_shared/authority-surface-equivalence.ts`), not a new alias list.

### 4. Window and threshold

The budget is a sliding window: **N denials within T minutes**. Proposed default: 5 in 15 minutes (decision D1).

- **Per-org setting.** The setting lives on the org, bounded (N 1–1000, T 1–1440).
- **Who can change it.** Lowering N or raising T only removes authority, so any admin may do it. Raising N or shortening T needs an owner session.
- **Every change is audited.** It is an `org.*` audit event, like `fail_mode`.
- **No budget by default.** An org with no setting gets the default. "No budget" is not a value.

### 5. When the budget runs out

The runtime records an `agent_circuit_trips` row:

- `condition = 'E5'`, a new value meaning denial budget exhausted;
- `target = NULL`, which covers the whole agent;
- evidence carrying the count, the window, the evaluation ids and denial codes counted, and the bundle versions that denied them. It carries no request context.

From then on, two refusals apply:

1. **Verify.** `v1-verify-permit` already refuses the agent's permits while the trip is open. No change is needed there.
2. **Evaluate (proposed).** `v1-evaluate` also denies early, with `AGENT_DENIAL_BUDGET_EXHAUSTED`, so the agent learns why instead of collecting allows it cannot use. The early deny is itself an evaluation, so it must not count again (no feedback loop).

### 6. Reset and override

The existing reset path is reused unchanged: an owner/admin person with a reason. No key can reset, and no MCP tool exposes a reset.

Whether a trip also clears itself when the window passes is decision D4. The proposal is **no**. That is consistent with every other trip, and an agent that tried five ways around a refusal warrants a person looking.

### 7. Policy and version semantics

- **A policy change does not reset the count.** The denials happened under the policy that made them, and the trip evidence names those versions.
- **Raising the threshold does not clear an open trip.** Only a reset does.

### 8. Failure handling

This follows CLAUDE.md rule 2 ("call failed" must never mean "nothing to enforce"):

- **The counter write fails.** The evaluation is still denied, as it already was. The failure is logged and alerted distinctly. It is not treated as "no trip": the next evaluation re-reads the count.
- **The trip lookup fails.** It refuses, as `checkAgentCircuitTrip` already does.
- **Never a grant.** A rate limit can never grant authority. An agent under budget still needs an allow and a verified permit for every action.

### 9. Privacy

The correlation key and the counter hold only ids already stored on the evaluation row: org, agent identity, evaluation id, action type, denial code and time. No arguments, destinations, credentials or response bodies are stored.

### 10. Relation to the local budget

mcp-gate's `denialBudget` stays as an offline, first-line stop with no account, and it needs no runtime. The runtime budget is the one an organization can rely on across gates, sessions and integrations. Neither replaces the other, and neither contains a route outside AtlaSent (#274 item 5).

## Tenancy and unbound keys

- **Per org and per agent identity.** One org's denials never count against another's.
- **A key with no bound agent** (`agent_identity_id IS NULL`) is decision D5. Options:
  - count per key;
  - do not count, and document it;
  - require agent binding for `agent.*` actions, which incident defense already largely does.

## Acceptance (before calling it built)

These are synthetic, against staging, matching the #274 matrix:

1. N denials across N **different** tools for one agent within T trip E5. The next permit verify is refused, and the next evaluate is denied with `AGENT_DENIAL_BUDGET_EXHAUSTED`.
2. The same N denials split across **two gates and two keys** bound to the same agent also trip. The counting is not per-session.
3. N-1 denials followed by a hold, then an approval, then a fresh allow: no trip. Held work does not count.
4. A different agent in the same org, and the same agent id in another org, are unaffected.
5. An API key, including an owner-scoped one, cannot reset. A person can, the reset is recorded, and the next evaluation is evaluated normally.
6. A policy change does not reset the count.
7. Counter-write and lookup failures are injected: the evaluation still denies, the failure is logged distinctly, and no permit verifies on a lookup failure.
8. The evidence row holds no argument or credential text.

Report the results as "resistant to these specific defects", not as coverage.

## Decisions for the founder

| # | Question | Proposed |
|---|---|---|
| D1 | Default threshold | 5 denials in 15 minutes, per org, bounded |
| D2 | Bucket scope | Per agent (all tools), not per action class |
| D3 | Do infrastructure failures and verify refusals count? | No: only policy `deny`; the others are alerted separately |
| D4 | Does a trip clear when the window passes? | No: a person resets it |
| D5 | Keys with no bound agent | Count per key until agent binding is required for `agent.*` |

## Where it would be built

- **atlasent-api**, one migration:
  - the `'E5'` condition;
  - a counter table or a view over `execution_evaluations`;
  - the trigger;
  - the org setting and its audit;
  - a verifier registry entry.
- **atlasent-api** `v1-evaluate`: the early deny.
- **atlasent-console**: show E5 trips beside E2 and E3, plus the org setting.
- **This repo**: surface `AGENT_DENIAL_BUDGET_EXHAUSTED` readably in the gate and the adapters. No new local logic.

No production change follows from this document alone. Each piece ships behind its own PR, staging proof and verifier check.
