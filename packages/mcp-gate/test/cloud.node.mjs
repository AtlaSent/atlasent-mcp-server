import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudAuthorizer, validateConnection } from '../cloud.mjs';
import { runGate } from '../gate.mjs';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const connection = {version:1,apiUrl:'https://runtime.example/functions/v1',actorId:'agent:11111111-1111-4111-8111-111111111111',gateId:'gate-001',environment:'sandbox',tools:{set_status:{actionType:'tool.set_status',targetId:'demo:sandbox'}}};
const params = ()=>({name:'set_status',arguments:{environment:'sandbox',status:'ready'}});
const response = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const verified = ()=>({valid:true,outcome:'allow',consumed:true,expires_at:new Date(Date.now()+60000).toISOString()});
const actorAssertion = (actionType,environment,over={}) => ({
 version:'actor_identity.v1',
 subject:{principal_id:connection.actorId,principal_kind:'agent',role:'agent'},
 binding:{action_type:actionType,tenant_id:'org-fixture',environment},
 signature:'ab'.repeat(64),
 ...over,
});
function transport({evaluate,verify,mint,mintStatus=200}={}) {
 const calls=[],identityCalls=[];
 const fetchImpl=async(url,opts)=>{
   const body=JSON.parse(opts.body);
   if(url.endsWith('/v1-agent-actor-identity')) {
     identityCalls.push({url,body,opts});
     return response(mint ? mint(body) : {assertion:actorAssertion(body.action_type,body.environment)},mintStatus);
   }
   calls.push({url,body,opts});
   return url.endsWith('/v1-evaluate') ? response(evaluate ? evaluate(body) : {decision:'allow',mode:'live',permit_token:'fixture-permit',execution_payload_hash_accepted:true,execution_hash_expected:body.execution_payload_hash}) : response(verify ? verify(body) : verified());
 };
 return {calls,identityCalls,fetchImpl};
}
test('wire: fresh full subject binding and consume before allow; no raw args sent',async()=>{
 const t=transport();const auth=cloudAuthorizer(connection,'ask_test_fixture',t);
 assert.equal((await auth(params())).effect,'allow');assert.equal((await auth(params())).effect,'allow');
 assert.equal(t.calls.length,4);assert.equal(t.identityCalls.length,2);const [a,b,c]=t.calls;
 assert.deepEqual(t.identityCalls[0].body,{action_type:'tool.set_status',environment:'sandbox'});
 assert.match(a.body.execution_payload_hash,/^[a-f0-9]{64}$/);assert.notEqual(a.body.execution_payload_hash,c.body.execution_payload_hash);
 assert.equal(a.body.actor_identity.version,'actor_identity.v1');assert.equal(a.body.actor_identity.subject.principal_id,connection.actorId);assert.equal(a.body.actor_identity.binding.action_type,'tool.set_status');assert.equal(a.body.actor_identity.binding.environment,'sandbox');
 assert.equal(b.body.payload_hash,a.body.execution_payload_hash);assert.equal(b.body.actor_id,connection.actorId);assert.equal(b.body.target_id,'demo:sandbox');assert.equal(b.body.environment,'sandbox');
 assert.equal(a.opts.redirect,'error');assert.equal(a.opts.headers['X-AtlaSent-Key'],'ask_test_fixture');
 assert.ok(!JSON.stringify(a.body).includes('ready'));assert.ok(!('execution_payload_hash' in a.body.context));
});
test('deny, hold and escalate never call verify',async()=>{
 for(const decision of ['deny','hold','escalate','unknown']) {
  const t=transport({evaluate:()=>({decision})});const result=await cloudAuthorizer(connection,'ask_test_fixture',t)(params());
  assert.equal(result.effect,'deny');assert.equal(t.calls.length,1);
 }
});
test('missing permit, binding mismatch, shadow and pending approval block',async()=>{
 for(const override of [{permit_token:null},{execution_payload_hash_accepted:false},{execution_payload_hash_accepted:undefined},{execution_hash_expected:'a'.repeat(64)},{mode:'shadow'},{human_approval_required:true,human_approval_status:'pending'}]) {
  const t=transport({evaluate:b=>({decision:'allow',mode:'live',permit_token:'fixture',execution_payload_hash_accepted:true,execution_hash_expected:b.execution_payload_hash,...override})});
  assert.equal((await cloudAuthorizer(connection,'ask_test_fixture',t)(params())).effect,'deny');assert.equal(t.calls.length,1);
 }
});
test('expired, replayed, unconsumed, contradictory and legacy verification block',async()=>{
 for(const value of [{valid:false,outcome:'deny',code:'REPLAY_DETECTED'},{...verified(),consumed:false},{...verified(),outcome:'deny'},{...verified(),expires_at:'2020-01-01T00:00:00Z'},{...verified(),expires_at:undefined},{verified:true}]) {
  const t=transport({verify:()=>value});assert.equal((await cloudAuthorizer(connection,'ask_test_fixture',t)(params())).effect,'deny');
 }
});
test('bad key, unsafe endpoint, malformed transport and mapping never fall back',async()=>{
 for(const key of ['', 'ask_live_fixture', 'service-role']) assert.throws(()=>cloudAuthorizer(connection,key));
 assert.throws(()=>validateConnection({...connection,apiUrl:'http://runtime.example'}));
 assert.throws(()=>validateConnection({...connection,apiUrl:'https://user:password@runtime.example'}));
 for(const fetchImpl of [async()=>{throw Error('timeout')},async()=>new Response('oops',{status:503}),async()=>new Response('not-json'),async()=>new Response('x'.repeat(1024*1024+1))]) {
  assert.equal((await cloudAuthorizer(connection,'ask_test_fixture',{fetchImpl})(params())).reason,'cloud_actor_identity_unavailable');
 }
 const t=transport();assert.equal((await cloudAuthorizer(connection,'ask_test_fixture',t)({name:'unknown',arguments:{}})).effect,'deny');assert.equal(t.calls.length,0);
});
test('the shipped example is rejected until its placeholders are replaced',async()=>{
 // Reads the real file, so this cannot drift from what we actually ship: unedited,
 // it used to pass every check and `check-connection` printed "valid".
 const example=JSON.parse(await readFile(new URL('../connection.example.json',import.meta.url),'utf8'));
 assert.throws(()=>validateConnection(example),/placeholders/);
 // Each placeholder independently, and case-insensitively — URL lowercases the hostname.
 assert.throws(()=>validateConnection({...connection,apiUrl:'https://YOUR-APPROVED-RUNTIME/functions/v1'}),/placeholders/);
 assert.throws(()=>validateConnection({...connection,apiUrl:'https://your-approved-runtime/functions/v1'}),/placeholders/);
 assert.throws(()=>validateConnection({...connection,actorId:'YOUR-REGISTERED-ACTOR-ID'}),/placeholders/);
 assert.throws(()=>validateConnection({...connection,actorId:'your-registered-actor-id'}),/placeholders/);
 // The action type joined the placeholder set on 2026-09-26. It previously shipped as the
 // concrete slug `tool.set_status`, which exists on ZERO orgs (live read of runtime prod,
 // no Canon template either) while reading exactly like a real action type — so the one
 // value a user was most likely to keep was the one that could never authorize.
 assert.throws(()=>validateConnection({...connection,tools:{set_status:{actionType:'YOUR-PROVISIONED-ACTION-TYPE',targetId:'demo:sandbox'}}}),/placeholders/);
 assert.throws(()=>validateConnection({...connection,tools:{set_status:{actionType:'your-provisioned-action-type',targetId:'demo:sandbox'}}}),/placeholders/);
 // A placeholder in ANY mapping is caught, not just the first: a user who edits one tool
 // and copies a second would otherwise ship the unedited one silently.
 assert.throws(()=>validateConnection({...connection,tools:{real:{actionType:'agent.tool.invoke',targetId:'t'},stale:{actionType:'YOUR-PROVISIONED-ACTION-TYPE',targetId:'t'}}}),/placeholders/);
 // Real action types containing 'your' are untouched — exact literal, never a prefix.
 assert.ok(validateConnection({...connection,tools:{set_status:{actionType:'your-team.deploy',targetId:'demo:sandbox'}}}));
 // A real configuration is untouched: no false positive on an ordinary host or actor.
 assert.equal(validateConnection(connection).actorId,'agent:11111111-1111-4111-8111-111111111111');
 assert.throws(()=>validateConnection({...connection,actorId:'agent-001'}),/agent:<uuid>/);
 assert.throws(()=>validateConnection({...connection,actorId:'your-team-bot'}),/agent:<uuid>/);
 assert.ok(validateConnection({...connection,apiUrl:'https://yourcompany.example/functions/v1'}));
});
test('verified actor mint failures and binding mismatches fail closed before evaluate',async()=>{
 const bad=[
  {mint:()=>({assertion:null}),reason:'cloud_actor_identity_invalid'},
  {mint:b=>({assertion:actorAssertion(b.action_type,b.environment,{version:'actor_identity.v0'})}),reason:'cloud_actor_identity_invalid'},
  {mint:b=>({assertion:{...actorAssertion(b.action_type,b.environment),subject:{principal_id:connection.actorId,principal_kind:'human'}}}),reason:'cloud_actor_identity_invalid'},
  {mint:b=>({assertion:{...actorAssertion(b.action_type,b.environment),subject:{principal_id:'agent:22222222-2222-4222-8222-222222222222',principal_kind:'agent'}}}),reason:'cloud_actor_identity_invalid'},
  {mint:b=>({assertion:{...actorAssertion(b.action_type,b.environment),binding:{action_type:'data.delete',tenant_id:'org-fixture',environment:b.environment}}}),reason:'cloud_actor_identity_invalid'},
  {mint:b=>({assertion:{...actorAssertion(b.action_type,b.environment),binding:{action_type:b.action_type,tenant_id:'org-fixture',environment:'production'}}}),reason:'cloud_actor_identity_invalid'},
  {mint:b=>({assertion:{...actorAssertion(b.action_type,b.environment),signature:''}}),reason:'cloud_actor_identity_invalid'},
 ];
 for(const fixture of bad){
  const t=transport(fixture);const r=await cloudAuthorizer(connection,'ask_test_fixture',t)(params());
  assert.equal(r.reason,fixture.reason);assert.equal(t.calls.length,0);assert.equal(t.identityCalls.length,1);
 }
 for(const mintStatus of [403,404,500]){
  const t=transport({mintStatus});const r=await cloudAuthorizer(connection,'ask_test_fixture',t)(params());
  assert.equal(r.reason,'cloud_actor_identity_unavailable');assert.equal(t.calls.length,0);assert.equal(t.identityCalls.length,1);
 }
});

