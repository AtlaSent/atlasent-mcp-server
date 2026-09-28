import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decide, NUDGE, evaluate } from '../hook.mjs';
import { canonicalJson } from '../jcs.mjs';
import { redactedPreview, assertNoSecrets, MASK } from '../redact.mjs';
import { actionDigest, repoIdentity, loadCredentials } from '../connected.mjs';
import { mergePolicies, validatePolicy } from '../policy.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const KEY = 'ask_test_hookkey123';
const AGENT = 'agent:aaaaaaaa-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// A fake runtime that enforces what the real one does at each step: an agent
// identity bound to (action_type, environment); a hold that becomes an approval
// request; a one-time claim; and a verify that checks payload, target, environment
// and actor against what evaluate bound, and consumes the permit.
// ---------------------------------------------------------------------------
function fakeRuntime(opts = {}) {
  const calls = [];
  const approvals = new Map();
  const permits = new Map();
  let seq = 0;
  const agent = () => opts.agent ?? AGENT;
  const handle = async (method, path, body) => {
    calls.push({ method, path, body });
    if (opts.fail?.(method, path)) return opts.fail(method, path);
    if (path.endsWith('/v1-agent-actor-identity')) {
      if (opts.mintStatus) return { status: opts.mintStatus, json: { error: 'api_key_not_agent_bound' } };
      return { status: 200, json: { assertion: { version: 'actor_identity.v1', subject: { principal_kind: 'agent', principal_id: agent() }, binding: { action_type: body.action_type, environment: body.environment }, signature: 'sig' } } };
    }
    if (path.endsWith('/v1-evaluate')) {
      if (opts.evaluate) return opts.evaluate(body);
      const id = `apr_${++seq}`;
      approvals.set(id, { status: 'pending', action_type: body.action_type, environment: body.context.environment, binding: { payload: body.execution_payload_hash, target: body.resource_id, env: body.context.environment, actor: body.actor_identity.subject.principal_id } });
      return { status: 200, json: { decision: 'hold', approval_request_id: id } };
    }
    const m = /\/v1\/approvals\/([^/]+)(\/claim-permit)?$/.exec(path);
    if (m) {
      const a = approvals.get(decodeURIComponent(m[1]));
      if (opts.approvalStatus) return { status: opts.approvalStatus, json: {} };
      if (!a) return { status: 404, json: { error: 'not_found' } };
      if (!m[2]) return { status: 200, json: { status: a.status, action_type: a.action_type, environment: a.environment, ...(a.note && { decision_note: a.note }) } };
      if (a.status !== 'approved_awaiting_claim' || a.claimed) return { status: 409, json: { error: 'not_claimable' } };
      if (body.actor_identity?.subject?.principal_id !== a.binding.actor) return { status: 403, json: { deny_code: 'ACTOR_MISMATCH' } };
      a.claimed = true;
      const token = `pt.v4.${++seq}`;
      permits.set(token, { ...a.binding, used: false });
      return { status: 200, json: { claimed: true, permit_token: token } };
    }
    if (path.endsWith('/v1-verify-permit')) {
      if (opts.verify) return opts.verify(body);
      const p = permits.get(body.permit_token);
      const no = code => ({ status: 200, json: { valid: false, outcome: 'deny', verify_error_code: code } });
      if (!p) return no('PERMIT_NOT_FOUND');
      if (p.used) return no('PERMIT_ALREADY_CONSUMED');
      if (body.payload_hash !== p.payload) return no('PAYLOAD_MISMATCH');
      if (body.target_id !== p.target) return no('TARGET_MISMATCH');
      if (body.environment !== p.env) return no('ENVIRONMENT_MISMATCH');
      if (body.actor_id !== p.actor) return no('ACTOR_MISMATCH');
      p.used = true;
      return { status: 200, json: { valid: true, outcome: 'allow' } };
    }
    return { status: 404, json: { error: 'no_route' } };
  };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (opts.throwOn?.(path)) throw Error('ECONNREFUSED');
    const r = await handle(init.method, path, init.body ? JSON.parse(init.body) : undefined);
    if (r.raw !== undefined) return new Response(r.raw, { status: r.status });
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  const approve = (id, status = 'approved_awaiting_claim', note) => { const a = approvals.get(id); a.status = status; if (note) a.note = note; };
  return { calls, approvals, permits, fetchImpl, approve, handle };
}

