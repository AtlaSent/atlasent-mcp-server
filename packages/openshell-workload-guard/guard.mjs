// AtlaSent OpenShell workload guard: pure decision logic.
//
// OpenShell calls this service (as supervisor middleware, HttpRequest /
// pre_credentials) for every request a sandbox sends to the AtlaSent API,
// BEFORE it injects the AtlaSent key. The guard learns which sandbox sent the
// request from a gateway-signed JWT the agent cannot forge, and denies any
// evaluate or verify that names a different sandbox. Because the key is
// injected only after this check, a request carrying the key has passed it.
//
// Design: docs/OPENSHELL_WORKLOAD_IDENTITY_DESIGN.md. Every failure denies.

import { createHash, createPublicKey, randomUUID, sign, verify } from "node:crypto";

export const EXTENSION_JWT_TYP = "openshell-ext+jwt";
export const ATTESTATION_TYP = "atlasent-workload-attestation+jwt";
export const ATTESTATION_HEADER = "x-atlasent-workload-attestation";
export const ATTESTATION_AUDIENCE = "atlasent-runtime";
export const ATTESTATION_TTL_SECONDS = 60;
export const WORKLOAD_KIND = "openshell_sandbox";
// Allowed clock skew when checking a gateway token, in seconds.
const SKEW_SECONDS = 30;

// Request paths the AtlaSent provider profile allows, matched on the suffix
// after the functions base. "workload" marks the two calls whose body must
// name the verified sandbox; the rest mint nothing a forged ID could use.
const ROUTES = [
  { method: "POST", pattern: /^v1-evaluate$/, workload: "context" },
  { method: "POST", pattern: /^v1-verify-permit$/, workload: "top" },
  { method: "GET", pattern: /^v1-approvals\/[^/]+$/ },
  { method: "POST", pattern: /^v1-approvals\/[^/]+\/claim-permit$/ },
  { method: "POST", pattern: /^v1-agent-actor-identity$/ },
  { method: "POST", pattern: /^v1-source-provenance-seal$/ },
  { method: "POST", pattern: /^v1-change-brief$/ },
  { method: "POST", pattern: /^v1-agent-circuit-trips$/ },
];

export class GuardDenial extends Error {
  /** @param {string} code lowercase reason code returned to the sandbox */
  constructor(code, detail) {
    super(detail ?? code);
    this.code = code;
  }
}

function b64urlJson(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function b64url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

/**
 * Load pinned gateway verification keys from a JWKS document (the gateway's
 * /.well-known/jwks.json, copied by the operator). Never fetched at runtime.
 * @returns {Map<string, import("node:crypto").KeyObject>}
 */
export function loadJwks(jwks) {
  const keys = new Map();
  for (const jwk of jwks?.keys ?? []) {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.kid !== "string" || typeof jwk.x !== "string") continue;
    keys.set(jwk.kid, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" }));
  }
  if (keys.size === 0) throw new Error("JWKS holds no Ed25519 key with a kid");
  return keys;
}

/**
 * Verify an OpenShell extension JWT, as OpenShell's extension docs require:
 * typ and alg pinned, signature, expiry, exact audience and issuer, and a
 * supervisor caller with a sandbox_id.
 */
export function verifyGatewayToken(token, { keys, issuer, audience, now = Date.now() }) {
  if (typeof token !== "string") throw new GuardDenial("caller_unauthenticated", "missing bearer token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new GuardDenial("caller_unauthenticated", "malformed token");
  let header;
  let claims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    throw new GuardDenial("caller_unauthenticated", "undecodable token");
  }
  if (header.typ !== EXTENSION_JWT_TYP || header.alg !== "EdDSA") {
    throw new GuardDenial("caller_unauthenticated", "unexpected token type or algorithm");
  }
  const key = keys.get(header.kid);
  if (!key) throw new GuardDenial("caller_unauthenticated", "unknown signing key");
  const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
  if (!ok) throw new GuardDenial("caller_unauthenticated", "bad signature");
  const t = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < t) {
    throw new GuardDenial("caller_unauthenticated", "token expired");
  }
  if (typeof claims.iat === "number" && claims.iat - SKEW_SECONDS > t) {
    throw new GuardDenial("caller_unauthenticated", "token issued in the future");
  }
  if (claims.iss !== issuer) throw new GuardDenial("caller_unauthenticated", "wrong issuer");
  if (claims.aud !== audience) throw new GuardDenial("caller_unauthenticated", "wrong audience");
  if (claims.caller_kind !== "supervisor") throw new GuardDenial("caller_not_supervisor");
  if (typeof claims.sandbox_id !== "string" || claims.sandbox_id === "") {
    throw new GuardDenial("caller_unauthenticated", "token carries no sandbox_id");
  }
  return claims;
}

/**
 * Parse JSON while refusing duplicate keys anywhere. A duplicate `workload`
 * could be read one way here and another way by the runtime.
 */
export function parseStrictJson(text) {
  const value = JSON.parse(text);
  // JSON.parse keeps the last of two duplicate keys silently, so scan the
  // text once more and track the keys of each open object. Sticky regex: a
  // key match is anchored at the quote, so the scan stays linear.
  const re = /"((?:[^"\\]|\\.)*)"\s*:/y;
  const stack = [];
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m.index === i) {
        const keys = stack[depth - 1];
        if (keys) {
          const k = JSON.parse(`"${m[1]}"`);
          if (keys.has(k)) throw new GuardDenial("body_duplicate_key", `duplicate key ${k}`);
          keys.add(k);
        }
        i = re.lastIndex - 1;
        continue;
      }
      inString = true;
    } else if (c === "{") {
      stack[depth++] = new Set();
    } else if (c === "[") {
      stack[depth++] = null;
    } else if (c === "}" || c === "]") {
      depth--;
    }
  }
  return value;
}

