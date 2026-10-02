import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { authorize, verify } from "./engine.js";
import {
  DEFAULT_FUNCTION_REGION,
  FUNCTION_REGION_ENV,
  FunctionRegionConfigError,
  functionRegionHeaders,
  resolveFunctionRegion,
} from "./functionRegion.js";

const HOSTED = "https://api.atlasent.io/functions/v1";
const HOSTED_PROD_REF = "https://kttccumlnmdtupgbyfue.supabase.co/functions/v1";
const SELF_HOSTED = "https://runtime.customer.example/functions/v1";
const ENV_KEYS = ["ATLASENT_MODE", "ATLASENT_API_KEY", "ATLASENT_BASE_URL", FUNCTION_REGION_ENV] as const;

describe("resolveFunctionRegion", () => {
  it("pins the hosted runtime to us-west-1", () => {
    assert.equal(DEFAULT_FUNCTION_REGION, "us-west-1");
    assert.equal(resolveFunctionRegion(HOSTED, undefined, {}), "us-west-1");
    assert.equal(resolveFunctionRegion(HOSTED_PROD_REF, undefined, {}), "us-west-1");
  });

  it("does not pin a self-hosted runtime or a lookalike host by default", () => {
    assert.equal(resolveFunctionRegion(SELF_HOSTED, undefined, {}), null);
    assert.equal(resolveFunctionRegion("https://api.atlasent.io.evil.example", undefined, {}), null);
  });

  it("explicit beats environment beats default; auto and null disable", () => {
    const env = { [FUNCTION_REGION_ENV]: "us-east-1" };
    assert.equal(resolveFunctionRegion(SELF_HOSTED, undefined, env), "us-east-1");
    assert.equal(resolveFunctionRegion(HOSTED, "eu-west-1", env), "eu-west-1");
    assert.equal(resolveFunctionRegion(HOSTED, "auto", env), null);
    assert.equal(resolveFunctionRegion(HOSTED, null, env), null);
    assert.equal(resolveFunctionRegion(HOSTED, undefined, { [FUNCTION_REGION_ENV]: "auto" }), null);
  });

  it("throws on a malformed value", () => {
    for (const bad of ["US-WEST-1", "west", "us-west-1\r\nx-evil: 1"]) {
      assert.throws(() => resolveFunctionRegion(HOSTED, bad, {}), FunctionRegionConfigError);
    }
  });

  it("returns no headers when unpinned", () => {
    assert.deepEqual(functionRegionHeaders(SELF_HOSTED, undefined, {}), {});
    assert.deepEqual(functionRegionHeaders(HOSTED, undefined, {}), { "x-region": "us-west-1" });
  });
});

describe("remote calls carry the region header", () => {
  const saved: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  let seen: Array<{ url: string; headers: Record<string, string> }> = [];

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ATLASENT_MODE = "remote";
    process.env.ATLASENT_API_KEY = "ask_live_test";
    delete process.env[FUNCTION_REGION_ENV];
    seen = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(JSON.stringify({ decision: "deny", reason: "test", request_id: "r1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const ctx = { action_type: "production.deploy", actor_id: "agent:1", environment: "production" };

  it("evaluate and verify against the hosted runtime send x-region: us-west-1", async () => {
    process.env.ATLASENT_BASE_URL = HOSTED;
    await authorize(ctx as never);
    await verify("pt-1", ctx as never);
    assert.ok(seen.length >= 2, "both calls reached fetch");
    for (const call of seen) {
      assert.equal(call.headers["x-region"], "us-west-1", call.url);
      assert.equal(call.headers["Authorization"], "Bearer ask_live_test");
    }
  });

  it("a self-hosted runtime gets no header", async () => {
    process.env.ATLASENT_BASE_URL = SELF_HOSTED;
    await authorize(ctx as never);
    assert.ok(seen.length >= 1);
    assert.equal(seen[0]!.headers["x-region"], undefined);
  });

  it("ATLASENT_FUNCTION_REGION is read at call time", async () => {
    process.env.ATLASENT_BASE_URL = HOSTED;
    process.env[FUNCTION_REGION_ENV] = "us-east-1";
    await authorize(ctx as never);
    assert.equal(seen[0]!.headers["x-region"], "us-east-1");
  });

  it("a malformed region fails closed: deny, and no request is sent", async () => {
    process.env.ATLASENT_BASE_URL = HOSTED;
    process.env[FUNCTION_REGION_ENV] = "US-WEST-1";
    const decision = await authorize(ctx as never);
    assert.equal(decision.decision, "deny");
    assert.equal(seen.length, 0);
  });
});

describe("region pinning stays centralized", () => {
  const SRC = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"));
  // Files that call fetch but never an AtlaSent runtime edge function, each with its reason:
  // v2Tools.ts: fetchBvsSnapshot reads the behavior service (/api/patterns), not an edge function;
  // its runtime calls go through v2Client.ts.
  const NOT_RUNTIME = new Set(["v2Tools.ts"]);

  it("only functionRegion.ts writes the x-region header", () => {
    assert.ok(files.length > 15);
    const offenders = files.filter(
      (f) => f !== "functionRegion.ts" && /["'`]x-region["'`]/i.test(readFileSync(join(SRC, f), "utf-8")),
    );
    assert.deepEqual(offenders, []);
  });

  it("every file that calls fetch uses the region helper", () => {
    const missing = files.filter((f) => {
      if (f === "functionRegion.ts" || NOT_RUNTIME.has(f)) return false;
      const src = readFileSync(join(SRC, f), "utf-8");
      return /\bfetch\(/.test(src) && !src.includes("functionRegionHeaders(");
    });
    assert.deepEqual(missing, []);
  });
});