function setup({ environment = 'production', preview, project, key = KEY } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ah-conn-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ah-repo-'));
  mkdirSync(join(cwd, '.git'));
  writeFileSync(join(cwd, '.git', 'config'), '[remote "origin"]\n\turl = https://user:secret@github.com/acme/app.git\n');
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ version: 1, connected: { ...(environment && { environment }), ...(preview && { preview }) } }));
  if (project) { mkdirSync(join(cwd, '.atlasent')); writeFileSync(join(cwd, '.atlasent', 'hooks.json'), JSON.stringify(project)); }
  const env = { ATLASENT_HOOKS_HOME: home, ...(key && { ATLASENT_HOOKS_API_KEY: key }), ATLASENT_HOOKS_BASE_URL: 'https://rt.example/functions/v1' };
  return { home, cwd, env };
}
const unattended = (cwd, command = 'fly deploy', extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 's1', cwd, permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command }, ...extra });
const run = (s, rt, input) => decide({ host: 'claude-code', input, env: s.env, fetchImpl: rt.fetchImpl });
const idOf = reason => /\((apr_\d+)\)/.exec(reason)?.[1];

// ---------------------------------------------------------------------------
// Happy path, wire bodies
// ---------------------------------------------------------------------------

test('hold → deny with approval id → approved → re-run claims, verifies and allows once', async () => {
  const s = setup(); const rt = fakeRuntime();
  const first = await run(s, rt, unattended(s.cwd));
  assert.equal(first.effect, 'deny');
  assert.match(first.reason, /Held for approval \(apr_1\)/);
  assert.match(first.reason, /atlasent_await_approval/);

  assert.equal((await run(s, rt, unattended(s.cwd))).effect, 'deny', 'still pending');
  rt.approve('apr_1');
  const second = await run(s, rt, unattended(s.cwd));
  assert.equal(second.effect, 'allow');
  assert.equal(second.reason, null);

  // A third identical run is a NEW request, never a second use of the permit.
  const third = await run(s, rt, unattended(s.cwd));
  assert.equal(third.effect, 'deny');
  assert.match(third.reason, /Held for approval \(apr_\d+\)/);
});

test('evaluate wire body binds the whole action, target in all three places, environment and identity', async () => {
  const s = setup(); const rt = fakeRuntime();
  const input = unattended(s.cwd);
  await run(s, rt, input);
  const ev = rt.calls.find(c => c.path.endsWith('/v1-evaluate')).body;
  assert.equal(ev.action_type, 'agent.tool.invoke');
  assert.equal(ev.execution_payload_hash, createHash('sha256').update(canonicalJson({ tool_name: 'Bash', tool_input: { command: 'fly deploy' } })).digest('hex'));
  assert.match(ev.execution_payload_hash, /^[0-9a-f]{64}$/);
  assert.equal(ev.context.execution_payload_hash, undefined, 'never nested under context');
  const target = 'deploy.release@https://github.com/acme/app.git';
  assert.equal(ev.resource_id, target);
  assert.equal(ev.context.target_id, target);
  assert.deepEqual(ev.context.target, { id: target });
  assert.equal(ev.context.environment, 'production');
  assert.equal(ev.context.tool, 'Bash');
  assert.equal(ev.context.session_mode, 'unattended');
  assert.equal(ev.actor_identity.subject.principal_id, AGENT);
  assert.doesNotMatch(JSON.stringify(ev), /secret@/, 'credentials in the remote URL never leave the laptop');
});

test('verify presents payload hash, target, environment and the agent actor', async () => {
  const s = setup(); const rt = fakeRuntime();
  await run(s, rt, unattended(s.cwd)); rt.approve('apr_1');
  await run(s, rt, unattended(s.cwd));
  const v = rt.calls.find(c => c.path.endsWith('/v1-verify-permit')).body;
  assert.equal(v.payload_hash, actionDigest(unattended(s.cwd)));
  assert.equal(v.target_id, 'deploy.release@https://github.com/acme/app.git');
  assert.equal(v.environment, 'production');
  assert.equal(v.actor_id, AGENT);
  assert.equal(v.action_type, 'agent.tool.invoke');
  const claim = rt.calls.find(c => c.path.endsWith('/claim-permit')).body;
  assert.equal(claim.actor_identity.subject.principal_id, AGENT);
});

