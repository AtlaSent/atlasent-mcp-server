# Contributing to atlasent-mcp-server

Thanks for your interest! This repo publishes [`@atlasent/mcp-server`](https://www.npmjs.com/package/@atlasent/mcp-server), the MCP server that lets Claude Desktop, Cursor, Windsurf, Claude Code, and any other MCP host ask AtlaSent for authorization **before** an agent runs a consequential action.

**You don't need an AtlaSent account or API key to contribute.** The whole test suite and the demo run offline.

## Getting set up

Requires Node.js 18+ (CI tests 18, 20, and 22).

```bash
git clone https://github.com/Atlasent/atlasent-mcp-server.git
cd atlasent-mcp-server
npm install
npm run build
npm test          # offline: no network, no credentials
npm run lint      # ESLint; installs its own toolchain on first run
npm run demo      # end-to-end local-mode demo
```

Or open the repo in the [dev container](./.devcontainer/devcontainer.json) (VS Code "Reopen in Container", or GitHub Codespaces). It installs and builds for you.

To try your build in a real MCP host, point the host at your checkout:

```json
{
  "mcpServers": {
    "atlasent-dev": {
      "command": "node",
      "args": ["/absolute/path/to/atlasent-mcp-server/dist/index.js"],
      "env": { "ATLASENT_MODE": "local" }
    }
  }
}
```

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) also works: `npx @modelcontextprotocol/inspector node dist/index.js`.

## How the code is laid out

| File | What it does |
|---|---|
| `src/server.ts` | `createServer()`: registers every MCP tool |
| `src/engine.ts` | `authorize()` / `verify()`: picks local vs. remote mode, fail-closed wrapper |
| `src/localEngine.ts` | The offline rules engine used in local mode |
| `src/decision.ts` | The `Decision` / `VerifyResult` envelope and the `toolResult()` helper |
| `src/v2Tools.ts`, `complianceTools.ts`, `vqpTools.ts` | Groups of hosted-API tools |
| `src/streamableHttp.ts` | Streamable HTTP transport (stdio is the default, in `index.ts`) |
| `src/*.test.ts` | Unit tests (`node:test` + the MCP SDK's `InMemoryTransport`) |

Every protected tool follows the same pattern:

```ts
const decision = await authorize(ctx);      // interception point
if (decision.decision !== "allow") {
  return toolResult(decision);              // blocked: nothing executes
}
// ...verify the permit, then run the action...
```

## Ground rules

These keep the project trustworthy as a security component. PRs that break them can't be merged, so please ask in an issue if one is in your way.

1. **Fail closed.** Any error in authorization or verification must end in `deny` / `valid: false`. The protected action never runs on an error path.
2. **Don't invent wire shapes.** Requests and responses to the hosted API mirror `atlasent-api`'s `v1-evaluate` and `v1-verify-permit` handlers. If you need a new field, open an RFC issue first.
3. **Keep local mode working without credentials.** `npm test` and `npm run demo` must pass offline.
4. **Read env vars at call time,** not at module load, so tests and hosts can switch configuration without a restart.
5. **10-second timeout** on every outbound `fetch`.
6. **Strict TypeScript.** No `any` in new code.
7. **Tests for behavior changes.** A new or changed tool handler comes with a test. Remote-mode tests mock `globalThis.fetch`; see `src/server.test.ts`.
8. **Don't hand-edit generated files.** `src/canonCatalog.ts`, `src/canonGraph.ts`, and `src/atlasCatalog.ts` are synced from upstream by the scripts in `scripts/`, and a CI job checks the Canon mirrors for drift.

## Finding something to work on

- Issues labeled [`good first issue`](https://github.com/Atlasent/atlasent-mcp-server/labels/good%20first%20issue) or [`help wanted`](https://github.com/Atlasent/atlasent-mcp-server/labels/help%20wanted).
- Docs, examples, and host-setup guides are always welcome and need no background in AtlaSent internals.
- For a larger change (a new tool, a new transport, or anything that touches authorization semantics), please open an **RFC** issue first so we can agree on the design before you write code.

## Pull request checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes (no `any` in new code)
- [ ] `npm test` passes
- [ ] `npm run demo` still runs end-to-end
- [ ] New or changed tool handlers have a matching test
- [ ] README updated if you changed a tool's inputs or outputs

## Reporting a security issue

Email **security@atlasent.io**. We acknowledge within 2 business days. Please don't open a public issue for anything security-sensitive. See [SECURITY.md](./SECURITY.md).

## Code of Conduct

This project follows our [Code of Conduct](./CODE_OF_CONDUCT.md). By taking part, you agree to uphold it.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](./LICENSE), the same license as this repository.
