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
  // GitHub-hosted resources.
  ['gh repo delete org/repo --yes', 'ask', 'cloud.delete'],
  ['gh release delete v1.2.0 -y', 'ask', 'cloud.delete'],
  ['gh api -X DELETE repos/org/repo', 'ask', 'cloud.delete'],
  ['gh api --method DELETE repos/org/repo/git/refs/heads/main', 'ask', 'cloud.delete'],
  // `find` with nothing narrowing what it deletes is rm -rf by another name.
  ['find . -delete', 'ask', 'fs.rm-broad'],
  ['find . -mindepth 1 -exec rm -rf {} +', 'ask', 'fs.rm-broad'],
  ['find / -delete', 'deny', 'fs.rm-root'],
  ['find ~ -exec rm -rf {} +', 'deny', 'fs.rm-root'],
  // A commit message does not make a real SQL statement in the same chain safe.
  ['git commit -m "wip" && psql -c "DROP TABLE users"', 'ask', 'sql.destructive'],
  // A substitution inside a quoted message or echo still RUNS: not inert.
  ["git commit -m \"$(psql -c 'DROP TABLE users')\"", 'ask', 'sql.destructive'],
  ['git commit -m "`psql -c \\"DROP TABLE users\\"`"', 'ask', 'sql.destructive'],
  ["echo \"$(psql -c 'DROP TABLE users')\"", 'ask', 'sql.destructive'],
  // find: leading options precede the start path; an -o branch escapes the filter.
  ['find -H / -delete', 'deny', 'fs.rm-root'],
  ['find -L -O2 ~ -delete', 'deny', 'fs.rm-root'],
  ['find -D stat . -delete', 'ask', 'fs.rm-broad'],
  ['find / -name keep -o -delete', 'deny', 'fs.rm-root'],
  ['find . -name keep -or -exec rm -rf {} +', 'ask', 'fs.rm-broad'],
  // Email leaves the account and cannot be recalled.
  ['echo "see attached" | mail -s "Q3 numbers" cfo@example.com', 'ask', 'mail.send'],
  ['mutt -s hi -a report.pdf -- ops@example.com < body.txt', 'ask', 'mail.send'],
  ['neomutt -H draft.eml', 'ask', 'mail.send'],
  ['sendmail -t < message.eml', 'ask', 'mail.send'],
  ['msmtp -a work board@example.com < message.eml', 'ask', 'mail.send'],
  ['swaks --to a@example.com --server smtp.example.com', 'ask', 'mail.send'],
  ['swaks -S --to a@example.com --server smtp.example.com', 'ask', 'mail.send'],
  ['xargs -I{} mail -s hi {} < customers.txt', 'ask', 'mail.send'],
  ['aws ses send-email --from a@example.com --destination ToAddresses=b@example.com', 'ask', 'mail.send'],
  ['aws --region us-east-1 sesv2 send-email --content file://m.json', 'ask', 'mail.send'],
  ['curl smtp://smtp.gmail.com:587 --mail-from a@example.com --mail-rcpt b@example.com -T m.txt', 'ask', 'mail.send'],
  ['curl -X POST -H "Authorization: Bearer $T" https://gmail.googleapis.com/gmail/v1/users/me/messages/send -d @msg.json', 'ask', 'mail.send'],
  ['curl -X POST https://gmail.googleapis.com/gmail/v1/users/me/drafts/send -d \'{"id":"r1"}\'', 'ask', 'mail.send'],
  ['curl "https://www.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media" --data-binary @m.eml', 'ask', 'mail.send'],
  ['curl -X POST https://graph.microsoft.com/v1.0/me/sendMail -d @m.json', 'ask', 'mail.send'],
  ['curl -X POST https://graph.microsoft.com/v1.0/me/messages/AAMk=/forward -d @to.json', 'ask', 'mail.send'],
  ['curl https://api.sendgrid.com/v3/mail/send -H "Authorization: Bearer $K" -d @m.json', 'ask', 'mail.send'],
  ['curl -s --user "api:$K" https://api.mailgun.net/v3/mg.example.com/messages -F to=a@example.com', 'ask', 'mail.send'],
  ['curl https://api.postmarkapp.com/email -d @m.json', 'ask', 'mail.send'],
  ['curl https://api.resend.com/emails -d @m.json', 'ask', 'mail.send'],
  // Resend sends on POST; a write flag or an explicit POST is a send (Codex review, #280).
  ['curl -sX POST https://api.resend.com/emails -H "Authorization: Bearer $K"', 'ask', 'mail.send'],
  ['curl --json @m.json https://api.resend.com/emails', 'ask', 'mail.send'],
  ['curl https://api.resend.com/emails/batch -d @batch.json', 'ask', 'mail.send'],
  ['python3 -c "import requests; requests.post(\'https://api.resend.com/emails\', json=m)"', 'ask', 'mail.send'],
  // curl uses the last -X; a GET elsewhere in the command does not excuse a POST
  // (Codex review, #281).
  ['curl -X GET -X POST https://api.resend.com/emails', 'ask', 'mail.send'],
  ['curl --request GET --request POST https://api.resend.com/emails', 'ask', 'mail.send'],
  ['python3 -c "import requests; requests.get(\'https://example.com\'); requests.post(\'https://api.resend.com/emails\', json=m)"', 'ask', 'mail.send'],
  ['curl -X GET https://api.resend.com/emails && python3 -c "import requests; requests.post(\'https://api.resend.com/emails\', json=m)"', 'ask', 'mail.send'],
  // A recipient need not contain @: a local user or an alias, which can forward
  // anywhere (Codex review, #280).
  ["printf 'body' | mail board", 'ask', 'mail.send'],
  ['mailx -r ops@example.com board', 'ask', 'mail.send'],
  ['s-nail -S sendwait board < m.txt', 'ask', 'mail.send'],
  ['mutt -- board < m.txt', 'ask', 'mail.send'],
  ['curl https://email.us-east-1.amazonaws.com/ -d "Action=SendRawEmail&RawMessage.Data=x"', 'ask', 'mail.send'],
  ['python3 - <<PY\nimport smtplib\ns = smtplib.SMTP("smtp.example.com")\ns.send_message(msg)\nPY', 'ask', 'mail.send'],
  ['node -e "require(\'nodemailer\').createTransport(cfg).sendMail(msg)"', 'ask', 'mail.send'],
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
  'gh pr list', 'gh api repos/org/repo', 'gh release view v1', 'gh repo view',
  'find . -name "*.pyc" -delete', 'find . -type d -name __pycache__ -exec rm -rf {} +', 'find build -delete',
  // Prose that mentions SQL or an API call is not running it.
  'git commit -m "fix: drop table handling in migration"', 'git commit -m "remove DELETE FROM sessions;"',
  'gh pr create --title "x" --body "handles TRUNCATE TABLE and curl -X DELETE"',
  // Reading mail, and reading about sending it, sends nothing.
  'mail', 'mail -f ~/mbox', 'mailx -H', 'mutt', 'mutt -f =INBOX', 'sendmail -bp', 'msmtp --version', 'msmtp --serverinfo --host=smtp.example.com',
  'which sendmail', 'ls -l /usr/sbin/sendmail', 'aws ses get-send-quota', 'aws ses list-identities',
  'curl https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread',
  'curl -X POST https://gmail.googleapis.com/gmail/v1/users/me/drafts -d @draft.json',
  'curl -X POST https://graph.microsoft.com/v1.0/me/messages/AAMk=/createReply',
  'curl https://api.mailgun.net/v3/domains/mg.example.com/messages/KEY',
  'curl https://api.resend.com/emails', 'curl -X GET https://api.resend.com/emails', 'curl -G https://api.resend.com/emails -d limit=10',
  'curl -X POST -X GET https://api.resend.com/emails', 'bash -c "curl -X GET https://api.resend.com/emails"',
  'curl -H "Authorization: Bearer $K" https://api.resend.com/emails/4ef9a417',
  'curl -X POST https://api.resend.com/emails/4ef9a417/cancel',
  'python3 -c "import requests; requests.get(\'https://api.resend.com/emails\', headers=h)"',
  'mail -u alice', 'mail -e', 'mail --version', 'mail -S folder=~/Mail', 'mail -fmbox', 'mutt -A team', 'mutt -Q editor',
  'python3 -c "import smtplib; print(smtplib.__file__)"',
  'grep -rn "messages/send" src/', 'rg sendMail src', 'cat docs/smtp.md',
  'git commit -m "call https://api.sendgrid.com/v3/mail/send from the mailer"',
  'echo "remember to mail -s report bob@example.com"',
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