function routeFor(method, path) {
  const m = /\/functions\/v1\/(.+)$/.exec(path) ?? /^\/(.+)$/.exec(path);
  if (!m) return undefined;
  return ROUTES.find((r) => r.method === method && r.pattern.test(m[1]));
}

function normalizeHost(host) {
  return String(host).trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Check the destination and transport OpenShell reported for this request.
 *
 * The AtlaSent key is injected after this guard allows, so the request must
 * be going to the operator-pinned AtlaSent host and port, over HTTPS. Anything
 * else denies: plaintext `http`, a WebSocket scheme (`ws`/`wss` are never an
 * evaluate or verify), and any field OpenShell left empty, because a
 * destination we cannot establish is not one we can bind a permit to.
 *
 * Limit: this trusts the scheme OpenShell reports. NVIDIA/OpenShell#4397 (open
 * 2026-10-10, issue #4253): plaintext HTTP in a tunnel reaches middleware as
 * `https`, and plaintext WebSocket as `wss`. No check here can see through that; the fix is in
 * OpenShell. Until a release carrying it is confirmed, treat a reported
 * `https` as necessary, not sufficient (docs/OPENSHELL_AUTHORITY_ADAPTER.md).
 */
export function checkDestination(target, destination) {
  if (!destination || typeof destination.host !== "string" || destination.host.trim() === "") {
    throw new GuardDenial("destination_unconfigured", "no pinned AtlaSent destination host");
  }
  const scheme = typeof target?.scheme === "string" ? target.scheme.trim().toLowerCase() : "";
  if (scheme === "") throw new GuardDenial("transport_unknown", "OpenShell reported no request scheme");
  if (scheme === "http") throw new GuardDenial("transport_not_secure", "plaintext http");
  if (scheme === "ws" || scheme === "wss") throw new GuardDenial("transport_not_http", `${scheme} is not an AtlaSent API request`);
  if (scheme !== "https") throw new GuardDenial("transport_unknown", `unrecognized scheme ${scheme}`);
  const host = typeof target?.host === "string" ? normalizeHost(target.host) : "";
  if (host === "") throw new GuardDenial("destination_unknown", "OpenShell reported no destination host");
  if (host !== normalizeHost(destination.host)) throw new GuardDenial("destination_mismatch", `host ${host}`);
  const port = Number(target?.port);
  if (!Number.isInteger(port) || port <= 0) throw new GuardDenial("destination_unknown", "OpenShell reported no destination port");
  if (port !== (destination.port ?? 443)) throw new GuardDenial("destination_mismatch", `port ${port}`);
}

/**
 * Decide one request. Returns { route, sandbox_id } on allow; throws
 * GuardDenial otherwise.
 */
export function checkRequest({ claims, context, target, body, destination }) {
  if (!context || context.sandbox_id !== claims.sandbox_id) {
    throw new GuardDenial("context_mismatch", "request context sandbox_id differs from the gateway token");
  }
  checkDestination(target, destination);
  const method = String(target?.method ?? "").toUpperCase();
  const route = routeFor(method, String(target?.path ?? ""));
  if (!route) throw new GuardDenial("path_not_allowed", `${method} ${target?.path}`);
  if (!route.workload) return { route, sandbox_id: claims.sandbox_id };

  let parsed;
  try {
    parsed = parseStrictJson(Buffer.from(body ?? []).toString("utf8"));
  } catch (err) {
    if (err instanceof GuardDenial) throw err;
    throw new GuardDenial("body_not_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new GuardDenial("body_not_json");
  const workload = route.workload === "context" ? parsed.context?.workload : parsed.workload;
  if (!workload || typeof workload !== "object") throw new GuardDenial("workload_missing");
  if (workload.kind !== WORKLOAD_KIND || workload.id !== claims.sandbox_id) {
    throw new GuardDenial("workload_mismatch", `body names ${workload.kind}:${workload.id}`);
  }
  return { route, sandbox_id: claims.sandbox_id };
}

/**
 * Sign the per-request workload attestation (design phase 2). It binds the
 * verified sandbox to the exact body bytes, so the runtime can check that
 * this guard saw this request.
 */
export function signAttestation({ signingKey, kid, sandboxId, requestId, method, path, body, now = Date.now(), jti = randomUUID() }) {
  const iat = Math.floor(now / 1000);
  const header = { alg: "EdDSA", typ: ATTESTATION_TYP, kid };
  const payload = {
    v: 1,
    aud: ATTESTATION_AUDIENCE,
    jti,
    sandbox_id: sandboxId,
    osh_request_id: requestId ?? "",
    method,
    path,
    body_sha256: createHash("sha256").update(Buffer.from(body ?? [])).digest("hex"),
    iat,
    exp: iat + ATTESTATION_TTL_SECONDS,
  };
  const input = `${b64url(header)}.${b64url(payload)}`;
  return `${input}.${sign(null, Buffer.from(input), signingKey).toString("base64url")}`;
}

/** Bearer token from gRPC metadata values. */
export function bearerFrom(values) {
  const v = Array.isArray(values) ? values[0] : values;
  const m = typeof v === "string" ? /^Bearer\s+(\S+)$/i.exec(v) : null;
  return m ? m[1] : undefined;
}
