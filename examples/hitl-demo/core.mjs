/**
 * The 90-second human-in-the-loop demo, as one function.
 *
 *   agent attempts a change -> AtlaSent HOLDS it -> a person approves in the
 *   console -> that exact change is permitted -> it executes once -> the
 *   effect is re-read and recorded
 *
 * It drives the REAL MCP tool `atlasent_governed_file_change` through an MCP
 * client. It never constructs a decision, permit, commit or proof itself: every
 * id it prints is one the tool returned or the repository showed. Any stage
 * that does not show what it should stops the demo with ok=false, and nothing
 * after it is printed as if it happened.
 *
 * Wiring (which server, which repository reader, simulated or not) lives in
 * examples/hitl-demo.mjs. This file has no imports so tests can drive it
 * against an in-memory server.
 */

export const TOOL = "atlasent_governed_file_change";

const parse = (result) => {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("tool returned no text content");
  return JSON.parse(text);
};

/**
 * @param {object} o
 * @param {{ listTools(): Promise<{tools: Array<{name: string}>}>, callTool(req: object): Promise<object> }} o.client
 * @param {(path: string) => Promise<string | null>} o.readHead  reads the file at the branch head (null = absent), independently of the tool
 * @param {string} o.path
 * @param {string} o.content
 * @param {string} o.message
 * @param {boolean} [o.simulated]    every output line is prefixed [SIMULATED]
 * @param {(approvalRequestId: string) => (void | Promise<void>)} [o.onHold]  presenter cue; the simulated approver hooks in here
 * @param {number} [o.approvalWaitSeconds]  overall wait for a person (default 600)
 * @param {number} [o.pollSeconds]          per-call wait inside the tool (default 30, max 300)
 * @param {boolean} [o.tamperCheck]         show that a changed action cannot use the approval (default true)
 * @param {(line: string) => void} [o.print]
 * @param {() => number} [o.clock]          ms clock, for the elapsed column
 * @param {(ms: number) => Promise<void>} [o.sleep]  between re-reads of the effect (GitHub read-after-write)
 */