test('a policy that allows without a person still has to verify (Principle 1)', async () => {
  const s = setup();
  const rt = fakeRuntime({ evaluate: body => { rt.permits.set('pt.v4.direct', { payload: body.execution_payload_hash, target: body.resource_id, env: body.context.environment, actor: AGENT, used: false }); return { status: 200, json: { decision: 'allow', permit_token: 'pt.v4.direct' } }; } });
  assert.equal((await run(s, rt, unattended(s.cwd))).effect, 'allow');
  assert.ok(rt.calls.some(c => c.path.endsWith('/v1-verify-permit')));
});

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

test('changed payload: a changed Bash command, MCP argument or Write content is a new request', async () => {
  const s = setup(); const rt = fakeRuntime();
  await run(s, rt, unattended(s.cwd, 'fly deploy')); rt.approve('apr_1');
  const changed = await run(s, rt, unattended(s.cwd, 'fly deploy --app other'));
  assert.equal(changed.effect, 'deny');
  assert.equal(idOf(changed.reason), 'apr_2', 'changed command gets its own approval, not apr_1');

  const mcp = args => unattended(s.cwd, '', { tool_name: 'mcp__railway__deploy_service', tool_input: args });
  assert.notEqual(actionDigest(mcp({ service: 'api' })), actionDigest(mcp({ service: 'db' })));
  const write = content => ({ tool_name: 'Write', tool_input: { file_path: '/x/.env', content } });
  assert.notEqual(actionDigest(write('A=1')), actionDigest(write('A=2')));
});

test('changed payload at the boundary: a permit bound to another digest does not verify', async () => {
  const s = setup(); const rt = fakeRuntime();
  await run(s, rt, unattended(s.cwd)); rt.approve('apr_1');
  // Tamper with the pending pointer so a different action tries to use apr_1.
  const pendingFile = join(s.home, 'pending.json');
  const p = JSON.parse(readFileSync(pendingFile, 'utf8'));
  const other = unattended(s.cwd, 'fly deploy --app other');
  p[actionDigest(other)] = Object.values(p)[0];
  writeFileSync(pendingFile, JSON.stringify(p));
  const r = await run(s, rt, other);
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /PAYLOAD_MISMATCH/);
});

test('digest is stable under key order', () => {
  const a = { tool_name: 'mcp__x__deploy', tool_input: { b: 1, a: { d: [1, 2], c: 'x' } } };
  const b = { tool_input: { a: { c: 'x', d: [1, 2] }, b: 1 }, tool_name: 'mcp__x__deploy' };
  assert.equal(actionDigest(a), actionDigest(b));
});

test('wrong agent: a key that is not agent-bound cannot mint, so nothing is evaluated', async () => {
  const s = setup(); const rt = fakeRuntime({ mintStatus: 403 });
  const r = await run(s, rt, unattended(s.cwd));
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /bound to a registered agent/);
  assert.ok(!rt.calls.some(c => c.path.endsWith('/v1-evaluate')));
});

test('wrong agent: an identity for a different agent cannot claim the approval', async () => {
  const s = setup(); const rt = fakeRuntime();
  await run(s, rt, unattended(s.cwd)); rt.approve('apr_1');
  const other = fakeRuntime({ agent: 'agent:someone-else' });
  const r = await decide({ host: 'claude-code', input: unattended(s.cwd), env: s.env, fetchImpl: async (url, init) => {
    const path = new URL(url).pathname;
    return path.endsWith('/v1-agent-actor-identity') ? other.fetchImpl(url, init) : rt.fetchImpl(url, init);
  } });
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /ACTOR_MISMATCH/);
});

test('wrong target: the same action from a different repository does not verify', async () => {
  const s = setup(); const rt = fakeRuntime();
  await run(s, rt, unattended(s.cwd)); rt.approve('apr_1');
  writeFileSync(join(s.cwd, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/other.git\n');
  const r = await run(s, rt, unattended(s.cwd));
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /TARGET_MISMATCH/);
});

test('wrong environment: an approval minted for one environment does not verify in another', async () => {
  const s = setup(); const rt = fakeRuntime();
  await run(s, rt, unattended(s.cwd)); rt.approve('apr_1');
  writeFileSync(join(s.home, 'hooks.json'), JSON.stringify({ version: 1, connected: { environment: 'staging' } }));
  const r = await run(s, rt, unattended(s.cwd));
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /ENVIRONMENT_MISMATCH/);
});

