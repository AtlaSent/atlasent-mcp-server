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

Nothing yet.

## [2.17.3] - 2026-10-06

### Changed

- OpenShell adapter: OpenShell 0.1.3-pre.4 is now reported as containing the
  fix for its startup bug (NVIDIA/OpenShell#3994). It is still "unverified"
  until the live startup test passes on it.
- Documented where the sandbox ID comes from: OpenShell sets
  `OPENSHELL_SANDBOX_ID` in the workload's environment, which is what
  `atlasent-openshell` reads. `OPENSHELL_SANDBOX` is never read, because
  OpenShell sets it to `"1"` inside a workload. The docs also state the
  remaining limit: an agent can still set a different ID for a process it
  starts.

## [2.17.2] - 2026-10-05

### Changed

- The official MCP Registry name is now `io.github.AtlaSent/mcp-server`
  (`server.json` `name` and `package.json` `mcpName`), matching the GitHub
  organization's casing. The registry only lets an organization publish under
  its exact casing, so 2.17.1 was refused under the old
  `io.github.Atlasent/mcp-server`; that entry stays at 2.16.0 and is no longer
  updated. Repository links across the package use `AtlaSent`. Same code as
  2.17.1.

## [2.17.1] - 2026-10-05

### Fixed

- Packaging only: the repository URL in `package.json`, `server.json` and the
  MCPB manifest now uses the GitHub organization's current casing
  (`AtlaSent`). npm checks it against the build's provenance, so 2.17.0 was
  refused at upload and never reached npm. 2.17.1 ships the same code as
  2.17.0.

## [2.17.0] - 2026-10-05 (not published to npm)

### Added

- NVIDIA OpenShell adapter (experimental). A new `atlasent-openshell`
  executable runs one command inside an OpenShell sandbox only after AtlaSent
  authorizes it: `atlasent-openshell run --envelope <file|-> -- <command>`
  evaluates, optionally waits on an approval hold, verifies the permit, then
  runs the command exactly once. Authority binds to the sandbox's durable
  `sandbox_id`; sandbox and workspace names are display labels only. An
  OpenShell Policy Advisor approval never satisfies an AtlaSent hold, and a
  change in OpenShell's policy generation means a fresh evaluation. A command
  killed or timed out after its permit was spent trips the circuit breaker and
  is reported to the runtime. Guide: `docs/OPENSHELL_AUTHORITY_ADAPTER.md`.
  OpenShell 0.1.2 and 0.1.3-pre.1 to pre.3 are flagged as affected by an
  upstream startup bug (NVIDIA/OpenShell#3994); no OpenShell release yet
  contains the fix.
- Verify now presents the workload a permit was evaluated for
  (`workload: { kind, id }`). The runtime requires it for permits bound to an
  OpenShell sandbox.
- `atlasent_evidence_gap_report`, a read-only tool that reads your CI workflow
  files and lists every deploy, publish, migration and infrastructure-apply
  step with whether an AtlaSent gate stands in front of it (`bound`, `gated`,
  `gated_upstream`, `weak` or `ungoverned`), plus the exact fix for each gap.
  Runs offline in local mode.
- MCP prompts: `gate-action`, `explain-decision` and `find-action-type` walk an
  agent through lookup, evaluate, allow-only and verify. They are guidance, not
  enforcement.
- AI Action Protection (opt-in, CROSS-064): `atlasent_governed_file_change`
  makes one GitHub contents write only on a permit verified at the boundary for
  exactly that change, then re-reads the effect. A circuit breaker stops the
  agent when an outcome is unknown or an effect cannot be established, and the
  trip is recorded in the runtime. Registered only when
  `ATLASENT_AI_ACTION_GITHUB_{REPO,BRANCH,TOKEN}` are all set. Guide:
  `docs/AI_ACTION_PROTECTION.md`.
- An MCPB bundle (`npm run bundle`) for Claude Desktop and Smithery stdio
  installs. Blank `ATLASENT_*` values from form-filled hosts now count as unset.
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

- `atlasent_await_approval` could never claim an approved action. It polled
  and claimed at `/v1/approvals/{id}`, which no deployed host serves (404).
  It now uses the `v1-approvals` function under `/functions/v1`.
- `evaluate`, `verify_permit` and `atlasent_evaluate` now check `action_type`
  against the runtime's own pattern (lowercase dot-notation). The old pattern
  let through `/`, uppercase and undotted values the runtime then rejected,
  and `atlasent_evaluate` had no check at all.
- `atlasent_evaluate_many` and `atlasent_evaluate_stream` now check each item's
  `action` against the runtime's action-type pattern (lowercase dot-notation,
  for example `production.deploy`), the same check `evaluate`,
  `verify_permit` and `atlasent_evaluate` gained in #229. The batch and stream
  endpoints run every item through the single-evaluate handler, which rejects
  anything else. One bad item now fails the whole call before anything is
  sent.
- `atlasent_evaluate_many`, `atlasent_evaluate_stream` and `atlasent_query`
  could not reach the runtime. They called `{base}/v1/evaluate/batch`,
  `/v1/evaluate/stream` and `/v1/graphql`. None of these is a deployed
  function under the Supabase functions base, so every call got a 404 and
  was reported as `feature_not_enabled`. They now call `/v1-evaluate-batch`,
  `/v1-evaluate-stream` and `/v1-graphql`, the way `/v1-evaluate` is called,
  and `ATLASENT_BASE_URL` defaults to `https://api.atlasent.io/functions/v1`
  here as it does everywhere else in the server.
- Batch and stream items are now sent as `{ action_type, actor_id, context }`,
  the shape the runtime reads. They used to go out as `{ action, agent }`,
  which the runtime would answer with a per-item 400 ("action_type and
  actor_id are required"). The tool input keeps `action` and `agent`.
- `feature_not_enabled` is now reported only for the runtime's tenant-flag
  404 (`{"error":"not_found"}`). Any other 404, for example a wrong
  `ATLASENT_BASE_URL`, is reported as "endpoint not found" rather than as a
  missing flag.

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

[Unreleased]: https://github.com/AtlaSent/atlasent-mcp-server/compare/v2.17.3...HEAD
[2.17.3]: https://github.com/AtlaSent/atlasent-mcp-server/compare/v2.17.2...v2.17.3
[2.17.2]: https://github.com/AtlaSent/atlasent-mcp-server/compare/v2.17.1...v2.17.2
[2.17.1]: https://github.com/AtlaSent/atlasent-mcp-server/compare/v2.17.0...v2.17.1
[2.17.0]: https://github.com/AtlaSent/atlasent-mcp-server/compare/v2.16.0...v2.17.0
[2.16.0]: https://github.com/AtlaSent/atlasent-mcp-server/compare/v2.15.0...v2.16.0
[2.15.0]: https://github.com/AtlaSent/atlasent-mcp-server/compare/v2.14.0...v2.15.0
[2.14.0]: https://github.com/AtlaSent/atlasent-mcp-server/compare/v2.13.0...v2.14.0
[2.13.0]: https://github.com/AtlaSent/atlasent-mcp-server/compare/v2.12.2...v2.13.0
[2.12.2]: https://github.com/AtlaSent/atlasent-mcp-server/compare/v2.12.1...v2.12.2
[2.12.1]: https://github.com/AtlaSent/atlasent-mcp-server/compare/v2.11.0...v2.12.1
[2.11.0]: https://github.com/AtlaSent/atlasent-mcp-server/compare/v1.0.0...v2.11.0
[1.0.0]: https://github.com/AtlaSent/atlasent-mcp-server/releases/tag/v1.0.0
