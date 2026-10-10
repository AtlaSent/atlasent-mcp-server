// gRPC wiring for the AtlaSent OpenShell workload guard. Decision logic lives
// in guard.mjs; this file only speaks OpenShell's SupervisorMiddleware
// contract (proto/supervisor_middleware.proto, vendored from OpenShell).

import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import {
  ATTESTATION_HEADER,
  GuardDenial,
  bearerFrom,
  checkRequest,
  loadJwks,
  signAttestation,
  verifyGatewayToken,
} from "./guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const IMPLEMENTATION_NAME = "atlasent/openshell-workload-guard";
export const IMPLEMENTATION_VERSION = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version;
// OpenShell extension protocol 1.0 (crates/openshell-core/src/extension_protocol.rs).
const PROTOCOL = { major: 1, minor: 0 };
const CONTRACT = "openshell.supervisor-middleware.contract";
export const MAX_PAYLOAD_BYTES = 262144;

function loadService() {
  const def = protoLoader.loadSync("supervisor_middleware.proto", {
    includeDirs: [join(HERE, "proto")],
    keepCase: true,
    enums: String,
    longs: Number,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(def).openshell.middleware.v1.SupervisorMiddleware;
}

function logLine(fields) {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), component: "atlasent-workload-guard", ...fields })}\n`);
}

/** Reject a gateway that does not speak our protocol, as OpenShell's own services do. */
export function checkGatewayMetadata(gateway) {
  if (!gateway || !gateway.protocol_version) return "gateway sent no protocol metadata";
  if (gateway.protocol_version.major !== PROTOCOL.major) {
    return `gateway protocol ${gateway.protocol_version.major}.${gateway.protocol_version.minor} is incompatible with ${PROTOCOL.major}.${PROTOCOL.minor}`;
  }
  if (!(gateway.supported_capabilities ?? []).includes(CONTRACT)) return `gateway does not support ${CONTRACT}`;
  const unmet = (gateway.required_capabilities ?? []).filter((c) => c !== CONTRACT);
  if (unmet.length) return `gateway requires unsupported capabilities: ${unmet.join(", ")}`;
  return undefined;
}

/**
 * @param {object} cfg
 * @param {{issuer: string, keys: Map<string, import("node:crypto").KeyObject>}} cfg.gateway
 * @param {string} cfg.audience
 * @param {{host: string, port?: number}} cfg.destination pinned AtlaSent API host (and port, default 443)
 * @param {{signingKey: import("node:crypto").KeyObject, kid: string} | undefined} cfg.attestation
 * @param {() => number} [cfg.now]
 */
export function createHandlers(cfg) {
  const now = cfg.now ?? (() => Date.now());
  return {
    Describe(call, cb) {
      const problem = checkGatewayMetadata(call.request.gateway);
      if (problem) return cb({ code: grpc.status.FAILED_PRECONDITION, details: problem });
      cb(null, {
        name: "atlasent-workload-guard",
        service_version: IMPLEMENTATION_VERSION,
        bindings: [
          {
            operation: "SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_REQUEST",
            phase: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS",
            max_payload_bytes: MAX_PAYLOAD_BYTES,
          },
        ],
        expected_audience: cfg.audience,
        extension: {
          protocol_version: PROTOCOL,
          implementation_name: IMPLEMENTATION_NAME,
          implementation_version: IMPLEMENTATION_VERSION,
          supported_capabilities: [CONTRACT],
          required_capabilities: [CONTRACT],
        },
      });
    },

    ValidateConfig(call, cb) {
      // The guard takes no per-policy configuration: its rules are fixed so a
      // policy author cannot loosen them.
      const fields = Object.keys(call.request.config?.fields ?? {});
      cb(null, fields.length === 0 ? { valid: true, reason: "" } : { valid: false, reason: "atlasent-workload-guard takes no configuration" });
    },

    EvaluateHttpRequest(call, cb) {
      const req = call.request;
      const base = {
        osh_request_id: req.context?.request_id,
        sandbox_id: req.context?.sandbox_id,
        method: req.target?.method,
        path: req.target?.path,
        // What OpenShell reported, logged as-is: the live transport-identity
        // probe (NVIDIA/OpenShell#4397) reads it back from this line.
        scheme: req.target?.scheme,
        host: req.target?.host,
        port: req.target?.port,
      };
      try {
        if (req.phase !== "SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS") {
          throw new GuardDenial("unsupported_phase", String(req.phase));
        }
        const claims = verifyGatewayToken(bearerFrom(call.metadata.get("authorization")), {
          keys: cfg.gateway.keys,
          issuer: cfg.gateway.issuer,
          audience: cfg.audience,
          now: now(),
        });
        const { route, sandbox_id } = checkRequest({
          claims,
          context: req.context,
          target: req.target,
          body: req.body,
          destination: cfg.destination,
        });
        const header_mutations = [];
        if (route.workload && cfg.attestation) {
          const value = signAttestation({
            signingKey: cfg.attestation.signingKey,
            kid: cfg.attestation.kid,
            sandboxId: sandbox_id,
            requestId: req.context?.request_id,
            method: String(req.target.method).toUpperCase(),
            path: req.target.path,
            body: req.body,
            now: now(),
          });
          header_mutations.push({ write: { name: ATTESTATION_HEADER, value, on_existing: "EXISTING_HEADER_ACTION_OVERWRITE" } });
        }
        logLine({ ...base, decision: "allow", attested: header_mutations.length > 0 });
        cb(null, { decision: "DECISION_ALLOW", reason: "", header_mutations });
      } catch (err) {
        const code = err instanceof GuardDenial ? err.code : "guard_error";
        logLine({ ...base, decision: "deny", reason_code: code, detail: err.message });
        cb(null, { decision: "DECISION_DENY", reason: code, reason_code: code, header_mutations: [] });
      }
    },

    EvaluateWebSocketSession(call) {
      call.emit("error", { code: grpc.status.UNIMPLEMENTED, details: "atlasent-workload-guard handles HTTP requests only" });
    },
  };
}

/** Build runtime config from a JSON config object (paths resolved by the caller). */
export function loadConfig(raw) {
  for (const k of ["listen", "audience"]) if (typeof raw[k] !== "string" || !raw[k]) throw new Error(`config.${k} is required`);
  if (typeof raw.gateway?.issuer !== "string" || !raw.gateway.issuer.startsWith("openshell-gateway:")) {
    throw new Error('config.gateway.issuer must be "openshell-gateway:<gateway_id>"');
  }
  if (typeof raw.gateway?.jwks_path !== "string") throw new Error("config.gateway.jwks_path is required");
  if (typeof raw.destination?.host !== "string" || raw.destination.host.trim() === "") {
    throw new Error("config.destination.host is required (the AtlaSent API host the key is injected for)");
  }
  if (raw.destination.port !== undefined && !(Number.isInteger(raw.destination.port) && raw.destination.port > 0 && raw.destination.port < 65536)) {
    throw new Error("config.destination.port must be a TCP port");
  }
  const cfg = {
    listen: raw.listen,
    destination: { host: raw.destination.host, port: raw.destination.port ?? 443 },
    audience: raw.audience,
    gateway: { issuer: raw.gateway.issuer, keys: loadJwks(JSON.parse(readFileSync(raw.gateway.jwks_path, "utf8"))) },
    tls: undefined,
    attestation: undefined,
  };
  if (raw.tls) {
    cfg.tls = { cert: readFileSync(raw.tls.cert_path), key: readFileSync(raw.tls.key_path) };
  } else if (raw.allow_insecure_transport !== true) {
    throw new Error("config.tls is required (set allow_insecure_transport only for local tests)");
  }
  if (raw.attestation) {
    if (typeof raw.attestation.kid !== "string" || !raw.attestation.kid) throw new Error("config.attestation.kid is required");
    const signingKey = createPrivateKey(readFileSync(raw.attestation.signing_key_path));
    if (signingKey.asymmetricKeyType !== "ed25519") throw new Error("attestation signing key must be Ed25519");
    cfg.attestation = { signingKey, kid: raw.attestation.kid };
  }
  return cfg;
}

export function startServer(cfg) {
  const server = new grpc.Server({ "grpc.max_receive_message_length": MAX_PAYLOAD_BYTES + 300 * 1024 });
  server.addService(loadService().service, createHandlers(cfg));
  const creds = cfg.tls
    ? grpc.ServerCredentials.createSsl(null, [{ cert_chain: cfg.tls.cert, private_key: cfg.tls.key }], false)
    : grpc.ServerCredentials.createInsecure();
  return new Promise((resolve, reject) => {
    server.bindAsync(cfg.listen, creds, (err, port) => (err ? reject(err) : resolve({ server, port })));
  });
}

export { loadService };