test('insufficient approval: still pending, rejected with a note, or a runtime deny all block', async () => {
  const s = setup(); const rt = fakeRuntime();
  await run(s, rt, unattended(s.cwd));
  assert.match((await run(s, rt, unattended(s.cwd))).reason, /Still waiting for a person/);
  rt.approve('apr_1', 'rejected', 'run with --dry-run first');
  const r = await run(s, rt, unattended(s.cwd));
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /Their note: "run with --dry-run first"/);

  const s2 = setup(); const rt2 = fakeRuntime({ evaluate: () => ({ status: 200, json: { decision: 'deny', deny_code: 'INSUFFICIENT_APPROVALS', deny_reason: 'needs a person' } }) });
  const d = await run(s2, rt2, unattended(s2.cwd));
  assert.equal(d.effect, 'deny');
  assert.match(d.reason, /INSUFFICIENT_APPROVALS/);
});

test('expired or consumed permit: a verify refusal blocks', async () => {
  for (const code of ['PERMIT_EXPIRED', 'PERMIT_ALREADY_CONSUMED']) {
    const s = setup(); const rt = fakeRuntime({ verify: () => ({ status: 200, json: { valid: false, outcome: 'deny', verify_error_code: code } }) });
    await run(s, rt, unattended(s.cwd)); rt.approve('apr_1');
    const r = await run(s, rt, unattended(s.cwd));
    assert.equal(r.effect, 'deny');
    assert.match(r.reason, new RegExp(code));
  }
});

test('a claim that fails (already claimed) blocks', async () => {
  const s = setup(); const rt = fakeRuntime();
  await run(s, rt, unattended(s.cwd)); rt.approve('apr_1');
  rt.approvals.get('apr_1').claimed = true;
  const r = await run(s, rt, unattended(s.cwd));
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /no permit could be claimed/);
});

test('network failure blocks and remembers nothing', async () => {
  const s = setup(); const rt = fakeRuntime({ throwOn: p => p.endsWith('/v1-evaluate') });
  const r = await run(s, rt, unattended(s.cwd));
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /could not be reached/);
  assert.ok(!existsSync(join(s.home, 'pending.json')));
});

test('malformed responses block: non-JSON, unknown decision, hold without id, 5xx, bad identity', async () => {
  const cases = [
    { fail: (m, p) => p.endsWith('/v1-evaluate') && { status: 200, raw: 'not json' } },
    { evaluate: () => ({ status: 200, json: { decision: 'maybe' } }) },
    { evaluate: () => ({ status: 200, json: { decision: 'hold' } }) },
    { evaluate: () => ({ status: 200, json: { decision: 'allow' } }) },
    { evaluate: () => ({ status: 503, json: { error: 'down' } }) },
    { fail: (m, p) => p.endsWith('/v1-agent-actor-identity') && { status: 200, json: { assertion: { version: 'actor_identity.v1', subject: { principal_kind: 'human', principal_id: 'u' } } } } },
  ];
  for (const opts of cases) {
    const s = setup(); const rt = fakeRuntime(opts);
    const r = await run(s, rt, unattended(s.cwd));
    assert.equal(r.effect, 'deny', JSON.stringify(Object.keys(opts)));
  }
});

test('a verify answer that is not exactly valid:true + outcome:allow blocks', async () => {
  for (const json of [{ valid: 'yes', outcome: 'allow' }, { valid: true, outcome: 'deny' }, { outcome: 'allow' }, { valid: true }]) {
    const s = setup(); const rt = fakeRuntime({ verify: () => ({ status: 200, json }) });
    await run(s, rt, unattended(s.cwd)); rt.approve('apr_1');
    const r = await run(s, rt, unattended(s.cwd));
    assert.ok(rt.calls.some(c => c.path.endsWith('/v1-verify-permit')), 'verify was reached');
    assert.equal(r.effect, 'deny', JSON.stringify(json));
  }
});

test('the residual scan rejects any unmasked secret shape', () => {
  for (const raw of ['Bearer abcdefghijklmnop', 'sk-abcdefghijklmnopqrstuv', 'PGPASSWORD=hunter2', 'AKIAABCDEFGHIJKLMNOP']) {
    assert.throws(() => assertNoSecrets(JSON.stringify(raw)), /secret-shaped/, raw);
  }
  assert.doesNotThrow(() => assertNoSecrets(JSON.stringify(`Bearer ${MASK} PGPASSWORD=${MASK}`)));
});

