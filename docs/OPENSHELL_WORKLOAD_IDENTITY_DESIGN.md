# OpenShell workload identity the agent cannot set (design)

Status: **BUILT, 2026-10-06. The founder decided to build both phases.**
- Phase 1: `packages/openshell-workload-guard`. Live-tested on OpenShell
  0.1.3-pre.4; see "Verification results".
- Phase 2: atlasent-api#4032, migration `20261551000000`. Not yet applied to
  any environment.
- Decision record: atlasent-docs CROSS-066.

## Problem

`atlasent-openshell` reads the sandbox ID from `OPENSHELL_SANDBOX_ID` in its
own environment (see `OPENSHELL_AUTHORITY_ADAPTER.md`, "Remaining limit"). The
agent controls the environment of every process it starts, so it can run the
executable with another sandbox's ID. Runtime #4010 binds a permit to
whatever workload ID evaluate was given, so a forged ID at evaluate gets a
permit bound to the forged ID. The binding stops reuse across sandboxes. It
does not prove which sandbox asked.

No fix inside the sandbox works. Anything the executable can read, the agent
can read or replace, including files, sockets it can open, and arguments.

## What OpenShell already provides

These facts come from OpenShell 0.1.3-pre.4's docs and protocol
(`docs/extensibility/overview.mdx`,
`docs/extensibility/supervisor-middleware/*.mdx`,
`proto/supervisor_middleware.proto`):

1. **Supervisor middleware** runs in the supervisor, outside the sandbox. An
   operator registers it in the gateway config (`[[openshell.supervisor.middleware]]`)
   and attaches it to endpoints in the sandbox policy. Registration is static
   and needs a gateway restart to change.
2. The `HttpRequest/pre_credentials` binding sees each policy-allowed request
   **before provider credentials are injected**. It can allow it, deny it,
   replace the body (within the payload limit) and change headers. It can't
   see or set credential headers.
3. Each call carries `RequestContext{request_id, sandbox_id, sandbox, workspace}`
   from the supervisor.
4. With `gateway_jwt` configured, each call also carries a short-lived Ed25519
   JWT signed by the gateway: `caller_kind = "supervisor"`, `sandbox_id` = the
   calling sandbox, and an operator-set audience. The keys are published at
   `/.well-known/jwks.json`.
5. Failure is fail-closed by default (`on_error = "fail_closed"`). A denial
   always blocks, even under `enforcement: audit`. Middleware can't attach to a
   `tls: skip` endpoint.
6. The workload holds only a placeholder for the AtlaSent key. OpenShell
   substitutes the real key after middleware has run. This was confirmed live
   on 2026-10-06: a request with no `Authorization` header reached the endpoint
   with no credential.

Facts 2, 4 and 6 together are the basis. The real AtlaSent key goes only on
requests that passed the middleware. The middleware learns the sandbox ID from
a gateway signature, not from the agent.

## Design

### Phase 1: an AtlaSent middleware service (no runtime change)

A small gRPC service, `atlasent-workload-guard`, that the operator runs next
to the gateway and registers like this:

```toml
[[openshell.supervisor.middleware]]
name = "atlasent-workload-guard"
grpc_endpoint = "https://host.openshell.internal:50061"
audience = "urn:atlasent:openshell:workload-guard"
max_payload_bytes = 262144
timeout = "500ms"
```

It is attached by policy to the AtlaSent API endpoint only, with
`on_error = "fail_closed"`. For every request it does the following:

1. **Verifies the caller.** It checks the JWT signature against the gateway's
   JWKS (pinned at startup, never fetched from a URL a request names), plus
   `iss`, `aud` and expiry, and requires `caller_kind == "supervisor"`. It
   requires `RequestContext.sandbox_id == jwt.sandbox_id`. Any failure denies.
