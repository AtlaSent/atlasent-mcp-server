import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { analyzeWorkflows } from "./evidenceGap.js";
import { renderExposureReview } from "./exposureReview.js";
import { renderHtml } from "./exposureScanCli.js";
import { classifyName, environmentOf, priorityOf, secretsOf, triggerOf } from "./findingContext.js";
import { CSV_COLUMNS, csvCell, renderCsv } from "./reportCsv.js";
import { STATUS_LABEL, STATUS_ORDER, headline } from "./reportModel.js";

// One workflow with every shape the ranking has to tell apart:
//   prod job: a gate with its own `if:` in front of a migration and a deploy (one cause, two steps)
//   staging job: an ungated deploy on the same push trigger
//   release job: needs a gated job and has no gate of its own (gated_upstream)
const MIXED = `
name: Ship
on:
  push:
    branches: [main]
  workflow_dispatch:
env:
  SHARED: \${{ secrets.SHARED_TOKEN }}
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - name: Gate
        id: gate
        uses: AtlaSent/atlasent-action@v1
        with:
          action: production.deploy
  release:
    needs: gate
    runs-on: ubuntu-latest
    steps:
      - name: Publish
        run: npm publish
  prod:
    runs-on: ubuntu-latest
    environment: production
    env:
      DB: \${{ secrets.DB_PASSWORD }}
    steps:
      - name: Permit
        id: permit
        if: \${{ inputs.skip_gate != true }}
        uses: AtlaSent/atlasent-action@v1
        with:
          action: production.deploy
      - name: Migrate
        run: supabase db push
      - name: Ship
        run: helm upgrade --install api ./chart
  staging:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - name: Ship to staging
        run: helm upgrade --install api ./chart
`;

const wf = (content: string, path = ".github/workflows/ship.yml") => [{ path, content }];

