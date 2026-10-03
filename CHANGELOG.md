# Changelog

All notable changes to `@atlasent/mcp-server` are documented here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is a short, customer-facing summary. [`RELEASE_NOTES.md`](./RELEASE_NOTES.md)
carries the longer per-release detail. For the exact tool set of an installed
version, ask the server with MCP `tools/list`.

Companion packages in this repository (`@atlasent/mcp-gate`, the
`atlasent-guard` Claude Code plugin) are listed at the end.

## [Unreleased]

### Added

- Every call to the AtlaSent runtime now pins the edge-function region with an
  `x-region` header. The hosted runtime defaults to `us-west-1`, the region of
  its database. Supabase otherwise runs the function nearest the caller; on
  staging, with the same request shape, evaluate went from a p50 of 4.70 s to
  1.42 s once pinned. Set `ATLASENT_FUNCTION_REGION` to override the region,
  or to `auto` to turn pinning off. A self-hosted `ATLASENT_BASE_URL` is
  unpinned unless the variable is set. A malformed value makes the call fail
  closed (deny), and no request is sent.
- The `agent.tool.invoke` gate now presents what the runtime requires for an
  agent tool call (ADR CROSS-063):
  - It sends the agent's own verified identity, minted for exactly
    `agent.tool.invoke` in the request's environment.
  - It sends sealed source provenance, sealed for the same `request_id`,
    context and target that are evaluated.
  - It verifies the permit against the sealed action hash and the agent the
    runtime issued it to.

  If either the identity or the seal cannot be obtained, the evaluate still
  goes out and the runtime refuses it. Nothing is allowed locally. This needs
  an agent-bound AtlaSent API key.

- `deploy_service` sends one attempt id as `request_id` on both of its
  evaluations: the bare `<uuid>` for the `agent.tool.invoke` gate and
  `mcp-<uuid>.action` for the `production.deploy` it guards. The runtime stores
  `request_id` on every evaluation row, including early refusals, so the
  AtlaSent console can tie the gate to the deploy and show the agent's deploy
  attempt without picking up its other traffic. A linked re-request after a
  plan change gets a new id under the same attempt, because reusing the held
  request's id would make the runtime replay that hold.

### Fixed

- `atlasent_evaluate_many` and `atlasent_evaluate_stream` now check each item's
  `action` against the runtime's action-type pattern (lowercase dot-notation,
  for example `production.deploy`), the same check `evaluate`,
  `verify_permit` and `atlasent_evaluate` gained in #229. The batch and stream
  endpoints run every item through the single-evaluate handler, which rejects
  anything else. One bad item now fails the whole call before anything is
  sent.

## [2.16.0] - 2026-09-27

### Fixed

- Agents can now reach the approval hold on `production.deploy`,
  `infrastructure.change`, `production.rollback` and
  `secret.configuration.change`. The runtime requires a verified actor identity
  at evaluate for these four types; the server only sent one when claiming an
  approval, so every such request was denied `ACTOR_UNVERIFIED`. It now mints
  the agent's own identity (`/v1-agent-actor-identity`) and attaches it whenever
  a change plan is sent. A key that cannot mint gets a note, and the runtime
  still decides.

### Changed

- In remote mode, `deploy_service` refuses before any call when `change_plan`
  is missing, and tells the agent to ask for the revision rather than invent
  one.

## [2.15.0] - 2026-09-27

### Added

- The server now sends MCP `instructions` at initialize: when to call
  `atlasent_evaluate`, to act only on `allow` after verifying the permit, to wait
  on `hold` rather than retry, and how to move from the local demo to real
  permits (sign-up link and the one env var to set). Hosts that support
  `instructions` put this in the agent's context.

### Changed

- The local demo engine's terminal-allow note now includes the sign-up link and
  names `ATLASENT_API_KEY`. Until now the only sign-up pointer was on stderr,
  which most MCP hosts hide from both the person and the agent.
- The local-mode stderr warning and the `NODE_ENV=production` refusal no longer
  say `ATLASENT_BASE_URL` is required (it is optional since 2.14.0), and the
  warning no longer cites an internal document.
- README "Get an API key" now walks through the console's **Connect an AI
  agent** flow; the registry and Smithery `ATLASENT_API_KEY` descriptions say
  where to get a key.

## [2.14.0] - 2026-09-25

### Added

- `atlasent_await_approval`: waits for a person to approve or reject a held
  action in the AtlaSent console. On approval it claims the single permit
  the runtime issued. That permit must still pass `atlasent_verify_permit`
  before anything runs. A rejected, expired, timed-out, unclaimable or
  refused approval returns no permit. The tool cannot approve anything
  itself. Requires `approvals:read` on the API key.
- Held results now include `approval_request_id`.
- Approvals for actions that require a verified actor are claimed with the
  agent's own actor identity. Identity failures normally stop the claim with
  no permit. For compatibility with a runtime that does not expose the identity
  endpoint (HTTP 404), the server retries with an empty body, records a note,
  and the runtime makes the final decision.
