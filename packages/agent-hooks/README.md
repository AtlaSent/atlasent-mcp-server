# AtlaSent Guard for Claude Code

**Stops AI coding agents from destroying production.**

In April 2026 a coding agent deleted a company's production database, and its backups,
through a platform API in nine seconds. Nothing between the agent and the API asked
"should this happen?"

This plugin is that question. Before Claude Code runs a command, it checks whether the
command destroys or ships something. If it does, a person has to approve it. Everything
else runs exactly as before.

```text
> Clean up the old staging volume
● Bash(curl -s https://backboard.railway.app/graphql/v2 -d '{"query":"mutation { volumeDelete(...) }"}')
  ⚠ AtlaSent guard: An API request that deletes something (HTTP DELETE, or a GraphQL
    mutation such as volumeDelete) [http.delete]. A person must approve this before it runs.
```

Local: no account, no network, no dependencies. Apache-2.0 licensed.

**Requires Node.js 18 or later** on your `PATH` (check with `node --version`).

## Install (30 seconds)

In Claude Code:

```text
/plugin marketplace add Atlasent/atlasent-mcp-server
/plugin install atlasent-guard@atlasent
```

Restart Claude Code. Requires Node 18 or later on your `PATH`. Without it, the guard
blocks every checked action and says why, rather than silently protecting nothing.

Try it: ask Claude to run `terraform destroy` or `git push --force`. You get a prompt
instead of a teardown.

## What it catches

| Rule | Default | Examples |
|---|---|---|
| `fs.rm-root` | **deny** | `rm -rf /`, `rm -rf ~`, `sudo bash -c "rm -rf /usr"` |
| `disk.format` | **deny** | `mkfs.ext4 /dev/sda1`, `dd of=/dev/nvme0n1` |
| `fs.rm-broad` | ask | `rm -rf .`, `rm -rf .git`, `rm -rf ~/projects/app`, `find . -delete` (not `rm -rf node_modules`, not `find . -name '*.pyc' -delete`) |
| `sql.destructive` | ask | `DROP TABLE`, `TRUNCATE`, `DELETE FROM x` with no `WHERE`, `DROP COLUMN`, `FLUSHALL`, `db.dropDatabase()` — in `psql -c`, heredocs, pipes, or a database MCP tool's `query` |
| `db.reset` | ask | `supabase db reset`, `prisma migrate reset`, `dropdb`, `rails db:drop`, `manage.py flush` |
| `iac.destroy` | ask | `terraform destroy`, `tofu apply -destroy`, `pulumi destroy`, `cdk destroy` |
| `k8s.delete` | ask | `kubectl delete`, `kubectl drain`, `--replicas=0`, `helm uninstall` |
| `cloud.delete` | ask | `aws rds delete-db-instance`, `aws s3 rb`, `aws s3 rm --recursive`, `gcloud … delete`, `az … delete`, `gh repo delete`, `gh release delete`, `gh api -X DELETE` |
| `paas.destroy` | ask | `railway down`, `railway volume delete`, `fly apps destroy`, `heroku pg:reset`, `vercel rm`, `supabase projects delete` |
| `container.destroy` | ask | `docker volume rm`, `docker system prune --volumes`, `docker compose down -v` |
| `http.delete` | ask | `curl -X DELETE …`, a GraphQL `mutation { volumeDelete(…) }` sent with curl |
| `git.force-push` | ask | `git push --force`, `-f`, `--force-with-lease`, `+refspec` |
| `git.remote-delete` | ask | `git push --delete`, `git push origin :branch` |
| `git.discard-work` | ask | `git reset --hard`, `git clean -f`, `git branch -D`, `git checkout -- .`, `git filter-repo` |
| `deploy.release` | ask | `vercel --prod`, `fly deploy`, `railway up`, `terraform apply`, `npm publish`, `gh release create`, `supabase db push`, `wrangler deploy` |
| `mcp.destructive` | ask | any MCP tool named like `delete_*`, `*_drop`, `reset_*`, `deploy_*`, `publish_*` |
| `guard.self-edit` | ask | the agent editing `.atlasent/hooks.json` or `.claude/settings.json` |

