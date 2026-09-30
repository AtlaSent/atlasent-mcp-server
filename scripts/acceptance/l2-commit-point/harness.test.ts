/**
 * CI gate for the BP-000009 L2 commit-point harness: the clean suite must be
 * green and deterministic, and every mutant must both take effect and be
 * caught. A mutant that survives, or one that never ran, fails this test:
 * a guard that has not been shown to fail is not evidence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mutants, runDeterministic, runL2Suite } from "./harness.js";

describe("L2 commit-point harness (BP-000009, agent.tool.invoke via @atlasent/mcp-server)", () => {
  it("every requirement passes, twice, with identical outcomes", async () => {
    const det = await runDeterministic();
    const failed = [...det.runs[0].checks, det.check].filter((c) => !c.passed);
    assert.deepEqual(failed, []);
    assert.ok(det.runs[0].checks.length >= 16, `expected >= 16 checks, got ${det.runs[0].checks.length}`);
  });

  const expected: Record<string, string> = {
    verify_bypassed: "R8.replay_refused",
    payload_binding_removed: "R2.payload_bound_at_evaluate",
    replay_possible: "R8.replay_refused",
    deny_reaches_provider: "R11.deny_zero_provider_mutations",
    execution_inferred_from_authorization: "R13b.not_inferred_write_dropped",
  };
  for (const m of mutants()) {
    it(`mutant ${m.name} is applied and caught (${expected[m.name]})`, async () => {
      const r = await runL2Suite(m);
      assert.ok(m.applied.count > 0, `mutant ${m.name} never took effect`);
      assert.ok(r.failures.some((f) => f.id === expected[m.name]), `mutant ${m.name} survived ${expected[m.name]}; failures: ${r.failures.map((f) => f.id).join(", ")}`);
    });
  }
});
