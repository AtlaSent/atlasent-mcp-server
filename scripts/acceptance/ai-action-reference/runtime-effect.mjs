#!/usr/bin/env node
// G3/G4 staging acceptance: AI Action Protection with RUNTIME-ESTABLISHED
// effects (atlasent-docs CROSS-064 G4), against a REAL GitHub repository whose
// pushes reach runtime STAGING through the "AtlaSent Staging" GitHub App.
//
// Four governed GitHub writes, each held for one human approval, then:
//
//   A  ESTABLISHED  the exact approved write executes once (consume-and-admit),
//                   GitHub's signed push event reaches the runtime, and the
//                   runtime establishes the effect from that event. A replay of
//                   the consumed permit is refused.
//   B  SUPERSEDED   the approved write lands, then someone else changes the
//                   same path: the runtime reports superseded /
//                   later_change_to_same_path, never established.
//   C  MISMATCH     the operation is admitted for content X, but the bytes that
//                   land are Y: mismatch / content_not_authorized.
//   D  WRONG REF    the operation is admitted for branch B, the write lands on
//                   another branch: never established.
//
// Keys (never printed, never written to the evidence file):
//   ATLASENT_HOOKS_API_KEY        agent-bound staging key (evaluate, claim)
//   ATLASENT_EXECUTOR_API_KEY     same org; verify:execute + consequential_operations:write
//   ATLASENT_AI_ACTION_GITHUB_TOKEN  contents:write on the repo below
// Optional:
//   ATLASENT_AI_ACTION_GITHUB_REPO   default Atlasent/atlasent-api
//   APPROVAL_WAIT_MS                 default 20 min
//
// Run from the repo root after `npm run build`:
//   node scripts/acceptance/ai-action-reference/runtime-effect.mjs
// Writes ./g3-g4-runtime-effect-evidence-<ts>.json. Permits are recorded as sha256 only.
import { writeFileSync } from 'node:fs';

const BASE = process.env.ATLASENT_BASE_URL ?? 'https://lwnqpmnxpeyhpxvastku.supabase.co/functions/v1';
const AGENT_KEY = process.env.ATLASENT_HOOKS_API_KEY;
const EXEC_KEY = process.env.ATLASENT_EXECUTOR_API_KEY;
const GH_TOKEN = process.env.ATLASENT_AI_ACTION_GITHUB_TOKEN;
const REPO = process.env.ATLASENT_AI_ACTION_GITHUB_REPO ?? 'Atlasent/atlasent-api';
const ENV = 'staging';
const WAIT_MS = Number(process.env.APPROVAL_WAIT_MS ?? 20 * 60_000);
const fail = (m) => { console.error(m); process.exit(2); };
if (!BASE.includes('lwnqpmnxpeyhpxvastku')) fail('Refusing: this acceptance runs on runtime staging only.');
if (!AGENT_KEY || !/^ask_(test|live)_/.test(AGENT_KEY)) fail('Set ATLASENT_HOOKS_API_KEY to the agent-bound staging key.');
if (!EXEC_KEY || !/^ask_(test|live)_/.test(EXEC_KEY)) fail('Set ATLASENT_EXECUTOR_API_KEY (verify:execute + consequential_operations:write).');
if (!GH_TOKEN) fail('Set ATLASENT_AI_ACTION_GITHUB_TOKEN.');

process.env.ATLASENT_MODE = 'remote';
process.env.ATLASENT_BASE_URL = BASE;
const useKey = (k) => { process.env.ATLASENT_API_KEY = k; };
useKey(AGENT_KEY);

const engine = await import('../../../dist/engine.js');
const ga = await import('../../../dist/governedAction.js');
const gh = await import('../../../dist/githubFileAdapter.js');

