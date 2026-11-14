// Standalone synthetic connector boundary simulation. No Salesforce/OpenShell network calls.
// Run: node --test examples/salesforce/authority-simulation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const request = Object.freeze({org:'org-demo',workspace:'ws-demo',actor:'agent-demo',action:'salesforce.account.update_payment_terms',target:'001-demo',from:'Net 30',to:'Net 90',environment:'staging',revision:7});
const fixture = () => {
  const records = new Map([['001-demo','Net 30']]);
  const consumed = new Set(), receipts = new Map();
  let calls = 0;
  return {
    records, receipts, get calls(){return calls},
    execute({req,permit,approvals=[],guardUp=true,route='protected'}) {
      if (route !== 'protected') throw new Error('UNPROTECTED_ROUTE');
      if (!guardUp) throw new Error('GUARD_UNAVAILABLE');
      if (approvals.length < 2 || new Set(approvals).size !== 2) throw new Error('HOLD');
      if (!permit || permit.expiresAt <= Date.now() || permit.digest !== digest(req) || permit.revision !== req.revision || permit.org !== req.org) throw new Error('PERMIT_INVALID');
      if (consumed.has(permit.nonce)) throw new Error('PERMIT_REPLAY');
      consumed.add(permit.nonce); // synthetic atomic boundary; production requires durable transactional consumption
      calls++;
      records.set(req.target, req.to);
      const receipt = {id:'synthetic-'+calls, target:req.target, value:records.get(req.target)};
      receipts.set(receipt.id,receipt);
      return receipt;
    },
    verify(receipt,req){ const observed=receipts.get(receipt.id); return Boolean(observed && observed.target===req.target && records.get(req.target)===req.to); }
  };
};
const permitFor=(req)=>({digest:digest(req),revision:req.revision,org:req.org,nonce:'single-use-1',expiresAt:Date.now()+60_000});
test('HOLD after one approval; zero processor effects',()=>{
 const f=fixture();assert.throws(()=>f.execute({req:request,permit:permitFor(request),approvals:['manager']}),/HOLD/);assert.equal(f.calls,0);
});
test('two approvals execute exactly once and effect is independently read back',()=>{
 const f=fixture(),p=permitFor(request);
 const receipt=f.execute({req:request,permit:p,approvals:['manager','controller']});
 assert.equal(f.verify(receipt,request),true);
 assert.throws(()=>f.execute({req:request,permit:p,approvals:['manager','controller']}),/PERMIT_REPLAY/);
 assert.equal(f.calls,1);
});
test('modified payload, stale policy, expired permit and unavailable guard fail closed',()=>{
 for(const mutation of [
  {req:{...request,to:'Net 120'}},
  {req:{...request,revision:8}},
  {permit:{...permitFor(request),expiresAt:0}},
  {guardUp:false}
 ]) {
  const f=fixture();assert.throws(()=>f.execute({req:request,permit:permitFor(request),approvals:['manager','controller'],...mutation}));assert.equal(f.calls,0);
 }
});
test('unprotected route is explicitly rejected by the simulated connector',()=>{
 const f=fixture();assert.throws(()=>f.execute({req:request,permit:permitFor(request),approvals:['manager','controller'],route:'direct'}),/UNPROTECTED_ROUTE/);assert.equal(f.calls,0);
});
test('no evidence of effect without an authoritative processor receipt',()=>{
 const f=fixture();assert.equal(f.verify({id:'agent-claimed-success'},request),false);
});
