import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, _resetRateLimitForTests } from "./server.js";
import { analyzeWorkflows, detectStep, parseYamlSubset, YamlSubsetError } from "./evidenceGap.js";

// Parsed YAML is read by deep property access in these assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YamlDoc = Record<string, any>;

const wf = (content: string, path = ".github/workflows/deploy.yml") => [{ path, content }];

const UNGATED = `
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: npm run build
      - name: Ship it
        run: |
          # kubectl apply -f old.yaml   (commented out; must not count)
          helm upgrade --install api ./chart
`;

const BOUND = `
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: AtlaSent gate
        id: gate
        uses: AtlaSent/atlasent-action@v1
        with:
          action: production.deploy
      - name: Apply
        if: steps.gate.outputs.verified == 'true'
        run: terraform apply -auto-approve plan.tfplan
`;

describe("parseYamlSubset", () => {
  it("reads flow collections: inline maps, nested lists, quotes and ${{ }} expressions", () => {
    const doc = parseYamlSubset(
      'on: [push, "pull_request"]\njobs:\n  a:\n    permissions: { contents: read, id-token: write }\n    steps:\n      - { name: "a, b", run: npm publish, if: "${{ github.ref == \'refs/heads/main\' }}" }\n      - with: { action: production.deploy, list: [x, [y, z]], expr: ${{ inputs.a }} }\n',
    ) as YamlDoc;
    assert.deepEqual(doc.on, ["push", "pull_request"]);
    assert.deepEqual(doc.jobs.a.permissions, { contents: "read", "id-token": "write" });
    assert.deepEqual(doc.jobs.a.steps[0], { name: "a, b", run: "npm publish", if: "${{ github.ref == 'refs/heads/main' }}" });
    assert.deepEqual(doc.jobs.a.steps[1].with, { action: "production.deploy", list: ["x", ["y", "z"]], expr: "${{ inputs.a }}" });
  });

  it("joins a flow collection that spans lines", () => {
    const doc = parseYamlSubset("jobs:\n  a:\n    steps:\n      - { name: p,\n          run: npm publish }\n    needs: [\n      b,\n      c ]\n") as YamlDoc;
    assert.deepEqual(doc.jobs.a.steps[0], { name: "p", run: "npm publish" });
    assert.deepEqual(doc.jobs.a.needs, ["b", "c"]);
  });

  it("refuses a malformed flow collection, with its line, instead of misreading it", () => {
    for (const [src, line] of [
      ["jobs:\n  a:\n    steps:\n      - { run: npm publish\n", 4],
      ["jobs:\n  a:\n    env: { A: 1 B: 2 }\n", 3],
      ['jobs:\n  a:\n    env: { "A: 1 }\n', 3],
      ["jobs:\n  a:\n    env: { A: 1 } extra\n", 3],
    ] as const) {
      assert.throws(() => parseYamlSubset(src), (e: unknown) => e instanceof YamlSubsetError && e.line === line);
    }
  });

  it("parses maps, same-indent sequences, block scalars and flow lists", () => {
    const doc = parseYamlSubset(`
jobs:
  a:
    needs: [b, "c"]
    steps:
    - run: |
        echo one
        echo two
    - uses: x/y@v1 # trailing comment
`) as YamlDoc;
    assert.deepEqual(doc.jobs.a.needs, ["b", "c"]);
    assert.equal(doc.jobs.a.steps[0].run, "echo one\necho two");
    assert.equal(doc.jobs.a.steps[1].uses, "x/y@v1");
  });

  it("folds a multi-line plain scalar", () => {
    const doc = parseYamlSubset(
      "jobs:\n  a:\n    steps:\n      - name: p\n        run: bash scripts/provision.sh \\\n          --org x\n        env: {}\n",
    ) as YamlDoc;
    assert.match(doc.jobs.a.steps[0].run, /provision\.sh .*--org x/);
    assert.deepEqual(doc.jobs.a.steps[0].env, {});
  });

  it("keeps '#' inside quotes", () => {
    const doc = parseYamlSubset(`a: "x # y"\n`) as Record<string, string>;
    assert.equal(doc.a, "x # y");
  });
});

