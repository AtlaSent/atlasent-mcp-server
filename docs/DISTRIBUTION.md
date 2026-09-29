# Distribution status

The one canonical record of where AtlaSent's MCP server and Claude Code plugin
are listed. **One product, one repository, thin per-marketplace metadata:**
every listing points at `@atlasent/mcp-server` (this repo's `dist/`) or at the
`atlasent-guard` plugin in `packages/agent-hooks`. Do not create a listing
under another name or fork the product per marketplace.

Last verified: **2026-09-28**. Every "verified" cell below was checked against
the live surface on that date, not inferred from a workflow run or a config
file. Re-check before quoting any of it; a listing can change without a commit
here.

## Status

| Surface | Listing | Published version | Owner / claimed | Repo prerequisites | Remaining human action | Evidence (2026-09-28) |
|---|---|---|---|---|---|---|
| **npm** `@atlasent/mcp-server` | [npmjs.com/package/@atlasent/mcp-server](https://www.npmjs.com/package/@atlasent/mcp-server) | **2.16.0** (`latest`) | Atlasent org, trusted publishing (OIDC) | `publish.yml`, tag `v*`, `package.release` gate | None | `registry.npmjs.org/@atlasent%2fmcp-server` → `dist-tags.latest = 2.16.0` |
| **npm** `@atlasent/mcp-gate` | [npmjs.com/package/@atlasent/mcp-gate](https://www.npmjs.com/package/@atlasent/mcp-gate) | **0.1.0** (`latest`) | Atlasent org | `publish-gate.yml`, tag `gate-v*` | Next release ships Apache-2.0; 0.1.0 on npm still says MIT and cannot be changed | registry API, `license: MIT` on 0.0.1 and 0.1.0 |
| **npm** `@atlasent/agent-hooks` | not published | — | — | package ready (Apache-2.0, LICENSE, NOTICE) | Seed a `package.release` template for it in the live bundle (production write), then add a gated tag workflow | registry API → 404 |
| **Official MCP Registry** | `io.github.Atlasent/mcp-server` on [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io/v0/servers/io.github.Atlasent%2Fmcp-server/versions) | **2.16.0**, `isLatest: true` (all of 2.12.2 → 2.16.0 present) | Atlasent GitHub org (namespace `io.github.Atlasent`) | `server.json`; `publish-mcp-registry.yml` runs after each npm publish | None | `/versions` endpoint, published 2026-09-28T06:28:12Z. The search endpoint lists every version oldest-first, so its first hit (2.12.2) is not the current one; read `_meta…isLatest` |
| **Claude Code plugin** (own marketplace) | `/plugin marketplace add Atlasent/atlasent-mcp-server` then `/plugin install atlasent-guard@atlasent` | plugin **0.2.0** (on merge) | this repo | `.claude-plugin/marketplace.json`; `claude plugin validate --strict` passes for plugin and marketplace | None | local `claude plugin validate --strict`, both pass |
| **Claude plugin directory** (Anthropic, public) | not submitted | — | — | Ready: license, README ≥40 words, `plugin.json` description/author/version, no binaries/lockfile/`.npmrc`, hook path uses `${CLAUDE_PLUGIN_ROOT}`. Network: none by default; only when the user enters an agent key in the plugin's `api_key` setting (`userConfig`, `sensitive`) does connected mode call `api.atlasent.io`, sending a redacted preview and a hash. Expect **reviewer holds**, not blocks: the hook runs a `.mjs` file from a subfolder plugin, and it can read a key from `ATLASENT_HOOKS_API_KEY` / `~/.atlasent/credentials.json` (npm CLI path) as well as the plugin setting | Submit at `claude.ai/directory/manage` (paid plan, GitHub connected with push access) | [pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist) walked item by item |
| **`claude-plugins-official`** (Anthropic's own marketplace) | not listed | — | — | — | Only via an Anthropic partner contact; no public submission route | Claude Code docs, plugins/publish |
| **Claude connector directory** (remote MCP) | not applicable | — | — | Needs a hosted remote MCP URL; this server is stdio (streamable HTTP is self-host only) | None until AtlaSent hosts a remote MCP endpoint | [submit docs](https://claude.com/docs/plugins/submit) |
| **Glama** | [glama.ai/mcp/servers/@Atlasent/atlasent-mcp-server](https://glama.ai/mcp/servers/@Atlasent/atlasent-mcp-server) | Not stated on the page (its npm badge is a live shields.io image). README snapshot sits between 2026-09-26 and 2026-09-27 20:39Z commits on `main` | **Claimed**: "Server maintainers are verified by Glama", maintainer `bettyc925` (from `glama.json`) | `glama.json`, `Dockerfile` (CI `docker-smoke`) | None required; Glama re-indexes from GitHub. To force it, use the listing's own re-index/refresh control while signed in as `bettyc925` | Page shows 45 tools. `main` registered 44 when checked and 45 after #191 merged (2026-09-28); Glama's README snapshot predates #191, so its 45 was not the evidence-gap tool, and the page does not say which tools it counted |
| **Smithery** | not listed | — | — | `smithery.yaml` fixed (config was top-level, ignored); **current path is an MCPB bundle**: `npm run build && npm run bundle` → `atlasent-mcp-server-<version>.mcpb`, validated in CI (artifact `mcpb-bundle`) | Sign in at smithery.ai and publish the bundle under the Atlasent namespace (steps below) | `registry.smithery.ai/servers/@Atlasent/atlasent-mcp-server` → 404; search "atlasent" → no AtlaSent entry |
| **GitHub MCP Registry** (github.com/mcp, VS Code gallery) | not listed | — | — | Curated by GitHub from the official registry | None available to us; watch for inclusion | `api.mcp.github.com/v0.1/servers?search=atlasent` → 0 results |
| **Docker MCP Catalog** | not listed | — | — | `Dockerfile` exists and passes `docker-smoke` | Optional: PR to `docker/mcp-registry` | `docker/mcp-registry` has no `servers/atlasent` |
| **PulseMCP, mcp.so, cursor.directory** | not verified | — | — | These mostly ingest from the official registry | Check by hand in a browser | PulseMCP's public API is sunset, mcp.so renders client-side, cursor.directory rate-limited the check |

## Smithery: publishing the bundle

1. Download the `mcpb-bundle` artifact from the latest green CI run on `main`,
   or build it: `npm ci && npm run build && npm run bundle`.
2. Sign in at [smithery.ai](https://smithery.ai) with the account that should
   own the Atlasent namespace, then go to [smithery.ai/new](https://smithery.ai/new),
   choose **Local (MCPB bundle)** and upload `atlasent-mcp-server-<version>.mcpb`.
   CLI equivalent: `npx @smithery/cli mcp publish ./atlasent-mcp-server-<version>.mcpb -n <namespace>/mcp-server`.
3. Open the server's **Settings → Verification** to complete vendor verification.
4. Verify publicly: `curl https://registry.smithery.ai/servers/<namespace>/mcp-server`
   returns the server, then update this table.

Each later version needs a new bundle upload; nothing publishes to Smithery
automatically.

## Keeping the metadata thin and consistent

- `package.json`, `server.json` (both fields) and `mcpb/manifest.json` carry the
  same version; `src/distribution.test.ts` and `scripts/build-mcpb.mjs` fail on
  a mismatch.
- Every distributable declares Apache-2.0 and ships LICENSE + NOTICE;
  `scripts/check-package-licenses.mjs` (self-tested in CI) fails otherwise.
- No listing says the signed record can be verified offline;
  `src/distribution.test.ts` fails on that wording in listing files.
