// Demonstrates an allowed provider refusal followed by unauthorized detours.
// All paths are synthetic and go through the local MCP Gate. It does not
// demonstrate network containment or cloud organizational authorization.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const gateDir = fileURLToPath(new URL('..', import.meta.url));
const upstream = fileURLToPath(new URL('../../../examples/agent-detour-demo/fake-server.mjs', import.meta.url));
const policy = {
  version: 1,
  default: 'deny',
  rules: [
    { id: 'approved-lookup', tool: 'lookup_entrance', effect: 'allow', kind: 'read',
      argumentsEquals: { place: 'fictional-zoo', source: 'approved-demo' } },
    { id: 'approved-public-fallback', tool: 'lookup_public_reference', effect: 'allow', kind: 'read',
      argumentsEquals: { place: 'fictional-zoo', source: 'public-fixture' } },
  ],
};

test('an agent cannot turn a blocked provider lookup into unapproved tool calls through MCP Gate', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlasent-agent-detour-'));
  const policyFile = join(dir, 'policy.json');
  const auditFile = join(dir, 'audit.jsonl');
  const traceFile = join(dir, 'upstream-trace.txt');
  writeFileSync(policyFile, JSON.stringify(policy));
  const child = spawn(process.execPath,
    ['cli.mjs', 'run', policyFile, auditFile, '--', process.execPath, upstream],
    { cwd: gateDir, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_DETOUR_TRACE_FILE: traceFile } });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const call = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const response = await lines.next();
    assert.equal(response.done, false, 'Gate must answer every request');
    return JSON.parse(response.value);
  };
  try {
    const initialized = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'detour-test', version: '1' } });
    assert.ok(initialized.result.capabilities.tools);

    // The original request is locally authorized, but the synthetic provider refuses it.
    const first = await call(2, 'tools/call', { name: 'lookup_entrance', arguments: { place: 'fictional-zoo', source: 'approved-demo' } });
    assert.equal(first.result.isError, true);
    assert.match(first.result.content[0].text, /Synthetic provider refused/);

    // Retrying with a changed destination is a new request, not an authorization.
    const detours = [
      { name: 'lookup_entrance', arguments: { place: 'fictional-zoo', source: 'unapproved-reader' } },
      { name: 'run_remote_script', arguments: { command: 'UNAPPROVED_SCRIPT' } },
      { name: 'lookup_with_external_key', arguments: { credential: 'UNAPPROVED_CREDENTIAL' } },
      { name: 'post_webhook', arguments: { url: 'https://example.invalid/inbox' } },
    ];
    for (let i = 0; i < detours.length; i++) {
      const denied = await call(i + 3, 'tools/call', detours[i]);
      assert.equal(denied.result.isError, true);
      assert.match(denied.result.content[0].text, /Blocked by AtlaSent Gate/);
    }

    // An explicitly permitted safe fallback still works.
    const last = await call(7, 'tools/call', { name: 'lookup_public_reference', arguments: { place: 'fictional-zoo', source: 'public-fixture' } });
    assert.equal(last.result.isError, undefined);
    assert.match(last.result.content[0].text, /Synthetic published data/);

    const exit = once(child, 'exit');
    child.stdin.end();
    assert.equal((await exit)[0], 0);

    // Test the actual native-tool boundary, not only an advisory decision.
    const dispatched = readFileSync(traceFile, 'utf8').trim().split('\n');
    assert.deepEqual(dispatched, ['lookup_entrance', 'lookup_public_reference']);
    const audit = readFileSync(auditFile, 'utf8');
    const entries = audit.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(entries.filter(e => e.status === 'blocked').length, 4);
    assert.ok(entries.some(e => e.status === 'server_error'));
    assert.ok(entries.some(e => e.status === 'server_returned'));
    assert.doesNotMatch(audit, /UNAPPROVED_SCRIPT|UNAPPROVED_CREDENTIAL|unapproved-reader/);
    assert.ok(entries.filter(e => e.status === 'server_returned').every(e => e.verified === false));

    console.log('PASS: synthetic provider refusal; four detours blocked before upstream; permitted public fallback dispatched; metadata-only evidence.');
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
