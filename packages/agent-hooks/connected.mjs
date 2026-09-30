// Connected mode: an unattended "ask" goes to the organization's AtlaSent policy
// instead of becoming a flat refusal. See docs/HOOK_HITL_APPROVAL.md.
//
// The hook cannot wait minutes for a person inside one PreToolUse call, so:
//   1st run of an action  → evaluate; a hold is remembered and the call is DENIED with
//                            the approval id, telling the agent to re-run it unchanged.
//   later run, same action → check the approval; if approved, claim the permit and
//                            verify it at this boundary; only a verified permit allows.
//
// Fail-closed throughout: every error, timeout, malformed or unexpected response is a
// deny. Nothing local ever counts as authority; the runtime's verified permit is the
// only path to allow. The hook never turns "unattended" into autonomy on its own: if
// the governing policy allows without a person, that is the policy's decision.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { canonicalJson } from './jcs.mjs';
import { redactedPreview } from './redact.mjs';

export const ACTION_TYPE = 'agent.tool.invoke';
const DEFAULT_BASE = 'https://api.atlasent.io/functions/v1';
// Claude Code kills a hook at hooks.json's timeout (30 s); finish well inside it.
export const TOTAL_BUDGET_MS = 25_000;
// Per call. evaluate and claim-permit each run a full policy evaluation on the
// runtime (claim-time reevaluation, IMPL-026B), which took about 7 s on staging:
// a 6 s cap lost a permit the runtime had already minted and spent. The cheap
// calls (identity mint, seal, approval read, verify) keep the short cap.
const CALL_TIMEOUT_MS = 6_000;
const EVALUATION_CALL_TIMEOUT_MS = 15_000;
// An evaluation call can return a single-use permit that must still be verified
// in this same run, so it never takes the time verify needs.
export const VERIFY_RESERVE_MS = 4_000;
// Below this, a claim would likely be cut off after the runtime spent it.
export const MIN_CLAIM_MS = 8_000;
export function callTimeoutMs(kind, left) {
  if (kind === 'evaluation') return Math.max(0, Math.min(EVALUATION_CALL_TIMEOUT_MS, left - VERIFY_RESERVE_MS));
  return Math.max(0, Math.min(CALL_TIMEOUT_MS, left));
}
const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // matches the runtime's hold expiry
const APPROVED = new Set(['approved', 'approved_awaiting_claim']);

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Where the key comes from depends on how the hook was installed.
//   Plugin (hooks.json passes --plugin): NONE. Connected mode is not offered in the
//     plugin yet (0.2.5): the runtime cannot complete it today (the agent identity
//     endpoint is staging-only, and an active global incident defense denies agent.*
//     actions without signed source provenance). A plugin install is local only: no
//     credential of any kind is read and nothing is ever sent. Re-enabling means
//     restoring plugin.json's userConfig and this branch, with a live end-to-end run.
//   npm CLI: ATLASENT_HOOKS_API_KEY (CI and tests), else <home>/credentials.json
//     ({ "api_key", "base_url"? }), written by `atlasent-hooks connect`.
// A blank value counts as unset: an optional setting left empty is exported as "".
// No key → not connected.
const set = v => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
export function loadCredentials(home, env = process.env, { plugin = false } = {}) {
  if (plugin) return null;
  let file = {};
  const path = join(home, 'credentials.json');
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!object(parsed)) throw Error('credentials.json must be an object');
    file = parsed;
  }
  const fromEnv = set(env.ATLASENT_HOOKS_API_KEY);
  const apiKey = fromEnv ?? file.api_key;
  if (!apiKey) return null;
  if (typeof apiKey !== 'string' || !/^ask_(live|test)_[A-Za-z0-9_-]+$/.test(apiKey)) throw Error('the AtlaSent API key is not in ask_live_… / ask_test_… form');
  // A key and its endpoint travel together: credentials.json's base_url applies only to
  // the key stored beside it, so an env key never goes to a leftover host.
  const baseUrl = String(set(env.ATLASENT_HOOKS_BASE_URL) ?? (fromEnv ? undefined : file.base_url) ?? DEFAULT_BASE).replace(/\/+$/, '');
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(baseUrl)) throw Error('base_url must be https');
  return { apiKey, baseUrl };
}

