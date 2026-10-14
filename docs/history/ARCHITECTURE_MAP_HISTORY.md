# Architecture file map: full original entries

> Moved verbatim from `CLAUDE.md` on 2026-10-14 (no relative links needed rebasing; paths in code spans are repo-root-relative, as they were in `CLAUDE.md`). Historical record: dated narrative, superseded text included. `CLAUDE.md` states the current truth; where they differ, `CLAUDE.md` wins.

These are the full file-map entries (plus one Mode dispatch sentence and the Build/test lines) as they stood before CLAUDE.md shortened them. Each line is verbatim.

## File-map entries (originally in CLAUDE.md's "Architecture" code block)

```
  version.ts                    VERSION read from package.json at runtime (serverInfo + User-Agent). Never hardcode it — a literal reported 2.11.0 from 2.12.0; server.test.ts pins it
  exposureReview.ts             atlasent_exposure_review: the free Authorization Exposure Review (founder decision 2026-10-07). Renders analyzeWorkflows() as readable Markdown with a scope statement (these files only, not an org assessment), fixes, and optional consent-gated help links to console /help/implementation. Offline like evidenceGap.ts. Tests in exposureReview.test.ts pin the scope wording, the consent and fee wording, no help offer on a fully gated repo, and no network call
  exposureScanCli.ts            `atlasent-exposure-scan [repo-dir] [--out dir] [--fail-on-gaps]`: the same review as one command against a real checkout. Reads .github/workflows/*.yml, writes atlasent-exposure-review.{html,md,json}. The HTML is self-contained (no script, font, image or stylesheet link) and escapes every workflow-derived string; exposureScanCli.test.ts pins both, plus the scope wording
  openshell.securityRegressions.test.ts  2026-10-10 regression suite for NVIDIA/OpenShell#4359 (nothing runs before the final verify verdict; revocation / policy change stops delivery; complete verify binding) and #4397 (CLI refuses non-loopback plaintext ATLASENT_BASE_URL). OPENSHELL_OPEN_ADVISORIES rides on every assessOpenShellVersion result; the #4397 one drops only for a version in OPENSHELL_TRANSPORT_IDENTITY_CONFIRMED (empty), which needs a recorded qualifying pass (CONNECT path; a `PROBE_PLAINTEXT_MODE=transparent` pass never qualifies) of the live probe `npm run test:openshell-transport-acceptance` (src/openshell.transport.acceptance.test.ts, runTransportIdentityProbe; TLS case is the positive control, not_observed fails). Streaming middleware is NOT adopted
packages/agent-hooks/  Claude Code plugin `atlasent-guard` (PreToolUse hook): destructive/shipping shell + MCP calls ask, catastrophic ones deny, ask becomes deny when unattended. Zero deps. **The plugin install is local only (0.2.5+): it offers no key setting, reads no credential and sends nothing.** Connected mode exists only on the unpublished npm CLI path, because the runtime cannot complete it today (`v1-agent-actor-identity` is staging-only; an active global incident defense denies `agent.*` actions without signed source provenance). On that path it (`connected.mjs`, design `docs/HOOK_HITL_APPROVAL.md`) sends an unattended ask to `v1-evaluate` as `agent.tool.invoke`, binds the permit to `sha256(JCS({tool_name, tool_input}))` plus target/environment/agent, and allows only on a verified claimed permit. Every failure denies; the no-key path is pinned byte-identical. Each attempt carries a persisted per-attempt `request_id` (UUID, keyed by action digest; reused on an honest retry, spent on a final decision or `idempotency_key_reused`), because the runtime's provenance reservation is bound to it. Installed from this repo's root `.claude-plugin/marketplace.json`; npm name `@atlasent/agent-hooks` is NOT published (a publish needs its own `package.release` template seeded into the live bundle, as mcp-gate got in v10). Apache-2.0, with its own LICENSE + NOTICE because the plugin installs from this folder alone. Tests drive the real CLI with Claude Code's stdin payload and live in `packages/agent-hooks-test/`, OUTSIDE the plugin folder: the plugin installs that folder whole, and the Claude directory's validator blocks a plugin whose files contain secret-shaped strings (the redaction fixtures). A test there fails if a test file or token shape reappears in `packages/agent-hooks/`. The plugin's hook command passes `--plugin`, which makes it local only: `loadCredentials` returns nothing and `decide` never reaches the network. Re-enabling connected mode in the plugin means restoring `plugin.json`'s `userConfig` and that branch, with a live end-to-end run first
packages/openshell-workload-guard/  OpenShell supervisor middleware (CROSS-066; design docs/OPENSHELL_WORKLOAD_IDENTITY_DESIGN.md). It runs before OpenShell injects the AtlaSent key, verifies the gateway-signed sandbox_id (pinned JWKS, typ/alg/iss/aud/caller_kind), denies an evaluate/verify whose workload names another sandbox or none, and signs `x-atlasent-workload-attestation` (60 s EdDSA JWS over the exact body), which atlasent-api#4032 requires for keys flagged requires_workload_attestation. Own package with gRPC deps; not published, not part of the MCP server bundle. Proto files vendored unmodified from OpenShell (Apache-2.0, see NOTICE). CI job `openshell-workload-guard`. Live-tested on OpenShell 0.1.3-pre.4 (results in the design doc). Requires a pinned `destination` host (port default 443) and denies any request not reported as https to it, or with scheme/host/port left empty (NVIDIA/OpenShell#4397; it cannot detect a mislabelled https). Declares only the buffered HTTP request binding (streaming #4359 not adopted). Opt-in `fill_absent_workload` (Docker driver, 2026-10-10; live-tested on OpenShell 0.1.3 2026-10-13, `run-guard-bound.sh` PASS, atlasent-api#4281) adds the verified workload to a body that has NONE, by splicing the original bytes (never re-serializing), and signs the attestation over the new body; it pairs with the adapter's `ATLASENT_OPENSHELL_WORKLOAD_BINDING=guard` (sends no workload, and accepts an allow/hold only when the runtime reports `workload_attested: true`, which atlasent-api's v1-evaluate emits only for a verified guard attestation; until that runtime change deploys, guard mode denies; src/openshell.guardBound.test.ts). CROSS-070 (decided 2026-10-10): the runtime will require attestation for EVERY request naming openshell_sandbox, behind atlasent-api's OPENSHELL_WORKLOAD_ATTESTATION_ENFORCEMENT (off until its three gates close); once enforced, the adapter without the guard stops working on every driver (docs/OPENSHELL_AUTHORITY_ADAPTER.md). Never make it rewrite a forged workload: denying is the evidence
```

