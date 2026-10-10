#!/usr/bin/env node
/**
 * atlasent-openshell — AtlaSent organizational-authority adapter for NVIDIA
 * OpenShell sandboxes. See docs/OPENSHELL_AUTHORITY_ADAPTER.md.
 *
 *   atlasent-openshell run --envelope <file|-> [--wait-ms N] [--timeout-ms N]
 *                          [--breaker-state <file>] -- <command> [args...]
 *   atlasent-openshell check [--version <openshell-version>]
 *
 * `run` prints one JSON result line to stderr (stdout belongs to the command)
 * and exits with the command's own code, or 77 DENY, 75 HOLD unresolved,
 * 125 outcome unknown (tripped), 126 not started, 64 usage, 70 internal.
 */

import { readFileSync } from "node:fs";

import { assessOpenShellVersion, OpenShellAuthorityAdapter } from "./openshell.js";
import { CircuitBreaker } from "./governedAction.js";
import { getMode, recordCircuitTrip } from "./engine.js";
import { dropEmptyAtlasentEnv } from "./hostEnv.js";
import { EXIT, parseSandboxContext, runGoverned, sandboxContextFrom } from "./openshellRun.js";

export interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
  argv: string[];
}

export function parseArgs(args: string[]): ParsedArgs | { error: string } {
  const [command, ...rest] = args;
  if (command !== "run" && command !== "check") return { error: `unknown command ${command ?? "(none)"}; expected run | check` };
  const flags: Record<string, string> = {};
  let i = 0;
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") {
      i++;
      break;
    }
    if (!a.startsWith("--")) return { error: `unexpected argument ${a}; put the command after --` };
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${a} needs a value` };
    flags[a.slice(2)] = value;
    i++;
  }
  return { command, flags, argv: rest.slice(i) };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The AtlaSent call carries the API key, so it must go over TLS. A plaintext
 * base URL is refused unless it is loopback (a local runtime under test). A
 * URL that does not parse is refused too: a destination we cannot establish is
 * not one we send a key to. See NVIDIA/OpenShell#4397.
 * Returns a refusal reason, or undefined when the transport is acceptable.
 */
export function checkAtlasentTransport(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.ATLASENT_BASE_URL ?? "https://api.atlasent.io/functions/v1";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `ATLASENT_BASE_URL is not a valid URL; refusing to send the AtlaSent key to it.`;
  }
  if (url.hostname === "") return "ATLASENT_BASE_URL has no host; refusing to send the AtlaSent key.";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return undefined;
  return `ATLASENT_BASE_URL must be https (got ${url.protocol}//${url.host}); refusing to send the AtlaSent key over it.`;
}

/** Same rule as engine.getMode(), read from the env main() was given. */
function remoteModeIn(env: NodeJS.ProcessEnv): boolean {
  const explicit = env.ATLASENT_MODE?.toLowerCase();
  if (explicit === "remote") return true;
  if (explicit === "local") return false;
  return Boolean(env.ATLASENT_API_KEY);
}

function intFlag(flags: Record<string, string>, name: string): number | undefined | { error: string } {
  if (flags[name] === undefined) return undefined;
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < 0) return { error: `--${name} must be a non-negative integer` };
  return n;
}

export async function main(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseArgs(args);
  const emit = (obj: unknown) => process.stderr.write(`${JSON.stringify(obj)}\n`);
  if ("error" in parsed) {
    emit({ outcome: "USAGE", reasons: [parsed.error] });
    return EXIT.USAGE;
  }
  dropEmptyAtlasentEnv(env);

  if (parsed.command === "check") {
    const sandbox = parseSandboxContext(sandboxContextFrom(env, (p) => readFileSync(p, "utf8"))());
    const version = parsed.flags.version ?? env.OPENSHELL_VERSION;
    emit({
      mode: getMode(),
      sandbox: sandbox.ok ? sandbox.sandbox : { error: sandbox.reason },
      openshell_version: version ?? null,
      openshell_assessment: version ? assessOpenShellVersion(version) : null,
    });
    return sandbox.ok ? 0 : EXIT.USAGE;
  }

  if (remoteModeIn(env)) {
    const refused = checkAtlasentTransport(env);
    if (refused) {
      emit({ outcome: "DENY", reasons: [refused] });
      return EXIT.DENY;
    }
  }

  const wait = intFlag(parsed.flags, "wait-ms");
  const timeout = intFlag(parsed.flags, "timeout-ms");
  for (const v of [wait, timeout]) {
    if (typeof v === "object") {
      emit({ outcome: "USAGE", reasons: [v.error] });
      return EXIT.USAGE;
    }
  }
  const source = parsed.flags.envelope;
  if (!source) {
    emit({ outcome: "USAGE", reasons: ["--envelope <file|-> is required"] });
    return EXIT.USAGE;
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(readFileSync(source === "-" ? 0 : source, "utf8"));
  } catch (err) {
    emit({ outcome: "USAGE", reasons: [`could not read envelope: ${err instanceof Error ? err.message : String(err)}`] });
    return EXIT.USAGE;
  }

  try {
    const breaker = parsed.flags["breaker-state"] ? new CircuitBreaker({ stateFile: parsed.flags["breaker-state"] }) : undefined;
    const result = await runGoverned(
      {
        adapter: new OpenShellAuthorityAdapter(),
        sandbox: sandboxContextFrom(env, (p) => readFileSync(p, "utf8")),
        reportTrip: recordCircuitTrip,
        ...(breaker && { breaker }),
      },
      {
        envelope,
        argv: parsed.argv,
        ...(typeof wait === "number" && { wait_ms: wait }),
        ...(typeof timeout === "number" && { timeout_ms: timeout }),
      },
    );
    emit(result);
    return result.exit_code;
  } catch (err) {
    emit({ outcome: "DENY", reasons: [`internal error: ${err instanceof Error ? err.message : String(err)}`] });
    return EXIT.INTERNAL;
  }
}

const invokedDirectly = process.argv[1] && /openshellCli\.(js|ts)$|atlasent-openshell$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
