# Release Notes

## v2.14.0 — 2026-09-25

### Tools

- **`atlasent_await_approval`** — wait for a person to approve or reject a held
  action in the AtlaSent console (CROSS-056). Held results now carry
  `approval_request_id`. On approval the tool claims the single permit the
  runtime minted (`POST /v1/approvals/{id}/claim-permit`); it must still pass
  `atlasent_verify_permit` before anything runs. Rejected, expired, timed out,
  unclaimable or refused all return no permit. The tool has no decision input
  and cannot approve. Needs `approvals:read` on the key.

- **Reported session on every evaluate** (CROSS-056 §2b): `agent_session`
  carries the MCP client's name and the chat/session id (`ATLASENT_SESSION_ID`,
  `ATLASENT_RUN_ID`, or the Streamable HTTP session; a generated
  `mcp-process-…` id otherwise). Top-level, never inside `context`.
- **`atlasent_evaluate` `actor_id` is optional.** Leave it empty with an agent
  API key; the runtime derives the agent and its owner from the key.

### Security

- **Removed `atlasent_create_approval_request` and
  `atlasent_resolve_approval_request`.** Neither ever worked: both called
  `/v1/approval-requests`, which has no handler in the API. And repairing them
  as they were would have been dangerous: the resolve tool accepted an
  agent-supplied `resolver_id`, so an agent could have approved its own held
  action. An agent must never approve its own action; a person approves in the
  AtlaSent console. A held or `INSUFFICIENT_APPROVALS` result still sets
  `requires_human_approval` and still does not run. A test now fails if any
  tool whose name suggests approving or resolving is registered.

## v2.13.0 — 2026-09-24

### Tools

- **`atlasent_get_permit`** — fetch one permit's record (`GET /v1/permits/:id`):
  status, actor, action, environment, issue/expiry/consume times and the
  issuing `decision_id`.
- **`atlasent_check_permit`** — `{ valid, status }` for a permit without
  consuming it (`GET /v1/permits/:id/valid`). A status read before a deferred
  action, **not** authorization: execute only after `atlasent_verify_permit`.
- **`atlasent_get_decision`** — fetch one authorization decision
  (`GET /v1/execution-evaluations/:id`, needs `audit:read`); `include_trace`
  adds its approval events, permit uses and webhook deliveries.

### Security

- Permit tools (`atlasent_get_permit`, `atlasent_check_permit`,
  `atlasent_list_permits`) never return a permit's `token` (its bearer
  credential) or `signature`: both are stripped client-side, so an older or
  misconfigured backend cannot leak them into an agent's context. The API
  side has also stopped returning them.

## v2.12.2 — 2026-09-24

