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

The adapter contract is implemented and unit-tested. The `atlasent-openshell`
executable wrapper is still to come. Rules, each pinned by a test in
`src/openshell.test.ts`:

### 1. Identity binds to `sandbox_id`

OpenShell supervisor middleware runs after OpenShell policy allows a request
and before provider credentials are injected. It receives `sandbox_id` plus
human-readable `sandbox_name` and `workspace`. NVIDIA describes `sandbox_id` as
the durable identity; names and workspaces are display context and may be
reused. (Source: OpenShell `docs/extensibility/supervisor-middleware.mdx`, as
relayed. The page returned 404 when fetched on 2026-10-05, so re-read it before
relying on the exact field names.)

- The adapter refuses a request with a missing, blank or malformed
  `sandbox_id`. It never derives one from `sandbox_name` or `workspace`.
- It sends `context.workload = { kind: "openshell_sandbox", id: <sandbox_id>,
  labels: { sandbox_name, workspace } }` to `/v1-evaluate`. The decision record
  names the exact sandbox. For `agent.*` actions the sealed action hash covers
  it too. Labels are evidence for the approval UI, never authority.
- At the execution boundary, a permit or HOLD presented from a different
  `sandbox_id` is refused, even when the name matches.
- **Limit:** for actions other than `agent.*`, the runtime does not yet compare
  `workload.id` at `/v1-verify-permit`. It records the field but does not
  re-check it at the boundary, so today the sandbox check at execution happens
  only in the adapter. Making the runtime enforce it is an `atlasent-api`
  follow-up.

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
without response"). The issue names no fix release. `assessOpenShellVersion`
marks 0.1.2 `known_affected`, and every other version `unverified`. A version
string never makes the path production-ready. Only a recorded pass of the live
probe does:

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

## Remaining slice

- `atlasent-openshell` executable wrapping `OpenShellAuthorityAdapter`
  (input: canonical envelope + middleware context; output: DENY | HOLD | PERMIT).
- Trip/failure reporting through the existing circuit-trip runtime endpoint.
- Runtime-side `workload.id` comparison at verify (`atlasent-api`).
- First recorded live startup-probe pass on a fixed OpenShell release.

Do not fork OpenShell or duplicate its policy engine.
