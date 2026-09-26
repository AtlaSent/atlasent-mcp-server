# `atlasent_trajectory_verify` is not a supported MCP tool

`atlasent_trajectory_verify` has been removed from the public MCP tool surface — it is no longer registered and cannot be called.

The runtime does not implement `/v1/trajectory-verify`. The tool could never complete a real authorization check and must not be presented to agents as a usable capability.

For execution-boundary authorization, use the shipped AtlaSent flow:

1. `atlasent_evaluate` to obtain the runtime Decision and Permit.
2. `atlasent_verify_permit` immediately before the protected native side effect.
3. Proceed only when Permit Verification succeeds for the exact action, actor, target, environment, and bound payload.

Do not replace this with another client-side trajectory evaluator. The AtlaSent runtime remains the sole protected-action decision authority.

This removal was part of a broader cleanup that keeps the public tool surface limited to endpoints the AtlaSent API actually serves.
