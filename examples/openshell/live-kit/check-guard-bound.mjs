#!/usr/bin/env node
// Turn a stub-atlasent.mjs log into a pass/fail report for the guard-bound
// live run (docs/OPENSHELL_AUTHORITY_ADAPTER.md, guard-bound mode).
//
//   node check-guard-bound.mjs --log stub.jsonl --sandbox-id <id> [--since <iso>]
//
// For the honest run, every evaluate and verify record must show: the
// workload the guard filled in names the real sandbox; the attestation is
// present, signed by the guard and covers the exact bytes received; the
// Content-Length OpenShell sent matches those bytes; an Authorization header
// arrived. Exit 0 on pass, 1 on fail, 2 when there is nothing to check (a
// run that reached nothing has proved nothing).

import { readFileSync } from "node:fs";

export function checkGuardBound(records, { sandboxId }) {
  const relevant = records.filter((r) => /v1-(evaluate|verify-permit)$/.test(String(r.path)));
  const results = relevant.map((r) => {
    const failures = [];
    if (r.workload?.kind !== "openshell_sandbox") failures.push("workload kind is not openshell_sandbox");
    if (r.workload?.id !== sandboxId) failures.push(`workload id is ${JSON.stringify(r.workload?.id)}, expected ${sandboxId}`);
    if (!r.attestation?.present) failures.push("no attestation header");
    else {
      if (r.attestation.signature_valid !== true) failures.push("attestation signature not verified (was --guard-public-key given?)");
      if (r.attestation.body_sha256_matches !== true) failures.push("attestation body_sha256 does not match the bytes received");
      if (r.attestation.sandbox_id !== sandboxId) failures.push(`attestation names ${JSON.stringify(r.attestation.sandbox_id)}`);
    }
    if (r.content_length_matches === false) failures.push(`Content-Length ${r.content_length} but ${r.body_bytes} bytes arrived`);
    if (!r.authorization?.present) failures.push("no Authorization header (credential injection did not happen)");
    return { path: r.path, ts: r.ts, ok: failures.length === 0, failures };
  });
  const sawEvaluate = relevant.some((r) => /v1-evaluate$/.test(String(r.path)));
  const status = relevant.length === 0 || !sawEvaluate ? "nothing_to_check" : results.every((x) => x.ok) ? "pass" : "fail";
  return { status, checked: results.length, results };
}

export function readLog(path, since) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => !since || r.ts >= since);
}

const invokedDirectly = process.argv[1] && /check-guard-bound\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const a = (n) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const report = checkGuardBound(readLog(a("log") ?? "stub.jsonl", a("since")), { sandboxId: a("sandbox-id") });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.status === "pass" ? 0 : report.status === "fail" ? 1 : 2);
}