test('a secret used as an object key (never redacted) is caught by the final scan: blocked, nothing sent', async () => {
  const s = setup(); const rt = fakeRuntime();
  const r = await run(s, rt, unattended(s.cwd, '', { tool_name: 'mcp__vault__delete_secret', tool_input: { 'sk-abcdefghijklmnopqrstuv': true } }));
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /could not be prepared safely/);
  assert.equal(rt.calls.length, 0);
});

test('approval check refused (no approvals:read) says so and blocks', async () => {
  const s = setup(); const rt = fakeRuntime();
  await run(s, rt, unattended(s.cwd));
  const rt403 = fakeRuntime({ approvalStatus: 403 });
  const r = await decide({ host: 'claude-code', input: unattended(s.cwd), env: s.env, fetchImpl: rt403.fetchImpl });
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /approvals:read/);
});

test('missing connected.environment blocks locally and sends nothing', async () => {
  const s = setup({ environment: null }); const rt = fakeRuntime();
  const r = await run(s, rt, unattended(s.cwd));
  assert.equal(r.effect, 'deny');
  assert.equal(rt.calls.length, 0);
});

test('secret-redaction failure blocks and sends nothing', async () => {
  const s = setup(); const rt = fakeRuntime();
  let deep = { command: 'x' }; for (let i = 0; i < 80; i++) deep = { n: deep };
  const r = await run(s, rt, unattended(s.cwd, '', { tool_name: 'mcp__db__drop_table', tool_input: deep }));
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /could not be prepared safely/);
  assert.equal(rt.calls.length, 0);
});

test('redaction removes each secret shape from the preview, and the preview can be turned off', async () => {
  const secrets = [
    'curl -H "Authorization: Bearer abcdefghijklmnop123" https://x',
    'deploy --token=ghp_abcdefghijklmnopqrstuvwxyz0123',
    'export OPENAI=sk-abcdefghijklmnopqrstuv',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 rb s3://b',
    'aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP',
    'PGPASSWORD=hunter2 psql -c "DROP TABLE x"',
    'psql postgres://admin:hunter2@db.prod/app -c "DROP TABLE x"',
    'mysql -phunter2 -e "DROP DATABASE x"',
    'curl -H "x-api-key: ask_live_abcdef123456"',
    'slack xoxb-1234567890-abcdefghij',
    'token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4fw',
  ];
  for (const cmd of secrets) {
    const out = redactedPreview({ tool_name: 'Bash', tool_input: { command: cmd } });
    assert.ok(out.includes(MASK), cmd);
    for (const bad of ['abcdefghijklmnop123', 'ghp_abc', 'sk-abc', 'wJalrXUtnFEMI', 'AKIAABCDEF', 'hunter2', 'ask_live_abc', 'xoxb-123', 'eyJhbGciOiJIUzI1']) {
      assert.ok(!out.includes(bad), `${bad} leaked from: ${cmd}`);
    }
  }
  const structured = redactedPreview({ tool_name: 'mcp__x__deploy', tool_input: { api_key: 'plain-looking-value', nested: { password: 'p', ok: 'fine' } } });
  assert.doesNotMatch(structured, /plain-looking-value|"p"/);
  assert.match(structured, /fine/);

  const s = setup({ preview: 'off' }); const rt = fakeRuntime();
  await run(s, rt, unattended(s.cwd, 'PGPASSWORD=hunter2 psql -c "DROP TABLE x"'));
  const ev = rt.calls.find(c => c.path.endsWith('/v1-evaluate')).body;
  assert.equal(ev.context.action_preview, undefined);
  assert.doesNotMatch(JSON.stringify(ev), /hunter2|DROP TABLE/);
});

test('with the preview on, the raw secret never reaches the runtime', async () => {
  const s = setup(); const rt = fakeRuntime();
  await run(s, rt, unattended(s.cwd, 'PGPASSWORD=hunter2 psql -c "DROP TABLE users"'));
  const ev = rt.calls.find(c => c.path.endsWith('/v1-evaluate')).body;
  assert.match(ev.context.action_preview, /DROP TABLE users/);
  assert.doesNotMatch(JSON.stringify(rt.calls), /hunter2/);
});

// ---------------------------------------------------------------------------
// Configuration boundaries
// ---------------------------------------------------------------------------