// ---------------------------------------------------------------------------
// What exactly is being approved
// ---------------------------------------------------------------------------

// The whole proposed action — tool name and complete input — canonicalized, so a
// changed argument anywhere (a Bash command, an MCP argument, a Write's content) is a
// different digest and a different approval.
export function actionObject(input) {
  return { tool_name: input.tool_name, tool_input: object(input.tool_input) ? input.tool_input : {} };
}
export function actionDigest(input) {
  return createHash('sha256').update(canonicalJson(actionObject(input)), 'utf8').digest('hex');
}

// The runtime's source_provenance_action.v1 hash (atlasent-api
// _shared/source-provenance-attestation.ts, computeSourceProvenanceActionHash): what an
// admitted permit is bound to. Recomputed here from the CURRENT action, never read back
// from local state, so a tampered pending file cannot point one action's permit at another.
export function provenanceActionHash({ tenantId, actorId, environment, resourceId, context }) {
  return createHash('sha256').update(canonicalJson({
    version: 'source_provenance_action.v1',
    tenant_id: tenantId,
    actor_id: actorId,
    action_type: ACTION_TYPE,
    environment,
    resource_id: resourceId ?? null,
    context,
  }), 'utf8').digest('hex');
}

// Repository identity for the target binding: the origin remote URL with any
// credentials removed, else a hash of the working directory. Read from the file, never
// by running git.
export function repoIdentity(cwd) {
  if (typeof cwd === 'string' && cwd) {
    let dir = resolve(cwd);
    for (let i = 0; i < 64; i++) {
      const cfg = join(dir, '.git', 'config');
      if (existsSync(cfg)) {
        const text = readFileSync(cfg, 'utf8');
        const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(text);
        if (m) return m[1].replace(/(:\/\/)[^@/]+@/, '$1');
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return 'cwd:' + createHash('sha256').update(String(cwd ?? '')).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Pending approvals: digest → approval id. Only a pointer; never evidence.
// ---------------------------------------------------------------------------

function readJson(path) {
  try { const v = JSON.parse(readFileSync(path, 'utf8')); return object(v) ? v : {}; } catch { return {}; }
}
function writeJsonPrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
// An entry is one attempt at one exact action (keyed by its digest):
//   { request_id, approval_request_id?, binding?, created_at }
// binding says WHICH value the permit is bound to ('provenance': the runtime admitted
// sealed provenance; 'digest': it did not). The value itself is always recomputed from
// the current action at verify time, never stored.
// request_id is written BEFORE the evaluate call, so an honest retry after a lost
// answer re-presents the same id (the runtime's idempotency key and the id any
// source provenance is bound to). It is spent with the attempt: a final answer
// deletes the entry and the next attempt gets a fresh id, because the runtime
// replays the recorded decision for a repeated id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const BINDINGS = new Set(['provenance', 'digest']);
export function pendingStore(home, now) {
  const path = join(home, 'pending.json');
  const load = () => {
    const all = readJson(path);
    const t = now().getTime();
    for (const [k, v] of Object.entries(all)) {
      // Entries written before 0.2.6 carry only { approval_request_id, created_at }; keep
      // them so an upgrade does not orphan an approval a person already granted.
      const legacyHeld = object(v) && v.request_id === undefined && typeof v.approval_request_id === 'string' && v.approval_request_id;
      const ok = object(v) && ((typeof v.request_id === 'string' && UUID_RE.test(v.request_id)) || legacyHeld) &&
        (v.approval_request_id === undefined || typeof v.approval_request_id === 'string') &&
        (v.binding === undefined || BINDINGS.has(v.binding)) &&
        t - Date.parse(v.created_at) < PENDING_TTL_MS;
      if (!ok) delete all[k];
    }
    return all;
  };
  return {
    get: digest => load()[digest] ?? null,
    // The attempt for this action, created (and persisted) if there is none yet.
    attempt: digest => {
      const all = load();
      if (!all[digest]) { all[digest] = { request_id: randomUUID(), created_at: now().toISOString() }; writeJsonPrivate(path, all); }
      return all[digest];
    },
    hold: (digest, approval_request_id, binding) => { const all = load(); if (all[digest]) { all[digest].approval_request_id = approval_request_id; all[digest].binding = binding; writeJsonPrivate(path, all); } },
    del: digest => { const all = load(); if (digest in all) { delete all[digest]; writeJsonPrivate(path, all); } },
  };
}

// ---------------------------------------------------------------------------
// HTTP: every call bounded, every failure an exception the caller turns into deny.
// ---------------------------------------------------------------------------

function client(creds, fetchImpl, deadline) {
  const call = async (method, url, body, kind = 'plain') => {
    const timeout = callTimeoutMs(kind, deadline - Date.now());
    if (timeout <= 0) throw Error('ran out of time');
    const res = await fetchImpl(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${creds.apiKey}`, 'User-Agent': '@atlasent/agent-hooks' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json: object(json) ? json : null };
  };
  const fn = p => `${creds.baseUrl}${p}`;
  return {
    mintIdentity: environment => call('POST', fn('/v1-agent-actor-identity'), { action_type: ACTION_TYPE, environment }),
    // Trusted source provenance for this exact request, minted by AtlaSent from what it
    // already knows (this key's agent, that agent's owner, this request and action). The
    // guard cannot assert any of it; it only forwards what the runtime sealed.
    seal: body => call('POST', fn('/v1-source-provenance-seal'), body),
    evaluate: body => call('POST', fn('/v1-evaluate'), body, 'evaluation'),
    verify: body => call('POST', fn('/v1-verify-permit'), body),
    // Approvals are the v1-approvals function, like every other call here. The
    // "/v1/approvals/…" gateway form at the API root is not served by any deployed
    // host (it answers 404 on production and staging), so it must not be used.
    approval: id => call('GET', fn(`/v1-approvals/${encodeURIComponent(id)}`)),
    claim: (id, body) => call('POST', fn(`/v1-approvals/${encodeURIComponent(id)}/claim-permit`), body, 'evaluation'),
  };
}

// The minted assertion must be an agent identity for exactly this binding; the runtime
// checks the signature. Returns the assertion or throws.
function checkedAssertion(r, environment) {
  if (r.status === 404) throw Error('this AtlaSent runtime has no agent identity endpoint');
  if (r.status !== 200) throw Error(`agent identity was refused (${httpFailure(r)}); the key must be bound to a registered agent`);
  const a = r.json?.assertion;
  if (!object(a) || a.version !== 'actor_identity.v1' || a.subject?.principal_kind !== 'agent' ||
      typeof a.subject?.principal_id !== 'string' || a.binding?.action_type !== ACTION_TYPE ||
      typeof a.binding?.tenant_id !== 'string' || !a.binding.tenant_id ||
      a.binding?.environment !== environment || typeof a.signature !== 'string') {
    throw Error('malformed agent identity response');
  }
  return a;
}

const reasonsOf = j => {
  const r = j?.deny_reason ?? j?.denial?.reasons ?? j?.reasons;
  const list = Array.isArray(r) ? r : typeof r === 'string' ? [r] : [];
  return list.filter(x => typeof x === 'string').map(x => x.slice(0, 300)).join('; ');
};

// What the runtime said about a refused request: its error code and message
// (e.g. "source_provenance_request_id_required: A stable request_id is required…").
// A bare "HTTP 400" tells the user nothing they can act on.
const errorDetailOf = j => {
  const clean = v => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, 300) : null);
  const code = clean(j?.error) ?? clean(j?.code) ?? clean(j?.deny_code);
  const message = clean(j?.message) ?? clean(j?.error_description) ?? (reasonsOf(j) || null);
  if (code && message && message !== code) return `${code}: ${message}`;
  return code ?? message;
};
const httpFailure = r => `HTTP ${r.status}${errorDetailOf(r.json) ? `, ${errorDetailOf(r.json)}` : ''}`;

// The approver's note, if the approval record carries one. Guidance only: it is shown
// to the agent and never changes the decision.
const noteOf = j => {
  for (const k of ['decision_note', 'resolution_note', 'denial_reason', 'rejection_reason', 'reason']) {
    if (typeof j?.[k] === 'string' && j[k].trim()) return j[k].trim().slice(0, 500);
  }
  return null;
};

// A deny is a policy decision, not a wait: retrying the same action gets the same answer.
const DENY_HINT = 'This is a policy decision, not a wait for approval. Do not retry it unchanged; change the approach or ask the user.';
// Needs a person, but no approval request was opened for it: route to the user, then re-run.
const APPROVAL_NEEDED_HINT = 'It needs approval from a person in AtlaSent. Stop and ask the user to get it approved; once they confirm, run exactly the same action again. Do not change the action to get around it.';
const decisionIdOf = j => {
  for (const k of ['evaluation_id', 'decision_id', 'request_id']) {
    const v = j?.[k];
    if (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(v)) return v;
  }
  return null;
};
const RETRY_HINT = 'Do not change the action. Wait, then run exactly the same action again (or use atlasent_await_approval if it is available).';

// ---------------------------------------------------------------------------
// The connected decision. Returns { effect: 'allow'|'deny', reason, outcome }.
// ---------------------------------------------------------------------------

export async function connectedDecision({ input, rule, config, creds, home, fetchImpl = fetch, now = () => new Date(), budgetMs = TOTAL_BUDGET_MS }) {
  const deadline = Date.now() + budgetMs;
  const deny = (outcome, text) => ({ effect: 'deny', outcome, reason: `AtlaSent guard: ${rule.description} [${rule.id}]. ${text}` });
  const environment = config.environment;
  if (typeof environment !== 'string' || !environment) {
    return deny('no_environment', 'Connected mode needs "connected": { "environment": "…" } in ~/.atlasent/hooks.json, so it was blocked and nothing was sent.');
  }

  let digest; let preview = null;
  try {
    digest = actionDigest(input);
    if (config.preview !== 'off') preview = redactedPreview(actionObject(input));
  } catch (e) {
    return deny('redaction_failed', `The action could not be prepared safely (${String(e.message).slice(0, 120)}), so it was blocked and nothing was sent.`);
  }

  const repo = repoIdentity(input.cwd);
  const targetId = `${rule.id}@${repo}`;
  const api = client(creds, fetchImpl, deadline);
  const pending = pendingStore(home, now);

  const verifyAndAllow = async (permitToken, actorId, bindingHash) => {
    const v = await api.verify({ permit_token: permitToken, action_type: ACTION_TYPE, actor_id: actorId, environment, target_id: targetId, payload_hash: bindingHash });
    if (v.status === 200 && v.json?.valid === true && v.json?.outcome === 'allow') {
      return { effect: 'allow', outcome: 'verified', reason: null };
    }
    const code = typeof v.json?.verify_error_code === 'string' ? ` (${v.json.verify_error_code})` : '';
    return deny('verify_failed', `The permit did not verify at this boundary${code}${reasonsOf(v.json) ? `: ${reasonsOf(v.json)}` : ''}. It was blocked.`);
  };

  // The exact context sent to the sealer and to evaluate. Built once, from the current
  // action, so the claim path recomputes the same binding the evaluate path sealed.
  const context = {
    tool: input.tool_name,
    environment,
    rule: rule.id,
    session_mode: 'unattended',
    repo,
    target_id: targetId,
    target: { id: targetId },
    // The exact action (tool name + complete input), so the sealed provenance and the
    // permit bind to it even when the preview is off or redacted.
    action_digest: digest,
    ...(preview !== null && { action_preview: preview }),
  };
  const bindingFor = (binding, assertion) => binding === 'provenance'
    ? provenanceActionHash({ tenantId: assertion.binding.tenant_id, actorId: assertion.subject.principal_id, environment, resourceId: targetId, context })
    : digest;

  try {
    const held = pending.get(digest);
    if (held?.approval_request_id) {
      const id = held.approval_request_id;
      const polled = await api.approval(id);
      if (polled.status === 401 || polled.status === 403) return deny('approval_read_refused', `Checking approval ${id} was refused (HTTP ${polled.status}); the key needs approvals:read. It stays blocked.`);
      if (polled.status === 404) { pending.del(digest); return deny('approval_missing', `Approval ${id} was not found. Run the action again to ask for approval afresh.`); }
      if (polled.status !== 200 || typeof polled.json?.status !== 'string') return deny('approval_unreadable', `Approval ${id} could not be read (${httpFailure(polled)}), so it stays blocked.`);
      const status = polled.json.status;
      if (status === 'pending') return deny('waiting', `Still waiting for a person to decide approval ${id} in AtlaSent. ${RETRY_HINT}`);
      if (!APPROVED.has(status)) {
        pending.del(digest);
        const note = noteOf(polled.json);
        return deny('not_approved', `A person did not approve this (approval ${id}: ${status}).${note ? ` Their note: "${note}".` : ''} Do not retry it unchanged.`);
      }
      // Approved. The claim spends the approval, so only start it with time left
      // for the identity mint, the claim itself and the verify after it;
      // otherwise keep the pointer and let the next run claim.
      if (deadline - Date.now() < CALL_TIMEOUT_MS + MIN_CLAIM_MS + VERIFY_RESERVE_MS) {
        return deny('waiting', `Approval ${id} is approved, but this check ran short on time before claiming it, so nothing was used. ${RETRY_HINT}`);
      }
      // Claim exactly once; whatever happens next, this pointer is spent.
      pending.del(digest);
      // No recorded binding: a pre-0.2.6 entry, which was always bound to the digest.
      if (held.binding === undefined) held.binding = 'digest';
      if (!BINDINGS.has(held.binding)) return deny('approval_unbound', `Approval ${id} has no recorded action binding here, so its permit cannot be checked. Run the action again to ask afresh.`);
      if (polled.json.action_type !== undefined && polled.json.action_type !== ACTION_TYPE) return deny('approval_mismatch', `Approval ${id} is for a different action type, so it was not used.`);
      const assertion = checkedAssertion(await api.mintIdentity(environment), environment);
      const claimBody = status === 'approved_awaiting_claim' ? { actor_identity: assertion } : {};
      const claimed = await api.claim(id, claimBody);
      const token = claimed.json?.permit_token;
      if (!(claimed.status === 200 && claimed.json?.claimed === true && typeof token === 'string' && token)) {
        const detail = errorDetailOf(claimed.json);
        return deny('claim_failed', `Approval ${id} was approved but no permit could be claimed${detail ? ` (${detail})` : ''}. It was blocked.`);
      }
      return await verifyAndAllow(token, assertion.subject.principal_id, bindingFor(held.binding, assertion));
    }

    const assertion = checkedAssertion(await api.mintIdentity(environment), environment);
    const { request_id: requestId } = pending.attempt(digest);
    // The seal must cover exactly the context and target sent to evaluate.
    const sealed = await api.seal({ action_type: ACTION_TYPE, request_id: requestId, context, resource_id: targetId });
    if (sealed.status === 409) {
      // This request's seal expired or was used for something else: start over.
      pending.del(digest);
      return deny('seal_refused', `AtlaSent would not seal source provenance for this request (${httpFailure(sealed)}). It was blocked. Run exactly the same action again to start a new request.`);
    }
    if (sealed.status !== 200 || !object(sealed.json?.source_provenance) ||
        typeof sealed.json?.action_hash !== 'string' || !HEX64_RE.test(sealed.json.action_hash)) {
      // Keep the attempt: an honest retry gets the same seal back for the same request.
      return deny('seal_failed', `AtlaSent could not seal source provenance for this action (${httpFailure(sealed)}), and it cannot be evaluated without it. It was blocked.`);
    }
    if (sealed.json.action_hash !== bindingFor('provenance', assertion)) {
      // The runtime sealed something other than this action as the guard sees it.
      return deny('seal_mismatch', 'AtlaSent sealed provenance for a different action than this one, so it was not used. It was blocked.');
    }
    const body = {
      action_type: ACTION_TYPE,
      request_id: requestId,
      actor_identity: assertion,
      resource_id: targetId,
      execution_payload_hash: digest,
      state_snapshot: { source: 'atlasent-guard', complete: true },
      context,
      source_provenance: sealed.json.source_provenance,
      ...(typeof input.session_id === 'string' && { agent_session: { host: 'claude-code', session_id: input.session_id.slice(0, 200) } }),
    };
    const r = await api.evaluate(body);
    if (r.status === 409 && r.json?.error === 'idempotency_key_reused') {
      // An earlier try of this attempt was recorded but its answer was lost; the
      // runtime does not replay it. Spend the attempt so the next run starts clean.
      pending.del(digest);
      return deny('evaluate_failed', `AtlaSent already recorded an earlier try of this request (${httpFailure(r)}). It was blocked. Run exactly the same action again.`);
    }
    // A 200 is a recorded evaluation: never re-present its request_id.
    if (r.status === 200 && !r.json) pending.del(digest);
    // Not a decision: keep the attempt, so re-running presents the same request_id.
    if (r.status !== 200 || !r.json) return deny('evaluate_failed', `AtlaSent could not evaluate this (${httpFailure(r)}). It was blocked.`);
    const d = r.json.decision;
    // Admitted provenance binds the permit to the sealed action hash; otherwise the
    // runtime binds it to the action digest we sent.
    const binding = object(r.json.source_provenance) ? 'provenance' : 'digest';
    const decisionRef = decisionIdOf(r.json) ? ` Decision ${decisionIdOf(r.json)}.` : '';
    if ((d === 'hold' || d === 'escalate') && typeof r.json.approval_request_id === 'string' && r.json.approval_request_id) {
      const id = r.json.approval_request_id;
      pending.hold(digest, id, binding);
      return deny('held', `Held for approval (${id}). A person has been asked in AtlaSent.${decisionRef} ${RETRY_HINT}`);
    }
    if (d === 'hold' || d === 'escalate') {
      // The runtime held it but recorded no approval request (a non-fatal path on
      // its side). Nobody can approve it, so re-running would only hold again.
      pending.del(digest);
      return deny('held_unrecorded', `AtlaSent held this for approval, but no approval request was recorded, so there is nothing for a person to approve.${decisionRef} It was blocked. Do not retry it automatically; tell the user.`);
    }
    if (d !== 'allow' && d !== 'deny') {
      pending.del(digest);
      return deny('evaluate_failed', `AtlaSent answered with an unrecognized decision${typeof d === 'string' ? ` ("${d.slice(0, 40)}")` : ''}.${decisionRef} It was blocked.`);
    }
    if (d === 'allow' && typeof r.json.permit_token === 'string' && r.json.permit_token) {
      // The governing policy allowed without a person. That is the policy's call; the
      // permit still has to verify here.
      pending.del(digest);
      return await verifyAndAllow(r.json.permit_token, assertion.subject.principal_id, bindingFor(binding, assertion));
    }
    pending.del(digest); // a final decision spends this attempt's request_id
    if (d === 'allow') return deny('evaluate_failed', `AtlaSent allowed this but returned no permit, so there is nothing to verify.${decisionRef} It was blocked.`);
    const code = typeof r.json.deny_code === 'string' ? ` (${r.json.deny_code})` : '';
    // INSUFFICIENT_APPROVALS is not a terminal refusal: a person's approval resolves it
    // (src/engine.ts routes it via requires_human_approval). It is still blocked now.
    const hint = r.json.deny_code === 'INSUFFICIENT_APPROVALS' ? APPROVAL_NEEDED_HINT : DENY_HINT;
    return deny(r.json.deny_code === 'INSUFFICIENT_APPROVALS' ? 'needs_approval' : 'denied', `AtlaSent denied this${code}${reasonsOf(r.json) ? `: ${reasonsOf(r.json)}` : ''}.${decisionRef} ${hint}`);
  } catch (e) {
    return deny('error', `AtlaSent could not be reached or answered unexpectedly (${String(e?.message ?? e).slice(0, 160)}), so it was blocked.`);
  }
}
