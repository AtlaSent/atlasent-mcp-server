/**
 * Hosts that fill env vars from a settings form (MCPB bundles in Claude
 * Desktop and Smithery, for example) can pass an optional field the user left
 * blank as an empty string. For these variables an empty string must mean
 * "not set": `ATLASENT_BASE_URL=""` would otherwise bypass the hosted default
 * and send every call to a relative URL. Called once from the CLI entry, before
 * any config is read.
 */
export const OPTIONAL_ATLASENT_ENV = [
  "ATLASENT_API_KEY",
  "ATLASENT_ANON_KEY",
  "ATLASENT_BASE_URL",
  "ATLASENT_MODE",
] as const;

export function dropEmptyAtlasentEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const dropped: string[] = [];
  for (const k of OPTIONAL_ATLASENT_ENV) {
    if (env[k] !== undefined && env[k]!.trim() === "") {
      delete env[k];
      dropped.push(k);
    }
  }
  return dropped;
}