test('a repository cannot choose the environment, but can turn the preview off', () => {
  const user = validatePolicy({ version: 1, connected: { environment: 'production' } });
  const project = validatePolicy({ version: 1, connected: { environment: 'sandbox', preview: 'off' } });
  assert.deepEqual(mergePolicies(user, project).connected, { environment: 'production', preview: 'off' });
  assert.equal(mergePolicies(validatePolicy({ version: 1 }), project).connected.environment, undefined);
});

test('credentials in the remote URL are stripped from the repository identity', () => {
  const { cwd } = setup();
  assert.equal(repoIdentity(cwd), 'https://github.com/acme/app.git');
});

test('the guard asks before the agent edits its own credentials or pending approvals', () => {
  const s = setup();
  for (const f of ['credentials.json', 'pending.json']) {
    const d = evaluate({ host: 'claude-code', input: { tool_name: 'Write', cwd: s.cwd, permission_mode: 'default', tool_input: { file_path: join(s.home, '..', '.atlasent', f), content: '{}' } }, env: s.env });
    assert.equal(d.effect, 'ask', f);
  }
});

// ---------------------------------------------------------------------------
// No key: today's behaviour, plus one nudge per session
// ---------------------------------------------------------------------------

test('no key, nudge not shown: the decision is exactly what the local guard returns', async () => {
  const s = setup({ key: null }); const rt = fakeRuntime();
  const input = unattended(s.cwd);
  const env = { ...s.env, ATLASENT_HOOKS_NUDGE: 'off' };
  const local = evaluate({ host: 'claude-code', input, env });
  const full = await decide({ host: 'claude-code', input, env, fetchImpl: rt.fetchImpl });
  assert.deepEqual({ effect: full.effect, reason: full.reason, rule: full.rule }, { effect: local.effect, reason: local.reason, rule: local.rule });
  assert.equal(rt.calls.length, 0);
});

test('no key: the nudge is today\'s reason plus exactly one line, once per session, never when attended', async () => {
  const s = setup({ key: null }); const rt = fakeRuntime();
  const input = unattended(s.cwd);
  const local = evaluate({ host: 'claude-code', input, env: s.env });
  const first = await decide({ host: 'claude-code', input, env: s.env, fetchImpl: rt.fetchImpl });
  assert.equal(first.effect, local.effect);
  assert.equal(first.reason, `${local.reason} ${NUDGE}`);
  const second = await decide({ host: 'claude-code', input, env: s.env, fetchImpl: rt.fetchImpl });
  assert.equal(second.reason, local.reason);
  const attended = await decide({ host: 'claude-code', input: { ...input, session_id: 's9', permission_mode: 'default' }, env: s.env, fetchImpl: rt.fetchImpl });
  assert.equal(attended.effect, 'ask');
  assert.ok(!attended.reason.includes(NUDGE));
  assert.equal(rt.calls.length, 0);
});

test('an attended ask never goes to the runtime even when connected', async () => {
  const s = setup(); const rt = fakeRuntime();
  const r = await run(s, rt, { ...unattended(s.cwd), permission_mode: 'default' });
  assert.equal(r.effect, 'ask');
  assert.equal(rt.calls.length, 0);
});

// ---------------------------------------------------------------------------
// End to end through the real CLI, against an HTTP fake runtime
// ---------------------------------------------------------------------------

