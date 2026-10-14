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
}

/**
 * Returns the denial when `status`/`body` is OpenShell's canonical
 * middleware-denial response, else null. Matching is exact: a 403 JSON object
 * whose `error` is the string "middleware_denied". Anything else (including an
 * AtlaSent scope 403, a non-JSON body, or a body that merely mentions the
 * phrase) is not a middleware denial.
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
  if (obj.error !== "middleware_denied") return null;
  const code = obj.reason_code;
  return { reason_code: typeof code === "string" && REASON_CODE.test(code) ? code : null };
}

/**
 * Operator-facing message for a middleware denial. Never mentions key scopes as
 * the cause, and never claims which middleware refused: OpenShell's canonical
 * denial carries no middleware identity. A code the AtlaSent workload guard is
 * known to use is described as such, not attributed.
 */
export function middlewareDenialMessage(d: MiddlewareDenial): string {
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
