import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getMode } from "./engine.js";

const KEYS = ["ATLASENT_MODE", "ATLASENT_API_KEY", "ATLASENT_BASE_URL", "NODE_ENV", "ATLASENT_ALLOW_LOCAL_MODE_IN_PROD"] as const;
let saved: Record<string, string | undefined> = {};

describe("getMode", () => {
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("goes remote with only an API key (base URL defaults to the hosted endpoint)", () => {
    process.env.ATLASENT_API_KEY = "ask_live_x";
    assert.equal(getMode(), "remote");
  });

  it("goes remote with a key and a base URL", () => {
    process.env.ATLASENT_API_KEY = "ask_live_x";
    process.env.ATLASENT_BASE_URL = "https://example.supabase.co/functions/v1";
    assert.equal(getMode(), "remote");
  });

  it("stays local with no key, even when a base URL is set", () => {
    process.env.ATLASENT_BASE_URL = "https://example.supabase.co/functions/v1";
    assert.equal(getMode(), "local");
  });

  it("honours an explicit ATLASENT_MODE=local over a key", () => {
    process.env.ATLASENT_API_KEY = "ask_live_x";
    process.env.ATLASENT_MODE = "local";
    assert.equal(getMode(), "local");
  });

  it("with a key only, NODE_ENV=production no longer throws (it is remote, not local)", () => {
    process.env.ATLASENT_API_KEY = "ask_live_x";
    process.env.NODE_ENV = "production";
    assert.equal(getMode(), "remote");
  });
});

describe("dropEmptyAtlasentEnv (form-filled host config)", () => {
  it("treats blank optional fields as unset, so the hosted base URL default applies", async () => {
    const { dropEmptyAtlasentEnv } = await import("./hostEnv.js");
    const env: NodeJS.ProcessEnv = {
      ATLASENT_API_KEY: "ask_live_x",
      ATLASENT_BASE_URL: "",
      ATLASENT_MODE: "  ",
      OTHER: "",
    };
    assert.deepEqual(dropEmptyAtlasentEnv(env).sort(), ["ATLASENT_BASE_URL", "ATLASENT_MODE"]);
    assert.equal(env.ATLASENT_API_KEY, "ask_live_x");
    assert.equal("ATLASENT_BASE_URL" in env, false);
    assert.equal(env.OTHER, "", "only ATLASENT_* optional vars are touched");
  });

  it("a blank API key means local mode, never remote with an empty key", async () => {
    const { dropEmptyAtlasentEnv } = await import("./hostEnv.js");
    const env: NodeJS.ProcessEnv = { ATLASENT_API_KEY: "" };
    dropEmptyAtlasentEnv(env);
    assert.equal(env.ATLASENT_API_KEY, undefined);
  });
});
