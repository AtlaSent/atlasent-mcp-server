import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(new URL('./live-sandbox.mjs', import.meta.url));
test('live acceptance refuses missing key without creating an output directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-live-refusal-'));
  try {
    const env = { ...process.env }; delete env.ATLASENT_GATE_API_KEY;
    writeFileSync(join(root, 'connection.json'), JSON.stringify({ version: 1, apiUrl: 'https://runtime.example/functions/v1',
      actorId: 'test', gateId: 'test', environment: 'sandbox', tools: {
        read_status: { actionType: 'tool.read', targetId: 'demo' }, set_status: { actionType: 'tool.write', targetId: 'demo' },
      } }));
    const result = spawnSync(process.execPath, [script, join(root, 'connection.json'), join(root, 'result')], { env });
    assert.equal(result.status, 1);
    assert.equal(existsSync(join(root, 'result')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('acceptance runner exercises the real stdio Gate with a simulated runtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate live runner #-'));
  try {
    const config = { version: 1, apiUrl: 'https://runtime.example/functions/v1', actorId: 'agent:11111111-1111-4111-8111-111111111111', gateId: 'test', environment: 'sandbox',
      tools: { read_status: { actionType: 'tool.read', targetId: 'demo' }, set_status: { actionType: 'tool.write', targetId: 'demo' } } };
    writeFileSync(join(root, 'connection.json'), JSON.stringify(config));
    writeFileSync(join(root, 'mock.mjs'), `globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/v1-agent-actor-identity')) return Response.json({assertion:{version:'actor_identity.v1',subject:{principal_id:'agent:11111111-1111-4111-8111-111111111111',principal_kind:'agent',role:'agent'},binding:{action_type:body.action_type,tenant_id:'org-simulated',environment:body.environment},signature:'ab'.repeat(64)}});
      if (url.endsWith('/v1-evaluate')) return Response.json({decision:'allow',mode:'live',permit_token:'simulated',execution_payload_hash_accepted:true,execution_hash_expected:body.execution_payload_hash});
      if (url.endsWith('/v1-verify-permit')) return Response.json({valid:true,outcome:'allow',consumed:true,expires_at:new Date(Date.now()+60000).toISOString()});
      throw Error('unexpected URL');
    };`);
    const result = spawnSync(process.execPath, [script, join(root, 'connection.json'), join(root, 'result')], {
      env: { ...process.env, ATLASENT_GATE_API_KEY: 'ask_test_simulated', NODE_OPTIONS: '--import=' + pathToFileURL(join(root, 'mock.mjs')).href },
      timeout: 15000, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, 'result/result.json'), 'utf8')).status, 'passed');
    assert.equal(result.stdout.includes('ask_test_'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
