import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const nameOK = x => typeof x === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(x);
const idOK = x => typeof x === 'string' || (typeof x === 'number' && Number.isSafeInteger(x));
const key = x => JSON.stringify(x);
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
export function validatePolicy(p) {
  if (!object(p) || p.version !== 1 || p.default !== 'deny' || !Array.isArray(p.rules) || Object.keys(p).some(k => !['version','default','rules','denialBudget'].includes(k))) throw Error('Invalid policy');
  // Optional session-wide stop: after this many blocked tool calls, from any
  // tool, every further call is blocked. Only a restart resets it.
  if ('denialBudget' in p && (!object(p.denialBudget) || Object.keys(p.denialBudget).some(k => k !== 'maxBlockedCalls') || !Number.isSafeInteger(p.denialBudget.maxBlockedCalls) || p.denialBudget.maxBlockedCalls < 1 || p.denialBudget.maxBlockedCalls > 10000)) throw Error('Invalid denial budget');
  const ids = new Set();
  for (const r of p.rules) {
    if (!object(r) || !nameOK(r.id) || ids.has(r.id) || !nameOK(r.tool) || !['allow','deny'].includes(r.effect) || !['read','write','delete','export'].includes(r.kind) || Object.keys(r).some(k => !['id','tool','effect','kind','argumentsEquals'].includes(k)) || ('argumentsEquals' in r && !object(r.argumentsEquals))) throw Error('Invalid policy rule');
    ids.add(r.id);
  }
  return p;
}
export function decide(p, params) {
  if (!object(params) || !nameOK(params.name) || ('arguments' in params && !object(params.arguments)) || ('_meta' in params && !object(params._meta)) || Object.keys(params).some(k => !['name','arguments','_meta'].includes(k))) return { effect: 'deny', reason: 'invalid_arguments', kind: 'unclassified' };
  const matches = p.rules.filter(r => r.tool === params.name && (!('argumentsEquals' in r) || isDeepStrictEqual(r.argumentsEquals, params.arguments ?? {})));
  const rule = matches.find(r => r.effect === 'deny') ?? matches.find(r => r.effect === 'allow');
  return rule ? { effect: rule.effect, reason: rule.id, kind: rule.kind, policy_rule_id: rule.id } : { effect: 'deny', reason: 'no_matching_rule', kind: 'unclassified' };
}
export async function* frames(stream) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let end;
    while ((end = buffer.indexOf(10)) !== -1) {
      if (end > 1024 * 1024) throw Error('Frame too large');
      const line = buffer.subarray(0, end).toString('utf8');
      buffer = buffer.subarray(end + 1);
      if (line.trim()) yield JSON.parse(line);
    }
    if (buffer.length > 1024 * 1024) throw Error('Frame too large');
  }
  if (buffer.length) throw Error('Incomplete frame');
}
async function send(stream, msg) {
  if (!stream.write(JSON.stringify(msg) + '\n')) await once(stream, 'drain');
}
// This gate intentionally exposes only MCP initialization, ping and tools.
// Resources, prompts, sampling, elicitation and extension methods fail closed.
export async function runGate({ policy, command, args = [], input = process.stdin, output = process.stdout, audit, authorize, timeoutMs = 30000 }) {
  validatePolicy(policy);
  const session = randomUUID();
  const pending = new Map();
  const maxBlocked = policy.denialBudget?.maxBlockedCalls;
  let blockedCalls = 0;
  let budgetExhausted = false;
  const childEnv = { ...process.env };
  delete childEnv.ATLASENT_GATE_API_KEY;
  const child = spawn(command, args, { stdio: ['pipe','pipe','pipe'], shell: false, env: childEnv });
  // Child stderr can contain credentials; discard rather than capture or relay it.
  child.stderr.resume();
  const cancellation = new AbortController();
  let fatal;
  let clientClosed = false;
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  const fail = () => { fatal = true; cancellation.abort(); stop(); };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  output.on('error', fail);
  const log = event => audit({ time: new Date().toISOString(), session, ...event });
  const onInputEnd = () => { clientClosed = true; cancellation.abort(); stop(); };
  input.on('end', onInputEnd);
  input.on('close', onInputEnd);
  const onExit = () => { if (!clientClosed) fatal = true; stop(); };
  child.on('exit', onExit);
  const onSignal = () => { fatal = true; stop(); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const timer = setInterval(() => {
    if ([...pending.values()].some(p => Date.now() - p.started > timeoutMs)) fail();
  }, Math.min(timeoutMs, 1000));
  const clientTask = (async () => {
    for await (const msg of frames(input)) {
      if (!object(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') throw Error('Invalid request');
      if (!('id' in msg)) {
        if (msg.method === 'notifications/initialized') await send(child.stdin, { jsonrpc: '2.0', method: msg.method });
        continue;
      }
      if (!idOK(msg.id) || pending.has(key(msg.id)) || pending.size >= 128) throw Error('Invalid or duplicate id');
      if (!['initialize','ping','tools/list','tools/call'].includes(msg.method)) {
        log({ status: 'blocked', reason: 'unsupported_method' });
        await send(output, error(msg.id, -32601, 'Method not exposed by AtlaSent Gate'));
        continue;
      }
      const invocation = randomUUID();
      const item = { started: Date.now(), invocation, method: msg.method };
      if (msg.method === 'tools/call') {
        // A spent budget refuses before policy or cloud authorization runs: an
        // agent that keeps changing tool, target or credential after refusals
        // is stopped, not re-evaluated until something matches.
        if (budgetExhausted) {
          log({ invocation, status: 'blocked', kind: 'unclassified', reason: 'denial_budget_exhausted' });
          await send(output, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'Blocked by AtlaSent Gate: denial_budget_exhausted' }] } });
          continue;
        }
        let decision = decide(policy, msg.params);
        const policyRuleId = decision.policy_rule_id;
        // MCP request metadata is not tool input or authorization context.
        // Consume it at this boundary: never pass unbound metadata to either
        // the organizational authorizer or upstream tool server.
        if (decision.effect === 'allow') {
          msg.params = { name: msg.params.name, arguments: msg.params.arguments ?? {} };
        }
        if (decision.effect === 'allow' && authorize) {
          const cloud = await authorize(msg.params, { signal: cancellation.signal, onPending: id => log({ invocation, status: 'awaiting_approval', policy_rule_id: policyRuleId, approval_request_id: id }) });
          if (!cloud || !['allow','deny'].includes(cloud.effect)) throw Error('Invalid authorization result');
          decision = { ...decision, ...cloud };
          if (fatal || clientClosed) return;
        }
        // No argument, result, error-text, request-id, or unknown tool-name capture.
        item.kind = decision.kind;
        item.policyRuleId = policyRuleId;
        log({ invocation, status: decision.effect === 'allow' ? 'allowed' : 'blocked', kind: decision.kind, reason: decision.reason, policy_rule_id: policyRuleId });
        if (decision.effect !== 'allow') {
          blockedCalls++;
          if (maxBlocked !== undefined && blockedCalls >= maxBlocked) {
            budgetExhausted = true;
            log({ status: 'budget_exhausted', reason: 'denial_budget_exhausted', blocked_calls: blockedCalls });
          }
          await send(output, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'Blocked by AtlaSent Gate: ' + decision.reason }] } });
          continue;
        }
      }
      // Authorization may wait for human approval; upstream timeout starts only
      // when the verified request is actually dispatched to the tool server.
      item.started = Date.now();
      pending.set(key(msg.id), item);
      await send(child.stdin, msg);
    }
    clientClosed = true;
    stop();
  })().catch(fail);
  const serverTask = (async () => {
    for await (const msg of frames(child.stdout)) {
      if (!object(msg) || msg.jsonrpc !== '2.0') throw Error('Invalid upstream response');
      if ('method' in msg) {
        if ('id' in msg && idOK(msg.id)) await send(child.stdin, error(msg.id, -32601, 'Server-initiated requests are not exposed'));
        else if (msg.method === 'notifications/tools/list_changed') await send(output, { jsonrpc: '2.0', method: msg.method });
        continue;
      }
      const item = pending.get(key(msg.id));
      if (!item || (('result' in msg) === ('error' in msg))) throw Error('Unmatched upstream response');
      pending.delete(key(msg.id));
      if (item.method === 'initialize' && object(msg.result)) {
        msg.result.capabilities = msg.result.capabilities?.tools ? { tools: msg.result.capabilities.tools } : {};
      }
      if (item.method === 'tools/call') log({ invocation: item.invocation, kind: item.kind, policy_rule_id: item.policyRuleId, status: msg.error || msg.result?.isError ? 'server_error' : 'server_returned', verified: false });
      await send(output, msg);
    }
    if (!clientClosed) fatal = true;
    stop();
  })().catch(fail);
  await stopped;
  cancellation.abort();
  clearInterval(timer);
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  output.off('error', fail);
  input.off('end', onInputEnd);
  input.off('close', onInputEnd);
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
  killTimer.unref();
  child.stdin.destroy();
  input.destroy();
  for (const item of pending.values()) if (item.method === 'tools/call') log({ invocation: item.invocation, kind: item.kind, policy_rule_id: item.policyRuleId, status: 'outcome_unknown', verified: false });
  // Tasks have catch handlers; destroying input/child ends their iterators.
  void clientTask; void serverTask;
  if (fatal) throw Error('Gate stopped safely; inspect configuration or upstream server');
}
