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
import {
  comparePriority,
  environmentOf,
  priorityOf,
  secretsOf,
  triggerOf,
  type Cause,
  type CauseKind,
  type Environment,
  type EnvironmentInfo,
  type Priority,
  type TriggerInfo,
} from "./findingContext.js";

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
  return unquote(raw.trim());
}

/** True when `[`/`{` outnumber `]`/`}` outside quotes and `${{ }}`: the collection continues on the next line. */
function flowOpen(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (text.startsWith("${{", i)) {
      const end = text.indexOf("}}", i + 3);
      if (end < 0) return true;
      i = end + 1;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth > 0 || quote !== null;
}

/**
 * A YAML flow collection (`[a, b]`, `{ name: x, run: y }`, nested), as
 * workflows write them: `branches: [main]`, `with: { action: x }`,
 * `permissions: { id-token: write }`, or a whole step `- { run: npm publish }`.
 * Scalars stay strings, as everywhere else in this subset. Anything it cannot
 * read throws, so the file is reported unreadable instead of being misread.
 */
function parseFlow(src: string): YValue {
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`flow collection: ${why}`);
  };
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  function plain(stop: string): string {
    const start = i;
    while (i < src.length && !stop.includes(src[i])) {
      // ": " is an indicator inside a flow collection; YAML rejects it in a plain value.
      if (src[i] === ":" && (i + 1 >= src.length || /\s/.test(src[i + 1]))) fail('unexpected ": " in a value');
      if (src.startsWith("${{", i)) {
        const end = src.indexOf("}}", i + 3);
        if (end < 0) fail("unterminated ${{ expression");
        i = end + 2;
      } else i++;
    }
    return src.slice(start, i).trim();
  }
  function quoted(): string {
    const q = src[i++];
    let out = "";
    while (i < src.length) {
      const c = src[i];
      if (c === q) {
        if (q === "'" && src[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        i++;
        return out;
      }
      if (q === '"' && c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return fail("unterminated quote");
  }
  function value(stop: string): YValue {
    ws();
    const c = src[i];
    if (c === "{") return map();
    if (c === "[") return seq();
    if (c === '"' || c === "'") return quoted();
    return plain(stop);
  }
  function map(): YMap {
    i++;
    const out: YMap = {};
    ws();
    if (src[i] === "}") {
      i++;
      return out;
    }
    for (;;) {
      ws();
      const key = src[i] === '"' || src[i] === "'" ? quoted() : plain(":,}");
      if (typeof key !== "string" || key === "") fail("missing key");
      ws();
      if (src[i] !== ":") fail(`expected ":" after "${key}"`);
      i++;
      out[key] = value(",}");
      ws();
      if (src[i] === ",") {
        i++;
        ws();
        // YAML allows a trailing comma before the closing brace.
        if (src[i] === "}") {
          i++;
          return out;
        }
        continue;
      }
      if (src[i] === "}") {
        i++;
        return out;
      }
      return fail('expected "," or "}"');
    }
  }
  function seq(): YValue[] {
    i++;
    const out: YValue[] = [];
    ws();
    if (src[i] === "]") {
      i++;
      return out;
    }
    for (;;) {
      ws();
      if (src[i] === "," || src[i] === "]") fail("empty item");
      out.push(value(",]"));
      ws();
      if (src[i] === ",") {
        i++;
        ws();
        // YAML allows a trailing comma before the closing bracket.
        if (src[i] === "]") {
          i++;
          return out;
        }
        continue;
      }
      if (src[i] === "]") {
        i++;
        return out;
      }
      return fail('expected "," or "]"');
    }
  }
  const v = value("");
  ws();
  if (i < src.length) fail("unexpected text after the collection");
  return v;
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
      const lit = body.map((b) => (b === "" ? "" : b.slice(minIndent)));
      // `>` folds line breaks into spaces (blank lines stay breaks), so a
      // command split over lines is one command, as the runner executes it.
      const joined =
        block[2] === ">"
          ? lit.reduce((acc, l, k) => (k === 0 ? l : l === "" || lit[k - 1] === "" ? `${acc}\n${l}` : `${acc} ${l}`), "")
          : lit.join("\n");
      text = block[1] + JSON.stringify(joined); // stored as a quoted scalar
      lines.push({ indent, text, no: i + 1 });
      i = j - 1;
      continue;
    }
    lines.push({ indent, text, no: i + 1 });
  }

  let pos = 0;

  function parseScalarLiteral(v: string, no = 0): YValue {
    if (v.startsWith("{") || v.startsWith("[")) {
      try {
        const flow = parseFlow(v);
        if (flow && typeof flow === "object" && !Array.isArray(flow)) LINE_OF.set(flow, no);
        return flow;
      } catch (e) {
        throw new YamlSubsetError(e instanceof Error ? e.message : String(e), no);
      }
    }
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

  function parseValueAfterKey(keyIndent: number, value: string, no = 0): YValue {
    if (value !== "") return parseScalarLiteral(value, no);
    const next = lines[pos];
    if (!next) return "";
    // A sequence may sit at the same indent as its key (`steps:\n- run: x`).
    if (next.indent === keyIndent && (next.text === "-" || next.text.startsWith("- "))) return parseNode(next.indent);
    if (next.indent <= keyIndent) return "";
    // The value itself may start on the next, more-indented line:
    //   platform:            github-token:
    //     [ubuntu, macos]      ${{ secrets.X }}
    // Anything there that is not a sequence item or a `key: value` line is
    // that value (a flow collection or a plain scalar, possibly over several
    // lines), not a nested map.
    const isItem = next.text === "-" || next.text.startsWith("- ");
    const startsScalar = /^[{[]/.test(next.text) || !splitKey(next.text);
    if (!isItem && startsScalar) {
      const no = next.no;
      let text = next.text;
      pos++;
      while (pos < lines.length && lines[pos].indent > keyIndent) {
        text += " " + lines[pos].text;
        pos++;
      }
      return parseScalarLiteral(text, no);
    }
    return parseNode(next.indent);
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
      // A flow collection may span lines: join until it closes.
      if (/^[[{]/.test(value)) {
        while (flowOpen(value) && pos < lines.length && lines[pos].indent > indent) {
          value += " " + lines[pos].text;
          pos++;
        }
      }
      // Multi-line plain scalar: more-indented lines continue the value
      // (`run: bash x.sh \` followed by indented flag lines).
      if (value !== "" && !/^["'[{]/.test(value)) {
        while (pos < lines.length && lines[pos].indent > indent) {
          value += " " + lines[pos].text;
          pos++;
        }
      }
      map[kv[0]] = parseValueAfterKey(indent, value, l.no);
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
      } else if (/^[[{]/.test(rest)) {
        // A flow item, `- { run: npm publish }`; it may span lines.
        pos++;
        let text = rest;
        while (flowOpen(text) && pos < lines.length && lines[pos].indent > indent) {
          text += " " + lines[pos].text;
          pos++;
        }
        seq.push(parseScalarLiteral(text, l.no));
      } else if (splitKey(rest) && !rest.startsWith('"') && !rest.startsWith("'")) {
        // `- key: value` opens a map whose keys sit at itemIndent.
        lines[pos] = { indent: itemIndent, text: rest, no: l.no };
        seq.push(parseMap(itemIndent));
      } else {
        pos++;
        seq.push(parseScalarLiteral(rest, l.no));
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

/**
 * "unknown": the step runs a command whose program is chosen at run time
 * (`$CMD`, `eval "$x"`, `bash -c "$VAR"`, `${{ inputs.cmd }}`). What it does
 * cannot be read from the file, so it is reported rather than passed.
 */
export type Category = "deploy" | "publish" | "migrate" | "infrastructure" | "unknown";

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

/**
 * The run text with comments dropped and the quoted text of echo/printf lines
 * blanked: `echo "helm install ..."` in a job summary prints instructions, it
 * does not deploy. Only the quoted part is blanked, so `echo "$M" | kubectl
 * apply -f -` is still detected.
 */
function runWithoutComments(run: string): string {
  return run
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => (/^\s*(echo|printf)\b/.test(l) ? l.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""') : l))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Shell indirection (#261). A detector that reads `run:` text literally is
// evaded by handing the command to another shell (`bash -c '...'`,
// `sh -lc "..."`, `env X=1 bash -c`, `eval`, `echo '...' | sh`), by splitting
// it with quotes or line continuations, or by building it at run time
// (`$CMD`, `eval "$x"`, `bash -c "$VAR"`, `${{ inputs.cmd }}`). analyzeShell
// lexes the text the way a POSIX shell would split it, unwraps those forms so
// the detectors see the inner command, and returns every command position
// whose program cannot be known from the file. Such a step is never passed:
// it is reported as an "unknown" finding (confidence "possible").
// ---------------------------------------------------------------------------

interface ShWord {
  /** Source text of the word, quotes included. */
  raw: string;
  /** Quotes removed; expansions kept literally (`$X` stays `$X`). */
  value: string;
  quoted: boolean;
  /** Bodies of $(...) and `...`, which the shell runs as commands. */
  subs: string[];
}

interface ShSegment {
  words: ShWord[];
  /** Operator that ends the segment: ";", "&&", "||", "|", "&", "\n", "(" , ")" or "". */
  op: string;
  /** Heredoc body or here-string fed to this command's stdin. */
  stdin?: string;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
const PREFIX_COMMANDS = new Set(["env", "sudo", "exec", "command", "nohup", "time", "builtin", "nice", "doas"]);
const SKIP_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "esac"]);
/** Keywords whose next words are names or patterns, never a command. */
const BLOCK_KEYWORDS = new Set(["for", "case", "select", "function", "in"]);
/** A word that is nothing but one expansion: the program is chosen at run time. */
const PURE_EXPANSION = /^"?(?:\$[A-Za-z_]\w*|\$[0-9@*#?!$-]|\$\{\{[^}]*\}\}|\$\{[^}]*\}|\$\([\s\S]*\)|`[\s\S]*`)"?$/;
const MAX_SHELL_DEPTH = 4;

/** Index just past the `)` matching the `(` at `open`, quote-aware. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? s.length : e; continue; }
    if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === "\\") i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return s.length;
}

export function lexShell(src: string): ShSegment[] {
  const segs: ShSegment[] = [];
  let words: ShWord[] = [];
  let w: ShWord | null = null;
  const pending: Array<{ delim: string; seg: ShWord[] }> = [];
  const stdinFor = new Map<ShWord[], string>();
  let hereString = false;
  /** Inside [[ ... ]], && || ( ) are part of the test, not separators. */
  let dblBracket = false;
  const word = (): ShWord => (w ??= { raw: "", value: "", quoted: false, subs: [] });
  const endWord = () => {
    if (!w) return;
    if (hereString) {
      stdinFor.set(words, w.value);
      hereString = false;
    } else {
      if (!w.quoted && w.value === "[[") dblBracket = true;
      if (!w.quoted && w.value === "]]") dblBracket = false;
      words.push(w);
    }
    w = null;
  };
  const endSeg = (op: string) => {
    endWord();
    const stdin = stdinFor.get(words);
    if (words.length || op === "|") segs.push({ words, op, ...(stdin !== undefined ? { stdin } : {}) });
    words = [];
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "\\" && n === "\n") { i += 2; continue; }
    if (c === "\\") { const x = word(); x.raw += c + (n ?? ""); x.value += n ?? ""; i += 2; continue; }
    if (c === " " || c === "\t" || c === "\r") { endWord(); i++; continue; }
    if (c === "#" && !w) { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      const end = e < 0 ? src.length : e;
      const x = word(); x.quoted = true; x.raw += src.slice(i, end + 1); x.value += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const x = word(); x.quoted = true;
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          const nx = src[j + 1];
          if (nx === "\n") { j += 2; continue; }
          v += "$`\"\\".includes(nx) ? nx : "\\" + nx;
          j += 2;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "(") {
          const e = matchParen(src, j + 1);
          // $(( ... )) is arithmetic, not a command.
          if (src[j + 2] !== "(") x.subs.push(src.slice(j + 2, e - 1));
          v += src.slice(j, e);
          j = e;
          continue;
        }
        if (src[j] === "`") {
          const e = src.indexOf("`", j + 1);
          const end = e < 0 ? src.length : e;
          x.subs.push(src.slice(j + 1, end));
          v += src.slice(j, end + 1);
          j = end + 1;
          continue;
        }
        v += src[j++];
      }
      x.raw += src.slice(i, j + 1);
      x.value += v;
      i = j + 1;
      continue;
    }
    if (c === "$" && n === "{" && src[i + 2] === "{") {
      const e = src.indexOf("}}", i + 3);
      const end = e < 0 ? src.length : e + 2;
      const x = word(); x.raw += src.slice(i, end); x.value += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "$" && n === "{") {
      const e = src.indexOf("}", i + 2);
      const end = e < 0 ? src.length : e + 1;
      const x = word(); x.raw += src.slice(i, end); x.value += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "$" && n === "(") {
      const e = matchParen(src, i + 1);
      const x = word();
      if (src[i + 2] !== "(") x.subs.push(src.slice(i + 2, e - 1)); // $(( ... )) is arithmetic
      x.raw += src.slice(i, e);
      x.value += src.slice(i, e);
      i = e;
      continue;
    }
    if (c === "`") {
      const e = src.indexOf("`", i + 1);
      const end = e < 0 ? src.length : e;
      const x = word(); x.subs.push(src.slice(i + 1, end)); x.raw += src.slice(i, end + 1); x.value += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === "<" && n === "<" && src[i + 2] === "<") { endWord(); hereString = true; i += 3; continue; }
    if (c === "<" && n === "<") {
      endWord();
      i += 2;
      if (src[i] === "-") i++;
      while (src[i] === " " || src[i] === "\t") i++;
      let delim = "";
      while (i < src.length && !/[\s;&|()<>]/.test(src[i])) {
        if (src[i] !== "'" && src[i] !== '"' && src[i] !== "\\") delim += src[i];
        i++;
      }
      pending.push({ delim, seg: words });
      continue;
    }
    if (c === "&" && (n === ">" || (w as ShWord | null)?.raw.endsWith(">"))) { const x = word(); x.raw += c; x.value += c; i++; continue; }
    if (c === "(" && (w as ShWord | null)?.raw.endsWith("=")) {
      // Array literal: arr=( a "b" ) is one assignment word.
      const e = matchParen(src, i);
      const x = word(); x.raw += src.slice(i, e); x.value += src.slice(i, e);
      i = e;
      continue;
    }
    if (dblBracket && (c === "&" || c === "|" || c === "(" || c === ")")) { const x = word(); x.raw += c; x.value += c; i++; continue; }
    if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      const two = c + (n ?? "");
      const op = two === "&&" || two === "||" || two === ";;" || two === "|&" ? two : c;
      endSeg(op === "|&" ? "|" : op);
      i += op.length;
      if (c === "\n" && pending.length) {
        // Heredoc bodies follow the line that opened them, in order.
        for (const h of pending.splice(0)) {
          const body: string[] = [];
          while (i < src.length) {
            const nl = src.indexOf("\n", i);
            const line = src.slice(i, nl < 0 ? src.length : nl);
            i = nl < 0 ? src.length : nl + 1;
            if (line.trim() === h.delim) break;
            body.push(line);
          }
          const target = segs.find((s) => s.words === h.seg);
          if (target) target.stdin = body.join("\n");
        }
      }
      continue;
    }
    const x = word(); x.raw += c; x.value += c;
    i++;
  }
  endSeg("");
  return segs;
}

/** Index of the program word in a segment, past assignments and prefixes; -1 if none. */
function commandIndex(words: ShWord[]): number {
  let j = 0;
  while (j < words.length) {
    const w = words[j];
    if (!w.quoted && BLOCK_KEYWORDS.has(w.value)) return -1;
    if (!w.quoted && SKIP_KEYWORDS.has(w.value)) { j++; continue; }
    if (!w.quoted && /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(w.raw)) { j++; continue; }
    if (!w.quoted && PREFIX_COMMANDS.has(w.value)) {
      j++;
      while (j < words.length && /^-/.test(words[j].value)) j++;
      continue;
    }
    return j;
  }
  return -1;
}

function programName(w: ShWord): string {
  return w.value.replace(/^.*\//, "");
}

export interface ShellAnalysis {
  /** Extra command text for the detectors: unquoted, unwrapped, one command per line. */
  lines: string[];
  /** Commands whose program is chosen at run time, as written. */
  dynamic: string[];
}

export function analyzeShell(src: string, depth = 0): ShellAnalysis {
  const out: ShellAnalysis = { lines: [], dynamic: [] };
  if (depth > MAX_SHELL_DEPTH) {
    out.dynamic.push(`shell nesting deeper than ${MAX_SHELL_DEPTH}`);
    return out;
  }
  const segs = lexShell(src);
  const inner = (code: string, label: string) => {
    const r = analyzeShell(code, depth + 1);
    out.lines.push(...r.lines);
    if (r.dynamic.length) out.dynamic.push(label);
  };
  segs.forEach((seg, k) => {
    const words = seg.words;
    const j = commandIndex(words);
    const label = words.slice(Math.max(0, j)).map((w) => w.raw).join(" ").slice(0, 120);
    for (const w of words) for (const sub of w.subs) inner(sub, label);
    if (j < 0) return;
    const cmd = words[j];
    const args = words.slice(j + 1);
    const name = programName(cmd);
    if (name === "echo" || name === "printf") {
      // Printed text is not run, unless it is piped into a shell.
      const next = segs[k + 1];
      const nj = next ? commandIndex(next.words) : -1;
      const pipedToShell =
        seg.op === "|" && next && nj >= 0 && SHELLS.has(programName(next.words[nj])) &&
        !next.words.slice(nj + 1).some((w) => !/^-/.test(w.value));
      if (pipedToShell) inner(args.map((w) => w.value).join(" "), `${label} | ${programName(next.words[nj])}`);
      else out.lines.push([cmd.value, ...args.map((w) => (w.quoted ? '""' : w.value))].join(" "));
      return;
    }
    out.lines.push(words.slice(j).map((w) => w.value).join(" "));
    if (PURE_EXPANSION.test(cmd.raw)) {
      out.dynamic.push(label);
      return;
    }
    if (name === "eval") {
      inner(args.map((w) => w.value).join(" "), label);
      return;
    }
    if (SHELLS.has(name)) {
      const c = args.findIndex((w) => !w.quoted && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.value));
      if (c >= 0) {
        const script = args[c + 1];
        if (script) inner(script.value, label);
        else out.dynamic.push(label);
      } else if (seg.stdin !== undefined && !args.some((w) => !/^-/.test(w.value))) {
        inner(seg.stdin, label);
      }
    }
  });
  return out;
}

interface Detection {
  category: Category;
  detected_by: string;
  confidence: "certain" | "possible";
}

/** True for the shells analyzeShell models; pwsh, cmd, python etc. are read literally only. */
function posixShell(shell: string): boolean {
  const name = shell.trim().split(/\s+/)[0] ?? "";
  return name === "" || SHELLS.has(name.replace(/^.*\//, ""));
}

/**
 * @param defaultShell the job's or workflow's `defaults.run.shell`, used when
 *   the step sets no `shell:` of its own.
 */
export function detectStep(step: YMap, extraGates: string[] = [], defaultShell = ""): Detection | null {
  const uses = typeof step.uses === "string" ? step.uses : "";
  const stepShell = typeof step.shell === "string" ? step.shell : defaultShell;
  const shell: ShellAnalysis =
    typeof step.run === "string" && posixShell(stepShell) ? analyzeShell(step.run) : { lines: [], dynamic: [] };
  // The literal text (as before) plus the unwrapped, unquoted commands, so a
  // command handed to another shell is seen exactly as a direct one is.
  const run = typeof step.run === "string" ? [runWithoutComments(step.run), ...shell.lines].join("\n") : "";
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
    if (shell.dynamic.length > 0) {
      return { category: "unknown", detected_by: `command built at run time: ${shell.dynamic[0]}`, confidence: "possible" };
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
  name: string;
  line: number;
  issuesOnly: boolean; // mode: evaluate-only
  verifies: boolean; // enforce mode, or verify-permit: true
  advisory: boolean; // continue-on-error
  conditional: boolean; // has its own `if:`
  custom: boolean; // your own script or curl, not atlasent-action; not inspected
}

function truthy(v: YValue | undefined): boolean {
  return typeof v === "string" && /^(true|'true'|"true")$/i.test(v.trim());
}

/**
 * `continue-on-error` can only be ruled out when it is absent or a literal
 * false. An expression such as `${{ inputs.advisory }}` may evaluate true at
 * run time, so it counts as possibly on.
 */
function mayContinueOnError(v: YValue | undefined): boolean {
  if (v === undefined) return false;
  return !(typeof v === "string" && /^(false|'false'|"false"|)$/i.test(v.trim()));
}

/** Status functions that let a step or job run after an earlier failure. */
function runsAfterFailure(cond: string): boolean {
  return /\b(always|failure|cancelled)\s*\(\s*\)/.test(cond);
}

function stripExpr(cond: string): string {
  const t = cond.trim();
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(t);
  return (m ? m[1] : t).trim();
}

/**
 * True only when the condition positively requires `steps.<id>.outputs.verified
 * == 'true'`: that comparison alone, or ANDed with other terms. Any `||`, a
 * negation, a different comparison, or a status function that runs after a
 * failure means the step can run without a verified permit.
 */
function requiresVerified(cond: string, id: string): boolean {
  return positiveVerifiedRefs(cond).some((r) => r.kind === "steps" && r.id === id);
}

/**
 * The `steps.<id>` / `needs.<job>` verified outputs a condition positively
 * requires: `<ref>.outputs.verified == 'true'` alone or ANDed with other terms.
 * Any `||`, negation, other comparison or always()/failure()/cancelled() in
 * the condition means nothing is required, so the result is empty.
 */
function positiveVerifiedRefs(cond: string): Array<{ kind: "steps" | "needs"; id: string }> {
  const c = stripExpr(cond);
  if (c === "" || c.includes("||") || runsAfterFailure(c)) return [];
  const positive = /^\(?\s*(steps|needs)\.([\w-]+)\.outputs\.verified\s*==\s*(['"])true\3\s*\)?$/;
  const refs: Array<{ kind: "steps" | "needs"; id: string }> = [];
  for (const part of c.split("&&")) {
    const m = positive.exec(part.trim());
    if (m) refs.push({ kind: m[1] as "steps" | "needs", id: m[2] });
  }
  return refs;
}

const GATE_SCRIPT = /(?:^|[\s/])([\w.-]*(?:atlasent|permit|deploy|release)[-_]gate[\w.-]*\.(?:sh|bash|py|js|mjs|cjs|ts))\b/gi;

/** A gate script of your own, but never a test or check of one. */
function customGateScript(run: string): boolean {
  if (/\bnode\s+--test\b|\b(deno|bun)\s+test\b|\b(vitest|jest|mocha)\b/.test(run)) return false;
  for (const m of run.matchAll(GATE_SCRIPT)) {
    if (!SCRIPT_EXCLUDE_GATE.test(m[1])) return true;
  }
  return false;
}
const SCRIPT_EXCLUDE_GATE = /(test|spec|check|lint|mock|fixture|acceptance)/i;

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
  } else if (customGateScript(run)) {
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
    name: typeof step.name === "string" ? step.name : uses || `step ${index + 1}`,
    line: LINE_OF.get(step) ?? 0,
    issuesOnly,
    verifies,
    advisory: mayContinueOnError(step["continue-on-error"]),
    conditional: typeof step.if === "string" && step.if.trim() !== "",
    custom,
  };
}

/** `defaults.run.shell`, when set. */
function runShell(defaults: YValue | undefined): string | undefined {
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return undefined;
  const run = (defaults as YMap).run;
  if (!run || typeof run !== "object" || Array.isArray(run)) return undefined;
  const sh = (run as YMap).shell;
  return typeof sh === "string" ? sh : undefined;
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
  /** Present on gaps (ungoverned / weak): the concrete change for this step. */
  fix?: Fix;
  /** The environment this step changes, and what in the file said so. */
  environment: EnvironmentInfo;
  /** What starts it, from the workflow's `on:`. */
  trigger: TriggerInfo;
  /** Names of the secrets the step can read (never values). */
  secrets: string[];
  /** How soon to fix it, and why. */
  priority: Priority;
  /** Present on gaps: the id of the root cause in the report's `causes`. */
  cause?: string;
}

export interface Fix {
  /** atlasent-action `action:` for this kind of step. */
  action_type: string;
  /** Step to insert before this one (ungoverned), as YAML. */
  gate_step?: string;
  /**
   * Condition to put on this step so it runs only on a verified permit.
   * Absent when the existing condition cannot be rewritten safely (see note).
   */
  bind_if?: string;
  /** What to change on an existing gate that cannot stop the step (weak). */
  change?: string;
  /** The job needs these permissions for a verified workload actor. */
  job_permissions?: string;
  note?: string;
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
    /** Every recognized step, by the environment it changes. */
    steps_by_environment: Record<Environment, number>;
    /** Gaps only, by the environment they change. */
    gaps_by_environment: Record<Environment, number>;
    /** Distinct root causes behind the gaps. */
    causes: number;
  };
  findings: Finding[];
  /** Root causes behind the gaps, highest priority first. */
  causes: Cause[];
  triggers: Record<string, string[]>;
  parse_errors: Array<{ workflow: string; line: number; error: string }>;
  not_checked: string[];
  next_step: string;
  /** Present when there are gaps: how to get the key the gate steps need. */
  setup?: {
    sign_up_url: string;
    steps: string[];
    docs: string;
  };
}

const NOT_CHECKED = [
  "Only the workflow files passed in were read. Pass every file under .github/workflows/ for a complete picture.",
  "Branch protection, required reviewers and GitHub Environment protection rules live in repository settings, not in these files.",
  "Deploys run from laptops, other CI systems, or cloud consoles are invisible here.",
  "What a script such as ./deploy.sh does inside is not inspected; such steps are reported with confidence 'possible'.",
  "A 'gated' or 'bound' step has a gate in front of it. That is not proof your policy would allow it, or that the gate's API key is set.",
  "Reusable workflows called with `uses:` at job level are listed as their own job but not followed into the called file.",
  "A command whose program is chosen at run time ($CMD, eval \"$x\", bash -c \"$VAR\", ${{ inputs.cmd }}) is reported as category 'unknown' with confidence 'possible'; what it runs is not known.",
  "Code fetched or generated at run time and piped into a shell (for example curl ... | bash) is not followed.",
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

// ---------------------------------------------------------------------------
// The concrete next action for a gap
// ---------------------------------------------------------------------------

export const SIGN_UP_URL = "https://console.atlasent.io/auth/sign-up?utm_source=evidence-gap&utm_medium=mcp";
const ACTION_DOCS = "https://github.com/AtlaSent/atlasent-action#quick-start";
const GATE_ID = "atlasent_gate";

/**
 * atlasent-action accepts only its GATE_PERMITTED_ACTIONS. database.migrate is
 * a Canon action it does not accept yet, so a migration is gated as a
 * production deploy and the fix says so.
 */
function actionTypeFor(category: Category): { action: string; note?: string } {
  switch (category) {
    case "publish":
      return { action: "package.release" };
    case "infrastructure":
      return { action: "infrastructure.change" };
    case "migrate":
      return {
        action: "production.deploy",
        note: "The Canon action for a migration is database.migrate, which atlasent-action does not accept yet; gate it as production.deploy.",
      };
    default:
      return { action: "production.deploy" };
  }
}

function gateStepYaml(action: string, id: string): string {
  return [
    "- name: AtlaSent gate",
    `  id: ${id}`,
    "  uses: AtlaSent/atlasent-action@v1",
    "  env:",
    "    ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}",
    "    ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}",
    "  with:",
    `    action: ${action}`,
    "    environment: production",
    "    target-id: ${{ github.repository }}",
  ].join("\n");
}

/**
 * The condition that runs the step only on a verified permit, keeping every
 * other term of its existing condition. always(), !cancelled() and success()
 * terms are dropped (they only widen when the step runs). Returns null when
 * that cannot be done safely: a failure()/cancelled() handler, or a status
 * function inside an `||`, whose meaning a rewrite would change.
 */
function bindIf(gateId: string, existingIf: string): string | null {
  const verified = `steps.${gateId}.outputs.verified == 'true'`;
  const cur = stripExpr(existingIf);
  if (cur === "") return `if: ${verified}`;
  if (!runsAfterFailure(cur)) return `if: \${{ (${cur}) && ${verified} }}`;
  if (cur.includes("||")) return null;
  const widening = /^\(?\s*(always\s*\(\s*\)|!\s*cancelled\s*\(\s*\)|success\s*\(\s*\))\s*\)?$/;
  const kept = cur.split("&&").map((t) => t.trim()).filter((t) => t !== "" && !widening.test(t));
  if (kept.some((t) => runsAfterFailure(t))) return null;
  return kept.length === 0 ? `if: ${verified}` : `if: \${{ ${kept.map((t) => `(${t})`).join(" && ")} && ${verified} }}`;
}

/** A gate step id not used by any step in the job, nor by another fix for it. */
function allocateGateId(used: Set<string>): string {
  let id = GATE_ID;
  for (let n = 2; used.has(id); n++) id = `${GATE_ID}_${n}`;
  used.add(id);
  return id;
}

function hasIdTokenWrite(perms: YValue | undefined): boolean {
  if (typeof perms === "string") return /write-all/.test(perms);
  return !!perms && typeof perms === "object" && !Array.isArray(perms) && (perms as YMap)["id-token"] === "write";
}

function fixFor(
  status: GapStatus,
  category: Category,
  step: YMap,
  job: YMap,
  doc: YMap,
  weakGate: GateInfo | undefined,
  usedIds: Set<string>,
): Fix | undefined {
  if (status !== "ungoverned" && status !== "weak") return undefined;
  const { action, note } = actionTypeFor(category);
  const stepIf = typeof step.if === "string" ? step.if : "";
  const needsIdToken = action === "production.deploy" || action === "infrastructure.change";
  const perms = job.permissions !== undefined ? job.permissions : doc.permissions;
  const job_permissions =
    needsIdToken && !hasIdTokenWrite(perms)
      ? "Add `permissions: { contents: read, id-token: write }` to this job: the gate mints a verified GitHub workload identity for this action type."
      : undefined;
  const notes: string[] = note ? [note] : [];
  const withBinding = (gateId: string): Pick<Fix, "bind_if"> => {
    const b = bindIf(gateId, stepIf);
    if (b) {
      if (runsAfterFailure(stripExpr(stepIf))) notes.push("always()/success()/!cancelled() dropped from the condition: with them the step still runs after a deny.");
      return { bind_if: b };
    }
    notes.push(
      `This step's condition uses failure()/cancelled() or an || that a rewrite would change. Edit it by hand so it requires steps.${gateId}.outputs.verified == 'true' and cannot run after a deny.`,
    );
    return {};
  };
  const tail = () => ({
    ...(job_permissions ? { job_permissions } : {}),
    ...(notes.length ? { note: notes.join(" ") } : {}),
  });

  // Already bound to a gate this report did not recognize (a wrapper action,
  // or `uses: ./` inside atlasent-action itself). Only a positive binding
  // counts: `!= 'true'`, a negation or an `||` is not one, and gets a gate.
  const ref = positiveVerifiedRefs(stepIf)[0];
  if (ref && status === "ungoverned") {
    return {
      action_type: action,
      change:
        `This step already requires ${ref.kind}.${ref.id}.outputs.verified == 'true', but no gate was recognized there. ` +
        "If that is your gate, pass its `uses:` value in `gate_actions` and run the report again; if not, add a gate step in its place.",
      ...tail(),
    };
  }
  // Ungoverned, or weak because the only gate is in another job that cannot
  // stop this one: a gate in THIS job, before the step, is the fix. It gets
  // an id no step in the job uses, so several fixes in one job never collide.
  if (status === "ungoverned" || !weakGate) {
    const id = allocateGateId(usedIds);
    return {
      action_type: action,
      gate_step: gateStepYaml(action, id),
      ...withBinding(id),
      ...(status === "weak"
        ? { change: "The gate in the job this one needs cannot stop it (it can be skipped or continue on error, or this job runs after it fails). Add this gate in this job, before the step." }
        : {}),
      ...tail(),
    };
  }
  const gateId = weakGate.id ?? GATE_ID;
  if (!weakGate.id) notes.push("Give the gate step an `id:` so this step can reference its output.");
  // Every weakness the gate has, not just the first: this text becomes the
  // cause's fix_once, and a one-time fix that leaves the gate skippable (or
  // advisory) does not close the findings it claims to close.
  const weaknesses: string[] = [];
  if (weakGate.advisory) weaknesses.push("Remove continue-on-error from the gate step, so a deny fails the job.");
  if (weakGate.conditional) weaknesses.push("Remove the gate step's own `if:` (for example a skip_gate input), so it cannot be skipped.");
  if (weakGate.issuesOnly) {
    weaknesses.push("The gate only issues a permit (mode: evaluate-only). Add a step with `verify-permit: 'true'` before this one, or drop evaluate-only.");
  }
  const change =
    weaknesses.length === 0 ? "Bind this step to the gate's verified output."
    : weaknesses.length === 1 ? weaknesses[0]
    : `The gate is weak in ${weaknesses.length} ways; all of these are needed: ${weaknesses.join(" ")}`;
  return { action_type: action, change, ...withBinding(gateId), ...tail() };
}

interface PendingCause {
  index: number;
  kind: CauseKind;
  id: string;
  workflow: string;
  job: string;
  step: string;
  line: number;
  gate?: Cause["gate"];
  fixOnce?: string;
}

function emptyEnvCounts(): Record<Environment, number> {
  return { production: 0, non_production: 0, unknown: 0 };
}

function causeText(p: PendingCause): { title: string; detail: string } {
  const gateStep = p.gate?.step ?? "";
  switch (p.kind) {
    case "gate_skippable":
      return {
        title: `Gate step "${gateStep}" can be skipped`,
        detail: "The gate runs under its own `if:`, so when that condition is false the steps after it run with no authorization check.",
      };
    case "gate_advisory":
      return {
        title: `Gate step "${gateStep}" cannot fail the job`,
        detail: "The gate has continue-on-error, so a deny is recorded and the steps after it run anyway.",
      };
    case "gate_issues_only":
      return {
        title: `Gate step "${gateStep}" issues a permit nothing verifies`,
        detail: "The gate runs in evaluate-only mode and no step verifies and consumes the permit before the change runs.",
      };
    case "runs_after_failure":
      return {
        title: `"${p.step}" runs even after the gate denies`,
        detail: "The step's `if:` uses always(), failure() or cancelled(), so a failed gate does not stop it.",
      };
    case "upstream_gate_weak":
      return {
        title: `The gate in job "${p.gate?.job}" cannot stop the jobs that need it`,
        detail: "That gate can be skipped, can continue on error, or only issues a permit, so jobs that depend on it run without a check that can stop them.",
      };
    case "upstream_after_failure":
      return {
        title: `Job "${p.job}" runs even after the gate job fails`,
        detail: "The job's `if:` uses always(), failure() or cancelled(), so the gate job failing does not stop it.",
      };
    default:
      return { title: `No gate in front of "${p.step}"`, detail: "No AtlaSent gate runs in this job or in any job it needs." };
  }
}

/**
 * Gaps that one change would close share a cause: every step behind the same
 * skippable / advisory / issue-only gate, or every job needing the same weak
 * gate job. Everything else is its own cause. Highest priority first.
 */
function buildCauses(pending: PendingCause[], findings: Finding[]): Cause[] {
  const byId = new Map<string, Cause>();
  for (const p of pending) {
    const f = findings[p.index];
    let c = byId.get(p.id);
    if (!c) {
      c = {
        id: p.id,
        kind: p.kind,
        ...causeText(p),
        workflow: p.workflow,
        job: p.gate?.job ?? p.job,
        ...(p.gate ? { gate: p.gate } : {}),
        ...(p.fixOnce ? { fix_once: p.fixOnce } : {}),
        findings: [],
        priority: f.priority,
        environments: emptyEnvCounts(),
      };
      byId.set(p.id, c);
    }
    c.findings.push(p.index);
    c.environments[f.environment.value]++;
    if (comparePriority(f.priority, c.priority) < 0) c.priority = f.priority;
    f.cause = p.id;
  }
  const causes = [...byId.values()];
  for (const c of causes) {
    c.findings.sort((a, b) => comparePriority(findings[a].priority, findings[b].priority) || a - b);
  }
  return causes.sort(
    (a, b) => comparePriority(a.priority, b.priority) || b.findings.length - a.findings.length || a.findings[0] - b.findings[0],
  );
}

/**
 * @param gateActions extra `uses:` values the caller declares as its gate:
 *   a wrapper composite action, or `./` inside the atlasent-action repo.
 *   Matched exactly or as `<value>@<ref>`; reported as custom gates.
 */
export function analyzeWorkflows(inputs: WorkflowInput[], gateActions: string[] = []): EvidenceGapReport {
  const findings: Finding[] = [];
  const pendingCauses: PendingCause[] = [];
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
      // A gate job that may continue on error, or may be skipped by its own
      // `if:`, cannot stop the jobs that need it.
      const jobWeak =
        mayContinueOnError((job as YMap)["continue-on-error"]) ||
        (typeof (job as YMap).if === "string" && ((job as YMap).if as string).trim() !== "");
      if (gs.some(enforcingGate) && !jobWeak) jobGate.set(name, "enforcing");
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
      const defaultShell = runShell(job.defaults) ?? runShell((doc as YMap).defaults) ?? "";
      const gates: GateInfo[] = [];
      const usedIds = new Set(steps.map((st) => st.id).filter((x): x is string => typeof x === "string"));
      steps.forEach((s, i) => {
        const g = gateInfo(s, i, gateActions);
        if (g) gates.push(g);
      });

      steps.forEach((step, i) => {
        const det = detectStep(step, gateActions, defaultShell);
        if (!det) return;
        const earlier = gates.filter((g) => g.index < i);
        const stepIf = typeof step.if === "string" ? step.if : "";
        let status: GapStatus;
        let reason: string;
        let weakGate: GateInfo | undefined;
        let causeKind: CauseKind | undefined;
        let upJob: string | undefined;
        const enforcing = earlier.filter(enforcingGate);
        const bound = enforcing.find((g) => g.id && requiresVerified(stepIf, g.id));
        const jobIf = typeof job.if === "string" ? job.if : "";
        if (enforcing.length > 0 && !bound && runsAfterFailure(stepIf)) {
          status = "weak";
          causeKind = "runs_after_failure";
          reason =
            "A gate runs earlier in this job, but this step's `if:` uses always(), failure() or cancelled(), " +
            "so the gate failing does not stop it. The rest of the condition may still prevent it (for example " +
            "a rollback that needs a gated step to have run); that part is not evaluated.";
        } else if (bound) {
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
          weakGate = g;
          status = "weak";
          causeKind = g.advisory ? "gate_advisory" : g.conditional ? "gate_skippable" : "gate_issues_only";
          reason = g.advisory
            ? "The gate step has continue-on-error, so a deny does not stop this step."
            : g.conditional
              ? "The gate step runs under its own `if:`, so it can be skipped while this step still runs."
              : "The gate only issues a permit (evaluate-only); nothing in this job verifies and consumes it before this step.";
        } else {
          const up = upstreamGate(jobName);
          if (up?.kind === "enforcing" && runsAfterFailure(jobIf)) {
            status = "weak";
            causeKind = "upstream_after_failure";
            upJob = up.job;
            reason =
              `Gated in job "${up.job}", but this job's \`if:\` uses always(), failure() or cancelled(), ` +
              "so the gate job failing does not stop it. The rest of the condition is not evaluated.";
          } else if (up?.kind === "enforcing") {
            status = "gated_upstream";
            reason =
              `Gated in job "${up.job}", which this job needs. Nothing re-verifies the permit where this step runs; ` +
              "a verify-permit step in this job would bind the permit to the execution.";
          } else if (up) {
            status = "weak";
            causeKind = "upstream_gate_weak";
            upJob = up.job;
            reason =
              `Job "${up.job}", which this job needs, has a gate that cannot stop this step ` +
              "(continue-on-error, its own `if:`, or evaluate-only with nothing consuming the permit).";
          } else {
            status = "ungoverned";
            causeKind = "no_gate";
            reason = "No AtlaSent gate in this job or in any job it needs.";
          }
        }
        const stepName = typeof step.name === "string" ? step.name : typeof step.uses === "string" ? step.uses : `step ${i + 1}`;
        const line = LINE_OF.get(step) ?? 0;
        const environment = environmentOf(job, jobName, step, wf.path);
        const trigger = triggerOf(triggers[wf.path], jobIf, stepIf);
        const secrets = secretsOf(step, job, doc as YMap);
        const fix = fixFor(status, det.category, step, job, doc as YMap, weakGate, usedIds);
        if (causeKind) {
          pendingCauses.push({
            index: findings.length,
            kind: causeKind,
            id:
              weakGate ? `${causeKind}:${wf.path}#${jobName}#${weakGate.index}`
              : causeKind === "upstream_gate_weak" ? `${causeKind}:${wf.path}#${upJob}`
              : `${causeKind}:${wf.path}#${jobName}#${i}`,
            workflow: wf.path,
            job: jobName,
            step: stepName,
            line,
            gate: weakGate ? { job: jobName, step: weakGate.name, line: weakGate.line } : upJob ? { job: upJob } : undefined,
            fixOnce: weakGate ? fix?.change : undefined,
          });
        }
        findings.push({
          workflow: wf.path,
          job: jobName,
          step: stepName,
          line,
          ...det,
          status,
          reason,
          ...(fix ? { fix } : {}),
          environment,
          trigger,
          secrets,
          priority: priorityOf(det.category, environment, trigger, secrets, det.confidence),
        });
      });
    }
  }

  const counts = emptyCounts();
  for (const f of findings) counts[f.status]++;
  const gaps = counts.ungoverned + counts.weak;
  const stepsByEnv = emptyEnvCounts();
  const gapsByEnv = emptyEnvCounts();
  for (const f of findings) {
    stepsByEnv[f.environment.value]++;
    if (f.status === "ungoverned" || f.status === "weak") gapsByEnv[f.environment.value]++;
  }
  const causes = buildCauses(pendingCauses, findings);
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
      `${gaps} step${gaps === 1 ? "" : "s"} can change a real system without an approval gate that stops ` +
      `${gaps === 1 ? "it" : "them"}. Each one's \`fix\` has the exact change. To apply it: create a free AtlaSent ` +
      `account and API key (${SIGN_UP_URL}), add it as the ATLASENT_API_KEY repository secret, then make each fix.`;
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
      steps_by_environment: stepsByEnv,
      gaps_by_environment: gapsByEnv,
      causes: causes.length,
    },
    findings,
    causes,
    triggers,
    parse_errors: parseErrors,
    not_checked: NOT_CHECKED,
    next_step: next,
    ...(gaps > 0
      ? {
          setup: {
            sign_up_url: SIGN_UP_URL,
            steps: [
              "Create a free account and an API key at the sign-up URL.",
              "Add the key as the repository secret ATLASENT_API_KEY (and ATLASENT_BASE_URL if you were given one).",
              "For each finding with a `fix`: insert `gate_step` before the step, add `bind_if` to the step, and apply `change`/`job_permissions` where present.",
              "Run the report again: fixed steps show as bound.",
            ],
            docs: ACTION_DOCS,
          },
        }
      : {}),
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