export async function runHitlDemo(o) {
  const print = o.print ?? ((l) => console.log(l));
  const clock = o.clock ?? (() => Date.now());
  const t0 = clock();
  const tag = o.simulated ? "[SIMULATED] " : "";
  const say = (l = "") => print(tag + l);
  const elapsed = () => `+${((clock() - t0) / 1000).toFixed(1)}s`;
  const stage = (n, title) => { say(); say(`${elapsed().padStart(8)}  STAGE ${n} | ${title}`); };
  const line = (k, v) => say(`           ${k.padEnd(22)} ${typeof v === "string" ? v : JSON.stringify(v)}`);
  const ids = {};
  const fail = (stageName, reason, extra = {}) => {
    say();
    say(`  FAIL at ${stageName}: ${reason}`);
    say("  The demo stopped here. Nothing after this stage happened or is claimed.");
    return { ok: false, failed_stage: stageName, reason, ids, ...extra };
  };
  const call = async (args) => parse(await o.client.callTool({ name: TOOL, arguments: args }));
  const waitTotal = o.approvalWaitSeconds ?? 600;
  const pollSeconds = Math.min(Math.max(o.pollSeconds ?? 30, 0), 300);
  const change = { path: o.path, content: o.content, message: o.message };

  if (o.simulated) {
    say("SIMULATED RUN: in-memory runtime, in-memory repository and a simulated approver.");
    say("Nothing here touched AtlaSent or GitHub. Do not present this as a live run.");
  }

  // 0. The tool exists (it is registered only when an operator named the repo).
  const listed = await o.client.listTools();
  if (!listed.tools.some((t) => t.name === TOOL)) {
    return fail("setup", `${TOOL} is not registered. Set ATLASENT_AI_ACTION_GITHUB_REPO, _BRANCH and _TOKEN.`);
  }
  const before = await o.readHead(o.path);
  line("target file", o.path);
  line("before", before === null ? "(does not exist)" : `${before.length} bytes`);

  // 1. Attempt.
  stage(1, "ATTEMPT  the agent asks to change a config file");
  const first = await call(change);
  if (first.outcome === "executed") {
    ids.commit_sha = first.proof?.execution?.receipt?.commit_sha;
    return fail("attempt", "the org's agent.tool.invoke policy ALLOWED this change with no person involved, and it was written. " +
      "This demo needs that policy to require human approval (requires_human_approval). Do not present this run.", { proof: first.proof });
  }
  if (first.outcome !== "held" || typeof first.approval_request_id !== "string") {
    return fail("attempt", `expected a hold, got outcome=${first.outcome}${first.deny_code ? ` deny_code=${first.deny_code}` : ""}: ${JSON.stringify(first.reasons ?? first.reason ?? null)}`);
  }
  ids.approval_request_id = first.approval_request_id;
  ids.action_digest = first.action_digest;
  ids.target_id = first.target_id;

  // 2. Hold: nothing changed.
  stage(2, "HOLD     AtlaSent intercepted it; it waits for a person");
  line("decision", "hold");
  line("approval_request_id", first.approval_request_id);
  line("action_digest", first.action_digest);
  line("target", first.target_id);
  line("reasons", first.reasons ?? []);
  if ((await o.readHead(o.path)) !== before) return fail("hold", "the file changed while the action was held");
  line("file unchanged", "yes (re-read at the branch head)");
  say(`           >>> Approve ${first.approval_request_id} in the AtlaSent console (Approvals).`);
  if (o.onHold) await o.onHold(first.approval_request_id);

  // 3. A changed action cannot use this approval.
  if (o.tamperCheck !== false) {
    stage(3, "BOUND    the approval covers this exact change, not a changed one");
    const tampered = await call({ ...change, content: o.content.replace(/\n?$/, "") + " \n", approval_request_id: first.approval_request_id, max_wait_seconds: 0 });
    if (tampered.outcome !== "refused" || !tampered.approved) {
      return fail("bound", `a changed action was not refused (outcome=${tampered.outcome})`, { tampered });
    }
    line("changed content", "refused before any runtime call");
    line("approved content_sha256", tampered.approved.content_sha256);
    if ((await o.readHead(o.path)) !== before) return fail("bound", "the file changed after a refused action");
    line("file unchanged", "yes");
  }

  // 4. Wait for the person. Each call waits inside the tool, then executes on approval.
  stage(4, "APPROVE  waiting for a person to decide in the console");
  const deadline = clock() + waitTotal * 1000;
  let result;
  for (;;) {
    const remaining = Math.max(0, Math.ceil((deadline - clock()) / 1000));
    if (remaining === 0) return fail("approve", `no decision within ${waitTotal}s. Nothing was changed.`);
    result = await call({ ...change, approval_request_id: first.approval_request_id, max_wait_seconds: Math.min(pollSeconds, remaining) });
    if (result.outcome !== "held") break;
    line("still pending", elapsed());
  }
  if (result.outcome === "refused") {
    return fail("approve", `not approved: ${JSON.stringify(result.reasons ?? result.reason ?? null)}. Nothing was changed.`);
  }
  const proof = result.proof;
  if (!proof || typeof proof !== "object") return fail("approve", `unexpected tool result: ${JSON.stringify(result).slice(0, 300)}`);
  ids.audit_id = proof.decision?.audit_id;
  ids.permit_token_sha256 = proof.permit?.token_sha256;
  line("approved", proof.decision?.approval_request_id ?? "(no approval id on the proof)");
  line("permit (sha256 only)", proof.permit?.token_sha256 ?? "(none)");
  if (proof.decision?.approval_request_id !== first.approval_request_id) {
    return fail("approve", "the proof does not name the approval that was requested");
  }

  // 5. Execute: verified at the boundary, then exactly one write.
  stage(5, "EXECUTE  permit verified at the boundary, then one write");
  if (proof.permit?.verified !== true) {
    return fail("execute", `permit not verified (outcome=${proof.outcome}, verify_error_code=${proof.permit?.verify_error_code ?? "none"}). Nothing was written.`, { proof });
  }
  line("verify outcome", proof.permit.verify_outcome ?? "allow");
  line("verified_at", proof.permit.verified_at ?? "(not reported)");
  const receipt = proof.execution && "receipt" in proof.execution ? proof.execution.receipt : undefined;
  if (!receipt?.commit_sha) {
    return fail("execute", `no execution receipt (outcome=${proof.outcome}${proof.execution?.error ? `: ${proof.execution.error}` : ""})`, { proof });
  }
  ids.commit_sha = receipt.commit_sha;
  ids.commit_url = receipt.commit_url;
  line("commit", receipt.commit_sha);
  if (receipt.commit_url) line("commit url", receipt.commit_url);

  // 6. Effect: the tool's re-read, then ours.
  stage(6, "RECORD   the effect is re-read and the proof is recorded");
  if (proof.outcome !== "executed" || proof.effect?.established !== true) {
    return fail("record", `effect not established (outcome=${proof.outcome}). Say "written, effect not confirmed", never "verified".`, { proof });
  }
  let observed = null;
  for (let i = 0; i < 4; i++) {
    observed = await o.readHead(o.path);
    if (observed === o.content) break;
    if (o.sleep) await o.sleep(2000);
  }
  if (observed !== o.content) return fail("record", "our own re-read of the branch head does not show the approved bytes", { proof });
  ids.proof_sha256 = proof.proof_sha256;
  line("effect (adapter)", `established: at commit ${proof.effect.detail?.at_commit_matches ? "matches" : "?"}, at branch head ${proof.effect.detail?.at_branch_head_matches ? "matches" : "?"}`);
  line("effect (demo re-read)", "branch head holds exactly the approved bytes");
  line("audit_id", ids.audit_id ?? "(not reported)");
  line("proof", proof.version);
  line("proof_sha256", proof.proof_sha256);
  say();
  say(`${elapsed().padStart(8)}  DONE: held -> approved -> exactly that change executed once -> effect recorded.`);
  if (o.simulated) say("This was a SIMULATED run. Run without --simulate against a runtime to show it live.");
  return { ok: true, ids, proof };
}
