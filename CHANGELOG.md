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

Nothing in the MCP server itself yet. See the companion packages below.

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
  agent's own actor identity.
- Mandatory change-control evaluations accept a `change_plan`, record it as a
  Change Brief, and bind it to the approval. If the plan changes before
  claim, the server files at most one linked re-request and returns the diff.
  A second mismatch stops with no permit.
- Every evaluate reports the calling MCP client and session
  (`agent_session`), taken from `ATLASENT_SESSION_ID`, `ATLASENT_RUN_ID`, the
  Streamable HTTP session, or a generated per-process id.

### Changed

- `atlasent_evaluate`'s `actor_id` is optional. With an agent API key, the
  runtime derives the agent and its owner from the key.
- An API key on its own now selects remote mode. `ATLASENT_BASE_URL` is
  optional and defaults to `https://api.atlasent.io/functions/v1`. Before
  this change, a key without a base URL ran in local mode.
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

### `@atlasent/mcp-gate` 0.1.0 (tag `gate-v0.1.0`) — 2026-09-25

- First release. A local, fail-closed MCP stdio gate that blocks every tool
  call until you write a rule, and records metadata-only activity evidence.
  No account, no network, no dependencies.

[Unreleased]: https://github.com/Atlasent/atlasent-mcp-server/compare/v2.14.0...HEAD
[2.14.0]: https://github.com/Atlasent/atlasent-mcp-server/compare/v2.13.0...v2.14.0
[2.13.0]: https://github.com/Atlasent/atlasent-mcp-server/compare/v2.12.2...v2.13.0
[2.12.2]: https://github.com/Atlasent/atlasent-mcp-server/compare/v2.12.1...v2.12.2
[2.12.1]: https://github.com/Atlasent/atlasent-mcp-server/compare/v2.11.0...v2.12.1
[2.11.0]: https://github.com/Atlasent/atlasent-mcp-server/compare/v1.0.0...v2.11.0
[1.0.0]: https://github.com/Atlasent/atlasent-mcp-server/releases/tag/v1.0.0
