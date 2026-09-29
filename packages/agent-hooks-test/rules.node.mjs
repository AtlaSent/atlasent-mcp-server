import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, decisionOf, tokenize, segmentsOf, RULES } from '../agent-hooks/rules.mjs';

const verdict = (command, policy) => {
  const { effect, rule } = decisionOf(classify({ kind: 'shell', command }, policy));
  return [effect, rule?.id ?? null];
};

// Each case is [command, expected effect, expected rule]. The rule id is asserted, not
// just the effect, so a case cannot pass by tripping an unrelated rule.
const FLAGGED = [
  ['rm -rf /', 'deny', 'fs.rm-root'],
  ['rm -rf ~', 'deny', 'fs.rm-root'],
  ['rm -fr $HOME', 'deny', 'fs.rm-root'],
  ['rm -r -f /usr', 'deny', 'fs.rm-root'],
  ['sudo rm --recursive --force /*', 'deny', 'fs.rm-root'],
  ['bash -c "rm -rf /"', 'deny', 'fs.rm-root'],
  ["sh -c 'cd /tmp && rm -rf ~/'", 'deny', 'fs.rm-root'],
  ['rm --no-preserve-root -rf /', 'deny', 'fs.rm-root'],
  ['mkfs.ext4 /dev/sda1', 'deny', 'disk.format'],
  ['dd if=/dev/zero of=/dev/nvme0n1 bs=1M', 'deny', 'disk.format'],
  ['rm -rf .', 'ask', 'fs.rm-broad'],
  ['rm -rf .git', 'ask', 'fs.rm-broad'],
  ['rm -rf ~/projects/app', 'ask', 'fs.rm-broad'],
  ['rm -rf /var/lib/postgresql/data', 'ask', 'fs.rm-broad'],
  ['git push --force origin main', 'ask', 'git.force-push'],
  ['git push -f', 'ask', 'git.force-push'],
  ['git push origin +main', 'ask', 'git.force-push'],
  ['git push --force-with-lease', 'ask', 'git.force-push'],
  ['git -C repo push --force', 'ask', 'git.force-push'],
  ['git push origin --delete release/1.0', 'ask', 'git.remote-delete'],
  ['git push origin :old-branch', 'ask', 'git.remote-delete'],
  ['git reset --hard HEAD~3', 'ask', 'git.discard-work'],
  ['git clean -fdx', 'ask', 'git.discard-work'],
  ['git branch -D feature', 'ask', 'git.discard-work'],
  ['git checkout -- .', 'ask', 'git.discard-work'],
  ['git filter-repo --path secrets --invert-paths', 'ask', 'git.discard-work'],
  ['psql "$DATABASE_URL" -c "DROP TABLE users;"', 'ask', 'sql.destructive'],
  ['psql -c "drop database app"', 'ask', 'sql.destructive'],
  ['mysql -e "TRUNCATE TABLE orders"', 'ask', 'sql.destructive'],
  ['psql -c "DELETE FROM sessions;"', 'ask', 'sql.destructive'],
  ['sqlite3 app.db "delete from users"', 'ask', 'sql.destructive'],
  ['psql <<SQL\nALTER TABLE users DROP COLUMN email;\nSQL', 'ask', 'sql.destructive'],
  ['redis-cli FLUSHALL', 'ask', 'sql.destructive'],
  ['mongosh --eval "db.dropDatabase()"', 'ask', 'sql.destructive'],
  ['supabase db reset --linked', 'ask', 'db.reset'],
  ['npx prisma migrate reset --force', 'ask', 'db.reset'],
  ['dropdb production', 'ask', 'db.reset'],
  ['bin/rails db:drop', 'ask', 'db.reset'],
  ['python manage.py flush --noinput', 'ask', 'db.reset'],
  ['terraform destroy -auto-approve', 'ask', 'iac.destroy'],
  ['tofu apply -destroy', 'ask', 'iac.destroy'],
  ['pulumi destroy --yes', 'ask', 'iac.destroy'],
  ['npx cdk destroy --all', 'ask', 'iac.destroy'],
  ['kubectl delete namespace prod', 'ask', 'k8s.delete'],
  ['kubectl drain node-1', 'ask', 'k8s.delete'],
  ['kubectl scale deploy/api --replicas=0', 'ask', 'k8s.delete'],
  ['helm uninstall api', 'ask', 'k8s.delete'],
  ['aws rds delete-db-instance --db-instance-identifier prod', 'ask', 'cloud.delete'],
  ['aws ec2 terminate-instances --instance-ids i-1', 'ask', 'cloud.delete'],
  ['aws s3 rb s3://bucket --force', 'ask', 'cloud.delete'],
  ['aws s3 rm s3://bucket --recursive', 'ask', 'cloud.delete'],
  ['gcloud sql instances delete prod', 'ask', 'cloud.delete'],
  ['az group delete --name rg-prod', 'ask', 'cloud.delete'],
  ['railway down', 'ask', 'paas.destroy'],
  ['railway volume delete', 'ask', 'paas.destroy'],
  ['fly apps destroy my-app', 'ask', 'paas.destroy'],
  ['flyctl volumes destroy vol_123', 'ask', 'paas.destroy'],
  ['heroku apps:destroy --app prod', 'ask', 'paas.destroy'],
  ['heroku pg:reset DATABASE', 'ask', 'paas.destroy'],
  ['vercel rm my-app --yes', 'ask', 'paas.destroy'],
  ['supabase projects delete abc', 'ask', 'paas.destroy'],
  ['docker volume rm pgdata', 'ask', 'container.destroy'],
  ['docker system prune -a --volumes', 'ask', 'container.destroy'],
  ['docker compose down -v', 'ask', 'container.destroy'],
  ['curl -X DELETE https://api.example.com/v1/projects/1', 'ask', 'http.delete'],
  ['curl --request DELETE https://api.example.com/x', 'ask', 'http.delete'],
  // The shape of the PocketOS incident: a GraphQL mutation POSTed with curl.
  [`curl -s https://backboard.railway.app/graphql/v2 -H "Authorization: Bearer $T" -d '{"query":"mutation { volumeDelete(volumeId: \\"abc\\") }"}'`, 'ask', 'http.delete'],
  ['vercel --prod', 'ask', 'deploy.release'],
  ['fly deploy', 'ask', 'deploy.release'],
  ['railway up', 'ask', 'deploy.release'],
  ['terraform apply', 'ask', 'deploy.release'],
  ['npm publish --access public', 'ask', 'deploy.release'],
  ['pnpm publish', 'ask', 'deploy.release'],
  ['gh release create v1.0.0', 'ask', 'deploy.release'],
  ['supabase db push', 'ask', 'deploy.release'],
  ['supabase functions deploy api', 'ask', 'deploy.release'],
  ['wrangler deploy', 'ask', 'deploy.release'],
  ['kubectl apply -f k8s/ --context prod', 'ask', 'deploy.release'],
  ['git push heroku main', 'ask', 'deploy.release'],
  ['echo \'{"version":1,"rules":{"sql.destructive":"allow"}}\' > .atlasent/hooks.json', 'ask', 'guard.self-edit'],
  ['sed -i s/deny/allow/ ~/.claude/settings.json', 'ask', 'guard.self-edit'],
  // Options that take a separate value, before the subcommand (Codex review, #179).
  ['npm --workspace packages/foo publish', 'ask', 'deploy.release'],
  ['pnpm --filter api publish', 'ask', 'deploy.release'],
  ['npm -w pkg publish', 'ask', 'deploy.release'],
  ['kubectl --context prod delete namespace x', 'ask', 'k8s.delete'],
  ['kubectl -n prod delete pod x', 'ask', 'k8s.delete'],
  ['docker --context prod volume rm data', 'ask', 'container.destroy'],
  ['docker compose -f prod.yml down -v', 'ask', 'container.destroy'],
  ['helm --kube-context prod uninstall api', 'ask', 'k8s.delete'],
  ['fly -a app deploy', 'ask', 'deploy.release'],
  ['gh -R o/r release create v1', 'ask', 'deploy.release'],
  ['railway -s api down', 'ask', 'paas.destroy'],
  ['pulumi --stack prod destroy', 'ask', 'iac.destroy'],
  // Chained and wrapped forms.
  ['npm test && git push --force', 'ask', 'git.force-push'],
  ['echo "DROP TABLE users;" | psql "$DATABASE_URL"', 'ask', 'sql.destructive'],
  ['cd infra; terraform destroy', 'ask', 'iac.destroy'],
  ['FOO=1 env BAR=2 timeout 30 terraform destroy', 'ask', 'iac.destroy'],
  ['echo $(kubectl delete pod x)', 'ask', 'k8s.delete'],
];

