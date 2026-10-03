# AtlaSent MCP Gate

A fail-closed proxy that sits between an MCP client and an MCP server. Every tool call
is blocked until you write a rule allowing it. Runs entirely on your machine.

```sh
npx @atlasent/mcp-gate setup ~/my-gate -- node /absolute/path/to/server.mjs
```

That generates a `policy.json` of `{"version":1,"default":"deny","rules":[]}` and an
`mcp-client.json` entry to paste into your client. The first tool call your agent makes
comes back `Blocked by AtlaSent Gate: no_matching_rule`. **Start at
[One-command setup](#one-command-setup)** — no account or network needed.

The rest of this page, starting here, covers the optional cloud mode, which is the
less-proven half. Skip it unless you have a sandbox console already.

## Existing sandbox console setup

Console setup is live at `/integrations/mcp-gate`
(Integrations → Set up MCP Gate in your sandbox; shipped in atlasent-console #2345).
Use your existing sandbox console login and organization. Do not seed another
demo organization. The page derives its test-key destination from the authenticated
key bridge's readiness response and downloads secret-free connection and exact-call
policy files. Generating files does not establish a live connection.

For a repeatable live acceptance run, create a connection file with **both**
`read_status` and `set_status` mapped to existing sandbox action types/targets whose
published policies permit the demo. Set `ATLASENT_GATE_API_KEY` securely to a dedicated
test execution key with `evaluate:write` and `verify:execute`, then run this from a
checkout of this repository, in `packages/mcp-gate`. The `test/` directory is **not**
part of the published npm package, so this is not runnable from an `npx` install:

```sh
node test/live-sandbox.mjs /absolute/connection.json /absolute/new-acceptance-directory
```

This starts only the bundled in-memory demo server. It proves live-authorized reads,
a locally denied write leaving state unchanged, and a live-authorized write followed
by readback. It creates private activity and result files, never prints credentials
or tokens, and fails if required authorization does not succeed. It does not create
organizations, change runtime policy, mint keys, or approve requests.

Approval waiting additionally requires the canonical same-origin gateway and an
execution key with `approvals:read`. Current console self-service issuance does not
offer that scope; runtime tenant-binding acceptance remains tracked in API #2564.
Do not work around issuance restrictions with direct key-table writes. The generated
console configuration leaves waiting off and blocks holds. Full live acceptance
still needs runtime-deny, independent-review, replay and cross-tenant cases. The
runner's local automated test uses a simulated runtime and is not live proof.

Run a local MCP tool gate without an account, subscription, API key, or network service.
Local allow rules are operator configuration, **not AtlaSent organizational permits** —
see [the authority ladder](../../README.md#which-authority-decided) for what that means
and what it does not.

Published to npm as `@atlasent/mcp-gate`. Version 0.x: the local gate is exercised by 32
tests and is the supported path; the cloud mode in `cloud.mjs` is further along in code
than in live proof — approval waiting needs an `approvals:read` scope that console
self-service does not issue yet, so generated configurations ship with waiting off and
holds blocked.

## One-command setup

```sh
npx @atlasent/mcp-gate setup /absolute/new-gate-folder -- node /absolute/path/to/server.mjs
```

Or from a checkout of this repository, `node cli.mjs setup …` in this directory.

For other executables use their absolute path. Upstream arguments should use absolute
paths too, because MCP clients may launch from a different working directory.
Open `START-HERE.txt` in the generated folder. Review `policy.json` (all tool calls
start blocked), then copy the generated `atlasent-gate` entry from `mcp-client.json`
into your client's MCP configuration and restart the client. Existing configuration
is never overwritten. `run-dir` creates a unique private audit file on each restart.
This setup command does not install Node or the upstream server.

## Try it from a checkout

Requires Node 22 or later. No npm dependencies or installation required.

```sh
cd packages/mcp-gate
node cli.mjs init policy.json
node cli.mjs check policy.json
node --test test/*.node.mjs
```

Configure your MCP client's server entry (replace all paths with absolute paths):

```json
{
  "mcpServers": {
    "atlasent-demo": {
      "command": "node",
      "args": ["/checkout/packages/mcp-gate/cli.mjs", "run", "/checkout/packages/mcp-gate/policy.json", "/private/path/session-001.jsonl", "--", "node", "/checkout/packages/mcp-gate/demo-server.mjs"]
    }
  }
}
```

The manual `run` command below requires a **new audit filename on every launch**.
Prefer the setup-generated `run-dir` configuration for automatic session filenames.
Ask the client to call `read_status`, then `set_status` with
`{"environment":"production","status":"ready"}`: blocked.
Call `set_status` with `{"environment":"sandbox","status":"ready"}`: allowed.
Read status again to see the in-memory result. This demo changes no external system.

After the session, create and open the local activity viewer:

```sh
node cli.mjs report /private/path/session-001.jsonl activity.html
```

The viewer is an offline HTML snapshot, not a live dashboard. No HTTP listener, tracking,
remote scripts, or cloud upload. To use a real stdio server, replace the command after
`--` and explicitly author rules for that server's documented tools and arguments.
The operator chooses and trusts the upstream executable; shell expansion is disabled.

## Policy pack contract v1

Policies are JSON with `version: 1`, `default: "deny"`, and `rules`.
Every rule requires a unique `id`, exact `tool`, `effect` (`allow` or `deny`), and
`kind` (`read`, `write`, `delete`, or `export`). These classifications are supplied by
the operator, never inferred from server descriptions. An unmatched tool is unclassified
and blocked. Deny wins across matching rules. Unknown policy fields reject startup.
Optional `argumentsEquals` matches the **entire** argument object, ignoring object-key
order but including extra keys and array order. Omitting it allows any arguments for
that tool, so use this deliberately. Policy changes take effect on restart.
No arbitrary plugin code, wildcards, dynamic rule downloads, or approval tokens.
See [CONTRIBUTING.md](CONTRIBUTING.md) for a starter pack.

## Protection boundary

Only newline-delimited stdio, initialization, ping, tool listing/calls, and tool-list-change
notifications are exposed. Resources, prompts, sampling, elicitation, extension methods,
and server-initiated requests are not exposed. Client cancellation/progress notifications
are not forwarded in this first slice. Maximum frame: 1 MiB; pending calls: 128;
request timeout: 30 seconds. Invalid framing, duplicate pending IDs, transport errors,
audit errors and timeouts stop the gate. No automatic retries of writes.
An already-dispatched call may complete after disconnection: the gate records
`outcome_unknown`, never assumes rollback. The 16 MiB audit limit stops forwarding;
rotate by starting a new session with a new file.

Only metadata is captured: generated session/invocation IDs, local timestamp, policy rule,
classification and outcome. Arguments, results, raw error text, upstream stderr, unknown
tool names and client request IDs are omitted. Tool results still pass to the MCP client;
this is not a DLP filter or prompt-injection detector. Rule IDs are operator-controlled;
do not put secrets in policy identifiers. Audit files are private on creation (0600),
but are editable local logs, not tamper-proof evidence. Local timestamps are not a trusted clock.
`server_returned` explicitly means **not independently verified**.

The gate cannot constrain an agent that can edit its policy, launch the upstream directly,
or use the same credentials outside it. Separate policy/config ownership and credentials
before claiming enforced organizational protection. It does not sandbox the upstream
process or restrict its filesystem/network access. Only the direct subprocess is terminated;
upstreams that create detached descendants require an external supervisor/sandbox.

## Free / paid boundary and remaining delivery

Free local edition (part of the free AtlaSent Community plan; plans at
https://www.atlasent.io/pricing): tool visibility through MCP listing, explicit rules, blocking,
metadata evidence, offline viewer and versioned contributed policy packs.
Planned paid organizational management: enrolled gates, centrally owned policy,
independent approvals, retained evidence, alerts and fleet health. No pricing or billing
is activated here. Cloud policy and credential failure must never fall back to local allow.
Subscription changes must never silently weaken enforcement.

Before paid release: complete managed enrollment and live approval acceptance, and prove
two-gate isolation in staging. The connected execution-key adapter below implements
the evaluate/verify contract with local contract tests; it is not live acceptance. Other follow-ups: Streamable HTTP, live viewer,
interactive installer, broader external MCP compatibility, verification adapters, public distribution,
package signing/provenance and explicit extension review status. No GA claims.

## Reference acceptance (2026-09-16)

Verified with the official MCP SDK client and
`@modelcontextprotocol/server-filesystem@2026.8.31`. The test uses a temporary directory:
blocked content leaves the file unchanged, an exact permitted write changes the file,
readback confirms the contents, and an unmapped tool is denied. Payloads and paths do
not enter audit logs. This is independent test readback, not a runtime verifier feature.

Reproduce from a checkout of this repository, in `packages/mcp-gate`, using a separate
dependency installation (not Gate runtime dependencies). As above, `test/` is not part
of the published npm package:

```sh
npm install --prefix /absolute/reference-install --ignore-scripts @modelcontextprotocol/server-filesystem@2026.8.31
node test/reference-acceptance.mjs /absolute/reference-install/node_modules
```

CI repeats this on Node 22 (`ci.yml`'s `mcp-gate` job) and Node 24
(`mcp-gate-platform.yml`), and runs the unit suite on Windows for both. Unit tests
use `*.node.mjs` intentionally so the parent repository's Vitest runner does not try
to execute Node test suites.

## Connected authorization (experimental)

This mode adds fresh organizational evaluate/verify calls to every locally allowed tool
call. It is a **manual execution-key connection**, not managed enrollment, an approval
inbox, or a billing integration. Local deny still wins. A cloud deny, hold, escalation,
error or invalid permit never falls back to local allow. No cloud decision is cached.

Copy `connection.example.json` and replace the runtime URL, registered actor, and tool
mappings with values approved for your organization. All three ship as explicit
placeholders and `validateConnection` refuses each one, so the example cannot be
connected unedited. The API base must be HTTPS and must be the base exposing
`v1-evaluate` and `v1-verify-permit`. Review the destination before providing a key.
The key's server-side scope determines the organization; a caller-supplied organization
ID is never used to select another tenant.

**There is no shipped default action type, and the example does not name a real one.**
An `actionType` must be a class your organization has provisioned.
`action_classes.requires_verified_actor` defaults to **`true`** (its
`requires_human_approval` / `requires_independent_approval` siblings default to `false`
— the asymmetry is deliberate for a security product). Connected mode therefore mints a
fresh runtime-signed `actor_identity.v1` for every invocation through
`/v1-agent-actor-identity` and supplies it to `v1-evaluate`. There is no identity cache.
A mint failure, unsupported endpoint, malformed assertion, wrong principal, wrong action,
or wrong environment blocks the call before evaluation.

The execution key must be bound server-side to a registered agent, and `actorId` must be
that runtime principal in `agent:<uuid>` form. The key and actor must refer to the same
agent; the Gate never invents or self-asserts that binding. Production use remains gated
by the runtime's own classification/promotion and live acceptance of the agent-identity
endpoint; source support in this package is not evidence that a given production runtime
has enabled it.

```sh
npx @atlasent/mcp-gate check-connection connection.json
npx @atlasent/mcp-gate setup-connected /absolute/new-connected-folder connection.json -- node /absolute/path/server.mjs
```

Or from a checkout of this repository, `node cli.mjs check-connection …` in this directory.
`check-connection` validates the file's shape only — it performs no network call and
proves nothing about whether the mapped action types exist or would authorize.

Review the generated `policy.json` and add the explicit local tool rules you need.
Copy the generated MCP client entry. Supply **ATLASENT_GATE_API_KEY** to the Gate
process through your client's secret configuration: an `ask_test_*` key for sandbox,
an `ask_live_*` key for production. Never use a Supabase service-role key or a management
credential. This variable is removed from the upstream subprocess environment; that
is hygiene, not process isolation against a malicious server running as the same OS user.
The generated JSON contains no API key. Changing mappings requires a restart.

The configured `actorId` is not trusted by itself. Gate first asks the runtime to mint
the registered agent's signed `actor_identity.v1`, then verifies that the returned
assertion is for the exact configured principal, mapped action, and environment before it
will call `v1-evaluate`. `gateId` remains local attribution bound into the execution
digest, not a registered device identity. Backend action setup, entitlements, independent
approval requirements and actor restrictions still apply. Setup does not modify any of
them.

For approval-required actions, a held call is not released with the identity from the
initial evaluation. Once the approval reaches `approved_awaiting_claim`, Gate requires the
runtime's `claim_environment`, mints a **fresh** assertion for the same actor/action/
environment, and sends that assertion to `claim-permit`. A legacy `approved` row, missing
claim environment, changed environment, or failed identity mint blocks rather than
falling back.

Requests send mapped action, target, actor, environment, a fresh request UUID, and a
SHA-256 digest covering the entire invocation including exact arguments. Raw arguments
and results remain local. Cloud policies cannot inspect fields we do not send; this
slice uses local exact-argument restrictions and cloud action/target controls. Mapping a
tool to an unrelated action does not provide meaningful protection: review the semantic
mapping and protect the config from the agent. Some actions require additional context
or server-derived digests; these remain blocked until a dedicated adapter is built.

Cloud allow requires a real permit, explicit acceptance and matching echo of our digest,
non-shadow evaluation, satisfied approval if required, and verification returning
`valid: true`, `outcome: allow`, `consumed: true`, and an unexpired `expires_at`.
The verifier, not Gate, checks signature, revocation and replay. Verification consumes
before dispatch; a later crash can leave a consumed permit without execution. Never
retry a write automatically. Expiry is checked against the local clock as an additional
check; the server owns authoritative expiry enforcement. Raw cloud errors and tokens
are never returned to the MCP client or written to local activity logs.

By default a `cloud_hold` result returns without execution. Optional approval waiting
below resumes the original invocation through the existing canonical approval route.
Reissuing a separate call still creates a fresh request, not a continuation.
Cloud transport has a 10-second bound per request, rejects redirects and caps responses
at 1 MiB. Disconnect during authorization prevents dispatch. The local report still does
not independently verify the side effect.

Validation: local contract tests cover deny/hold, required permit binding, consumption,
expiry/replay-denial responses, response corruption, changed arguments, disconnects,
credential non-inheritance and fresh decisions across two Gate instances. The latter
uses a simulated central service, not a live sandbox. Live tenant isolation, two-gate
sandbox proof and live end-to-end approval acceptance remain release gates in issue #76.
API contract source: `atlasent-api` commit `a76beb0b240349488133e311893da8be89fe3c63`,
`supabase/functions/v1-evaluate/handler.ts` and `v1-verify-permit/handler.ts`.

## Wait for an existing approval (opt-in)

Add these fields to the connection configuration to keep a held call pending:

```json
{
  "approvalWaitMs": 120000,
  "approvalsUrl": "https://YOUR-APPROVED-RUNTIME/v1/approvals"
}
```

`approvalsUrl` must use the same origin as `apiUrl`, with the canonical
`/v1/approvals` path. The configured gateway must actually expose that route;
a bare Supabase function URL is not assumed to provide this gateway route.
The originating execution key also needs `approvals:read`. Gate does not obtain
`approvals:write`, resolve requests, or assign reviewers. Existing runtime policy
creates/routes the approval; the authorized reviewer uses the existing console.

Sequence: evaluate returns hold/escalate plus an approval UUID → record
`awaiting_approval` → poll status every two seconds → require
`approved_awaiting_claim` plus the exact `claim_environment` → mint a fresh
`actor_identity.v1` for the original actor/action/environment → claim the permit once
with the originating key and that assertion → require a fresh allow reevaluation → verify
and consume it against the **original** digest/actor/action/target/environment → dispatch.
No second caller-initiated evaluate, changed payload, or token from a status GET is used.
Denial, withdrawal, expiry, legacy approval state, missing claim environment, failed
identity mint, missing claim, HTTP failure or timeout blocks. Polling never calls
`resolve` or the retired approval queue/service. The local report shows the approval
UUID, never a permit token or approval bearer link.

The wait budget is 1–120000 ms (zero/unset disables waiting); each network request
is also bounded. The client must keep its connection open long enough. Disconnect
aborts pending polling/requests and prevents dispatch. Verification after a successful
claim can take up to the normal 10-second request budget. No automatic restart/resume
across processes is implemented. A lost claim response is not retried: one-time claim
semantics take precedence over availability. Signed permits that do not bind to the
original execution digest remain blocked by the runtime verifier.

Tests use the canonical response shapes inspected in `v1-approvals/handler.ts` and
the existing `atlasent-action` polling client. They are contract tests, not proof of a
live approval journey. Before public release, verify this with an actual sandbox
organization, original execution key, independently authorized reviewer and two gates.
