#!/usr/bin/env node
/**
 * Refund agent demo: a support agent works a queue of refund requests; small
 * ones go straight through, large ones wait for a person to approve them in
 * the AtlaSent console, and nothing is refunded without a verified permit.
 *
 * LIVE (default). Spawns the built server (dist/index.js) over stdio, exactly
 * as an MCP host would, and calls atlasent_evaluate, atlasent_await_approval
 * and verify_permit. Needs:
 *
 *   ATLASENT_API_KEY          a key for the refund demo org (evaluate:write, verify:execute,
 *                             approvals:read: atlasent_await_approval polls and claims with it)
 *   ATLASENT_BASE_URL         the runtime, e.g. https://<ref>.supabase.co/functions/v1
 *   ATLASENT_ENVIRONMENT      required, e.g. staging (no default: the demo never assumes production)
 *   REFUND_AGENT_ACTOR_ID     optional, default service:refund-agent
 *   REFUND_QUEUE              optional, a JSON file shaped like refund-agent/refunds.json
 *   DEMO_APPROVAL_WAIT_SECONDS optional, default 600
 *
 * The org needs the solo-builder-payment-authorize-gate pack, template
 * self-attested-under-1000, activated (see docs/REFUND_AGENT_DEMO.md). The
 * payment processor is simulated in every mode: no money moves.
 *
 * SIMULATED (`--simulate`). In-memory AtlaSent and approver, for rehearsal.
 * Every line is prefixed [SIMULATED]; no network call is made.
 *
 *   npm run build && npm run demo:refund -- --simulate   # rehearsal
 *   npm run build && npm run demo:refund                 # live
 *
 * Exit code 0 when the run completed (whatever was or was not issued); 1 on a
 * setup error. Writes refund-agent-results-<time>.json (permits as sha256 only).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runRefundAgent, toolCallTimeoutMs } from "./refund-agent/core.mjs";
import { createSimulatedTools } from "./refund-agent/simulated.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const simulate = process.argv.includes("--simulate");
const prefix = simulate ? "[SIMULATED] " : "";
const say = (line) => console.log(line === "" ? "" : prefix + line);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const queuePath = process.env.REFUND_QUEUE ?? resolve(__dirname, "refund-agent", "refunds.json");
const refunds = JSON.parse(readFileSync(queuePath, "utf8"));
const actorId = process.env.REFUND_AGENT_ACTOR_ID ?? "service:refund-agent";

function parse(result) {
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("tool returned no content");
  return JSON.parse(text);
}

async function liveTools() {
  for (const k of ["ATLASENT_API_KEY", "ATLASENT_BASE_URL", "ATLASENT_ENVIRONMENT"]) {
    if (!process.env[k]) die(`${k} is required for a live run. Rehearse with --simulate.`);
  }
  const entry = resolve(__dirname, "..", "dist", "index.js");
  if (!existsSync(entry)) die("Build first: npm run build");
  const client = new Client({ name: "atlasent-refund-agent-demo", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...process.env, ATLASENT_MODE: "remote" },
      stderr: process.env.DEMO_SERVER_LOGS === "1" ? "inherit" : "ignore",
    }),
  );
  // Without an explicit timeout the MCP client abandons atlasent_await_approval
  // after 60 s, long before the approver's window closes.
  const call = async (name, args) =>
    parse(await client.callTool({ name, arguments: args }, undefined, { timeout: toolCallTimeoutMs(name, args) }));
  return {
    close: () => client.close(),
    tools: {
      evaluate: (i) => call("atlasent_evaluate", i),
      awaitApproval: (i) => call("atlasent_await_approval", i),
      verify: (i) => call("verify_permit", i),
    },
  };
}

async function main() {
  const environment = simulate ? "staging" : process.env.ATLASENT_ENVIRONMENT;
  const sim = createSimulatedTools();
  const live = simulate ? null : await liveTools();
  say(`Refund agent demo — ${refunds.length} requests in the support queue, environment ${environment}`);
  say("The payment processor is simulated: no money moves in any mode.");
  try {
    const results = await runRefundAgent({
      refunds,
      tools: live ? live.tools : sim.tools,
      processor: sim.processor,
      actorId,
      environment,
      approvalWaitSeconds: Number(process.env.DEMO_APPROVAL_WAIT_SECONDS ?? 600),
      say,
    });
    const out = `refund-agent-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(out, JSON.stringify({ simulated: simulate, environment, actor_id: actorId, results }, null, 2) + "\n");
    say(`Results: ${out}`);
  } finally {
    await live?.close();
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
