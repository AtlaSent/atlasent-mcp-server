#!/usr/bin/env node
// atlasent-hooks — a PreToolUse guard for Claude Code.
//   atlasent-hooks claude-code      read a PreToolUse payload on stdin, answer on stdout
//   atlasent-hooks check "<cmd>"    show what the guard would do with a shell command
//   atlasent-hooks rules            list the built-in rules
//   atlasent-hooks init             write a starter ~/.atlasent/hooks.json (never overwrites)
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { evaluate, claudeCodeResponse } from './hook.mjs';
import { RULES, classify, decisionOf } from './rules.mjs';
import { loadPolicy, configPaths } from './policy.mjs';

const [mode, ...args] = process.argv.slice(2);

if (mode === 'claude-code') {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { input = null; }
  const decision = evaluate({ host: 'claude-code', input: input ?? {} });
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
} else {
  console.error('Usage: atlasent-hooks claude-code | check "<command>" | rules | init');
  process.exitCode = 2;
}