test('argument mutation during authorization is rejected',async()=>{
 const p=params();const t=transport({verify:()=>{p.arguments.status='tampered';return verified()}});
 assert.equal((await cloudAuthorizer(connection,'ask_test_fixture',t)(p)).reason,'cloud_arguments_changed');
});
test('two gates observe fresh central policy decisions (contract harness, not live service)',async()=>{
 let allow=true;
 const t=transport({evaluate:b=>allow?{decision:'allow',mode:'live',permit_token:'fixture',execution_payload_hash_accepted:true,execution_hash_expected:b.execution_payload_hash}:{decision:'deny'}});
 const a=cloudAuthorizer(connection,'ask_test_fixture',t),b=cloudAuthorizer({...connection,gateId:'gate-002'},'ask_test_fixture',t);
 assert.equal((await a(params())).effect,'allow');assert.equal((await b(params())).effect,'allow');
 allow=false;assert.equal((await a(params())).effect,'deny');assert.equal((await b(params())).effect,'deny');
});
test('real subprocess is not called on cloud hold and runs only after verified consume', {timeout:10000},async()=>{
 let allow=false;
 const t=transport({evaluate:b=>allow?{decision:'allow',mode:'live',permit_token:'fixture',execution_payload_hash_accepted:true,execution_hash_expected:b.execution_payload_hash}:{decision:'hold'}});
 const input=new PassThrough(),output=new PassThrough();const events=[];
 const task=runGate({policy:{version:1,default:'deny',rules:[{id:'demo',tool:'set_status',effect:'allow',kind:'write'}]},command:process.execPath,args:[fileURLToPath(new URL('../demo-server.mjs',import.meta.url))],input,output,audit:e=>events.push(e),authorize:cloudAuthorizer(connection,'ask_test_fixture',t)});
 const lines=createInterface({input:output})[Symbol.asyncIterator]();
 input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:params()})+'\n');
 assert.equal(JSON.parse((await lines.next()).value).result.isError,true);assert.equal(t.calls.length,1);
 allow=true;input.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:params()})+'\n');
 assert.equal(JSON.parse((await lines.next()).value).result.content[0].text,'ready');
 input.end();await task;output.end();
 assert.equal(events.filter(e=>e.status==='server_returned').length,1);assert.ok(!JSON.stringify(events).includes('fixture-permit'));
});

