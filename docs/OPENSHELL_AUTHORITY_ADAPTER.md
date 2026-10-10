# NVIDIA OpenShell × AtlaSent

Status: experimental integration surface. OpenShell controls reachability;
AtlaSent controls organizational authority and effect proof.

## Boundary

OpenShell owns sandbox isolation, network/process policy and credential
injection. AtlaSent owns organizational authorization for consequential
actions: DENY, HOLD/approval, bounded permits and post-execution evidence.

Do not broaden an OpenShell network rule merely because AtlaSent authorized an
action. The intended sequence is:

1. Agent proposes a consequential action.
2. The AtlaSent adapter canonicalizes actor, action, target, revision and
   intended effect and calls AtlaSent evaluation.
3. DENY stops. HOLD waits for the existing AtlaSent approval flow. ALLOW
   returns a bounded permit.
4. The executor presents and consumes/verifies that permit immediately before
   the external effect.
5. AtlaSent independently establishes the effect where a provider profile
   exists.

OpenShell's default-deny network policy remains a separate enforcement
boundary. AtlaSent authorization never means "give the sandbox general
network access."

## Providers v2

`atlasent-provider.yaml` is a custom OpenShell provider profile. It keeps the
AtlaSent API key in OpenShell's provider credential boundary and grants only
the AtlaSent authority endpoints to the adapter binary.

This is intentionally not a profile for Salesforce, AWS, GitHub or another
effect provider. Those credentials remain separately scoped. The agent should
not receive an AtlaSent credential value directly.

## Adapter contract (`src/openshell.ts`, 2026-10-05)

The adapter contract and the `atlasent-openshell` executable are implemented
and unit-tested. Rules, each pinned by a test in
`src/openshell.test.ts`:

### 1. Identity binds to `sandbox_id`

OpenShell supervisor middleware runs after OpenShell network policy allows a
request and before provider credentials are injected. Its `RequestContext`
(`proto/supervisor_middleware.proto`) carries `request_id`, `sandbox_id`,
`originating_process`, `sandbox` (the name) and `workspace`. NVIDIA's docs
(`docs/extensibility/supervisor-middleware/operations.mdx`, checked against
source at 71c3cd9 on 2026-10-05) say to use `sandbox_id` "for authorization,
persistence, and correlation" and names "only for display and logging". The
adapter accepts that shape directly: `sandbox` and `sandbox_name` are both read
as the display name.

- The adapter refuses a request with a missing, blank or malformed
  `sandbox_id`. It never derives one from `sandbox_name` or `workspace`.
- It sends `context.workload = { kind: "openshell_sandbox", id: <sandbox_id>,
  labels: { sandbox_name, workspace } }` to `/v1-evaluate`. The decision record
  names the exact sandbox. For `agent.*` actions the sealed action hash covers
  it too. Labels are evidence for the approval UI, never authority.
- At the execution boundary, a permit or HOLD presented from a different
  `sandbox_id` is refused, even when the name matches.
- The runtime enforces it too (atlasent-api `v1-verify-permit`, 2026-10-05).
  A permit evaluated with `context.workload` must be verified by presenting the
  same `kind` + `id`. That is required-if-bound: presenting nothing is a
  `PERMIT_BINDING_MISMATCH`. `verifyRemote` sends `{ kind, id }`, never the
  labels.
- **Where the ID comes from.** OpenShell's Kubernetes, Podman and VM compute
  drivers set `OPENSHELL_SANDBOX_ID` on the supervisor. It is reserved, so a
  sandbox spec, template or exec request cannot override it (checked against
  NVIDIA/OpenShell@71c3cd9).

  **Corrected 2026-10-06: the Docker driver does not give it to the workload.**
  Earlier text here said workload processes always inherit it. A live check on
  0.1.3-pre.4 (Docker driver) found only `OPENSHELL_SANDBOX=1` in the
  workload's environment, both in the initial command and under
  `sandbox exec`. Inheritance on the other drivers has not been checked live.

  `atlasent-openshell` reads `OPENSHELL_SANDBOX_ID`, or a JSON file named by
  `ATLASENT_OPENSHELL_SANDBOX_CONTEXT_FILE` (re-read before evaluate and again
  before verify). When neither is present it refuses, never guessing. On the
  Docker driver an operator has to supply the context file, or use
  guard-bound mode (below).
