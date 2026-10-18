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

A denial is counted when the runtime decides `deny` for a bucket. **It is counted first, in its own committed transaction, before the evaluation row is written and before any response.** The policy decision is known in `v1-evaluate` before any database write, so the order is:

1. Decide (allow, deny or hold).
2. If deny: one SQL function takes the bucket lock, appends the denial, writes the E5 trip if the budget is now spent, and **commits**.
3. Write the evaluation and audit rows, then respond.

If step 2 fails, `v1-evaluate` returns an error and no deny is ever shown to the agent uncounted. If step 3 fails after step 2 committed, the denial stays counted. The error falls on the safe side: it can overcount, never undercount. An earlier revision counted in the evaluation's own transaction and needed a separate failure marker; both races Codex found on #278 came from that ordering, and counting first removes them.

**One locked row per bucket, not a count over the log.** A view or a `count(*)` over recent evaluations races: two gates committing the fourth and fifth denial at once each see only their own row, so neither trips. The counter is a `agent_denial_buckets` row per bucket, holding the window's denial times. A deny's counting step (step 2 above) takes that row with `SELECT … FOR UPDATE`, or with an `INSERT … ON CONFLICT DO UPDATE` upsert on first use. It then decides under the lock:
- whether to append the denial;
- whether the budget is now spent;
- whether to write the E5 trip.

