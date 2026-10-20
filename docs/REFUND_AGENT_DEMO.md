# Refund agent demo

A support agent works a queue of refund requests. Small refunds go straight
through; large ones stop and wait for a person to approve them in the AtlaSent
console; nothing is refunded without a permit verified at the moment of
payment. The payment processor is simulated in every mode: no money moves.

```
RF-1001  $42.50     allow      → verified → issued
RF-1002  $189.00    allow      → verified → issued
RF-1003  $2,400     escalate   → approver approves in console → verified → issued
RF-1004  $12,750    escalate   → approver rejects (new bank account) → not issued
```

Code: [`examples/refund-agent-demo.mjs`](../examples/refund-agent-demo.mjs),
[`examples/refund-agent/`](../examples/refund-agent/). Tests:
`src/refundAgentDemo.test.ts`.

## What the policy is, and why this one

A refund is a disbursement of company funds. The Canon action it converges to
is `finance.payment.authorize` (CANON-000021; policy record POL-USFP-008), so
the agent asks for exactly that action, with `context.payment_kind: "refund"`.

The demo org runs the **`solo-builder-payment-authorize-gate`** pack, template
**`self-attested-under-1000`** (atlasent-api `packages/packs`):

- no numeric amount → **deny** `AMOUNT_REQUIRED`
- under $1,000 → **allow** (still evaluated, permitted and evidenced)
- $1,000 or more → **escalate** `SECOND_APPROVER_REQUIRED`, always

The escalation does not read any approval claim from the caller (atlasent-api
#2471). That matters for an agent: an agent that could send `approvals: 2`
could approve itself. This agent sends no approval claim at all, and a test
pins that.

Do **not** use the `customer.refund.issue` class that `seed_us_forprofit_baseline`
seeds for this demo. Its rules decide on a caller-reported `context.approvals`
count: an agent sending `approvals: 0` is denied outright (no hold, nothing for
the approver to do), and one sending `approvals: 2` is allowed. Changing that
seeded policy is a separate decision.

## Setting up the demo org (founder)

These change live authorization state, so each is a deliberate step by an org
owner, never something the agent or a script does on inferred authority.

1. **Org.** Create the refund demo org in the console (staging first). Note its
   org id.
2. **Policy.** Seed and activate the pack (from atlasent-api):

   ```sh
   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
   pnpm --filter @atlasent/packs seed -- \
     --org <org_id> --pack solo-builder-payment-authorize-gate \
     --template self-attested-under-1000 --activate
   ```

   `--activate` is required; without it the bundle is a draft and every
   refund fails closed ("no published policy bundle").
3. **Key.** Mint an API key for the org with `evaluate:write` and
   `verify:execute` (Settings → API keys). It is shown once.
4. **Approver (Eric).** See below.
5. **Rehearse** with `--simulate`, then one live run on staging before showing
   it to anyone.

## Adding Eric

Members are added only by an org admin in the console. There is no scripted
invite path: a service-role invite that names an approving admin was rejected
(atlasent-internal decision ledger, 2026-09-05).

1. Sign in as the demo org's owner, with MFA (the invite needs an AAL2 session).
2. **Seat.** A free org has one seat, so an invite returns
   `SEAT_LIMIT_REACHED` until the org has room (the promo-code route used
   for advisors).
3. Settings → Team → Invite, Eric's email, role **Operator**. Operator can
   approve and reject held requests; Auditor can only watch; only an owner can
   grant Admin.
4. Eric accepts the email invite, signs in, and sets up MFA.
5. The approver must be a different person from whoever started the run. That
   is the point of the demo: the agent asks, a distinct human decides.

## Running it

```sh
npm run build
npm run demo:refund -- --simulate        # rehearsal, no network, every line [SIMULATED]

ATLASENT_API_KEY=ask_test_... \
ATLASENT_BASE_URL=https://<ref>.supabase.co/functions/v1 \
ATLASENT_ENVIRONMENT=staging \
npm run demo:refund                       # live
```

While RF-1003 waits, Eric opens **Approval queue** in the console, reads the
refund (amount, customer, ticket, original payment method) and approves it.
For RF-1004 (a new bank account, the classic refund-fraud channel) he rejects
it. The run writes `refund-agent-results-<time>.json` with every outcome; the
permit is recorded only as a sha256.

## What to show in the console afterwards

- **Decisions:** four evaluations of `finance.payment.authorize`, two allow and
  two escalate, each with its signed receipt.
- **Approval queue / history:** Eric's approval and rejection, by name.
- **Decisions → Export CSV:** the policy results for the run, for a finance or
  audit reviewer.

## Not proven yet

- The live path has not been run end to end against a runtime. Do the staging
  rehearsal before any presentation.
- The agent verifies with the actor it evaluated as
  (`REFUND_AGENT_ACTOR_ID`, default `service:refund-agent`). With an
  agent-bound key the runtime may replace the actor; if verify reports a
  mismatch on staging, use a non-agent org key for the demo.
- POL-USFP-008 describes four refund tiers and a rule that a refund to an
  alternate destination needs a controller. This pack has one threshold, and
  the alternate-destination case is the approver's judgement, not a policy rule.