test('approval waiting does not consume the upstream response timeout', {timeout:10000}, async()=>{
 const input=new PassThrough(),output=new PassThrough(),events=[];
 const upstream="require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'ready'}]}})+'\\n'),30);});";
 const realNow=Date.now;let fakeNow=0;Date.now=()=>fakeNow;
 try {
  const task=runGate({policy:{version:1,default:'deny',rules:[{id:'demo',tool:'set_status',kind:'write',effect:'allow'}]},command:process.execPath,args:['-e',upstream],input,output,audit:e=>events.push(e),timeoutMs:10,authorize:async()=>{await new Promise(r=>setTimeout(r,20));fakeNow=1000;return {effect:'allow',reason:'cloud_permit_consumed'}}});
  const lines=createInterface({input:output})[Symbol.asyncIterator]();
  input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:params()})+'\n');
  assert.equal(JSON.parse((await lines.next()).value).result.content[0].text,'ready');
  input.end();await task;output.end();
  assert.equal(events.find(e=>e.status==='allowed').policy_rule_id,'demo');
  assert.equal(events.find(e=>e.status==='allowed').reason,'cloud_permit_consumed');
  assert.equal(events.find(e=>e.status==='server_returned').policy_rule_id,'demo');
 } finally { Date.now=realNow; input.destroy(); output.end(); }
});

