/**
 * Evidence-gap report: "where are my deploys ungoverned?"
 *
 *   atlasent_evidence_gap_report — read-only, offline, no account needed.
 *
 * The caller passes the text of its CI workflow files (GitHub Actions YAML).
 * The report finds every step that changes a real system (deploys, package
 * and image publishes, database migrations, infrastructure applies) and says,
 * per step, whether an AtlaSent gate stands in front of it:
 *
 *   bound                gate earlier in the same job, and the step runs only
 *                        `if: steps.<gate>.outputs.verified == 'true'`
 *   gated                gate earlier in the same job; the step is stopped
 *                        only by the gate step failing the job
 *   gated_upstream       gate in a job this job `needs:` (directly or not);
 *                        nothing re-verifies the permit where the step runs
 *   weak                 a gate exists but cannot stop the step: it has
 *                        `continue-on-error`, runs under its own `if:`, or
 *                        only issues a permit (`mode: evaluate-only`) that
 *                        nothing in the job consumes
 *   ungoverned           no gate at all
 *
 * What this is NOT, and the report says so every time (`not_checked`): it
 * reads only the files it is given. It cannot see branch protection, GitHub
 * Environment reviewers, deploys run from laptops or other CI systems, or
 * what a script like `./deploy.sh` does inside. A step with no finding is
 * not proof the step is governed; a `gated` step is not proof any policy
 * would say allow. It never calls the network, so it works in local mode.
 *
 * No YAML dependency: the server has two runtime deps and this keeps it that
 * way. The parser below covers the block-style subset GitHub workflows use
 * (maps, sequences, `- key:` items, `|`/`>` block scalars, flow lists for
 * `needs:`). Anything it cannot read is reported in `parse_errors`, never
 * silently dropped: a file we could not read is not a file with no gaps.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolResult } from "./decision.js";

// ---------------------------------------------------------------------------
// Minimal YAML (block subset) → plain values, with line numbers for objects.
// ---------------------------------------------------------------------------

type YValue = string | YValue[] | YMap;
interface YMap {
  [key: string]: YValue;
}

interface Line {
  indent: number;
  text: string;
  no: number; // 1-based source line
}

/** Line number of the key/item that introduced each map. */
const LINE_OF = new WeakMap<object, number>();

export class YamlSubsetError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
  }
}

function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function scalar(raw: string): YValue {
  const t = raw.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((p) => unquote(p));
  }
  return unquote(t);
}

/** Split `key: value` at the first `:` followed by space/end, outside quotes. */
function splitKey(text: string): [string, string] | null {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === ":" && (i === text.length - 1 || text[i + 1] === " ")) {
      return [unquote(text.slice(0, i)), text.slice(i + 1).trim()];
    }
  }
  return null;
}