Same code as `v2.12.1`, which was tagged but never reached npm (the publish
step's `NPM_TOKEN` had lapsed). `v2.12.2` is the first release published via
npm **trusted publishing** (OIDC): `publish.yml` no longer uses a stored npm
token, and upgrades npm to >= 11.5.1, which trusted publishing requires.
Everything listed under `v2.12.1` below ships in this version. It is also the
first version listed on the official MCP Registry (`io.github.Atlasent/mcp-server`).

## v2.12.1 — 2026-09-23

Everything that landed on `main` after the `v2.11.0` tag (`c3b2add`).
`2.12.0` was version-bumped on `main` (`3370382`) but never tagged or
published — the `package.release` gate had no template for this repo until
2026-09-19 — so **`2.12.1` is the first npm release since `2.11.0`** and
carries everything below.

### Security / correctness

- **Payload digest is now bound at evaluate** (`execution_payload_hash`, bare
  64-hex, top level) instead of only presented at verify, where it could
  never match. Malformed digests are refused client-side. See CLAUDE.md
  "Execution payload binding (AC-5)".
- **Target is now bound at evaluate** (#146, #147), so a permit minted for
  one target no longer verifies for another. `deploy_service` binds the
  service name; the agent-tool gate binds the tool name.
- Protected execution now verifies the permit **before** the native effect
  (verify-before-execute regression suite added).
- Top-level `deny_code` / `deny_reason` are read (#133); `escalate` is
  detected inside batch `items[]` (#139); VQP `hash_mismatch` surfaces as an
  explicit MCP error (#141).
- `serverInfo.version` and the `User-Agent` header now come from
  `package.json` — they reported `2.11.0` on the `2.12.0` code (#154).

### Tools

- **Outer gate migrated to the Canon-backed `agent.tool.invoke`
  action** (`CANON-000026` / `ACT-0029`), replacing the broken
  `model.agent.execute_tool` identity described above. See
  AtlaSent-Systems-Inc/atlasent-mcp-server#121 for the investigation and
  decision record.
- `atlasent_lookup_action` — read-only Canon lookup for Action Types, gate
  flags, authorization patterns, and evidence requirements. Accepts a
  plain-language `query`, resolved by an offline, deterministic ranker that
  never invents a slug.
- `atlasent_atlas_lookup` — read-only lookup of canonical AtlaSent concepts
  (Authority, Policy, Decision, Permit, Verification, Evidence, Gate, Trust
  Root).
- `atlasent_integrity_audit` — read-only Authority-graph consistency audit
  (hosted mode only).
- `atlasent_explain_authority`.
- **`atlasent_trajectory_verify` removed** — the runtime has no
  `/v1/trajectory-verify` endpoint (part of a public-contract-honesty
  cleanup). See `docs/TRAJECTORY_VERIFY_DEPRECATED.md`.
  The `2.11.0` release above still had it; do not reintroduce it without a
  real backing endpoint.

### Distribution and community

- README documents Cursor and Windsurf install in addition to Claude
  Desktop, and opens with a no-account local-mode quickstart.
- `Dockerfile` (also used by Glama to introspect the server), `glama.json`,
  dev container, `CONTRIBUTING.md` rewrite, Code of Conduct, RFC template.
- Generic REST tools resolve against the gateway root rather than
  `/functions/v1` (#126).
- Package metadata points at the `Atlasent` GitHub org.

Use MCP `tools/list` on the installed version for the exact tool set rather
than trusting this doc.

## v2.11.0 — 2026-06-09

**Correction (2026-08-30):** this section previously read "Unreleased —
prepared, not yet published," stating no version past v1.0.0 had ever
shipped and that `git tag -l` showed no `v*` tags. Both claims were wrong —
they were based on an incomplete local git clone rather than the live
registries. Verified directly against the npm registry
(`registry.npmjs.org/@atlasent/mcp-server`) and GitHub: **`2.11.0` has been
published to npm since 2026-06-09** (`dist-tags.latest: "2.11.0"`, published
via a manual `workflow_dispatch` run of `publish.yml`, not a tag push), and
the `v2.11.0` git tag has existed since 2026-06-10 (`create-v2-11-0-tag.yml`
run #1). Submission to the **MCP Registry remains genuinely outstanding**
as of 2026-08-30 — confirmed via a live query against
`registry.modelcontextprotocol.io`, which returns zero results for
`atlasent`.

### Tool surface growth since v1.0.0 (what's actually in this published version)

**Correction (2026-08-30, review of this PR):** this section originally
described `main`'s current tool inventory under the `v2.11.0` heading, which
misrepresented several tools as part of the published release when they
were added to `main` only *after* the tag. The published `v2.11.0` was cut
from commit `c3b2add`; verified directly by diffing `src/server.ts` at that
commit against `main`. The list below is now scoped to what `c3b2add`
actually contains — see the "Unreleased" section further down for what has
landed on `main` since.

The two-tool v1.0.0 surface (`evaluate`, `verify_permit`) grew into this by
`v2.11.0`:

- `deploy_service` — protected two-layer deployment demo. **In this
  published version, the outer gate uses the legacy, uncatalogued
  `model.agent.execute_tool` action type**, which has no corresponding
  `action_classes` provisioning path in the runtime — against a real,
  unmodified AtlaSent org this outer gate can only return `NO_ACTION_CLASS`
  deny. See the "Unreleased" section for the fix.
- `atlasent_evaluate` / `atlasent_verify_permit` — hosted V1 API-facing
  variants with a richer context envelope than the local demo tools.
- `atlasent_trajectory_verify` — per-step trajectory drift detection.
- Approval workflow tools (`atlasent_create_approval_request`,
  `atlasent_resolve_approval_request`), execution-evidence recording
  (`atlasent_record_execution_evaluation`), and Wave B tools
  (`atlasent_evaluate_many`, `atlasent_evaluate_stream`).
- Compliance tools: SCIM, SIEM config, evidence export.
- VQP snapshot generation, verification, and drift-event tools.

### Distribution changes since v1.0.0

- `server.json` added for MCP Registry submission
  (`io.github.atlasent-systems-inc/mcp-server`) — **submission itself is
  still outstanding**, see the correction note above the tool list.
- `smithery.yaml` added for Smithery discovery/install.

### Install

```bash
npm install @atlasent/mcp-server
```

See the [README](./README.md) for Claude Desktop / Cursor / Windsurf config
blocks and local/remote mode setup — note the README on `main` describes
the current (unreleased) state, not necessarily what `v2.11.0` ships; the
README bundled into the published npm tarball is frozen as of `c3b2add`.

---

# Release Notes — v1.0.0

**Release date:** 2026-04-17

## AtlaSent MCP Server v1.0.0

First stable release of the AtlaSent MCP server. Works with Claude Desktop, Cursor, Claude Code, and any MCP-compatible client.

### Tools exposed

| Tool | Description |
|---|---|
| `evaluate` | Authorize an action — returns `decision`, `permit_token`, `audit_hash` |
| `verify_permit` | Consume a permit at execution time — enforces single-use |

### Modes

- **Local mode** (no API key): In-process rules engine, zero network calls. Ideal for demos and offline development.
- **Remote mode** (`ATLASENT_API_KEY` set): Routes to the hosted AtlaSent backend. Full audit chain, multi-org policies.

### Install (Claude Desktop)

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": { "ATLASENT_API_KEY": "ask_live_xxx" }
    }
  }
}
```

### Local demo (no credentials)

```bash
git clone https://github.com/Atlasent/atlasent-mcp-server
cd atlasent-mcp-server && npm install && npm run demo
```

### Stability guarantees

The `evaluate` and `verify_permit` tool schemas are stable as of v1.0.0. Tool names and required parameters will not change without a major version bump.