describe("detectStep", () => {
  const cases: Array<[Record<string, unknown>, string | null]> = [
    [{ run: "npm publish --access public" }, "publish"],
    [{ run: "docker buildx build --push -t x ." }, "publish"],
    [{ run: "supabase db push" }, "migrate"],
    [{ run: "terraform -chdir=infra apply plan" }, "infrastructure"],
    [{ run: "kubectl rollout restart deploy/api" }, "deploy"],
    [{ uses: "docker/build-push-action@v6", with: { push: "true" } }, "publish"],
    [{ uses: "docker/build-push-action@v6", with: { push: "false" } }, null],
    [{ uses: "pypa/gh-action-pypi-publish@release/v1" }, "publish"],
    [{ run: "terraform plan" }, null],
    [{ run: "npm test" }, null],
    [{ run: "# npm publish" }, null],
    [{ uses: "AtlaSent/atlasent-action@v1" }, null],
  ];
  for (const [step, want] of cases) {
    it(`${JSON.stringify(step)} -> ${want}`, () => {
      assert.equal(detectStep(step as never)?.category ?? null, want);
    });
  }

  for (const run of [
    "node scripts/resolve-function-deploy-targets.mjs",
    "node --test scripts/deploy-gate-acceptance.test.mjs",
    "deno run scripts/deploy-gate.ts",
    "node scripts/check-orphaned-live-deployments.mjs",
  ]) {
    it(`does not treat helper script "${run}" as a deploy`, () => {
      assert.equal(detectStep({ run }), null);
    });
  }

  it("does not treat install instructions printed by echo/printf as a deploy", () => {
    assert.equal(detectStep({ run: 'echo "## Published"\necho "helm install atlasent oci://x --version 1.0.0"' }), null);
    assert.equal(detectStep({ run: "printf '%s\\n' 'kubectl apply -f k8s/'" }), null);
  });

  it("still detects a real command that an echo line pipes into", () => {
    assert.equal(detectStep({ run: 'echo "$MANIFEST" | kubectl apply -f -' })?.detected_by, "kubectl");
    assert.equal(detectStep({ run: 'echo "deploying" && helm upgrade app ./chart' })?.detected_by, "helm upgrade/install");
  });

  it("marks a deploy script as 'possible', not certain", () => {
    const d = detectStep({ run: "./scripts/deploy.sh prod" });
    assert.equal(d?.category, "deploy");
    assert.equal(d?.confidence, "possible");
  });
});

