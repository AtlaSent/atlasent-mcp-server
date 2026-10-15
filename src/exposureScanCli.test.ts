import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT, collectWorkflows, esc, isEntryPoint, main, parseArgs, renderHtml } from "./exposureScanCli.js";
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
      target: "r", generatedAt: "t",
    });
    assert.match(html, /not<\/strong> an assessment of your organization/);
    assert.doesNotMatch(html, /<script|<link |<img |@import|url\(/i);
  });

  it("escapes workflow-controlled text (a step name cannot inject markup)", () => {
    const evil = UNGATED.replace("Deploy to production", "<img src=x onerror=alert(1)>");
    const html = renderHtml(analyzeWorkflows([{ path: ".github/workflows/d.yml", content: evil }]), {
      target: "<b>r</b>", generatedAt: "t",
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

  it("recognizes itself when started through a bin link, as npm and npx do", () => {
    const real = join(mkdtempSync(join(tmpdir(), "bin-")), "exposureScanCli.js");
    writeFileSync(real, "");
    const link = join(mkdtempSync(join(tmpdir(), "bin-")), "atlasent-exposure-scan");
    symlinkSync(real, link);
    const url = pathToFileURL(real).href;
    assert.equal(isEntryPoint(link, url), true, "a link to this file is this file");
    assert.equal(isEntryPoint(real, url), true);
    assert.equal(isEntryPoint(join(tmpdir(), "other.js"), url), false);
    assert.equal(isEntryPoint(undefined, url), false);
  });

  it("the built bin, run through a link, writes the report", { skip: !existsSync(fileURLToPath(new URL("../dist/exposureScanCli.js", import.meta.url))) }, () => {
    const built = fileURLToPath(new URL("../dist/exposureScanCli.js", import.meta.url));
    const link = join(mkdtempSync(join(tmpdir(), "bin-")), "atlasent-exposure-scan");
    symlinkSync(built, link);
    const dir = repo({ "deploy.yml": UNGATED });
    const out = join(dir, "out");
    const r = spawnSync(process.execPath, [link, dir, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 with no gate that can stop them/);
    assert.ok(existsSync(join(out, "atlasent-exposure-review.html")));
  });

  // #261: completeness. A scan that did not read every workflow file must say
  // so in all three outputs and exit non-zero; it must not cap, skip or abort.
  const GATED = `on: push
jobs:
  d:
    steps:
      - id: gate
        uses: AtlaSent/atlasent-action@v1
      - if: steps.gate.outputs.verified == 'true'
        run: helm upgrade app ./chart
`;
  const outputs = (out: string) => ({
    html: readFileSync(join(out, "atlasent-exposure-review.html"), "utf8"),
    md: readFileSync(join(out, "atlasent-exposure-review.md"), "utf8"),
    json: JSON.parse(readFileSync(join(out, "atlasent-exposure-review.json"), "utf8")),
  });

  it("reads every workflow file: an ungated deploy in file 250 of 250 is found", () => {
    const files: Record<string, string> = {};
    for (let n = 0; n < 249; n++) files[`w${String(n).padStart(3, "0")}.yml`] = GATED;
    files["zz-last.yml"] = UNGATED;
    const dir = repo(files);
    const c = collectWorkflows(dir);
    assert.equal(c.inputs.length, 250);
    assert.equal(c.discovered, 250);
    assert.deepEqual(c.errors, []);
    const out = join(dir, "out");
    assert.equal(quiet(() => main([dir, "--out", out, "--fail-on-gaps"])), EXIT.GAPS);
    const { json } = outputs(out);
    assert.equal(json.scan.complete, true);
    assert.equal(json.scan.files_read, 250);
    assert.equal(json.summary.workflows_scanned, 250);
    assert.ok(json.findings.some((f: { workflow: string; status: string }) => f.workflow === ".github/workflows/zz-last.yml" && f.status === "ungoverned"));
  });

  it("a malformed workflow keeps every other finding and fails the scan, naming the file in md, json and html", () => {
    const dir = repo({
      "a-good.yml": GATED,
      "b-bad.yml": "jobs:\n  a:\n    steps:\n      - run: x\n     broken: indent\n",
      "c-ungated.yml": UNGATED,
    });
    const out = join(dir, "out");
    assert.equal(quiet(() => main([dir, "--out", out])), EXIT.INCOMPLETE);
    const { html, md, json } = outputs(out);
    assert.equal(json.scan.complete, false);
    assert.deepEqual(json.scan.errors.map((e: { path: string }) => e.path), [".github/workflows/b-bad.yml"]);
    assert.match(json.next_step, /INCOMPLETE SCAN/);
    assert.equal(json.findings.length, 2, "the good and the ungated file are still analyzed");
    assert.ok(json.findings.some((f: { status: string }) => f.status === "ungoverned"));
    assert.match(md, /## INCOMPLETE SCAN[\s\S]*b-bad\.yml/);
    assert.match(html, /INCOMPLETE SCAN[\s\S]*b-bad\.yml/);
  });

  it("an unreadable workflow (broken symlink) is an error, not a silent skip", () => {
    const dir = repo({ "a.yml": UNGATED });
    symlinkSync(join(dir, "nope.yml"), join(dir, ".github", "workflows", "dangling.yml"));
    const c = collectWorkflows(dir);
    assert.equal(c.discovered, 2);
    assert.deepEqual(c.errors.map((e) => e.path), [".github/workflows/dangling.yml"]);
    const out = join(dir, "out");
    assert.equal(quiet(() => main([dir, "--out", out])), EXIT.INCOMPLETE);
    const { html, md, json } = outputs(out);
    assert.equal(json.scan.files_discovered, 2);
    assert.equal(json.scan.files_read, 1);
    assert.match(md, /dangling\.yml/);
    assert.match(html, /dangling\.yml/);
    assert.equal(json.summary.gaps, 1, "the readable file's finding is kept");
  });

  it("a read failure is an error even when it is the only file, and never 'no workflows'", () => {
    const dir = repo({ "a.yml": UNGATED });
    const c = collectWorkflows(dir, () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); });
    assert.equal(c.inputs.length, 0);
    assert.match(c.errors[0].error, /EACCES/);
    const only = repo({});
    symlinkSync(join(only, "nope.yml"), join(only, ".github", "workflows", "only.yml"));
    const o = join(only, "out");
    assert.equal(quiet(() => main([only, "--out", o])), EXIT.INCOMPLETE);
    assert.match(outputs(o).md, /only\.yml/);
    if (process.getuid?.() !== 0) {
      chmodSync(join(dir, ".github", "workflows", "a.yml"), 0);
      const out = join(dir, "out");
      assert.equal(quiet(() => main([dir, "--out", out])), EXIT.INCOMPLETE);
      assert.equal(outputs(out).json.scan.complete, false);
    }
  });

  it("an oversized workflow is reported, not skipped", () => {
    const dir = repo({ "a.yml": UNGATED, "big.yml": UNGATED + "#".repeat(300 * 1024) });
    const c = collectWorkflows(dir);
    assert.deepEqual(c.errors.map((e) => e.path), [".github/workflows/big.yml"]);
    assert.equal(quiet(() => main([dir, "--out", join(dir, "o"), "--fail-on-gaps"])), EXIT.INCOMPLETE, "incomplete outranks gaps");
  });

  it("a complete, all-gated repo exits 0 and says complete", () => {
    const dir = repo({ "a.yml": GATED, "b.yml": GATED });
    const out = join(dir, "out");
    assert.equal(quiet(() => main([dir, "--out", out, "--fail-on-gaps"])), EXIT.OK);
    const { html, md, json } = outputs(out);
    assert.equal(json.scan.complete, true);
    assert.doesNotMatch(md, /INCOMPLETE/);
    assert.doesNotMatch(html, /INCOMPLETE/);
  });
});
