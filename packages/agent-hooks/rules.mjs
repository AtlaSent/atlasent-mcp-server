// Destructive-action rules for AI coding agents.
//
// This is a tripwire, not a sandbox. It reads the command an agent is ABOUT to run and
// flags the ones that destroy or ship things: deleting a production database, wiping a
// volume, force-pushing, `terraform destroy`, a production deploy. Everything else passes
// through untouched, because a gate that interrupts `ls` gets uninstalled.
//
// It cannot see through an agent that writes a script and runs the script, base64-decodes
// a payload, or uses credentials outside the agent. See README "What this does not do".

const EFFECTS = ['allow', 'ask', 'deny'];

// ---------------------------------------------------------------------------
// Minimal shell splitting. Good enough to find argv[0] and flags per segment;
// deliberately not a full POSIX parser. Anything it cannot split cleanly is still
// scanned by the whole-text rules below.
// ---------------------------------------------------------------------------
export function tokenize(command) {
  const segments = [];
  let tokens = [];
  let cur = '';
  let has = false;
  let quote = null;
  const push = () => { if (has) tokens.push(cur); cur = ''; has = false; };
  const end = () => { push(); if (tokens.length) segments.push(tokens); tokens = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && i + 1 < command.length) { cur += command[++i]; continue; }
      cur += c; continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < command.length) { cur += command[++i]; has = true; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`') { end(); continue; }
    if (c === '$' && command[i + 1] === '(') { end(); i++; continue; }
    if (/\s/.test(c)) { push(); continue; }
    cur += c; has = true;
  }
  end();
  return segments;
}

// Strip wrappers that do not change what runs: sudo, env, nohup, time, VAR=value, etc.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'nice', 'ionice', 'command', 'builtin', 'exec', 'xargs', 'watch', 'timeout', 'stdbuf']);
const WRAPPER_VALUE_FLAGS = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '--user', '--group', '--host', '--prompt', '--chdir'],
  doas: ['-u', '-C'], env: ['-u', '-C', '-S', '--unset', '--chdir'], nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p'], timeout: ['-s', '-k', '--signal', '--kill-after'], xargs: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a'],
  watch: ['-n', '--interval'], stdbuf: ['-i', '-o', '-e'],
};
export function unwrap(argv) {
  let a = argv.slice();
  for (let guard = 0; guard < 16 && a.length; guard++) {
    const head = a[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) { a = a.slice(1); continue; }
    const base = head.split('/').pop();
    if (WRAPPERS.has(base)) {
      a = a.slice(1);
      // Drop the wrapper's own flags, the values of flags that take one, and a numeric
      // duration for `timeout`.
      const valued = WRAPPER_VALUE_FLAGS[base] ?? [];
      while (a.length && (a[0].startsWith('-') || (base === 'timeout' && /^\d/.test(a[0])))) {
        const takesValue = valued.includes(a[0]);
        a = a.slice(takesValue ? 2 : 1);
      }
      continue;
    }
    if (base === 'npx' || base === 'pnpx' || base === 'bunx') { a = a.slice(1).filter((x, i, all) => !(i === 0 && x === '-y')); continue; }
    break;
  }
  if (a.length) a[0] = a[0].split('/').pop();
  return a;
}

// `bash -c "..."`, `sh -c`, `zsh -c`, `eval "..."`: scan the inner command too.
function nested(argv) {
  const out = [];
  if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(argv[0])) {
    const i = argv.findIndex((x, j) => j > 0 && /^-[a-z]*c[a-z]*$/.test(x));
    if (i !== -1 && argv[i + 1]) out.push(argv[i + 1]);
  }
  if (argv[0] === 'eval' && argv.length > 1) out.push(argv.slice(1).join(' '));
  return out;
}

export function segmentsOf(command, depth = 0) {
  const all = [];
  for (const seg of tokenize(command)) {
    const argv = unwrap(seg);
    if (!argv.length) continue;
    all.push(argv);
    if (depth < 3) for (const inner of nested(argv)) all.push(...segmentsOf(inner, depth + 1));
  }
  return all;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const shortFlags = argv => argv.filter(x => /^-[A-Za-z]+$/.test(x)).map(x => x.slice(1)).join('');
const hasFlag = (argv, ...names) => argv.some(x => names.includes(x) || names.some(n => n.startsWith('--') && x.startsWith(n + '=')));
// Options that take a SEPARATE value, per CLI. Without this, the value is read as the
// subcommand: `npm --workspace pkg publish` looked like `npm pkg`, and
// `kubectl --context prod delete ns x` looked like `kubectl prod`. The `--opt=value`
// form needs no entry. Long options common to many CLIs apply to every command except
// the few whose own flags would collide (rm's --dir is a boolean).
const COMMON_VALUE_OPTS = ['--context', '--profile', '--region', '--project', '--project-ref', '--kubeconfig', '--config', '--app', '--workspace',
  '--filter', '--repo', '--scope', '--token', '--cwd', '--prefix', '--stack', '--namespace', '--kube-context', '--subscription', '--account',
  '--host', '--service', '--environment', '--env', '--workdir', '--org', '--team', '--remote', '--file', '--project-name', '--env-file', '--log-level',
  '--output', '--endpoint-url', '--configuration', '--server', '--cluster', '--user', '--registry', '--dir'];
const VALUE_OPTS = {
  npm: ['-w', '-C'], pnpm: ['-w', '-C', '-F'], yarn: ['-w', '-C'], bun: ['-w', '-C'],
  kubectl: ['-n', '-s', '-l'], oc: ['-n', '-s', '-l'], k: ['-n', '-s', '-l'], helm: ['-n'],
  docker: ['-c', '-H', '-f', '-p', '-l'], podman: ['-c', '-H', '-f', '-p', '-l'], 'docker-compose': ['-f', '-p'],
  fly: ['-a', '-c', '-r'], flyctl: ['-a', '-c', '-r'], railway: ['-s', '-e'], vercel: ['-A', '-S', '-t'], vc: ['-A', '-S', '-t'],
  heroku: ['-a', '-r'], gh: ['-R'], pulumi: ['-s', '-C'], wrangler: ['-c', '-e'],
};
const NO_COMMON = new Set(['rm', 'dd', 'shred']);
const valueOpts = cmd => new Set([...(VALUE_OPTS[cmd] ?? []), ...(NO_COMMON.has(cmd) ? [] : COMMON_VALUE_OPTS)]);
const positional = argv => {
  const takes = valueOpts(argv[0]);
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('-')) { if (!x.includes('=') && takes.has(x)) i++; continue; }
    out.push(x);
  }
  return out;
};
const sub = (argv, n = 1) => positional(argv).slice(0, n).join(' ');

function rmInfo(argv) {
  if (argv[0] !== 'rm') return null;
  const s = shortFlags(argv);
  const recursive = /[rR]/.test(s) || hasFlag(argv, '--recursive');
  const force = /f/.test(s) || hasFlag(argv, '--force');
  return { recursive, force, targets: positional(argv) };
}
const ROOTISH = /^(\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/|\$HOME\/\*|\$\{HOME\}|\$\{HOME\}\/|\$\{HOME\}\/\*|\/(bin|boot|dev|etc|lib|lib64|opt|root|sbin|srv|usr|var|home|Users|System|Library)\/?\*?)$/;
const BROAD = /^(\.|\.\/|\.\.|\.\.\/.*|\*|\.\*|\.\/\*|\.git\/?|~\/.+|\$HOME\/.+|\$\{HOME\}\/.+|\/.+)$/;
const SAFE_ABS = /^\/(tmp|var\/tmp|private\/tmp)(\/|$)/;

// `find <dir> -delete` (or `-exec rm -r`) with no predicate narrowing what it matches is
// `rm -rf <dir>` in other words. With a filter (`-name '*.pyc' -delete`) it is routine
// cleanup and passes.
// A filter narrows the deletion only when the expression has no alternative branch:
// in `find / -name keep -o -delete` the -delete applies to everything NOT named keep.
const FIND_OR = new Set(['-o', '-or', ',']);
const FIND_FILTERS = /^-(i?name|i?path|i?wholename|i?regex|type|x?type|mtime|mmin|atime|amin|ctime|cmin|newer\w*|size|empty|user|group|perm|links|inum|samefile|prune|maxdepth)$/;
function findDeleteRoots(argv) {
  if (argv[0] !== 'find') return null;
  const destructive = argv.includes('-delete') || argv.some((x, i) => ['-exec', '-execdir', '-ok', '-okdir'].includes(x) && argv[i + 1] === 'rm');
  if (!destructive || (argv.some(x => FIND_FILTERS.test(x)) && !argv.some(x => FIND_OR.has(x)))) return null;
  // Leading options (-H, -L, -P, -O<level>, -D <debugopts>) come before the start paths.
  let i = 1;
  while (i < argv.length && /^-([HLP]|O\d*|D)$/.test(argv[i])) i += argv[i] === '-D' ? 2 : 1;
  const roots = [];
  for (; i < argv.length && !argv[i].startsWith('-') && argv[i] !== '(' && argv[i] !== '!'; i++) roots.push(argv[i]);
  return roots.length ? roots : ['.'];
}

const git = (argv, ...subs) => argv[0] === 'git' && subs.includes(gitSub(argv));
function gitSub(argv) {
  // Skip git's global options such as `-C dir` and `-c k=v`.
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-C' || argv[i] === '-c' || argv[i] === '--git-dir' || argv[i] === '--work-tree') { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    return argv[i];
  }
  return '';
}

const MCP_DESTRUCTIVE = /(^|[_\-.])(delete|drop|destroy|remove|truncate|purge|terminate|wipe|reset|erase|revoke|deploy|publish|release|rollback|force)([_\-.]|s?$)/i;
// Tools that only read (`list_releases`, `get_deployment`) are not destructive whatever
// noun follows the verb.
const MCP_READ_VERB = /^(list|get|read|search|describe|fetch|view|show|query|find|count|check|preview|diff|dry[_-]?run)([_\-.]|$)/i;
const CONFIG_PATH = /(^|[\/\\])(\.atlasent[\/\\](hooks|credentials|pending)\.json|\.claude[\/\\]settings(\.local)?\.json|\.cursor[\/\\]hooks\.json)$/;

// Commands that only search, read or print. When every segment is one of these, SQL or
// a GraphQL mutation appearing in the text is being looked at, not executed.
const INERT = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cat', 'less', 'more', 'head', 'tail', 'echo', 'printf', 'wc', 'find', 'ls', 'git-grep']);
// Commands that only carry prose (a commit message, a PR body) are inert too: "fix: drop
// table handling" in a commit message is not SQL being run. Only when EVERY segment is
// inert, so `git commit -m x && psql -c "DROP TABLE t"` is still flagged.
const MESSAGE_ONLY = a => (a[0] === 'git' && ['commit', 'tag', 'notes'].includes(gitSub(a)))
  || (a[0] === 'gh' && ['pr create', 'pr edit', 'pr comment', 'pr review', 'issue create', 'issue edit', 'issue comment'].includes(sub(a, 2)));
// A command substitution runs even inside a quoted message or echo argument, and the
// tokenizer keeps quoted text as one argument, so `git commit -m "$(psql -c 'DROP TABLE t')"`
// would look inert. Any `$(` or backtick in the text disables the exemption.
const SUBSTITUTION = /\$\(|`/;
const inert = (segs, text = '') => !SUBSTITUTION.test(text) && segs.length > 0 && segs.every(a => INERT.has(a[0]) || MESSAGE_ONLY(a) || (a[0] === 'git' && ['grep', 'log', 'show', 'diff'].includes(gitSub(a))));

// ---------------------------------------------------------------------------
// Rules. `argv` rules run per command segment; `text` rules run on the raw text so
// SQL inside quotes, heredocs and -e/-c arguments is still seen.
// ---------------------------------------------------------------------------
export const RULES = [
  { id: 'fs.rm-root', effect: 'deny', kind: 'destroy', description: 'Recursive delete of /, the home directory or a system directory',
    argv: a => { const r = rmInfo(a); if (r) return (r.recursive && r.targets.some(t => ROOTISH.test(t))) || hasFlag(a, '--no-preserve-root'); return !!findDeleteRoots(a)?.some(t => ROOTISH.test(t)); } },
  { id: 'disk.format', effect: 'deny', kind: 'destroy', description: 'Formatting or raw-writing a disk device',
    argv: a => /^mkfs(\.|$)/.test(a[0]) || (a[0] === 'dd' && a.some(x => /^of=\/dev\//.test(x))) || (a[0] === 'wipefs') || (a[0] === 'shred' && a.some(x => x.startsWith('/dev/'))) },
  { id: 'fs.rm-broad', effect: 'ask', kind: 'destroy', description: 'Recursive delete of the working tree, .git, the home directory contents or an absolute path',
    argv: a => { const broad = t => BROAD.test(t) && !SAFE_ABS.test(t) && !ROOTISH.test(t); const r = rmInfo(a); if (r) return r.recursive && r.targets.some(broad); return !!findDeleteRoots(a)?.some(broad); } },
  { id: 'git.force-push', effect: 'ask', kind: 'overwrite', description: 'Force-push, which can overwrite shared history',
    argv: a => git(a, 'push') && (hasFlag(a, '--force', '--force-with-lease', '--force-if-includes', '--mirror') || /f/.test(shortFlags(a)) || positional(a).some(x => /^\+/.test(x))) },
  { id: 'git.remote-delete', effect: 'ask', kind: 'destroy', description: 'Deleting a remote branch or tag',
    argv: a => git(a, 'push') && (hasFlag(a, '--delete', '--prune') || /d/.test(shortFlags(a)) || positional(a).some(x => /^:[^\/]/.test(x))) },
  { id: 'git.discard-work', effect: 'ask', kind: 'destroy', description: 'Discarding uncommitted work or rewriting history (reset --hard, clean -f, branch -D, filter-repo)',
    argv: a => (git(a, 'reset') && hasFlag(a, '--hard')) || (git(a, 'clean') && /f/.test(shortFlags(a))) || (git(a, 'branch') && (/D/.test(shortFlags(a)) || (hasFlag(a, '--delete') && hasFlag(a, '--force')))) || git(a, 'filter-branch', 'filter-repo') || (git(a, 'stash') && ['clear', 'drop'].includes(positional(a)[1])) || (git(a, 'checkout', 'restore') && positional(a).includes('.') && !hasFlag(a, '--staged')) },
  { id: 'sql.destructive', effect: 'ask', kind: 'destroy', description: 'SQL that drops or empties data (DROP, TRUNCATE, DELETE without WHERE, DROP COLUMN)',
    text: (t, segs) => !inert(segs, t) && (/\bdrop\s+(database|schema|table|materialized\s+view|view|index|role|user|owned|extension|function|type|policy|trigger)\b/i.test(t)
      || /\btruncate\s+(table\s+)?[\w."`\[]/i.test(t)
      || /\bdelete\s+from\s+[\w."`\[\]]+\s*(;|$|["'`)]|\s+(returning|limit)\b)/im.test(t)
      || /\balter\s+table\b[^;]*\bdrop\s+(column|constraint)\b/i.test(t)
      || /\b(flushall|flushdb)\b/i.test(t)
      || /\bdb\.dropDatabase\s*\(|\.drop\s*\(\s*\)|\.deleteMany\s*\(\s*\{\s*\}\s*\)/.test(t)) },
  { id: 'db.reset', effect: 'ask', kind: 'destroy', description: 'Database reset or drop through a CLI (dropdb, prisma migrate reset, supabase db reset, rails db:drop)',
    argv: a => a[0] === 'dropdb' || a[0] === 'dropuser'
      || (a[0] === 'prisma' && /^(migrate reset|db push)$/.test(sub(a, 2)) && (sub(a, 2) === 'migrate reset' || hasFlag(a, '--force-reset', '--accept-data-loss')))
      || (a[0] === 'supabase' && sub(a, 2) === 'db reset')
      || (['rails', 'rake', 'bin/rails'].includes(a[0]) && positional(a).some(x => /^db:(drop|reset|purge|schema:load)/.test(x)))
      || (a[0] === 'drizzle-kit' && positional(a)[0] === 'drop')
      || (['python', 'python3'].includes(a[0]) && positional(a)[0] === 'manage.py' && ['flush', 'reset_db', 'sqlflush'].includes(positional(a)[1])) },
  { id: 'iac.destroy', effect: 'ask', kind: 'destroy', description: 'Infrastructure teardown (terraform/tofu destroy, pulumi destroy, cdk destroy, serverless remove)',
    argv: a => (['terraform', 'tofu', 'terragrunt'].includes(a[0]) && (positional(a)[0] === 'destroy' || (positional(a)[0] === 'apply' && hasFlag(a, '-destroy', '--destroy'))))
      || (a[0] === 'pulumi' && ['destroy', 'down'].includes(positional(a)[0]))
      || (a[0] === 'cdk' && positional(a)[0] === 'destroy')
      || (['serverless', 'sls'].includes(a[0]) && positional(a)[0] === 'remove')
      || (a[0] === 'cdktf' && positional(a)[0] === 'destroy') },
  { id: 'k8s.delete', effect: 'ask', kind: 'destroy', description: 'Kubernetes deletion or drain (kubectl delete, drain, helm uninstall, scale to zero)',
    argv: a => (['kubectl', 'oc', 'k'].includes(a[0]) && (['delete', 'drain'].includes(positional(a)[0]) || (positional(a)[0] === 'scale' && a.some(x => /^--replicas=0$/.test(x)))))
      || (a[0] === 'helm' && ['uninstall', 'delete', 'del', 'un'].includes(positional(a)[0])) },
  { id: 'cloud.delete', effect: 'ask', kind: 'destroy', description: 'Cloud or hosted resource deletion (aws/gcloud/az/doctl delete, terminate, s3 rb, recursive s3 rm, gh repo/release delete)',
    argv: a => (a[0] === 'aws' && (positional(a).some(x => /^(delete|terminate|deregister|remove|purge|disable)-/.test(x)) || sub(a, 2) === 's3 rb' || (sub(a, 2) === 's3 rm' && hasFlag(a, '--recursive'))))
      || (a[0] === 'gsutil' && (['rm', 'rb'].includes(positional(a)[0])))
      || (['gcloud', 'az', 'doctl', 'linode-cli', 'hcloud', 'oci', 'ibmcloud'].includes(a[0]) && positional(a).some(x => ['delete', 'destroy', 'terminate', 'purge'].includes(x)))
      || (a[0] === 'gh' && (['repo delete', 'repo archive', 'release delete', 'secret delete', 'variable delete', 'environment delete', 'cache delete', 'run delete'].includes(sub(a, 2))
        || (positional(a)[0] === 'api' && a.some((x, i) => ((x === '-X' || x === '--method') && /^delete$/i.test(a[i + 1] ?? '')) || /^(-XDELETE|--method=DELETE)$/i.test(x))))) },
  { id: 'paas.destroy', effect: 'ask', kind: 'destroy', description: 'Platform teardown (Railway, Fly, Heroku, Vercel, Netlify, Render, Supabase project or volume deletion)',
    argv: a => (a[0] === 'railway' && (['delete', 'down'].includes(positional(a)[0]) || positional(a).slice(0, 3).some(x => ['delete', 'remove', 'rm'].includes(x)) && ['volume', 'environment', 'service', 'project'].includes(positional(a)[0])))
      || (['fly', 'flyctl'].includes(a[0]) && (positional(a).some(x => ['destroy'].includes(x)) || (['volumes', 'volume', 'apps', 'machine', 'machines'].includes(positional(a)[0]) && ['delete', 'destroy', 'rm', 'remove'].includes(positional(a)[1]))))
      || (a[0] === 'heroku' && positional(a).some(x => /^(apps:destroy|pg:reset|addons:destroy|destroy)$/.test(x)))
      || (['vercel', 'vc'].includes(a[0]) && ['remove', 'rm'].includes(positional(a)[0]))
      || (a[0] === 'netlify' && /^sites:delete$/.test(positional(a)[0] ?? ''))
      || (a[0] === 'render' && positional(a).includes('delete'))
      || (a[0] === 'supabase' && ['projects delete', 'branches delete', 'storage rm'].includes(sub(a, 2))) },
  { id: 'container.destroy', effect: 'ask', kind: 'destroy', description: 'Destroying container volumes or data (docker volume rm/prune, system prune --volumes, compose down -v)',
    argv: a => (['docker', 'podman'].includes(a[0]) && ((positional(a)[0] === 'volume' && ['rm', 'prune', 'remove'].includes(positional(a)[1])) || (positional(a)[0] === 'system' && positional(a)[1] === 'prune' && hasFlag(a, '--volumes')) || (positional(a)[0] === 'compose' && positional(a).includes('down') && (hasFlag(a, '--volumes') || /v/.test(shortFlags(a))))))
      || (a[0] === 'docker-compose' && positional(a)[0] === 'down' && (hasFlag(a, '--volumes') || /v/.test(shortFlags(a)))) },
  { id: 'http.delete', effect: 'ask', kind: 'destroy', description: 'An API request that deletes something (HTTP DELETE, or a GraphQL mutation such as volumeDelete)',
    // The 2026-04 PocketOS incident was a curl POST of a GraphQL `volumeDelete`
    // mutation to a platform API, not an HTTP DELETE, so both shapes are covered.
    text: (t, segs) => !inert(segs, t) && /\b(curl|wget|http|https|xh|httpie)\b/.test(t) && /\bmutation\b[\s\S]{0,600}?\b[a-z][A-Za-z0-9]*(Delete|Destroy|Remove|Purge|Wipe|Reset|Drop)\s*[({]/.test(t),
    argv: a => (['curl', 'wget'].includes(a[0]) && a.some((x, i) => ((x === '-X' || x === '--request' || x === '--method') && /^delete$/i.test(a[i + 1] ?? '')) || /^(-XDELETE|--request=DELETE|--method=DELETE)$/i.test(x)))
      || (['http', 'https', 'xh'].includes(a[0]) && /^delete$/i.test(a[1] ?? '')) },
  { id: 'deploy.release', effect: 'ask', kind: 'ship', description: 'Deploying or publishing (prod deploys, terraform/pulumi apply, npm publish, releases, migrations to a linked database)',
    argv: a => (['vercel', 'vc'].includes(a[0]) && (hasFlag(a, '--prod', '--production') || positional(a)[0] === 'promote'))
      || (['fly', 'flyctl'].includes(a[0]) && ['deploy', 'release'].includes(positional(a)[0]))
      || (a[0] === 'railway' && ['up', 'redeploy'].includes(positional(a)[0]))
      || (['terraform', 'tofu', 'terragrunt'].includes(a[0]) && positional(a)[0] === 'apply')
      || (a[0] === 'pulumi' && positional(a)[0] === 'up')
      || (a[0] === 'cdk' && positional(a)[0] === 'deploy')
      || (['serverless', 'sls'].includes(a[0]) && positional(a)[0] === 'deploy')
      || (['npm', 'pnpm', 'yarn', 'bun'].includes(a[0]) && (positional(a)[0] === 'publish' || sub(a, 2) === 'npm publish'))
      || (a[0] === 'cargo' && positional(a)[0] === 'publish')
      || (a[0] === 'twine' && positional(a)[0] === 'upload')
      || (a[0] === 'gem' && positional(a)[0] === 'push')
      || (a[0] === 'gh' && ['release create', 'workflow run'].includes(sub(a, 2)))
      || (a[0] === 'supabase' && ['db push', 'functions deploy', 'secrets set', 'secrets unset'].includes(sub(a, 2)))
      || (a[0] === 'heroku' && positional(a).some(x => /^(releases:rollback|container:release)$/.test(x)))
      || (a[0] === 'netlify' && positional(a)[0] === 'deploy' && hasFlag(a, '--prod'))
      || (a[0] === 'wrangler' && (['deploy', 'publish'].includes(positional(a)[0])))
      || (['kubectl', 'oc'].includes(a[0]) && ['apply', 'replace', 'rollout'].includes(positional(a)[0]) && a.some(x => /prod/i.test(x)))
      || (a[0] === 'helm' && ['upgrade', 'install', 'rollback'].includes(positional(a)[0]) && a.some(x => /prod/i.test(x)))
      || (git(a, 'push') && positional(a).slice(1).some(x => /^heroku$|^dokku$|^production$|^prod$/.test(x))) },
  { id: 'guard.self-edit', effect: 'ask', kind: 'tamper', description: 'Changing the guard\'s own configuration or the agent\'s hook settings',
    text: t => /(\.atlasent[\/\\](hooks|credentials|pending)\.json|\.claude[\/\\]settings(\.local)?\.json|\.cursor[\/\\]hooks\.json)/.test(t) && /(>|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\brm\b|\bchmod\b|\btruncate\b|\bln\b|\bperl\s+-[a-z]*i|\bpython|\bnode\s+-e)/.test(t),
    path: p => CONFIG_PATH.test(p) },
  { id: 'mcp.destructive', effect: 'ask', kind: 'destroy', description: 'An MCP tool whose name says it deletes, drops, resets, deploys or publishes',
    tool: name => { const m = /^mcp__.+?__(.+)$/.exec(name); return !!m && !MCP_READ_VERB.test(m[1]) && MCP_DESTRUCTIVE.test(m[1]); } },
];

export const RULE_IDS = RULES.map(r => r.id);
const RANK = { allow: 0, ask: 1, deny: 2 };

// Classify one proposed action. `action` is { kind: 'shell', command } |
// { kind: 'tool', name, input } | { kind: 'write', path }.
// Returns every matching rule with its effective effect, most severe first.
export function classify(action, policy = { rules: {}, custom: [] }) {
  const hits = [];
  const add = (id, effect, description) => {
    const override = policy.rules?.[id];
    const e = override ?? effect;
    hits.push({ id, effect: e, description });
  };
  if (action.kind === 'shell') {
    const text = String(action.command ?? '');
    const segs = segmentsOf(text);
    for (const r of RULES) {
      if ((r.argv && segs.some(a => { try { return r.argv(a); } catch { return false; } })) || (r.text && r.text(text, segs))) add(r.id, r.effect, r.description);
    }
    for (const c of policy.custom ?? []) if (c.regex.test(text)) add(c.id, c.effect, c.description);
  } else if (action.kind === 'tool') {
    for (const r of RULES) if (r.tool && r.tool(String(action.name ?? ''))) add(r.id, r.effect, r.description);
    // SQL passed to a database MCP tool is still SQL.
    const sql = [action.input?.query, action.input?.sql, action.input?.statement].filter(x => typeof x === 'string').join('\n');
    if (sql) for (const r of RULES) if (r.id === 'sql.destructive' && r.text(sql, [['sql']])) add(r.id, r.effect, r.description);
    for (const c of policy.custom ?? []) if (c.tool && c.regex.test(String(action.name ?? ''))) add(c.id, c.effect, c.description);
  } else if (action.kind === 'write') {
    for (const r of RULES) if (r.path && r.path(String(action.path ?? ''))) add(r.id, r.effect, r.description);
  }
  hits.sort((x, y) => RANK[y.effect] - RANK[x.effect]);
  return hits;
}

export function decisionOf(hits) {
  const top = hits.find(h => h.effect !== 'allow');
  return top ? { effect: top.effect, rule: top } : { effect: 'allow', rule: null };
}

export { EFFECTS };