const SAFE = [
  'ls -la', 'git status', 'git push', 'git push origin feature', 'git push -u origin claude/x',
  'git reset HEAD file.txt', 'git reset --soft HEAD~1', 'git clean -n', 'git branch -d merged',
  'rm -rf node_modules', 'rm -rf dist build .next', 'rm -rf /tmp/scratch', 'rm file.txt', 'rm -r ./coverage',
  'npm test', 'npm run build', 'npm install', 'terraform plan', 'terraform init', 'pulumi preview',
  'kubectl get pods', 'kubectl apply -f k8s/dev.yaml', 'helm list', 'docker compose down', 'docker ps',
  'psql -c "SELECT * FROM users"', 'psql -c "DELETE FROM sessions WHERE expires_at < now()"',
  'grep -r "DROP TABLE" docs/', 'rg "volumeDelete" src', 'git log --grep "drop table"', 'curl https://api.example.com/health', 'curl -X POST https://api.example.com/items -d "{}"',
  'aws s3 ls', 'aws s3 cp file s3://bucket/', 'gcloud config list', 'vercel', 'vercel dev', 'fly status',
  'railway logs', 'kubectl --context prod get pods', 'npm --workspace api test', 'docker --context prod ps', 'rm -r --dir build', 'supabase start', 'supabase db diff', 'prisma migrate dev', 'cat .atlasent/hooks.json',
  'echo "remember to run terraform destroy later"',
];