2. **Requires the workload in the body.** By path:
   - `POST .../v1-evaluate`: the body's `context.workload` must be
     `{kind: "openshell_sandbox", id: <jwt.sandbox_id>}`. A missing or
     different value denies with `workload_mismatch`. It never rewrites the
     value: a silent fix would hide a forging agent, and a denial is the
     evidence.
   - `POST .../v1-verify-permit`: the same check on the top-level `workload`.
   - The approval GET and claim, the change-brief and circuit-trip paths: no
     workload rule. They mint nothing that a forged ID could use, and the
     permit's workload is checked again at verify.
   - Any other path the profile allows: deny. The guard knows its paths
     exactly, the same way the provider profile does.
3. **Labels for display only.** It may check that `sandbox_name` and
   `workspace` in the body match `RequestContext`. A mismatch is logged, not
   denied, because they are labels (adapter contract §1).
4. **Bounds the body.** A body that is not JSON, is over the limit, or has a
   duplicate `workload` key is denied, never passed through.

What phase 1 proves: a request that reaches AtlaSent carrying this
deployment's key named the sandbox OpenShell says sent it. It relies on one
operational condition, and the runtime should know about it:

- **The key must be dedicated.** It goes only to this OpenShell provider, has
  only `evaluate:write` and `verify:execute`, and is never put in a sandbox,
  CI or a laptop. A copy of the key outside OpenShell skips the guard
  entirely.

Phase 1 needs no AtlaSent runtime change and no change to the wire shape.
#4010's binding stays as it is.

### Phase 2: the runtime checks that the guard ran (needs sign-off)

Phase 1 leaves the runtime trusting topology: "this key only ever travels
through the guard." Phase 2 makes that a check.

- The guard signs a short attestation on every allowed evaluate or verify,
  bound to the exact request:
  `{v: 1, aud: "atlasent-runtime", jti, sandbox_id, osh_request_id, method, path, body_sha256, iat, exp = iat + 60}`,
  as a compact EdDSA JWS with `typ: atlasent-workload-attestation+jwt` and a `kid`.
  It is sent as one request header, `x-atlasent-workload-attestation`.
  Middleware may add headers but not credential ones, so this header is
  allowed.
- The org registers the guard's public key (Ed25519, with a `kid`) with
  AtlaSent, and marks the API key `requires_workload_attestation`.
- For such a key, `v1-evaluate` and `v1-verify-permit` require a valid
  attestation. The `sandbox_id` in it must equal the body's workload ID, the
  `body_sha256` must equal the bytes received, the `path` must name the
  endpoint, and the `jti` must not have been used before
  (`reserve_workload_attestation_v1`). As built, a fresh `jti` is the replay
  key. OpenShell's request ID travels as `osh_request_id`, for correlation
  only.
  A missing or invalid attestation denies.
- Keys without the flag behave as today. The change is additive, so `/v1` is
  untouched.

What phase 2 adds: a leaked copy of the key can't evaluate or verify for an
OpenShell sandbox without the guard's signing key. The trust root moves from
"nobody copied the key" to "nobody has the guard key", and the guard key never
leaves the guard host.

### Rejected alternatives

- **Have the runtime verify OpenShell's gateway JWT directly** (the guard
  forwards it). Its audience is the middleware, so the runtime would accept a
  token minted for another party. It is also not bound to the request body, so
  a token captured within its lifetime could cover a different evaluate.
- **Have the guard rewrite the workload to the verified ID.** That fails
  silently. A forging agent would get a correctly bound permit and leave no
  trace. Denying is fail-closed and produces evidence.
- **Read identity from inside the sandbox** (a file, a socket, a nonce from
  the supervisor). The agent can read anything the executable can.

## Fit with what exists

- `atlasent-openshell` is unchanged. It still sends `context.workload` from
  `OPENSHELL_SANDBOX_ID`. Under the guard, a wrong ID is denied before it
  reaches AtlaSent rather than accepted.
- `examples/openshell/atlasent-provider.yaml` is unchanged. The guard is a
  policy attachment on the same endpoint.
- Policy Advisor approvals still never count (adapter contract §2). The guard
  checks identity, not approvals.