It unwraps `sudo`, `env`, `timeout`, `npx`, `VAR=value`, chains (`&&`, `;`, `|`),
`$(…)`, and `bash -c "…"`, so a destructive command inside a longer one is still seen.
`grep "DROP TABLE" docs/` and a commit message that mentions `DROP TABLE` are not
flagged; `echo "DROP TABLE x" | psql` is.

To see what it would do with any command, from a checkout of this repository:
`node packages/agent-hooks/cli.mjs check "<command>"`. (The npm package
`@atlasent/agent-hooks` is not published yet; the plugin installs straight from GitHub.)

## When nobody is watching

If Claude Code runs with `--dangerously-skip-permissions` (`bypassPermissions`) or
`dontAsk`, there is no one to answer a prompt. In those modes every "ask" becomes a
**deny**. Unattended agents are exactly where the incidents happen.

## Configure

Optional. `~/.atlasent/hooks.json` (yours) and `<repo>/.atlasent/hooks.json` (the
project's):

```json
{
  "version": 1,
  "rules": { "deploy.release": "deny", "git.discard-work": "allow" },
  "custom": [
    { "id": "team.prod-psql", "pattern": "psql .*prod", "flags": "i", "effect": "ask", "description": "psql against a prod host" }
  ],
  "unattended": "deny"
}
```

Effects are `allow`, `ask` and `deny`. **A repository config can tighten your rules but never
loosen them**: an agent that can write to the repository cannot switch your protection off.
An invalid config blocks every checked action until you fix it, instead of silently
protecting nothing.

## What gets recorded

When a rule fires, one line is appended to `~/.atlasent/agent-hooks-activity.jsonl`
(created private, `0600`): time, session, rule, decision, and a SHA-256 of the command.
**Never the command text**, because commands routinely carry passwords and tokens.
Set `ATLASENT_HOOKS_AUDIT=off` to disable it.

This log is a local, editable file. It is useful for you and it is **not** evidence
for an auditor. See "From your laptop to your organization" below.

## What this does not do

Be clear-eyed about this; a guard that overclaims is worse than none.

- **It is a tripwire, not a sandbox.** It reads the command text. An agent that writes a
  script and then runs `./script.sh`, decodes a payload, or calls an API from inside a
  program it wrote, is not seen. Pattern rules will also miss commands nobody thought of.
- **The approver is whoever is at the keyboard.** "Ask" means Claude Code prompts you.
  It is not independent review.
- **It does not protect credentials.** If the agent holds a production token, the token is
  the risk. Scope your tokens.
- **It only sees Claude Code.** The same agent using the same credentials elsewhere is
  outside it.

## From your laptop to your organization

This plugin answers *"did someone at the keyboard say yes?"* After an incident, the
question is *"who in the organization authorized this, and can you prove it?"*

[AtlaSent](https://www.atlasent.io) answers that one. The same destructive actions go to
your organization's policy at execution time: a named approver, a single-use permit bound
to that exact action, and a signed record of the decision. For agents, use [`@atlasent/mcp-server`](../../README.md) or
[`@atlasent/mcp-gate`](../mcp-gate); for pipelines, the
[AtlaSent deploy gate](https://github.com/Atlasent/atlasent-action).
[Create an account](https://console.atlasent.io/auth/sign-up?utm_source=agent-hooks&utm_medium=readme).

## Develop

```sh
cd packages/agent-hooks
npm test          # tests live in ../agent-hooks-test so the plugin ships none
node cli.mjs rules
node cli.mjs check "terraform destroy"
```

Tests run the CLI exactly as Claude Code does (JSON on stdin) and cover fail-closed on
malformed input and invalid config, the repo-cannot-weaken rule, unattended mode, and
that the activity log never contains command text. New rules need a flagged case and,
where there is an obvious look-alike, a safe case.
