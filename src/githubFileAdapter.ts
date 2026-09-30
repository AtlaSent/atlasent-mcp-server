/**
 * Reference execution adapter for AI Action Protection: an agent changes one
 * file in a GitHub repository (a configuration change that CI, deploys or
 * people then act on). A real system change, not a simulated tool call.
 *
 *   state    : the file's current blob sha on the branch ("absent" if none)
 *   execute  : PUT /repos/{o}/{r}/contents/{path} with the authorized base sha
 *              (GitHub itself refuses the write if the file moved underneath)
 *   effect   : re-read the file at the resulting commit AND at the branch head;
 *              established only if both hold exactly the authorized bytes
 *
 * The action's arguments name the base blob and the sha256 of the new content,
 * so the permit covers exactly "replace blob X with content Y at path P on
 * branch B". Different content, a different base, path, branch or repo is a
 * different digest.
 */
import { createHash } from "node:crypto";
import { sha256Hex, type ExecutionAdapter, type GovernedActionSpec } from "./governedAction.js";

export interface GithubFileTarget {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

export interface GithubFileChange extends GithubFileTarget {
  content: string;
  message: string;
}

export const GITHUB_CONTENTS_TOOL = "github.contents.put";

export function githubTargetId(t: GithubFileTarget): string {
  return `github:${t.owner}/${t.repo}@${t.branch}:${t.path}`;
}

type Fetch = typeof globalThis.fetch;

export interface GithubAdapterOptions {
  token: string;
  apiBase?: string;
  fetchImpl?: Fetch;
  timeoutMs?: number;
}

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export function githubFileAdapter(target: GithubFileTarget, content: string, opts: GithubAdapterOptions): ExecutionAdapter & {
  readBlob(): Promise<{ sha: string; content: string } | null>;
} {
  const api = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const doFetch: Fetch = opts.fetchImpl ?? globalThis.fetch;
  const timeout = opts.timeoutMs ?? 15_000;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${opts.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "atlasent-ai-action-protection-reference",
  };
  const contentsUrl = `${api}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${encPath(target.path)}`;

  async function getAt(ref: string): Promise<{ sha: string; content: string } | null> {
    const res = await doFetch(`${contentsUrl}?ref=${encodeURIComponent(ref)}`, { headers, signal: AbortSignal.timeout(timeout) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub read ${res.status}`);
    const j = (await res.json()) as { sha?: unknown; content?: unknown; encoding?: unknown; type?: unknown };
    if (j.type !== "file" || typeof j.sha !== "string" || typeof j.content !== "string" || j.encoding !== "base64") {
      throw new Error("GitHub read returned something other than a base64 file");
    }
    return { sha: j.sha, content: Buffer.from(j.content, "base64").toString("utf8") };
  }

  const expectedSha = sha256Hex(content);
  const stateOf = (b: { sha: string } | null) => (b ? `blob:${b.sha}` : "absent");

  return {
    system: "github",
    readBlob: () => getAt(target.branch),
    async readState() {
      const b = await getAt(target.branch);
      return { digest: stateOf(b), detail: { ref: target.branch } };
    },
    authorizedBaseState(spec: GovernedActionSpec) {
      const base = spec.arguments.base_state;
      if (typeof base !== "string") throw new Error("action has no authorized base_state");
      return base;
    },
    async execute(spec: GovernedActionSpec) {
      const base = String(spec.arguments.base_state);
      const body: Record<string, unknown> = {
        message: String(spec.arguments.message),
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: target.branch,
      };
      if (base.startsWith("blob:")) body.sha = base.slice("blob:".length);
      const res = await doFetch(contentsUrl, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`GitHub write ${res.status}: ${text.slice(0, 200)}`);
      const j = JSON.parse(text) as { commit?: { sha?: unknown; html_url?: unknown }; content?: { sha?: unknown } };
      if (typeof j.commit?.sha !== "string" || typeof j.content?.sha !== "string") {
        throw new Error("GitHub write returned no commit/blob sha");
      }
      return { commit_sha: j.commit.sha, blob_sha: j.content.sha, ...(typeof j.commit.html_url === "string" && { commit_url: j.commit.html_url }) };
    },
    async observeEffect(_spec, receipt) {
      const commit = String(receipt.commit_sha);
      const [atCommit, atHead] = await Promise.all([getAt(commit), getAt(target.branch)]);
      const commitOk = !!atCommit && sha256Hex(atCommit.content) === expectedSha && atCommit.sha === receipt.blob_sha;
      const headOk = !!atHead && sha256Hex(atHead.content) === expectedSha;
      return {
        established: commitOk && headOk,
        expected: `sha256:${expectedSha}`,
        observed: atHead ? `sha256:${sha256Hex(atHead.content)}` : null,
        detail: {
          commit_sha: commit,
          at_commit_matches: commitOk,
          at_branch_head_matches: headOk,
          ...(atHead && { head_blob_sha: atHead.sha }),
        },
      };
    },
  };
}

/** Git's blob id for these bytes: sha1("blob <len>\\0" + bytes). What GitHub reports as the file's sha. */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, "utf8"), bytes])).digest("hex");
}

/**
 * CROSS-064 G4: the effect this change is authorized to produce, in the
 * runtime's github_contents_write.v1 form. prior_blob_sha is the blob the
 * write replaces (null for a create); blob_sha is the blob it writes.
 */
export function githubExpectedEffect(change: GithubFileChange, baseState: string): Record<string, unknown> {
  return {
    kind: "github_contents_write.v1",
    repository: `${change.owner}/${change.repo}`,
    branch: change.branch,
    path: change.path,
    prior_blob_sha: baseState.startsWith("blob:") ? baseState.slice("blob:".length).toLowerCase() : null,
    blob_sha: gitBlobSha(change.content),
  };
}

/** The canonical action for "set this file to this content", authorized against its current state. */
export function githubFileChangeSpec(
  change: GithubFileChange,
  baseState: string,
  environment: string,
  opts: { withExpectedEffect?: boolean } = {},
): GovernedActionSpec {
  return {
    tool: GITHUB_CONTENTS_TOOL,
    system: "github",
    target_id: githubTargetId(change),
    environment,
    arguments: {
      repository: `${change.owner}/${change.repo}`,
      branch: change.branch,
      path: change.path,
      base_state: baseState,
      content_sha256: sha256Hex(change.content),
      message: change.message,
      // CROSS-064 G4: part of the action digest, and of the evaluated context,
      // only when the runtime is to establish the effect.
      ...(opts.withExpectedEffect && { expected_effect: githubExpectedEffect(change, baseState) }),
    },
  };
}