Further entries shortened in the same pass (verbatim originals):

```
  canonGraph.ts                 GENERATED-DERIVED: per-action knowledge-graph neighborhood + compliance (from atlasent/generated/authorization-graph.json); enriches atlasent_lookup_action. Re-sync with scripts/sync-canon.mjs
  actionSynonyms.ts             Hand-maintained query-side vocabulary for the ranker (token synonyms, phrases, per-slug aliases, context-modifier and stop words). Every SLUG_ALIASES key must be a live Canon slug — actionRetrieval.test.ts fails on drift. Lives outside the drift-gated generated mirrors on purpose
  actionRetrieval.test.ts       Ranker unit tests: alias drift guard, stemmer symmetry, confident/ambiguous/none verdicts, determinism, never-a-non-Canon-slug probe
  evidenceGap.ts                atlasent_evidence_gap_report: offline scan of CI workflow YAML for deploy/publish/migrate/apply steps with no (or a skippable) AtlaSent gate. Own block-YAML subset parser (no new dep); unparseable files go to parse_errors, never dropped. Tests in evidenceGap.test.ts carry mutants (continue-on-error, conditional gate, gate-after-step, evaluate-only, commented-out command) that must each change the status
  openshell.ts                  NVIDIA OpenShell adapter contract: binds to the durable sandbox_id (names/workspace are labels only), refuses OpenShell Policy Advisor approvals as AtlaSent approvals, re-evaluates across an OpenShell policy-generation change, startup probe. Live probe: npm run test:openshell-acceptance. Guide: docs/OPENSHELL_AUTHORITY_ADAPTER.md
  openshellRun.ts / openshellCli.ts  `atlasent-openshell run ... -- <cmd>`: evaluate -> HOLD wait -> verify -> execute once in one process; a signal/timeout after verify is E2 (local breaker + /v1-agent-circuit-trips). Sandbox context from ATLASENT_OPENSHELL_SANDBOX_CONTEXT_FILE or OPENSHELL_SANDBOX_* env, which OpenShell must inject
```

Test-file entries, collapsed to one line in CLAUDE.md (verbatim originals):

```
  server.test.ts                Unit tests: tools/list, evaluate (local + remote), verify_permit, deploy_service
  server.readonly.test.ts       READONLY mode tests
  complianceTools.test.ts       Compliance tool unit tests
  v2Tools.test.ts               V2 Wave B tool unit tests
  v2Client.test.ts              V2 HTTP client unit tests
  streamableHttp.integration.test.ts  Streamable HTTP transport integration tests
  integration.test.ts           Live-API tests; require ATLASENT_API_KEY + ATLASENT_BASE_URL, skip otherwise
  integration.write.test.ts     Live-API write tests (mutating tools)
```

## Mode dispatch (originally in CLAUDE.md's "Mode dispatch" section)

- Unset -> `remote` if `ATLASENT_API_KEY` is set (`ATLASENT_BASE_URL` defaults to `https://api.atlasent.io/functions/v1`), else `local`. Before 2026-09-25 a key without a base URL silently fell back to forgeable local mode, contradicting server.json and the README.

## Build, test, run (originally in CLAUDE.md; the hard-coded test count was dropped there)

```bash
npm test                  # 158 unit tests, no network (count grows as tools are added)
```

Tests use `node:test` + MCP SDK's `InMemoryTransport`. `globalThis.fetch` is mocked per-test in remote-mode tests; local-mode tests touch no network. The `npm test` count grows as new tools are added; check `src/*.test.ts` for the current count.
