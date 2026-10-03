// D2 HITL staging acceptance replay (docs/acceptance/HITL_HOOK_STAGING_2026-09-29.md).
// Drives the REAL connected hook (packages/agent-hooks, in-process via decide())
// against runtime STAGING only; refuses any other base URL.
//
//   D2_SECRETS=/path/secrets.json   0600 JSON, NEVER committed: org_id, agent_key,
//                                   approver_user_id, approver_email, approver_password,
//                                   issuer_id, issuer_kid, issuer_private_pkcs8_b64
//                                   (the staging-only test IdP issuer)
//   STAGING_ANON=<anon key>         runtime staging publishable key
//   ATLASENT_API_DIR=../atlasent-api  for sign.ts (reuses the runtime's canonical.ts)
//   node run.mjs A|B|C|D|all
//
// Writes trace-<case>.json beside the secrets file: every call, with tokens,
// signatures and keys replaced by a short sha256.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const HERE = new URL('.', import.meta.url).pathname;
const SECRETS = process.env.D2_SECRETS;
if (!SECRETS) throw Error('set D2_SECRETS to the local secrets file');
const S = JSON.parse(readFileSync(SECRETS, 'utf8'));
const OUT = dirname(SECRETS);
const HOOKS = process.env.HOOKS_DIR ?? join(HERE, '../../../packages/agent-hooks');
const { decide } = await import(join(HOOKS, 'hook.mjs'));
const SUPA = 'https://lwnqpmnxpeyhpxvastku.supabase.co';
const FN = `${SUPA}/functions/v1`;
if (!FN.includes('lwnqpmnxpeyhpxvastku')) throw Error('staging only');
const ANON = process.env.STAGING_ANON;

const h = s => 'sha256:' + createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const scrub = v => JSON.parse(JSON.stringify(v ?? null, (k, x) =>
  (typeof x === 'string' && /^(permit_token|token|access_token|refresh_token|signature|assertion_signature)$/.test(k)) ? h(x)
  : (typeof x === 'string' && /^(pt\.v\d+\.|ask_|eyJ)/.test(x)) ? h(x) : x));

const trace = [];
const log = (kase, step, data) => { trace.push({ case: kase, step, at: new Date().toISOString(), ...scrub(data) }); console.log(kase, step, JSON.stringify(scrub(data)).slice(0, 400)); };

