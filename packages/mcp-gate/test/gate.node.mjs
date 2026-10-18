import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { validatePolicy, decide, frames } from '../gate.mjs';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const policy = { version: 1, default: 'deny', rules: [{id:'sandbox-write',tool:'set_status',kind:'write',effect:'allow',argumentsEquals:{environment:'sandbox',status:'ready'}},{id:'read',tool:'read_status',kind:'read',effect:'allow'}] };

test('exact full arguments required; unknown tools and deny precedence', () => {
  validatePolicy(policy);
  assert.equal(decide(policy,{name:'set_status',arguments:{status:'ready',environment:'sandbox'}}).effect,'allow');
  for (const args of [{environment:'production',status:'ready'},{environment:'sandbox',status:'ready',extra:true}]) assert.equal(decide(policy,{name:'set_status',arguments:args}).effect,'deny');
  assert.equal(decide(policy,{name:'unknown',arguments:{}}).effect,'deny');
  assert.equal(decide(policy,{name:'unknown',arguments:{}}).policy_rule_id,undefined);
  assert.equal(decide({...policy,rules:[...policy.rules,{id:'stop',tool:'set_status',kind:'write',effect:'deny'}]},{name:'set_status',arguments:{environment:'sandbox',status:'ready'}}).effect,'deny');
});
test('policy typos and unsafe defaults fail closed', () => {
  for (const p of [{...policy,default:'allow'},{...policy,rules:[{...policy.rules[0],argumentEquals:{}}]},{...policy,rules:[policy.rules[0],policy.rules[0]]}]) assert.throws(()=>validatePolicy(p));
});
test('denial budget is optional, bounded and typo-proof', () => {
  validatePolicy({...policy,denialBudget:{maxBlockedCalls:3}});
  for (const b of [0,-1,1.5,10001,'3',null]) assert.throws(()=>validatePolicy({...policy,denialBudget:{maxBlockedCalls:b}}));
  for (const d of [{},{maxBlockedCalls:3,reset:true},{maxBlockedCall:3},[3],3]) assert.throws(()=>validatePolicy({...policy,denialBudget:d}));
});
test('bounded framing rejects oversized and truncated messages', async () => {
  for (const body of ['x'.repeat(1024*1024+1),'{"jsonrpc":"2.0"}']) await assert.rejects(async()=>{for await (const m of frames(Readable.from([body]))) void m;});
});
test('real proxy blocks production write, permits sandbox, records no payloads, renders report', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(),'atlasent-gate-'));
  const config = join(dir,'policy.json'), audit = join(dir,'audit.jsonl');
  writeFileSync(config,JSON.stringify(policy));
  const child=spawn(process.execPath,['cli.mjs','run',config,audit,'--',process.execPath,'demo-server.mjs'],{cwd,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const call=async(id,method,params)=>{child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return JSON.parse((await lines.next()).value);};
  try {
    assert.ok((await call(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}})).result.capabilities.tools);
    assert.equal((await call(2,'tools/call',{name:'set_status',arguments:{environment:'production',status:'SECRET_VALUE'}})).result.isError,true);
    assert.equal((await call(3,'tools/call',{name:'read_status',arguments:{}})).result.content[0].text,'pending');
    assert.equal((await call(4,'tools/call',{name:'set_status',arguments:{environment:'sandbox',status:'ready'}})).result.content[0].text,'ready');
    assert.equal((await call(5,'tools/call',{name:'read_status',arguments:{}})).result.content[0].text,'ready');
    assert.equal((await call(6,'resources/read',{uri:'file:///secrets'})).error.code,-32601);
    const exit=once(child,'exit'); child.stdin.end(); assert.equal((await exit)[0],0);
    const text=readFileSync(audit,'utf8'); assert.ok(!text.includes('SECRET_VALUE')); assert.ok(!text.includes('production')); assert.ok(text.includes('blocked')); assert.ok(text.includes('server_returned')); assert.ok(text.includes('"verified":false'));
    const report=spawn(process.execPath,['cli.mjs','report',audit,join(dir,'activity.html')],{cwd}); assert.equal((await once(report,'exit'))[0],0); const html=readFileSync(join(dir,'activity.html'),'utf8'); assert.match(html,/Local activity snapshot/); assert.match(html,/policy_rule_id/); assert.match(html,/sandbox-write/);
  } finally {child.kill();rmSync(dir,{recursive:true,force:true});}
});

