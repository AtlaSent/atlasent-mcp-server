// Offline tests for the OpenShell live-run kit. They prove the kit's own
// logic (stub recording, attestation checks, the checker's verdicts, the probe
// script's log handling). They do not and cannot prove anything about
// OpenShell: that is what the live runs are for.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHandler, inspectAttestation } from "./stub-atlasent.mjs";
import { checkGuardBound } from "./check-guard-bound.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SBX = "sbx-live-kit-1";
const guard = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");

function attest(body, { key = guard.privateKey, sandbox = SBX, sha } = {}) {
  const input = `${b64({ alg: "EdDSA", typ: "atlasent-workload-attestation+jwt", kid: "g" })}.${b64({
    v: 1,
    sandbox_id: sandbox,
    body_sha256: sha ?? createHash("sha256").update(body).digest("hex"),
  })}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
}

async function withStub(fn) {
  const records = [];
  const server = http.createServer(createHandler({ record: (r) => records.push(r), publicKey: guard.publicKey, scheme: "http" }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, records);
  } finally {
    server.close();
  }
}

const evalBody = (id = SBX) => JSON.stringify({ action_type: "x", context: { workload: { kind: "openshell_sandbox", id } } });

describe("stub-atlasent", () => {
  it("answers a verified, matching attestation like a flagged runtime, and records what arrived", async () => {
    await withStub(async (base, records) => {
      const body = evalBody();
      const res = await fetch(`${base}/functions/v1/v1-evaluate`, {
        method: "POST",
        headers: { authorization: "Bearer real-key", "x-atlasent-workload-attestation": attest(body) },
        body,
      });
      assert.equal(res.status, 200);
      const out = await res.json();
      assert.equal(out.workload_attested, true);
      assert.equal(out.decision, "allow");
      const r = records[0];
      assert.equal(r.attestation.signature_valid, true);
      assert.equal(r.attestation.body_sha256_matches, true);
      assert.equal(r.content_length_matches, true);
      assert.deepEqual(r.workload, { kind: "openshell_sandbox", id: SBX });
      assert.equal(r.authorization.present, true);
      assert.equal(JSON.stringify(r).includes("real-key"), false, "the key itself is never recorded");
    });
  });

  it("refuses a missing, foreign-signed or wrong-body attestation with 401", async () => {
    await withStub(async (base) => {
      const body = evalBody();
      for (const header of [undefined, attest(body, { key: other.privateKey }), attest(body, { sha: "0".repeat(64) }), "a.b"]) {
        const res = await fetch(`${base}/functions/v1/v1-evaluate`, {
          method: "POST",
          headers: header ? { "x-atlasent-workload-attestation": header } : {},
          body,
        });
        assert.equal(res.status, 401, String(header).slice(0, 20));
      }
    });
  });

  it("flags a Content-Length that does not match the bytes", () => {
    const body = Buffer.from(evalBody());
    const a = inspectAttestation(attest(body), Buffer.concat([body, Buffer.from(" ")]), guard.publicKey);
    assert.equal(a.body_sha256_matches, false, "a re-framed or altered body breaks the hash");
  });
});

describe("check-guard-bound", () => {
  const good = {
    path: "/functions/v1/v1-evaluate",
    workload: { kind: "openshell_sandbox", id: SBX },
    attestation: { present: true, well_formed: true, signature_valid: true, body_sha256_matches: true, sandbox_id: SBX },
    content_length_matches: true,
    authorization: { present: true },
  };
  it("passes a clean run", () => {
    assert.equal(checkGuardBound([good, { ...good, path: "/functions/v1/v1-verify-permit" }], { sandboxId: SBX }).status, "pass");
  });
  it("fails each defect it exists to catch", () => {
    for (const bad of [
      { ...good, workload: { kind: "openshell_sandbox", id: "sbx-other" } },
      { ...good, workload: undefined },
      { ...good, attestation: { present: false } },
      { ...good, attestation: { ...good.attestation, signature_valid: false } },
      { ...good, attestation: { ...good.attestation, body_sha256_matches: false } },
      { ...good, content_length_matches: false, content_length: 10, body_bytes: 12 },
      { ...good, authorization: { present: false } },
    ]) {
      assert.equal(checkGuardBound([bad], { sandboxId: SBX }).status, "fail", JSON.stringify(bad).slice(0, 80));
    }
  });
  it("a run that reached nothing, or only verify, has proved nothing", () => {
    assert.equal(checkGuardBound([], { sandboxId: SBX }).status, "nothing_to_check");
    assert.equal(checkGuardBound([{ ...good, path: "/functions/v1/v1-verify-permit" }], { sandboxId: SBX }).status, "nothing_to_check");
    assert.equal(checkGuardBound([{ ...good, path: "/other" }], { sandboxId: SBX }).status, "nothing_to_check");
  });
  it("the CLI exits 0 / 1 / 2 for pass / fail / nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-"));
    const run = (recs) => {
      const log = join(dir, `l${Math.random()}.jsonl`);
      writeFileSync(log, recs.map((r) => JSON.stringify({ ts: "2026-10-10T00:00:01.000Z", ...r })).join("\n") + "\n");
      try {
        execFileSync("node", [join(HERE, "check-guard-bound.mjs"), "--log", log, "--sandbox-id", SBX], { stdio: "pipe" });
        return 0;
      } catch (e) {
        return e.status;
      }
    };
    assert.equal(run([good]), 0);
    assert.equal(run([{ ...good, workload: undefined }]), 1);
    assert.equal(run([{ ...good, path: "/x" }]), 2);
  });
});

describe("probe-transport.sh", () => {
  // A fake OSH_EXEC that, instead of entering a sandbox, appends the guard log
  // line a real guard would write, with the scheme it would have been told.
  function fakeExec(dir, guardLog, scheme) {
    const p = join(dir, "fake-exec.sh");
    writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' '{"component":"atlasent-workload-guard","scheme":"${scheme}"}' >> "${guardLog}"\n`);
    return `sh ${p}`;
  }
  const run = (env, arg) =>
    execFileSync("sh", [join(HERE, "probe-transport.sh"), arg], { env: { ...process.env, ...env }, encoding: "utf8" });

  it("prints only the guard lines written during this request", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    const log = join(dir, "guard.log");
    writeFileSync(log, `${JSON.stringify({ component: "atlasent-workload-guard", scheme: "STALE" })}\n`);
    const out = run({ OSH_EXEC: fakeExec(dir, log, "http"), GUARD_LOG: log, PROBE_HOST: "stub:18080" }, "plaintext_tunnel");
    assert.equal(out.includes("STALE"), false, "an earlier request's line must not be read as this one's");
    assert.equal(JSON.parse(out.trim().split("\n").pop()).scheme, "http");
    appendFileSync(log, "");
  });

  it("refuses an unknown case and missing configuration", () => {
    assert.throws(() => run({ OSH_EXEC: "true", GUARD_LOG: "/dev/null", PROBE_HOST: "x" }, "udp"));
    assert.throws(() => run({ OSH_EXEC: "", GUARD_LOG: "/dev/null", PROBE_HOST: "x" }, "tls"));
    assert.throws(() => run({ OSH_EXEC: "true", GUARD_LOG: "/dev/null", PROBE_HOST: "" }, "tls"));
  });

  it("its output feeds the transport acceptance harness unchanged", async () => {
    const { reportedSchemeFromGuardLog } = await import("../../../src/openshell.ts");
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    const log = join(dir, "guard.log");
    writeFileSync(log, "");
    const out = run({ OSH_EXEC: fakeExec(dir, log, "https"), GUARD_LOG: log, PROBE_HOST: "stub:18443" }, "tls");
    assert.equal(reportedSchemeFromGuardLog(out), "https");
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
  });
});
