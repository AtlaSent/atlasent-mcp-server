/**
 * Unit tests for compliance MCP tools (SCIM, SIEM, evidence exports).
 *
 * Tests verify:
 * - All 12 tools are registered in normal mode with the gateway opt-in
 *   (ATLASENT_MCP_ENABLE_GATEWAY_TOOLS=1; without it only
 *   atlasent_get_evidence_export is served by the hosted runtime, see
 *   src/gatewayTools.test.ts)
 * - Mutating tools are absent when ATLASENT_MCP_READONLY=1
 * - Read-only tools remain available in readonly mode
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

async function listToolNames(): Promise<string[]> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "compliance-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  const { tools } = await client.listTools();
  return tools.map((t) => t.name);
}

// ── Normal mode: all 12 compliance tools are registered ──────────────────────

describe("compliance tools — normal mode", () => {
  const ALL_COMPLIANCE_TOOLS = [
    "atlasent_list_scim_users",
    "atlasent_get_scim_user",
    "atlasent_create_scim_user",
    "atlasent_patch_scim_user",
    "atlasent_delete_scim_user",
    "atlasent_list_scim_groups",
    "atlasent_get_siem_config",
    "atlasent_upsert_siem_config",
    "atlasent_test_siem_delivery",
    "atlasent_list_evidence_exports",
    "atlasent_get_evidence_export",
    "atlasent_create_evidence_export",
  ];

  let names: string[];

  before(async () => {
    delete process.env.ATLASENT_MCP_READONLY;
    process.env.ATLASENT_MCP_ENABLE_GATEWAY_TOOLS = "1";
    names = await listToolNames();
  });

  after(() => {
    delete process.env.ATLASENT_MCP_READONLY;
    delete process.env.ATLASENT_MCP_ENABLE_GATEWAY_TOOLS;
  });

  for (const tool of ALL_COMPLIANCE_TOOLS) {
    it(`${tool} is registered`, () => {
      assert.equal(names.includes(tool), true);
    });
  }
});

// ── Readonly mode: mutating tools absent, read-only tools present ─────────────

describe("compliance tools — readonly mode", () => {
  const MUTATING = [
    "atlasent_create_scim_user",
    "atlasent_patch_scim_user",
    "atlasent_delete_scim_user",
    "atlasent_upsert_siem_config",
    "atlasent_create_evidence_export",
  ];

  const READ_ONLY_TOOLS = [
    "atlasent_list_scim_users",
    "atlasent_get_scim_user",
    "atlasent_list_scim_groups",
    "atlasent_get_siem_config",
    "atlasent_test_siem_delivery",
    "atlasent_list_evidence_exports",
    "atlasent_get_evidence_export",
  ];

  let names: string[];

  before(async () => {
    process.env.ATLASENT_MCP_READONLY = "1";
    process.env.ATLASENT_MCP_ENABLE_GATEWAY_TOOLS = "1";
    names = await listToolNames();
  });

  after(() => {
    delete process.env.ATLASENT_MCP_READONLY;
    delete process.env.ATLASENT_MCP_ENABLE_GATEWAY_TOOLS;
  });

  for (const tool of MUTATING) {
    it(`${tool} is absent in readonly mode`, () => {
      assert.equal(names.includes(tool), false);
    });
  }

  for (const tool of READ_ONLY_TOOLS) {
    it(`${tool} is present in readonly mode`, () => {
      assert.equal(names.includes(tool), true);
    });
  }
});
