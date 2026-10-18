#!/usr/bin/env node
import { readFileSync, writeFileSync, openSync, writeSync, closeSync, fstatSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup } from './setup.mjs';
import { cloudAuthorizer, validateConnection } from './cloud.mjs';
import { runGate, validatePolicy } from './gate.mjs';

const starter = { version: 1, default: 'deny', rules: [
  { id: 'demo-read', tool: 'read_status', effect: 'allow', kind: 'read' },
  { id: 'demo-sandbox-write', tool: 'set_status', effect: 'allow', kind: 'write', argumentsEquals: { environment: 'sandbox', status: 'ready' } }
] };
// Where a local-edition user learns this is part of a product. Names only what is
// true today (README "Free / paid boundary"): the organizational features are
// planned, so this points at the plans page and promises nothing. Tagged so a
// signup that follows is attributed to this CLI.
const LOCAL_EDITION_NOTE = 'This is the free local edition (AtlaSent Community plan): https://www.atlasent.io/pricing?utm_source=mcp-gate&utm_medium=cli';
const escape = x => String(x).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function main() {
  let [mode, ...args] = process.argv.slice(2);
  let authorize;
  if (mode === 'run-connected') {
    if (args.length < 5 || args[3] !== '--') throw Error('Invalid connected command');
    const connection = validateConnection(JSON.parse(readFileSync(args[1], 'utf8')));
    authorize = cloudAuthorizer(connection, process.env.ATLASENT_GATE_API_KEY);
    args = [args[0], ...args.slice(2)];
    mode = 'run-dir';
  }
  if (mode === 'setup-connected' && args.length >= 4 && args[2] === '--') {
    const connection = validateConnection(JSON.parse(readFileSync(args[1], 'utf8')));
    const dir = setup(args[0], args[3], args.slice(4), connection);
    console.error('Connected setup created: ' + dir + '\nReview CONNECTED-MODE.txt and policy.json before using the generated client entry.');
  } else if (mode === 'check-connection' && args.length === 1) {
    const parsed = JSON.parse(readFileSync(args[0], 'utf8'));
    // Name the failing rule. Every message validateConnection throws is a fixed string
    // authored here with no interpolation, so this echoes no file or upstream content.
    // The global catch below stays deliberately generic on purpose: the run paths can
    // fail carrying upstream text the gate must never repeat.
    try { validateConnection(parsed); } catch (e) {
      console.error('Connection configuration rejected: ' + e.message);
      process.exitCode = 1;
      return;
    }
    console.error('Connection configuration valid; no remote enrollment performed');
  } else if (mode === 'setup' && args.length >= 3 && args[1] === '--') {
    const dir = setup(args[0], args[2], args.slice(3));
    console.error('Setup created: ' + dir + '\nReview policy.json, then copy the entry from mcp-client.json into your client. All tool calls start blocked.\n' + LOCAL_EDITION_NOTE);
  } else if (mode === 'init' && args.length === 1) {
    writeFileSync(args[0], JSON.stringify(starter, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.error('Created deny-by-default demo policy. Review explicit tool rules before connecting a real server.');
  } else if (mode === 'check' && args.length === 1) {
    validatePolicy(JSON.parse(readFileSync(args[0], 'utf8')));
    console.error('Policy valid');
  } else if (mode === 'report' && args.length === 2) {
    const fd = openSync(args[0], constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile() || fstatSync(fd).size > 16 * 1024 * 1024) throw Error('Invalid audit file');
      const events = readFileSync(fd, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
      const cols = ['time','invocation','status','kind','policy_rule_id','reason','approval_request_id','blocked_calls','verified'];
      const html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>AtlaSent Gate activity</title><style>body{font:16px system-ui;margin:40px;background:#f4f7fa;color:#172b3a}table{border-collapse:collapse;width:100%;background:white}td,th{padding:12px;text-align:left;border-bottom:1px solid #ddd}h1{color:#174b54}</style><h1>AtlaSent Gate</h1><p>Local activity snapshot · No payloads captured · Server returned does not mean independently verified.</p><table><thead><tr>' + cols.map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' + events.map(e => '<tr>' + cols.map(c => '<td>' + escape(e[c] ?? '—') + '</td>').join('') + '</tr>').join('') + '</tbody></table></html>';
      writeFileSync(args[1], html, { flag: 'wx', mode: 0o600 });
      console.error('Created activity snapshot: ' + resolve(args[1]));
    } finally { closeSync(fd); }
  } else if (['run', 'run-dir'].includes(mode) && args.length >= 4 && args[2] === '--') {
    const policy = validatePolicy(JSON.parse(readFileSync(args[0], 'utf8')));
    const auditPath = mode === 'run-dir' ? join(args[1], randomUUID() + '.jsonl') : args[1];
    const fd = openSync(auditPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let bytes = 0;
    const audit = e => {
      const line = Buffer.from(JSON.stringify(e) + '\n');
      if (bytes + line.length > 16 * 1024 * 1024) throw Error('Audit capacity reached');
      let offset = 0;
      while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset);
      bytes += line.length;
    };
    try { await runGate({ policy, command: args[3], args: args.slice(4), audit, authorize }); }
    finally { closeSync(fd); }
  } else {
    console.error('Usage:\n  atlasent-gate setup-connected NEW-directory connection.json -- /absolute/server [args...]\n  atlasent-gate check-connection connection.json\n  atlasent-gate run-connected policy.json connection.json activity-directory -- command [args...]\n  atlasent-gate setup NEW-directory -- /absolute/server [args...]\n  atlasent-gate run-dir policy.json activity-directory -- command [args...]\n  atlasent-gate init policy.json\n  atlasent-gate check policy.json\n  atlasent-gate run policy.json NEW-audit.jsonl -- command [args...]\n  atlasent-gate report audit.jsonl NEW-activity.html');
    process.exitCode = 2;
  }
}
main().catch(() => { console.error('AtlaSent Gate failed closed. Check policy, file paths, and upstream server.'); process.exitCode = 1; });
