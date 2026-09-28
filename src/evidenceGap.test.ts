import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, _resetRateLimitForTests } from "./server.js";
import { analyzeWorkflows, detectStep, parseYamlSubset } from "./evidenceGap.js";

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
        uses: Atlasent/atlasent-action@v1
        with:
          action: production.deploy
      - name: Apply
        if: steps.gate.outputs.verified == 'true'
        run: terraform apply -auto-approve plan.tfplan
`;

describe("parseYamlSubset", () => {
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
`) as Record<string, any>;
    assert.deepEqual(doc.jobs.a.needs, ["b", "c"]);
    assert.equal(doc.jobs.a.steps[0].run, "echo one\necho two");
    assert.equal(doc.jobs.a.steps[1].uses, "x/y@v1");
  });

  it("folds a multi-line plain scalar", () => {
    const doc = parseYamlSubset(
      "jobs:\n  a:\n    steps:\n      - name: p\n        run: bash scripts/provision.sh \\\n          --org x\n        env: {}\n",
    ) as Record<string, any>;
    assert.match(doc.jobs.a.steps[0].run, /provision\.sh .*--org x/);
    assert.equal(doc.jobs.a.steps[0].env, "{}");
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
    [{ uses: "Atlasent/atlasent-action@v1" }, null],
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
      wf(BOUND.replace("        uses: Atlasent/atlasent-action@v1\n", "        uses: Atlasent/atlasent-action@v1\n        continue-on-error: true\n")),
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
      - uses: Atlasent/atlasent-action@v1
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
      - uses: Atlasent/atlasent-action@v1
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
        uses: Atlasent/atlasent-action@v1
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
        uses: Atlasent/atlasent-action@v1${gateExtra}
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
      - uses: Atlasent/atlasent-action@v1
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
