#!/usr/bin/env node
// atlasent-workload-guard --config <file.json>
import { readFileSync } from "node:fs";
import { loadConfig, startServer } from "./server.mjs";

const i = process.argv.indexOf("--config");
if (i < 0 || !process.argv[i + 1]) {
  process.stderr.write("usage: atlasent-workload-guard --config <config.json>\n");
  process.exit(64);
}
try {
  const cfg = loadConfig(JSON.parse(readFileSync(process.argv[i + 1], "utf8")));
  const { port } = await startServer(cfg);
  process.stderr.write(
    `${JSON.stringify({ component: "atlasent-workload-guard", event: "listening", port, tls: Boolean(cfg.tls), attestation: Boolean(cfg.attestation) })}\n`,
  );
} catch (err) {
  process.stderr.write(`atlasent-workload-guard: ${err.message}\n`);
  process.exit(70);
}
