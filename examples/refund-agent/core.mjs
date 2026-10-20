/**
 * Refund agent demo: the agent's loop, with the AtlaSent calls injected so the
 * same loop runs live (MCP tools over stdio), simulated (in memory) and under
 * test.
 *
 * For every refund in the support queue the agent:
 *
 *   1 ASKS     evaluate finance.payment.authorize for exactly this refund
 *              (amount, customer, ticket, original payment method), with the
 *              refund's payload digest bound as execution_payload_hash
 *   2 WAITS    on hold/escalate: a person approves or rejects it in the
 *              AtlaSent console; the agent can only wait, never approve
 *   3 VERIFIES the permit at the boundary, presenting the same digest
 *   4 REFUNDS  exactly once, and only when verification says valid
 *   5 RECORDS  the outcome; the permit appears only as a sha256
 *
 * Fail closed at every step: deny, rejection, timeout, an unbound digest, an
 * invalid permit or any thrown error means the refund is not issued.
 *
 * finance.payment.authorize is the Canon action a refund converges to (CANON-
 * 000021; POL-USFP-008). The policy is the solo-builder-payment-authorize-gate
 * pack: under the threshold a refund is allowed and still evidenced; at or
 * above it the request always escalates to a person, whatever the agent
 * claims about approvals. The agent sends no approval claim at all.
 */
import { createHash } from "node:crypto";

export const ACTION_TYPE = "finance.payment.authorize";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

/** The exact payment the agent would send to the payment processor. */
export function refundPayload(r) {
  return {
    refund_id: r.refund_id,
    customer_ref: r.customer_ref,
    charge_ref: r.charge_ref,
    amount: r.amount,
    currency: r.currency,
    destination: r.original_payment_method ? "original_payment_method" : r.destination ?? "other",
  };
}

export function payloadDigest(r) {
  return sha256(canonicalJson(refundPayload(r)));
}

/**
 * @typedef {{ decision: string, permit_token?: string, approval_request_id?: string,
 *   reasons?: string[], deny_code?: string, execution_payload_hash_accepted?: boolean, request_id?: string }} EvalResult
 * @typedef {{
 *   evaluate(input: { action_type: string, actor_id: string, target_id: string, execution_payload_hash: string, context: Record<string, unknown> }): Promise<EvalResult>,
 *   awaitApproval(input: { approval_request_id: string, max_wait_seconds: number }): Promise<{ outcome: string, permit_token?: string, reasons?: string[] }>,
 *   verify(input: { permit_token: string, action_type: string, actor_id: string, environment: string, target_id: string, payload_hash: string }): Promise<{ valid: boolean, outcome?: string, reasons?: string[] }>,
 * }} AtlaSentTools
 * @typedef {{ issue(payload: ReturnType<typeof refundPayload>): Promise<{ processor_ref: string }> }} PaymentProcessor
 */

/**
 * @param {{
 *   refunds: Array<Record<string, any>>,
 *   tools: AtlaSentTools,
 *   processor: PaymentProcessor,
 *   actorId: string,
 *   environment: string,
 *   approvalWaitSeconds?: number,
 *   say?: (line: string) => void,
 * }} opts
 */
export async function runRefundAgent(opts) {
  const say = opts.say ?? (() => {});
  const results = [];
  for (const r of opts.refunds) {
    results.push(await handleOne(r, opts, say));
  }
  const issued = results.filter((x) => x.outcome === "issued");
  say("");
  say(
    `Done: ${results.length} refund request${results.length === 1 ? "" : "s"}, ${issued.length} issued, ` +
      `${results.length - issued.length} not issued.`,
  );
  return results;
}

async function handleOne(r, opts, say) {
  const label = `${r.refund_id} · ${r.currency} ${Number(r.amount).toFixed(2)} · ${r.customer_ref}`;
  const base = { refund_id: r.refund_id, amount: r.amount, currency: r.currency, customer_ref: r.customer_ref };
  const digest = payloadDigest(r);
  const record = (outcome, extra = {}) => {
    say(`    → ${outcome.toUpperCase()}${extra.reason ? `: ${extra.reason}` : ""}`);
    return { ...base, outcome, payload_sha256: digest, ...extra };
  };
  say("");
  say(`[refund] ${label}${r.reason ? ` — "${r.reason}"` : ""}`);

  let permit;
  let decision;
  try {
    // 1 ASK
    const ev = await opts.tools.evaluate({
      action_type: ACTION_TYPE,
      actor_id: opts.actorId,
      target_id: r.refund_id,
      execution_payload_hash: digest,
      context: {
        environment: opts.environment,
        payment_kind: "refund",
        amount: r.amount,
        currency: r.currency,
        counterparty: r.customer_ref,
        charge_ref: r.charge_ref,
        ticket_id: r.ticket_id,
        original_payment_method: r.original_payment_method === true,
      },
    });
    decision = ev.decision;
    say(`    AtlaSent: ${decision}${ev.deny_code ? ` (${ev.deny_code})` : ""}${ev.reasons?.length ? ` — ${ev.reasons[0]}` : ""}`);
    if (ev.execution_payload_hash_accepted === false) {
      return record("not_issued", { decision, reason: "the runtime did not bind the refund's digest, so the permit would not name this payment" });
    }

    if (decision === "allow") {
      permit = ev.permit_token;
    } else if (decision === "hold" || decision === "escalate") {
      // 2 WAIT — a person decides in the console; this agent cannot approve.
      if (!ev.approval_request_id) return record("not_issued", { decision, reason: "held with no approval request to wait on" });
      say(`    Waiting for a person to approve it in the AtlaSent console (request ${ev.approval_request_id})…`);
      const ap = await opts.tools.awaitApproval({
        approval_request_id: ev.approval_request_id,
        max_wait_seconds: opts.approvalWaitSeconds ?? 600,
      });
      say(`    Approval: ${ap.outcome}`);
      if (ap.outcome !== "approved" || !ap.permit_token) {
        return record("not_issued", { decision, approval: ap.outcome, reason: "not approved" });
      }
      permit = ap.permit_token;
    } else {
      return record("not_issued", { decision, reason: ev.deny_code ?? "denied" });
    }
    if (!permit) return record("not_issued", { decision, reason: "no permit was issued" });

    // 3 VERIFY at the boundary, with the same refund and digest.
    const v = await opts.tools.verify({
      permit_token: permit,
      action_type: ACTION_TYPE,
      actor_id: opts.actorId,
      environment: opts.environment,
      target_id: r.refund_id,
      payload_hash: digest,
    });
    say(`    Permit verification: ${v.valid ? "valid" : `invalid (${v.outcome ?? "error"})`}`);
    if (v.valid !== true) {
      return record("not_issued", { decision, reason: `permit not valid (${v.outcome ?? "error"})`, permit_sha256: sha256(permit) });
    }

    // 4 REFUND exactly once.
    const done = await opts.processor.issue(refundPayload(r));
    return record("issued", { decision, permit_sha256: sha256(permit), processor_ref: done.processor_ref });
  } catch (e) {
    return record("not_issued", {
      ...(decision ? { decision } : {}),
      reason: `error: ${e instanceof Error ? e.message : String(e)}`,
      ...(permit ? { permit_sha256: sha256(permit) } : {}),
    });
  }
}
