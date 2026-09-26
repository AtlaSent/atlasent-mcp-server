import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { classify, decisionOf } from './rules.mjs';
import { loadPolicy, configPaths } from './policy.mjs';

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
  if (effect === 'ask' && unattended && policy.unattended === 'deny') {
    effect = 'deny';
    reason += ' Nobody is available to approve it in this permission mode, so it was blocked. Ask a person to run it, or run the agent in a mode that prompts.';
  } else if (effect === 'ask') {
    reason += ' A person must approve this before it runs.';
  } else {
    reason += ' This is blocked outright.';
  }
  audit({ ts: now().toISOString(), host, event: input.hook_event_name ?? null, session: typeof input.session_id === 'string' ? input.session_id : null, rule: rule.id, matched: hits.map(h => h.id), decision: effect, subject_sha256: subjectDigest(action) }, env);
  return { effect, reason, rule: rule.id };
}

export function claudeCodeResponse(d) {
  // No decision for "allow": the call falls through to Claude Code's own permission
  // system. The guard only ever adds friction; it never grants what Claude Code would
  // otherwise have asked about.
  if (d.effect === 'allow') return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.effect, permissionDecisionReason: d.reason } };
}