describe("one source of truth for every output", () => {
  it("the HTML shows every status with the same count as the Markdown (they once disagreed)", () => {
    const report = analyzeWorkflows(wf(MIXED));
    assert.ok(report.summary.by_status.gated_upstream > 0, "fixture must exercise gated_upstream");
    const md = renderExposureReview(report).markdown;
    const html = renderHtml(report, { target: "r", generatedAt: "t" });
    for (const k of STATUS_ORDER) {
      const n = report.summary.by_status[k];
      assert.ok(md.includes(`| ${STATUS_LABEL[k]} | ${n} |`), `md ${k}`);
      assert.match(html, new RegExp(`<div class="n">${n}</div><div class="l">${STATUS_LABEL[k].replace(/[,]/g, "\\$&")}</div>`), `html ${k}`);
    }
  });

  it("the headline, breakdown and fix-first order are the same in HTML and Markdown", () => {
    const report = analyzeWorkflows(wf(MIXED));
    const md = renderExposureReview(report).markdown;
    const html = renderHtml(report, { target: "r", generatedAt: "t" });
    const h = headline(report).text;
    assert.ok(md.includes(h));
    assert.ok(html.includes(h));
    const titles = report.causes.slice(0, 3).map((c) => c.title);
    const order = (doc: string) => titles.map((t) => doc.indexOf(t.replace(/"/g, doc === html ? "&quot;" : '"')));
    for (const doc of [md, html]) {
      const pos = order(doc);
      assert.ok(pos.every((p) => p >= 0), "every fix-first cause is listed");
      assert.deepEqual([...pos].sort((a, b) => a - b), pos, "in rank order");
    }
  });
});

describe("environment", () => {
  it("reads the job's environment first and says so", () => {
    const r = analyzeWorkflows(wf(MIXED));
    const migrate = r.findings.find((f) => f.step === "Migrate")!;
    assert.deepEqual(migrate.environment, { value: "production", source: 'job environment "production"' });
    assert.equal(r.findings.find((f) => f.step === "Ship to staging")!.environment.value, "non_production");
  });

  it("pre-prod is not prod; names that say nothing are unknown", () => {
    assert.equal(classifyName("pre-prod"), "non_production");
    assert.equal(classifyName("preprod"), "non_production");
    assert.equal(classifyName("deploy-production"), "production");
    assert.equal(classifyName("deploy_prod"), "production");
    assert.equal(classifyName("deliver"), null);
    assert.equal(classifyName("product-site"), null);
  });

  it("an environment chosen at run time is unknown, even under a job named prod", () => {
    const r = analyzeWorkflows(wf(`
on: push
jobs:
  prod:
    runs-on: ubuntu-latest
    environment: \${{ inputs.target }}
    steps:
      - run: helm upgrade --install api ./chart
`));
    assert.equal(r.findings[0].environment.value, "unknown");
    assert.match(r.findings[0].environment.source, /chosen at run time/);
  });

  it("a step environment input chosen at run time is unknown, even in a job named deploy-staging", () => {
    const job = { "runs-on": "ubuntu-latest" };
    const step = { uses: "some/deploy-action@v1", with: { environment: "${{ inputs.target }}" } };
    const e = environmentOf(job, "deploy-staging", step, ".github/workflows/ship.yml");
    assert.equal(e.value, "unknown");
    assert.match(e.source, /step's environment input is chosen at run time/);
    // A literal step input still decides.
    const literal = environmentOf(job, "deploy-staging", { ...step, with: { environment: "production" } }, ".github/workflows/ship.yml");
    assert.deepEqual(literal, { value: "production", source: 'step input environment "production"' });
  });

  it("falls back to the workflow file name, then to unknown", () => {
    const body = `
on: push
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: helm upgrade --install api ./chart
`;
    assert.equal(analyzeWorkflows(wf(body, ".github/workflows/deploy-prod.yml")).findings[0].environment.value, "production");
    assert.equal(analyzeWorkflows(wf(body, ".github/workflows/ship.yml")).findings[0].environment.value, "unknown");
  });
});

describe("trigger, secrets and priority", () => {
  it("push is automatic; a dispatch-only condition narrows it to manual", () => {
    assert.equal(triggerOf(["push", "workflow_dispatch"], "", "").kind, "automatic");
    const t = triggerOf(["push", "workflow_dispatch"], "github.event_name == 'workflow_dispatch'", "");
    assert.equal(t.kind, "manual");
    assert.match(t.narrowed_by ?? "", /job runs only on workflow_dispatch/);
    // An || means it can still run on push.
    assert.equal(triggerOf(["push"], "github.event_name == 'workflow_dispatch' || true", "").kind, "automatic");
    assert.equal(triggerOf(["workflow_call"], "", "").kind, "called");
    assert.equal(triggerOf(["repository_dispatch"], "", "").kind, "external");
  });

  it("a negated dispatch check does not narrow to manual; a required one does, in any spelling", () => {
    for (const cond of [
      "!(github.event_name == 'workflow_dispatch')",
      "${{ !(github.event_name == 'workflow_dispatch') }}",
      "!(inputs.x && github.event_name == 'workflow_dispatch')",
    ]) {
      assert.equal(triggerOf(["push", "workflow_dispatch"], cond, "").kind, "automatic", cond);
    }
    for (const cond of [
      "${{ github.event_name == 'workflow_dispatch' }}",
      "github.event_name == 'workflow_dispatch' && inputs.confirm == 'yes'",
      "(github.event_name == \"workflow_dispatch\")",
      "'workflow_dispatch' == github.event_name",
    ]) {
      assert.equal(triggerOf(["push", "workflow_dispatch"], cond, "").kind, "manual", cond);
    }
  });

  it("every event-driven trigger is automatic, including ones not listed (workflow_job, image_version)", () => {
    for (const e of ["workflow_job", "image_version", "push", "workflow_run"]) {
      const t = triggerOf([e], "", "");
      assert.equal(t.kind, "automatic", e);
      const p = priorityOf("deploy", { value: "production", source: "x" }, t, [], "certain");
      assert.ok(p.factors.includes(`runs automatically (${e})`), e);
    }
    assert.equal(triggerOf(["workflow_dispatch"], "", "").kind, "manual");
    assert.equal(triggerOf([], "", "").kind, "unknown");
  });

  it("reads bracket-form secret references by name", () => {
    const step = {
      run: "deploy",
      env: { A: "${{ secrets['DEPLOY_TOKEN'] }}", B: '${{ secrets[ "OTHER_KEY" ] }}', C: "${{ secrets.PLAIN }}" },
    };
    assert.deepEqual(secretsOf(step, {}, {}), ["DEPLOY_TOKEN", "OTHER_KEY", "PLAIN"]);
    // A computed index is not a fixed name and is not guessed at.
    assert.deepEqual(secretsOf({ run: "x", env: { A: "${{ secrets[inputs.name] }}" } }, {}, {}), []);
  });

  it("lists secret names from the step, job env and workflow env, never values", () => {
    const migrate = analyzeWorkflows(wf(MIXED)).findings.find((f) => f.step === "Migrate")!;
    assert.deepEqual(migrate.secrets, ["DB_PASSWORD", "SHARED_TOKEN"]);
  });

  it("a production migration on push with secrets is critical; an unknown environment outranks staging", () => {
    const auto = triggerOf(["push"], "", "");
    const p = priorityOf("migrate", { value: "production", source: "x" }, auto, ["A"], "certain");
    assert.deepEqual([p.label, p.score], ["critical", 100]);
    const unknown = priorityOf("deploy", { value: "unknown", source: "x" }, auto, [], "certain");
    const staging = priorityOf("deploy", { value: "non_production", source: "x" }, auto, [], "certain");
    assert.ok(unknown.score > staging.score);
    assert.ok(p.factors.includes("targets production"));
  });
});

describe("causes", () => {
  it("every step behind one skippable gate is one cause with one fix", () => {
    const r = analyzeWorkflows(wf(MIXED));
    const skippable = r.causes.find((c) => c.kind === "gate_skippable")!;
    assert.equal(skippable.findings.length, 2);
    assert.equal(skippable.gate?.step, "Permit");
    assert.match(skippable.fix_once ?? "", /Remove the gate step's own `if:`/);
    for (const i of skippable.findings) assert.equal(r.findings[i].cause, skippable.id);
    assert.equal(r.summary.causes, r.causes.length);
    assert.ok(r.summary.causes < r.summary.gaps);
    assert.match(renderExposureReview(r).markdown, /These 3 gaps come from 2 causes: fixing them closes all 3\./);
  });

  it("a gate weak in two ways gets a one-time fix that names both", () => {
    const r = analyzeWorkflows(wf(`
on: push
jobs:
  prod:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Permit
        id: gate
        if: \${{ !inputs.skip_gate }}
        continue-on-error: true
        uses: AtlaSent/atlasent-action@v1
        with:
          action: production.deploy
      - name: Deploy
        run: helm upgrade --install api ./chart
`));
    const cause = r.causes.find((c) => c.gate?.step === "Permit")!;
    assert.ok(cause, JSON.stringify(r.causes));
    assert.match(cause.fix_once ?? "", /continue-on-error/);
    assert.match(cause.fix_once ?? "", /own `if:`/);
  });

  it("ranks causes by their most urgent step; production first", () => {
    const r = analyzeWorkflows(wf(MIXED));
    assert.equal(r.causes[0].kind, "gate_skippable");
    assert.equal(r.causes[0].environments.production, 2);
    const scores = r.causes.map((c) => c.priority.score);
    assert.deepEqual([...scores].sort((a, b) => b - a), scores);
    assert.deepEqual(r.summary.gaps_by_environment, { production: 2, non_production: 1, unknown: 0 });
  });

  it("findings keep their original order; ranking lives in causes", () => {
    const r = analyzeWorkflows(wf(MIXED));
    const lines = r.findings.map((f) => f.line);
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b));
  });

  it("is deterministic", () => {
    assert.deepEqual(analyzeWorkflows(wf(MIXED)), analyzeWorkflows(wf(MIXED)));
  });
});

describe("headline", () => {
  it("never calls an undetermined environment staging", () => {
    const r = analyzeWorkflows(wf(`
on: push
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: helm upgrade --install api ./chart
`));
    assert.match(headline(r).text, /could not tell whether it changes production/);
  });

  it("reports staging-only gaps without claiming production is exposed", () => {
    const r = analyzeWorkflows(wf(`
on: push
jobs:
  staging:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - run: helm upgrade --install api ./chart
`));
    assert.equal(headline(r).text, "No production step can run ungated. 1 staging or test step can.");
  });
});

describe("CSV", () => {
  function parse(csv: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let q = false;
    const t = csv.replace(/^\uFEFF/, "");
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (q) {
        if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\r" && t[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
      else cell += ch;
    }
    return rows;
  }

  it("one row per step, ungated first in rank order, every row the same width", () => {
    const r = analyzeWorkflows(wf(MIXED));
    const rows = parse(renderCsv(r));
    assert.deepEqual(rows[0], [...CSV_COLUMNS]);
    assert.equal(rows.length - 1, r.findings.length);
    for (const row of rows) assert.equal(row.length, CSV_COLUMNS.length);
    const rank = rows.slice(1).map((x) => x[0]);
    assert.deepEqual(rank, ["1", "2", "3", ""]);
    assert.equal(rows[1][CSV_COLUMNS.indexOf("environment")], "Production");
  });

  it("a step name a spreadsheet would run as a formula is shown as text", () => {
    const evil = MIXED.replace("name: Migrate", 'name: "=HYPERLINK(""http://x"",""y"")"');
    const csv = renderCsv(analyzeWorkflows(wf(evil)));
    assert.doesNotMatch(csv, /(^|,)"?=HYPERLINK/m);
    assert.match(csv, /'=HYPERLINK/);
    assert.equal(csvCell("-1+2"), "'-1+2");
    assert.equal(csvCell("@cmd"), "'@cmd");
    assert.equal(csvCell('a,"b"'), '"a,""b"""');
    assert.equal(csvCell(5), "5");
  });
});
