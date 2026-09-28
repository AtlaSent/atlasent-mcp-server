#!/usr/bin/env node
// One license across every distributable in this repo: the MCP server, each
// packages/* npm package, and every Claude Code plugin manifest must declare
// Apache-2.0, and each package directory must ship the full LICENSE (identical
// to the root) and a NOTICE listed in `files`. A plugin is installed from its
// own directory, and an npm tarball contains only that package, so the root
// LICENSE never reaches either.
//
// Exists because packages/agent-hooks and packages/mcp-gate both declared MIT
// in a repository licensed Apache-2.0 (fixed 2026-09-28).
//
//   node scripts/check-package-licenses.mjs            # check this repo
//   node scripts/check-package-licenses.mjs --self-test

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const EXPECTED = "Apache-2.0";

export function check(root) {
  const errors = [];
  const rootLicense = existsSync(join(root, "LICENSE")) ? readFileSync(join(root, "LICENSE"), "utf8") : null;
  if (!rootLicense) errors.push("LICENSE missing at repository root");

  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (rootPkg.license !== EXPECTED) errors.push(`package.json: license is ${JSON.stringify(rootPkg.license)}, expected ${EXPECTED}`);

  const pkgsDir = join(root, "packages");
  const pkgs = existsSync(pkgsDir) ? readdirSync(pkgsDir).filter((d) => existsSync(join(pkgsDir, d, "package.json"))) : [];
  if (pkgs.length === 0) errors.push("no packages/*/package.json found; refusing to report a pass over nothing");

  for (const d of pkgs) {
    const dir = join(pkgsDir, d);
    const rel = `packages/${d}`;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg.license !== EXPECTED) errors.push(`${rel}/package.json: license is ${JSON.stringify(pkg.license)}, expected ${EXPECTED}`);
    const lic = join(dir, "LICENSE");
    if (!existsSync(lic)) errors.push(`${rel}/LICENSE missing`);
    else if (rootLicense && readFileSync(lic, "utf8") !== rootLicense) errors.push(`${rel}/LICENSE differs from the root LICENSE`);
    if (!existsSync(join(dir, "NOTICE"))) errors.push(`${rel}/NOTICE missing`);
    if (Array.isArray(pkg.files)) {
      for (const f of ["LICENSE", "NOTICE"]) {
        if (!pkg.files.includes(f)) errors.push(`${rel}/package.json: "files" does not include ${f}`);
      }
    }
    const plugin = join(dir, ".claude-plugin", "plugin.json");
    if (existsSync(plugin)) {
      const pj = JSON.parse(readFileSync(plugin, "utf8"));
      if (pj.license !== EXPECTED) errors.push(`${rel}/.claude-plugin/plugin.json: license is ${JSON.stringify(pj.license)}, expected ${EXPECTED}`);
    }
    const readme = join(dir, "README.md");
    if (existsSync(readme) && /\bMIT[- ]licen[sc]ed\b|\bMIT License\b/.test(readFileSync(readme, "utf8"))) {
      errors.push(`${rel}/README.md still says MIT`);
    }
  }
  return { errors, packages: pkgs };
}

function selfTest() {
  const real = resolve(HERE, "..");
  const make = (mutate) => {
    const t = mkdtempSync(join(tmpdir(), "lic-"));
    copyFileSync(join(real, "LICENSE"), join(t, "LICENSE"));
    writeFileSync(join(t, "package.json"), JSON.stringify({ license: EXPECTED }));
    const p = join(t, "packages", "x");
    mkdirSync(join(p, ".claude-plugin"), { recursive: true });
    copyFileSync(join(real, "LICENSE"), join(p, "LICENSE"));
    writeFileSync(join(p, "NOTICE"), "x");
    writeFileSync(join(p, "README.md"), "Apache-2.0 licensed.");
    writeFileSync(join(p, "package.json"), JSON.stringify({ license: EXPECTED, files: ["*.mjs", "LICENSE", "NOTICE"] }));
    writeFileSync(join(p, ".claude-plugin", "plugin.json"), JSON.stringify({ license: EXPECTED }));
    mutate?.(t, p);
    return check(t).errors;
  };
  const cases = [
    ["clean fixture passes", undefined, 0],
    ["MIT in package.json", (t, p) => writeFileSync(join(p, "package.json"), JSON.stringify({ license: "MIT", files: ["LICENSE", "NOTICE"] })), 1],
    ["MIT in plugin.json", (t, p) => writeFileSync(join(p, ".claude-plugin", "plugin.json"), JSON.stringify({ license: "MIT" })), 1],
    ["README says MIT licensed", (t, p) => writeFileSync(join(p, "README.md"), "MIT licensed."), 1],
    ["LICENSE text differs", (t, p) => writeFileSync(join(p, "LICENSE"), "MIT License"), 1],
    ["NOTICE missing from files", (t, p) => writeFileSync(join(p, "package.json"), JSON.stringify({ license: EXPECTED, files: ["LICENSE"] })), 1],
  ];
  let failed = 0;
  for (const [name, mutate, wantMin] of cases) {
    const errs = make(mutate);
    const ok = wantMin === 0 ? errs.length === 0 : errs.length >= wantMin;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${errs.length ? ` -> ${errs[0]}` : ""}`);
  }
  // Empty scan set must not pass.
  const t = mkdtempSync(join(tmpdir(), "lic-"));
  copyFileSync(join(real, "LICENSE"), join(t, "LICENSE"));
  writeFileSync(join(t, "package.json"), JSON.stringify({ license: EXPECTED }));
  const empty = check(t).errors.length > 0;
  if (!empty) failed++;
  console.log(`${empty ? "ok  " : "FAIL"} no packages found is a failure, not a pass`);
  if (failed) {
    console.error(`self-test: ${failed} case(s) failed`);
    process.exit(1);
  }
  console.log("self-test passed");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const root = resolve(HERE, "..");
  const { errors, packages } = check(root);
  if (errors.length) {
    for (const e of errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  console.log(`license metadata consistent (${EXPECTED}) across root + ${packages.length} package(s): ${packages.join(", ")}`);
}
