// One product, thin per-marketplace metadata. These tests keep every listing
// file (server.json for the MCP Registry, mcpb/manifest.json for MCPB hosts
// such as Smithery and Claude Desktop, smithery.yaml, glama.json, the Claude
// Code plugin marketplace) consistent with package.json and with the env vars
// the server actually reads.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseYamlSubset } from "./evidenceGap.js";
import { OPTIONAL_ATLASENT_ENV } from "./hostEnv.js";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const json = (p: string) => JSON.parse(read(p));
const pkg = json("package.json");
const KNOWN_ENV = new Set<string>(OPTIONAL_ATLASENT_ENV);

describe("distribution metadata", () => {
  it("server.json, mcpb/manifest.json and package.json agree on version and license", () => {
    const srv = json("server.json");
    const mcpb = json("mcpb/manifest.json");
    assert.equal(srv.version, pkg.version);
    assert.equal(srv.packages[0].version, pkg.version);
    assert.equal(srv.packages[0].identifier, pkg.name);
    assert.equal(mcpb.version, pkg.version);
    assert.equal(mcpb.license, pkg.license);
  });

  it("the MCPB manifest runs dist/index.js, maps only env vars the server reads, and marks the key sensitive", () => {
    const m = json("mcpb/manifest.json");
    assert.equal(m.server.entry_point, "dist/index.js");
    assert.deepEqual(m.server.mcp_config.args, ["${__dirname}/dist/index.js"]);
    for (const k of Object.keys(m.server.mcp_config.env)) assert.ok(KNOWN_ENV.has(k), `unknown env ${k}`);
    assert.equal(m.user_config.api_key.sensitive, true);
    assert.equal(m.user_config.api_key.required, false, "no key must still start (local demo)");
    assert.equal(m.user_config.base_url.default, "https://api.atlasent.io/functions/v1");
  });

  it("smithery.yaml parses and its commandFunction maps config to the server's env vars", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON in a test/acceptance harness
    const doc = parseYamlSubset(read("smithery.yaml")) as Record<string, any>;
    assert.equal(doc.startCommand.type, "stdio");
    const props = Object.keys(doc.startCommand.configSchema.properties);
    assert.deepEqual(props.sort(), ["apiKey", "baseUrl", "mode"]);
    const fn = (0, eval)(doc.startCommand.commandFunction) as (c: Record<string, string>) => {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    const none = fn({});
    assert.equal(none.command, "npx");
    assert.deepEqual(none.args, ["-y", pkg.name]);
    assert.deepEqual(none.env, {}, "no config -> no env -> local demo mode");
    const full = fn({ apiKey: "ask_live_x", baseUrl: "https://b/functions/v1", mode: "remote" });
    assert.deepEqual(full.env, {
      ATLASENT_API_KEY: "ask_live_x",
      ATLASENT_BASE_URL: "https://b/functions/v1",
      ATLASENT_MODE: "remote",
    });
    for (const k of Object.keys(full.env)) assert.ok(KNOWN_ENV.has(k));
  });

  it("glama.json names maintainers for the claim flow", () => {
    const g = json("glama.json");
    assert.ok(Array.isArray(g.maintainers) && g.maintainers.length > 0);
  });

  it("the Claude Code marketplace lists only plugins that exist in this repo", () => {
    const mk = json(".claude-plugin/marketplace.json");
    for (const p of mk.plugins) {
      const pj = json(`${p.source.replace(/^\.\//, "")}/.claude-plugin/plugin.json`);
      assert.equal(pj.name, p.name);
      assert.equal(pj.license, pkg.license);
    }
  });

  it("no listing overclaims offline verification", () => {
    for (const f of ["server.json", "mcpb/manifest.json", "smithery.yaml", "README.md", "packages/agent-hooks/README.md", "packages/agent-hooks/.claude-plugin/plugin.json"]) {
      assert.doesNotMatch(read(f), /verify (it )?offline|without trusting us/i, f);
      // Not every action class requires human approval, so no listing may
      // promise that every record names an approver.
      assert.doesNotMatch(read(f), /record of who approved it/i, f);
      // A hold or deny for a missing approval had approval required and no
      // approver; only a decision that relied on an approval names one.
      assert.doesNotMatch(read(f), /when approval was required/i, f);
    }
  });
});
