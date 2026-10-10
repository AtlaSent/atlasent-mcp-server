/**
 * LIVE OpenShell transport-identity acceptance probe (NVIDIA/OpenShell#4397).
 * Opt-in, never part of `npm test`: it needs a real OpenShell install with the
 * AtlaSent workload guard registered as supervisor middleware.
 *
 *   OPENSHELL_VERSION=<x.y.z>               required; recorded in the report
 *   OPENSHELL_TRANSPORT_PROBE_CMD="<sh>"    required; called once per case with
 *                                           the case as $1: `tls` (HTTPS through
 *                                           the sandbox) or `plaintext_tunnel`
 *                                           (plain HTTP inside a CONNECT tunnel,
 *                                           e.g. `curl -p -x "$HTTPS_PROXY"
 *                                           http://...`). It prints either
 *                                           {"reported_scheme":"..."} or the
 *                                           workload guard's log lines for that
 *                                           request; the guard logs the scheme
 *                                           OpenShell reported.
 *
 *   npm run test:openshell-transport-acceptance
 *
 * Pass = TLS reported as https AND tunnelled plaintext reported as http. Every
 * OpenShell release up to and including 0.1.3-pre.4 is expected to FAIL here
 * with defect_4397 (plaintext reported as https). That failure is the positive
 * control: record a release in OPENSHELL_TRANSPORT_IDENTITY_CONFIRMED only
 * after it passes, and record the failing run on an older release beside it.
 * The probe never sends the AtlaSent key: point it at a stub destination.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  assessOpenShellVersion,
  reportedSchemeFromGuardLog,
  runTransportIdentityProbe,
  type TransportObservation,
} from "./openshell.js";

const run = promisify(execFile);
const probeCmd = process.env.OPENSHELL_TRANSPORT_PROBE_CMD;
const version = process.env.OPENSHELL_VERSION;
const skip = !probeCmd || !version ? "set OPENSHELL_VERSION and OPENSHELL_TRANSPORT_PROBE_CMD to run" : false;

function observationFrom(stdout: string): TransportObservation {
  for (const line of stdout.split("\n").reverse()) {
    try {
      const v = (JSON.parse(line) as { reported_scheme?: unknown }).reported_scheme;
      if (typeof v === "string" && v !== "") return { observed: true, reported_scheme: v };
    } catch {
      /* not JSON */
    }
  }
  const fromLog = reportedSchemeFromGuardLog(stdout);
  return fromLog ? { observed: true, reported_scheme: fromLog } : { observed: false, detail: "no reported scheme in probe output" };
}

describe("OpenShell transport identity acceptance (live, NVIDIA/OpenShell#4397)", { skip }, () => {
  it("middleware is told the scheme the request actually travelled over", { timeout: 120_000 }, async () => {
    const report = await runTransportIdentityProbe({
      send: async (c) => {
        const { stdout } = await run("sh", ["-c", probeCmd as string, "probe", c], { timeout: 30_000 });
        return observationFrom(stdout);
      },
    });
    console.log(JSON.stringify({ openshell_version: version, assessment: assessOpenShellVersion(version as string), report }, null, 2));
    assert.ok(report.passed, `transport-identity probe failed: ${JSON.stringify(report.results)}`);
  });
});
