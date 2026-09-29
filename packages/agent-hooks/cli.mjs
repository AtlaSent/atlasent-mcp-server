#!/usr/bin/env node
// atlasent-hooks — a PreToolUse guard for Claude Code.
//   atlasent-hooks claude-code      read a PreToolUse payload on stdin, answer on stdout
//   atlasent-hooks check "<cmd>"    show what the guard would do with a shell command
//   atlasent-hooks rules            list the built-in rules
//   atlasent-hooks init             write a starter ~/.atlasent/hooks.json (never overwrites)
//   atlasent-hooks connect          connect to AtlaSent so unattended asks wait for approval
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decide, claudeCodeResponse } from './hook.mjs';
import { RULES, classify, decisionOf } from './rules.mjs';
import { loadPolicy, configPaths, validatePolicy } from './policy.mjs';
import { loadCredentials } from './connected.mjs';

const [mode, ...args] = process.argv.slice(2);

if (mode === 'claude-code') {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { input = null; }
  let decision;
  try {
    decision = await decide({ host: 'claude-code', input: input ?? {} });
  } catch {
    decision = { effect: 'deny', reason: 'AtlaSent guard failed unexpectedly, so the action was blocked (fail-closed).' };
  }
  const body = claudeCodeResponse(decision);
  if (body) process.stdout.write(JSON.stringify(body) + '\n');
  process.exitCode = 0;
} else if (mode === 'check' && args.length) {
  const policy = loadPolicy(process.cwd());
  const hits = classify({ kind: 'shell', command: args.join(' ') }, policy);
  const { effect, rule } = decisionOf(hits);
  console.log(effect.toUpperCase() + (rule ? `  ${rule.id} — ${rule.description}` : '  (no rule matched)'));
  for (const h of hits.slice(1)) console.log(`  also: ${h.id} (${h.effect})`);
} else if (mode === 'rules') {
  for (const r of RULES) console.log(`${r.effect.padEnd(5)} ${r.id.padEnd(20)} ${r.description}`);
} else if (mode === 'init') {
  const file = configPaths(null).user;
  if (existsSync(file)) { console.error(`${file} already exists; not overwritten.`); process.exitCode = 1; }
  else {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ version: 1, rules: {}, custom: [], unattended: 'deny' }, null, 2) + '\n', { mode: 0o600 });
    console.error(`Wrote ${file}. Run "atlasent-hooks rules" to see rule ids you can set to allow, ask or deny.`);
  }
} else if (mode === 'connect') {
  // atlasent-hooks connect --environment production [--base-url URL]  < key-on-stdin
  // The key is read from stdin so it never lands in shell history.
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const environment = opt('--environment');
  if (!environment || process.stdin.isTTY) {
    console.error([
      'Connect the guard to AtlaSent so an unattended "ask" waits for a person instead of stopping:',
      '  1. Sign up and connect an agent: https://console.atlasent.io/auth/sign-up?utm_source=agent-hooks&utm_medium=cli',
      '     Copy the agent key it shows you (ask_live_… or ask_test_…).',
      '  2. Run:  atlasent-hooks connect --environment production < key.txt',
      '     (or pipe it: pbpaste | atlasent-hooks connect --environment production)',
    ].join('\n'));
    process.exitCode = environment ? 1 : 2;
  } else {
    const home = dirname(configPaths(null).user);
    const apiKey = readFileSync(0, 'utf8').trim();
    const baseUrl = opt('--base-url');
    try {
      const creds = loadCredentials(home, { ATLASENT_HOOKS_API_KEY: apiKey, ...(baseUrl && { ATLASENT_HOOKS_BASE_URL: baseUrl }) });
      const file = configPaths(null).user;
      const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, rules: {}, custom: [], unattended: 'deny' };
      const next = { ...current, connected: { ...(current.connected ?? {}), environment } };
      validatePolicy(next);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      writeFileSync(join(home, 'credentials.json'), JSON.stringify({ api_key: creds.apiKey, ...(baseUrl && { base_url: creds.baseUrl }) }) + '\n', { mode: 0o600 });
      writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      console.error(`Connected. Unattended asks now go to AtlaSent (${environment}). Credentials: ${join(home, 'credentials.json')}`);
    } catch (e) {
      console.error(`Not connected: ${e.message}`);
      process.exitCode = 1;
    }
  }
} else {
  console.error('Usage: atlasent-hooks claude-code | check "<command>" | rules | init | connect');
  process.exitCode = 2;
}