test('MCP tools: sending email asks, drafting and reading do not', () => {
  const t = name => decisionOf(classify({ kind: 'tool', name, input: {} })).rule?.id ?? null;
  // The founder incident: the session held a raw Gmail send tool, and "draft this, do
  // not send" was not a control.
  for (const name of ['mcp__Gmail__send_message', 'mcp__claude_ai_Gmail__send_message', 'mcp__Gmail__reply', 'mcp__Gmail__forward',
    'mcp__gmail__send_draft', 'mcp__gmail__drafts.send', 'mcp__gmail__users_messages_send', 'mcp__gmail__schedule_send',
    'mcp__outlook__send_mail', 'mcp__ms365__sendMail', 'mcp__ms365__reply_to_mail_message', 'mcp__resend__send-email', 'mcp__sendgrid__send',
    'mcp__mailchimp__send_campaign', 'mcp__zapier__gmail_send_email', 'mcp__crm__send_notification_email',
    'mcp__gmail__update_vacation_responder', 'mcp__gmail__create_forwarding_address']) assert.equal(t(name), 'mail.send', name);
  for (const name of ['mcp__Gmail__create_draft', 'mcp__Gmail__update_draft', 'mcp__Gmail__list_drafts', 'mcp__Gmail__get_draft',
    'mcp__Gmail__get_message', 'mcp__Gmail__get_thread', 'mcp__Gmail__search_threads', 'mcp__Gmail__label_message',
    'mcp__Gmail__trash_thread', 'mcp__Gmail__mark_message_spam', 'mcp__gws__gmail_draft_reply', 'mcp__gmail__get_vacation_settings',
    'mcp__gmail__list_send_as', 'mcp__gmail__check_send_quota', 'mcp__gmail__undo_send', 'mcp__gmail__cancel_scheduled_send',
    'mcp__email__validate_address', 'mcp__k8s__port_forward', 'mcp__Google_Calendar__respond_to_event']) assert.equal(t(name), null, name);
  // Deleting a draft is still a deletion.
  assert.equal(t('mcp__Gmail__delete_draft'), 'mcp.destructive');
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