test('missing upstream exits nonzero without leaking spawn details', {timeout:10000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'atlasent-gate-'));
  try {
    writeFileSync(join(dir,'policy.json'),JSON.stringify(policy));
    const c=spawn(process.execPath,['cli.mjs','run',join(dir,'policy.json'),join(dir,'audit.jsonl'),'--','/missing/SECRET_EXECUTABLE'],{cwd});
    let stderr='';c.stderr.on('data',x=>stderr+=x);
    assert.equal((await once(c,'exit'))[0],1);assert.ok(!stderr.includes('SECRET_EXECUTABLE'));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('existing audit file prevents upstream startup', {timeout:10000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'atlasent-gate-'));
  try {
    writeFileSync(join(dir,'policy.json'),JSON.stringify(policy));writeFileSync(join(dir,'audit.jsonl'),'preserve');
    const c=spawn(process.execPath,['cli.mjs','run',join(dir,'policy.json'),join(dir,'audit.jsonl'),'--',process.execPath,'-e',"require('fs').writeFileSync(process.argv[1],'ran')",join(dir,'marker')],{cwd});
    assert.equal((await once(c,'exit'))[0],1);assert.equal(readFileSync(join(dir,'audit.jsonl'),'utf8'),'preserve');
    assert.throws(()=>readFileSync(join(dir,'marker')));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('activity viewer escapes injected markup', {timeout:10000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'atlasent-gate-'));
  try {
    writeFileSync(join(dir,'audit.jsonl'),JSON.stringify({reason:'<script>alert(1)</script>'})+'\n');
    const c=spawn(process.execPath,['cli.mjs','report',join(dir,'audit.jsonl'),join(dir,'report.html')],{cwd});
    assert.equal((await once(c,'exit'))[0],0);
    const html=readFileSync(join(dir,'report.html'),'utf8');assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('unexpected upstream exit is fatal for nonzero and zero exits', {timeout:10000},async()=>{
  for (const code of [0,3]) {
    const dir=mkdtempSync(join(tmpdir(),'atlasent-gate-'));
    try {
      writeFileSync(join(dir,'policy.json'),JSON.stringify(policy));
      const c=spawn(process.execPath,['cli.mjs','run',join(dir,'policy.json'),join(dir,'audit.jsonl'),'--',process.execPath,'-e',`process.exit(${code})`],{cwd});
      assert.equal((await once(c,'exit'))[0],1);
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
});

test('setup is deny-by-default, generates absolute config and survives two client restarts', {timeout:10000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'atlasent-gate-'));
  try {
    const target=join(dir,'setup');
    const setup=spawn(process.execPath,['cli.mjs','setup',target,'--','node',join(cwd,'demo-server.mjs')],{cwd});
    assert.equal((await once(setup,'exit'))[0],0);
    const config=JSON.parse(readFileSync(join(target,'mcp-client.json'),'utf8')).mcpServers['atlasent-gate'];
    assert.equal(JSON.parse(readFileSync(join(target,'policy.json'),'utf8')).rules.length,0);
    const again=spawn(process.execPath,['cli.mjs','setup',target,'--','node',join(cwd,'demo-server.mjs')],{cwd});
    assert.equal((await once(again,'exit'))[0],1);
    for(let i=0;i<2;i++) {
      const c=spawn(config.command,config.args,{cwd:tmpdir()});
      const lines=createInterface({input:c.stdout})[Symbol.asyncIterator]();
      c.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_status',arguments:{}}})+'\n');
      assert.equal(JSON.parse((await lines.next()).value).result.isError,true);
      const exit=once(c,'exit');c.stdin.end();assert.equal((await exit)[0],0);
    }
    const {readdirSync}=await import('node:fs');assert.equal(readdirSync(join(target,'activity')).length,2);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('local setup names the free edition with an attributed link, and promises nothing more', {timeout:10000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'atlasent-gate-'));
  try {
    const c=spawn(process.execPath,['cli.mjs','setup',join(dir,'setup'),'--','node',join(cwd,'demo-server.mjs')],{cwd});
    let stderr='';c.stderr.on('data',x=>stderr+=x);
    assert.equal((await once(c,'exit'))[0],0);
    assert.match(stderr,/free local edition \(AtlaSent Community plan\): https:\/\/www\.atlasent\.io\/pricing\?utm_source=mcp-gate&utm_medium=cli\n?$/);
    assert.doesNotMatch(stderr,/approval|retained evidence|enforce/i);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