export function parseYamlSubset(source: string): YValue {
  const raw = source.replace(/\r\n?/g, "\n").split("\n");
  const lines: Line[] = [];
  // Pre-scan: collect block scalars into single synthetic lines so the
  // structural parser never sees shell script text.
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (/^\s*(#.*)?$/.test(r) || /^(---|\.\.\.)\s*$/.test(r)) continue;
    const indent = r.length - r.trimStart().length;
    if (r.slice(0, indent).includes("\t")) throw new YamlSubsetError("tab indentation", i + 1);
    let text = stripComment(r.trimStart()).trimEnd();
    const block = /^(.*?:\s*|-\s+|-\s*.*?:\s*)([|>])[+-]?\d*$/.exec(text);
    if (block) {
      const body: string[] = [];
      let j = i + 1;
      while (j < raw.length) {
        const b = raw[j];
        const bi = b.length - b.trimStart().length;
        if (b.trim() !== "" && bi <= indent) break;
        body.push(b.trim() === "" ? "" : b);
        j++;
      }
      const minIndent = Math.min(
        ...body.filter((b) => b !== "").map((b) => b.length - b.trimStart().length),
      );
      const joined = body.map((b) => (b === "" ? "" : b.slice(minIndent))).join("\n");
      text = block[1] + JSON.stringify(joined); // stored as a quoted scalar
      lines.push({ indent, text, no: i + 1 });
      i = j - 1;
      continue;
    }
    lines.push({ indent, text, no: i + 1 });
  }

  let pos = 0;

  function parseScalarLiteral(v: string): YValue {
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      try {
        return JSON.parse(v) as string;
      } catch {
        return unquote(v);
      }
    }
    return scalar(v);
  }

  function parseNode(indent: number): YValue {
    const first = lines[pos];
    if (!first || first.indent < indent) return "";
    if (first.text === "-" || first.text.startsWith("- ")) return parseSeq(first.indent);
    return parseMap(first.indent);
  }

  function parseValueAfterKey(keyIndent: number, value: string): YValue {
    if (value !== "") return parseScalarLiteral(value);
    const next = lines[pos];
    if (!next) return "";
    // A sequence may sit at the same indent as its key (`steps:\n- run: x`).
    if (next.indent > keyIndent || (next.indent === keyIndent && (next.text === "-" || next.text.startsWith("- ")))) {
      return parseNode(next.indent);
    }
    return "";
  }

  function parseMap(indent: number): YMap {
    const map: YMap = {};
    LINE_OF.set(map, lines[pos]?.no ?? 0);
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.indent < indent) break;
      if (l.indent > indent) throw new YamlSubsetError("unexpected indentation", l.no);
      if (l.text === "-" || l.text.startsWith("- ")) break;
      const kv = splitKey(l.text);
      if (!kv) throw new YamlSubsetError(`expected "key: value", got "${l.text.slice(0, 60)}"`, l.no);
      pos++;
      let value = kv[1];
      // Multi-line plain scalar: more-indented lines continue the value
      // (`run: bash x.sh \` followed by indented flag lines).
      if (value !== "" && !/^["'[{]/.test(value)) {
        while (pos < lines.length && lines[pos].indent > indent) {
          value += " " + lines[pos].text;
          pos++;
        }
      }
      map[kv[0]] = parseValueAfterKey(indent, value);
    }
    return map;
  }

  function parseSeq(indent: number): YValue[] {
    const seq: YValue[] = [];
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.indent !== indent || !(l.text === "-" || l.text.startsWith("- "))) {
        if (l.indent > indent) throw new YamlSubsetError("unexpected indentation", l.no);
        break;
      }
      const rest = l.text === "-" ? "" : l.text.slice(2).trimStart();
      const itemIndent = indent + (l.text.length - rest.length);
      if (rest === "") {
        pos++;
        seq.push(parseNode(indent + 1));
      } else if (splitKey(rest) && !rest.startsWith('"') && !rest.startsWith("'")) {
        // `- key: value` opens a map whose keys sit at itemIndent.
        lines[pos] = { indent: itemIndent, text: rest, no: l.no };
        seq.push(parseMap(itemIndent));
      } else {
        pos++;
        seq.push(parseScalarLiteral(rest));
      }
    }
    return seq;
  }

  if (lines.length === 0) return {};
  const root = parseNode(0);
  if (pos < lines.length) throw new YamlSubsetError("could not parse past this line", lines[pos].no);
  return root;
}

// ---------------------------------------------------------------------------
// Consequential-step detection
// ---------------------------------------------------------------------------

export type Category = "deploy" | "publish" | "migrate" | "infrastructure";

interface Detector {
  category: Category;
  re: RegExp;
  label: string;
}

