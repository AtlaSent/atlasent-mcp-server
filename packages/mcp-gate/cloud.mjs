import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.length > 0 && x.length <= 256 && !/[\r\n]/.test(x);
const name = x => typeof x === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(x);
const agentActorId = x => typeof x === 'string' && /^agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
export function validateConnection(c) {
  if (!object(c) || c.version !== 1 || !text(c.actorId) || !name(c.gateId) || !['sandbox','production'].includes(c.environment) || !object(c.tools) || !Object.keys(c.tools).length || Object.keys(c).some(k => !['version','apiUrl','actorId','gateId','environment','tools','approvalWaitMs','approvalsUrl'].includes(k))) throw Error('Invalid connection');
  const u = new URL(c.apiUrl);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw Error('HTTPS endpoint required');
  // connection.example.json ships `YOUR-APPROVED-RUNTIME` / `YOUR-REGISTERED-ACTOR-ID`
  // / `YOUR-PROVISIONED-ACTION-TYPE`. Unedited, those passed every check here and
  // `check-connection` printed "valid", which reads as "ready to connect" for a file
  // that names no real runtime, actor or action class.
  // Matched as EXACT literals, not a `your-` prefix: a prefix would reject legitimate
  // values like actor `your-team-bot`, turning a footgun guard into a false refusal.
  // Compared case-insensitively because URL lowercases the hostname.
  //
  // The action type joined this list on 2026-09-26. The example previously shipped the
  // concrete slug `tool.set_status`, which reads like a real AtlaSent action type and is
  // not one: a live read of runtime prod found it on ZERO orgs, with no Canon template
  // either. So two of the three values a user must replace announced themselves and the
  // third did not, which invited keeping the one value that cannot work. The failure then
  // landed past validation as an ordinary `cloud_deny` — indistinguishable from a policy
  // refusal, which is the shape this package's own README warns `check-connection` cannot
  // detect. This does not assert which action types mcp-gate SHOULD support; that is open
  // on issue #175 and deliberately not decided here.
  if (u.hostname.toLowerCase() === 'your-approved-runtime' || c.actorId.toUpperCase() === 'YOUR-REGISTERED-ACTOR-ID') throw Error('Replace the example placeholders before connecting');
  if (!agentActorId(c.actorId)) throw Error('Registered actor must be an agent:<uuid> identity');
  if (c.approvalWaitMs !== undefined && (!Number.isInteger(c.approvalWaitMs) || c.approvalWaitMs < 0 || c.approvalWaitMs > 120000)) throw Error('Invalid approval wait');
  if (c.approvalsUrl !== undefined || c.approvalWaitMs > 0) {
    const a = new URL(c.approvalsUrl);
    if (a.origin !== u.origin || a.username || a.password || a.search || a.hash || a.pathname !== '/v1/approvals') throw Error('Approval endpoint must be canonical and same-origin');
  }
  for (const [tool, m] of Object.entries(c.tools)) {
    if (!name(tool) || !object(m) || !name(m.actionType) || !text(m.targetId) || Object.keys(m).some(k=>!['actionType','targetId'].includes(k))) throw Error('Invalid tool mapping');
    if (m.actionType.toUpperCase() === 'YOUR-PROVISIONED-ACTION-TYPE') throw Error('Replace the example placeholders before connecting');
  }
  return c;
}
// Wire contract checked against atlasent-api a76beb0b (2026-09-16).
// Hash the entire execution subject, including exact arguments, tool, target,
// actor, environment, gate, and a fresh invocation nonce. No raw args uploaded.
export function executionHash(subject) {
  return createHash('sha256').update(JSON.stringify(subject)).digest('hex');
}
export function cloudAuthorizer(connection, apiKey, { fetchImpl = fetch, timeoutMs = 10000, sleepImpl = delay } = {}) {
  const c = structuredClone(validateConnection(connection));
  const prefix = c.environment === 'production' ? 'ask_live_' : 'ask_test_';
  if (typeof apiKey !== 'string' || !apiKey.startsWith(prefix) || apiKey.length <= prefix.length || /\s/.test(apiKey)) throw Error('Missing or incompatible execution key');
  async function request(url, body, signal, budget = timeoutMs) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(timeoutMs, budget)))), ...(signal ? [signal] : [])]),
      headers: { 'Content-Type': 'application/json', 'X-AtlaSent-Key': apiKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw Error('Cloud request failed');
    // Bound parsing even if Content-Length is absent or dishonest.
    const reader = response.body.getReader();
    let bytes = 0; const chunks = [];
    try {
      while (true) {
        const {done,value} = await reader.read(); if (done) break;
        bytes += value.length;
        if (bytes > 1024 * 1024) throw Error('Response too large');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(()=>{}); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(result)) throw Error('Invalid response');
    return result;
  }
  return async (params, { signal, onPending = () => {} } = {}) => {
    const post = (path, body) => request(c.apiUrl.replace(/\/$/, '') + path, body, signal);
    const mapping = Object.hasOwn(c.tools, params.name) ? c.tools[params.name] : undefined;
    if (!mapping) return { effect: 'deny', reason: 'cloud_unmapped_tool' };
    const mintActorIdentity = async (actionType, environment) => {
      const minted = await post('/v1-agent-actor-identity', { action_type: actionType, environment });
      const assertion = minted.assertion;
      if (!object(assertion) || assertion.version !== 'actor_identity.v1' || !object(assertion.subject) || assertion.subject.principal_kind !== 'agent' || assertion.subject.principal_id !== c.actorId || !object(assertion.binding) || assertion.binding.action_type !== actionType || assertion.binding.environment !== environment || typeof assertion.signature !== 'string' || !assertion.signature) return null;
      return assertion;
    };
    const invocation = randomUUID();
    const subject = { version: 1, invocation, gateId: c.gateId, actorId: c.actorId, environment: c.environment, actionType: mapping.actionType, targetId: mapping.targetId, tool: params.name, arguments: structuredClone(params.arguments ?? {}) };
    const hash = executionHash(subject);
    try {
      let actorIdentity;
      try { actorIdentity = await mintActorIdentity(mapping.actionType, c.environment); }
      catch { return { effect: 'deny', reason: 'cloud_actor_identity_unavailable' }; }
      if (!actorIdentity) return { effect: 'deny', reason: 'cloud_actor_identity_invalid' };
      const evaluation = await post('/v1-evaluate', {
        action_type: mapping.actionType, actor_id: c.actorId, actor_identity: actorIdentity, resource_id: mapping.targetId,
        request_id: invocation, execution_payload_hash: hash,
        context: { environment: c.environment, target: { id: mapping.targetId } },
      });
      let token = evaluation.permit_token;
      if (['hold','escalate'].includes(evaluation.decision) && c.approvalWaitMs > 0) {
        const id = evaluation.approval_request_id;
        if (evaluation.mode !== 'live' || typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return { effect: 'deny', reason: 'cloud_invalid_approval' };
        onPending(id);
        const deadline = performance.now() + c.approvalWaitMs;
        const url = c.approvalsUrl + '/' + id;
        while (true) {
          signal?.throwIfAborted();
          if (performance.now() >= deadline) return { effect: 'deny', reason: 'cloud_approval_timeout' };
          const row = await request(url, undefined, signal, deadline - performance.now());
          if (row.id !== id) return { effect: 'deny', reason: 'cloud_approval_mismatch' };
          if (row.status === 'pending') {
            await sleepImpl(Math.min(2000, Math.max(1, deadline - performance.now())), undefined, { signal });
            continue;
          }
          if (row.status !== 'approved_awaiting_claim') return { effect: 'deny', reason: 'cloud_approval_not_allowed' };
          if (typeof row.claim_environment !== 'string' || row.claim_environment !== c.environment) return { effect: 'deny', reason: 'cloud_approval_binding_mismatch' };
          if (performance.now() >= deadline) return { effect: 'deny', reason: 'cloud_approval_timeout' };
          let claimActorIdentity;
          try { claimActorIdentity = await mintActorIdentity(mapping.actionType, row.claim_environment); }
          catch { return { effect: 'deny', reason: 'cloud_actor_identity_unavailable' }; }
          if (!claimActorIdentity) return { effect: 'deny', reason: 'cloud_actor_identity_invalid' };
          const claim = await request(url + '/claim-permit', { actor_identity: claimActorIdentity }, signal, deadline - performance.now());
          if (claim.claimed !== true || claim.re_evaluation_decision !== 'allow' || typeof claim.permit_token !== 'string' || !claim.permit_token) return { effect: 'deny', reason: 'cloud_approval_unclaimable' };
          token = claim.permit_token;
          break;
        }
      } else {
        if (evaluation.decision !== 'allow') return { effect: 'deny', reason: evaluation.decision === 'hold' ? 'cloud_hold' : evaluation.decision === 'escalate' ? 'cloud_escalate' : 'cloud_deny' };
        if (evaluation.mode !== 'live' || evaluation.execution_payload_hash_accepted !== true || evaluation.execution_hash_expected !== hash || typeof token !== 'string' || !token || (evaluation.human_approval_required === true && evaluation.human_approval_status !== 'satisfied')) return { effect: 'deny', reason: 'cloud_unbound_or_unapproved' };
      }
      signal?.throwIfAborted();
      if (executionHash({...subject, arguments: params.arguments ?? {}}) !== hash) return { effect: 'deny', reason: 'cloud_arguments_changed' };
      const verification = await post('/v1-verify-permit', {
        permit_token: token, action_type: mapping.actionType,
        actor_id: c.actorId, environment: c.environment, target_id: mapping.targetId,
        payload_hash: hash,
      });
      signal?.throwIfAborted();
      // Public verify consumes atomically; never accept legacy truthy/unchecked responses.
      if (verification.valid !== true || verification.outcome !== 'allow' || verification.consumed !== true || !Number.isFinite(Date.parse(verification.expires_at)) || Date.parse(verification.expires_at) <= Date.now()) return { effect: 'deny', reason: 'cloud_verification_failed' };
      // Check the live caller's arguments again after both asynchronous boundaries.
      if (executionHash({...subject, arguments: params.arguments ?? {}}) !== hash) return { effect: 'deny', reason: 'cloud_arguments_changed' };
      return { effect: 'allow', reason: 'cloud_permit_consumed' };
    } catch { return { effect: 'deny', reason: 'cloud_unavailable' }; }
  };
}