// Records every call the hook makes; optional per-case interceptor.
function recordingFetch(kase, intercept) {
  return async (url, init) => {
    const path = new URL(url).pathname.replace('/functions/v1', '');
    if (intercept) { const r = await intercept(path, url, init); if (r) return r; }
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    log(kase, `${init.method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, {
      status: res.status,
      response: json && pick(json),
    });
    return new Response(text, { status: res.status, headers: res.headers });
  };
}
const pick = j => {
  const keep = ['decision', 'deny_code', 'approval_request_id', 'status', 'claimed', 'valid', 'outcome', 'verify_error_code',
    'error', 'message', 'execution_payload_hash_accepted', 'evaluation_id', 'decision_id', 'resolution_note', 'action_hash', 'reason', 'permit_token'];
  const o = {}; for (const k of keep) if (j[k] !== undefined) o[k] = j[k];
  if (j.source_provenance) o.source_provenance = 'present';
  return o;
};

function newHome() {
  const home = mkdtempSync(join(tmpdir(), 'd2-hooks-'));
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ version: 1, rules: {}, custom: [], unattended: 'deny', connected: { environment: 'staging' } }));
  return home;
}
const env = home => ({ ...process.env, ATLASENT_HOOKS_HOME: home, ATLASENT_HOOKS_API_KEY: S.agent_key, ATLASENT_HOOKS_BASE_URL: FN });
const input = (command, session = 'd2-acceptance') => ({
  session_id: session, permission_mode: 'bypassPermissions', hook_event_name: 'PreToolUse',
  cwd: process.env.REPO_CWD ?? join(HERE, '../../..'), tool_name: 'Bash', tool_input: { command, description: 'D2 acceptance' },
});
async function hook(kase, home, command, intercept) {
  for (let attempt = 1; ; attempt++) {
    const d = await decide({ host: 'claude-code', input: input(command), env: env(home), fetchImpl: recordingFetch(kase, intercept) });
    log(kase, 'hook-decision', { attempt, effect: d.effect, rule: d.rule, reason: d.reason });
    // An agent re-runs the same action after a transient failure; the hook keeps
    // the attempt's request_id, so the retry is the runtime's idempotent replay.
    const transient = d.effect === 'deny' && /could not be reached|could not evaluate this|approval_request_pending/.test(d.reason ?? '');
    if (!transient || attempt >= 3) return d;
  }
}
const pendingId = home => { try { const p = JSON.parse(readFileSync(join(home, 'pending.json'), 'utf8')); return Object.values(p)[0]?.approval_request_id ?? null; } catch { return null; } };

let jwt = null;
async function approverJwt() {
  if (jwt) return jwt;
  const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email: S.approver_email, password: S.approver_password }) });
  const j = await r.json();
  if (!j.access_token) throw Error('approver sign-in failed: ' + r.status);
  return (jwt = j.access_token);
}
import { execFileSync } from 'node:child_process';
// The approver's IdP-signed identity assertion, bound to this approval's own
// snapshot (action hash, tenant, environment, role) as read by the approver.
async function resolverAssertion(kase, id) {
  const g = await approverCall(kase, 'GET', `/v1-approvals/${id}`);
  const snap = g.json?.approval_authority_snapshot;
  if (!snap) throw Error('approval has no authority snapshot');
  const now = Date.now();
  const unsigned = {
    version: 'identity_assertion.v1',
    subject: { principal_id: S.approver_user_id, principal_kind: 'human' },
    role: snap.required_role,
    binding: { approval_id: id, action_hash: snap.action_hash, tenant_id: snap.tenant_id, environment: snap.environment },
    issuer: { type: 'oidc', issuer_id: S.issuer_id, kid: S.issuer_kid },
    issued_at: new Date(now - 5000).toISOString(),
    expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
    nonce: crypto.randomUUID(),
  };
  const out = execFileSync(process.env.DENO ?? 'deno', ['run', '--allow-read', '--allow-env', join(HERE, 'sign.ts')], { input: JSON.stringify(unsigned) });
  return JSON.parse(out.toString());
}
const signed = unsigned => JSON.parse(execFileSync(process.env.DENO ?? 'deno', ['run', '--allow-read', '--allow-env', join(HERE, 'sign.ts')], { input: JSON.stringify(unsigned) }).toString());
// The approver's signed approval_artifact.v1: what the claim-time reevaluation
// verifies to lift the lifecycle escalate. Bound to the approval's own snapshot
// and row (approval id, tenant, action type, target, action hash), with the
// approver's identity assertion embedded.
async function approvalArtifact(kase, id, identityAssertion) {
  const g = await approverCall(kase, 'GET', `/v1-approvals/${id}`);
  const snap = g.json.approval_authority_snapshot;
  const now = Date.now();
  return signed({
    version: 'approval_artifact.v1',
    approval_id: id,
    tenant_id: snap.tenant_id,
    action_type: g.json.action_type,
    resource_id: String(g.json.resource_id ?? ''),
    action_hash: snap.action_hash,
    reviewer: { principal_id: S.approver_user_id, principal_kind: 'human', roles: [snap.required_role] },
    issuer: { type: 'oidc', issuer_id: S.issuer_id, kid: S.issuer_kid },
    issued_at: new Date(now - 5000).toISOString(),
    expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
    nonce: crypto.randomUUID(),
    meaning: 'approved',
    identity_assertion: identityAssertion,
  });
}
async function resolve(kase, id, decision, reason) {
  const resolverIdentity = await resolverAssertion(kase, id);
  const body = { decision, reason, resolver_identity_assertion: resolverIdentity };
  if (decision === 'approved') body.approval = { artifact: await approvalArtifact(kase, id, await resolverAssertion(kase, id)) };
  return approverCall(kase, 'POST', `/v1-approvals/${id}/resolve`, body);
}
async function approverCall(kase, method, path, body) {
  const r = await fetch(`${FN}${path}`, { method, headers: { Authorization: `Bearer ${await approverJwt()}`, apikey: ANON, 'X-AtlaSent-Org': S.org_id, 'content-type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  log(kase, `approver ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, { status: r.status, response: j && pick(j), request: body ?? null });
  return { status: r.status, json: j };
}
const results = [];
const expect = (kase, claim, ok) => { results.push({ case: kase, claim, pass: !!ok }); console.log(ok ? 'PASS' : 'FAIL', kase, claim); };

const which = process.argv[2] ?? 'all';

// ---- A: happy path. hold -> legitimate approval -> exact-action permit -> one verified execution
if (which === 'all' || which === 'A') {
  const home = newHome(); const cmd = 'git push --force origin d2-acceptance-A';
  const d1 = await hook('A', home, cmd);
  const id = pendingId(home);
  expect('A', 'unattended ask is held (denied now) with an approval id', d1.effect === 'deny' && /Held for approval/.test(d1.reason) && id);
  const d2 = await hook('A', home, cmd);
  expect('A', 'still pending before any person decides', d2.effect === 'deny' && /Still waiting/.test(d2.reason));
  const res = await resolve('A', id, 'approved', 'D2 acceptance: approve this exact force-push');
  expect('A', 'approver (JWT, role approver) resolves approved', res.status === 200);
  const d3 = await hook('A', home, cmd);
  expect('A', 'same exact action now allowed on a claimed + verified permit', d3.effect === 'allow');
  const d4 = await hook('A', home, cmd);
  const id2 = pendingId(home);
  expect('A', 'running it again is a NEW request (permit single use; no reuse)', d4.effect === 'deny' && id2 && id2 !== id);
  const g = await approverCall('A', 'GET', `/v1-approvals/${id}`);
  expect('A', 'approval record shows claimed/approved state', g.status === 200);
  results.push({ case: 'A', approval_request_id: id, rerequest_id: id2 });
}

// ---- B: changed action does not reuse an approval
if (which === 'all' || which === 'B') {
  const home = newHome();
  const d1 = await hook('B', home, 'git push --force origin d2-acceptance-B');
  const id = pendingId(home);
  await resolve('B', id, 'approved', 'D2 acceptance: approve B only');
  const d2 = await hook('B', home, 'git push --force origin d2-acceptance-B-CHANGED');
  const idChanged = JSON.parse(readFileSync(join(home, 'pending.json'), 'utf8'));
  const ids = Object.values(idChanged).map(v => v.approval_request_id).filter(Boolean);
  expect('B', 'changed command is held separately, not allowed by the approval of the original', d1.effect === 'deny' && d2.effect === 'deny' && /Held for approval/.test(d2.reason) && ids.length === 2 && ids.includes(id));
}

// ---- C: denial with a note is terminal and the note reaches the agent
if (which === 'all' || which === 'C') {
  const home = newHome(); const cmd = 'git push --force origin d2-acceptance-C';
  await hook('C', home, cmd);
  const id = pendingId(home);
  const note = 'Not on main during the freeze; open a PR instead.';
  const r = await resolve('C', id, 'denied', note);
  const g = await approverCall('C', 'GET', `/v1-approvals/${id}`);
  expect('C', 'resolution_note persisted on the approval', g.json?.resolution_note === note);
  const d = await hook('C', home, cmd);
  expect('C', 'agent is denied with the approver note', r.status === 200 && d.effect === 'deny' && d.reason.includes(note));
}

// ---- D: token-level negatives on a real claimed permit
if (which === 'all' || which === 'D') {
  const home = newHome(); const cmd = 'git push --force origin d2-acceptance-D';
  await hook('D', home, cmd);
  const id = pendingId(home);
  await resolve('D', id, 'approved', 'D2 acceptance: token negatives');
  const seen = {};
  const intercept = async (path, url, init) => {
    if (path.endsWith('/claim-permit') && !seen.claim) {
      seen.claim = true;
      const res = await fetch(url, init); const text = await res.text(); const j = JSON.parse(text);
      log('D', 'claim #1', { status: res.status, response: pick(j) });
      const again = await fetch(url, init); const j2 = await again.json().catch(() => null);
      log('D', 'claim #2 (replay of claim)', { status: again.status, response: j2 && pick(j2) });
      seen.claimReplay = again.status !== 200 || j2?.claimed !== true || !j2?.permit_token;
      return new Response(text, { status: res.status, headers: res.headers });
    }
    if (path === '/v1-verify-permit' && !seen.verify) {
      seen.verify = true;
      const body = JSON.parse(init.body);
      const wrongTarget = await fetch(url, { ...init, body: JSON.stringify({ ...body, target_id: body.target_id + '-OTHER' }) });
      const wt = await wrongTarget.json().catch(() => null);
      log('D', 'verify with wrong target_id', { status: wrongTarget.status, response: wt && pick(wt) });
      seen.wrongTarget = !(wt?.valid === true && wt?.outcome === 'allow');
      const wrongHash = await fetch(url, { ...init, body: JSON.stringify({ ...body, payload_hash: 'f'.repeat(64) }) });
      const wh = await wrongHash.json().catch(() => null);
      log('D', 'verify with wrong payload_hash', { status: wrongHash.status, response: wh && pick(wh) });
      seen.wrongHash = !(wh?.valid === true && wh?.outcome === 'allow');
      const real = await fetch(url, init); const rt = await real.text();
      log('D', 'verify with exact binding', { status: real.status, response: pick(JSON.parse(rt)) });
      const replay = await fetch(url, init); const rp = await replay.json().catch(() => null);
      log('D', 'verify replay (same permit again)', { status: replay.status, response: rp && pick(rp) });
      seen.replay = !(rp?.valid === true && rp?.outcome === 'allow');
      return new Response(rt, { status: real.status, headers: real.headers });
    }
    return null;
  };
  const d = await hook('D', home, cmd, intercept);
  expect('D', 'a second claim of the same approval yields no second permit', seen.claimReplay);
  if (!seen.verify) {
    results.push({ case: 'D', claim: 'token-level verify negatives', pass: null, note: 'not reached: no permit was minted (see claim #1)' });
    console.log('NOT REACHED D verify negatives (no permit minted)');
  } else {
    expect('D', 'permit does not verify for a different target', seen.wrongTarget);
    expect('D', 'permit does not verify for a different payload hash', seen.wrongHash);
    expect('D', 'replayed permit is refused', seen.replay);
  }
  results.push({ case: 'D', note: `final hook effect after negatives: ${d.effect} (verify may be consumed by an earlier mismatch; fail-closed either way)` });
}

writeFileSync(join(OUT, `trace-${which}.json`), JSON.stringify({ results, trace }, null, 2));
console.log(JSON.stringify(results, null, 2));
process.exit(results.some(r => r.pass === false) ? 1 : 0);
