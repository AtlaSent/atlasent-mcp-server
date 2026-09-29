// Connected mode: an unattended "ask" goes to the organization's Atlasent policy
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

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { canonicalJson } from './jcs.mjs';
import { redactedPreview } from './redact.mjs';

export const ACTION_TYPE = 'agent.tool.invoke';
const DEFAULT_BASE = 'https://api.atlasent.io/functions/v1';
// Claude Code kills a hook at hooks.json's timeout; finish well inside it.
export const TOTAL_BUDGET_MS = 20_000;
const CALL_TIMEOUT_MS = 6_000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // matches the runtime's hold expiry
const APPROVED = new Set(['approved', 'approved_awaiting_claim']);

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Where the key comes from depends on how the hook was installed.
//   Plugin (hooks.json passes --plugin): ONLY the plugin's own `api_key` setting
//     (plugin.json userConfig, stored by Claude Code, exported as
//     CLAUDE_PLUGIN_OPTION_API_KEY). No other credential on the machine is read, and
//     the key goes only to the Atlasent API.
//   npm CLI: ATLASENT_HOOKS_API_KEY (CI and tests), else <home>/credentials.json
//     ({ "api_key", "base_url"? }), written by `atlasent-hooks connect`.
// A blank value counts as unset: an optional setting left empty is exported as "".
// No key → not connected.
const set = v => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
export function loadCredentials(home, env = process.env, { plugin = false } = {}) {
  if (plugin) {
    const apiKey = set(env.CLAUDE_PLUGIN_OPTION_API_KEY);
    if (!apiKey) return null;
    if (!/^ask_(live|test)_[A-Za-z0-9_-]+$/.test(apiKey)) throw Error('the Atlasent API key is not in ask_live_… / ask_test_… form');
    return { apiKey, baseUrl: DEFAULT_BASE };
  }
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
  if (typeof apiKey !== 'string' || !/^ask_(live|test)_[A-Za-z0-9_-]+$/.test(apiKey)) throw Error('the Atlasent API key is not in ask_live_… / ask_test_… form');
  // A key and its endpoint travel together: credentials.json's base_url applies only to
  // the key stored beside it, so an env key never goes to a leftover host.
  const baseUrl = String(set(env.ATLASENT_HOOKS_BASE_URL) ?? (fromEnv ? undefined : file.base_url) ?? DEFAULT_BASE).replace(/\/+$/, '');
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(baseUrl)) throw Error('base_url must be https');
  return { apiKey, baseUrl };
}