test('CLI end to end: hold, approve, re-run allows; pending file is private', async () => {
  const rt = fakeRuntime();
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', async () => {
      const r = await rt.handle(req.method, new URL(req.url, 'http://x').pathname, data ? JSON.parse(data) : undefined);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/functions/v1`;
  const s = setup();
  const env = { PATH: process.env.PATH, ...s.env, ATLASENT_HOOKS_BASE_URL: base };
  const cli = input => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, 'claude-code'], { env });
    let out = ''; let err = '';
    p.stdout.on('data', c => { out += c; }); p.stderr.on('data', c => { err += c; });
    p.on('close', code => code === 0 ? resolve(out.trim() ? JSON.parse(out) : null) : reject(Error(err)));
    p.stdin.end(JSON.stringify(input));
  });
  try {
    const first = await cli(unattended(s.cwd));
    assert.equal(first.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /Held for approval \(apr_1\)/);
    assert.equal(statSync(join(s.home, 'pending.json')).mode & 0o777, 0o600);
    rt.approve('apr_1');
    assert.equal(await cli(unattended(s.cwd)), null, 'allowed: falls through to Claude Code\'s own permissions');
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Plugin settings (userConfig): Claude Code exports them as CLAUDE_PLUGIN_OPTION_*
// ---------------------------------------------------------------------------

const withAuth = rt => {
  const auth = [];
  return { auth, fetchImpl: async (url, init) => { auth.push(init.headers?.authorization ?? init.headers?.Authorization); return rt.fetchImpl(url, init); } };
};

test('plugin api_key setting connects with no other credential, and is the key sent', async () => {
  const s = setup({ key: null }); const rt = fakeRuntime(); const w = withAuth(rt);
  s.env.CLAUDE_PLUGIN_OPTION_API_KEY = 'ask_test_fromplugin1';
  const r = await decide({ host: 'claude-code', input: unattended(s.cwd), env: s.env, fetchImpl: w.fetchImpl });
  assert.equal(r.effect, 'deny');
  assert.ok(idOf(r.reason), r.reason);
  assert.ok(rt.calls.length > 0);
  assert.ok(w.auth.every(a => a === 'Bearer ask_test_fromplugin1'), JSON.stringify(w.auth));
});

test('a blank plugin api_key setting counts as unset: local guard, nothing sent', async () => {
  const s = setup({ key: null }); const rt = fakeRuntime();
  s.env.CLAUDE_PLUGIN_OPTION_API_KEY = '   ';
  const r = await run(s, rt, unattended(s.cwd));
  assert.equal(r.effect, 'deny');
  assert.equal(rt.calls.length, 0);
});

test('plugin environment setting supplies connected.environment when the user file has none', async () => {
  const s = setup({ environment: null }); const rt = fakeRuntime();
  s.env.CLAUDE_PLUGIN_OPTION_ENVIRONMENT = 'staging';
  const r = await run(s, rt, unattended(s.cwd));
  assert.ok(idOf(r.reason), r.reason);
  const ev = rt.calls.find(c => c.path.endsWith('/v1-evaluate'));
  assert.equal(ev.body.context.environment, 'staging');
});

test("the user's own hooks.json environment wins over the plugin setting", async () => {
  const s = setup({ environment: 'production' }); const rt = fakeRuntime();
  s.env.CLAUDE_PLUGIN_OPTION_ENVIRONMENT = 'staging';
  await run(s, rt, unattended(s.cwd));
  const ev = rt.calls.find(c => c.path.endsWith('/v1-evaluate'));
  assert.equal(ev.body.context.environment, 'production');
});

test('an invalid plugin environment setting blocks and sends nothing', async () => {
  const s = setup({ environment: null }); const rt = fakeRuntime();
  s.env.CLAUDE_PLUGIN_OPTION_ENVIRONMENT = 'Prod Env!';
  const r = await run(s, rt, unattended(s.cwd));
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /environment setting/);
  assert.equal(rt.calls.length, 0);
});

test('a repository still cannot choose the environment when the plugin setting is used', async () => {
  const s = setup({ environment: null, project: { version: 1, connected: { environment: 'sandbox' } } }); const rt = fakeRuntime();
  s.env.CLAUDE_PLUGIN_OPTION_ENVIRONMENT = 'production';
  await run(s, rt, unattended(s.cwd));
  const ev = rt.calls.find(c => c.path.endsWith('/v1-evaluate'));
  assert.equal(ev.body.context.environment, 'production');
});

test("a key from the plugin or env never goes to credentials.json's base_url; the file's own key still does", () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-cred-'));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ api_key: 'ask_live_filekey1', base_url: 'https://legacy.example/functions/v1' }));
  assert.deepEqual(loadCredentials(home, {}), { apiKey: 'ask_live_filekey1', baseUrl: 'https://legacy.example/functions/v1' });
  assert.deepEqual(loadCredentials(home, { CLAUDE_PLUGIN_OPTION_API_KEY: 'ask_live_plugin1' }), { apiKey: 'ask_live_plugin1', baseUrl: 'https://api.atlasent.io/functions/v1' });
  assert.equal(loadCredentials(home, { ATLASENT_HOOKS_API_KEY: 'ask_live_env1' }).baseUrl, 'https://api.atlasent.io/functions/v1');
  assert.equal(loadCredentials(home, { CLAUDE_PLUGIN_OPTION_API_KEY: 'ask_live_plugin1', ATLASENT_HOOKS_BASE_URL: 'https://rt.example/functions/v1' }).baseUrl, 'https://rt.example/functions/v1');
});
