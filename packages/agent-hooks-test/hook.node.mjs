import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../agent-hooks/cli.mjs', import.meta.url));

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
  const plugin = JSON.parse(readFileSync(new URL('../agent-hooks/.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  const hooks = JSON.parse(readFileSync(new URL('../agent-hooks/hooks/hooks.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(readFileSync(new URL('../agent-hooks/package.json', import.meta.url), 'utf8'));
  const market = JSON.parse(readFileSync(new URL('../../.claude-plugin/marketplace.json', import.meta.url), 'utf8'));
  assert.equal(plugin.version, pkg.version, 'plugin.json and package.json versions must match');
  const entry = hooks.hooks.PreToolUse[0];
  for (const tool of ['Bash', 'Write', 'Edit', 'mcp__supabase__execute_sql']) assert.match(tool, new RegExp(`^(${entry.matcher})$`), tool);
  // --plugin makes the plugin's own key setting the only credential read; the command
  // may be wrapped (see the hooks.json command tests below) but must still pass it.
  assert.match(entry.hooks[0].command, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/cli\.mjs" claude-code --plugin( |$)/);
  assert.equal(market.plugins.find(p => p.name === plugin.name)?.source, './packages/agent-hooks');
});

// The plugin installs packages/agent-hooks as a whole, so everything in it ships. The
// Claude directory refuses a plugin with a secret-shaped string in any file, and the
// redaction fixtures are exactly that, which is why the tests live in this folder.
test('the shipped plugin folder holds no tests and no secret-shaped string', () => {
  const root = fileURLToPath(new URL('../agent-hooks/', import.meta.url));
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const files = walk(root);
  assert.ok(files.length > 5, 'walked the plugin folder');
  assert.deepEqual(files.filter(f => /(^|[\\/])(test|tests|__tests__)[\\/]|\.(test|spec|node)\.m?js$/.test(f.slice(root.length))), []);
  // Token shapes a secret scanner flags (the redaction fixtures use every one of them).
  const TOKENS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bask_(?:live|test)_[A-Za-z0-9_-]{6,}/, /\bsk-[A-Za-z0-9_-]{16,}/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bxox[abposr]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/];
  for (const f of files) { const text = readFileSync(f, 'utf8'); for (const re of TOKENS) assert.doesNotMatch(text, re, f); }
});

// The command Claude Code actually runs is hooks/hooks.json's, not cli.mjs directly.
// Claude Code treats a hook that exits non-zero (other than 2) as a non-blocking error
// and runs the tool anyway, so a machine without Node used to get NO protection with the
// plugin shown as enabled. The wrapper must block (exit 2) instead.
const HOOK_COMMAND = JSON.parse(readFileSync(fileURLToPath(new URL('../agent-hooks/hooks/hooks.json', import.meta.url)), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
const PLUGIN_ROOT = fileURLToPath(new URL('../agent-hooks', import.meta.url));
function runHookCommand(payload, env) {
  return spawnSync('sh', ['-c', HOOK_COMMAND], { input: JSON.stringify(payload), encoding: 'utf8', env: { ATLASENT_HOOKS_HOME: mkdtempSync(join(tmpdir(), 'ah-home-')), ...env } });
}

test('hooks.json command: with Node present it answers exactly as the CLI does', () => {
  const r = runHookCommand(bash('terraform destroy'), { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(decision(JSON.parse(r.stdout)), 'ask');
  const quiet = runHookCommand(bash('npm test'), { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout.trim(), '');
});

test('hooks.json command: no Node on PATH blocks (exit 2) instead of silently allowing', () => {
  const emptyBin = mkdtempSync(join(tmpdir(), 'ah-nobin-'));
  // `sh` itself is resolved by spawnSync; inside it, PATH holds no node.
  const r = spawnSync('/bin/sh', ['-c', HOOK_COMMAND], { input: JSON.stringify(bash('npm test')), encoding: 'utf8', env: { PATH: emptyBin, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs Node\.js 18/);
});

test('hooks.json command: a guard that cannot start blocks (exit 2)', () => {
  const r = runHookCommand(bash('npm test'), { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: join(tmpdir(), 'no-such-plugin-root') });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /fail-closed/);
});