// "/v1/approvals/…" is served at the API root, "/v1-evaluate" under /functions/v1
// (same split as src/engine.ts restBaseUrl).
function restBase(baseUrl) {
  return baseUrl.endsWith('/functions/v1') ? baseUrl.slice(0, -'/functions/v1'.length) : baseUrl;
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
export function pendingStore(home, now) {
  const path = join(home, 'pending.json');
  const load = () => {
    const all = readJson(path);
    const t = now().getTime();
    for (const [k, v] of Object.entries(all)) if (!object(v) || typeof v.approval_request_id !== 'string' || !(t - Date.parse(v.created_at) < PENDING_TTL_MS)) delete all[k];
    return all;
  };
  return {
    get: digest => load()[digest] ?? null,
    set: (digest, approval_request_id) => { const all = load(); all[digest] = { approval_request_id, created_at: now().toISOString() }; writeJsonPrivate(path, all); },
    del: digest => { const all = load(); if (digest in all) { delete all[digest]; writeJsonPrivate(path, all); } },
  };
}

// ---------------------------------------------------------------------------
// HTTP: every call bounded, every failure an exception the caller turns into deny.
// ---------------------------------------------------------------------------

function client(creds, fetchImpl, deadline) {
  const call = async (method, url, body) => {
    const left = deadline - Date.now();
    if (left <= 0) throw Error('ran out of time');
    const res = await fetchImpl(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${creds.apiKey}`, 'User-Agent': '@atlasent/agent-hooks' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(Math.min(CALL_TIMEOUT_MS, left)),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json: object(json) ? json : null };
  };
  const fn = p => `${creds.baseUrl}${p}`;
  const rest = p => `${restBase(creds.baseUrl)}${p}`;
  return {
    mintIdentity: environment => call('POST', fn('/v1-agent-actor-identity'), { action_type: ACTION_TYPE, environment }),
    evaluate: body => call('POST', fn('/v1-evaluate'), body),
    verify: body => call('POST', fn('/v1-verify-permit'), body),
    approval: id => call('GET', rest(`/v1/approvals/${encodeURIComponent(id)}`)),
    claim: (id, body) => call('POST', rest(`/v1/approvals/${encodeURIComponent(id)}/claim-permit`), body),
  };
}

// The minted assertion must be an agent identity for exactly this binding; the runtime
// checks the signature. Returns the assertion or throws.
function checkedAssertion(r, environment) {
  if (r.status === 404) throw Error('this Atlasent runtime has no agent identity endpoint');
  if (r.status !== 200) throw Error(`agent identity was refused (${typeof r.json?.error === 'string' ? r.json.error : `HTTP ${r.status}`}); the key must be bound to a registered agent`);
  const a = r.json?.assertion;
  if (!object(a) || a.version !== 'actor_identity.v1' || a.subject?.principal_kind !== 'agent' ||
      typeof a.subject?.principal_id !== 'string' || a.binding?.action_type !== ACTION_TYPE ||
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

// The approver's note, if the approval record carries one. Guidance only: it is shown
// to the agent and never changes the decision.
const noteOf = j => {
  for (const k of ['decision_note', 'resolution_note', 'denial_reason', 'rejection_reason', 'reason']) {
    if (typeof j?.[k] === 'string' && j[k].trim()) return j[k].trim().slice(0, 500);
  }
  return null;
};

const RETRY_HINT = 'Do not change the action. Wait, then run exactly the same action again (or use atlasent_await_approval if it is available).';

// ---------------------------------------------------------------------------
// The connected decision. Returns { effect: 'allow'|'deny', reason, outcome }.
// ---------------------------------------------------------------------------

export async function connectedDecision({ input, rule, config, creds, home, fetchImpl = fetch, now = () => new Date() }) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
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

  const verifyAndAllow = async (permitToken, actorId) => {
    const v = await api.verify({ permit_token: permitToken, action_type: ACTION_TYPE, actor_id: actorId, environment, target_id: targetId, payload_hash: digest });
    if (v.status === 200 && v.json?.valid === true && v.json?.outcome === 'allow') {
      return { effect: 'allow', outcome: 'verified', reason: null };
    }
    const code = typeof v.json?.verify_error_code === 'string' ? ` (${v.json.verify_error_code})` : '';
    return deny('verify_failed', `The permit did not verify at this boundary${code}${reasonsOf(v.json) ? `: ${reasonsOf(v.json)}` : ''}. It was blocked.`);
  };

  try {
    const held = pending.get(digest);
    if (held) {
      const id = held.approval_request_id;
      const polled = await api.approval(id);
      if (polled.status === 401 || polled.status === 403) return deny('approval_read_refused', `Checking approval ${id} was refused (HTTP ${polled.status}); the key needs approvals:read. It stays blocked.`);
      if (polled.status === 404) { pending.del(digest); return deny('approval_missing', `Approval ${id} was not found. Run the action again to ask for approval afresh.`); }
      if (polled.status !== 200 || typeof polled.json?.status !== 'string') return deny('approval_unreadable', `Approval ${id} could not be read, so it stays blocked.`);
      const status = polled.json.status;
      if (status === 'pending') return deny('waiting', `Still waiting for a person to decide approval ${id} in Atlasent. ${RETRY_HINT}`);
      if (!APPROVED.has(status)) {
        pending.del(digest);
        const note = noteOf(polled.json);
        return deny('not_approved', `A person did not approve this (approval ${id}: ${status}).${note ? ` Their note: "${note}".` : ''} Do not retry it unchanged.`);
      }
      // Approved. Claim exactly once; whatever happens next, this pointer is spent.
      pending.del(digest);
      if (polled.json.action_type !== undefined && polled.json.action_type !== ACTION_TYPE) return deny('approval_mismatch', `Approval ${id} is for a different action type, so it was not used.`);
      const assertion = checkedAssertion(await api.mintIdentity(environment), environment);
      const claimBody = status === 'approved_awaiting_claim' ? { actor_identity: assertion } : {};
      const claimed = await api.claim(id, claimBody);
      const token = claimed.json?.permit_token;
      if (!(claimed.status === 200 && claimed.json?.claimed === true && typeof token === 'string' && token)) {
        const code = claimed.json?.deny_code ?? claimed.json?.error;
        return deny('claim_failed', `Approval ${id} was approved but no permit could be claimed${typeof code === 'string' ? ` (${code})` : ''}. It was blocked.`);
      }
      return await verifyAndAllow(token, assertion.subject.principal_id);
    }

    const assertion = checkedAssertion(await api.mintIdentity(environment), environment);
    const context = {
      tool: input.tool_name,
      environment,
      rule: rule.id,
      session_mode: 'unattended',
      repo,
      target_id: targetId,
      target: { id: targetId },
      ...(preview !== null && { action_preview: preview }),
    };
    const body = {
      action_type: ACTION_TYPE,
      actor_identity: assertion,
      resource_id: targetId,
      execution_payload_hash: digest,
      state_snapshot: { source: 'atlasent-guard', complete: true },
      context,
      ...(typeof input.session_id === 'string' && { agent_session: { host: 'claude-code', session_id: input.session_id.slice(0, 200) } }),
    };
    const r = await api.evaluate(body);
    if (r.status !== 200 || !r.json) return deny('evaluate_failed', `Atlasent could not evaluate this (HTTP ${r.status})${reasonsOf(r.json) ? `: ${reasonsOf(r.json)}` : ''}. It was blocked.`);
    const d = r.json.decision;
    if ((d === 'hold' || d === 'escalate') && typeof r.json.approval_request_id === 'string' && r.json.approval_request_id) {
      const id = r.json.approval_request_id;
      pending.set(digest, id);
      return deny('held', `Held for approval (${id}). A person has been asked in Atlasent. ${RETRY_HINT}`);
    }
    if (d === 'allow' && typeof r.json.permit_token === 'string' && r.json.permit_token) {
      // The governing policy allowed without a person. That is the policy's call; the
      // permit still has to verify here.
      return await verifyAndAllow(r.json.permit_token, assertion.subject.principal_id);
    }
    const code = typeof r.json.deny_code === 'string' ? ` (${r.json.deny_code})` : '';
    return deny('denied', `Atlasent denied this${code}${reasonsOf(r.json) ? `: ${reasonsOf(r.json)}` : ''}.`);
  } catch (e) {
    return deny('error', `Atlasent could not be reached or answered unexpectedly (${String(e?.message ?? e).slice(0, 160)}), so it was blocked.`);
  }
}
