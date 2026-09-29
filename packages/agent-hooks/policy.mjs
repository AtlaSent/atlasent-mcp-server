import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { RULE_IDS, EFFECTS } from './rules.mjs';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const ID = /^[A-Za-z0-9_.-]{1,64}$/;

// Config file, all fields optional:
// {
//   "version": 1,
//   "rules": { "deploy.release": "deny", "git.discard-work": "allow" },
//   "custom": [{ "id": "my.prod-db", "pattern": "psql .*prod", "effect": "ask", "description": "..." }],
//   "unattended": "deny",       // what an "ask" becomes when no human can answer
//   "connected": { "environment": "production", "preview": "redacted" }
//                               // used only when an AtlaSent key is configured
// }
export const ENVIRONMENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export function validatePolicy(p) {
  if (!object(p) || p.version !== 1) throw Error('config: "version": 1 is required');
  for (const k of Object.keys(p)) if (!['version', 'rules', 'custom', 'unattended', 'connected', '$comment'].includes(k)) throw Error(`config: unknown field "${k}"`);
  const rules = p.rules ?? {};
  if (!object(rules)) throw Error('config: "rules" must be an object');
  for (const [id, e] of Object.entries(rules)) {
    if (!RULE_IDS.includes(id)) throw Error(`config: unknown rule "${id}"`);
    if (!EFFECTS.includes(e)) throw Error(`config: rule "${id}" effect must be allow, ask or deny`);
  }
  const custom = p.custom ?? [];
  if (!Array.isArray(custom)) throw Error('config: "custom" must be an array');
  const seen = new Set(RULE_IDS);
  const compiled = custom.map(c => {
    if (!object(c) || !ID.test(c.id ?? '') || seen.has(c.id)) throw Error('config: each custom rule needs a unique id');
    for (const k of Object.keys(c)) if (!['id', 'pattern', 'flags', 'effect', 'description', 'tool'].includes(k)) throw Error(`config: custom rule "${c.id}" has unknown field "${k}"`);
    if (!EFFECTS.includes(c.effect)) throw Error(`config: custom rule "${c.id}" effect must be allow, ask or deny`);
    if (typeof c.pattern !== 'string' || !c.pattern || c.pattern.length > 512) throw Error(`config: custom rule "${c.id}" needs a pattern`);
    if (c.flags !== undefined && !/^[imsu]{0,4}$/.test(c.flags)) throw Error(`config: custom rule "${c.id}" flags may only use i, m, s, u`);
    seen.add(c.id);
    return { id: c.id, effect: c.effect, description: typeof c.description === 'string' ? c.description : c.id, tool: c.tool === true, regex: new RegExp(c.pattern, c.flags ?? '') };
  });
  const unattended = p.unattended ?? 'deny';
  if (!['deny', 'ask'].includes(unattended)) throw Error('config: "unattended" must be deny or ask');
  const c = p.connected ?? {};
  if (!object(c)) throw Error('config: "connected" must be an object');
  for (const k of Object.keys(c)) if (!['environment', 'preview'].includes(k)) throw Error(`config: connected has unknown field "${k}"`);
  if (c.environment !== undefined && (typeof c.environment !== 'string' || !ENVIRONMENT_NAME.test(c.environment))) throw Error('config: connected.environment must be a short lowercase name such as "production"');
  if (c.preview !== undefined && !['redacted', 'off'].includes(c.preview)) throw Error('config: connected.preview must be redacted or off');
  const connected = { ...(c.environment !== undefined && { environment: c.environment }), ...(c.preview !== undefined && { preview: c.preview }) };
  return { rules, custom: compiled, unattended, connected };
}

export const DEFAULT_POLICY = Object.freeze({ rules: {}, custom: [], unattended: 'deny', connected: {} });

// User-level config first, project-level second; project settings win per rule, except
// that a project can never make a rule LESS strict than the user set it. An agent that
// can write to the repository must not be able to switch the user's protection off.
const RANK = { allow: 0, ask: 1, deny: 2 };
export function mergePolicies(user, project) {
  const rules = { ...user.rules };
  for (const [id, e] of Object.entries(project.rules)) if (!(id in rules) || RANK[e] >= RANK[rules[id]]) rules[id] = e;
  const custom = [...user.custom, ...project.custom.filter(c => !user.custom.some(u => u.id === c.id))];
  const unattended = user.unattended === 'deny' || project.unattended === 'deny' ? 'deny' : 'ask';
  // Which environment's policy governs is the user's choice only: a repository the agent
  // can write to must not be able to route its actions to a laxer environment. A
  // repository may only make the preview stricter (turn it off).
  const uc = user.connected ?? {}; const pc = project.connected ?? {};
  const connected = {
    ...(uc.environment !== undefined && { environment: uc.environment }),
    preview: uc.preview === 'off' || pc.preview === 'off' ? 'off' : 'redacted',
  };
  return { rules, custom, unattended, connected };
}

export function configPaths(cwd, env = process.env) {
  const home = env.ATLASENT_HOOKS_HOME ?? join(homedir(), '.atlasent');
  const user = join(home, 'hooks.json');
  return { user, project: cwd ? findProjectConfig(cwd, user) : null };
}

// Nearest `.atlasent/hooks.json` at or above the working directory, so a session started
// in `repo/packages/app` still honours `repo/.atlasent/hooks.json`. The user-level file is
// never also read as a project file.
function findProjectConfig(cwd, userFile) {
  let dir = resolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    const candidate = join(dir, '.atlasent', 'hooks.json');
    if (candidate !== userFile && existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Throws on an unreadable or invalid file: the caller fails closed.
export function loadPolicy(cwd, env = process.env) {
  const { user, project } = configPaths(cwd, env);
  const read = f => (f && existsSync(f)) ? validatePolicy(JSON.parse(readFileSync(f, 'utf8'))) : DEFAULT_POLICY;
  return mergePolicies(read(user), read(project));
}
