import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT, collectWorkflows, esc, main, parseArgs, renderHtml } from "./exposureScanCli.js";
import { analyzeWorkflows } from "./evidenceGap.js";

const UNGATED = `name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to production
        run: npx vercel deploy --prod
`;

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "exposure-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, ".github", "workflows", n), c);
  return dir;
}

function quiet<T>(fn: () => T): T {
  const o = process.stdout.write, e = process.stderr.write;
  process.stdout.write = (() => true) as typeof o;
  process.stderr.write = (() => true) as typeof e;
  try { return fn(); } finally { process.stdout.write = o; process.stderr.write = e; }
}

describe("atlasent-exposure-scan", () => {
  it("parses args, with safe defaults and refusals", () => {
    assert.deepEqual(parseArgs([]), { dir: ".", out: ".", failOnGaps: false });
    assert.deepEqual(parseArgs(["r", "--out", "o", "--fail-on-gaps"]), { dir: "r", out: "o", failOnGaps: true });
    assert.ok("error" in parseArgs(["--out"]));
    assert.ok("error" in parseArgs(["--nope"]));
    assert.ok("error" in parseArgs(["a", "b"]));
  });

  it("reads only .yml/.yaml under .github/workflows, sorted", () => {
    const dir = repo({ "b.yaml": UNGATED, "a.yml": UNGATED, "notes.md": "x" });
    assert.deepEqual(collectWorkflows(dir).inputs.map((i) => i.path), [".github/workflows/a.yml", ".github/workflows/b.yaml"]);
  });

  it("writes html, md and json and reports the ungated deploy", () => {
    const dir = repo({ "deploy.yml": UNGATED });
    const out = join(dir, "out");
    assert.equal(quiet(() => main([dir, "--out", out], new Date("2026-10-12T12:00:00Z"))), EXIT.OK);
    const html = readFileSync(join(out, "atlasent-exposure-review.html"), "utf8");
    assert.match(html, /1 of 1 production-changing step can run with no approval/);
    assert.match(html, /What to fix/);
    assert.match(html, /<code>if: steps\.atlasent_gate\.outputs\.verified == &#39;true&#39;<\/code>/);
    assert.doesNotMatch(html, /if: if:/);
    assert.doesNotMatch(readFileSync(join(out, "atlasent-exposure-review.md"), "utf8"), /if: if:/);
    assert.match(html, /2026-10-12 12:00 UTC/);
    assert.ok(existsSync(join(out, "atlasent-exposure-review.md")));
    const json = JSON.parse(readFileSync(join(out, "atlasent-exposure-review.json"), "utf8"));
    assert.equal(json.summary.gaps, 1);
  });

  it("states its scope and loads nothing external", () => {
    const html = renderHtml(analyzeWorkflows([{ path: ".github/workflows/d.yml", content: UNGATED }]), {
      target: "r", generatedAt: "t", skipped: [],
    });
    assert.match(html, /not<\/strong> an assessment of your organization/);
    assert.doesNotMatch(html, /<script|<link |<img |@import|url\(/i);
  });

  it("escapes workflow-controlled text (a step name cannot inject markup)", () => {
    const evil = UNGATED.replace("Deploy to production", "<img src=x onerror=alert(1)>");
    const html = renderHtml(analyzeWorkflows([{ path: ".github/workflows/d.yml", content: evil }]), {
      target: "<b>r</b>", generatedAt: "t", skipped: [],
    });
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<b>r<\/b>/);
    assert.match(html, /&lt;img src=x/);
    assert.equal(esc(`<"'&>`), "&lt;&quot;&#39;&amp;&gt;");
  });

  it("--fail-on-gaps exits 1 on gaps; a repo with no workflows exits 2", () => {
    const dir = repo({ "deploy.yml": UNGATED });
    assert.equal(quiet(() => main([dir, "--out", join(dir, "o"), "--fail-on-gaps"])), EXIT.GAPS);
    const empty = mkdtempSync(join(tmpdir(), "exposure-empty-"));
    assert.equal(quiet(() => main([empty, "--out", join(empty, "o")])), EXIT.NO_WORKFLOWS);
    assert.ok(!existsSync(join(empty, "o", "atlasent-exposure-review.html")));
  });
});