- The policy-generation behaviour still applies: a generation change between
  evaluate and verify re-evaluates (adapter contract §3).

## Open questions

1. *(Decided 2026-10-06: both phases. CROSS-066.)*
2. *(Built in this repo as a Node gRPC service, `packages/openshell-workload-guard`.
   Not published to npm.)*
3. Whether `requires_workload_attestation` should later become required for
   every key used with `kind: "openshell_sandbox"`. That is stricter, but it
   breaks a deployment that runs the adapter without the guard.

## Verification plan (once built)

The guard is a control, so its tests must show it fails on the defect it
targets:

- A forged `OPENSHELL_SANDBOX_ID` in a real sandbox makes evaluate return
  `middleware_denied / workload_mismatch`, and the AtlaSent stub receives
  nothing.
- The honest ID passes, and the stub sees the injected key.
- A JWT for another sandbox, an expired JWT, a wrong audience, and a JWT with
  a mismatched `RequestContext` are each denied.
- Guard down: OpenShell returns `middleware_failed` and nothing reaches
  AtlaSent.
- Phase 2: the attestation is replayed, has the wrong body hash, is expired, or
  is signed by the wrong key. Each is denied by the runtime, with a positive
  control for each.

## Verification results (2026-10-06)

Run on OpenShell 0.1.3-pre.4 with the Docker driver and an mTLS gateway with
`gateway_jwt`. The guard was registered over HTTPS and attached by policy to a
local stub of the AtlaSent API.

| Check | Result |
|---|---|
| Gateway negotiation | Protocol 1.0. The guard's audience was accepted (`openshell gateway info`) |
| Forged `context.workload.id` | `403 middleware_denied / workload_mismatch`. The stub received nothing |
| No workload | `403 middleware_denied / workload_missing` |
| Honest request | Reached the stub with the real key substituted and the attestation attached. The signature verified, and `body_sha256` equalled the bytes the stub received |
| Agent sets its own attestation header | Overwritten by the guard's |
| Guard stopped | `middleware_failed`. The stub received nothing |
| Node-signed attestation in the Deno runtime verifier | Verifies |

Tests:

- Guard: 18 unit and gRPC tests. Mutations were killed: removing the
  sandbox-ID comparison fails 3 tests, and skipping the signature check fails
  2.
- Runtime verifier: 8 tests, with a refusal code for each defect.
- `v1-evaluate`: 7 tests. Hard-wiring the flag to false fails the 6
  flagged-key tests.
- `v1-verify-permit`: 4 tests.

Found along the way:

- **Docker driver.** It does not put `OPENSHELL_SANDBOX_ID` in the workload's
  environment, so `atlasent-openshell` needs an operator-supplied context file
  there. The guard checks whatever ID is sent, so this is a usability gap, not
  a hole.

  **Addressed 2026-10-10, opt-in, not yet run live.** The guard takes
  `fill_absent_workload: true`. When the evaluate or verify body has no
  workload at all, the guard adds `{kind: "openshell_sandbox", id: <verified
  sandbox_id>}` and returns the new body (`has_body`). The attestation signs
  that new body. Rules:
  - The guard splices into the original bytes instead of re-serializing,
    which would lose precision on large numbers and move keys and escapes.
    The result is re-checked through the strict path, so a splice bug denies.
  - A workload that is present is never rewritten: forged, null, the wrong
    kind or not an object still denies.
  - A `context` that is not an object denies.
  - Transport, destination and duplicate-key checks run first.

  On the adapter side, `ATLASENT_OPENSHELL_WORKLOAD_BINDING=guard` sends no
  workload when it has no ID (`OPENSHELL_AUTHORITY_ADAPTER.md` §1).
- **`--policy` replaces the whole policy.** A sandbox created with `--policy`
  gets that policy instead of the default one. A middleware-only policy file
  left the workload unable to start (`Permission denied`), so keep the
  default `filesystem_policy` and `landlock` sections.