test('outcome_unknown retains matched rule attribution', {timeout:10000}, async()=>{
 const input=new PassThrough(),output=new PassThrough(),events=[];
 const task=runGate({policy:{version:1,default:'deny',rules:[{id:'demo',tool:'set_status',kind:'write',effect:'allow'}]},command:process.execPath,args:['-e','process.stdin.resume()'],input,output,audit:e=>events.push(e),timeoutMs:10,authorize:async()=>({effect:'allow',reason:'cloud_permit_consumed'})});
 input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:params()})+'\n');
 await assert.rejects(task,/Gate stopped safely/);output.end();
 const unknown=events.find(e=>e.status==='outcome_unknown');
 assert.equal(unknown.policy_rule_id,'demo');assert.equal(unknown.kind,'write');
});

test('disconnect while awaiting cloud cannot dispatch an allowed write', {timeout:10000},async()=>{
 const input=new PassThrough(),output=new PassThrough();let resolveAuth,entered;
 const started=new Promise(r=>entered=r);const events=[];
 const task=runGate({policy:{version:1,default:'deny',rules:[{id:'demo',tool:'set_status',effect:'allow',kind:'write'}]},command:process.execPath,args:[fileURLToPath(new URL('../demo-server.mjs',import.meta.url))],input,output,audit:e=>events.push(e),authorize:()=>{entered();return new Promise(r=>resolveAuth=r)}});
 input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:params()})+'\n');
 await started;input.destroy();await task;resolveAuth({effect:'allow',reason:'fixture'});
 await new Promise(r=>setImmediate(r));assert.equal(events.length,0);output.end();
});

