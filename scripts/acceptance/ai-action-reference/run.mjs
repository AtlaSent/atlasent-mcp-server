#!/usr/bin/env node
// AI Action Protection — reference scenario on runtime STAGING, against a REAL
// GitHub repository (atlasent-docs CROSS-064, design-partner acceptance DP-1..DP-9).
//
// An AI agent (a CROSS-056 agent-bound key) tries to change a configuration
// file in an AtlaSent-controlled repository. The same runtime lifecycle as
// Production Change Protection decides:
//
//   agent identity + sealed provenance -> agent.tool.invoke -> HOLD
//   -> a person approves in the staging console -> claim -> bounded permit
//   -> verify at the boundary -> GitHub write (once) -> effect re-read -> proof
//
// Cases (each records PASS/FAIL; a change reaching GitHub when it should not is FAIL):
//   A  untrusted agent (identity for another agent) is refused; file unchanged
//   B  the action is held for organizational approval; file unchanged while pending
//   C  a changed action cannot use the approval (refused locally, and PAYLOAD_MISMATCH at verify)
//   D  the exact approved action executes once; the effect is re-read and matches
//   E  replay: the consumed permit is refused (PERMIT_ALREADY_USED); no second write
//   F  circuit breaker E1: the target changes after authorization -> refused before verify
//   G  proof names agent + action + decision + execution + effect
//   (B1, agent stopped after issuance, needs an operator to pause the agent: set
//    CASE_B1=1 and pause the agent in the console when prompted.)
//
// Env:
//   ATLASENT_HOOKS_API_KEY            the agent-bound staging key (never written anywhere)
//   ATLASENT_AI_ACTION_GITHUB_TOKEN   token that can write ONLY the reference repo
//   ATLASENT_AI_ACTION_GITHUB_REPO    default AtlaSent-Reference/pilot-deploy-gate
//   ATLASENT_AI_ACTION_GITHUB_BRANCH  required; the branch the agent may change
//   APPROVAL_WAIT_MS                  default 15 min
//
// Run from the repo root after `npm run build`:
//   node scripts/acceptance/ai-action-reference/run.mjs
// Writes ./ai-action-reference-evidence-<ts>.json (permits recorded as sha256 only).
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const BASE = process.env.ATLASENT_BASE_URL ?? 'https://lwnqpmnxpeyhpxvastku.supabase.co/functions/v1';
const KEY = process.env.ATLASENT_HOOKS_API_KEY;
const GH_TOKEN = process.env.ATLASENT_AI_ACTION_GITHUB_TOKEN;
const REPO = process.env.ATLASENT_AI_ACTION_GITHUB_REPO ?? 'AtlaSent-Reference/pilot-deploy-gate';
const BRANCH = process.env.ATLASENT_AI_ACTION_GITHUB_BRANCH;
const ENV = 'staging';
const WAIT_MS = Number(process.env.APPROVAL_WAIT_MS ?? 15 * 60_000);
if (!BASE.includes('lwnqpmnxpeyhpxvastku')) { console.error('Refusing: this acceptance runs on runtime staging only.'); process.exit(2); }
if (!KEY || !/^ask_(test|live)_/.test(KEY)) { console.error('Set ATLASENT_HOOKS_API_KEY to the agent-bound staging key.'); process.exit(2); }
if (!GH_TOKEN || !BRANCH) { console.error('Set ATLASENT_AI_ACTION_GITHUB_TOKEN and ATLASENT_AI_ACTION_GITHUB_BRANCH.'); process.exit(2); }

process.env.ATLASENT_MODE = 'remote';
process.env.ATLASENT_API_KEY = KEY;
process.env.ATLASENT_BASE_URL = BASE;

const engine = await import('../../../dist/engine.js');
const ga = await import('../../../dist/governedAction.js');
const gh = await import('../../../dist/githubFileAdapter.js');

