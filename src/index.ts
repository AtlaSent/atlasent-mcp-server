#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Transports:
 *   - stdio              (default, unchanged) — spawned by hosts like
 *                         Claude Desktop / Cursor / Claude Code.
 *   - streamable-http    (V2 Wave B) — MCP spec 2025-03-26. Opt-in via
 *                         `--transport streamable-http` or the env var
 *                         `ATLASENT_MCP_TRANSPORT=streamable-http`.
 *
 * The stdio entry is the historical default and is preserved verbatim.
 * Streamable HTTP is ADDITIVE — selecting it does not modify or disable
 * the stdio path; deployments that want both run two processes.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startStreamableHttp } from "./streamableHttp.js";
import { dropEmptyAtlasentEnv } from "./hostEnv.js";

function pickTransport(): "stdio" | "streamable-http" {
  // CLI flag takes precedence over env var.
  const argv = process.argv.slice(2);
  const flagIdx = argv.indexOf("--transport");
  if (flagIdx !== -1 && argv[flagIdx + 1]) {
    const v = argv[flagIdx + 1].toLowerCase();
    if (v === "streamable-http" || v === "http") return "streamable-http";
    if (v === "stdio") return "stdio";
  }
  const env = process.env.ATLASENT_MCP_TRANSPORT?.toLowerCase();
  if (env === "streamable-http" || env === "http") return "streamable-http";
  return "stdio";
}

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "server_started",
      transport: "stdio",
    }) + "\n",
  );
}

async function runStreamableHttp(): Promise<void> {
  const handle = await startStreamableHttp();
  // Keep the process alive until SIGTERM / SIGINT. The handle's HTTP
  // server keeps the event loop busy on its own, but we also wire
  // graceful shutdown so containers stop cleanly.
  const shutdown = async (signal: string) => {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "server_shutdown",
        transport: "streamable-http",
        signal,
      }) + "\n",
    );
    await handle.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

async function main(): Promise<void> {
  dropEmptyAtlasentEnv();
  const transport = pickTransport();
  if (transport === "streamable-http") {
    await runStreamableHttp();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "server_failed",
      error: err instanceof Error ? err.message : String(err),
    }) + "\n",
  );
  process.exit(1);
});
