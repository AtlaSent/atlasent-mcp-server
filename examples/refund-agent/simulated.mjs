/**
 * SIMULATED AtlaSent tools and payment processor for
 * `npm run demo:refund -- --simulate`: rehearsal and tests only. They prove
 * nothing about the real runtime, and the demo prefixes every line with
 * [SIMULATED].
 *
 * The decision mirrors the solo-builder-payment-authorize-gate pack's default
 * template (self-attested-under-1000): no amount → deny AMOUNT_REQUIRED; under
 * the threshold → allow; at or above → escalate SECOND_APPROVER_REQUIRED. The
 * simulated approver stands in for the person in the console: it approves
 * refunds to the original payment method and rejects the rest. Permits are
 * single-use and bound to the refund id and payload digest, like the runtime's.
 */
import { randomUUID } from "node:crypto";

export function createSimulatedTools(opts = {}) {
  const threshold = opts.threshold ?? 1000;
  const approve = opts.approve ?? ((req) => req.context.original_payment_method === true);
  const state = { evaluations: [], approvals: new Map(), permits: new Map(), verifies: 0, issued: [] };

  const mint = (req) => {
    const token = `sim_permit_${randomUUID()}`;
    state.permits.set(token, { target_id: req.target_id, digest: req.execution_payload_hash, used: false });
    return token;
  };

  const tools = {
    async evaluate(req) {
      state.evaluations.push(req);
      const amount = req.context.amount;
      if (typeof amount !== "number" || !Number.isFinite(amount)) {
        return { decision: "deny", deny_code: "AMOUNT_REQUIRED", reasons: ["A refund must carry a real numeric amount."] };
      }
      if (amount < threshold) return { decision: "allow", permit_token: mint(req), execution_payload_hash_accepted: true };
      const id = randomUUID();
      state.approvals.set(id, req);
      return {
        decision: "escalate",
        deny_code: "SECOND_APPROVER_REQUIRED",
        reasons: [`At or above the $${threshold} threshold: a person must approve it.`],
        approval_request_id: id,
        execution_payload_hash_accepted: true,
      };
    },
    async awaitApproval({ approval_request_id }) {
      const req = state.approvals.get(approval_request_id);
      if (!req) return { outcome: "not_found" };
      return approve(req) ? { outcome: "approved", permit_token: mint(req) } : { outcome: "rejected" };
    },
    async verify({ permit_token, target_id, payload_hash }) {
      state.verifies++;
      const p = state.permits.get(permit_token);
      if (!p) return { valid: false, outcome: "invalid" };
      if (p.used) return { valid: false, outcome: "replayed" };
      if (p.target_id !== target_id || p.digest !== payload_hash) return { valid: false, outcome: "mismatch" };
      p.used = true;
      return { valid: true, outcome: "verified" };
    },
  };

  const processor = {
    async issue(payload) {
      state.issued.push(payload);
      return { processor_ref: `sim_re_${state.issued.length}` };
    },
  };

  return { tools, processor, state };
}