An allow reads the trip state under `FOR SHARE` on the same row, in its own transaction, before it issues a permit. A share lock waits for any counting step that holds the row and then sees what it committed. So two concurrent denials of one bucket serialise and the N-th always trips, and an allow queued behind the N-th denial sees the trip and is refused (Codex review on #278).

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

The correlation key is **(org, bucket identity, scope)**, and it holds no arguments, destinations or credentials. The bucket identity is the key-bound agent (`key_agent_identity_id`), or the API key id when the key has no bound agent (D5). It is never a shared null bucket. Scope is decision D2:

- **Per agent (proposed default).** Every denial counts, whatever the tool. This is the strictest option and needs no equivalence table, so it cannot be dodged by finding a tool name the table lacks.
- **Per protected effect.** Denials are grouped by the Canon action class (`action_type`) the request named. This is narrower, but an agent that moves to a *different* action class to reach the same effect escapes it. It would need the existing authority-surface equivalence (`_shared/authority-surface-equivalence.ts`), not a new alias list.

### 4. Window and threshold

The budget is a sliding window: **N denials within T minutes**. Proposed default: 5 in 15 minutes (decision D1).

- **Per-org setting.** The setting lives on the org, bounded (N 1–1000, T 1–1440).
- **Who can change it.** Lowering N or raising T only removes authority, so any admin may do it. Raising N or shortening T needs an owner session.
- **Every change is audited.** It is an `org.*` audit event, like `fail_mode`.
- **On by default.** An org with no setting has the default budget (D1) enabled, so every existing org is covered on the day it ships. There is no setting that turns the budget off.

### 5. When the budget runs out

The runtime records an `agent_circuit_trips` row:

- `condition = 'E5'`, a new value meaning denial budget exhausted;
- `target = NULL`, which covers the whole agent;
- evidence carrying the count, the window, the evaluation ids and denial codes counted, and the bundle versions that denied them. It carries no request context.

From then on, two refusals apply:

1. **Verify.** For a key-bound agent, `v1-verify-permit` already refuses the agent's permits while the trip is open, with no change. For an unbound key counted under D5, it does **not** today: it looks trips up by agent only. Counting unbound keys therefore also requires a key-scoped trip lookup in `v1-verify-permit` (see Tenancy and unbound keys); without it, a tripped unbound key's permits would still verify (Codex review on #278).
2. **Evaluate (proposed).** `v1-evaluate` also denies early, with `AGENT_DENIAL_BUDGET_EXHAUSTED`, so the agent learns why instead of collecting allows it cannot use. The early deny is itself an evaluation, so it must not count again (no feedback loop).

### 6. Reset and override

The existing reset path is reused unchanged: an owner/admin person with a reason. No key can reset, and no MCP tool exposes a reset.

Whether a trip also clears itself when the window passes is decision D4. The proposal is **no**. That is consistent with every other trip, and an agent that tried five ways around a refusal warrants a person looking.

### 7. Policy and version semantics

- **A policy change does not reset the count.** The denials happened under the policy that made them, and the trip evidence names those versions.
- **Raising the threshold does not clear an open trip.** Only a reset does.

### 8. Failure handling

This follows CLAUDE.md rule 2 ("call failed" must never mean "nothing to enforce"):

- **The counting step fails.** No deny is returned: `v1-evaluate` returns an error and issues no permit, and it logs and alerts the failure distinctly from a policy deny. Nothing is lost, because a denial the agent never received was never made. A retry is a fresh evaluation; if it is denied, it is counted, or it fails the same way. No failure marker is needed (Codex review on #278).
- **The allow's trip read fails, or the row is unreadable.** It refuses, and issues no permit. An unreadable bucket is never read as "not tripped".
- **The trip lookup fails.** It refuses, as `checkAgentCircuitTrip` already does.
- **Never a grant.** A rate limit can never grant authority. An agent under budget still needs an allow and a verified permit for every action.

### 9. Privacy

The correlation key and the counter hold only ids already stored on the evaluation row: org, agent identity, evaluation id, action type, denial code and time. No arguments, destinations, credentials or response bodies are stored.

### 10. Relation to the local budget

mcp-gate's `denialBudget` stays as an offline, first-line stop with no account, and it needs no runtime. The runtime budget is the one an organization can rely on across gates, sessions and integrations. Neither replaces the other, and neither contains a route outside AtlaSent (#274 item 5).

## Tenancy and unbound keys

- **Per org and per agent identity.** One org's denials never count against another's.
- **A key with no bound agent** (`agent_identity_id IS NULL`) is decision D5. If it is counted, its bucket is the key id, and its trip is recorded against that key. `agent_circuit_trips.agent_identity_id` is `NOT NULL` today, and `v1-verify-permit` looks trips up by agent. So counting unbound keys also needs a key-scoped trip column and lookup, or the third option below. Options:
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
7. Counting-step and lookup failures are injected: the agent gets an error or a refusal, never a permit; the failure is logged distinctly from a policy deny; and no permit verifies on a lookup failure.
8. The evidence row holds no argument or credential text.
9. Two gates submit the (N-1)-th and N-th denials at the same moment, with N-2 already counted: exactly one E5 trip is recorded. Repeat many times to show it is not timing luck.
10. With the counting step failing (injected), the agent receives an error, not a deny, and no permit; with the allow's trip read failing (injected), an allow-shaped request is refused.
11. If unbound keys are counted (D5): two unbound keys in one org have separate buckets. One key tripping does not stop the other.
12. With N-1 already counted, the N-th denial and an allow-shaped request for one bucket arrive together. E5 is recorded. If the allow read the bucket after the denial committed, evaluate refuses it; if it read first, its permit is refused at `v1-verify-permit` once E5 exists. No run ends with a permit that verifies after the trip. Repeat many times.
13. If unbound keys are counted (D5): after a key trips, a permit issued to that key **before** the trip is refused at `v1-verify-permit`.

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
  - the `agent_denial_buckets` counter table (locked per bucket, section 1; a view or count over `execution_evaluations` races and is not an option);
  - the counting function (one call, its own transaction);
  - the org setting and its audit;
  - a verifier registry entry.
- **atlasent-api** `v1-evaluate`: count first on deny, read the trip under `FOR SHARE` on allow, and the early deny.
- **atlasent-api** `v1-verify-permit`: a key-scoped trip lookup, only if D5 counts unbound keys.
- **atlasent-console**: show E5 trips beside E2 and E3, plus the org setting.
- **This repo**: surface `AGENT_DENIAL_BUDGET_EXHAUSTED` readably in the gate and the adapters. No new local logic.

No production change follows from this document alone. Each piece ships behind its own PR, staging proof and verifier check.
