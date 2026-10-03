/**
 * Runs the BP-000009 L2 commit-point acceptance: the suite twice (determinism),
 * then every mutant, each of which MUST be caught. Exit 0 only when the clean
 * suite is green both times AND every mutant both applied and failed at least
 * one check. With --out <file>, writes the evidence record as JSON.
 *
 *   node --import tsx scripts/acceptance/l2-commit-point/run.ts [--out docs/acceptance/<file>.json]
 */
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { BINDING_PROFILE, ACTION_TYPE, mutants, runDeterministic, runL2Suite } from "./harness.js";

const outIdx = process.argv.indexOf("--out");
const out = outIdx > 0 ? process.argv[outIdx + 1] : undefined;
// The harness's own JSON logs go to stderr; silence them so the report is readable.
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: unknown, ...rest: unknown[]) =>
  typeof chunk === "string" && chunk.startsWith('{"ts"') ? true : (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stderr.write;

const det = await runDeterministic();
const clean = det.runs[0];
const checks = [...clean.checks, det.check];
for (const c of checks) console.log(`${c.passed ? "PASS" : "FAIL"}  ${c.id}  ${c.detail}`);

const mutantResults = [];
for (const m of mutants()) {
  const r = await runL2Suite(m);
  const caught = r.failures.length > 0;
  const applied = m.applied.count > 0;
  mutantResults.push({ name: m.name, description: m.description, applied_count: m.applied.count, caught, failed_checks: r.failures.map((f) => f.id) });
  console.log(`${caught && applied ? "CAUGHT" : "SURVIVED"}  mutant ${m.name}  applied=${m.applied.count}  failed=[${r.failures.map((f) => f.id).join(", ")}]`);
}

const ok = checks.every((c) => c.passed) && mutantResults.every((m) => m.caught && m.applied_count > 0);
let commit = "unknown";
try { commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch { /* not a checkout */ }

if (out) {
  writeFileSync(out, JSON.stringify({
    version: "l2_commit_point_acceptance.v1",
    binding_profile: BINDING_PROFILE,
    action_type: ACTION_TYPE,
    level_claimed: ok ? "L2" : null,
    level_definition: "L2 = deterministic simulated execution through the binding's own commit-point code path",
    evidence_kind: "simulated_harness",
    commit_point: {
      kind: "client_executor_adjacent_verify",
      description: "The commit point is the MCP server's executeGoverned. The runtime verifies and consumes the permit, and the very next event in the single ordered runtime+provider log is the governed provider write, guarded only by the provider's own base-sha precondition. The provider never sees or checks the permit, so this is NOT a native provider-effect commit point (a provider that checks authorization atomically as part of applying the change).",
      adjacency_rule: "every provider.mutation in every scenario is immediately preceded by a successful runtime.verify; no provider read, provider state change, other runtime call, or second mutation may sit between them (R6, R6b)",
    },
    supersedes: {
      record: "docs/acceptance/L2_COMMIT_POINT_BP-000009_2026-09-30.json",
      reason: "its R6 required only that the last RUNTIME call before the mutation was runtime.verify, so a provider read or state change between verify and write passed (atlasent#794)",
    },
    run_at: new Date().toISOString(),
    code_under_test: { repository: "Atlasent/atlasent-mcp-server", commit, path: "MCP client > atlasent_governed_file_change > engine.authorize (identity, seal, evaluate) / awaitApproval > executeGoverned (verify, execute once, observe effect) > githubFileAdapter" },
    simulated: {
      runtime: "local HTTP server speaking the v1 wire: identity mint, provenance seal (runtime action-hash algorithm), evaluate, approvals/claim, verify with runtime error codes; HMAC-signed 300 s single-use permits",
      provider: "in-process GitHub contents API behind the adapter's fetchImpl seam, counting every mutation call",
    },
    not_proven: [
      "the real AtlaSent runtime's semantics (L3+ / staging acceptance: scripts/acceptance/ai-action-reference/run.mjs)",
      "a real provider or vendor sandbox (L3)",
      "customer acceptance (G4) or production validation (G5)",
      "the LangChain/LlamaIndex binding profile (BP-000010); this evidence covers BP-000009 only",
      "a native provider-effect commit point: the provider does not check the permit, so verify and write remain two calls; their adjacency is shown in the harness's ordered event log, not enforced by the provider",
    ],
    checks,
    outcomes: clean.outcomes,
    deterministic_rerun: { identical: det.check.passed, runs: det.runs.length },
    mutants: mutantResults,
    result: ok ? "pass" : "fail",
  }, null, 2) + "\n");
  console.log(`wrote ${out}`);
}
console.log(ok ? "L2 commit-point acceptance: PASS" : "L2 commit-point acceptance: FAIL");
process.exit(ok ? 0 : 1);