- Mandatory change-control evaluations accept a `change_plan`, record it as a
  Change Brief, and bind it to the approval. If the plan changes before
  claim, the server files at most one linked re-request and returns the diff.
  A second mismatch stops with no permit. Results can carry a `notes` array.
- Every evaluate reports the calling MCP client and session
  (`agent_session`), taken from `ATLASENT_SESSION_ID`, `ATLASENT_RUN_ID`, the
  Streamable HTTP session, or a generated per-process id.

### Changed

- `atlasent_evaluate`'s `actor_id` is optional. With an agent API key, the
  runtime derives the agent and its owner from the key.
- An API key on its own now selects remote mode. `ATLASENT_BASE_URL` is
  optional and defaults to `https://api.atlasent.io/functions/v1`. Before
  this change, a key without a base URL ran in local mode.
- The local-mode startup warning includes a link for getting an API key.
- The agent tool gate sends `context.tool`, the field the runtime's
  `agent.tool.invoke` action class reads.

### Removed

- `atlasent_create_approval_request` and `atlasent_resolve_approval_request`.
  Neither ever worked against the hosted API. Repairing them as written
  would have let an agent approve its own held action. A person now approves
  in the AtlaSent console, and a held result still never runs.

### Fixed

- The local engine's documentation no longer calls itself fail-closed. Its
  behaviour is unchanged: it allows action types it does not recognise, which
  makes it suitable for demos and not for enforcement.

## [2.13.0] - 2026-09-24

### Added

- `atlasent_get_permit`: fetches one permit's record, including status,
  actor, action, environment, timestamps and the issuing decision.
- `atlasent_check_permit`: returns `{ valid, status }` for a permit without
  consuming it. This is a status read, not authorization. Execute only after
  `atlasent_verify_permit`.
- `atlasent_get_decision`: fetches one authorization decision (requires
  `audit:read`). `include_trace` adds approval events, permit uses and webhook
  deliveries.

### Security

- Permit tools never return a permit's bearer `token` or its `signature`.
  Both fields are stripped client-side, so an older or misconfigured backend
  cannot leak them into an agent's context.

## [2.12.2] - 2026-09-24

Same code as 2.12.1, which was tagged but never reached npm.

### Changed

- First release published through npm trusted publishing (OIDC) with
  provenance.
- First version listed on the official MCP Registry as
  `io.github.Atlasent/mcp-server`.

## [2.12.1] - 2026-09-23

Tagged but not published to npm; everything here ships in 2.12.2. 2.12.0 was
never tagged or published.

### Added

- `atlasent_lookup_action`: read-only lookup of canonical action types, gate
  flags, authorization patterns and evidence requirements. It accepts a
  plain-language query and never invents an action type.
- `atlasent_atlas_lookup`: read-only lookup of canonical AtlaSent concepts
  (Authority, Policy, Decision, Permit, Verification, Evidence, Gate, Trust
  Root).
- `atlasent_integrity_audit`: read-only authority-graph consistency audit
  (remote mode only).
- `atlasent_explain_authority`.
- README install instructions for Cursor and Windsurf, and a no-account
  local-mode quickstart.
- `Dockerfile`, `glama.json` and a dev container.

### Changed

- The `deploy_service` outer gate uses the canonical `agent.tool.invoke`
  action. Before this change it used an uncatalogued action type that a
  standard AtlaSent org could only deny.
- Generic REST tools resolve against the gateway root rather than
  `/functions/v1`.
- `serverInfo.version` and the `User-Agent` header are read from
  `package.json`. 2.12.0 code reported itself as 2.11.0.

### Removed

- `atlasent_trajectory_verify`. The hosted API has no endpoint for it. See
  [`docs/TRAJECTORY_VERIFY_DEPRECATED.md`](./docs/TRAJECTORY_VERIFY_DEPRECATED.md).

### Security

- The execution payload digest (`execution_payload_hash`) is bound at
  evaluate, not only presented at verify. Malformed digests are refused
  client-side instead of being sent to a runtime that would drop them.
- The target is bound at evaluate, so a permit issued for one target does not
  verify for another.
- Protected execution verifies the permit before the native effect runs.
- Top-level `deny_code` / `deny_reason` are read, `escalate` is detected
  inside batch `items[]`, and a VQP `hash_mismatch` surfaces as an explicit
  error.

## [2.11.0] - 2026-06-09

### Added

- `deploy_service`: a two-layer protected deployment demo.
- `atlasent_evaluate` / `atlasent_verify_permit`: hosted-API variants with a
  richer context envelope than the local `evaluate` / `verify_permit` tools.