const RUN_DETECTORS: Detector[] = [
  { category: "infrastructure", re: /\bterraform\s+(-chdir=\S+\s+)?apply\b/, label: "terraform apply" },
  { category: "infrastructure", re: /\btofu\s+apply\b/, label: "tofu apply" },
  { category: "infrastructure", re: /\bpulumi\s+up\b/, label: "pulumi up" },
  { category: "infrastructure", re: /\bcdk\s+deploy\b/, label: "cdk deploy" },
  { category: "infrastructure", re: /\baws\s+cloudformation\s+(deploy|update-stack|create-stack)\b/, label: "aws cloudformation" },
  { category: "infrastructure", re: /\bansible-playbook\b/, label: "ansible-playbook" },
  { category: "deploy", re: /\bkubectl\s+(apply|rollout|set\s+image|replace|patch|delete)\b/, label: "kubectl" },
  { category: "deploy", re: /\bhelm\s+(upgrade|install|uninstall|rollback)\b/, label: "helm upgrade/install" },
  { category: "deploy", re: /\b(serverless|sls)\s+deploy\b/, label: "serverless deploy" },
  { category: "deploy", re: /\baws\s+ecs\s+update-service\b/, label: "aws ecs update-service" },
  { category: "deploy", re: /\baws\s+lambda\s+update-function-code\b/, label: "aws lambda update-function-code" },
  { category: "deploy", re: /\baws\s+s3\s+sync\b/, label: "aws s3 sync" },
  { category: "deploy", re: /\bgcloud\s+(run|app|functions)\s+deploy\b/, label: "gcloud deploy" },
  { category: "deploy", re: /\baz\s+(webapp|functionapp|containerapp)\s+(deploy|up|update)\b/, label: "az deploy" },
  { category: "deploy", re: /\bfirebase\s+deploy\b/, label: "firebase deploy" },
  { category: "deploy", re: /\bwrangler\s+(deploy|publish)\b/, label: "wrangler deploy" },
  { category: "deploy", re: /\bvercel\b[^\n]*(--prod\b|\bdeploy\b)/, label: "vercel deploy" },
  { category: "deploy", re: /\bnetlify\s+deploy\b/, label: "netlify deploy" },
  { category: "deploy", re: /\b(flyctl|fly)\s+deploy\b/, label: "fly deploy" },
  { category: "deploy", re: /\brailway\s+up\b/, label: "railway up" },
  { category: "deploy", re: /\beb\s+deploy\b/, label: "eb deploy" },
  { category: "deploy", re: /\bgit\s+push\s+\S*heroku\b/, label: "git push heroku" },
  { category: "deploy", re: /\bsupabase\s+functions\s+deploy\b/, label: "supabase functions deploy" },
  { category: "migrate", re: /\bsupabase\s+db\s+push\b/, label: "supabase db push" },
  { category: "migrate", re: /\bprisma\s+migrate\s+deploy\b/, label: "prisma migrate deploy" },
  { category: "migrate", re: /\balembic\s+upgrade\b/, label: "alembic upgrade" },
  { category: "migrate", re: /\bflyway\b[^\n]*\bmigrate\b/, label: "flyway migrate" },
  { category: "migrate", re: /\b(rails|rake)\s+db:migrate\b/, label: "db:migrate" },
  { category: "migrate", re: /\bmanage\.py\s+migrate\b/, label: "django migrate" },
  { category: "migrate", re: /\bknex\s+migrate:latest\b/, label: "knex migrate" },
  { category: "publish", re: /\b(npm|pnpm)\s+publish\b/, label: "npm publish" },
  { category: "publish", re: /\byarn\s+(npm\s+)?publish\b/, label: "yarn publish" },
  { category: "publish", re: /\btwine\s+upload\b/, label: "twine upload" },
  { category: "publish", re: /\b(poetry|uv|hatch|flit)\s+publish\b/, label: "python publish" },
  { category: "publish", re: /\bcargo\s+publish\b/, label: "cargo publish" },
  { category: "publish", re: /\bgem\s+push\b/, label: "gem push" },
  { category: "publish", re: /\bdotnet\s+nuget\s+push\b/, label: "nuget push" },
  { category: "publish", re: /\bmvn\b[^\n]*\bdeploy\b/, label: "mvn deploy" },
  { category: "publish", re: /\bgradlew?\b[^\n]*\bpublish/, label: "gradle publish" },
  { category: "publish", re: /\b(docker|podman)\s+push\b/, label: "docker push" },
  { category: "publish", re: /\bdocker\s+buildx\s+build\b[^\n]*--push\b/, label: "docker buildx --push" },
  { category: "publish", re: /\bhelm\s+push\b/, label: "helm push" },
  { category: "publish", re: /\bgh\s+release\s+create\b/, label: "gh release create" },
];

/**
 * Scripts whose name says deploy/release/publish/migrate. We cannot see
 * inside them, so they are reported with confidence "possible". The name has
 * to START with the verb (deploy.sh, release-prod.sh), so helpers such as
 * resolve-deploy-targets.mjs do not count, and test/check/gate/verify
 * scripts are excluded outright.
 */