const [owner, repo] = REPO.split('/');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const PATH = `ai-action-reference/flags-${stamp}.json`;
const evidence = { started_at: new Date().toISOString(), runtime: BASE, environment: ENV, repository: REPO, branch: BRANCH, path: PATH, cases: [], proofs: [], result: null };
const record = (id, claim, pass, detail = {}) => { evidence.cases.push({ id, claim, pass, ...detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${claim}`, JSON.stringify(detail).slice(0, 400)); };
const target = { owner, repo, branch: BRANCH, path: PATH };

async function headContent() {
  const b = await gh.githubFileAdapter(target, '', { token: GH_TOKEN }).readBlob();
  return b ? b.content : null;
}
async function specFor(content, message) {
  const adapter = gh.githubFileAdapter(target, content, { token: GH_TOKEN });
  const base = (await adapter.readState()).digest;
  return { spec: gh.githubFileChangeSpec({ ...target, content, message }, base, ENV), adapter };
}

const V1 = '{"checkout_v2":true}\n';
const MSG = `AI Action Protection reference: enable checkout_v2 (${stamp})`;
const breaker = new ga.CircuitBreaker();
const fns = { authorize: engine.authorize, verify: engine.verify, getMode: engine.getMode };

async function main() {
  // A. Untrusted agent: an identity presented for a different agent is refused.
  {
    const mint = await engine.mintAgentActorIdentity('agent.tool.invoke', ENV);
    if (!mint.ok) throw Error(`the key cannot mint an agent identity: ${mint.reason}`);
    const forged = JSON.parse(JSON.stringify(mint.actor_identity));
    forged.subject.principal_id = `agent:${randomUUID()}`;
    const res = await fetch(`${BASE}/v1-evaluate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ action_type: 'agent.tool.invoke', actor_id: forged.subject.principal_id, actor_identity: forged, request_id: randomUUID(), resource_id: gh.githubTargetId(target), context: { tool: gh.GITHUB_CONTENTS_TOOL, environment: ENV } }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await res.json().catch(() => null);
    record('A', 'untrusted agent identity is refused, no permit', !j?.permit_token && (res.status >= 400 || j?.decision === 'deny'), { http: res.status, decision: j?.decision, deny_code: j?.deny_code ?? j?.error });
  }

  // B. Hold for organizational approval.
  const { spec, adapter } = await specFor(V1, MSG);
  evidence.action_digest = ga.actionDigest(spec);
  const auth = await ga.requestAuthorization(spec, 'agent:reported', fns);
  const d = auth.decision;
  const held = d.decision === 'hold' && typeof d.approval_request_id === 'string';
  record('B', 'the change is held for approval and the file does not exist yet', held && (await headContent()) === null, { decision: d.decision, approval_request_id: d.approval_request_id, deny_code: d.deny_code, notes: d.notes });
  if (!held) throw Error('expected a hold; is the staging org agent.tool.invoke policy requires_human_approval?');
  if (!d.sealed_binding || ga.sealedActionHash(d.sealed_binding, spec) !== d.bound_payload_hash) throw Error('sealed provenance was not admitted or does not match this change');

  console.log(`\n>>> Approve ${d.approval_request_id} in the staging console now (Approvals). Waiting up to ${WAIT_MS / 60000} min.\n`);
  const waited = await engine.awaitApproval({ approval_request_id: d.approval_request_id, max_wait_ms: WAIT_MS, poll_interval_ms: 5000 });
  if (waited.outcome !== 'approved') throw Error(`approval ended ${waited.outcome}: ${waited.reasons?.join('; ')}`);
  const permit = waited.permit_token;
  const actorId = d.bound_actor_id;
  evidence.agent = actorId;
  evidence.approval_request_id = d.approval_request_id;
  record('B2', 'file still unchanged after approval, before execution', (await headContent()) === null);

  // C. Changed action cannot use the approval: present the altered action at verify.
  {
    const altered = { ...spec, arguments: { ...spec.arguments, content_sha256: ga.sha256Hex('{"checkout_v2":true,"admin":true}\n') } };
    const v = await engine.verify(permit, { action_type: 'agent.tool.invoke', actor_id: actorId, environment: ENV, target_id: spec.target_id, payload_hash: ga.sealedActionHash(d.sealed_binding, altered) });
    record('C', 'a changed action is refused at verify (permit bound to the approved change)', v.valid !== true, { outcome: v.outcome, verify_error_code: v.verify_error_code });
    if (v.valid === true) throw Error('altered action verified: STOP');
    record('C2', 'nothing was written', (await headContent()) === null);
  }

  // D + G. Exact action executes once; effect re-read.
  const proof = await ga.executeGoverned({ spec, actorId, permitToken: permit, sealedBinding: d.sealed_binding, decision: { decision: 'allow', approval_request_id: d.approval_request_id, ...(d.audit_id && { audit_id: d.audit_id }) }, adapter, breaker, verify: engine.verify, argumentsCheck: () => (ga.sha256Hex(V1) === spec.arguments.content_sha256 ? null : 'content mismatch') });
  evidence.proofs.push(proof);
  record('D', 'the exact approved change executed once and its effect is established', proof.outcome === 'executed' && (await headContent()) === V1, { outcome: proof.outcome, commit: proof.execution?.receipt?.commit_sha, effect: proof.effect });
  record('G', 'proof identifies agent + action + decision + execution + effect', !!(proof.agent.actor_id && proof.action.action_digest && proof.decision.approval_request_id && proof.permit.verified && proof.execution && proof.effect?.established), { proof_sha256: proof.proof_sha256 });

  // E. Replay.
  {
    const replay = await ga.executeGoverned({ spec: { ...spec, arguments: { ...spec.arguments, base_state: `blob:${proof.execution.receipt.blob_sha}` } }, actorId, permitToken: permit, sealedBinding: d.sealed_binding, decision: { decision: 'allow' }, adapter, breaker, verify: engine.verify });
    record('E', 'replaying the consumed permit is refused and nothing is written again', replay.outcome === 'refused_verify', { outcome: replay.outcome, verify_error_code: replay.permit.verify_error_code });
  }

  // F. Circuit breaker E1: target changes after authorization.
  {
    const V2 = '{"checkout_v2":false}\n';
    const second = await specFor(V2, `${MSG} (revert)`);
    const a2 = await ga.requestAuthorization(second.spec, 'agent:reported', fns);
    // Someone else changes the file after authorization (the scenario's operator write, not the agent).
    const other = gh.githubFileAdapter(target, '{"changed_by":"someone else"}\n', { token: GH_TOKEN });
    const baseNow = (await other.readState()).digest;
    await other.execute({ ...second.spec, arguments: { ...second.spec.arguments, base_state: baseNow, message: `${MSG} (concurrent change)` } });
    const permit2 = a2.decision.decision === 'allow' ? a2.decision.permit_token : 'no-permit-held';
    const p2 = await ga.executeGoverned({ spec: second.spec, actorId, permitToken: permit2, sealedBinding: a2.decision.sealed_binding, decision: a2.decision, adapter: second.adapter, breaker, verify: engine.verify });
    record('F', 'target changed after authorization -> refused before verify (permit unspent)', p2.outcome === 'refused_target_changed' && p2.permit.verified === false, { outcome: p2.outcome, authorization: a2.decision.decision });
  }
}

try {
  await main();
  const failed = evidence.cases.filter((c) => !c.pass);
  evidence.result = failed.length ? `FAIL (${failed.map((f) => f.id).join(', ')})` : 'PASS';
} catch (e) {
  evidence.result = `FAIL: ${e.message}`;
}
evidence.finished_at = new Date().toISOString();
const file = `ai-action-reference-evidence-${stamp}.json`;
writeFileSync(file, JSON.stringify(evidence, (k, v) => (k === 'permit_token' ? undefined : v), 2));
console.log(`\nRESULT: ${evidence.result}\nEvidence: ${file}`);
process.exit(evidence.result === 'PASS' ? 0 : 1);