const [owner, repo] = REPO.split('/');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const BRANCH = `g3-acceptance/${stamp}`;
const OTHER = `g3-acceptance/${stamp}-other`;
const DIR = `g3-acceptance/${stamp}`;
const sha256 = (s) => ga.sha256Hex(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { version: 'g3_g4_runtime_effect_acceptance.v1', started_at: new Date().toISOString(), runtime: BASE, environment: ENV, repository: REPO, branch: BRANCH, cases: [], result: null };
const record = (id, claim, pass, detail = {}) => { evidence.cases.push({ id, claim, pass, ...detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${claim}`, JSON.stringify(detail).slice(0, 500)); };

async function ghApi(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    method, headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** A write by someone other than the governed executor (no permit involved). */
async function rawWrite(branch, path, content, message) {
  const cur = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' } });
  const sha = cur.ok ? (await cur.json()).sha : undefined;
  const r = await ghApi('PUT', `/contents/${path}`, { message, branch, content: Buffer.from(content).toString('base64'), ...(sha && { sha }) });
  return { commit: r.commit.sha, blob: r.content.sha };
}

const withExec = async (fn) => { useKey(EXEC_KEY); try { return await fn(); } finally { useKey(AGENT_KEY); } };
const fns = { authorize: engine.authorize, verify: engine.verify, getMode: engine.getMode };

/** Request authorization for one governed write; returns the held request. */
async function requestHeld(id, path, content) {
  const target = { owner, repo, branch: BRANCH, path };
  const change = { ...target, content, message: `G3/G4 acceptance ${id} (${stamp})` };
  const adapter = gh.githubFileAdapter(target, content, { token: GH_TOKEN });
  const base = (await adapter.readState()).digest;
  const spec = gh.githubFileChangeSpec(change, base, ENV, { withExpectedEffect: true });
  const auth = await ga.requestAuthorization(spec, 'agent:reported', fns);
  const d = auth.decision;
  const ok = d.decision === 'hold' && typeof d.approval_request_id === 'string' && !!d.sealed_binding && ga.sealedActionHash(d.sealed_binding, spec) === d.bound_payload_hash;
  record(`${id}.held`, `${id}: the write is held for human approval with sealed provenance bound to this exact change`, ok,
    { decision: d.decision, approval_request_id: d.approval_request_id, deny_code: d.deny_code, notes: d.notes, action_digest: auth.digest });
  if (!ok) throw Error(`${id}: expected a sealed hold`);
  return { id, target, change, content, spec, adapter, d };
}

async function claim(h) {
  const w = await engine.awaitApproval({ approval_request_id: h.d.approval_request_id, max_wait_ms: WAIT_MS, poll_interval_ms: 5000 });
  if (w.outcome !== 'approved') throw Error(`${h.id}: approval ended ${w.outcome}: ${w.reasons?.join('; ')}`);
  h.permit = w.permit_token;
  h.boundary = { action_type: 'agent.tool.invoke', actor_id: h.d.bound_actor_id, target_id: h.spec.target_id, environment: ENV, payload_hash: ga.sealedActionHash(h.d.sealed_binding, h.spec) };
  return h;
}

const admit = (h) => withExec(() => engine.admitGovernedOperation(h.permit, h.boundary, { provider: 'github', operation_key: `ai-action:${ga.actionDigest(h.spec)}` }));

async function establishUntil(op, expected, accept, maxMs = 120_000) {
  let last;
  for (let t = 0; t <= maxMs; t += 6000) {
    last = await withExec(() => engine.establishGovernedEffect({ ...op, expected_effect: expected }));
    if (accept(last)) return last;
    await sleep(6000);
  }
  return last;
}

async function main() {
  // Baseline: create the branch so a push for it reaches the runtime BEFORE any admission.
  const mainRef = await ghApi('GET', '/git/ref/heads/main');
  await ghApi('POST', '/git/refs', { ref: `refs/heads/${BRANCH}`, sha: mainRef.object.sha });
  await ghApi('POST', '/git/refs', { ref: `refs/heads/${OTHER}`, sha: mainRef.object.sha });
  evidence.base_commit = mainRef.object.sha;
  console.log(`branch ${BRANCH} created at ${mainRef.object.sha}; letting the baseline push reach staging...`);
  await sleep(20_000);

  const A = await requestHeld('A', `${DIR}/a.json`, '{"case":"A","checkout_v2":true}\n');
  const B = await requestHeld('B', `${DIR}/b.json`, '{"case":"B","checkout_v2":true}\n');
  const C = await requestHeld('C', `${DIR}/c.json`, '{"case":"C","checkout_v2":true}\n');
  const D = await requestHeld('D', `${DIR}/d.json`, '{"case":"D","checkout_v2":true}\n');
  const ids = [A, B, C, D].map((h) => h.d.approval_request_id);
  console.log(`\n>>> Approve these 4 requests in the staging console (Accounting_Demo -> Approvals) now:\n    ${ids.join('\n    ')}\n    Waiting up to ${WAIT_MS / 60000} min each.\n`);
  for (const h of [A, B, C, D]) await claim(h);
  record('approvals', 'all four approvals claimed as bounded permits; nothing written yet', true, { approval_request_ids: ids, permit_sha256: [A, B, C, D].map((h) => sha256(h.permit)) });

  // A: established, through the shipped executor with runtime effect establishment.
  {
    const proof = await ga.executeGoverned({
      spec: A.spec, actorId: A.d.bound_actor_id, permitToken: A.permit, sealedBinding: A.d.sealed_binding,
      decision: { decision: 'allow', approval_request_id: A.d.approval_request_id }, adapter: A.adapter, breaker: new ga.CircuitBreaker(), verify: engine.verify,
      argumentsCheck: () => (sha256(A.content) === A.spec.arguments.content_sha256 ? null : 'content mismatch'),
      runtimeEffect: { admit: (p, c, o) => withExec(() => engine.admitGovernedOperation(p, c, o)), establish: (r) => withExec(() => engine.establishGovernedEffect(r)), provider: 'github', waitMs: 120_000, pollMs: 6000 },
    });
    evidence.proof_A = proof;
    record('A', 'the approved write executed once and the RUNTIME established it from the GitHub push event', proof.outcome === 'executed' && proof.effect?.runtime?.verdict === 'established',
      { outcome: proof.outcome, operation: proof.operation, commit: proof.execution?.receipt?.commit_sha, runtime: proof.effect?.runtime });
    const replay = await admit(A);
    record('A.replay', 'replaying the consumed permit is refused and admits nothing', replay.valid !== true, { outcome: replay.outcome, verify_error_code: replay.verify_error_code });
  }

  // B: superseded.
  {
    const a = await admit(B);
    if (!a.valid) throw Error(`B admit refused: ${a.reason}`);
    const receipt = await B.adapter.execute(B.spec);
    await sleep(3000);
    const later = await rawWrite(BRANCH, B.target.path, '{"case":"B","changed_by":"someone else"}\n', `G3/G4 acceptance B: later change (${stamp})`);
    const r = await establishUntil({ operation_id: a.operation_id, attempt_id: a.attempt_id }, B.spec.arguments.expected_effect, (x) => x.verdict === 'superseded' || x.verdict === 'established' || x.verdict === 'mismatch');
    record('B', 'a later change to the same path makes the effect SUPERSEDED, never established', r.verdict === 'superseded',
      { operation_id: a.operation_id, effect_commit: receipt.commit_sha, later_commit: later.commit, verdict: r.verdict, reason: r.reason, evidence: r.evidence });
  }

  // C: mismatch — admitted for one content, different bytes land.
  {
    const a = await admit(C);
    if (!a.valid) throw Error(`C admit refused: ${a.reason}`);
    const rogue = await rawWrite(BRANCH, C.target.path, '{"case":"C","checkout_v2":true,"admin":true}\n', `G3/G4 acceptance C: unauthorized content (${stamp})`);
    const r = await establishUntil({ operation_id: a.operation_id, attempt_id: a.attempt_id }, C.spec.arguments.expected_effect, (x) => x.verdict === 'mismatch' || x.verdict === 'established' || x.verdict === 'superseded');
    record('C', 'bytes other than the authorized content are a MISMATCH (content_not_authorized)', r.verdict === 'mismatch' && r.reason === 'content_not_authorized',
      { operation_id: a.operation_id, rogue_commit: rogue.commit, verdict: r.verdict, reason: r.reason, evidence: r.evidence });
  }

  // D: wrong ref — the write lands on another branch.
  {
    const a = await admit(D);
    if (!a.valid) throw Error(`D admit refused: ${a.reason}`);
    const wrong = await rawWrite(OTHER, D.target.path, D.content, `G3/G4 acceptance D: right bytes, wrong branch (${stamp})`);
    const r = await establishUntil({ operation_id: a.operation_id, attempt_id: a.attempt_id }, D.spec.arguments.expected_effect, (x) => x.verdict === 'established', 60_000);
    record('D', 'the right bytes on the WRONG branch are never established', r.verdict !== 'established',
      { operation_id: a.operation_id, wrong_ref_commit: wrong.commit, verdict: r.verdict, reason: r.reason });
  }

  evidence.result = evidence.cases.every((c) => c.pass) ? 'pass' : 'fail';
}

try { await main(); } catch (e) { evidence.error = e instanceof Error ? e.message : String(e); evidence.result = 'fail'; console.error('STOPPED:', evidence.error); }
evidence.finished_at = new Date().toISOString();
const out = `g3-g4-runtime-effect-evidence-${stamp}.json`;
writeFileSync(out, JSON.stringify(evidence, (k, v) => (k === 'permit' ? undefined : v), 2));
console.log(`\nresult: ${evidence.result}   evidence: ${out}`);
process.exit(evidence.result === 'pass' ? 0 : 1);