test('flags destructive and shipping commands with the expected rule', () => {
  for (const [cmd, effect, id] of FLAGGED) assert.deepEqual(verdict(cmd), [effect, id], cmd);
});

test('leaves ordinary development commands alone', () => {
  for (const cmd of SAFE) assert.deepEqual(verdict(cmd), ['allow', null], cmd);
});

test('every built-in rule is exercised by at least one flagged case or a tool/path case', () => {
  const covered = new Set(FLAGGED.map(c => c[2]).concat(['mcp.destructive']));
  for (const r of RULES) assert.ok(covered.has(r.id), `no test case for ${r.id}`);
});

test('the most severe matching rule wins', () => {
  assert.deepEqual(verdict('git push --force && rm -rf /'), ['deny', 'fs.rm-root']);
});

test('policy overrides change the effect of a rule, and custom rules apply', () => {
  const policy = { rules: { 'deploy.release': 'deny', 'git.force-push': 'allow' }, custom: [{ id: 'my.prod-psql', effect: 'ask', description: 'prod psql', regex: /psql .*prod/ }] };
  assert.deepEqual(verdict('vercel --prod', policy), ['deny', 'deploy.release']);
  assert.deepEqual(verdict('git push --force', policy), ['allow', null]);
  assert.deepEqual(verdict('psql postgres://prod-db/app', policy), ['ask', 'my.prod-psql']);
});

test('MCP tools: destructive names and destructive SQL arguments', () => {
  const t = (name, input = {}) => decisionOf(classify({ kind: 'tool', name, input })).rule?.id ?? null;
  assert.equal(t('mcp__supabase__delete_branch'), 'mcp.destructive');
  assert.equal(t('mcp__railway__volume_delete'), 'mcp.destructive');
  assert.equal(t('mcp__github__merge_pull_request'), null);
  assert.equal(t('mcp__supabase__execute_sql', { query: 'DROP TABLE users' }), 'sql.destructive');
  assert.equal(t('mcp__supabase__execute_sql', { query: 'select 1' }), null);
  assert.equal(t('mcp__x__list_deployments'), null);
  assert.equal(t('mcp__github__list_releases'), null);
  assert.equal(t('mcp__vercel__get_deployment'), null);
  assert.equal(t('mcp__github__create_release'), 'mcp.destructive');
});

test('writes to the guard or agent hook configuration need approval', () => {
  const w = path => decisionOf(classify({ kind: 'write', path })).rule?.id ?? null;
  assert.equal(w('/repo/.atlasent/hooks.json'), 'guard.self-edit');
  assert.equal(w('/home/u/.claude/settings.json'), 'guard.self-edit');
  assert.equal(w('/repo/.claude/settings.local.json'), 'guard.self-edit');
  assert.equal(w('/repo/src/index.ts'), null);
});

test('tokenizer splits chains and keeps quoted arguments whole', () => {
  assert.deepEqual(tokenize('a "b c" && d; e | f'), [['a', 'b c'], ['d'], ['e'], ['f']]);
  assert.deepEqual(segmentsOf('sudo -u root terraform destroy')[0], ['terraform', 'destroy']);
});
