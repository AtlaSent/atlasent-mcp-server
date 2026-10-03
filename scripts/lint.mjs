#!/usr/bin/env node
// `npm run lint`: run ESLint over the repo (config: eslint.config.mjs).
//
// ESLint and typescript-eslint live in tools/lint/ with their own lockfile,
// because the root compiles with TypeScript 7, which has no JavaScript API,
// and typescript-eslint parses through one (it peers on typescript <6.1).
// The first run, or any run after tools/lint/package-lock.json changes,
// installs that toolchain with `npm ci`. Extra arguments go to ESLint,
// e.g. `npm run lint -- --fix`.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(ROOT, "tools", "lint");
const lock = join(TOOL, "package-lock.json");
const installed = join(TOOL, "node_modules", ".package-lock.json");
const eslint = join(TOOL, "node_modules", "eslint", "bin", "eslint.js");

if (!existsSync(eslint) || !existsSync(installed) || statSync(installed).mtimeMs < statSync(lock).mtimeMs) {
  execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: TOOL, stdio: "inherit", shell: process.platform === "win32" });
}

try {
  execFileSync(process.execPath, [eslint, ...process.argv.slice(2), "."], { cwd: ROOT, stdio: "inherit" });
} catch (e) {
  process.exit(typeof e.status === "number" ? e.status : 1);
}
