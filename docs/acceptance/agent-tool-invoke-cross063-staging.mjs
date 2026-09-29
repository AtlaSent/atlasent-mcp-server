#!/usr/bin/env node
// CROSS-063 agent acceptance on runtime STAGING, with a real agent-bound key.
//
//   agent identity -> sealed provenance -> agent.tool.invoke -> HOLD
//   -> a person approves in the console -> claim (agent identity) -> bound permit
//   -> exact retry (idempotent, no second hold) -> verify -> execute ONCE -> evidence
//
// Negative proofs, each on a fresh request that would otherwise HOLD. A hold or
// allow on any of them is a FAIL: each must be refused with no permit.
//   missing identity, identity re-bound to another org, identity for another
//   action, another agent (assertion and actor_id), context changed after
//   sealing, tampered provenance, provenance replayed on a new request, exact
//   request replay, permit reuse, second claim.
//
// Usage (Git Bash):
//   export ATLASENT_HOOKS_API_KEY='ask_test_...'     # the agent-bound key
//   node.exe agent-tool-invoke-cross063-staging.mjs
// Writes ./cross063-evidence-<timestamp>.json. Never writes the key; permit
// tokens are recorded as a prefix only.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BASE = process.env.ATLASENT_BASE_URL ?? 'https://lwnqpmnxpeyhpxvastku.supabase.co/functions/v1';
const KEY = process.env.ATLASENT_HOOKS_API_KEY ?? process.env.ATLASENT_API_KEY;
const ENV = 'staging';
const ACTION = 'agent.tool.invoke';
const WAIT_MS = Number(process.env.APPROVAL_WAIT_MS ?? 15 * 60_000);
if (!KEY || !/^ask_(test|live)_/.test(KEY)) { console.error('Set ATLASENT_HOOKS_API_KEY to the agent-bound key.'); process.exit(2); }
if (!BASE.includes('lwnqpmnxpeyhpxvastku')) { console.error('Refusing: this acceptance runs on runtime staging only.'); process.exit(2); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidence = { started_at: new Date().toISOString(), base: BASE, environment: ENV, action_type: ACTION, steps: [], negatives: [], result: null };
const short = t => (typeof t === 'string' ? `${t.slice(0, 12)}…` : t);
const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');
const clone = o => JSON.parse(JSON.stringify(o));

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, 'User-Agent': 'cross063-acceptance' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
const summary = r => ({
  http: r.status,
  decision: r.json?.decision, deny_code: r.json?.deny_code, deny_reason: r.json?.deny_reason?.slice?.(0, 240),
  error: r.json?.error, message: r.json?.message?.slice?.(0, 240),
  approval_request_id: r.json?.approval_request_id, idempotent_replay: r.json?.idempotent_replay,
  permit_token: short(r.json?.permit_token), source_provenance_admitted: !!r.json?.source_provenance,
  evaluation_id: r.json?.evaluation_id ?? r.json?.decision_id, request_id: r.json?.request_id,
  valid: r.json?.valid, outcome: r.json?.outcome, verify_error_code: r.json?.verify_error_code, claimed: r.json?.claimed,
});
const step = (name, r, extra = {}) => { const s = { name, ...summary(r), ...extra }; evidence.steps.push(s); console.log(`- ${name}:`, JSON.stringify(s)); return s; };

const mint = (action = ACTION) => call('POST', '/v1-agent-actor-identity', { action_type: action, environment: ENV });
function assertionOf(r) {
  const a = r.json?.assertion;
  if (r.status !== 200 || a?.version !== 'actor_identity.v1' || a?.subject?.principal_kind !== 'agent') {
    throw Error(`identity mint failed: ${JSON.stringify(summary(r))}`);
  }
  return a;
}

// One protected action: a harmless command, bound by digest.
const COMMAND = `echo cross063-acceptance-${stamp}`;
const TARGET = `cross063-acceptance@staging`;
const DIGEST = sha(JSON.stringify({ tool_name: 'Bash', tool_input: { command: COMMAND } }));
const contextFor = () => ({
  tool: 'Bash', environment: ENV, target_id: TARGET, target: { id: TARGET },
  action_digest: DIGEST, action_preview: COMMAND,
});

async function sealed(requestId, context = contextFor()) {
  const r = await call('POST', '/v1-source-provenance-seal', { action_type: ACTION, request_id: requestId, context, resource_id: TARGET });
  if (r.status !== 200 || !r.json?.source_provenance || !/^[0-9a-f]{64}$/.test(r.json?.action_hash ?? '')) {
    throw Error(`seal failed: ${JSON.stringify(summary(r))}`);
  }
  return { source_provenance: r.json.source_provenance, action_hash: r.json.action_hash, context };
}
const evalBody = (requestId, identity, seal) => ({
  action_type: ACTION, request_id: requestId, actor_identity: identity, resource_id: TARGET,
  execution_payload_hash: DIGEST, state_snapshot: { source: 'cross063-acceptance', complete: true },
  context: seal.context, source_provenance: seal.source_provenance,
});

async function negative(name, mutate, expect = 'refused') {
  try {
    const id = assertionOf(await mint());
    const rid = randomUUID();
    const s = await sealed(rid);
    const body = evalBody(rid, id, s);
    await mutate(body, { id, rid, s });
    const r = await call('POST', '/v1-evaluate', body);
    const refused = !r.json?.permit_token && (r.json?.decision === 'deny' || r.status >= 400);
    const row = { name, pass: refused, expected: expect, ...summary(r) };
    evidence.negatives.push(row);
    console.log(`${refused ? 'PASS' : 'FAIL'} negative: ${name}`, JSON.stringify(summary(r)));
  } catch (e) {
    evidence.negatives.push({ name, pass: false, error: String(e.message ?? e) });
    console.log(`FAIL negative: ${name} (${e.message})`);
  }
}

async function main() {
  // 1. Positive start: identity -> seal -> evaluate -> HOLD.
  const identity = assertionOf(await mint());
  evidence.agent = identity.subject.principal_id;
  evidence.tenant = identity.binding.tenant_id;
  const R = randomUUID();
  const seal = await sealed(R);
  const body = evalBody(R, identity, seal);
  const first = await call('POST', '/v1-evaluate', body);
  step('evaluate (positive)', first, { request_id_sent: R, action_hash: seal.action_hash });
  const approvalId = first.json?.approval_request_id;
  if (!(first.json?.decision === 'hold' || first.json?.decision === 'escalate') || !approvalId) {
    throw Error('The positive request was not held with an approval id. Is the org\'s agent.tool.invoke policy a Hold?');
  }
  console.log(`\n>>> Approve ${approvalId} in the staging console now (Approvals). Negatives run while you do.\n`);

  // 2. Negatives (each a fresh request that would otherwise HOLD).
  await negative('missing identity', b => { delete b.actor_identity; });
  await negative('identity re-bound to another org (tenant_id edited)', b => { b.actor_identity.binding.tenant_id = randomUUID(); });
  await negative('identity minted for another action (agent.tool_call)', async b => { b.actor_identity = assertionOf(await mint('agent.tool_call')); });
  await negative('another agent in the assertion (principal_id edited)', b => { b.actor_identity.subject.principal_id = `agent:${randomUUID()}`; });
  await negative('another agent as actor_id', b => { b.actor_id = `agent:${randomUUID()}`; });
  await negative('context changed after sealing', b => { b.context = { ...b.context, action_preview: 'rm -rf /tmp/x' }; });
  await negative('tampered provenance (signature edited)', b => {
    const sp = b.source_provenance;
    const k = ['signature', 'sig', 'proof'].find(x => typeof sp[x] === 'string');
    if (k) sp[k] = sp[k].slice(0, -4) + (sp[k].endsWith('AAAA') ? 'BBBB' : 'AAAA');
    else sp.tampered = true;
  });
  await negative('provenance replayed on a new request_id', async (b, { s }) => {
    const other = randomUUID(); b.request_id = other; b.source_provenance = clone(seal.source_provenance); void s;
  });

  // 3. Wait for a person.
  const until = Date.now() + WAIT_MS;
  let status;
  for (;;) {
    const r = await call('GET', `/v1-approvals/${approvalId}`);
    status = r.json?.status;
    if (status && status !== 'pending') { step('approval status', r, { status, resolved_by: r.json?.resolved_by ?? r.json?.approver_id }); break; }
    if (Date.now() > until) throw Error(`approval ${approvalId} still pending after ${WAIT_MS / 60000} min`);
    await new Promise(res => setTimeout(res, 5000));
  }
  if (status !== 'approved_awaiting_claim' && status !== 'approved') throw Error(`approval ended ${status}`);

  // 4. Claim with a fresh agent identity -> bound permit.
  const claimIdentity = assertionOf(await mint());
  const claim = await call('POST', `/v1-approvals/${approvalId}/claim-permit`, status === 'approved_awaiting_claim' ? { actor_identity: claimIdentity } : {});
  step('claim', claim);
  const permit = claim.json?.permit_token;
  if (!(claim.status === 200 && claim.json?.claimed === true && permit)) throw Error('claim returned no permit');

  // 5. Exact retry of the same request: replayed, no second hold, no permit.
  const retry = await call('POST', '/v1-evaluate', body);
  step('exact retry (same request_id)', retry);
  evidence.negatives.push({ name: 'exact request replay', pass: retry.json?.idempotent_replay === true && !retry.json?.permit_token, ...summary(retry) });

  // 6. Second claim: refused.
  const claim2 = await call('POST', `/v1-approvals/${approvalId}/claim-permit`, { actor_identity: assertionOf(await mint()) });
  evidence.negatives.push({ name: 'second claim', pass: !claim2.json?.permit_token, ...summary(claim2) });

  // 7. Verify against exactly the binding, then execute ONCE.
  const verifyBody = { permit_token: permit, action_type: ACTION, actor_id: identity.subject.principal_id, environment: ENV, target_id: TARGET, payload_hash: seal.action_hash };
  const v = await call('POST', '/v1-verify-permit', verifyBody);
  step('verify', v);
  if (!(v.json?.valid === true && v.json?.outcome === 'allow')) throw Error('permit did not verify');
  const out = execFileSync('bash', ['-c', COMMAND], { encoding: 'utf8' }).trim();
  evidence.execution = { command: COMMAND, output: out, executions: 1, at: new Date().toISOString() };
  console.log(`- executed once: ${out}`);

  // 8. Permit reuse: the consumed permit must not verify again.
  const v2 = await call('POST', '/v1-verify-permit', verifyBody);
  evidence.negatives.push({ name: 'permit reuse', pass: v2.json?.valid !== true, ...summary(v2) });

  // Decision rows for R are read from the runtime separately (there is no
  // key-scoped eval-log on the runtime); R is recorded above.
  evidence.request_id = R;
  evidence.approval_request_id = approvalId;
}

try {
  await main();
  const failed = evidence.negatives.filter(n => !n.pass);
  evidence.result = failed.length ? `FAIL (${failed.map(f => f.name).join('; ')})` : 'PASS';
} catch (e) {
  evidence.result = `FAIL: ${e.message}`;
}
evidence.finished_at = new Date().toISOString();
const file = `cross063-evidence-${stamp}.json`;
writeFileSync(file, JSON.stringify(evidence, null, 2));
console.log(`\nRESULT: ${evidence.result}\nEvidence: ${file}`);
process.exit(evidence.result === 'PASS' ? 0 : 1);
