import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import * as grpc from "@grpc/grpc-js";

import {
  ATTESTATION_HEADER,
  GuardDenial,
  checkRequest,
  loadJwks,
  parseStrictJson,
  signAttestation,
  verifyGatewayToken,
} from "../guard.mjs";
import { createHandlers, loadService, startServer } from "../server.mjs";

const ISSUER = "openshell-gateway:gw-test";
const AUD = "urn:atlasent:openshell:workload-guard";
const SBX = "sbx-0b9a6f1e";
const NOW = 1_790_000_000_000;

const gw = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const jwks = { keys: [{ ...gw.publicKey.export({ format: "jwk" }), kid: "gw-kid-1" }] };
const keys = loadJwks(jwks);
const att = generateKeyPairSync("ed25519");

const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
function token(claims = {}, header = {}, key = gw.privateKey) {
  const h = { alg: "EdDSA", typ: "openshell-ext+jwt", kid: "gw-kid-1", ...header };
  const c = {
    iss: ISSUER,
    aud: AUD,
    sub: "supervisor",
    iat: NOW / 1000 - 10,
    exp: NOW / 1000 + 600,
    jti: "j1",
    caller_kind: "supervisor",
    sandbox_id: SBX,
    ...claims,
  };
  const input = `${b64(h)}.${b64(c)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
}
const vt = (t) => verifyGatewayToken(t, { keys, issuer: ISSUER, audience: AUD, now: NOW });
const denies = (fn, code) =>
  assert.throws(fn, (e) => e instanceof GuardDenial && e.code === code, `expected denial ${code}`);

const evaluateBody = (workload) => Buffer.from(JSON.stringify({ action_type: "x", actor_id: "a", context: { workload } }));
const ctx = { request_id: "r1", sandbox_id: SBX };
const DEST = { host: "api.atlasent.io", port: 443 };
const HTTPS = { scheme: "https", host: "api.atlasent.io", port: 443 };
const evalTarget = { ...HTTPS, method: "POST", path: "/functions/v1/v1-evaluate" };

describe("gateway token", () => {
  it("accepts a valid supervisor token", () => {
    assert.equal(vt(token()).sandbox_id, SBX);
  });
  it("denies each defect", () => {
    denies(() => vt(undefined), "caller_unauthenticated");
    denies(() => vt("a.b"), "caller_unauthenticated");
    denies(() => vt(token({}, {}, other.privateKey)), "caller_unauthenticated");
    denies(() => vt(token({}, { kid: "nope" })), "caller_unauthenticated");
    denies(() => vt(token({}, { alg: "none" })), "caller_unauthenticated");
    denies(() => vt(token({}, { typ: "JWT" })), "caller_unauthenticated");
    denies(() => vt(token({ exp: NOW / 1000 - 600 })), "caller_unauthenticated");
    denies(() => vt(token({ iat: NOW / 1000 + 600 })), "caller_unauthenticated");
    denies(() => vt(token({ iss: "https://gateway.example" })), "caller_unauthenticated");
    denies(() => vt(token({ aud: "urn:openshell:extension:middleware:other" })), "caller_unauthenticated");
    denies(() => vt(token({ caller_kind: "gateway" })), "caller_not_supervisor");
    denies(() => vt(token({ sandbox_id: undefined })), "caller_unauthenticated");
  });
  it("rejects a tampered payload even with a valid signature on the original", () => {
    const [h, , s] = token().split(".");
    denies(() => vt(`${h}.${b64({ caller_kind: "supervisor", sandbox_id: "sbx-other", iss: ISSUER, aud: AUD, exp: NOW / 1000 + 600 })}.${s}`), "caller_unauthenticated");
  });
});

describe("request check", () => {
  const claims = { sandbox_id: SBX };
  it("allows evaluate naming the signed sandbox", () => {
    const r = checkRequest({ destination: DEST, claims, context: ctx, target: evalTarget, body: evaluateBody({ kind: "openshell_sandbox", id: SBX }) });
    assert.equal(r.sandbox_id, SBX);
  });
  it("denies a forged sandbox id: the attack this guard exists for", () => {
    denies(
      () => checkRequest({ destination: DEST, claims, context: ctx, target: evalTarget, body: evaluateBody({ kind: "openshell_sandbox", id: "sbx-victim" }) }),
      "workload_mismatch",
    );
  });
  it("denies a missing workload, a wrong kind and a non-JSON body", () => {
    denies(() => checkRequest({ destination: DEST, claims, context: ctx, target: evalTarget, body: evaluateBody(undefined) }), "workload_missing");
    denies(() => checkRequest({ destination: DEST, claims, context: ctx, target: evalTarget, body: evaluateBody({ kind: "k8s_pod", id: SBX }) }), "workload_mismatch");
    denies(() => checkRequest({ destination: DEST, claims, context: ctx, target: evalTarget, body: Buffer.from("not json") }), "body_not_json");
    denies(() => checkRequest({ destination: DEST, claims, context: ctx, target: evalTarget, body: Buffer.from("[]") }), "body_not_json");
  });
  it("denies a duplicate workload key, which two parsers could read differently", () => {
    const body = Buffer.from(
      `{"context":{"workload":{"kind":"openshell_sandbox","id":"sbx-victim"},"workload":{"kind":"openshell_sandbox","id":"${SBX}"}}}`,
    );
    denies(() => checkRequest({ destination: DEST, claims, context: ctx, target: evalTarget, body }), "body_duplicate_key");
  });
  it("checks verify-permit's top-level workload", () => {
    const target = { ...HTTPS, method: "POST", path: "/functions/v1/v1-verify-permit" };
    const ok = Buffer.from(JSON.stringify({ permit_token: "p", workload: { kind: "openshell_sandbox", id: SBX } }));
    assert.equal(checkRequest({ destination: DEST, claims, context: ctx, target, body: ok }).sandbox_id, SBX);
    const bad = Buffer.from(JSON.stringify({ permit_token: "p", workload: { kind: "openshell_sandbox", id: "sbx-victim" } }));
    denies(() => checkRequest({ destination: DEST, claims, context: ctx, target, body: bad }), "workload_mismatch");
    const nested = Buffer.from(JSON.stringify({ permit_token: "p", context: { workload: { kind: "openshell_sandbox", id: SBX } } }));
    denies(() => checkRequest({ destination: DEST, claims, context: ctx, target, body: nested }), "workload_missing");
  });
  it("denies a context whose sandbox differs from the token", () => {
    denies(
      () => checkRequest({ destination: DEST, claims, context: { sandbox_id: "sbx-other" }, target: evalTarget, body: evaluateBody({ kind: "openshell_sandbox", id: SBX }) }),
      "context_mismatch",
    );
  });
  it("allows the profile's other paths without a workload, and denies anything else", () => {
    for (const [method, path] of [
      ["GET", "/functions/v1/v1-approvals/abc"],
      ["POST", "/functions/v1/v1-approvals/abc/claim-permit"],
      ["POST", "/functions/v1/v1-agent-actor-identity"],
      ["POST", "/functions/v1/v1-source-provenance-seal"],
      ["POST", "/functions/v1/v1-change-brief"],
      ["POST", "/functions/v1/v1-agent-circuit-trips"],
    ]) {
      assert.ok(checkRequest({ destination: DEST, claims, context: ctx, target: { ...HTTPS, method, path }, body: Buffer.alloc(0) }));
    }
    for (const [method, path] of [
      ["GET", "/functions/v1/v1-evaluate"],
      ["POST", "/functions/v1/v1-api-keys"],
      ["POST", "/functions/v1/v1-approvals/abc/claim-permit/extra"],
      ["DELETE", "/functions/v1/v1-approvals/abc"],
    ]) {
      denies(() => checkRequest({ destination: DEST, claims, context: ctx, target: { ...HTTPS, method, path }, body: Buffer.alloc(0) }), "path_not_allowed");
    }
  });
});

describe("strict JSON", () => {
  it("parses ordinary JSON, including keys inside arrays and escaped quotes", () => {
    assert.deepEqual(parseStrictJson('{"a":[{"b":1},{"b":2}],"c":"x\\":y"}'), { a: [{ b: 1 }, { b: 2 }], c: 'x":y' });
  });
  it("finds a duplicate at any depth", () => {
    assert.throws(() => parseStrictJson('{"a":{"b":1,"b":2}}'), GuardDenial);
    assert.throws(() => parseStrictJson('{"a":1,"a":1}'), GuardDenial);
    assert.throws(() => parseStrictJson('{"a":1,"\\u0061":1}'), GuardDenial, "an escaped spelling is the same key");
  });
});

describe("attestation", () => {
  it("binds the sandbox to the exact body bytes", () => {
    const body = evaluateBody({ kind: "openshell_sandbox", id: SBX });
    const jws = signAttestation({ signingKey: att.privateKey, kid: "guard-1", sandboxId: SBX, requestId: "r1", method: "POST", path: "/functions/v1/v1-evaluate", body, now: NOW, jti: "j-1" });
    const [h, p, s] = jws.split(".");
    assert.ok(verify(null, Buffer.from(`${h}.${p}`), att.publicKey, Buffer.from(s, "base64url")));
    const header = JSON.parse(Buffer.from(h, "base64url"));
    const claims = JSON.parse(Buffer.from(p, "base64url"));
    assert.deepEqual(header, { alg: "EdDSA", typ: "atlasent-workload-attestation+jwt", kid: "guard-1" });
    assert.equal(claims.sandbox_id, SBX);
    assert.equal(claims.aud, "atlasent-runtime");
    assert.equal(claims.body_sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(claims.exp - claims.iat, 60);
  });
});

describe("gRPC service", () => {
  let server;
  let client;
  before(async () => {
    const cfg = { listen: "127.0.0.1:0", audience: AUD, destination: DEST, gateway: { issuer: ISSUER, keys }, attestation: { signingKey: att.privateKey, kid: "guard-1" }, now: () => NOW };
    const started = await startServer(cfg);
    server = started.server;
    const Svc = loadService();
    client = new Svc(`127.0.0.1:${started.port}`, grpc.credentials.createInsecure());
  });
  after(() => {
    client?.close();
    server?.forceShutdown();
  });
  const call = (method, req, bearer) =>
    new Promise((resolve, reject) => {
      const md = new grpc.Metadata();
      if (bearer) md.set("authorization", `Bearer ${bearer}`);
      client[method](req, md, (err, res) => (err ? reject(err) : resolve(res)));
    });
  const gatewayMeta = {
    protocol_version: { major: 1, minor: 0 },
    implementation_name: "openshell/gateway",
    supported_capabilities: ["openshell.supervisor-middleware.contract"],
    required_capabilities: ["openshell.supervisor-middleware.contract"],
  };

  it("Describe negotiates protocol 1.x and states the audience", async () => {
    const m = await call("Describe", { gateway: gatewayMeta });
    assert.equal(m.expected_audience, AUD);
    assert.equal(m.bindings[0].operation, "SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_REQUEST");
    await assert.rejects(call("Describe", { gateway: { ...gatewayMeta, protocol_version: { major: 2, minor: 0 } } }));
    await assert.rejects(call("Describe", {}));
  });

  it("ValidateConfig refuses any configuration", async () => {
    assert.equal((await call("ValidateConfig", { config: { fields: {} } })).valid, true);
    assert.equal((await call("ValidateConfig", { config: { fields: { loosen: { bool_value: true } } } })).valid, false);
  });

  const request = (workloadId) => ({
    phase: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS",
    context: ctx,
    target: { scheme: "https", host: "api.atlasent.io", port: 443, ...evalTarget },
    body: evaluateBody({ kind: "openshell_sandbox", id: workloadId }),
  });

  it("allows the honest request and attaches the attestation header", async () => {
    const r = await call("EvaluateHttpRequest", request(SBX), token());
    assert.equal(r.decision, "DECISION_ALLOW");
    assert.equal(r.header_mutations[0].write.name, ATTESTATION_HEADER);
    assert.equal(r.header_mutations[0].write.on_existing, "EXISTING_HEADER_ACTION_OVERWRITE");
  });

  it("denies a forged sandbox id, a missing token and a wrong phase", async () => {
    const forged = await call("EvaluateHttpRequest", request("sbx-victim"), token());
    assert.equal(forged.decision, "DECISION_DENY");
    assert.equal(forged.reason_code, "workload_mismatch");
    assert.equal(forged.header_mutations.length, 0, "a denial carries no attestation");
    const anon = await call("EvaluateHttpRequest", request(SBX));
    assert.equal(anon.reason_code, "caller_unauthenticated");
    const phase = await call("EvaluateHttpRequest", { ...request(SBX), phase: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_RETURN" }, token());
    assert.equal(phase.reason_code, "unsupported_phase");
  });
});

describe("handlers without attestation", () => {
  it("phase 1 alone allows without a header", () => {
    const h = createHandlers({ audience: AUD, destination: DEST, gateway: { issuer: ISSUER, keys }, now: () => NOW });
    const md = new grpc.Metadata();
    md.set("authorization", `Bearer ${token()}`);
    let out;
    h.EvaluateHttpRequest(
      { request: { phase: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS", context: ctx, target: evalTarget, body: evaluateBody({ kind: "openshell_sandbox", id: SBX }) }, metadata: md },
      (_e, r) => (out = r),
    );
    assert.equal(out.decision, "DECISION_ALLOW");
    assert.equal(out.header_mutations.length, 0);
  });
});

// Transport identity (NVIDIA/OpenShell#4397, opened 2026-10-10). The key is
// injected after this guard allows, so the guard must only allow a request
// bound for the pinned AtlaSent host over https. Each case below is one way
// the reported destination can be wrong or missing; every one must deny, and
// must deny for every route, not only evaluate and verify.
describe("transport identity (NVIDIA/OpenShell#4397)", () => {
  const claims = { sandbox_id: SBX };
  const ok = evaluateBody({ kind: "openshell_sandbox", id: SBX });
  const check = (target, destination = DEST) => checkRequest({ destination, claims, context: ctx, target, body: ok });
  const ROUTES = [
    ["POST", "/functions/v1/v1-evaluate"],
    ["POST", "/functions/v1/v1-verify-permit"],
    ["GET", "/functions/v1/v1-approvals/abc"],
    ["POST", "/functions/v1/v1-approvals/abc/claim-permit"],
    ["POST", "/functions/v1/v1-agent-actor-identity"],
  ];

  it("positive control: https to the pinned host and port allows", () => {
    assert.equal(check(evalTarget).sandbox_id, SBX);
    assert.equal(check({ ...evalTarget, scheme: "HTTPS", host: "API.atlasent.io." }).sandbox_id, SBX, "case and a trailing dot are normalized");
  });

  it("denies plaintext http, on every route", () => {
    for (const [method, path] of ROUTES) {
      const body = path.endsWith("verify-permit") ? Buffer.from(JSON.stringify({ workload: { kind: "openshell_sandbox", id: SBX } })) : ok;
      denies(
        () => checkRequest({ destination: DEST, claims, context: ctx, target: { ...HTTPS, scheme: "http", method, path }, body }),
        "transport_not_secure",
      );
    }
    denies(() => check({ ...evalTarget, scheme: "http", port: 80 }), "transport_not_secure");
  });

  it("denies ws and wss: a WebSocket is never an AtlaSent API request", () => {
    denies(() => check({ ...evalTarget, scheme: "ws" }), "transport_not_http");
    denies(() => check({ ...evalTarget, scheme: "wss" }), "transport_not_http");
  });

  it("denies a scheme, host or port OpenShell did not establish", () => {
    denies(() => check({ ...evalTarget, scheme: "" }), "transport_unknown");
    denies(() => check({ ...evalTarget, scheme: undefined }), "transport_unknown");
    denies(() => check({ ...evalTarget, scheme: "h2c" }), "transport_unknown");
    denies(() => check({ ...evalTarget, host: "" }), "destination_unknown");
    denies(() => check({ ...evalTarget, host: undefined }), "destination_unknown");
    denies(() => check({ ...evalTarget, port: 0 }), "destination_unknown");
    denies(() => check({ ...evalTarget, port: undefined }), "destination_unknown");
  });

  it("denies https to a host or port other than the pinned one", () => {
    denies(() => check({ ...evalTarget, host: "api.atlasent.io.attacker.example" }), "destination_mismatch");
    denies(() => check({ ...evalTarget, host: "attacker.example" }), "destination_mismatch");
    denies(() => check({ ...evalTarget, port: 8443 }), "destination_mismatch");
  });

  it("denies when no destination is pinned, rather than allowing any host", () => {
    denies(() => checkRequest({ destination: undefined, claims, context: ctx, target: evalTarget, body: ok }), "destination_unconfigured");
    denies(() => check(evalTarget, null), "destination_unconfigured");
    denies(() => check(evalTarget, { host: "" }), "destination_unconfigured");
  });

  it("over gRPC: a plaintext request is denied and carries no attestation", async () => {
    const h = createHandlers({ audience: AUD, destination: DEST, gateway: { issuer: ISSUER, keys }, attestation: { signingKey: att.privateKey, kid: "guard-1" }, now: () => NOW });
    const md = new grpc.Metadata();
    md.set("authorization", `Bearer ${token()}`);
    for (const scheme of ["http", "ws", "wss", ""]) {
      let out;
      h.EvaluateHttpRequest(
        { request: { phase: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS", context: ctx, target: { ...evalTarget, scheme }, body: ok }, metadata: md },
        (_e, r) => (out = r),
      );
      assert.equal(out.decision, "DECISION_DENY", `scheme "${scheme}" allowed`);
      assert.equal(out.header_mutations.length, 0, `scheme "${scheme}" got an attestation`);
    }
  });

  it("loadConfig refuses a config with no pinned destination", async () => {
    const { loadConfig } = await import("../server.mjs");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    const jwksPath = join(dir, "jwks.json");
    writeFileSync(jwksPath, JSON.stringify(jwks));
    const base = { listen: "127.0.0.1:0", audience: AUD, gateway: { issuer: ISSUER, jwks_path: jwksPath }, allow_insecure_transport: true };
    assert.throws(() => loadConfig(base), /destination\.host is required/);
    assert.throws(() => loadConfig({ ...base, destination: { host: "api.atlasent.io", port: 70000 } }), /TCP port/);
    assert.deepEqual(loadConfig({ ...base, destination: { host: "api.atlasent.io" } }).destination, DEST);
  });
});

// Streaming middleware (NVIDIA/OpenShell#4359, revised 2026-10-10) is not
// adopted. Its security review found a request could complete before the final
// middleware verdict and a response could be delivered after revocation. Until
// NVIDIA qualifies it, the guard speaks only the buffered unary HTTP request
// binding, where OpenShell holds the whole request until the verdict returns.
describe("streaming middleware is not adopted (NVIDIA/OpenShell#4359)", () => {
  const gatewayMeta = {
    protocol_version: { major: 1, minor: 0 },
    implementation_name: "openshell/gateway",
    supported_capabilities: ["openshell.supervisor-middleware.contract"],
    required_capabilities: ["openshell.supervisor-middleware.contract"],
  };
  const h = createHandlers({ audience: AUD, destination: DEST, gateway: { issuer: ISSUER, keys }, now: () => NOW });
  const describeWith = (gateway) => {
    let res;
    h.Describe({ request: { gateway } }, (err, m) => (res = { err, m }));
    return res;
  };

  it("declares exactly one binding: buffered HTTP request, pre-credentials", () => {
    const { err, m } = describeWith(gatewayMeta);
    assert.equal(err, null);
    assert.deepEqual(
      m.bindings.map((b) => [b.operation, b.phase]),
      [["SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_REQUEST", "SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS"]],
    );
    assert.deepEqual(m.extension.supported_capabilities, ["openshell.supervisor-middleware.contract"], "no streaming capability is declared");
  });

  it("refuses a gateway that requires a capability it does not implement, such as a streaming session", () => {
    const { err } = describeWith({
      ...gatewayMeta,
      supported_capabilities: [...gatewayMeta.supported_capabilities, "openshell.supervisor-middleware.http-request-session"],
      required_capabilities: [...gatewayMeta.required_capabilities, "openshell.supervisor-middleware.http-request-session"],
    });
    assert.ok(err, "a required streaming capability must fail Describe, not be ignored");
    assert.equal(err.code, grpc.status.FAILED_PRECONDITION);
    assert.match(err.details, /http-request-session/);
  });

  it("the vendored service exposes no session RPCs, and WebSocket sessions are refused", () => {
    const methods = Object.keys(loadService().service);
    assert.equal(methods.some((n) => /Session$/.test(n) && n !== "EvaluateWebSocketSession"), false, `unexpected session RPC in ${methods}`);
    let emitted;
    h.EvaluateWebSocketSession({ emit: (ev, e) => (emitted = { ev, e }) });
    assert.equal(emitted.ev, "error");
    assert.equal(emitted.e.code, grpc.status.UNIMPLEMENTED);
  });

  it("returns its verdict only after every check, never a provisional allow", () => {
    // A unary handler that answers once. A denial path must call back exactly
    // once with DENY; an allow must never precede a later deny.
    const md = new grpc.Metadata();
    md.set("authorization", `Bearer ${token()}`);
    const results = [];
    h.EvaluateHttpRequest(
      {
        request: { phase: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS", context: ctx, target: { ...evalTarget, scheme: "http" }, body: evaluateBody({ kind: "openshell_sandbox", id: SBX }) },
        metadata: md,
      },
      (_e, r) => results.push(r.decision),
    );
    assert.deepEqual(results, ["DECISION_DENY"]);
  });
});
