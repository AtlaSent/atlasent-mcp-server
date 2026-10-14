# Disabled atlasent-api endpoints: history

> Moved verbatim from `CLAUDE.md` on 2026-10-14 (no relative links needed rebasing; paths in code spans are repo-root-relative, as they were in `CLAUDE.md`). Historical record: dated narrative, superseded text included. `CLAUDE.md` states the current truth; where they differ, `CLAUDE.md` wins.

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

Source of truth: `atlasent-api/supabase/runtime-functions-disabled.json`. The V2 Wave A batch/stream/graphql functions (`v1-evaluate-batch`, `v1-evaluate-stream`, `v1-graphql`, called as `{ATLASENT_BASE_URL}/v1-evaluate-batch` etc.) are separate from this list and are gated at the tenant level. A flag-off answer is a 404 with `{"error":"not_found"}`, surfaced as `FeatureNotEnabledError`; any other 404 is a `V2HttpError`. The `/v1/evaluate/batch` form under the functions base is not a deployed function. Batch/stream items go on the wire as `{action_type, actor_id, context}`.
