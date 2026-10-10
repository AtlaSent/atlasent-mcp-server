#!/usr/bin/env node
// Recording stub of the AtlaSent API for live OpenShell runs. NOT the runtime.
//
// It stands where api.atlasent.io would, behind the OpenShell provider profile
// and the AtlaSent workload guard, and records what actually arrived:
//   - the body bytes, their sha256 and whether Content-Length matches them
//     (the guard may replace the body; OpenShell must re-frame it);
//   - whether an Authorization header arrived, as a short hash prefix only
//     (the real key must never be logged);
//   - the x-atlasent-workload-attestation, decoded, with its signature checked
//     against the guard public key when one is given, and its body_sha256
//     compared with the bytes received;
//   - the workload the body names.
// It answers like a runtime whose key is flagged requires_workload_attestation:
// evaluate/verify without a verified, matching attestation get 401; with one,
// evaluate returns an allow carrying workload_attested: true.
//
//   node stub-atlasent.mjs --http-port 18080 [--https-port 18443 --cert c.pem --key k.pem]
//                          [--guard-public-key guard.pub.pem] [--log stub.jsonl]

import { createHash, createPublicKey, verify } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const ATTESTATION_HEADER = "x-atlasent-workload-attestation";

function b64urlJson(s) {
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
}

/** Decode and check a guard attestation against the bytes received. */
export function inspectAttestation(header, body, publicKey) {
  if (typeof header !== "string" || header === "") return { present: false };
  const parts = header.split(".");
  if (parts.length !== 3) return { present: true, well_formed: false };
  let payload;
  try {
    b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    return { present: true, well_formed: false };
  }
  const bodySha = createHash("sha256").update(body).digest("hex");
  const out = {
    present: true,
    well_formed: true,
    sandbox_id: payload.sandbox_id,
    body_sha256_matches: payload.body_sha256 === bodySha,
  };
  if (publicKey) {
    out.signature_valid = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"));
  }
  return out;
}

function workloadOf(path, parsed) {
  if (!parsed || typeof parsed !== "object") return undefined;
  if (/v1-verify-permit$/.test(path)) return parsed.workload;
  return parsed.context?.workload;
}

/**
 * Build the request handler. `record` receives one plain object per request.
 * `publicKey` (optional KeyObject) turns on signature checking and the
 * flagged-key answers; without it every attestation counts as unverified.
 */
export function createHandler({ record, publicKey, scheme }) {
  let n = 0;
  return (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let parsed;
      try {
        parsed = body.length ? JSON.parse(body.toString("utf8")) : undefined;
      } catch {
        parsed = undefined;
      }
      const auth = req.headers.authorization;
      const att = inspectAttestation(req.headers[ATTESTATION_HEADER], body, publicKey);
      const declared = req.headers["content-length"];
      const rec = {
        ts: new Date().toISOString(),
        scheme,
        method: req.method,
        path: req.url,
        content_length: declared === undefined ? null : Number(declared),
        body_bytes: body.length,
        content_length_matches: declared === undefined ? null : Number(declared) === body.length,
        body_sha256: createHash("sha256").update(body).digest("hex"),
        authorization: auth ? { present: true, sha256_prefix: createHash("sha256").update(auth).digest("hex").slice(0, 8) } : { present: false },
        attestation: att,
        workload: workloadOf(req.url ?? "", parsed),
        body: parsed ?? null,
      };
      record(rec);

      const attested = att.present && att.well_formed && att.body_sha256_matches && att.signature_valid === true;
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const path = String(req.url ?? "");
      if (/v1-evaluate$/.test(path) || /v1-verify-permit$/.test(path)) {
        if (!attested) return send(401, { error: "workload_attestation_missing_or_invalid", stub: true });
        n += 1;
        if (/v1-evaluate$/.test(path)) {
          return send(200, { decision: "allow", permit_token: `pt_stub_${n}`, request_id: `stub-${n}`, workload_attested: true });
        }
        return send(200, { valid: true, outcome: "verified" });
      }
      return send(404, { error: "not_found", stub: true });
    });
  };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const invokedDirectly = process.argv[1] && /stub-atlasent\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const logPath = arg("log") ?? "stub.jsonl";
  const pubPath = arg("guard-public-key");
  const publicKey = pubPath ? createPublicKey(readFileSync(pubPath)) : undefined;
  const record = (rec) => {
    appendFileSync(logPath, `${JSON.stringify(rec)}\n`);
    process.stderr.write(`${rec.method} ${rec.path} attested=${rec.attestation.signature_valid === true && rec.attestation.body_sha256_matches === true}\n`);
  };
  const httpPort = Number(arg("http-port") ?? 18080);
  http.createServer(createHandler({ record, publicKey, scheme: "http" })).listen(httpPort, () => process.stderr.write(`stub http on ${httpPort}\n`));
  const httpsPort = arg("https-port");
  if (httpsPort) {
    const opts = { cert: readFileSync(arg("cert")), key: readFileSync(arg("key")) };
    https.createServer(opts, createHandler({ record, publicKey, scheme: "https" })).listen(Number(httpsPort), () => process.stderr.write(`stub https on ${httpsPort}\n`));
  }
  if (!publicKey) process.stderr.write("WARNING: no --guard-public-key; every attestation is treated as unverified\n");
}