test('Gate key is removed from child environment', {timeout:10000},async()=>{
 const input=new PassThrough(),output=new PassThrough();
 const original=process.env.ATLASENT_GATE_API_KEY;process.env.ATLASENT_GATE_API_KEY='ask_test_secret';
 let task;
 try {
  task=runGate({policy:{version:1,default:'deny',rules:[]},command:process.execPath,args:['-e',`process.stdin.once('data',()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{inherited:!!process.env.ATLASENT_GATE_API_KEY}})+'\\n'))`],input,output,audit:()=>{}});
  const lines=createInterface({input:output})[Symbol.asyncIterator]();input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})+'\n');
  assert.equal(JSON.parse((await lines.next()).value).result.inherited,false);input.end();await task;
 } finally {input.destroy();output.end();if(original===undefined) delete process.env.ATLASENT_GATE_API_KEY;else process.env.ATLASENT_GATE_API_KEY=original;}
});

test('connected setup generates explicit mode without storing credentials',async()=>{
 const {setup}=await import('../setup.mjs');
 const {mkdtempSync,readFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'gate-connected-'));
 try {
  const dir=setup(join(root,'new'),process.execPath,[],connection);
  const c=JSON.parse(readFileSync(join(dir,'mcp-client.json'),'utf8')).mcpServers['atlasent-gate'];
  assert.equal(c.args[1],'run-connected');assert.ok(c.args.includes(join(dir,'connection.json')));
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'connection.json'),'utf8')),connection);
  assert.ok(!JSON.stringify(c).includes('ask_test_'));
 } finally {rmSync(root,{recursive:true,force:true});}
});

