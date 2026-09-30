# NVIDIA OpenShell × Atlasent

Status: experimental integration surface.

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

## Next implementation slice

Add `atlasent-openshell` as a small adapter executable around the existing
MCP governed-action client. Its stable contract should be:

- input: canonical action envelope;
- output: DENY | HOLD | PERMIT;
- HOLD: poll/claim through the existing approval contract;
- PERMIT: return only the opaque permit plus the expected execution binding;
- trip/failure: report through the existing circuit-trip runtime endpoint.

Do not fork OpenShell or duplicate its policy engine.
