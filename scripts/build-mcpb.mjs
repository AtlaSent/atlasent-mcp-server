#!/usr/bin/env node
// Build atlasent-mcp-server-<version>.mcpb: the same server npm ships, packed
// as an MCPB bundle for hosts that install local servers from a bundle
// (Smithery's stdio listings, Claude Desktop). One product, one version: this
// packs dist/ from this repository, and fails if mcpb/manifest.json, server.json
// and package.json disagree on the version.
//
//   npm run build && node scripts/build-mcpb.mjs [--out <dir>]
//
// Steps: stage manifest + dist + package.json + LICENSE/NOTICE/README, install
// production dependencies only (npm ci --omit=dev against the real lockfile),
// fill the manifest's `tools` from the server's own tools/list, then run the
// pinned MCPB CLI's `validate` and `pack`.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outIdx = process.argv.indexOf("--out");
const OUT = resolve(outIdx !== -1 ? process.argv[outIdx + 1] : ROOT);

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(ROOT, "mcpb", "manifest.json"), "utf8"));
const serverJson = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8"));
if (manifest.version !== pkg.version) fail(`mcpb/manifest.json version ${manifest.version} != package.json ${pkg.version}`);
if (serverJson.version !== pkg.version) fail(`server.json version ${serverJson.version} != package.json ${pkg.version}`);
if (manifest.license !== pkg.license) fail(`mcpb/manifest.json license ${manifest.license} != package.json ${pkg.license}`);
if (!existsSync(join(ROOT, "dist", "index.js"))) fail("dist/index.js missing; run `npm run build` first");

const stage = mkdtempSync(join(tmpdir(), "atlasent-mcpb-"));
try {
  for (const f of ["dist", "package.json", "package-lock.json", "LICENSE", "NOTICE", "README.md"]) {
    cpSync(join(ROOT, f), join(stage, f), { recursive: true });
  }
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit" });
  rmSync(join(stage, "package-lock.json"));

  // Tool list straight from the server, so the bundle never advertises a tool
  // the code does not register (or hides one it does).
  const { createServer } = await import(pathToFileURL(join(stage, "dist", "server.js")).href);
  const { Client } = await import(pathToFileURL(join(stage, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href);
  const { InMemoryTransport } = await import(pathToFileURL(join(stage, "node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js")).href);
  const server = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcpb-build", version: pkg.version });
  await Promise.all([client.connect(ct), server.connect(st)]);
  const { tools } = await client.listTools();
  await client.close();
  if (!tools.length) fail("server registered no tools");
  manifest.tools = tools
    .map((t) => ({ name: t.name, description: (t.description ?? t.title ?? t.name).split(/(?<=\.)\s/)[0].slice(0, 200) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  execFileSync("npx", ["-y", MCPB_CLI, "validate", join(stage, "manifest.json")], { stdio: "inherit" });
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `atlasent-mcp-server-${pkg.version}.mcpb`);
  execFileSync("npx", ["-y", MCPB_CLI, "pack", stage, file], { stdio: "inherit" });
  console.log(`built ${file} (${manifest.tools.length} tools)`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