describe("analyzeWorkflows", () => {
  it("reports an ungated helm upgrade as ungoverned, and ignores the commented-out kubectl", () => {
    const r = analyzeWorkflows(wf(UNGATED));
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].status, "ungoverned");
    assert.equal(r.findings[0].detected_by, "helm upgrade/install");
    assert.equal(r.findings[0].job, "deploy");
    assert.equal(r.summary.gaps, 1);
    assert.deepEqual(r.triggers[".github/workflows/deploy.yml"], ["push"]);
    assert.ok(r.findings[0].line > 0);
  });

  it("reports a step bound to the gate's verified output as bound", () => {
    const r = analyzeWorkflows(wf(BOUND));
    assert.equal(r.findings[0].status, "bound");
    assert.equal(r.summary.gaps, 0);
  });

  it("downgrades to gated when the verified binding is removed", () => {
    const r = analyzeWorkflows(wf(BOUND.replace("        if: steps.gate.outputs.verified == 'true'\n", "")));
    assert.equal(r.findings[0].status, "gated");
  });

  it("does not count a binding to a different step id", () => {
    const r = analyzeWorkflows(wf(BOUND.replace("steps.gate.outputs", "steps.other.outputs")));
    assert.equal(r.findings[0].status, "gated");
  });

  it("marks a gate with continue-on-error as weak", () => {
    const r = analyzeWorkflows(
      wf(BOUND.replace("        uses: AtlaSent/atlasent-action@v1\n", "        uses: AtlaSent/atlasent-action@v1\n        continue-on-error: true\n")),
    );
    assert.equal(r.findings[0].status, "weak");
    assert.match(r.findings[0].reason, /continue-on-error/);
  });

  it("marks a conditional gate as weak", () => {
    const r = analyzeWorkflows(
      wf(BOUND.replace("        id: gate\n", "        id: gate\n        if: inputs.skip_gate != 'true'\n")),
    );
    assert.equal(r.findings[0].status, "weak");
  });

  it("marks an evaluate-only permit that nothing consumes as weak", () => {
    const r = analyzeWorkflows(wf(BOUND.replace("          action: production.deploy\n", "          action: production.deploy\n          mode: evaluate-only\n")));
    assert.equal(r.findings[0].status, "weak");
    assert.match(r.findings[0].reason, /evaluate-only/);
  });

  it("does not count a gate that runs after the step", () => {
    const r = analyzeWorkflows(
      wf(`
jobs:
  d:
    steps:
      - run: npm publish
      - uses: AtlaSent/atlasent-action@v1
`),
    );
    assert.equal(r.findings[0].status, "ungoverned");
  });

  it("recognizes a custom gate script and says it was not inspected", () => {
    const r = analyzeWorkflows(
      wf(`
jobs:
  d:
    steps:
      - id: permit
        run: deno run -A scripts/deploy-gate.ts
      - run: supabase db push
`),
    );
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].status, "gated");
    assert.match(r.findings[0].reason, /not atlasent-action/);
  });

  it("treats a declared gate wrapper as a custom gate, and nothing else", () => {
    const src = `
jobs:
  d:
    steps:
      - uses: my-org/deploy-gate@v2
      - run: npm publish
`;
    assert.equal(analyzeWorkflows(wf(src)).findings[0].status, "ungoverned");
    const r = analyzeWorkflows(wf(src), ["my-org/deploy-gate"]);
    assert.equal(r.findings[0].status, "gated");
    assert.match(r.findings[0].reason, /not atlasent-action/);
    assert.equal(analyzeWorkflows(wf(src), ["my-org/deploy"]).findings[0].status, "ungoverned");
  });

  it("follows needs: transitively to an upstream gate", () => {
    const r = analyzeWorkflows(
      wf(`
jobs:
  gate:
    steps:
      - uses: AtlaSent/atlasent-action@v1
  build:
    needs: gate
    steps:
      - run: echo build
  ship:
    needs: [build]
    steps:
      - run: docker push ghcr.io/x/y:1
  other:
    steps:
      - run: docker push ghcr.io/x/z:1
`),
    );
    const byJob = Object.fromEntries(r.findings.map((f) => [f.job, f.status]));
    assert.deepEqual(byJob, { ship: "gated_upstream", other: "ungoverned" });
  });

  it("reports a skippable upstream gate as weak, not as no gate", () => {
    const r = analyzeWorkflows(
      wf(`
jobs:
  gate:
    steps:
      - if: \${{ !inputs.skip_gate }}
        uses: AtlaSent/atlasent-action@v1
  ship:
    needs: gate
    steps:
      - run: docker push ghcr.io/x/y:1
`),
    );
    assert.equal(r.findings[0].status, "weak");
    assert.match(r.findings[0].reason, /"gate"/);
  });

  it("reports unreadable files instead of dropping them", () => {
    const r = analyzeWorkflows([
      { path: "bad.yml", content: "jobs:\n  a:\n    steps:\n      - run: x\n     broken: indent\n" },
      { path: "notwf.yml", content: "name: x\n" },
    ]);
    assert.equal(r.summary.workflows_unreadable, 2);
    assert.equal(r.parse_errors.length, 2);
    assert.match(r.next_step, /could not be read/);
  });

  it("never reads a clean result as proof", () => {
    const r = analyzeWorkflows(wf("on: push\njobs:\n  t:\n    steps:\n      - run: npm test\n"));
    assert.equal(r.findings.length, 0);
    assert.match(r.next_step, /not proof/);
    assert.ok(r.not_checked.length > 0);
  });
});

