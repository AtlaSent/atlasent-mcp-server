import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { classify, decisionOf } from './rules.mjs';
import { loadPolicy, configPaths, ENVIRONMENT_NAME } from './policy.mjs';
import { loadCredentials, connectedDecision } from './connected.mjs';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);

// Permission modes in which no human is going to answer a prompt. An "ask" there
// would either be skipped or stall, so it becomes a refusal unless the operator set
// "unattended": "ask".
const UNATTENDED_MODES = new Set(['bypassPermissions', 'dontAsk']);

// Map a Claude Code PreToolUse payload to a proposed action.
// https://code.claude.com/docs/en/hooks
export function actionFromClaudeCode(input) {
  if (!object(input) || typeof input.tool_name !== 'string') throw Error('malformed hook input');
  const ti = object(input.tool_input) ? input.tool_input : {};
  const name = input.tool_name;
  if (name === 'Bash') {
    if (typeof ti.command !== 'string') throw Error('malformed Bash input');
    return { kind: 'shell', command: ti.command };
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return { kind: 'write', path: String(ti.file_path ?? ti.notebook_path ?? '') };
  return { kind: 'tool', name, input: ti };
}

export function subjectDigest(action) {
  return createHash('sha256').update(JSON.stringify(action)).digest('hex');
}

// Metadata-only activity record: which rule, what was decided, and a digest of the
// command. Never the command text itself, which routinely carries secrets.
export function audit(record, env = process.env) {
  if (env.ATLASENT_HOOKS_AUDIT === 'off') return;
  const file = env.ATLASENT_HOOKS_AUDIT ?? join(dirname(configPaths(null, env).user), 'agent-hooks-activity.jsonl');
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    closeSync(openSync(file, 'a', 0o600));
    appendFileSync(file, JSON.stringify(record) + '\n');
  } catch { /* an audit failure must not turn into an allow; decisions are made before this */ }
}

// Core decision. Never throws: any internal failure is a refusal.
export function evaluate({ host, input, env = process.env, now = () => new Date() }) {
  let action; let policy;
  try {
    action = actionFromClaudeCode(input);
  } catch {
    return { effect: 'deny', reason: 'AtlaSent guard could not read the proposed action, so it was blocked (fail-closed).', rule: 'guard.malformed-input' };
  }
  try {
    policy = loadPolicy(typeof input.cwd === 'string' ? input.cwd : null, env);
  } catch (e) {
    return { effect: 'deny', reason: `AtlaSent guard configuration is invalid, so every checked action is blocked until it is fixed: ${String(e.message).slice(0, 200)}`, rule: 'guard.invalid-config' };
  }
  const hits = classify(action, policy);
  let { effect, rule } = decisionOf(hits);
  if (effect === 'allow') return { effect, reason: null, rule: null };
  const unattended = UNATTENDED_MODES.has(input.permission_mode) || env.ATLASENT_HOOKS_UNATTENDED === '1';
  let reason = `AtlaSent guard: ${rule.description} [${rule.id}].`;
  let unattendedAsk = false;
  if (effect === 'ask' && unattended && policy.unattended === 'deny') {
    effect = 'deny';
    unattendedAsk = true;
    reason += ' Nobody is available to approve it in this permission mode, so it was blocked. Ask a person to run it, or run the agent in a mode that prompts.';
  } else if (effect === 'ask') {
    reason += ' A person must approve this before it runs.';
  } else {
    reason += ' This is blocked outright.';
  }
  audit({ ts: now().toISOString(), host, event: input.hook_event_name ?? null, session: typeof input.session_id === 'string' ? input.session_id : null, rule: rule.id, matched: hits.map(h => h.id), decision: effect, subject_sha256: subjectDigest(action) }, env);
  // Internal fields (not serialized to Claude Code) let decide() route an unattended
  // ask to connected mode.
  return { effect, reason, rule: rule.id, ...(unattendedAsk && { _unattendedAsk: { rule, policy } }) };
}

export const NUDGE = 'To have this wait for approval from your phone instead of stopping, connect Atlasent: atlasent-hooks connect';

// Once per session, and only where the limit was actually hit: an unattended ask with
// no key configured. Never in an attended prompt.
function nudgeOnce(home, sessionId, env, now) {
  if (env.ATLASENT_HOOKS_NUDGE === 'off' || typeof sessionId !== 'string' || !sessionId) return false;
  const file = join(home, 'nudged.json');
  let seen = {};
  try { const v = JSON.parse(readFileSync(file, 'utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) seen = v; } catch { /* first time */ }
  if (seen[sessionId]) return false;
  const cutoff = now().getTime() - 7 * 24 * 60 * 60 * 1000;
  for (const [k, t] of Object.entries(seen)) if (!(Date.parse(t) > cutoff)) delete seen[k];
  seen[sessionId] = now().toISOString();
  try { mkdirSync(home, { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(seen) + '\n', { mode: 0o600 }); } catch { return false; }
  return true;
}

// Full decision, including connected mode. Never throws: any failure is a refusal.
export async function decide({ host, input, env = process.env, now = () => new Date(), fetchImpl = globalThis.fetch }) {
  const d = evaluate({ host, input, env, now });
  if (!d._unattendedAsk) return d;
  const { rule, policy } = d._unattendedAsk;
  const home = dirname(configPaths(null, env).user);
  let creds;
  try {
    creds = loadCredentials(home, env);
  } catch (e) {
    return { effect: 'deny', rule: rule.id, reason: `${d.reason} The Atlasent credentials are invalid (${String(e.message).slice(0, 120)}), so connected approval is unavailable.` };
  }
  if (!creds) {
    return nudgeOnce(home, input.session_id, env, now) ? { ...d, reason: `${d.reason} ${NUDGE}` } : d;
  }
  // Environment: the user's own hooks.json first, then the plugin's `environment`
  // setting (user-owned, exported as CLAUDE_PLUGIN_OPTION_ENVIRONMENT). Never a
  // repository config: see mergePolicies.
  const config = { ...(policy.connected ?? {}) };
  if (config.environment === undefined) {
    const fromPlugin = typeof env.CLAUDE_PLUGIN_OPTION_ENVIRONMENT === 'string' ? env.CLAUDE_PLUGIN_OPTION_ENVIRONMENT.trim() : '';
    if (fromPlugin !== '') {
      if (!ENVIRONMENT_NAME.test(fromPlugin)) {
        return { effect: 'deny', rule: rule.id, reason: `${d.reason} The plugin's Atlasent environment setting is not a short lowercase name such as "production", so connected approval is unavailable and nothing was sent.` };
      }
      config.environment = fromPlugin;
    }
  }
  let r;
  try {
    r = await connectedDecision({ input, rule, config, creds, home, fetchImpl, now });
  } catch (e) {
    r = { effect: 'deny', outcome: 'error', reason: `${d.reason} Connected approval failed (${String(e?.message ?? e).slice(0, 120)}).` };
  }
  audit({ ts: now().toISOString(), host, event: 'connected', session: typeof input.session_id === 'string' ? input.session_id : null, rule: rule.id, decision: r.effect, outcome: r.outcome ?? null }, env);
  return { effect: r.effect, reason: r.reason, rule: rule.id };
}

export function claudeCodeResponse(d) {
  // No decision for "allow": the call falls through to Claude Code's own permission
  // system. The guard only ever adds friction; it never grants what Claude Code would
  // otherwise have asked about.
  if (d.effect === 'allow') return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.effect, permissionDecisionReason: d.reason } };
}
