# NVIDIA OpenShell × Atlasent

Status: experimental integration surface. OpenShell controls reachability;
Atlasent controls organizational authority and effect proof.

## Boundary

OpenShell owns sandbox isolation, network/process policy and credential
injection. Atlasent owns organizational authorization for consequential
actions: DENY, HOLD/approval, bounded permits and post-execution evidence.

Do not broaden an OpenShell network rule merely because Atlasent authorized an
action. The intended sequence is:

1. Agent proposes a consequential action.
2. The Atlasent adapter canonicalizes actor, action, target, revision and
   intended effect and calls Atlasent evaluation.
3. DENY stops. HOLD waits for the existing Atlasent approval flow. ALLOW
   returns a bounded permit.
4. The executor presents and consumes/verifies that permit immediately before
   the external effect.
5. Atlasent independently establishes the effect where a provider profile
   exists.

OpenShell's default-deny network policy remains a separate enforcement
boundary. Atlasent authorization never means "give the sandbox general
network access."

## Providers v2

`atlasent-provider.yaml` is a custom OpenShell provider profile. It keeps the
Atlasent API key in OpenShell's provider credential boundary and grants only
the Atlasent authority endpoints to the adapter binary.

This is intentionally not a profile for Salesforce, AWS, GitHub or another
effect provider. Those credentials remain separately scoped. The agent should
not receive an Atlasent credential value directly.

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
- **Trust:** the binding is only as strong as its source. `atlasent-openshell`
  reads the sandbox context from `ATLASENT_OPENSHELL_SANDBOX_CONTEXT_FILE` (JSON,
  re-read before evaluate and again before verify) or from `OPENSHELL_SANDBOX_ID`,
  `OPENSHELL_SANDBOX_NAME`, `OPENSHELL_WORKSPACE` and `OPENSHELL_POLICY_GENERATION`.
  These are this adapter's own names, not OpenShell-defined ones. They must be
  injected by OpenShell (supervisor or provider), never set by the agent. A
  process that can rewrite them can claim another sandbox's identity.

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
2026-10-02). **As of 2026-10-05 no release contains it.** The latest stable
release is v0.1.2. The newest prerelease, v0.1.3-pre.3 (`6e865df3`), was cut
about seven hours before the fix. `assessOpenShellVersion` marks 0.1.2 and
0.1.3-pre.1 through pre.3 `known_affected`, and every other version
`unverified`. A version string never makes the path production-ready. Only a
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
  None exists yet. An attempt from an AtlaSent cloud session on 2026-10-05
  could not reach OpenShell's release binaries or its ghcr.io image blobs
  (`pkg-containers.githubusercontent.com` is denied by that environment's
  egress policy), so the probe has still never run against a real install.
- Confirm where OpenShell exposes `sandbox_id` and the policy generation to a
  process inside the sandbox, so the context is injected rather than
  self-reported. Middleware receives `sandbox_id` per request. A binary inside
  the sandbox has no documented equivalent yet.

Do not fork OpenShell or duplicate its policy engine.
