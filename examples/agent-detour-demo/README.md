# Agent detour demonstration (synthetic)

An ordinary research request can fail at its destination. If an agent then changes tools, credentials or endpoints to finish the task, that detour needs **its own** authorization. This offline fixture models that failure without calling a real website, using real credentials, or executing remote code.

## Run

Requires a checkout of this repository and Node 22 or newer. No key, network service, package installation or real account.

```sh
node --test packages/mcp-gate/test/agent-detours.node.mjs
```

The test runs `@atlasent/mcp-gate` as a **real local stdio proxy** in front of `fake-server.mjs`, then sends these synthetic MCP requests:

| Attempt | Expected result | Actual upstream invocation? |
| --- | --- | --- |
| Authorized `lookup_entrance` | Allowed by the local operator rule; synthetic provider returns an error | Yes |
| Same tool, different source | Denied because exact arguments no longer match | No |
| `run_remote_script` | Denied: no matching rule | No |
| `lookup_with_external_key` | Denied: no matching rule | No |
| `post_webhook` | Denied: no matching rule | No |
| Explicitly permitted `lookup_public_reference` | Allowed; returns synthetic published-data fixture | Yes |

The test reads an independent upstream trace to prove only the two permitted calls were dispatched. It also asserts that the local activity log omits tool arguments/credential strings and labels a returned tool result as **not independently verified**.

## The boundary we do—and do not—prove

- **Proven by this test if it passes:** deny-by-default MCP proxy behavior for the covered tool path; exact argument matching; denied detours not dispatched through this proxy.
- **Not proven:** preventing an agent from invoking a different MCP server, shell, browser, outbound network path or credential outside the proxy; a cross-tool retry budget; genuine human approval; hosted signed permits; independent execution/effect proof; any cloud deployment or external customer result.
- The local `allow` is an **operator rule**, not organizational authorization. Cloud-backed authorization and verified, single-use permits require the separately configured and accepted execution path. See [MCP Gate](../../packages/mcp-gate/README.md) and [live staging reference acceptance issue #209](https://github.com/AtlaSent/atlasent-mcp-server/issues/209).

For production use, separately restrict credentials, tool launching, sandbox policy, egress and native execution routes. A prompt asking the model to call AtlaSent does not secure any bypass route.

This is a **test fixture and illustration**, not a claim that AtlaSent prevented any public incident.
