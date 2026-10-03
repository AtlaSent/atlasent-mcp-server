import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ACTION_TYPE_PATTERN, isValidActionType } from "./actionTypePattern.js";
import { CANON_ACT_CATALOG } from "./canonCatalog.js";
import { createServer, _resetRateLimitForTests } from "./server.js";

// The pattern server.ts used before this change. `.-:` is a RANGE
// (0x2E-0x3A), so `/` slipped through. Kept here as a positive control:
// every rejection case below must have been ACCEPTED by it, otherwise the
// case proves nothing about the fix.
// eslint-disable-next-line no-useless-escape
const OLD_PATTERN = /^[A-Za-z0-9_.\.-:]+$/;

// Byte-for-byte copy of atlasent-api v1-evaluate/handler.ts ACTION_TYPE_RE.
const RUNTIME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const REJECTED_BY_OLD_BUT_NOT_RUNTIME = [
  "production/deploy",
  "a/b",
  "/",
  "production.deploy/../x",
  "Production.Deploy",
  "github:production.deploy",
  "production.deploy:",
  "delete_table",
  "x",
  ".deploy",
  "production.",
  "production..deploy",
  "1production.deploy",
  "production.1deploy",
];

const REJECTED_BY_BOTH = [
  "production deploy",
  "production-deploy.run", // the old message claimed `-` was allowed; the range never included it
  "production.deploy ",
  " production.deploy",
  "production.\tdeploy",
  "production.deploy\n",
  "production.deploy!",
  "production.deploy;drop",
  "production.dеploy", // Cyrillic е
  "",
];

describe("ACTION_TYPE_PATTERN", () => {
  it("is exactly the runtime's ACTION_TYPE_RE", () => {
    assert.equal(ACTION_TYPE_PATTERN.source, RUNTIME_PATTERN.source);
    assert.equal(ACTION_TYPE_PATTERN.flags, RUNTIME_PATTERN.flags);
  });

  it("accepts every Canon slug in canonCatalog.ts", () => {
    assert.ok(CANON_ACT_CATALOG.length > 0, "empty catalog would make this vacuous");
    for (const { slug } of CANON_ACT_CATALOG) {
      assert.ok(isValidActionType(slug), `Canon slug rejected: ${slug}`);
    }
  });

  it("rejects `/` and the other values the old range-bug pattern let through", () => {
    for (const v of REJECTED_BY_OLD_BUT_NOT_RUNTIME) {
      assert.ok(OLD_PATTERN.test(v), `positive control: old pattern should accept ${JSON.stringify(v)}`);
      assert.equal(RUNTIME_PATTERN.test(v), false, `runtime should reject ${JSON.stringify(v)}`);
      assert.equal(isValidActionType(v), false, `should reject ${JSON.stringify(v)}`);
    }
  });

  it("rejects spaces and other characters outside the set", () => {
    for (const v of REJECTED_BY_BOTH) {
      assert.equal(isValidActionType(v), false, `should reject ${JSON.stringify(v)}`);
    }
  });

  it("the old pattern fails this suite (it accepts `/`)", () => {
    const oldAcceptsSlash = OLD_PATTERN.test("a/b");
    assert.equal(oldAcceptsSlash, true);
    assert.notEqual(ACTION_TYPE_PATTERN.source, OLD_PATTERN.source);
  });
});

describe("action_type validation at the MCP tool boundary", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    _resetRateLimitForTests();
  });

  async function connect() {
    process.env.ATLASENT_MODE = "local";
    delete process.env.ATLASENT_API_KEY;
    delete process.env.ATLASENT_BASE_URL;
    const server = createServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
    return client;
  }

  for (const tool of ["evaluate", "verify_permit", "atlasent_evaluate"]) {
    it(`${tool} refuses a slash-bearing action_type before any evaluation`, async () => {
      const client = await connect();
      const args: Record<string, unknown> = {
        action_type: "production/deploy",
        actor_id: "user-1",
        environment: "staging",
      };
      if (tool === "verify_permit") args.permit_token = "pt_x";
      const res = await client.callTool({ name: tool, arguments: args }).then(
        (r) => r,
        (e: unknown) => ({ isError: true, content: [{ type: "text", text: String(e) }] }),
      );
      assert.equal(res.isError, true);
      const text = JSON.stringify(res.content);
      assert.match(text, /action_type/);
      assert.doesNotMatch(text, /"decision"\s*:\s*"allow"/);
    });
  }

  it("evaluate still accepts a Canon slug", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "evaluate",
      arguments: { action_type: "workflow.approve", actor_id: "user-1", environment: "staging" },
    });
    assert.doesNotMatch(JSON.stringify(res.content), /must be canonical/);
  });
});