describe("atlasent_evidence_gap_report tool", () => {
  it("returns the report over MCP without an API key or network", async () => {
    _resetRateLimitForTests();
    delete process.env.ATLASENT_API_KEY;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network must not be used");
    }) as typeof fetch;
    try {
      const server = createServer();
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await Promise.all([client.connect(ct), server.connect(st)]);
      const res = await client.callTool({ name: "atlasent_evidence_gap_report", arguments: { workflows: wf(UNGATED) } });
      assert.notEqual(res.isError, true);
      const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      assert.equal(body.report, "evidence_gap.v1");
      assert.equal(body.summary.by_status.ungoverned, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("review findings (Codex, #191): no false 'governed' results", () => {
  const status = (src: string) => analyzeWorkflows(wf(src)).findings.map((f) => f.status).join(",");
  const gated = (stepIf: string, gateExtra = "") => `
jobs:
  d:
    steps:
      - id: gate
        uses: AtlaSent/atlasent-action@v1${gateExtra}
      - if: ${stepIf}
        run: npm publish
`;
  it("bound requires verified == 'true', not a mention of the output", () => {
    assert.equal(status(gated("${{ always() && steps.gate.outputs.verified != 'true' }}")), "weak");
    assert.equal(status(gated("steps.gate.outputs.verified == 'false'")), "gated");
    assert.equal(status(gated("steps.gate.outputs.verified == 'true' || github.actor == 'x'")), "gated");
    assert.equal(
      status(gated("steps.gate.outputs.verified == 'true' && github.ref == 'refs/heads/main' || github.actor == 'x'")),
      "gated",
      "an || anywhere lets the step run without a verified permit",
    );
    assert.equal(status(gated("${{ steps.gate.outputs.verified == 'true' && github.ref == 'refs/heads/main' }}")), "bound");
  });
  it("a step that runs after failure (always/failure/cancelled) is weak", () => {
    assert.equal(status(gated("always()")), "weak");
    assert.equal(status(gated("${{ !cancelled() }}")), "weak");
    assert.equal(status(gated("success()")), "gated");
  });
  it("continue-on-error set by an expression counts as possibly on", () => {
    assert.equal(status(gated("steps.gate.outputs.verified == 'true'", "\n        continue-on-error: ${{ inputs.advisory }}")), "weak");
    assert.equal(status(gated("steps.gate.outputs.verified == 'true'", "\n        continue-on-error: false")), "bound");
  });
  it("tests and checks of a gate script are not gates", () => {
    assert.equal(
      status(`
jobs:
  d:
    steps:
      - run: node --test scripts/deploy-gate-acceptance.test.mjs
      - run: node scripts/check-deploy-gate.ts
      - run: npm publish
`),
      "ungoverned",
    );
  });
  it("a test runner invoking a real gate script is still a test, not a gate", () => {
    assert.equal(status("jobs:\n  d:\n    steps:\n      - run: node --test scripts/deploy-gate.mjs\n      - run: npm publish\n"), "ungoverned");
    assert.equal(status("jobs:\n  d:\n    steps:\n      - run: node scripts/deploy-gate.mjs\n      - run: npm publish\n"), "gated");
  });
  it("folds > block scalars before detecting commands", () => {
    assert.equal(status("jobs:\n  d:\n    steps:\n      - run: >\n          docker buildx build -t x\n          --push .\n"), "ungoverned");
  });
  it("a job that runs after its gate job fails, or a gate job that can be skipped or continue on error, is weak", () => {
    const up = (jobExtra: string, gateJobExtra = "") => `
jobs:
  gate:${gateJobExtra}
    steps:
      - uses: AtlaSent/atlasent-action@v1
  ship:
    needs: gate${jobExtra}
    steps:
      - run: npm publish
`;
    assert.equal(status(up("")), "gated_upstream");
    assert.equal(status(up("\n    if: always()")), "weak");
    assert.equal(status(up("", "\n    continue-on-error: true")), "weak");
    assert.equal(status(up("", "\n    if: github.event_name == 'push'")), "weak");
  });
});

describe("next action for a gap: a concrete fix, not sales copy", () => {
  /** Insert the fix's gate step before the flagged step and bind it, as a person would. */
  function applyFix(src: string, stepLine: number, fix: { gate_step?: string; bind_if?: string }): string {
    const lines = src.split("\n");
    const idx = stepLine - 1;
    const indent = lines[idx].length - lines[idx].trimStart().length;
    const pad = " ".repeat(indent);
    const gate = fix.gate_step ? fix.gate_step.split("\n").map((l) => pad + l) : [];
    // The step keeps its line; its binding goes right under the "- " line.
    return [...lines.slice(0, idx), ...gate, lines[idx], `${pad}  ${fix.bind_if}`, ...lines.slice(idx + 1)].join("\n");
  }

  it("an ungoverned step gets a gate step and binding that, applied, make it bound", () => {
    const src = `
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm publish --access public
`;
    const r = analyzeWorkflows(wf(src));
    const f = r.findings[0];
    assert.equal(f.status, "ungoverned");
    assert.ok(f.fix, "a gap carries a fix");
    assert.equal(f.fix!.action_type, "package.release");
    assert.match(f.fix!.gate_step!, /uses: AtlaSent\/atlasent-action@v1/);
    assert.equal(f.fix!.bind_if, "if: steps.atlasent_gate.outputs.verified == 'true'");
    const fixed = applyFix(src, f.line, f.fix!);
    const again = analyzeWorkflows(wf(fixed));
    assert.equal(again.findings.length, 1, fixed);
    assert.equal(again.findings[0].status, "bound", fixed);
    assert.equal(again.findings[0].fix, undefined);
  });

  it("maps each kind of step to an action type atlasent-action accepts", () => {
    const kind = (run: string) => analyzeWorkflows(wf(`jobs:\n  d:\n    steps:\n      - run: ${run}\n`)).findings[0].fix!;
    assert.equal(kind("helm upgrade --install api ./chart").action_type, "production.deploy");
    assert.equal(kind("terraform apply plan.tfplan").action_type, "infrastructure.change");
    const mig = kind("prisma migrate deploy");
    assert.equal(mig.action_type, "production.deploy");
    assert.match(mig.note!, /database\.migrate/);
  });

  it("asks for id-token: write only when the job lacks it and the action needs a verified workload", () => {
    const withPerms = `jobs:\n  d:\n    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - run: kubectl apply -f k.yaml\n`;
    assert.equal(analyzeWorkflows(wf(withPerms)).findings[0].fix!.job_permissions, undefined);
    assert.match(
      analyzeWorkflows(wf(`jobs:\n  d:\n    steps:\n      - run: kubectl apply -f k.yaml\n`)).findings[0].fix!.job_permissions!,
      /id-token: write/,
    );
    assert.equal(analyzeWorkflows(wf(`jobs:\n  d:\n    steps:\n      - run: npm publish\n`)).findings[0].fix!.job_permissions, undefined);
  });

  it("a weak gate gets the specific change, bound to the existing gate id", () => {
    const src = `
jobs:
  d:
    steps:
      - id: gate
        if: \${{ !inputs.skip_gate }}
        uses: AtlaSent/atlasent-action@v1
      - run: npm publish
`;
    const f = analyzeWorkflows(wf(src)).findings[0];
    assert.equal(f.status, "weak");
    assert.match(f.fix!.change!, /skip_gate|own `if:`/);
    assert.equal(f.fix!.bind_if, "if: steps.gate.outputs.verified == 'true'");
    assert.equal(f.fix!.gate_step, undefined, "fix the existing gate, do not add a second one");
  });

  it("keeps an existing condition when binding, and drops always()", () => {
    const f1 = analyzeWorkflows(wf(`jobs:\n  d:\n    steps:\n      - if: github.ref == 'refs/heads/main'\n        run: npm publish\n`)).findings[0];
    assert.equal(f1.fix!.bind_if, "if: ${{ (github.ref == 'refs/heads/main') && steps.atlasent_gate.outputs.verified == 'true' }}");
    const f2 = analyzeWorkflows(wf(`jobs:\n  d:\n    steps:\n      - if: always()\n        run: npm publish\n`)).findings[0];
    assert.equal(f2.fix!.bind_if, "if: steps.atlasent_gate.outputs.verified == 'true'");
    assert.match(f2.fix!.note!, /always/);
  });

  it("next_step and setup point at an attributable sign-up only when there are gaps", () => {
    const gap = analyzeWorkflows(wf(`jobs:\n  d:\n    steps:\n      - run: npm publish\n`));
    assert.match(gap.next_step, /utm_source=evidence-gap/);
    assert.match(gap.next_step, /ATLASENT_API_KEY/);
    assert.equal(gap.setup!.sign_up_url, "https://console.atlasent.io/auth/sign-up?utm_source=evidence-gap&utm_medium=mcp");
    const clean = analyzeWorkflows(
      wf(`jobs:\n  d:\n    steps:\n      - id: g\n        uses: AtlaSent/atlasent-action@v1\n      - if: steps.g.outputs.verified == 'true'\n        run: npm publish\n`),
    );
    assert.equal(clean.setup, undefined);
    assert.doesNotMatch(clean.next_step, /sign-up/);
  });

  it("does not suggest a second gate for a step already bound to an unrecognized one", () => {
    const f = analyzeWorkflows(
      wf(`jobs:\n  gate:\n    steps:\n      - uses: ./\n  ship:\n    needs: gate\n    steps:\n      - if: needs.gate.outputs.verified == 'true'\n        run: npm publish\n`),
    ).findings[0];
    assert.equal(f.status, "ungoverned");
    assert.equal(f.fix!.gate_step, undefined);
    assert.match(f.fix!.change!, /gate_actions/);
  });

  it("keeps every other term when it drops always(), and declines when a rewrite would change meaning", () => {
    const fix = (cond: string) =>
      analyzeWorkflows(wf(`jobs:\n  d:\n    steps:\n      - if: ${cond}\n        run: npm publish\n`)).findings[0].fix!;
    assert.equal(
      fix("${{ always() && github.ref == 'refs/heads/main' }}").bind_if,
      "if: ${{ (github.ref == 'refs/heads/main') && steps.atlasent_gate.outputs.verified == 'true' }}",
    );
    const handler = fix("failure()");
    assert.equal(handler.bind_if, undefined, "a failure() handler is not rewritten");
    assert.match(handler.note!, /by hand/);
    assert.equal(fix("${{ always() || github.ref == 'refs/heads/main' }}").bind_if, undefined);
  });

  it("only a positive binding to an unrecognized gate suppresses the gate step", () => {
    const fix = (cond: string) =>
      analyzeWorkflows(wf(`jobs:\n  d:\n    steps:\n      - if: ${cond}\n        run: npm publish\n`)).findings[0].fix!;
    assert.equal(fix("needs.g.outputs.verified == 'true'").gate_step, undefined);
    for (const unsafe of [
      "needs.g.outputs.verified != 'true'",
      "${{ !steps.g.outputs.verified }}",
      "needs.g.outputs.verified == 'true' || github.actor == 'x'",
    ]) {
      assert.ok(fix(unsafe).gate_step, unsafe);
    }
  });

  it("a weak upstream gate gets a gate in this job, and applying it makes the step bound", () => {
    const src = `
jobs:
  gate:
    if: github.event_name == 'push'
    steps:
      - uses: AtlaSent/atlasent-action@v1
  ship:
    needs: gate
    steps:
      - run: npm publish
`;
    const f = analyzeWorkflows(wf(src)).findings[0];
    assert.equal(f.status, "weak");
    assert.ok(f.fix!.gate_step);
    const again = analyzeWorkflows(wf(applyFix(src, f.line, f.fix!)));
    assert.equal(again.findings[0].status, "bound");
  });

  it("several gaps in one job get distinct gate ids that avoid existing step ids; applying all binds all", () => {
    let src = `
jobs:
  d:
    steps:
      - id: atlasent_gate
        run: echo unrelated
      - run: npm publish
      - run: docker push ghcr.io/x/y:1
`;
    const fixes = analyzeWorkflows(wf(src)).findings.map((f) => ({ line: f.line, fix: f.fix! }));
    const ids = fixes.map((x) => /id: (\S+)/.exec(x.fix.gate_step!)![1]);
    assert.deepEqual(ids, ["atlasent_gate_2", "atlasent_gate_3"]);
    // Apply bottom-up so earlier line numbers stay valid.
    for (const x of [...fixes].sort((a, b) => b.line - a.line)) src = applyFix(src, x.line, x.fix);
    const again = analyzeWorkflows(wf(src));
    assert.deepEqual(again.findings.map((f) => f.status), ["bound", "bound"]);
  });
});

// #261: a command handed to another shell, split by quotes or a line
// continuation, or built at run time, must never read as "no finding".
// Every case below returned null before this change.
describe("shell indirection (#261)", () => {
  for (const [run, by] of [
    ['echo start && bash -c "npm publish"', "npm publish"],
    ["echo 'kubectl apply -f k8s/' | bash", "kubectl"],
    ["printf 'npm publish' | sh -s", "npm publish"],
    ["env CI=1 sh -lc 'echo go; terraform apply -auto-approve'", "terraform apply"],
    ["terraform \\\n  apply -auto-approve", "terraform apply"],
    ["terra\\\nform apply -auto-approve", "terraform apply"],
    ['n"pm" publish', "npm publish"],
    ["bash -c 'bash -c \"cargo publish\"'", "cargo publish"],
    ["echo \"$(helm upgrade app ./chart)\"", "helm upgrade/install"],
  ] as const) {
    it(`sees through ${JSON.stringify(run)}`, () => {
      const d = detectStep({ run });
      assert.equal(d?.detected_by, by);
      assert.equal(d?.confidence, "certain");
    });
  }

  for (const run of [
    "$CMD",
    '"${DEPLOY_CMD}" --prod',
    'eval "$x"',
    "eval $(./generate.sh)",
    'bash -c "$VAR"',
    "sh -c '${{ inputs.command }}'",
    "${{ inputs.command }}",
    'echo "$SCRIPT" | bash',
    "OUT=$(eval \"$Y\")",
  ]) {
    it(`flags run-time command construction ${JSON.stringify(run)} as unknown, never passes it`, () => {
      const d = detectStep({ run });
      assert.equal(d?.category, "unknown");
      assert.equal(d?.confidence, "possible");
      assert.match(d?.detected_by ?? "", /^command built at run time: /);
    });
  }

  for (const run of [
    "echo \"bash -c 'npm publish'\"",
    'echo "Run: $CMD"',
    'case "$TARGET" in\n  prod) echo prod ;;\nesac',
    "for f in $FILES; do echo $f; done",
    'if [ "$X" = y ]; then echo ok; fi',
    "cat <<EOF > notes.txt\n$BODY\nEOF",
    "$GITHUB_WORKSPACE/scripts/build.sh",
    "FOO=$BAR",
    "npm ci 2>&1 | tee install.log",
    // Found by scanning real AtlaSent workflows: none of these runs a variable.
    'if [[ -z "$A" || "${B^^}" != "N/A" ]]; then echo x; fi',
    "DEADLINE=$(( $(date +%s) + 75 * 60 ))",
    '[ $(( ${#payload} % 4 )) -ne 0 ] && payload="${payload}="',
    'targets+=("$name")',
  ]) {
    it(`does not invent a finding for ${JSON.stringify(run)}`, () => {
      assert.equal(detectStep({ run }), null);
    });
  }

  it("reads pwsh and other non-POSIX shells literally (step shell or defaults.run.shell)", () => {
    const ps = "$gateTests = @(Get-ChildItem x)\n& $tool --version";
    assert.equal(detectStep({ run: ps, shell: "pwsh" }), null);
    assert.equal(detectStep({ run: ps }, [], "pwsh"), null);
    assert.equal(detectStep({ run: ps, shell: "bash" }, [], "pwsh")?.category, "unknown", "a step's own shell wins");
    const r = analyzeWorkflows(wf("on: push\ndefaults:\n  run:\n    shell: pwsh\njobs:\n  d:\n    steps:\n      - run: $x = 1\n"));
    assert.equal(r.findings.length, 0);
    // A literal deploy is still seen under any shell.
    assert.equal(detectStep({ run: "npm publish", shell: "pwsh" })?.detected_by, "npm publish");
  });

  it("a dynamic command with no gate is a gap; behind a bound gate it is bound", () => {
    const ungated = analyzeWorkflows(wf("on: push\njobs:\n  d:\n    steps:\n      - name: Run it\n        run: bash -c \"$DEPLOY\"\n"));
    assert.equal(ungated.findings[0].category, "unknown");
    assert.equal(ungated.findings[0].status, "ungoverned");
    assert.equal(ungated.summary.gaps, 1);
    assert.ok(ungated.findings[0].fix?.gate_step);
    const bound = analyzeWorkflows(wf(BOUND.replace("run: terraform apply -auto-approve plan.tfplan", 'run: eval "$CMD"')));
    assert.equal(bound.findings[0].category, "unknown");
    assert.equal(bound.findings[0].status, "bound");
  });
});

describe("flow-style workflows are analyzed, not skipped", () => {
  const wf = (steps: string, perms = "") =>
    `on: push\njobs:\n  ship:\n    runs-on: ubuntu-latest\n${perms}    steps:\n${steps}`;

  it("a step written as an inline map is found", () => {
    const r = analyzeWorkflows([{ path: "a.yml", content: wf("      - { name: Publish, run: npm publish }\n") }]);
    assert.deepEqual(r.parse_errors, []);
    assert.deepEqual(r.findings.map((f) => [f.step, f.category, f.status, f.line]), [["Publish", "publish", "ungoverned", 6]]);
  });

  it("a gate whose inputs are an inline map is recognized and binds the step", () => {
    const r = analyzeWorkflows([{
      path: "a.yml",
      content: wf("      - { id: gate, uses: atlasent-systems-inc/atlasent-action@v1, with: { action: package.release } }\n      - { if: \"steps.gate.outputs.verified == 'true'\", run: npm publish }\n"),
    }]);
    assert.deepEqual(r.findings.map((f) => f.status), ["bound"]);
  });

  it("inline permissions with id-token: write are honoured", () => {
    const content = wf("      - run: kubectl apply -f k8s/\n", "    permissions: { contents: read, id-token: write }\n");
    const fix = analyzeWorkflows([{ path: "a.yml", content }]).findings[0].fix;
    assert.equal(fix?.job_permissions, undefined);
    const without = analyzeWorkflows([{ path: "a.yml", content: wf("      - run: kubectl apply -f k8s/\n", "    permissions: { contents: read }\n") }]).findings[0].fix;
    assert.match(without?.job_permissions ?? "", /id-token: write/);
  });

  it("a malformed inline step makes the file unreadable, never clean", () => {
    const r = analyzeWorkflows([{ path: "a.yml", content: wf("      - { name: Publish, run: npm publish\n") }]);
    assert.equal(r.findings.length, 0);
    assert.equal(r.parse_errors.length, 1);
    assert.equal(r.summary.workflows_unreadable, 1);
  });
});