const SCRIPT_PATH = /(?:^|[\s;&|(])((?:\.{0,2}\/)?(?:[\w.-]+\/)*((?:deploy|release|publish|migrate)(?:[-_.][\w-]*)?\.(?:sh|bash|py|js|mjs|cjs|ts|rb)))\b/g;
const SCRIPT_EXCLUDE = /(test|spec|check|verify|gate|lint|plan|dry[-_]?run|preview)/i;
const MAKE_OR_NPM = /\b(make\s+(deploy|release|publish|migrate)\b|(npm|pnpm|yarn)\s+(run\s+)?(deploy|release)\b)/;

function scriptHint(run: string): string | null {
  for (const m of run.matchAll(SCRIPT_PATH)) {
    if (!SCRIPT_EXCLUDE.test(m[2])) return m[1];
  }
  const mk = MAKE_OR_NPM.exec(run);
  return mk ? mk[0] : null;
}

const USES_DETECTORS: Array<{ category: Category; re: RegExp; label: string }> = [
  { category: "deploy", re: /^aws-actions\/amazon-ecs-deploy-task-definition@/i, label: "ECS deploy action" },
  { category: "deploy", re: /^azure\/(webapps|functions|container-apps|k8s)-deploy@/i, label: "Azure deploy action" },
  { category: "deploy", re: /^google-github-actions\/deploy-/i, label: "GCP deploy action" },
  { category: "deploy", re: /^actions\/deploy-pages@/i, label: "GitHub Pages deploy" },
  { category: "deploy", re: /^(JamesIves\/github-pages-deploy-action|peaceiris\/actions-gh-pages)@/i, label: "GitHub Pages deploy" },
  { category: "deploy", re: /^(amondnet\/vercel-action|superfly\/flyctl-actions|cloudflare\/wrangler-action|cloudflare\/pages-action)/i, label: "hosting deploy action" },
  { category: "deploy", re: /^akhileshns\/heroku-deploy@/i, label: "Heroku deploy action" },
  { category: "infrastructure", re: /^pulumi\/actions@/i, label: "Pulumi action" },
  { category: "publish", re: /^pypa\/gh-action-pypi-publish@/i, label: "PyPI publish action" },
  { category: "publish", re: /^softprops\/action-gh-release@/i, label: "GitHub release action" },
];

function isGateUses(uses: string): boolean {
  return /(^|\/)atlasent-action(@|\/)/i.test(uses);
}

function runWithoutComments(run: string): string {
  return run
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

interface Detection {
  category: Category;
  detected_by: string;
  confidence: "certain" | "possible";
}

export function detectStep(step: YMap, extraGates: string[] = []): Detection | null {
  const uses = typeof step.uses === "string" ? step.uses : "";
  const run = typeof step.run === "string" ? runWithoutComments(step.run) : "";
  const withMap = step.with && typeof step.with === "object" && !Array.isArray(step.with) ? (step.with as YMap) : {};
  if (uses && (isGateUses(uses) || extraGates.includes(uses))) return null;
  for (const d of USES_DETECTORS) {
    if (d.re.test(uses)) return { category: d.category, detected_by: `uses: ${uses}`, confidence: "certain" };
  }
  if (/^docker\/build-push-action@/i.test(uses) && String(withMap.push ?? "").trim() === "true") {
    return { category: "publish", detected_by: "docker/build-push-action with push: true", confidence: "certain" };
  }
  if (/^pulumi\/actions@/i.test(uses)) return null;
  if (uses && /^hashicorp\/setup-terraform/i.test(uses)) return null;
  if (run) {
    for (const d of RUN_DETECTORS) {
      if (d.re.test(run)) return { category: d.category, detected_by: d.label, confidence: "certain" };
    }
    const hint = scriptHint(run);
    if (hint) {
      const cat: Category = /migrate/.test(hint) ? "migrate" : /publish|release/.test(hint) ? "publish" : "deploy";
      return { category: cat, detected_by: `script: ${hint}`, confidence: "possible" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gate classification
// ---------------------------------------------------------------------------

export type GapStatus = "bound" | "gated" | "gated_upstream" | "weak" | "ungoverned";

interface GateInfo {
  index: number;
  id: string | null;
  issuesOnly: boolean; // mode: evaluate-only
  verifies: boolean; // enforce mode, or verify-permit: true
  advisory: boolean; // continue-on-error
  conditional: boolean; // has its own `if:`
  custom: boolean; // your own script or curl, not atlasent-action; not inspected
}

function truthy(v: YValue | undefined): boolean {
  return typeof v === "string" && /^(true|'true'|"true")$/i.test(v.trim());
}

function gateInfo(step: YMap, index: number, extraGates: string[] = []): GateInfo | null {
  const run = typeof step.run === "string" ? runWithoutComments(step.run) : "";
  const uses = typeof step.uses === "string" ? step.uses : "";
  const w = step.with && typeof step.with === "object" && !Array.isArray(step.with) ? (step.with as YMap) : {};
  let issuesOnly = false;
  let verifies = false;
  let custom = false;
  const declared = !!uses && extraGates.some((g) => uses === g || uses.startsWith(g.endsWith("@") ? g : `${g}@`));
  if (uses && (isGateUses(uses) || declared)) {
    custom = declared && !isGateUses(uses);
    const mode = typeof w.mode === "string" ? w.mode.trim() : "";
    const verifyPermit = truthy(w["verify-permit"]);
    issuesOnly = mode === "evaluate-only" && !verifyPermit;
    verifies = !issuesOnly;
  } else if (/\/v1[-/]verify-permit\b/.test(run)) {
    verifies = true;
    custom = true;
  } else if (/(?:^|[\s/])[\w.-]*(?:atlasent|permit|deploy|release)[-_]gate[\w.-]*\.(?:sh|bash|py|js|mjs|cjs|ts)\b/i.test(run)) {
    // A gate script of your own (e.g. scripts/deploy-gate.ts). Its logic is
    // not inspected; the report says so on every step it covers.
    verifies = true;
    custom = true;
  } else if (/\/v1[-/]evaluate\b/.test(run)) {
    issuesOnly = true;
    custom = true;
  } else {
    return null;
  }
  return {
    index,
    id: typeof step.id === "string" ? step.id : null,
    issuesOnly,
    verifies,
    advisory: truthy(step["continue-on-error"]),
    conditional: typeof step.if === "string" && step.if.trim() !== "",
    custom,
  };
}

function needsOf(job: YMap): string[] {
  const n = job.needs;
  if (typeof n === "string") return n.trim() === "" ? [] : [n.trim()];
  if (Array.isArray(n)) return n.filter((x): x is string => typeof x === "string");
  return [];
}

function stepsOf(job: YMap): YMap[] {
  return Array.isArray(job.steps)
    ? job.steps.filter((s): s is YMap => !!s && typeof s === "object" && !Array.isArray(s))
    : [];
}

function enforcingGate(g: GateInfo): boolean {
  return g.verifies && !g.advisory && !g.conditional;
}

export interface Finding {
  workflow: string;
  job: string;
  step: string;
  line: number;
  category: Category;
  detected_by: string;
  confidence: "certain" | "possible";
  status: GapStatus;
  reason: string;
}

export interface WorkflowInput {
  path: string;
  content: string;
}

export interface EvidenceGapReport {
  report: "evidence_gap.v1";
  summary: {
    workflows_scanned: number;
    workflows_unreadable: number;
    consequential_steps: number;
    by_status: Record<GapStatus, number>;
    gaps: number;
  };
  findings: Finding[];
  triggers: Record<string, string[]>;
  parse_errors: Array<{ workflow: string; line: number; error: string }>;
  not_checked: string[];
  next_step: string;
}

const NOT_CHECKED = [
  "Only the workflow files passed in were read. Pass every file under .github/workflows/ for a complete picture.",
  "Branch protection, required reviewers and GitHub Environment protection rules live in repository settings, not in these files.",
  "Deploys run from laptops, other CI systems, or cloud consoles are invisible here.",
  "What a script such as ./deploy.sh does inside is not inspected; such steps are reported with confidence 'possible'.",
  "A 'gated' or 'bound' step has a gate in front of it. That is not proof your policy would allow it, or that the gate's API key is set.",
  "Reusable workflows called with `uses:` at job level are listed as their own job but not followed into the called file.",
];

function emptyCounts(): Record<GapStatus, number> {
  return { bound: 0, gated: 0, gated_upstream: 0, weak: 0, ungoverned: 0 };
}

function triggerNames(on: YValue | undefined): string[] {
  if (typeof on === "string") return on.trim() ? [on.trim()] : [];
  if (Array.isArray(on)) return on.filter((x): x is string => typeof x === "string");
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

/**
 * @param gateActions extra `uses:` values the caller declares as its gate:
 *   a wrapper composite action, or `./` inside the atlasent-action repo.
 *   Matched exactly or as `<value>@<ref>`; reported as custom gates.
 */
export function analyzeWorkflows(inputs: WorkflowInput[], gateActions: string[] = []): EvidenceGapReport {
  const findings: Finding[] = [];
  const parseErrors: EvidenceGapReport["parse_errors"] = [];
  const triggers: Record<string, string[]> = {};

  for (const wf of inputs) {
    let doc: YValue;
    try {
      doc = parseYamlSubset(wf.content);
    } catch (e) {
      parseErrors.push({
        workflow: wf.path,
        line: e instanceof YamlSubsetError ? e.line : 0,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc) || !doc.jobs || typeof doc.jobs !== "object" || Array.isArray(doc.jobs)) {
      parseErrors.push({ workflow: wf.path, line: 0, error: "no top-level `jobs:` map; not a GitHub Actions workflow" });
      continue;
    }
    // Scalars are never coerced here, so `on:` stays the string key "on".
    triggers[wf.path] = triggerNames(doc.on);
    const jobs = doc.jobs as YMap;

    // Which jobs carry a gate, and whether it can actually stop anything.
    const jobGate = new Map<string, "enforcing" | "weak">();
    for (const [name, job] of Object.entries(jobs)) {
      if (!job || typeof job !== "object" || Array.isArray(job)) continue;
      const gs = stepsOf(job as YMap)
        .map((s, i) => gateInfo(s, i, gateActions))
        .filter((g): g is GateInfo => !!g);
      if (gs.some(enforcingGate)) jobGate.set(name, "enforcing");
      else if (gs.length > 0) jobGate.set(name, "weak");
    }
    // Nearest gate in the needs: graph; an enforcing one wins over a weak one.
    const upstreamGate = (name: string): { job: string; kind: "enforcing" | "weak" } | null => {
      const seen = new Set<string>();
      let weak: string | null = null;
      const walk = (n: string): string | null => {
        const job = jobs[n];
        if (!job || typeof job !== "object" || Array.isArray(job)) return null;
        for (const dep of needsOf(job as YMap)) {
          if (seen.has(dep)) continue;
          seen.add(dep);
          const kind = jobGate.get(dep);
          if (kind === "enforcing") return dep;
          if (kind === "weak" && !weak) weak = dep;
          const deeper = walk(dep);
          if (deeper) return deeper;
        }
        return null;
      };
      const found = walk(name);
      if (found) return { job: found, kind: "enforcing" };
      return weak ? { job: weak, kind: "weak" } : null;
    };

    for (const [jobName, jobVal] of Object.entries(jobs)) {
      if (!jobVal || typeof jobVal !== "object" || Array.isArray(jobVal)) continue;
      const job = jobVal as YMap;
      const steps = stepsOf(job);
      const gates: GateInfo[] = [];
      steps.forEach((s, i) => {
        const g = gateInfo(s, i, gateActions);
        if (g) gates.push(g);
      });

      steps.forEach((step, i) => {
        const det = detectStep(step, gateActions);
        if (!det) return;
        const earlier = gates.filter((g) => g.index < i);
        const stepIf = typeof step.if === "string" ? step.if : "";
        let status: GapStatus;
        let reason: string;
        const enforcing = earlier.filter(enforcingGate);
        const bound = enforcing.find(
          (g) => g.id && new RegExp(`steps\\.${g.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.outputs\\.verified`).test(stepIf),
        );
        if (bound) {
          status = "bound";
          reason = `Runs only if gate step "${bound.id}" reported verified == 'true'.`;
          if (bound.custom) reason += " The gate is your own script or wrapper, not atlasent-action; whether it fails closed was not inspected.";
        } else if (enforcing.length > 0) {
          status = "gated";
          reason =
            "An AtlaSent gate runs earlier in this job, so a deny fails the job before this step. " +
            "Add `if: steps.<gate-id>.outputs.verified == 'true'` to bind the step to the verified permit.";
          if (enforcing.every((g) => g.custom)) {
            reason += " The gate is your own script or wrapper, not atlasent-action; whether it fails closed was not inspected.";
          }
        } else if (earlier.length > 0) {
          const g = earlier[earlier.length - 1];
          status = "weak";
          reason = g.advisory
            ? "The gate step has continue-on-error, so a deny does not stop this step."
            : g.conditional
              ? "The gate step runs under its own `if:`, so it can be skipped while this step still runs."
              : "The gate only issues a permit (evaluate-only); nothing in this job verifies and consumes it before this step.";
        } else {
          const up = upstreamGate(jobName);
          if (up?.kind === "enforcing") {
            status = "gated_upstream";
            reason =
              `Gated in job "${up.job}", which this job needs. Nothing re-verifies the permit where this step runs; ` +
              "a verify-permit step in this job would bind the permit to the execution.";
          } else if (up) {
            status = "weak";
            reason =
              `Job "${up.job}", which this job needs, has a gate that cannot stop this step ` +
              "(continue-on-error, its own `if:`, or evaluate-only with nothing consuming the permit).";
          } else {
            status = "ungoverned";
            reason = "No AtlaSent gate in this job or in any job it needs.";
          }
        }
        findings.push({
          workflow: wf.path,
          job: jobName,
          step: typeof step.name === "string" ? step.name : typeof step.uses === "string" ? step.uses : `step ${i + 1}`,
          line: LINE_OF.get(step) ?? 0,
          ...det,
          status,
          reason,
        });
      });
    }
  }

  const counts = emptyCounts();
  for (const f of findings) counts[f.status]++;
  const gaps = counts.ungoverned + counts.weak;
  const scanned = inputs.length - parseErrors.length;

  let next: string;
  if (inputs.length === 0) {
    next = "Pass the contents of your .github/workflows/*.yml files as `workflows`.";
  } else if (findings.length === 0) {
    next =
      parseErrors.length > 0
        ? "Some files could not be read (see parse_errors); no conclusion can be drawn about them."
        : "No deploy, publish, migrate or infrastructure steps were recognized in these files. That is not proof there are none.";
  } else if (gaps > 0) {
    next =
      "Put an AtlaSent gate (github.com/Atlasent/atlasent-action) in front of each ungoverned or weak step, " +
      "and bind the step with `if: steps.<gate-id>.outputs.verified == 'true'`.";
  } else {
    next = "Every recognized step has a gate in front of it. Bind 'gated' steps to the gate's verified output to close the remaining distance.";
  }

  return {
    report: "evidence_gap.v1",
    summary: {
      workflows_scanned: scanned,
      workflows_unreadable: parseErrors.length,
      consequential_steps: findings.length,
      by_status: counts,
      gaps,
    },
    findings,
    triggers,
    parse_errors: parseErrors,
    not_checked: NOT_CHECKED,
    next_step: next,
  };
}

// ---------------------------------------------------------------------------
// MCP registration
// ---------------------------------------------------------------------------

const MAX_FILES = 100;
const MAX_FILE_BYTES = 256 * 1024;

export function registerEvidenceGapTool(server: McpServer, rateLimitOk: (tool: string) => boolean): void {
  server.registerTool(
    "atlasent_evidence_gap_report",
    {
      title: "Evidence Gap Report (where are my deploys ungoverned?)",
      description:
        "Scan CI workflow files for steps that change real systems (deploys, package and image publishes, " +
        "database migrations, terraform/pulumi applies) and report, per step, whether an AtlaSent gate stands " +
        "in front of it: bound, gated, gated_upstream, weak, or ungoverned. " +
        "Read the repository's .github/workflows/*.yml files and pass each one's path and full text as `workflows`. " +
        "Offline and read-only: no network call, no API key, nothing is executed. The report lists what it cannot " +
        "see (repository settings, deploys outside CI, the inside of deploy scripts) so a clean result is never " +
        "read as proof.",
      inputSchema: z.object({
        workflows: z
          .array(
            z.object({
              path: z.string().min(1).max(512).describe("File path, e.g. .github/workflows/deploy.yml"),
              content: z.string().max(MAX_FILE_BYTES).describe("Full text of the workflow file."),
            }),
          )
          .max(MAX_FILES)
          .describe("Every workflow file to scan. Omitting files leaves gaps unreported."),
        gate_actions: z
          .array(z.string().min(1).max(256))
          .max(20)
          .optional()
          .describe(
            "Optional `uses:` values that are your own AtlaSent gate wrappers (e.g. 'my-org/deploy-gate' or './'). " +
              "atlasent-action is always recognized; declared wrappers are reported as custom gates.",
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!rateLimitOk("atlasent_evidence_gap_report")) {
        return {
          ...toolResult({ error: "rate_limit_exceeded", message: "MCP tool rate limit exceeded — slow down and retry" }),
          isError: true as const,
        };
      }
      const report = analyzeWorkflows(args.workflows, args.gate_actions ?? []);
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "evidence_gap.report",
          workflows: args.workflows.length,
          consequential_steps: report.summary.consequential_steps,
          gaps: report.summary.gaps,
        }) + "\n",
      );
      return toolResult(report as unknown as Record<string, unknown>);
    },
  );
}
