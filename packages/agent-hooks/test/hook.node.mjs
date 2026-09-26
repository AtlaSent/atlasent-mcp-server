import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

// Run the hook exactly as Claude Code does: JSON on stdin, JSON (or nothing) on stdout.
function run(payload, { raw, home, env = {} } = {}) {
  const h = home ?? mkdtempSync(join(tmpdir(), 'ah-home-'));
  const r = spawnSync(process.execPath, [CLI, 'claude-code'], {
    input: raw ?? JSON.stringify(payload),
    env: { PATH: process.env.PATH, ATLASENT_HOOKS_HOME: h, ...env },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout.trim() ? JSON.parse(r.stdout) : null, home: h };
}
const bash = (command, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: extra.cwd ?? tmpdir(), permission_mode: 'default', tool_name: 'Bash', tool_input: { command }, ...extra });
const decision = out => out?.hookSpecificOutput?.permissionDecision ?? null;

test('ordinary commands produce no output, so Claude Code\'s own permissions apply', () => {
  assert.equal(run(bash('npm test')).out, null);
});

test('a destructive command asks, with a reason naming the rule', () => {
  const { out } = run(bash('terraform destroy'));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(decision(out), 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /iac\.destroy/);
});

test('a catastrophic command is denied outright', () => {
  assert.equal(decision(run(bash('rm -rf /')).out), 'deny');
});

test('with nobody to ask (bypassPermissions), an ask becomes a deny', () => {
  const { out } = run(bash('psql -c "DROP TABLE users"', { permission_mode: 'bypassPermissions' }));
  assert.equal(decision(out), 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Nobody is available to approve/);
});

test('unreadable input fails closed', () => {
  assert.equal(decision(run(null, { raw: 'not json' }).out), 'deny');
  assert.equal(decision(run({ tool_name: 'Bash', tool_input: {} }).out), 'deny');
});

test('an invalid config fails closed on every checked call, including harmless ones', () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-home-'));
  writeFileSync(join(home, 'hooks.json'), '{"version":1,"rules":{"no.such.rule":"allow"}}');
  const { out } = run(bash('ls'), { home });
  assert.equal(decision(out), 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /configuration is invalid/);
});

test('a repository config cannot weaken the user config', () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-home-'));
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ version: 1, rules: { 'deploy.release': 'deny' } }));
  const repo = mkdtempSync(join(tmpdir(), 'ah-repo-'));
  mkdirSync(join(repo, '.atlasent'));
  writeFileSync(join(repo, '.atlasent', 'hooks.json'), JSON.stringify({ version: 1, rules: { 'deploy.release': 'allow', 'git.force-push': 'deny' }, unattended: 'ask' }));
  assert.equal(decision(run(bash('vercel --prod', { cwd: repo }), { home }).out), 'deny', 'user deny must survive a repo allow');
  assert.equal(decision(run(bash('git push -f', { cwd: repo }), { home }).out), 'deny', 'a repo may tighten');
  assert.equal(decision(run(bash('terraform destroy', { cwd: repo, permission_mode: 'bypassPermissions' }), { home }).out), 'deny', 'repo cannot relax unattended handling');
});

test('a repository config is found from a subdirectory of the repository', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ah-repo-'));
  mkdirSync(join(repo, '.atlasent'));
  writeFileSync(join(repo, '.atlasent', 'hooks.json'), JSON.stringify({ version: 1, rules: { 'deploy.release': 'deny' } }));
  const sub = join(repo, 'packages', 'app');
  mkdirSync(sub, { recursive: true });
  assert.equal(decision(run(bash('vercel --prod', { cwd: sub })).out), 'deny');
});

test('the agent editing the guard config through Write needs approval', () => {
  const { out } = run({ hook_event_name: 'PreToolUse', cwd: tmpdir(), tool_name: 'Write', tool_input: { file_path: '/repo/.atlasent/hooks.json', content: '{}' } });
  assert.equal(decision(out), 'ask');
});

test('destructive MCP tools ask', () => {
  const { out } = run({ hook_event_name: 'PreToolUse', cwd: tmpdir(), tool_name: 'mcp__supabase__execute_sql', tool_input: { query: 'truncate table orders' } });
  assert.equal(decision(out), 'ask');
});

test('the activity log records the decision but never the command text', () => {
  const secret = 'postgres://admin:hunter2@prod-db/app';
  const { home } = run(bash(`psql ${secret} -c "DROP TABLE users"`));
  const file = join(home, 'agent-hooks-activity.jsonl');
  assert.ok(existsSync(file));
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes('hunter2') && !text.includes('DROP'), 'command text leaked into the log');
  const rec = JSON.parse(text.trim().split('\n').pop());
  assert.equal(rec.rule, 'sql.destructive');
  assert.equal(rec.decision, 'ask');
  assert.match(rec.subject_sha256, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0, 'log must be private');
});

test('allowed commands are not logged', () => {
  const { home } = run(bash('ls'));
  assert.ok(!existsSync(join(home, 'agent-hooks-activity.jsonl')));
});

test('plugin manifest and hook registration are wired to this CLI', () => {
  const plugin = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const market = JSON.parse(readFileSync(new URL('../../../.claude-plugin/marketplace.json', import.meta.url), 'utf8'));
  assert.equal(plugin.version, pkg.version, 'plugin.json and package.json versions must match');
  const entry = hooks.hooks.PreToolUse[0];
  for (const tool of ['Bash', 'Write', 'Edit', 'mcp__supabase__execute_sql']) assert.match(tool, new RegExp(`^(${entry.matcher})$`), tool);
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/cli\.mjs" claude-code$/);
  assert.equal(market.plugins.find(p => p.name === plugin.name)?.source, './packages/agent-hooks');
});
