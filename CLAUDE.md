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
  version.ts                    VERSION read from package.json at runtime (serverInfo + User-Agent). Never hardcode it — a literal reported 2.11.0 from 2.12.0; server.test.ts pins it
  localEngine.ts                Tiny rules engine used when no hosted backend is configured
  engine.ts                     authorize() / verify(): dispatches to local or remote; fail-closed wrapper
  server.ts                     createServer(): registers evaluate, verify_permit, deploy_service + 20+ tools
  canonCatalog.ts               GENERATED-DERIVED: the canonical action specs incl. canon_id (from the atlasent repo); backs atlasent_lookup_action. Re-sync with scripts/sync-canon.mjs
  canonGraph.ts                 GENERATED-DERIVED: per-action knowledge-graph neighborhood + compliance (from atlasent/generated/authorization-graph.json); enriches atlasent_lookup_action. Re-sync with scripts/sync-canon.mjs
  actionRetrieval.ts            Offline, deterministic natural-language → Canon ranker behind atlasent_lookup_action's `query` (field-weighted BM25 + light stemmer); returns confident / ambiguous / none and never synthesizes a slug
  actionSynonyms.ts             Hand-maintained query-side vocabulary for the ranker (token synonyms, phrases, per-slug aliases, context-modifier and stop words). Every SLUG_ALIASES key must be a live Canon slug — actionRetrieval.test.ts fails on drift. Lives outside the drift-gated generated mirrors on purpose
  actionRetrieval.test.ts       Ranker unit tests: alias drift guard, stemmer symmetry, confident/ambiguous/none verdicts, determinism, never-a-non-Canon-slug probe
  atlasCatalog.ts               GENERATED-DERIVED: the Knowledge Atlas (concepts + edges, from atlasent-docs/architecture/traceability/atlas.json); backs atlasent_atlas_lookup. Re-vendor with scripts/vendor-atlas.mjs
  v2Tools.ts                    Wave B tools: atlasent_evaluate_many, atlasent_evaluate_stream, atlasent_query
  v2Client.ts                   HTTP clients for Wave A endpoints; FeatureNotEnabledError on 404
  complianceTools.ts            SCIM, SIEM config, evidence export MCP tools
  vqpTools.ts                   VQP snapshot generation, verification, drift event tools
  streamableHttp.ts             Streamable HTTP transport (MCP HTTP mode)
  index.ts                      CLI entry point; connects stdio transport
  server.test.ts                Unit tests: tools/list, evaluate (local + remote), verify_permit, deploy_service
  server.readonly.test.ts       READONLY mode tests
  complianceTools.test.ts       Compliance tool unit tests
  v2Tools.test.ts               V2 Wave B tool unit tests
  v2Client.test.ts              V2 HTTP client unit tests
  streamableHttp.integration.test.ts  Streamable HTTP transport integration tests
  integration.test.ts           Live-API tests; require ATLASENT_API_KEY + ATLASENT_BASE_URL, skip otherwise
  integration.write.test.ts     Live-API write tests (mutating tools)

packages/agent-hooks/  Claude Code plugin `atlasent-guard` (PreToolUse hook): destructive/shipping shell + MCP calls ask, catastrophic ones deny, ask becomes deny when unattended. Zero deps, local only, no cloud call. Installed from this repo's root `.claude-plugin/marketplace.json`; npm name `@atlasent/agent-hooks` is NOT published (a publish needs a `package.release` template, same as mcp-gate). Tests drive the real CLI with Claude Code's stdin payload
.claude-plugin/        marketplace.json listing the plugins in this repo (source paths are relative to the repo root)

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
- Unset -> `remote` if `ATLASENT_API_KEY` is set (`ATLASENT_BASE_URL` defaults to `https://api.atlasent.io/functions/v1`), else `local`. Before 2026-09-25 a key without a base URL silently fell back to forgeable local mode, contradicting server.json and the README.

## Build, test, run

```bash
npm run build             # tsc -> dist/
npm test                  # 158 unit tests, no network (count grows as tools are added)
npm run test:integration  # live API; needs ATLASENT_API_KEY + ATLASENT_BASE_URL
npm run demo              # end-to-end demo in local mode
```

Tests use `node:test` + MCP SDK's `InMemoryTransport`. `globalThis.fetch` is mocked per-test in remote-mode tests; local-mode tests touch no network. The `npm test` count grows as new tools are added; check `src/*.test.ts` for the current count.

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

