// Gateway-only tools are hidden against the hosted runtime and registered
// against a self-hosted one or with ATLASENT_MCP_ENABLE_GATEWAY_TOOLS
// (src/gatewayTools.ts, founder decision 2026-10-19).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, _resetRateLimitForTests } from "./server.js";
import { GATEWAY_ONLY_TOOLS, GATEWAY_TOOLS_ENV, gatewayToolsEnabled } from "./gatewayTools.js";
import { HOSTED_RUNTIME_HOSTS } from "./functionRegion.js";

const ENV_KEYS = [
  "ATLASENT_MODE",
  "ATLASENT_API_KEY",
  "ATLASENT_BASE_URL",
  "ATLASENT_MCP_READONLY",
  GATEWAY_TOOLS_ENV,
] as const;

// Tools the hosted runtime serves: they must be present in every configuration.
const KEPT = [
  "evaluate",
  "verify_permit",
  "deploy_service",
  "atlasent_evaluate",
  "atlasent_await_approval",
  "atlasent_list_policies",
  "atlasent_list_permits",
  "atlasent_list_audit_events",
  "atlasent_get_evidence_export",
  "atlasent_explain_authority",
  "atlasent_integrity_audit",
  "atlasent_vqp_generate",
  "atlasent_vqp_verify",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  _resetRateLimitForTests();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function toolNames(): Promise<Set<string>> {
  const server = createServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gateway-tools-test", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  const { tools } = await client.listTools();
  return new Set(tools.map((t) => t.name));
}

function assertHidden(names: Set<string>, label: string): void {
  for (const t of GATEWAY_ONLY_TOOLS) assert.equal(names.has(t), false, `${label}: ${t} must be hidden`);
  for (const t of KEPT) assert.equal(names.has(t), true, `${label}: ${t} must stay`);
}

function assertShown(names: Set<string>, label: string): void {
  for (const t of GATEWAY_ONLY_TOOLS) assert.equal(names.has(t), true, `${label}: ${t} must be registered`);
  for (const t of KEPT) assert.equal(names.has(t), true, `${label}: ${t} must stay`);
}

function remote(base?: string): void {
  process.env.ATLASENT_API_KEY = "test-key";
  if (base !== undefined) process.env.ATLASENT_BASE_URL = base;
}

describe("gateway-only tool set", () => {
  it("names exactly the 26 tools on slash-form paths the hosted API 404s", () => {
    assert.equal(GATEWAY_ONLY_TOOLS.size, 26);
  });

  it("never contains an authorize/verify primitive or a tool the hosted API serves", () => {
    for (const t of KEPT) assert.equal(GATEWAY_ONLY_TOOLS.has(t), false, t);
  });
});

describe("hidden against the hosted runtime", () => {
  it("default env (local mode, no base URL)", async () => {
    assertHidden(await toolNames(), "default");
  });

  it("API key with ATLASENT_BASE_URL unset (the hosted default)", async () => {
    remote();
    assertHidden(await toolNames(), "key, no base");
  });

  it("blank ATLASENT_BASE_URL counts as unset", async () => {
    remote("   ");
    assertHidden(await toolNames(), "blank base");
  });

  for (const host of HOSTED_RUNTIME_HOSTS) {
    it(`base URL on ${host}`, async () => {
      remote(`https://${host}/functions/v1`);
      assertHidden(await toolNames(), host);
    });
  }

  it("hosted host matched case-insensitively and with a trailing dot", async () => {
    remote("https://API.AtlaSent.io./functions/v1");
    assertHidden(await toolNames(), "mixed-case host");
  });

  it("unparseable base URL", async () => {
    remote("not a url");
    assert.equal(gatewayToolsEnabled(process.env), false);
  });

  it("local mode with a self-hosted base URL (these tools only make remote calls)", async () => {
    process.env.ATLASENT_MODE = "local";
    process.env.ATLASENT_BASE_URL = "https://gateway.example.com";
    assertHidden(await toolNames(), "local + self-hosted");
  });

  it("a hosted host as a subdomain prefix is not mistaken for self-hosted", () => {
    remote("https://api.atlasent.io.evil.example/functions/v1");
    // Not hosted, so it is treated as self-hosted: the operator chose this URL.
    assert.equal(gatewayToolsEnabled(process.env), true);
  });

  for (const v of ["0", "false", "", "yes"]) {
    it(`${GATEWAY_TOOLS_ENV}=${JSON.stringify(v)} does not opt in`, async () => {
      remote("https://api.atlasent.io/functions/v1");
      process.env[GATEWAY_TOOLS_ENV] = v;
      assertHidden(await toolNames(), `flag=${v}`);
    });
  }
});

describe("registered when opted in or self-hosted", () => {
  for (const v of ["1", "true", "TRUE"]) {
    it(`${GATEWAY_TOOLS_ENV}=${v} against the hosted runtime`, async () => {
      remote("https://api.atlasent.io/functions/v1");
      process.env[GATEWAY_TOOLS_ENV] = v;
      assertShown(await toolNames(), `flag=${v}`);
    });
  }

  it(`${GATEWAY_TOOLS_ENV}=1 in local mode`, async () => {
    process.env[GATEWAY_TOOLS_ENV] = "1";
    assertShown(await toolNames(), "flag + local");
  });

  it("remote mode with a self-hosted base URL", async () => {
    remote("https://atlasent.internal.example.com");
    assertShown(await toolNames(), "self-hosted");
  });

  it("remote mode with a self-hosted Supabase project", async () => {
    remote("https://abcdefghijklmnop.supabase.co/functions/v1");
    assertShown(await toolNames(), "self-hosted supabase");
  });

  it("read-only mode still removes the mutating gateway tools", async () => {
    remote("https://atlasent.internal.example.com");
    process.env.ATLASENT_MCP_READONLY = "1";
    const names = await toolNames();
    for (const t of ["atlasent_create_policy", "atlasent_permit", "atlasent_create_scim_user"]) {
      assert.equal(names.has(t), false, t);
    }
    for (const t of ["atlasent_get_policy", "atlasent_get_permit", "atlasent_list_scim_users"]) {
      assert.equal(names.has(t), true, t);
    }
  });
});

describe("hiding does not change authorization", () => {
  it("evaluate and verify_permit behave the same with and without the opt-in (local mode)", async () => {
    const run = async () => {
      const server = createServer();
      const [c, s] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "gateway-tools-test", version: "1.0.0" });
      await Promise.all([client.connect(c), server.connect(s)]);
      const ev = await client.callTool({
        name: "evaluate",
        arguments: { action_type: "production.deploy", actor_id: "user-1", environment: "production" },
      });
      const vp = await client.callTool({
        name: "verify_permit",
        arguments: { permit_token: "pt_forged", action_type: "production.deploy", actor_id: "user-1", environment: "production" },
      });
      const text = (r: typeof ev) => (r.content as Array<{ text: string }>)[0].text;
      const strip = (t: string) => {
        const o = JSON.parse(t) as Record<string, unknown>;
        delete o.permit_token;
        delete o.request_id;
        delete o.expires_at;
        delete o.audit_id;
        return o;
      };
      return { ev: strip(text(ev)), vp: strip(text(vp)) };
    };
    const hidden = await run();
    process.env[GATEWAY_TOOLS_ENV] = "1";
    _resetRateLimitForTests();
    const shown = await run();
    assert.deepEqual(shown, hidden);
    assert.equal(hidden.vp.valid, false, "a forged permit must not verify");
  });
});
