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
- **Where the ID comes from.** OpenShell itself puts the sandbox ID in the
  workload's environment as `OPENSHELL_SANDBOX_ID` (checked against
  NVIDIA/OpenShell@71c3cd9):
  - its compute drivers (Kubernetes, Podman, VM) set it on the supervisor;
  - it is reserved, so a sandbox spec, template or exec request cannot
    override it;
  - workload processes inherit it, because it is not on the supervisor-only
    strip list.

  `atlasent-openshell` reads exactly that variable, or a JSON file named by
  `ATLASENT_OPENSHELL_SANDBOX_CONTEXT_FILE` (re-read before evaluate and again
  before verify).
- **What OpenShell does not give the workload.** `OPENSHELL_SANDBOX` is
  overwritten with `"1"` inside a workload as an "inside a sandbox" marker, so
  it is never the name there and the adapter never reads it. OpenShell provides
  no sandbox name, workspace or policy generation to the workload.
  `OPENSHELL_SANDBOX_NAME`, `OPENSHELL_WORKSPACE` and
  `OPENSHELL_POLICY_GENERATION` are optional values an operator may set. They
  are display labels and change detection only, never authority.
- **Remaining limit.** OpenShell protects the variable from the sandbox's
  configuration, not from the agent. A process inside the sandbox can launch
  `atlasent-openshell` with a different `OPENSHELL_SANDBOX_ID` in its
  environment, and the runtime's check (atlasent-api#4010) cannot tell. The
  binding stops one sandbox's permit from being redeemed by a different
  well-behaved process; it is not proof against an agent that lies to its own
  child. Closing that needs an identity the agent cannot set, such as a value
  OpenShell's supervisor attests or the middleware path, where OpenShell
  supplies `sandbox_id` per request.

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
`known_affected`, says pre.4 contains the fix, and calls every version
`unverified` until a probe passes. A version string never makes the path production-ready. Only a
recorded pass of the live probe does:

```
OPENSHELL_VERSION=<x.y.z> \
OPENSHELL_ACCEPTANCE_START_CMD='<start the sandbox>' \
OPENSHELL_ACCEPTANCE_PROBE_CMD='<one AtlaSent-governed request through it>' \
npm run test:openshell-acceptance
```

The probe sends a request every 500 ms for the first 20 s after start. It
fails on any dropped, denied or errored request. On a known-affected version it
fails even when every request passes. **It has not yet been run against a real
OpenShell install.** The unit suite proves only the probe logic, including a
positive control that reproduces the 0.1.2 failure pattern.

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

## Remaining

- First recorded live startup-probe pass on a release that contains `ec49209`.
  v0.1.3-pre.4 is the first such release. An attempt from an AtlaSent cloud session on 2026-10-05
  could not reach OpenShell's release binaries or its ghcr.io image blobs
  (`pkg-containers.githubusercontent.com` is denied by that environment's
  egress policy), so the probe has still never run against a real install.
- An identity for the executable that the agent cannot set (see "Remaining
  limit" above).

Do not fork OpenShell or duplicate its policy engine.
