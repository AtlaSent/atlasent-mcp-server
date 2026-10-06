/**
 * LIVE OpenShell startup policy-generation acceptance probe. Opt-in, never part
 * of `npm test`: it needs a real OpenShell install with the AtlaSent provider
 * profile attached (examples/openshell/).
 *
 *   OPENSHELL_VERSION=<x.y.z>                 required; recorded in the report
 *   OPENSHELL_ACCEPTANCE_START_CMD="<sh>"     optional; creates/starts the sandbox.
 *                                             The 20s window starts when it exits.
 *   OPENSHELL_ACCEPTANCE_PROBE_CMD="<sh>"     required; sends ONE AtlaSent-governed
 *                                             request through the sandbox. Exit 0 =
 *                                             success. It may print a JSON line
 *                                             {"policy_generation": N} to report the
 *                                             generation it observed.
 *
 *   npm run test:openshell-acceptance
 *
 * Pass = every request across the first 20s succeeded. A known-affected
 * OpenShell (0.1.2, NVIDIA/OpenShell#3994) is expected to fail here, and a pass
 * on it is NOT recorded as acceptance evidence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { assessOpenShellVersion, runStartupGenerationProbe, type ProbeAttempt } from "./openshell.js";

const run = promisify(execFile);
const probeCmd = process.env.OPENSHELL_ACCEPTANCE_PROBE_CMD;
const startCmd = process.env.OPENSHELL_ACCEPTANCE_START_CMD;
const version = process.env.OPENSHELL_VERSION;

const skip = !probeCmd || !version ? "set OPENSHELL_VERSION and OPENSHELL_ACCEPTANCE_PROBE_CMD to run" : false;

function classify(text: string): "dropped" | "denied" | "error" {
  // curl (52) "Empty reply from server" is how 0.1.2's stale-generation drop surfaces.
  if (/closed connection|connection reset|ECONNRESET|EPIPE|empty reply from server|curl: \(52\)/i.test(text)) return "dropped";
  if (/policy|denied|403/i.test(text)) return "denied";
  return "error";
}

function generationFrom(stdout: string): string | number | undefined {
  for (const line of stdout.split("\n").reverse()) {
    try {
      const v = (JSON.parse(line) as { policy_generation?: unknown }).policy_generation;
      if (typeof v === "string" || typeof v === "number") return v;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

describe("OpenShell startup policy-generation acceptance (live)", { skip }, () => {
  it("no request is dropped or denied across the sandbox's first 20 seconds", { timeout: 120_000 }, async () => {
    if (startCmd) await run("sh", ["-c", startCmd], { timeout: 60_000 });
    const send = async (): Promise<ProbeAttempt> => {
      try {
        const { stdout } = await run("sh", ["-c", probeCmd as string], { timeout: 15_000 });
        return { ok: true, policy_generation: generationFrom(stdout) };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const text = `${e.stderr ?? ""}\n${e.stdout ?? ""}\n${e.message ?? ""}`;
        return { ok: false, kind: classify(text), detail: text.trim().slice(0, 300), policy_generation: generationFrom(e.stdout ?? "") };
      }
    };
    const report = await runStartupGenerationProbe({ send, duration_ms: 20_000, interval_ms: 500 });
    const assessment = assessOpenShellVersion(version as string);
    console.log(JSON.stringify({ openshell_version: version, assessment, report }, null, 2));
    assert.ok(report.passed, `startup probe failed: ${JSON.stringify(report.failures)}`);
    assert.notEqual(
      assessment.status,
      "known_affected",
      `probe passed, but OpenShell ${version} is known-affected (${assessment.reason}); not acceptance evidence`,
    );
  });
});
