// Recognises OpenShell's canonical supervisor-middleware denial (issue #263).
//
// When an OpenShell supervisor middleware (the AtlaSent workload guard in
// packages/openshell-workload-guard, or any other registered middleware) blocks a request, OpenShell answers with
// its own canonical response instead of the upstream one: HTTP 403 with a JSON
// body whose `error` is exactly "middleware_denied", plus a validated
// `reason_code` when the middleware supplied one (see
// packages/openshell-workload-guard/proto/supervisor_middleware.proto,
// HttpResponseBlockDelivery and HttpRequestResult.reason_code).
//
// Before this, every 403 was reported as "your key lacks the required scope",
// which sent operators looking at key scopes for a refusal AtlaSent never made.
// This module changes WORDING ONLY: callers still throw, so the request still
// fails closed with the same outcome and exit code.
//
// OpenShell 0.1.5 answers a middleware that could not complete its check
// (service unavailable, timed out, invalid result, payload over its limit)
// under the default `on_error = "fail_closed"` with the same 403 and
// `error: "middleware_failed"` (crates/openshell-supervisor-network/src/l7/
// relay.rs at v0.1.5). That is recognised too (#279): a guard that is down is
// not a key-scope problem either, and it is still a refusal.

/** OpenShell's reason_code format: lowercase letter first, then [a-z0-9_], max 64 bytes. */
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Codes the AtlaSent workload guard emits. The response never identifies which
 * middleware refused (any supervisor middleware returns the same canonical
 * shape), so these only describe what a code means; they are not proof that the
 * workload guard sent it.
 */
const GUARD_CODE_MEANING: Record<string, string> = {
  workload_mismatch: "the request names a different sandbox than the one it was sent from",
  workload_missing: "the request names no workload",
};

export interface MiddlewareDenial {
  /** The validated reason_code, or null when absent or not in OpenShell's format. */
  reason_code: string | null;
  /**
   * Present (true) when OpenShell reported `middleware_failed`: a middleware
   * could not complete its check and OpenShell blocked the request. Absent on
   * an explicit `middleware_denied`.
   */
  failed?: true;
}

/**
 * Returns the denial when `status`/`body` is OpenShell's canonical
 * middleware-denial or middleware-failure response, else null. Matching is
 * exact: a 403 JSON object whose `error` is the string "middleware_denied" or
 * "middleware_failed". Anything else (including an AtlaSent scope 403, a
 * non-JSON body, or a body that merely mentions the phrase) is not one.
 */
export function parseMiddlewareDenial(status: number, body: string): MiddlewareDenial | null {
  if (status !== 403) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.error !== "middleware_denied" && obj.error !== "middleware_failed") return null;
  const code = obj.reason_code;
  const out: MiddlewareDenial = { reason_code: typeof code === "string" && REASON_CODE.test(code) ? code : null };
  if (obj.error === "middleware_failed") out.failed = true;
  return out;
}

/**
 * Operator-facing message for a middleware denial. Never mentions key scopes as
 * the cause, and never claims which middleware refused: OpenShell's canonical
 * denial carries no middleware identity. A code the AtlaSent workload guard is
 * known to use is described as such, not attributed.
 */
export function middlewareDenialMessage(d: MiddlewareDenial): string {
  if (d.failed) {
    return (
      "Blocked by OpenShell: a supervisor middleware on this route could not complete its check " +
      "(unavailable, timed out or invalid result), so OpenShell refused the request (middleware_failed). " +
      "Nothing was authorized. This is not an AtlaSent API key scope problem."
    );
  }
  const code = d.reason_code ? ` (reason_code: ${d.reason_code})` : " (no reason_code given)";
  const meaning = d.reason_code && GUARD_CODE_MEANING[d.reason_code]
    ? `: ${GUARD_CODE_MEANING[d.reason_code]}. That code is one the AtlaSent workload guard uses, ` +
      `but the response does not say which middleware refused`
    : "";
  return (
    `Refused by OpenShell supervisor middleware at the sandbox boundary` +
    `${code}${meaning}. This is not an AtlaSent API key scope problem.`
  );
}
