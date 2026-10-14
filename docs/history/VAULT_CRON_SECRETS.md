# Vault cron secret requirement (atlasent-api operators)

> Moved verbatim from `CLAUDE.md` on 2026-10-14 (no relative links needed rebasing; paths in code spans are repo-root-relative, as they were in `CLAUDE.md`). Historical record: dated narrative, superseded text included. `CLAUDE.md` states the current truth; where they differ, `CLAUDE.md` wins.

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