- `atlasent_trajectory_verify` (removed in 2.12.1).
- Approval request tools (removed in 2.14.0), execution-evidence recording
  (`atlasent_record_execution_evaluation`), and batch/stream evaluation
  (`atlasent_evaluate_many`, `atlasent_evaluate_stream`).
- Compliance tools: SCIM, SIEM configuration and evidence export.
- VQP snapshot generation, verification and drift-event tools.
- `server.json` for the MCP Registry and `smithery.yaml` for Smithery.

## [1.0.0] - 2026-04-17

First stable release.

### Added

- `evaluate`: authorizes an action and returns `decision`, `permit_token` and
  `audit_hash`.
- `verify_permit`: consumes a permit at execution time; permits are
  single-use.
- Local mode (no API key): an in-process rules engine with no network calls,
  for demos and offline development.
- Remote mode (`ATLASENT_API_KEY` set): routes to the hosted AtlaSent API.

The `evaluate` and `verify_permit` tool names and required parameters are
stable and will not change without a major version bump.

---

## Companion packages

### `atlasent-guard` Claude Code plugin — Unreleased

- A Claude Code plugin (`packages/agent-hooks`) that makes destructive and
  shipping commands wait for a person, for example `DROP TABLE`,
  `terraform destroy`, volume deletes, `git push --force` and production
  deploys. With nobody to ask, they are refused. Everything else runs as
  normal. Runs locally and needs no account.
- 0.2.2: without Node.js on `PATH` the guard now blocks, with a message saying
  to install Node, instead of silently letting every action through while
  showing as enabled. Also flags `gh repo delete`, `gh release delete`,
  `gh api -X DELETE`, and `find … -delete` or `find … -exec rm` when nothing
  narrows what they match. A commit message or PR body that mentions SQL no
  longer triggers an approval prompt.
- 0.2.3: the Node check moved from an inline command chain in `hooks.json`
  into `hooks/guard.sh`, which `hooks.json` runs by a literal path. The Claude
  plugin directory's validator blocks a hook command it cannot follow, and
  0.2.2's inline chain was one. Behavior is unchanged.
- 0.2.4 (connected mode): approval polls and permit claims now go to the
  `v1-approvals` function under `/functions/v1`. The `/v1/approvals/…` form the
  guard used 404s on every deployed host. Each evaluate also sends a fresh
  `request_id`, which the runtime requires before it will consider source
  provenance. Connected mode still cannot reach an approval: an active global
  incident defense denies every `agent.*` action that lacks signed upstream
  source provenance (`ASSERTION_UNVERIFIED`), which the guard cannot supply,
  and the agent identity endpoint is not deployed to production.
- 0.2.5: connected mode is no longer offered in the plugin. The plugin has no
  key or environment setting, reads no credential of any kind, sends nothing,
  and no longer suggests adding a key. It is local only until connected mode
  can be completed end to end.
- 0.2.6 (connected mode, npm CLI path only; the plugin stays local only):
  - Before evaluating, the guard asks AtlaSent to seal source provenance for the
    exact request (`v1-source-provenance-seal`) and forwards the seal unchanged;
    it asserts none of it.
  - The permit is verified against the provenance action hash, recomputed from
    the current action and never read back from the local pending file.
  - Each attempt keeps one `request_id` across honest retries, and spends it on a
    final answer, a sealer 409 or `idempotency_key_reused`.
  - Refused requests show the runtime's error code and message.
  - Still not commercially ready until the live staging proof passes.
- 0.2.7: the plugin and marketplace descriptions, and the top of the README,
  now state that Node.js 18 or later is required. Behavior is unchanged.

### `@atlasent/mcp-gate` 0.1.0 (tag `gate-v0.1.0`) — 2026-09-25

- First release. A local, fail-closed MCP stdio gate that blocks every tool
  call until you write a rule, and records metadata-only activity evidence.
  No account, no network, no dependencies.

[Unreleased]: https://github.com/Atlasent/atlasent-mcp-server/compare/v2.16.0...HEAD
[2.16.0]: https://github.com/Atlasent/atlasent-mcp-server/compare/v2.15.0...v2.16.0
[2.15.0]: https://github.com/Atlasent/atlasent-mcp-server/compare/v2.14.0...v2.15.0
[2.14.0]: https://github.com/Atlasent/atlasent-mcp-server/compare/v2.13.0...v2.14.0
[2.13.0]: https://github.com/Atlasent/atlasent-mcp-server/compare/v2.12.2...v2.13.0
[2.12.2]: https://github.com/Atlasent/atlasent-mcp-server/compare/v2.12.1...v2.12.2
[2.12.1]: https://github.com/Atlasent/atlasent-mcp-server/compare/v2.11.0...v2.12.1
[2.11.0]: https://github.com/Atlasent/atlasent-mcp-server/compare/v1.0.0...v2.11.0
[1.0.0]: https://github.com/Atlasent/atlasent-mcp-server/releases/tag/v1.0.0
