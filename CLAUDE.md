# @atlasent/mcp-server

MCP server that enforces `authorize-before-execute` for any MCP-compatible AI agent.

## Architecture baseline

> Canonical cross-repo reference: [`atlasent-docs/architecture/ARCHITECTURE-BASELINE.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-docs/blob/main/architecture/ARCHITECTURE-BASELINE.md)

This repo's role: **MCP distribution layer** — exposes AtlaSent authorization as MCP tools (`atlasent_evaluate`, `atlasent_verify_permit`) for any MCP-compatible agent host (Claude Desktop, Cursor, Windsurf) without requiring a custom SDK integration.

Cross-repo invariants for this repo:
- Wire shape source of truth: `atlasent-api/supabase/functions/v1-{evaluate,verify-permit}/handler.ts`. Do not invent new request/response shapes here.
- Fail-closed at every layer: any error in `authorize()` or `verify()` collapses to deny. This is non-negotiable.
- 10-second request timeout on every hosted-API fetch (`AbortSignal.timeout()`). A hung API must not block the agent.
- Mode dispatch reads env vars at call time (not module load), so tests can swap config without reload.

---

## Architecture

```
src/
  decision.ts                   Decision / VerifyResult types + toolResult() MCP envelope helper
  version.ts                    VERSION read from package.json at runtime (serverInfo + User-Agent). Never hardcode it; server.test.ts pins it
  localEngine.ts                Tiny rules engine used when no hosted backend is configured
  engine.ts                     authorize() / verify(): dispatches to local or remote; fail-closed wrapper
  server.ts                     createServer(): registers evaluate, verify_permit, deploy_service + 20+ tools
  prompts.ts                    MCP Prompts (gate-action, explain-decision, find-action-type). Guidance only, never enforcement; tests in server.test.ts
  canonCatalog.ts               GENERATED-DERIVED: the canonical action specs incl. canon_id (from the atlasent repo); backs atlasent_lookup_action. Re-sync with scripts/sync-canon.mjs
  canonGraph.ts                 GENERATED-DERIVED: per-action knowledge-graph neighborhood + compliance; enriches atlasent_lookup_action. Re-sync with scripts/sync-canon.mjs
  actionRetrieval.ts            Offline, deterministic natural-language → Canon ranker behind atlasent_lookup_action's `query` (field-weighted BM25 + light stemmer); returns confident / ambiguous / none and never synthesizes a slug
  actionSynonyms.ts             Hand-maintained query vocabulary for the ranker. Every SLUG_ALIASES key must be a live Canon slug (actionRetrieval.test.ts fails on drift)
  actionRetrieval.test.ts       Ranker tests: alias drift guard, verdicts, determinism, never-a-non-Canon-slug probe
  atlasCatalog.ts               GENERATED-DERIVED: the Knowledge Atlas (concepts + edges, from atlasent-docs/architecture/traceability/atlas.json); backs atlasent_atlas_lookup. Re-vendor with scripts/vendor-atlas.mjs
  v2Tools.ts                    Wave B tools: atlasent_evaluate_many, atlasent_evaluate_stream, atlasent_query
  v2Client.ts                   HTTP clients for Wave A endpoints; FeatureNotEnabledError on 404
  complianceTools.ts            SCIM, SIEM config, evidence export MCP tools
  vqpTools.ts                   VQP snapshot generation, verification, drift event tools
  exposureReview.ts             atlasent_exposure_review: the free Authorization Exposure Review (scope: these files only, not an org assessment; consent-gated help links). Offline, no network call; tests pin the wording
  exposureScanCli.ts            `atlasent-exposure-scan [repo-dir] [--out dir] [--fail-on-gaps]`: the same review as one command, writing self-contained, escaped HTML plus .md/.json
  hostEnv.ts                    dropEmptyAtlasentEnv(): blank ATLASENT_* values from form-filled hosts (MCPB/Smithery) count as unset, so a blank base URL cannot bypass the hosted default
  evidenceGap.ts                atlasent_evidence_gap_report: offline scan of CI workflow YAML for deploy/publish/migrate/apply steps with no (or a skippable) AtlaSent gate. Unparseable files go to parse_errors, never dropped. evidenceGap.test.ts carries mutants that must each change the status
  streamableHttp.ts             Streamable HTTP transport (MCP HTTP mode)
  governedAction.ts             AI Action Protection executor (CROSS-064): action digest, sealed-hash recompute, verify-at-boundary -> execute once -> effect -> ai_action_proof.v1, and the execution-boundary CircuitBreaker (can only stop, never authorize; no MCP tool resets it)
  openshell.ts                  NVIDIA OpenShell adapter: binds to the durable sandbox_id (names are labels only), refuses OpenShell Policy Advisor approvals as AtlaSent approvals, re-evaluates across a policy-generation change. Live probe: npm run test:openshell-acceptance. Guide: docs/OPENSHELL_AUTHORITY_ADAPTER.md
  openshell.securityRegressions.test.ts  Regressions for NVIDIA/OpenShell#4359 (nothing runs before the final verify verdict) and #4397 (refuses non-loopback plaintext ATLASENT_BASE_URL). Only a recorded CONNECT-path pass of `npm run test:openshell-transport-acceptance` may add a version to OPENSHELL_TRANSPORT_IDENTITY_CONFIRMED; a `PROBE_PLAINTEXT_MODE=transparent` pass never qualifies. Streaming middleware is NOT adopted
  openshellRun.ts / openshellCli.ts  `atlasent-openshell run ... -- <cmd>`: evaluate -> HOLD wait -> verify -> execute once; a signal/timeout after verify is E2 (local breaker + /v1-agent-circuit-trips). OpenShell must inject the sandbox context
  githubFileAdapter.ts          Reference execution adapter: one real GitHub contents write, effect re-read at commit and branch head
  aiActionTools.ts              atlasent_governed_file_change, registered ONLY when ATLASENT_AI_ACTION_GITHUB_{REPO,BRANCH,TOKEN} are all set. Guide: docs/AI_ACTION_PROTECTION.md
  index.ts                      CLI entry point; connects stdio transport
  *.test.ts                     Unit tests (server, readonly, compliance, v2, ...); integration*.test.ts are live-API, need ATLASENT_API_KEY + ATLASENT_BASE_URL, skip otherwise

packages/agent-hooks/  Claude Code plugin `atlasent-guard` (PreToolUse hook): destructive/shipping shell + MCP calls ask, catastrophic ones deny, ask becomes deny when unattended. Zero deps, Apache-2.0 with its own LICENSE + NOTICE. See "agent-hooks plugin rules" below
packages/openshell-workload-guard/  OpenShell supervisor middleware (CROSS-066; docs/OPENSHELL_WORKLOAD_IDENTITY_DESIGN.md): verifies the gateway-signed sandbox_id, denies an evaluate/verify naming another sandbox or none, signs `x-atlasent-workload-attestation`. Not published, not in the MCP bundle. Needs a pinned https `destination`; `fill_absent_workload` splices bytes, never re-serializes; adapter guard mode accepts allow/hold only on `workload_attested: true`. Never make it rewrite a forged workload: denying is the evidence. CROSS-070 and live-test record: docs/history/ARCHITECTURE_MAP_HISTORY.md
.claude-plugin/        marketplace.json listing the plugins in this repo (source paths are relative to the repo root)
mcpb/manifest.json     MCPB manifest: `npm run build && npm run bundle` packs the same dist/ (prod deps only) into atlasent-mcp-server-<version>.mcpb for Smithery stdio listings and Claude Desktop. CI builds + validates it on the Node 22 leg
docs/DISTRIBUTION.md   canonical status of every listing surface (registry, npm, Glama, Smithery, plugin directory, ...): one product, thin per-marketplace metadata

Dockerfile            stdio image; also what Glama builds to introspect tools (no creds -> local mode). CI `docker-smoke` job keeps it answering tools/list
glama.json            Glama listing ownership (maintainers)
.devcontainer/        one-click contributor environment (local mode)

examples/
  demo.mjs            End-to-end script: spawns server, drives evaluate -> deploy -> verify flow

.github/workflows/
  ci.yml              build + test on push/PR, Node 18/20/22 matrix; docker-smoke job
  integration.yml     nightly integration tests against the hosted API
  publish.yml         npm publish --access public (cosign-signed tarball) on v* tag push, gated by an AtlaSent release check
```

## Interception point

Every protected tool follows the same pattern. See `server.ts`, the `deploy_service` handler:

```ts
const ctx: ActionContext = { action_type: "production.deploy", actor_id, environment, ... };
const decision = await authorize(ctx);       // INTERCEPTION POINT
if (decision.decision !== "allow") {
  return toolResult(decision);                // blocked; nothing executes
}
const result = /* run the action */;
return toolResult(decision, { result });
```


The guarantee: if `authorize()` does not return `allow`, the action code never runs.

## Mode dispatch

`engine.getMode()` is read on every call (so hosts can flip modes without restart):

- `ATLASENT_MODE=remote` -> hosted AtlaSent API
- `ATLASENT_MODE=local` -> in-process rules engine
- Unset -> `remote` if `ATLASENT_API_KEY` is set (`ATLASENT_BASE_URL` defaults to `https://api.atlasent.io/functions/v1`), else `local`. A key without a base URL never falls back to local mode.

## Build, test, run

```bash
npm run build             # tsc -> dist/
npm run lint              # ESLint (eslint.config.mjs); toolchain lives in tools/lint because root TypeScript 7 has no JS API for typescript-eslint
npm test                  # unit tests, no network
npm run test:integration  # live API; needs ATLASENT_API_KEY + ATLASENT_BASE_URL
npm run demo              # end-to-end demo in local mode
```

Tests use `node:test` + MCP SDK's `InMemoryTransport`. `globalThis.fetch` is mocked per-test in remote-mode tests; local-mode tests touch no network.

## Key design decisions

- **Fail-closed at every layer.** `authorize()` and `verify()` wrap everything in try/catch; any error -> `{ decision: "deny" }` or `{ outcome: "error", valid: false }`.
- **Env vars read at call time.** Let tests (and users) swap config without module reload.
- **10s request timeout.** `AbortSignal.timeout()` on every fetch.
- **Normalized decision envelope.** One shape for `allow`/`deny`/`hold`; remote outputs coerced into this shape (`escalate` -> `hold`); unknown decisions collapse to `deny`.
- **`isError` set only on failure.** MCP convention.
- **Stderr structured logs.** Every authorize / execute / verify emits a JSON line to stderr.

## API contracts

Hosted backend: `atlasent-api/supabase/functions/v1-{evaluate,verify-permit}/handler.ts` is the source of truth.

- `POST /v1-evaluate`: `{ action_type, actor_id, context }` -> `{ decision, permit_token?, request_id, expires_at?, denial? }`
- `POST /v1-verify-permit`: `{ permit_token, action_type, actor_id }` -> `{ valid, outcome, verify_error_code?, reason? }`

Headers: `Authorization: Bearer $ATLASENT_API_KEY`, optional `x-anon-key: $ATLASENT_ANON_KEY`.

Presenting a value at verify binds nothing; it must be bound at evaluate. Full reasoning and the defects that taught it: [binding and identity history](docs/history/BINDING_AND_IDENTITY_HISTORY.md).

- **Payload digest (AC-5).** Bind at evaluate as top-level `execution_payload_hash`, bare 64-char hex, never inside `context`. Anything else is silently dropped on the ordinary path (denied for change-controlled types). `normalizePayloadHash` (`src/engine.ts`) is the single entry point: strips `sha256:`, lowercases, **throws** on non-64-hex. Check the response's `execution_payload_hash_accepted`.
- **Target.** `applyTargetBinding` fills all three bound placements from one value: top-level `resource_id`, `context.target_id`, `context.target = { id }`. `deploy_service` binds `service_name`; `agentToolGate` binds the tool. No target means a byte-identical request (pinned by a test).
- **Approval claim (IMPL-026B).** For `approved_awaiting_claim`, `awaitApproval` mints the agent's `actor_identity.v1` (`mintAgentActorIdentity`, `/v1-agent-actor-identity`, 10 s timeout) with action type and environment from the approval row, never from the agent. Failed mint: no claim, no permit. 404: claim `{}` plus a note. Plain `approved`: claim `{}`, no mint. 409 `claim_in_progress`: re-poll, mint fresh.
- **Change plans (four mandatory-change-control types).** `deploy_service`, `evaluate` and `atlasent_evaluate` take a `change_plan`; `attachChangeControl` creates a `/v1-change-brief` for exactly that plan, sends `change_plan` + `change_brief_id` top-level, and remembers the plan per `approval_request_id` (in memory, cap 256) for the claim. Brief 404/403 or unknown actor/target/environment: note, evaluate proceeds; any other brief failure throws. On `change_plan_mismatch`: at most ONE linked re-request per call; anything else stops with no permit and returns the diff. `on_plan_mismatch: "use_approved"` returns `approved_plan`; an unreadable diff claims nothing. Tests: `src/planMismatch.test.ts`.
- **Verified actor at evaluate.** `attachAgentActorIdentity` attaches a minted assertion on every path sending a `change_plan` (else `ACTOR_UNVERIFIED`), after `attachChangeControl` so the remembered body never holds it. `deploy_service` refuses in remote mode without `change_plan` and tells the agent to ask, not invent one.
- **`agent.*` (CROSS-063), in `authorizeRemote` only.** Mint for every `agent.*` action and send `agent:<id>` as `actor_id`. `attachSourceProvenance` runs **last**, sealing `request_id` (bare UUID), `context` and `resource_id` as sent; `agentToolGate` presents the sealed `action_hash` + `bound_actor_id` at verify. The standalone evaluate path (`evaluateAction`, behind `atlasent_evaluate`) mints the identity but does **not** seal provenance, so the runtime's provenance overlay refuses an `agent.*` action sent that way. Tests: `src/agentToolGate.test.ts`.
- **Verified actor at verify.** `attachVerifyActorIdentity` mints a fresh assertion for `agent.*` and the change-control types, never reusing the evaluate one. Tests: `src/verifyActorIdentity.test.ts`.
- At evaluate and verify, a failed identity mint or provenance seal adds a `notes` entry and the request still goes out; the runtime decides (the claim path above is stricter).

## agent-hooks plugin rules

- The plugin install is local only (0.2.5+): no key setting, reads no credential, sends nothing. Its hook command passes `--plugin`, so `loadCredentials` returns nothing and `decide` never reaches the network. Connected mode (`connected.mjs`, design `docs/HOOK_HITL_APPROVAL.md`) exists only on the unpublished npm CLI path; there every failure denies and the no-key path is pinned byte-identical. Re-enabling it in the plugin means restoring `plugin.json`'s `userConfig` and that branch, with a live end-to-end run first.
- Tests live in `packages/agent-hooks-test/`, OUTSIDE the plugin folder: the plugin installs whole, and the Claude directory's validator blocks a plugin whose files contain secret-shaped strings. Never put a test file or token shape in `packages/agent-hooks/` (a test fails if one reappears).
- `@atlasent/agent-hooks` is NOT published on npm; a publish needs its own `package.release` template seeded into the live bundle.
- Full original entry (runtime blockers, `request_id` handling): [architecture map history](docs/history/ARCHITECTURE_MAP_HISTORY.md).

## Disabled and quarantined atlasent-api endpoints

Do not add MCP tools (or default code paths) calling an endpoint the runtime does not serve. Check the `atlasent-api` manifests directly for the runtime you target; never trust a count or table written here:

- `runtime-functions-disabled.json` (not deployed) or `runtime-functions.json` with `production_eligibility: quarantined` (deployed 410): unusable anywhere.
- `runtime-functions-staging.json`: staging runtime only; never a default code path.
- `v1-sso` is shipped, distinct from the `v1-sso-*` skeletons. The 2026-06-01 re-enabled set (`v1-redteam-runs`, `v1-post-evaluations`, `v1-spiffe-validate`, `v1-policy-bundles`, `v1-marketplace-packs`, `v1-decisions-stream`, `v1-transparency-anchor`) is deployed.
- Per-endpoint re-enable constraints live in the history table below: e.g. no `CompliancePackRule[]` adapter for the retired `v1-compliance-packs`; `v1-policy-rules` / `v1-policy-simulate-layered` need a plane-ownership redesign, not just the missing table; `v1-sso-connections` needs a redesign.

The V2 Wave A functions (`v1-evaluate-batch`, `v1-evaluate-stream`, `v1-graphql`, called as `{ATLASENT_BASE_URL}/v1-evaluate-batch` etc.) are tenant-gated: a flag-off 404 `{"error":"not_found"}` is `FeatureNotEnabledError`, any other 404 a `V2HttpError`. `/v1/evaluate/batch` is not a deployed function. Items go on the wire as `{action_type, actor_id, context}`. Dated per-endpoint table and corrections: [disabled endpoints history](docs/history/DISABLED_ENDPOINTS_HISTORY.md).

Operators of a self-hosted or fresh atlasent-api runtime must create the cron Vault secrets or audit signing, chain anchoring and billing sync stay silently broken: [Vault cron secrets](docs/history/VAULT_CRON_SECRETS.md).

## npm publishing

`@atlasent/mcp-server`, `publishConfig.access: public`. A `v*` tag triggers `publish.yml`: AtlaSent `package.release` gate, build, tests, then `npm publish` via npm trusted publishing (OIDC, no stored token, provenance attached) plus a cosign keyless-signed tarball artifact. `publish-gate.yml` publishes `@atlasent/mcp-gate` on a `gate-v*` tag, also gated and via trusted publishing. History (2.11.0, v2.12.1, template v5/v9/v10): [release gate history](docs/history/RELEASE_GATE_HISTORY.md).

- Release only by pushing a real `v*` (or `gate-v*`) tag. A `workflow_dispatch` carries `refs/heads/main` and no tag, so it matches no template and denies; that is correct. Never relax the ref condition: the tag binding is what makes the permit name a specific version. The registry template deliberately has no tag regex (`workflow_run` runs on `refs/heads/main`).
- Never add a `skip_gate` input, and never rename a workflow to impersonate another template. `publish-gate.yml`'s discriminator is `context.artifact: "atlasent-mcp-gate"`, not `context.package`.
- Never apply `docs/runbooks/package_release_v9/`; it was superseded by v10 before it was applied.
- Published `constraint_bundles` rows are DB-immutable: change a bundle only by archive-and-insert in one atomic statement, verified against the stored row.
- Re-running a tag's publish uses the workflow file AT THAT TAG, so a workflow fix always needs a new version (v2.12.1 -> v2.12.2).
- Check the live npm registry / GitHub before concluding a tag or version is missing, not a local `git tag -l`.

## MCP Registry publishing

`server.json` is the MCP Registry manifest: `io.github.AtlaSent/mcp-server` since 2.17.2 (the old `io.github.Atlasent/mcp-server` is frozen at 2.16.0). The registry compares case-sensitively (modelcontextprotocol/registry#689), so the `io.github.<owner>` prefix must match the org's casing exactly and `package.json` `mcpName` must equal it (`distribution.test.ts` pins this). npm provenance also compares `repository.url` case-sensitively: keep `github.com/AtlaSent/...`. `publish-mcp-registry.yml` runs after each npm publish (GitHub OIDC, no stored secret), polls npm until the version resolves and fails closed after ~10 min; manual re-publish via workflow_dispatch. Read `_meta[...].isLatest`, not the first search hit (search lists oldest first). Smithery: `smithery.yaml`. Listing status: `docs/DISTRIBUTION.md`.

**Release checklist: bump BOTH version fields in `server.json` (top-level and `packages[0].version`) AND `mcpb/manifest.json`'s `version` together with `package.json`.** `src/distribution.test.ts` and `scripts/build-mcpb.mjs` fail on any mismatch, and the workflow fails closed on one.