const approvalId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const waiting={...connection,approvalWaitMs:5000,approvalsUrl:'https://runtime.example/v1/approvals'};
function approvalTransport({row,claim,verification,hold,mint,mintStatus=200}={}) {
 const calls=[],identityCalls=[];let polls=0;
 return {calls,identityCalls, sleepImpl:async()=>{}, fetchImpl:async(url,opts)=>{
  const body=opts.body ? JSON.parse(opts.body) : undefined;
  if(url.endsWith('/v1-agent-actor-identity')) {
   identityCalls.push({url,body,method:opts.method});
   return response(mint ? mint(body) : {assertion:actorAssertion(body.action_type,body.environment)},mintStatus);
  }
  calls.push({url,body,method:opts.method});
  if(url.endsWith('/v1-evaluate')) return response(hold??{decision:'hold',mode:'live',approval_request_id:approvalId});
  if(url.endsWith('/claim-permit')) return response(claim??{claimed:true,re_evaluation_decision:'allow',permit_token:'fresh-approval-permit'});
  if(url.endsWith('/v1-verify-permit')) return response(verification??verified());
  polls++;return response(row??{id:approvalId,status:polls===1?'pending':'approved_awaiting_claim',claim_environment:'sandbox'});
 }};
}
test('approval resumes original invocation: poll, claim once, verify exact original digest',async()=>{
 const t=approvalTransport();const pending=[];const auth=cloudAuthorizer(waiting,'ask_test_fixture',t);
 assert.equal((await auth(params(),{onPending:id=>pending.push(id)})).effect,'allow');
 assert.deepEqual(pending,[approvalId]);assert.deepEqual(t.calls.map(c=>c.method),['POST','GET','GET','POST','POST']);
 assert.equal(t.identityCalls.length,2);assert.deepEqual(t.identityCalls.map(c=>c.body),[{action_type:'tool.set_status',environment:'sandbox'},{action_type:'tool.set_status',environment:'sandbox'}]);
 const first=t.calls[0],claimCall=t.calls.find(c=>c.url.endsWith('/claim-permit')),last=t.calls.at(-1);assert.equal(last.body.payload_hash,first.body.execution_payload_hash);
 assert.equal(claimCall.body.actor_identity.subject.principal_id,connection.actorId);assert.equal(claimCall.body.actor_identity.binding.environment,'sandbox');
 assert.equal(last.body.permit_token,'fresh-approval-permit');assert.equal(last.body.target_id,'demo:sandbox');
 assert.equal(t.calls.filter(c=>c.url.endsWith('/v1-evaluate')).length,1);
});
test('approval denial, wrong row, nonallow reevaluation, missing claim or bad verify cannot execute',async()=>{
 for(const fixture of [
  {row:{id:approvalId,status:'denied'}},
  {row:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',status:'approved_awaiting_claim',claim_environment:'sandbox'}},
  {row:{id:approvalId,status:'approved'}},
  {row:{id:approvalId,status:'approved_awaiting_claim',claim_environment:'production'}},
  {claim:{claimed:false,re_evaluation_decision:'allow'}},
  {claim:{claimed:true,re_evaluation_decision:'deny',permit_token:'bad'}},
  {verification:{valid:false,outcome:'deny',consumed:false}},
  {hold:{decision:'hold',mode:'shadow',approval_request_id:approvalId}},
  {hold:{decision:'hold',mode:'live',approval_request_id:'../resolve'}}
 ]) {
  const t=approvalTransport(fixture);assert.equal((await cloudAuthorizer(waiting,'ask_test_fixture',t)(params())).effect,'deny');
  assert.ok(t.calls.filter(c=>c.url.endsWith('/claim-permit')).length<=1);
  assert.ok(!t.calls.some(c=>c.url.endsWith('/resolve')));
 }
});
test('approval claim requires a fresh valid actor identity, not only the initial evaluation identity',async()=>{
 let mints=0;
 const t=approvalTransport({mint:b=>{
  mints+=1;
  return mints===1
   ? {assertion:actorAssertion(b.action_type,b.environment)}
   : {assertion:{...actorAssertion(b.action_type,b.environment),subject:{principal_id:'agent:22222222-2222-4222-8222-222222222222',principal_kind:'agent'}}};
 }});
 const r=await cloudAuthorizer(waiting,'ask_test_fixture',t)(params());
 assert.equal(r.reason,'cloud_actor_identity_invalid');
 assert.equal(t.identityCalls.length,2);
 assert.equal(t.calls.filter(c=>c.url.endsWith('/claim-permit')).length,0);
});

test('approval timeout and cancellation never claim a permit',async()=>{
 const t=approvalTransport({row:{id:approvalId,status:'pending'}});
 t.sleepImpl=async()=>{await new Promise(r=>setTimeout(r,10))};
 assert.equal((await cloudAuthorizer({...waiting,approvalWaitMs:1},'ask_test_fixture',t)(params())).reason,'cloud_approval_timeout');
 assert.ok(!t.calls.some(c=>c.url.endsWith('/claim-permit')));
 const controller=new AbortController();const t2=approvalTransport();
 t2.sleepImpl=async()=>{controller.abort()};
 assert.equal((await cloudAuthorizer(waiting,'ask_test_fixture',t2)(params(),{signal:controller.signal})).effect,'deny');
 assert.ok(!t2.calls.some(c=>c.url.endsWith('/claim-permit')));
});
test('approval endpoint cannot redirect credentials to another origin or arbitrary path',()=>{
 for(const url of ['https://other.example/v1/approvals','https://runtime.example/arbitrary','https://user:pass@runtime.example/v1/approvals']) assert.throws(()=>validateConnection({...waiting,approvalsUrl:url}));
 assert.throws(()=>validateConnection({...waiting,approvalWaitMs:120001}));
});

test('held subprocess call resumes once and logs its approval reference', {timeout:10000},async()=>{
 const t=approvalTransport();const input=new PassThrough(),output=new PassThrough(),events=[];
 const task=runGate({policy:{version:1,default:'deny',rules:[{id:'demo',tool:'set_status',kind:'write',effect:'allow'}]},command:process.execPath,args:[fileURLToPath(new URL('../demo-server.mjs',import.meta.url))],input,output,audit:e=>events.push(e),authorize:cloudAuthorizer(waiting,'ask_test_fixture',t)});
 const lines=createInterface({input:output})[Symbol.asyncIterator]();
 input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:params()})+'\n');
 assert.equal(JSON.parse((await lines.next()).value).result.content[0].text,'ready');
 input.end();await task;output.end();
 assert.equal(events.filter(e=>e.status==='awaiting_approval')[0].approval_request_id,approvalId);
 assert.equal(events.filter(e=>e.status==='awaiting_approval')[0].policy_rule_id,'demo');
 assert.equal(events.filter(e=>e.status==='server_returned').length,1);
 assert.equal(t.calls.filter(c=>c.url.endsWith('/claim-permit')).length,1);
});
