# npm publishing, `package.release` gate and MCP Registry: history

> Moved verbatim from `CLAUDE.md` on 2026-10-14 (no relative links needed rebasing; paths in code spans are repo-root-relative, as they were in `CLAUDE.md`). Historical record: dated narrative, superseded text included. `CLAUDE.md` states the current truth; where they differ, `CLAUDE.md` wins.

## npm publishing

Scoped package `@atlasent/mcp-server`, `publishConfig.access: public`. Tag `v*` triggers `publish.yml`, which runs an AtlaSent `package.release` gate, then build, tests, and `npm publish --access public` via npm **trusted publishing** (OIDC; no stored token — see "Trusted publishing replaces NPM_TOKEN" below). The repo is public, so npm provenance is attached, alongside a cosign keyless-signed tarball uploaded as a build artifact. **Correction (2026-08-30):** this section previously claimed no `v*` tag had ever been pushed and no version had ever been published — that was based on an incomplete local git clone (`git tag -l` empty), not the live registry. Verified directly against `registry.npmjs.org`: **`2.11.0` has been published to npm since 2026-06-09** (via a manual `workflow_dispatch` run, not a tag-triggered one), and the `v2.11.0` git tag has existed on GitHub since 2026-06-10 (`create-v2-11-0-tag.yml` run #1, which pinned it to a specific historical commit SHA rather than the HEAD at dispatch time). Before assuming a tag or version is missing, check the live registry/GitHub state directly rather than a local checkout's `git tag -l`, which may not have fetched tags. **MCP Registry: listed since 2026-09-24**, and every npm release since has reached it: 2.12.2 through 2.16.0 are all present, with 2.16.0 `isLatest: true` (checked 2026-09-28 against `registry.modelcontextprotocol.io/v0/servers/io.github.Atlasent%2Fmcp-server/versions`). **Read `_meta[...].isLatest`, not the first search hit:** `/v0/servers?search=atlasent` returns every version, oldest first, so the first entry is 2.12.2 and reads as "stuck at 2.12.2" when nothing is stuck. Before 2026-09-24 it had never been listed.

### Trusted publishing replaces NPM_TOKEN (2026-09-24)

The repo is now public, and `publish.yml` publishes via npm **trusted
publishing** (OIDC): no stored npm token, `id-token: write` (already present
for cosign), npm upgraded to >= 11.5.1 in the job, and provenance attached via
`publishConfig.provenance`. The "Not `--provenance`" / `NPM_TOKEN` text above
is historical. `v2.12.1` was tagged but never reached npm: the `npm`
environment's `NPM_TOKEN` had lapsed (E404 on PUT), then a re-pasted token
carried a newline ("is not a legal HTTP header value"). `v2.12.2` ships the
same code. Re-running a tag's publish uses the workflow file AT THAT TAG, so a
workflow fix always needs a new version.

### The `package.release` gate had no template for this repo until 2026-09-19

Both `publish.yml` and `publish-mcp-registry.yml` call `package.release` against
runtime prod (`kttccumlnmdtupgbyfue`). Until 2026-09-19 the org's bundle carried
**no template matching this repository at all**, so both gates were
guaranteed-deny (`No template condition matched`) — the same class of gap
`atlasent-control-plane` hit twice and documented at length. That is why the
2026-06-09 publish went out via `workflow_dispatch`: a real tag push would have
been denied at the gate.

Bundle versioned forward v4 -> **v5** (id `73578fb8-88ef-4c24-978d-24803e31837b`,
action class `d9116cd9-2a18-4f60-9638-c2996d2f6c2c`, 14 -> 16 templates,
`allow_actors` unchanged), archive-and-insert in one atomic statement because
published `constraint_bundles` rows are DB-immutable. The two added templates:

| Template | Matches |
|---|---|
| `package_release_atlasent_mcp_server_tag_release_manager` | this repo + `Publish to npm` + `event_name: push` + `^refs/tags/v<semver>(-prerelease)?$` |
| `package_release_atlasent_mcp_server_registry_release_manager` | this repo + `Publish to MCP Registry` + `context.artifact == "mcp-registry"` + `event_name` in (`workflow_run`, `workflow_dispatch`) |

**The registry template deliberately does NOT carry a tag regex.** On the
`workflow_run` path — the normal one, since that workflow chains off
`Publish to npm` — `github.ref` is `refs/heads/main`, not the tag. A tag
condition there would have denied the real path while passing every test
written against the dispatch path. Caught before the production write by running
the drafted templates through the canonical rule engine
(`atlasent-api/packages/sdk/src/rules.ts`), not by reasoning about them.

**Known limit, not a defect:** `publish.yml`'s own `workflow_dispatch` trigger is
NOT authorized — a dispatch has `ref: refs/heads/main` and no tag, so it matches
no template and denies. Releasing from this repo now means pushing a real `v*`
tag. Do not "fix" that by relaxing the ref condition; the tag binding is what
makes the permit name a specific version.

**CORRECTED 2026-09-26 — `@atlasent/mcp-gate` HAS a template and
`publish-gate.yml` reaches `allow`.** This paragraph said the gate "denies until
one is seeded" and named the drafted `package_release_v9` as the thing to apply.
Both are now wrong, in the one direction a stale note must never take: it tells a
reader a working authorization gate cannot pass, and points at a runbook whose SQL
now carries a `SUPERSEDED — DO NOT RUN` banner. Same failure shape
`atlasent-action`'s `RELEASING.md` records for its own release gate.

What is true, read from the live bundle rather than from a runbook: the active
`package.release` bundle for this org is **v10**
(`773a5972-76eb-402c-a288-346a7d9c9ceb`, 32 templates), and it carries
`package_release_atlasent_mcp_gate_tag_release_manager`. `publish-gate.yml`
("Publish MCP Gate to npm", `gate-v*`) matched it on a real tag push and returned
`allow` — the first live exercise of that template — and
`@atlasent/mcp-gate@0.1.0` is on npm with provenance. **v9 was superseded by v10
before it was ever applied; never apply `docs/runbooks/package_release_v9/`.**

Still binding, unchanged: do NOT rename this workflow to impersonate another
template, and do NOT add a `skip_gate` input. A `workflow_dispatch` of it denies
and that is correct — a dispatch carries `ref: refs/heads/main` and no tag, so it
matches no template. Releasing means pushing a real `gate-v*` tag.

Its discriminator is **`context.artifact: "atlasent-mcp-gate"`**, not
`context.package`. `publish-gate.yml` originally sent `"package":
"@atlasent/mcp-gate"` — a field no template in this bundle reads, so it could
never have matched, and a field that is simply absent from a match cannot deny;
it looks identical to a template that was never scoped to the package. The value
is the artifact identity, not the npm package name: the template asserts
`@atlasent/mcp-gate` is denied, which is the assertion that catches this exact
mix-up. Fixed before the first `gate-v*` tag was ever pushed.

Verified post-write, against the STORED row rather than the drafted form:
exactly one `active` bundle for this action class; a server-side `jsonb`
equality check confirmed the local copy matched the stored row byte-for-byte
(so the regex escaping survived the SQL round trip); and re-running the stored
bundle through the rule engine passed 23/23 assertions — 13 covering the new
templates (4 allow, 9 deny) and 10 regression assertions confirming all 14
pre-existing templates still match, each by name.

## MCP Registry publishing

`server.json` (repo root) is the official MCP Registry manifest
(`io.github.AtlaSent/mcp-server` since 2.17.2; the `io.github.<owner>` prefix must
match the GitHub org's casing exactly, because the registry compares
case-sensitively (modelcontextprotocol/registry#689). The old
`io.github.Atlasent/mcp-server` entry is frozen at 2.16.0. `package.json`
`mcpName` must equal it, which `distribution.test.ts` pins. npm provenance also
compares `repository.url` case-sensitively: keep `github.com/AtlaSent/...`). After every successful npm
publish, `publish-mcp-registry.yml` publishes it to
registry.modelcontextprotocol.io via `mcp-publisher` with GitHub OIDC (no
stored secret). **Release checklist addition: bump BOTH version fields in
`server.json` (top-level and `packages[0].version`) AND `mcpb/manifest.json`'s
`version` together with `package.json`** (`src/distribution.test.ts` and
`scripts/build-mcpb.mjs` fail on any mismatch) — the workflow fails closed on a mismatch. It also polls npm
until the new version resolves before publishing (fails closed after ~10 min):
the registry rejects a version npm does not serve yet, which is what failed
v2.12.2's first registry run. First-time
publication (and re-publishes) can be run manually via workflow_dispatch.
`smithery.yaml` covers the Smithery directory separately.