Headers: `Authorization: Bearer $ATLASENT_API_KEY`, optional `x-anon-key: $ATLASENT_ANON_KEY`.

## Disabled Endpoints (atlasent-api)

> **Corrected 2026-09-26 — this section is stale in three ways; read this before the
> table below.** Checked against `atlasent-api` `main` (`ffb92cd`):
>
> 1. **Five entries left the disabled manifest on 2026-09-16 (atlasent-api#3402).**
>    `v1-sso-assertion-hook`, `v1-sso-providers`, `v1-policy-rules`,
>    `v1-policy-simulate-layered` and `v1-compliance-packs` now sit in
>    `runtime-functions.json` classified `quarantined`, because a quarantine
>    tombstone has to be *deployed* to be served. Their deployed handler is a
>    **410 Gone** tombstone rather than a 404 (live state is probed by
>    `atlasent-api`'s `quarantine-tombstone-drift` workflow; not re-checked
>    here). The rule for this repo is unchanged: do not call them.
> 2. **One entry is missing:** `v1-marketplace-install` (added 2026-09-10,
>    org-admin-only pack install, held back pending a security review).
> 3. **"No partial-rollout track" is no longer true.** Several notes below give
>    that as the reason a function is held back. `atlasent-api` now has
>    `supabase/runtime-functions-staging.json`, deployed only to staging for
>    functions classified `staging_only`; production deploys never read it. The
>    held-back functions are waiting on a founder decision, not a missing
>    mechanism (atlasent-docs CROSS-058, PROPOSED).
>
> The durable rule, instead of another count: check the `atlasent-api` manifests
> directly, relative to the runtime you target. An endpoint is unusable **anywhere**
> if it is in `runtime-functions-disabled.json` (not deployed) or in
> `runtime-functions.json` with `production_eligibility: quarantined` (deployed
> 410). An endpoint in `runtime-functions-staging.json` is deployed to the
> **staging runtime only**: callable when the configured base URL points at
> staging, absent in production. Do not ship a default code path that depends on
> it. Verified 2026-09-26: this repo references
> none of the endpoints named in this section.

The following atlasent-api edge functions are intentionally **not deployed** on the runtime project and have **no corresponding MCP tools** in this repo. Do not add MCP tools that call these paths — they will always 404 in production. **Updated 2026-09-08** — the disabled set has grown past the 8 entries recorded 2026-08-28 (which had itself grown past the original 3 SSO skeleton handlers, disabled 2026-06-02); it is now 10 entries. None of the 7 added since the original 3 have an MCP tool referencing them either — re-verified against the whole repo (not just `src/`), grepping for every one of the 10 disabled functions' path fragments (`sso-assertion-hook`, `sso-providers`, `sso-connections`, `policy-rules`, `policy-simulate-layered`, `compliance-packs`, `control-assurance`, `outcome-proposals`, `regulatory-interpretations`) — the only match anywhere is this table itself:

| Function name | Notes |
|---|---|
| `v1-sso-assertion-hook` | SSO SAML assertion hook — held back until SSO is in the V1 pilot surface |
| `v1-sso-providers` | SSO identity-provider management — held back. Its notes previously said "re-enable with `v1-sso-connections`" — that cross-reference is stale as of 2026-08-10 since `v1-sso-connections` is now quarantined, not a re-enable target |
| `v1-sso-connections` | **QUARANTINED 2026-08-10** (SSO Configuration Authority remediation) — not merely held back for scope. Had a real table-mismatch bug: POST/GET wrote/read `sso_connections` while GET /:id, PATCH, DELETE operated on `identity_providers`. `v1-sso` (shipped, live) already implements this resource correctly. Do not re-enable without a redesign |
| `v1-policy-rules` | **QUARANTINED 2026-08-18** — plane-mismatch bug, not a scope gap: every route reads/writes `public.policy_rules`, which is confirmed absent on runtime production (that table lives only in `atlasent-console`'s migrations). Do not re-enable by just adding the table; needs a plane-ownership redesign first |
| `v1-policy-simulate-layered` | **QUARANTINED 2026-08-24** (#2181 follow-up) — same absent-on-runtime `policy_rules` dependency as `v1-policy-rules` above, via its `bundle_id`-driven path. Same redesign prerequisite |
| `v1-compliance-packs` | **QUARANTINED 2026-09-06, RETIRED PERMANENTLY 2026-09-06** (atlasent-api#2983, founder decision) — its install handler wrote columns (`org_id`, `policy_bundle`, `status`, `source`, `pack_id`, `pack_version`) that don't exist on `constraint_bundles`, so every install attempt had always failed; zero consumers, zero tests. Decision was retire, not adapt — this stays permanently quarantined (410 Gone) and no `CompliancePackRule[]` adapter should be built for it |
| `v1-control-assurance` | **HELD BACK 2026-08-21** (CROSS-022) — fully implemented and tested, but kept out of `runtime-functions.json` because this repo's deploy model has no partial-rollout track and its `classification.json` production_eligibility is still experimental/disabled |
| `v1-internal-control-assurance-write` | **HELD BACK 2026-08-21** (CROSS-022 step 4) — internal-worker-secret auth only; held back because no worker that calls it has been built yet, same manifest-has-no-partial-rollout reason as above |
| `v1-outcome-proposals` | **HELD BACK 2026-08-27** (CROSS-042) — disabled-by-default AI Proposed Trajectories slice; production enablement requires first-party Anthropic/US-inference/ZDR attestation and security review not yet done |
| `v1-regulatory-interpretations` | **NOT DEPLOYED** (added 2026-08-31, CROSS-020 first-caller slice) — fully implemented and tested, but held back for three independent reasons: the migration creating its tables/RPCs (`20260942000000`) has never been applied to any environment; its three new scopes (`regulatory_interpretations:read/write/ratify`) have never been seeded into `enterprise_permissions`; and per CROSS-020 §1 a ratified row here activates no policy and is not read by `v1-evaluate`/`_shared/rules.ts` anyway |

> **Re-enabled 2026-06-01 — do NOT re-add to the table:** `v1-redteam-runs`,
> `v1-post-evaluations`, `v1-spiffe-validate`, `v1-policy-bundles`, `v1-marketplace-packs`,
> `v1-decisions-stream`, `v1-transparency-anchor` are all deployed today and present in
> `runtime-functions.json`. **`v1-sso` is shipped, not disabled** — it is distinct from the
> three `v1-sso-*` skeletons above; do not conflate them.

Source of truth: `atlasent-api/supabase/runtime-functions-disabled.json`. The V2 Wave A batch/stream/graphql endpoints (`/v1/evaluate/batch`, `/v1/evaluate/stream`, `/v1/graphql`) are separate from this list and are properly gated at the tenant level (`FeatureNotEnabledError` on 404).

## Vault cron secret requirement (atlasent-api operators)

**Correction (2026-09-06, Layer 10 observability/incident-ops audit) — the gap this section describes is FIXED on atlasent-api's own runtime prod/staging projects; do not read the paragraph below as current for those.** `atlasent-api`'s own `docs/runbooks/CRON_VAULT_SECRETS.md` records **"secrets created 2026-07-07 by bettyc925 — all 8 crons live"**, independently corroborated by that repo's `docs/MIGRATION_LOG.md` ("OPS COMPLETE 2026-07-07 ... All 8 crons are now live"). This section had not been updated to reflect that fix — verified directly against both source documents rather than assumed from this repo's own text, per this program's standing "a runbook claim is not evidence, check the target directly" doctrine. The original text is preserved below because it remains accurate for exactly the scenario it names — **a self-hosted or freshly-provisioned atlasent-api runtime project** — where these Vault secrets have not yet been created and this remains a real, live setup step, not a historical curiosity.

If you are running this MCP server against a **self-hosted or fresh atlasent-api** runtime project, be aware that 8 runtime HTTP cron jobs have never fired since creation on managed Supabase instances. These crons were re-pointed to read their bearer secrets from Vault (migration `20260702000000_crons_vault_secret_migration.sql`) because `current_setting('app.*')` GUCs are not settable on managed Supabase (`42501` permission error).

**Until the following Vault secrets are created, those crons post a NULL bearer and receive 401 (fail-safe, no enforcement effect):**

| Vault secret name | Cron it enables |
|---|---|
| `ATLASENT_AUDIT_SIGN_SWEEP_WORKER_SECRET` | `audit-sign-reconciliation-sweep` |
| `ATLASENT_CHAIN_ANCHOR_WORKER_SECRET` | `chain-anchor-every-5min` |
| `ATLASENT_BILLING_ADMIN_SECRET` | `governed-action-stripe-sync` |
| `ATLASENT_EVIDENCE_SCHEDULER_SECRET` | `evidence-scheduler-sweep` |
| `ATLASENT_BVS_WORKER_SECRET` | `bvs-observe-hourly`, `bvs-adjustment-engine-5min` |
| `ATLASENT_DELEGATION_SHADOW_WORKER_SECRET` | `delegation-shadow-every-5min` |
| `supabase_functions_base_url` | All of the above (functions base URL) |

See `atlasent-api/docs/runbooks/CRON_VAULT_SECRETS.md` for the full setup procedure (and its current "all 8 live" status on atlasent-api's own runtime projects, per the correction above). This does not affect MCP server behavior directly (the MCP server calls evaluate/verify synchronously), but audit-chain signing, chain anchoring, and billing sync will be silently broken on a new runtime deployment until these secrets are set.

## npm publishing

Scoped package `@atlasent/mcp-server`, `publishConfig.access: public`. Tag `v*` triggers `publish.yml`, which runs an AtlaSent `package.release` gate, then build, tests, and `npm publish --access public` via npm **trusted publishing** (OIDC; no stored token — see "Trusted publishing replaces NPM_TOKEN" below). The repo is public, so npm provenance is attached, alongside a cosign keyless-signed tarball uploaded as a build artifact. **Correction (2026-08-30):** this section previously claimed no `v*` tag had ever been pushed and no version had ever been published — that was based on an incomplete local git clone (`git tag -l` empty), not the live registry. Verified directly against `registry.npmjs.org`: **`2.11.0` has been published to npm since 2026-06-09** (via a manual `workflow_dispatch` run, not a tag-triggered one), and the `v2.11.0` git tag has existed on GitHub since 2026-06-10 (`create-v2-11-0-tag.yml` run #1, which pinned it to a specific historical commit SHA rather than the HEAD at dispatch time). Before assuming a tag or version is missing, check the live registry/GitHub state directly rather than a local checkout's `git tag -l`, which may not have fetched tags. **MCP Registry: listed since 2026-09-24** (`io.github.Atlasent/mcp-server` 2.12.2, verified via a live `registry.modelcontextprotocol.io/v0/servers?search=atlasent` query). Before then it had never been listed.

### Trusted publishing replaces NPM_TOKEN (2026-09-24)

The repo is now public, and `publish.yml` publishes via npm **trusted
publishing** (OIDC): no stored npm token, `id-token: write` (already present
for cosign), npm upgraded to >= 11.5.1 in the job, and provenance attached via
`publishConfig.provenance`. The "Not `--provenance`" / `NPM_TOKEN` text above
is historical. `v2.12.1` was tagged but never reached npm: the `npm`
environment's `NPM_TOKEN` had lapsed (E404 on PUT), then a re-pasted token
carried a newline ("is not a legal HTTP header value"). `v2.12.2` ships the
same code. Re-running a tag's publish uses the workflow file AT THAT TAG, so a
workflow fix always needs a new version.

### The `package.release` gate had no template for this repo until 2026-09-19

Both `publish.yml` and `publish-mcp-registry.yml` call `package.release` against
runtime prod (`kttccumlnmdtupgbyfue`). Until 2026-09-19 the org's bundle carried
**no template matching this repository at all**, so both gates were
guaranteed-deny (`No template condition matched`) — the same class of gap
`atlasent-control-plane` hit twice and documented at length. That is why the
2026-06-09 publish went out via `workflow_dispatch`: a real tag push would have
been denied at the gate.

Bundle versioned forward v4 -> **v5** (id `73578fb8-88ef-4c24-978d-24803e31837b`,
action class `d9116cd9-2a18-4f60-9638-c2996d2f6c2c`, 14 -> 16 templates,
`allow_actors` unchanged), archive-and-insert in one atomic statement because
published `constraint_bundles` rows are DB-immutable. The two added templates:

| Template | Matches |
|---|---|
| `package_release_atlasent_mcp_server_tag_release_manager` | this repo + `Publish to npm` + `event_name: push` + `^refs/tags/v<semver>(-prerelease)?$` |
| `package_release_atlasent_mcp_server_registry_release_manager` | this repo + `Publish to MCP Registry` + `context.artifact == "mcp-registry"` + `event_name` in (`workflow_run`, `workflow_dispatch`) |

**The registry template deliberately does NOT carry a tag regex.** On the
`workflow_run` path — the normal one, since that workflow chains off
`Publish to npm` — `github.ref` is `refs/heads/main`, not the tag. A tag
condition there would have denied the real path while passing every test
written against the dispatch path. Caught before the production write by running
the drafted templates through the canonical rule engine
(`atlasent-api/packages/sdk/src/rules.ts`), not by reasoning about them.

**Known limit, not a defect:** `publish.yml`'s own `workflow_dispatch` trigger is
NOT authorized — a dispatch has `ref: refs/heads/main` and no tag, so it matches
no template and denies. Releasing from this repo now means pushing a real `v*`
tag. Do not "fix" that by relaxing the ref condition; the tag binding is what
makes the permit name a specific version.

**CORRECTED 2026-09-26 — `@atlasent/mcp-gate` HAS a template and
`publish-gate.yml` reaches `allow`.** This paragraph said the gate "denies until
one is seeded" and named the drafted `package_release_v9` as the thing to apply.
Both are now wrong, in the one direction a stale note must never take: it tells a
reader a working authorization gate cannot pass, and points at a runbook whose SQL
now carries a `SUPERSEDED — DO NOT RUN` banner. Same failure shape
`atlasent-action`'s `RELEASING.md` records for its own release gate.

What is true, read from the live bundle rather than from a runbook: the active
`package.release` bundle for this org is **v10**
(`773a5972-76eb-402c-a288-346a7d9c9ceb`, 32 templates), and it carries
`package_release_atlasent_mcp_gate_tag_release_manager`. `publish-gate.yml`
("Publish MCP Gate to npm", `gate-v*`) matched it on a real tag push and returned
`allow` — the first live exercise of that template — and
`@atlasent/mcp-gate@0.1.0` is on npm with provenance. **v9 was superseded by v10
before it was ever applied; never apply `docs/runbooks/package_release_v9/`.**

Still binding, unchanged: do NOT rename this workflow to impersonate another
template, and do NOT add a `skip_gate` input. A `workflow_dispatch` of it denies
and that is correct — a dispatch carries `ref: refs/heads/main` and no tag, so it
matches no template. Releasing means pushing a real `gate-v*` tag.

Its discriminator is **`context.artifact: "atlasent-mcp-gate"`**, not
`context.package`. `publish-gate.yml` originally sent `"package":
"@atlasent/mcp-gate"` — a field no template in this bundle reads, so it could
never have matched, and a field that is simply absent from a match cannot deny;
it looks identical to a template that was never scoped to the package. The value
is the artifact identity, not the npm package name: the template asserts
`@atlasent/mcp-gate` is denied, which is the assertion that catches this exact
mix-up. Fixed before the first `gate-v*` tag was ever pushed.

Verified post-write, against the STORED row rather than the drafted form:
exactly one `active` bundle for this action class; a server-side `jsonb`
equality check confirmed the local copy matched the stored row byte-for-byte
(so the regex escaping survived the SQL round trip); and re-running the stored
bundle through the rule engine passed 23/23 assertions — 13 covering the new
templates (4 allow, 9 deny) and 10 regression assertions confirming all 14
pre-existing templates still match, each by name.

## MCP Registry publishing

`server.json` (repo root) is the official MCP Registry manifest
(`io.github.Atlasent/mcp-server`; the `io.github.<owner>` prefix must match the
GitHub org, so it changed with the move to `Atlasent`). After every successful npm
publish, `publish-mcp-registry.yml` publishes it to
registry.modelcontextprotocol.io via `mcp-publisher` with GitHub OIDC (no
stored secret). **Release checklist addition: bump BOTH version fields in
`server.json` (top-level and `packages[0].version`) together with
`package.json`** — the workflow fails closed on a mismatch. It also polls npm
until the new version resolves before publishing (fails closed after ~10 min):
the registry rejects a version npm does not serve yet, which is what failed
v2.12.2's first registry run. First-time
publication (and re-publishes) can be run manually via workflow_dispatch.
`smithery.yaml` covers the Smithery directory separately.