- **Guard-bound mode (opt-in, added 2026-10-10; not yet run live).** With
  `ATLASENT_OPENSHELL_WORKLOAD_BINDING=guard`, a context with no `sandbox_id`
  is accepted. The adapter then sends evaluate and verify with **no**
  `context.workload` (never a label, never a placeholder). The AtlaSent
  workload guard, registered with `fill_absent_workload: true`, adds the
  gateway-verified sandbox ID to each request. This amends the rule above:
  in this mode the adapter does not know the ID, so the guard and the runtime
  bind the permit to the sandbox, not the adapter. What still holds:
  - a real `sandbox_id`, if one is present, is used and checked as usual;
  - a permit evaluated guard-bound does not verify under a real ID, or the
    other way round;
  - a malformed ID, a missing or unreadable context, and a policy-generation
    change are refused exactly as in the default mode;
  - an unknown mode value is a usage error, never read as the default.

  **It needs** the guard registered for the AtlaSent endpoints with
  `fill_absent_workload: true`, **and** an API key that requires workload
  attestation (atlasent-api#4032). The adapter enforces this. In guard-bound
  mode it accepts an allow or a hold only when the runtime's evaluate response
  carries `workload_attested: true`. The runtime sends that only when the
  guard's attestation verified against the exact bytes it received. A missing
  field means the guard did not run or the key does not require attestation,
  and in either case the permit would be bound to no sandbox. So the adapter
  denies, and it records no permit and no HOLD. A real `sandbox_id` and the
  default mode do not need the field. Local mode never attests, so guard-bound
  mode always denies there. The runtime field is additive and was added in
  atlasent-api (`v1-evaluate`, branch
  `claude/openshell-security-regressions-nl26aa`). Until that change is
  deployed, guard-bound mode denies everything, which is the fail-closed
  default.
- **What OpenShell does not give the workload.** `OPENSHELL_SANDBOX` is
  overwritten with `"1"` inside a workload as an "inside a sandbox" marker, so
  it is never the name there and the adapter never reads it. OpenShell provides
  no sandbox name, workspace or policy generation to the workload.
  `OPENSHELL_SANDBOX_NAME`, `OPENSHELL_WORKSPACE` and
  `OPENSHELL_POLICY_GENERATION` are optional values an operator may set. They
  are display labels and change detection only, never authority.
- **The agent can still lie to its own child process. The workload guard closes that.**
  A process inside the sandbox can launch `atlasent-openshell` with a
  different sandbox ID, and on its own the runtime's check
  (atlasent-api#4010) cannot tell. The workload guard
  (`packages/openshell-workload-guard`, CROSS-066) closes this. It runs as
  OpenShell supervisor middleware, outside the agent's control, before the
  AtlaSent key is injected. It reads the sandbox from OpenShell's
  gateway-signed token and denies any evaluate or verify naming another
  sandbox. For keys flagged `requires_workload_attestation`, the runtime also
  requires the guard's signed attestation (atlasent-api#4032). Without the
  guard, the binding only stops a permit moving between well-behaved
  processes.

### 2. OpenShell approvals never satisfy an AtlaSent HOLD

An OpenShell Policy Advisor approval means "this sandbox may reach this
resource". An AtlaSent approval means "this exact action, target, revision and
effect is organizationally authorized". These are separate approval systems.

- The canonical envelope is strict. An envelope carrying `approvals`,
  `policy_advisor_approval`, `openshell_approval`, `proposal_id` or a similar
  field is refused, and the evaluator is never called.
- The adapter never populates `context.approvals`.
- A HOLD resolves only through the AtlaSent approval wait (`awaitApproval`).

### 3. A policy-generation change forces a fresh evaluation

A HOLD or unconsumed permit obtained under one OpenShell policy generation is
not carried across a change. `resolveHold` re-evaluates instead of claiming,
and `verifyBeforeExecute` returns `reevaluate: true`. If a generation is known
on only one side, the adapter treats it as changed. A spurious bump costs one
extra evaluation (possibly a new HOLD), never an inherited allow.

### 4. OpenShell 0.1.2 is not acceptance evidence

In 0.1.2 (NVIDIA/OpenShell#3994), the startup provider-env revision is seeded
from the local snapshot rather than the server value. As a result, the first
settings poll (about 10s after startup) reports a spurious change, advances the
policy generation and drops in-flight requests ("Remote end closed connection
without response"). The fix is NVIDIA/OpenShell#4122 (`ec49209`, merged
2026-10-02). v0.1.3-pre.4 (`e7fdd6be`, 2026-10-05) is the first release that
contains it, confirmed by commit ancestry. The latest stable release is still
v0.1.2. `assessOpenShellVersion` marks 0.1.2 and 0.1.3-pre.1 through pre.3
`known_affected`. It marks pre.4 `probe_passed`, because of the recorded pass
below. Every other version is `unverified`. A version string never makes the
path production-ready. Only a recorded pass of the live probe does:

```
OPENSHELL_VERSION=<x.y.z> \
OPENSHELL_ACCEPTANCE_START_CMD='<start the sandbox>' \
OPENSHELL_ACCEPTANCE_PROBE_CMD='<one AtlaSent-governed request through it>' \
npm run test:openshell-acceptance
```

The probe sends a request every 500 ms for the first 20 s after start. It
fails on any dropped, denied or errored request. On a known-affected version it
fails even when every request passes.

### Recorded run, 2026-10-06

Setup, the same for both versions:

- Gateway image `ghcr.io/nvidia/openshell/gateway:<version>` in mTLS mode,
  with the Docker compute driver and the matching supervisor binary.
- Sandbox from `curlimages/curl:latest`, with a provider built from a test
  profile shaped like `examples/openshell/atlasent-provider.yaml`: a bearer
  credential with `header_name: authorization`, and a REST endpoint
  `host.openshell.internal:18080` that allows `POST
  /functions/v1/v1-evaluate`.
- That endpoint was a local stub that holds each request for 2 s and logs
  whether the real credential replaced the sandbox's placeholder.
- The probe command was `openshell sandbox exec` running `curl --fail` with
  `Authorization: Bearer $ATLASENT_API_KEY`.

| OpenShell | Result |
|---|---|
| 0.1.2 (positive control) | **Failed.** A request at 8.3 s got `curl: (52) Empty reply from server`. The supervisor logged `provider_env_changed:true` with an unchanged revision, then `policy generation is stale [captured_generation:1 current_generation:2]` for each in-flight request. A separate 50-request shell probe lost 4 requests the same way. |
| 0.1.3-pre.4 | **Passed 3 of 3 runs.** Every request was answered (8 per run). The stub saw the real credential on every request. The supervisor logged no provider-env change and no stale generation. A separate 50-request shell probe got 50 of 50. |

What the run does not cover:

- other compute drivers (Kubernetes, Podman, VM);
- the real AtlaSent API over TLS, as opposed to the plain-HTTP stub;
- OpenShell releases after pre.4.

Re-run the probe for each of these before relying on it.

Two things the run surfaced:

- The first version of the example profile failed `openshell profile lint` on
  pre.4 (`category: security` is not accepted; a bearer credential needs
  `header_name`). Both are fixed and checked in the unit suite.
- The workload has to send the placeholder itself. OpenShell replaces
  `Bearer <placeholder>` with the real key; it does not add the header. A
  probe that sends no `Authorization` header passes without exercising
  credential injection, which is the path #3994 sits on.

## `atlasent-openshell` executable

```
atlasent-openshell run --envelope <file|-> [--wait-ms N] [--timeout-ms N] \
                       [--breaker-state <file>] -- <command> [args...]
atlasent-openshell check [--version <openshell-version>]
```

`run` does evaluate, then an optional HOLD wait, then verify (which consumes
the permit), then runs the command exactly once, all in one process. One
process on purpose: a split evaluate-now, verify-later CLI would need the permit
state on disk, where the agent could edit it.

- One JSON result line goes to stderr; stdout belongs to the command.
- Exit codes: the command's own code when it ran; 77 DENY; 75 HOLD unresolved;
  125 outcome unknown; 126 command not started; 64 usage; 70 internal.
- A policy-generation change between evaluate and verify re-evaluates, at most
  twice, then gives up as DENY.
- **Circuit trips.** A command killed by a signal or by `--timeout-ms` ran with
  a spent permit and an unknown outcome. That is CROSS-064 condition **E2**:
  - the local breaker trips (`--breaker-state`, persisted, reset only by a
    person);
  - the trip is reported to `/v1-agent-circuit-trips`, after which the runtime
    refuses that agent's permits until a person resets it.

  A command that exits non-zero has a known outcome and is not a trip.

`check` prints the resolved sandbox context and the OpenShell version
assessment.

`examples/openshell/atlasent-provider.yaml` allows exactly the endpoints this
binary calls. That includes the approval GET poll the HOLD wait needs, which
the first version of the profile was missing.

### Re-running against the real API (staging)

The 2026-10-06 run used a plain-HTTP stub. This run covers what the stub did
not: TLS through OpenShell's proxy to the real AtlaSent host, and credential
injection that the runtime itself accepts. It needs a machine whose sandboxes
can reach the AtlaSent staging host, and a **staging** test key with
`evaluate:write`.

1. Copy `examples/openshell/atlasent-provider.yaml` and change the endpoint
   `host` to the staging host from your `ATLASENT_BASE_URL` (port 443). Give
   it a new `id`, such as `atlasent-staging`. Lint and import it, then create
   the provider from the key:

   ```
   openshell profile lint -f atlasent-staging.yaml
   openshell profile import -f atlasent-staging.yaml
   ATLASENT_API_KEY=ask_test_... openshell provider create \
     --name atlasent-staging --type atlasent-staging --credential ATLASENT_API_KEY
   ```

2. Save two scripts and run the probe. Success means the request
   reached the runtime and the runtime accepted the injected key. Any answer
   other than 401 counts, because this tests transport and injection, not the
   decision. A 401 means the key was not injected. Replace
   `<staging-host>` with the host from step 1.

   `start.sh`:

   ```sh
   openshell sandbox delete acc >/dev/null 2>&1
   openshell sandbox create --name acc --from curlimages/curl:latest \
     --provider atlasent-staging --no-auto-providers --no-tty --detach -- sleep 600 >/dev/null
   until openshell sandbox exec --name acc -- true >/dev/null 2>&1; do sleep 0.5; done
   ```

   `probe.sh`:

   ```sh
   code=$(openshell sandbox exec --name acc -- sh -c '
     curl -sS -o /dev/null -w "%{http_code}" -X POST \
       -H "authorization: Bearer $ATLASENT_API_KEY" -H "content-type: application/json" \
       -d "{\"action_type\":\"agent.tool.invoke\",\"actor_id\":\"openshell-probe\",\"context\":{}}" \
       https://<staging-host>/functions/v1/v1-evaluate')
   echo "http=$code"
   # 401 = key not injected; 000 = connection dropped or refused.
   [ "$code" != "401" ] && [ "$code" != "000" ] && [ -n "$code" ]
   ```

   ```
   OPENSHELL_VERSION=0.1.3-pre.4 \
   OPENSHELL_ACCEPTANCE_START_CMD="sh start.sh" \
   OPENSHELL_ACCEPTANCE_PROBE_CMD="sh probe.sh" \
   npm run test:openshell-acceptance
   ```

3. Record the result (version, driver, number of passing runs) in "Recorded
   run" above, and in `OPENSHELL_PROBE_PASSED` in `src/openshell.ts` if it
   widens what that entry claims.

## Upstream security regressions (2026-10-10)

Two open OpenShell pull requests bear on AtlaSent's guarantees. Neither is in
a release. `assessOpenShellVersion` reports both on every version as
`advisories` (`OPENSHELL_OPEN_ADVISORIES` in `src/openshell.ts`) without
changing qualification status: qualification of v0.1.3 continues.

**NVIDIA/OpenShell#4359, streaming middleware: not adopted.** The revised
interface (`EvaluateHttpRequestSession` / `EvaluateHttpResponseSession`,
selected by listing `openshell.supervisor-middleware.http-session` in
`required_capabilities`) had three blocking findings in review of head
`7f09efe`: a response, and a request upload, could complete before the
terminal verdict (fixed `c2684e8`); responses could be written after policy
revocation (fixed `0a492e2`, generation checked before every write); and
body-stage `Begin` events lacked preflight header mutations (fixed
`a491a29`). The follow-up review cleared them but was static only. As of
2026-10-10 the E2E jobs still need a maintainer re-run and the PR has no
approving review. Checked against the PR page on 2026-10-10. A DENY or HOLD is
worthless if the bytes already reached the destination, so AtlaSent pins the
same three properties at its own boundary, in
`src/openshell.securityRegressions.test.ts`:

- A. Nothing runs before the final verdict. Evaluate ALLOW is not final;
  verify is. A pending, hung, throwing or invalid verify, and a HOLD still
  waiting or rejected, run nothing. An approved HOLD is still verified.
- B. Revocation stops delivery: a runtime revocation at verify, a policy
  generation change between evaluate and verify (including during the HOLD
  wait), and a consumed or dropped permit.
- C. The verify-side binding is complete: sandbox, action, target and the
  runtime-bound payload hash. A dropped envelope field or sandbox id fails
  before the runtime is called.

The workload guard declares only the buffered HTTP request binding and refuses
a gateway that requires any capability it does not implement, such as a
streaming session (`packages/openshell-workload-guard/test/guard.node.mjs`).
Keep any streaming adapter experimental until NVIDIA completes release
qualification.

The same PR marks the v1 hook RPCs deprecated, with removal planned for
OpenShell 0.2.0. The guard is built on v1 `EvaluateHttpRequest`, so it will
stop working on 0.2.0 unless it is ported to the session interface first.

**NVIDIA/OpenShell#4397, request transport identity.** Plaintext HTTP in a
tunnel reaches middleware as `https`, and plaintext WebSocket as `wss`: the
scheme was hardcoded rather than derived from the transport (issue #4253).
The PR (commit `335066c`, opened 2026-10-10) is unreviewed and has not run on
NVIDIA CI. The guard now
requires a pinned `destination` (host, port default 443) and denies a reported
`http`, `ws` or `wss`, any other scheme, a host or port other than the pinned
one, and any scheme, host or port OpenShell left empty. `atlasent-openshell
run` refuses a plaintext `ATLASENT_BASE_URL` unless it is loopback, before any
call. **Limit:** neither can see through a mislabelled `https`. Until a release
confirmed to carry the #4397 fix is recorded here, a reported `https` is
necessary, not sufficient.

**Measuring the fix: the live transport-identity probe.** Whether a given
OpenShell release has the #4397 fix is measured, not read from a changelog:

```
OPENSHELL_VERSION=<x.y.z> \
OPENSHELL_TRANSPORT_PROBE_CMD='<sh; $1 is tls | plaintext_tunnel>' \
npm run test:openshell-transport-acceptance
```

The command sends one request through the sandbox per case. `tls` is HTTPS.
`plaintext_tunnel` is plain HTTP inside a CONNECT tunnel, for example
`curl -p -x "$HTTPS_PROXY" http://<stub>/...`. Point it at a stub destination,
never the AtlaSent API. The command prints `{"reported_scheme":"..."}` or the
workload guard's log lines, which now record the `scheme`, `host` and `port`
OpenShell reported. The probe (`runTransportIdentityProbe`) passes only if TLS
reads `https` and the tunnelled plaintext reads `http`. If the harness cannot
see a reported scheme, it fails `not_observed`; it never passes. The `tls` case
is the in-run positive control. On every release so far, expect a failure with
`defect_4397: true`. That failure is the cross-version control, so record it
alongside any later pass. A version is added to
`OPENSHELL_TRANSPORT_IDENTITY_CONFIRMED` only after a recorded pass, and only
that drops the #4397 advisory for it. The probe has not been run live yet.

Every check above was shown to fail against a mutation of the code it guards
(verify verdict ignored, spawn before verify, generation check removed, permit
not consumed, digest check removed, plaintext/ws/wss accepted, destination
check removed, a required unknown capability ignored). That is resistance to
those mutations, not coverage.

## Remaining

The live runs below each have a single command in
[`examples/openshell/live-kit/`](../examples/openshell/live-kit/README.md).

- The staging run above, and startup-probe runs on other compute drivers
  (Kubernetes, Podman, VM).
- Deploying the workload guard
  ([`OPENSHELL_WORKLOAD_IDENTITY_DESIGN.md`](OPENSHELL_WORKLOAD_IDENTITY_DESIGN.md),
  `packages/openshell-workload-guard`). Phase 1 was live-tested on 0.1.3-pre.4.
  Phase 2 (atlasent-api#4032) is not applied to any environment yet.
- Run guard-bound mode live on the Docker driver: no `sandbox_id` in the
  workload, guard with `fill_absent_workload: true`, key with
  `requires_workload_attestation`. Check that the stub receives the filled
  body, that the attestation's `body_sha256` matches those bytes, that
  OpenShell fixes `Content-Length` after the body changes, and that a forged
  workload still gets `workload_mismatch`.
- OpenShell 0.1.3 stable. As of 2026-10-06 the newest tag is
  `v0.1.3-pre.4`. When stable ships, re-run the probe on it and add the
  result.
- Run the transport-identity probe live: once on 0.1.3-pre.4 (expected to
  fail with `defect_4397`, the control), then on the first release carrying
  the #4397 fix. Record both runs here and add the passing version to
  `OPENSHELL_TRANSPORT_IDENTITY_CONFIRMED`. Do not adopt #4359's streaming interface
  until NVIDIA ships it qualified.
- Port the workload guard to `EvaluateHttpRequestSession` once #4359 ships
  qualified, and before any OpenShell 0.2.0 deployment: 0.2.0 plans to remove
  the v1 RPC the guard uses. Re-run regression suites A–C on the port.

Do not fork OpenShell or duplicate its policy engine.
