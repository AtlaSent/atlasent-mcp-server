/**
 * CI gate for the BP-000009 L2 commit-point harness: the clean suite must be
 * green and deterministic, and every mutant must both take effect and be
 * caught. A mutant that survives, or one that never ran, fails this test:
 * a guard that has not been shown to fail is not evidence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adjacencyViolations, mutants, runDeterministic, runL2Suite, type Event } from "./harness.js";

/**
 * The rule the 2026-09-30 record used: the last RUNTIME event before the
 * mutation is a verify. Kept here only as a positive control: the hostile
 * mutants below must pass it (proving they reproduce the gap atlasent#794
 * describes) and fail the adjacency rule that replaced it.
 */
function legacyLastRuntimeCallViolations(events: Event[]): string[] {
  const out: string[] = [];
  events.forEach((e, i) => {
    if (e.kind !== "provider.mutation") return;
    const lastRuntime = events.slice(0, i).filter((x) => x.kind.startsWith("runtime.")).pop();
    if (lastRuntime?.kind !== "runtime.verify") out.push(`mutation #${e.seq}`);
  });
  return out;
}

const ev = (...kinds: Array<string | [string, Record<string, unknown>]>): Event[] =>
  kinds.map((k, i) => (typeof k === "string" ? { seq: i + 1, kind: k } : { seq: i + 1, kind: k[0], detail: k[1] }));
const ok = ["runtime.verify", { valid: true }] as [string, Record<string, unknown>];

describe("L2 commit-point harness (BP-000009, agent.tool.invoke via @atlasent/mcp-server)", () => {
  it("every requirement passes, twice, with identical outcomes", async () => {
    const det = await runDeterministic();
    const failed = [...det.runs[0].checks, det.check].filter((c) => !c.passed);
    assert.deepEqual(failed, []);
    assert.ok(det.runs[0].checks.length >= 17, `expected >= 17 checks, got ${det.runs[0].checks.length}`);
  });

  it("adjacency rule: verify must be the event IMMEDIATELY before each mutation", () => {
    assert.deepEqual(adjacencyViolations(ev("provider.read", ok, "provider.mutation", "provider.read")), []);
    assert.equal(adjacencyViolations(ev(ok, "provider.read", "provider.mutation")).length, 1);
    assert.equal(adjacencyViolations(ev(ok, "provider.state_change", "provider.mutation")).length, 1);
    assert.equal(adjacencyViolations(ev(ok, "provider.mutation", "provider.mutation")).length, 1, "one verify cannot cover two writes");
    assert.equal(adjacencyViolations(ev(["runtime.verify", { valid: false }], "provider.mutation")).length, 1);
    assert.equal(adjacencyViolations(ev("provider.mutation")).length, 1);
    // The superseded rule passes the intervening read: the gap #794 names.
    assert.deepEqual(legacyLastRuntimeCallViolations(ev(ok, "provider.read", "provider.mutation")), []);
  });

  const expected: Record<string, string> = {
    verify_bypassed: "R8.replay_refused",
    payload_binding_removed: "R2.payload_bound_at_evaluate",
    replay_possible: "R8.replay_refused",
    deny_reaches_provider: "R11.deny_zero_provider_mutations",
    execution_inferred_from_authorization: "R13b.not_inferred_write_dropped",
    provider_read_between_verify_and_mutation: "R6b.verify_adjacent_every_mutation",
    provider_state_change_between_verify_and_mutation: "R6b.verify_adjacent_every_mutation",
  };
  const hostile = new Set(["provider_read_between_verify_and_mutation", "provider_state_change_between_verify_and_mutation"]);
  it("every mutant has an expected catching check", () => {
    assert.deepEqual(mutants().map((m) => m.name).filter((n) => !expected[n]), []);
  });
  for (const m of mutants()) {
    it(`mutant ${m.name} is applied and caught (${expected[m.name]})`, async () => {
      const r = await runL2Suite(m);
      assert.ok(m.applied.count > 0, `mutant ${m.name} never took effect`);
      assert.ok(r.failures.some((f) => f.id === expected[m.name]), `mutant ${m.name} survived ${expected[m.name]}; failures: ${r.failures.map((f) => f.id).join(", ")}`);
      if (hostile.has(m.name)) {
        // Positive control: the hostile mutant must be invisible to everything
        // except the adjacency rule, or this test is not proving that rule.
        assert.deepEqual(r.failures.map((f) => f.id), ["R6b.verify_adjacent_every_mutation"]);
        const legacy = r.sequences.flatMap((s) => legacyLastRuntimeCallViolations(s.events));
        assert.deepEqual(legacy, [], "the superseded last-runtime-call rule must NOT see this mutant");
      }
    });
  }
});
